import * as vscode from 'vscode';
import { mediaRoot, webviewAssets } from './webviewAssets';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  discoverProviderModels,
  getProviderApiKey,
  getSavedCredentialStatus,
  isCurrentConfigurationComplete,
  storeProviderApiKey,
} from './providerSecrets';
import {
  PROVIDERS,
  type ModelSelections,
  type ProviderId,
  buildModelSettingUpdates,
  chooseInitialModels,
  getProviderDefinition,
  isCommitMessageStyle,
  isProviderId,
  parseBoundedInt,
  parseGlobList,
} from './setupCore';

export const SETUP_COMPLETE_KEY = 'askii.setup.completed';
const SETUP_PROGRESS_KEY = 'askii.setup.progress';

type SetupStep = 'provider' | 'models' | 'options' | 'wiki' | 'advanced';

interface SetupProgress {
  step: Exclude<SetupStep, 'provider'>;
  provider: ProviderId;
  models: string[];
  manual: boolean;
  warning?: string;
  selections: ModelSelections;
}

interface OptionalSettings {
  inlineCompletionEnabled: boolean;
  inlineCompletionEagerness: 'low' | 'medium' | 'high';
  inlineHelperMode: 'off' | 'helpful' | 'funny' | 'wiki';
  formatAfterEdit: boolean;
  doAutoConfirm: boolean;
  controlAutoConfirm: boolean;
  doMaxRounds: number;
  browserHeadless: boolean;
  wikiEnabled: boolean;
  wikiPath: string;
  wikiAutoReload: boolean;
  codeWikiEnabled: boolean;
  codeWikiAutoReload: boolean;
  chromePath: string;
  commitMessageInstructions: string;
  commitMessageStyle: 'oneliner' | 'brief' | 'descriptive';
  noteReminderSound: boolean;
  noteSnoozeMinutes: number;
  requestTimeoutSeconds: number;
  maxOutputTokens: number;
  inlineExcludeGlobs: string[];
}

interface SetupState {
  step: SetupStep;
  provider: ProviderId;
  providers: typeof PROVIDERS;
  models: string[];
  manualModels: boolean;
  modelWarning: string;
  selections: ModelSelections;
  savedCredentials: Record<ProviderId, boolean>;
  urls: { ollama: string; lmstudio: string; openai: string };
  options: OptionalSettings;
}

let currentPanel: vscode.WebviewPanel | undefined;

function getOptionalSettings(config: vscode.WorkspaceConfiguration): OptionalSettings {
  const eagerness = config.get<string>('inlineCompletionEagerness') ?? 'medium';
  const helperMode = config.get<string>('inlineHelperMode') ?? 'off';
  const commitStyle = config.get<string>('commitMessageStyle');
  return {
    inlineCompletionEnabled: config.get<boolean>('inlineCompletionEnabled') ?? false,
    inlineCompletionEagerness: eagerness === 'low' || eagerness === 'high' ? eagerness : 'medium',
    inlineHelperMode:
      helperMode === 'helpful' || helperMode === 'funny' || helperMode === 'wiki'
        ? helperMode
        : 'off',
    formatAfterEdit: config.get<boolean>('formatAfterEdit') ?? false,
    doAutoConfirm: config.get<boolean>('doAutoConfirm') ?? false,
    controlAutoConfirm: config.get<boolean>('controlAutoConfirm') ?? false,
    doMaxRounds: config.get<number>('doMaxRounds') ?? 20,
    browserHeadless: config.get<boolean>('browserHeadless') ?? false,
    wikiEnabled: config.get<boolean>('wikiEnabled') ?? false,
    wikiPath: config.get<string>('wikiPath') ?? '',
    wikiAutoReload: config.get<boolean>('wikiAutoReload') ?? false,
    codeWikiEnabled: config.get<boolean>('codeWikiEnabled') ?? false,
    codeWikiAutoReload: config.get<boolean>('codeWikiAutoReload') ?? false,
    chromePath: config.get<string>('chromePath') ?? '',
    commitMessageInstructions: config.get<string>('commitMessageInstructions') ?? '',
    commitMessageStyle: isCommitMessageStyle(commitStyle) ? commitStyle : 'oneliner',
    noteReminderSound: config.get<boolean>('noteReminderSound') ?? true,
    noteSnoozeMinutes: config.get<number>('noteSnoozeMinutes') ?? 10,
    requestTimeoutSeconds: config.get<number>('requestTimeoutSeconds') ?? 600,
    maxOutputTokens: config.get<number>('maxOutputTokens') ?? 0,
    inlineExcludeGlobs: config.get<string[]>('inlineExcludeGlobs') ?? [],
  };
}

function getConfiguredModels(config: vscode.WorkspaceConfiguration): ModelSelections {
  return {
    general: config.get<string>('llmModel') ?? '',
    inline: config.get<string>('llmInlineModel') ?? '',
    vision: config.get<string>('llmVisionModel') ?? '',
  };
}

function getConfiguredPlatforms(config: vscode.WorkspaceConfiguration): {
  general: string;
  inline: string;
  vision: string;
} {
  return {
    general: config.get<string>('llmPlatform') ?? '',
    inline: config.get<string>('llmInlinePlatform') ?? '',
    vision: config.get<string>('llmVisionPlatform') ?? '',
  };
}

function manualSelections(
  provider: ProviderId,
  configuredPlatforms: ReturnType<typeof getConfiguredPlatforms>,
  configuredModels: ModelSelections,
): ModelSelections {
  const matching = (role: keyof ModelSelections): string =>
    configuredPlatforms[role] === provider ? configuredModels[role] : '';
  return {
    general: matching('general') || (provider === 'askiicloud' ? 'askii-smart' : ''),
    inline: matching('inline') || (provider === 'askiicloud' ? 'askii-fast' : ''),
    vision: matching('vision') || (provider === 'askiicloud' ? 'askii-smart' : ''),
  };
}

export async function shouldOpenSetupAutomatically(
  context: vscode.ExtensionContext,
): Promise<boolean> {
  if (context.globalState.get<boolean>(SETUP_COMPLETE_KEY) === true) {
    return false;
  }
  if (await isCurrentConfigurationComplete()) {
    await context.globalState.update(SETUP_COMPLETE_KEY, true);
    await context.globalState.update(SETUP_PROGRESS_KEY, undefined);
    return false;
  }
  return context.extensionMode !== vscode.ExtensionMode.Test;
}

export async function openSetupPanel(context: vscode.ExtensionContext): Promise<void> {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active, false);
    return;
  }

  const config = vscode.workspace.getConfiguration('askii');
  const completed = context.globalState.get<boolean>(SETUP_COMPLETE_KEY) === true;
  const progress = completed
    ? undefined
    : context.globalState.get<SetupProgress>(SETUP_PROGRESS_KEY);
  const configuredProvider = config.get<string>('llmPlatform');
  const provider =
    progress?.provider ?? (isProviderId(configuredProvider) ? configuredProvider : 'askiicloud');
  const models = progress?.models ?? [];
  const manualModels = progress?.manual ?? false;
  const configuredPlatforms = getConfiguredPlatforms(config);
  const configuredModels = getConfiguredModels(config);
  const selections =
    progress?.selections ??
    (manualModels
      ? manualSelections(provider, configuredPlatforms, configuredModels)
      : chooseInitialModels(provider, models, configuredPlatforms, configuredModels));

  const state: SetupState = {
    step: progress?.step ?? 'provider',
    provider,
    providers: PROVIDERS,
    models,
    manualModels,
    modelWarning: progress?.warning ?? '',
    selections,
    savedCredentials: await getSavedCredentialStatus(),
    urls: {
      ollama: config.get<string>('ollamaUrl') ?? 'http://localhost:11434',
      lmstudio: config.get<string>('lmStudioUrl') ?? 'ws://localhost:1234',
      openai: config.get<string>('openaiUrl') ?? '',
    },
    options: getOptionalSettings(config),
  };

  const panel = vscode.window.createWebviewPanel(
    'askiiSetup',
    'ASKII Setup',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [mediaRoot()] },
  );
  currentPanel = panel;
  const nonce = randomBytes(16).toString('base64');
  panel.webview.html = getSetupHtml(panel.webview, nonce, state);
  panel.webview.onDidReceiveMessage((message: unknown) =>
    handleSetupMessage(panel, context, message),
  );
  panel.onDidDispose(() => {
    if (currentPanel === panel) {
      currentPanel = undefined;
    }
  });
}

async function updateGlobalSettings(values: Record<string, unknown>): Promise<void> {
  const config = vscode.workspace.getConfiguration('askii');
  for (const [setting, value] of Object.entries(values)) {
    await config.update(setting, value, vscode.ConfigurationTarget.Global);
  }
  // Setup saves user settings; a workspace value would silently win over them
  const overridden = Object.keys(values).filter((setting) => {
    const inspected = config.inspect(setting);
    return inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;
  });
  if (overridden.length > 0) {
    void vscode.window
      .showWarningMessage(
        `ASKII: saved to your user settings, but this workspace overrides ${overridden
          .map((s) => `askii.${s}`)
          .join(', ')} — the workspace values still apply here.`,
        'Open Workspace Settings',
      )
      .then((choice) => {
        if (choice) {
          void vscode.commands.executeCommand('workbench.action.openWorkspaceSettingsFile');
        }
      });
  }
}

function messageRecord(message: unknown): Record<string, unknown> | undefined {
  return typeof message === 'object' && message !== null
    ? (message as Record<string, unknown>)
    : undefined;
}

function messageString(message: Record<string, unknown>, key: string): string {
  return typeof message[key] === 'string' ? message[key].trim() : '';
}

async function handleProviderValidation(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  message: Record<string, unknown>,
): Promise<void> {
  const providerValue = message.provider;
  if (!isProviderId(providerValue)) {
    throw new Error('Choose a valid provider.');
  }
  const provider = providerValue;
  const definition = getProviderDefinition(provider);
  const suppliedApiKey = messageString(message, 'apiKey');
  const apiKey = suppliedApiKey || (await getProviderApiKey(provider));
  const serverUrl = messageString(message, 'serverUrl');
  const openaiBaseUrl = messageString(message, 'openaiBaseUrl');
  const result = await discoverProviderModels(provider, { apiKey, serverUrl, openaiBaseUrl });

  if (definition.connection === 'apiKey' && suppliedApiKey) {
    await storeProviderApiKey(provider, suppliedApiKey);
  }
  if (provider === 'ollama') {
    await updateGlobalSettings({ ollamaUrl: serverUrl });
  } else if (provider === 'lmstudio') {
    await updateGlobalSettings({ lmStudioUrl: serverUrl });
  } else if (provider === 'openai') {
    await updateGlobalSettings({ openaiUrl: openaiBaseUrl });
  }

  const config = vscode.workspace.getConfiguration('askii');
  const selections =
    result.mode === 'manual'
      ? manualSelections(provider, getConfiguredPlatforms(config), getConfiguredModels(config))
      : chooseInitialModels(
          provider,
          result.models,
          getConfiguredPlatforms(config),
          getConfiguredModels(config),
        );
  const progress: SetupProgress = {
    step: 'models',
    provider,
    models: result.models,
    manual: result.mode === 'manual',
    warning: result.mode === 'manual' ? result.warning : undefined,
    selections,
  };
  await context.globalState.update(SETUP_PROGRESS_KEY, progress);
  await panel.webview.postMessage({
    type: 'providerValidated',
    provider,
    models: result.models,
    manual: result.mode === 'manual',
    warning: result.mode === 'manual' ? result.warning : '',
    selections,
    savedCredential: definition.connection === 'apiKey',
  });
}

async function handleModelSave(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  message: Record<string, unknown>,
): Promise<void> {
  if (!isProviderId(message.provider)) {
    throw new Error('Choose a valid provider.');
  }
  const provider = message.provider;
  const selections: ModelSelections = {
    general: messageString(message, 'general'),
    inline: messageString(message, 'inline'),
    vision: messageString(message, 'vision'),
  };
  if (!selections.general || !selections.inline || !selections.vision) {
    throw new Error('Choose a model for all three ASKII roles.');
  }
  await updateGlobalSettings(buildModelSettingUpdates(provider, selections));
  const previous = context.globalState.get<SetupProgress>(SETUP_PROGRESS_KEY);
  await context.globalState.update(SETUP_PROGRESS_KEY, {
    step: 'options',
    provider,
    models: previous?.models ?? [],
    manual: previous?.manual ?? false,
    warning: previous?.warning,
    selections,
  } satisfies SetupProgress);
  await panel.webview.postMessage({ type: 'modelsSaved' });
}

function parseOptionalSettings(message: Record<string, unknown>): OptionalSettings {
  const eagerness = messageString(message, 'inlineCompletionEagerness');
  const helperMode = messageString(message, 'inlineHelperMode');
  const commitStyle = messageString(message, 'commitMessageStyle');
  if (eagerness !== 'low' && eagerness !== 'medium' && eagerness !== 'high') {
    throw new Error('Choose a valid inline completion eagerness.');
  }
  if (
    helperMode !== 'off' &&
    helperMode !== 'helpful' &&
    helperMode !== 'funny' &&
    helperMode !== 'wiki'
  ) {
    throw new Error('Choose a valid inline helper mode.');
  }
  if (!isCommitMessageStyle(commitStyle)) {
    throw new Error('Choose a valid commit message style.');
  }
  return {
    inlineCompletionEnabled: message.inlineCompletionEnabled === true,
    inlineCompletionEagerness: eagerness,
    inlineHelperMode: helperMode,
    formatAfterEdit: message.formatAfterEdit === true,
    doAutoConfirm: message.doAutoConfirm === true,
    controlAutoConfirm: message.controlAutoConfirm === true,
    doMaxRounds: parseBoundedInt('Max agent rounds', messageString(message, 'doMaxRounds'), 1),
    browserHeadless: message.browserHeadless === true,
    wikiEnabled: message.wikiEnabled === true,
    wikiPath: messageString(message, 'wikiPath'),
    wikiAutoReload: message.wikiAutoReload === true,
    codeWikiEnabled: message.codeWikiEnabled === true,
    codeWikiAutoReload: message.codeWikiAutoReload === true,
    chromePath: messageString(message, 'chromePath'),
    commitMessageInstructions: messageString(message, 'commitMessageInstructions'),
    commitMessageStyle: commitStyle,
    noteReminderSound: message.noteReminderSound === true,
    noteSnoozeMinutes: parseBoundedInt(
      'Snooze duration',
      messageString(message, 'noteSnoozeMinutes'),
      1,
    ),
    requestTimeoutSeconds: parseBoundedInt(
      'Request timeout',
      messageString(message, 'requestTimeoutSeconds'),
      0,
    ),
    maxOutputTokens: parseBoundedInt(
      'Max output tokens',
      messageString(message, 'maxOutputTokens'),
      0,
    ),
    inlineExcludeGlobs: parseGlobList(messageString(message, 'inlineExcludeGlobs')),
  };
}

function defaultPickerUri(current: string, folder: boolean): vscode.Uri | undefined {
  if (!current || !path.isAbsolute(current)) {
    return undefined;
  }
  return vscode.Uri.file(folder ? current : path.dirname(current));
}

async function handlePathPick(
  panel: vscode.WebviewPanel,
  message: Record<string, unknown>,
): Promise<void> {
  const target = message.target;
  const wiki = target === 'wikiPath';
  const chrome = target === 'chromePath';
  if (!wiki && !chrome && target !== 'commitMessageInstructions') {
    throw new Error('Unknown path setting.');
  }
  const current = messageString(message, 'current');
  const picked = await vscode.window.showOpenDialog(
    wiki
      ? {
          title: 'Select the ASKII wiki folder (.md documentation)',
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          defaultUri: defaultPickerUri(current, true),
        }
      : chrome
        ? {
            title: 'Select the Chrome/Chromium executable',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri: defaultPickerUri(current, false),
          }
        : {
            title: 'Select the ASKII commit rules Markdown file',
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: { Markdown: ['md'], 'All Files': ['*'] },
            defaultUri: defaultPickerUri(current, false),
          },
  );
  if (!picked || picked.length === 0) {
    return;
  }
  await panel.webview.postMessage({ type: 'pathPicked', target, path: picked[0].fsPath });
}

async function completeSetup(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(SETUP_COMPLETE_KEY, true);
  await context.globalState.update(SETUP_PROGRESS_KEY, undefined);
}

async function handleSetupMessage(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  rawMessage: unknown,
): Promise<void> {
  const message = messageRecord(rawMessage);
  if (!message || typeof message.type !== 'string') {
    return;
  }
  try {
    if (message.type === 'validateProvider') {
      await handleProviderValidation(panel, context, message);
    } else if (message.type === 'pickPath') {
      await handlePathPick(panel, message);
    } else if (message.type === 'saveModels') {
      await handleModelSave(panel, context, message);
    } else if (message.type === 'finish') {
      const options = parseOptionalSettings(message);
      await updateGlobalSettings({ ...options });
      await completeSetup(context);
      panel.dispose();
    } else if (message.type === 'ignore') {
      await completeSetup(context);
      panel.dispose();
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    await panel.webview.postMessage({ type: 'setupError', operation: message.type, message: text });
  }
}

export function getSetupHtml(webview: vscode.Webview, nonce: string, state: SetupState): string {
  const assets = webviewAssets(webview, 'setupPanel', { state });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${assets.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${assets.style}">
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div class="mascot" aria-hidden="true">(⌐■_■)</div>
      <h1>Welcome to ASKII</h1>
      <p class="subtitle">Connect a provider, choose your models, and tune the experience.</p>
    </header>
    <div class="steps" aria-label="Setup progress"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>

    <section id="providerScreen" class="screen panel">
      <h2>Choose a provider</h2><p class="lead">Your API key is encrypted by VS Code and never stored in settings.</p>
      <div id="providers" class="providers"></div>
      <div class="connection">
        <div id="apiKeyField" class="field"><label for="apiKey">API key <span id="savedCredential" class="saved"></span></label><input id="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="Paste a new key, or leave blank to reuse the saved key"><span class="hint">Saved credentials are never sent back to this page.</span></div>
        <div id="serverUrlField" class="field"><label for="serverUrl">Server URL</label><input id="serverUrl" type="url" spellcheck="false"></div>
        <div id="openaiUrlField" class="field"><label for="openaiUrl">OpenAI-compatible base URL <span class="hint">Optional — leave blank for api.openai.com.</span></label><input id="openaiUrl" type="url" spellcheck="false" placeholder="https://example.com/v1"></div>
      </div>
      <div id="providerError" class="error" role="alert"></div>
      <div class="actions"><div id="providerLoader" class="loader" aria-live="polite"><span class="spinner"></span><span>Validating and loading models…</span></div><button id="providerNext" class="btn">Next</button></div>
    </section>

    <section id="modelsScreen" class="screen panel">
      <h2>Choose models</h2><p id="modelLead" class="lead"></p><div id="modelWarning" class="warning" hidden></div>
      <div class="models">
        <div class="model-card"><label for="generalModel">General model</label><span class="hint">Ask, Edit, and Do</span><div id="generalModelHost"></div></div>
        <div class="model-card"><label for="inlineModel">Inline model</label><span class="hint">Suggestions, inline completion, and Git messages</span><div id="inlineModelHost"></div></div>
        <div class="model-card"><label for="visionModel">Vision model</label><span class="hint">Browse, Control, and Note — choose a vision-capable model</span><div id="visionModelHost"></div></div>
      </div>
      <div id="modelsError" class="error" role="alert"></div>
      <div class="actions"><button id="modelsBack" class="btn secondary">Back</button><span class="spacer"></span><button id="modelsNext" class="btn">Next</button></div>
    </section>

    <section id="optionsScreen" class="screen panel">
      <h2>Features &amp; agents</h2><p class="lead">Applied globally when you finish setup. Ignore keeps their current values.</p>
      <div class="option"><input id="inlineCompletionEnabled" type="checkbox"><div class="option-body"><label for="inlineCompletionEnabled">Inline code completion</label><span class="hint">Show Copilot-style ghost-text suggestions.</span><select id="inlineCompletionEagerness"><option value="low">Low — 1200 ms</option><option value="medium">Medium — 500 ms</option><option value="high">High — 200 ms</option></select></div></div>
      <div class="option"><div class="option-body"><label for="inlineHelperMode">Inline helper mode</label><span class="hint">Add concise explanations, jokes, or wiki context beside code.</span><select id="inlineHelperMode"><option value="off">Off</option><option value="helpful">Helpful</option><option value="funny">Funny</option><option value="wiki">Wiki</option></select></div></div>
      <div class="option"><input id="formatAfterEdit" type="checkbox"><div class="option-body"><label for="formatAfterEdit">Format after edits</label><span class="hint">Run the configured formatter after ASKII changes a file.</span></div></div>
      <h3>Agents</h3>
      <div class="option"><input id="doAutoConfirm" type="checkbox"><div class="option-body"><label for="doAutoConfirm">Automatically confirm Do actions</label><span class="hint danger">ASKII may create, modify, or delete files without asking first.</span></div></div>
      <div class="option"><input id="controlAutoConfirm" type="checkbox"><div class="option-body"><label for="controlAutoConfirm">Automatically confirm Control actions</label><span class="hint danger">ASKII may move the mouse, type, and navigate without asking first.</span></div></div>
      <div class="option"><div class="option-body"><label for="doMaxRounds">Max agent rounds</label><span class="hint">Maximum interaction rounds per Do or Control task before ASKII stops.</span><input id="doMaxRounds" type="number" min="1" step="1"></div></div>
      <h3>Browser</h3>
      <div class="option"><div class="option-body"><label for="chromePathInput">Browser executable</label><span class="hint">Optional — Chromium-based browser used by ASKII Control browser mode (Chrome, Edge, Chromium, Brave). Leave empty to auto-detect.</span><div class="pick-row"><input id="chromePathInput" type="text" spellcheck="false" placeholder="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"><button id="chromePathBrowse" class="btn secondary small" type="button">Browse…</button></div></div></div>
      <div class="option"><input id="browserHeadless" type="checkbox"><div class="option-body"><label for="browserHeadless">Run the browser headless</label><span class="hint">Run the ASKII Control browser without a visible window.</span></div></div>
      <div id="optionsError" class="error" role="alert"></div>
      <div class="actions"><button id="optionsBack" class="btn secondary">Back</button><span class="spacer"></span><button id="optionsIgnore" class="btn secondary">Ignore</button><button id="optionsNext" class="btn">Next</button></div>
    </section>

    <section id="wikiScreen" class="screen panel">
      <h2>Wiki &amp; commit rules</h2><p class="lead">Finish applies these globally. Ignore keeps their current values.</p>
      <div class="option"><input id="wikiEnabled" type="checkbox"><div class="option-body"><label for="wikiEnabled">Enable wiki RAG</label><span class="hint">Use the wiki as retrieval context for Ask, Edit, and Do. Requires a wiki folder and an index built via ASKII: Reload Wikis.</span></div></div>
      <div class="option"><div class="option-body"><label for="wikiPathInput">Wiki folder</label><span class="hint">Folder of .md documentation files used for wiki RAG context. Run ASKII: Reload Wikis to index it.</span><div class="pick-row"><input id="wikiPathInput" type="text" spellcheck="false" placeholder="Absolute path to your wiki folder"><button id="wikiPathBrowse" class="btn secondary small" type="button">Browse…</button></div></div></div>
      <div class="option"><input id="wikiAutoReload" type="checkbox"><div class="option-body"><label for="wikiAutoReload">Auto-reload wiki on startup</label><span class="hint">Rebuild and reload the wiki index whenever the extension starts. Requires wiki RAG and a wiki folder.</span></div></div>
      <h3>Code wiki</h3>
      <div class="option"><input id="codeWikiEnabled" type="checkbox"><div class="option-body"><label for="codeWikiEnabled">Enable code wiki</label><span class="hint">Vector index over workspace code (code files only) used as retrieval context for Ask, Edit, and Do. Runs the embeddinggemma2 model locally — the first index build downloads it once — then run ASKII: Reload Wikis.</span></div></div>
      <div class="option"><input id="codeWikiAutoReload" type="checkbox"><div class="option-body"><label for="codeWikiAutoReload">Auto-reload code wiki on startup</label><span class="hint">Rebuild the code wiki index whenever the extension starts. Unchanged files are reused, so only edits are re-embedded. Requires code wiki.</span></div></div>
      <div class="option"><div class="option-body"><label for="commitMessageStyle">Commit message style</label><span class="hint">Shape of the Git commit messages ASKII generates.</span><select id="commitMessageStyle"><option value="oneliner">One-liner — subject only</option><option value="brief">Brief — subject and short body</option><option value="descriptive">Descriptive — detailed body</option></select></div></div>
      <div class="option"><div class="option-body"><label for="commitRulesInput">Commit rules file</label><span class="hint">.md file with custom instructions appended to the commit message prompt. Absolute or workspace-relative. Leave empty for the built-in rules.</span><div class="pick-row"><input id="commitRulesInput" type="text" spellcheck="false" placeholder="Absolute or workspace-relative .md path"><button id="commitRulesBrowse" class="btn secondary small" type="button">Browse…</button></div></div></div>
      <div id="wikiError" class="error" role="alert"></div>
      <div class="actions"><button id="wikiBack" class="btn secondary">Back</button><span class="spacer"></span><button id="ignore" class="btn secondary">Ignore</button><button id="wikiNext" class="btn">Next</button></div>
    </section>

    <section id="advancedScreen" class="screen panel">
      <h2>Advanced settings</h2><p class="lead">Finish applies these globally. Ignore keeps their current values.</p>
      <h3>Notes &amp; reminders</h3>
      <div class="option"><input id="noteReminderSound" type="checkbox"><div class="option-body"><label for="noteReminderSound">Play a sound when a reminder fires</label><span class="hint">Chime when a note reminder notification is shown.</span></div></div>
      <div class="option"><div class="option-body"><label for="noteSnoozeMinutes">Snooze duration</label><span class="hint">Minutes a note reminder waits before firing again when you snooze it.</span><input id="noteSnoozeMinutes" type="number" min="1" step="1"></div></div>
      <h3>Reliability</h3>
      <div class="option"><div class="option-body"><label for="requestTimeoutSeconds">Request timeout (seconds)</label><span class="hint">Seconds before an LLM request is cancelled. 0 waits forever — useful for slow local models.</span><input id="requestTimeoutSeconds" type="number" min="0" step="1"></div></div>
      <div class="option"><div class="option-body"><label for="maxOutputTokens">Max output tokens</label><span class="hint">Cap on the tokens generated per request. 0 uses the provider default.</span><input id="maxOutputTokens" type="number" min="0" step="1"></div></div>
      <h3>Privacy</h3>
      <div class="option"><div class="option-body"><label for="inlineExcludeGlobs">Never send these files (inline features)</label><span class="hint">Files matching these globs are never sent by inline suggestions or completion. One glob per line.</span><textarea id="inlineExcludeGlobs" rows="5" spellcheck="false" placeholder="**/.env&#10;**/*.pem&#10;**/secrets/**"></textarea></div></div>
      <div id="advancedError" class="error" role="alert"></div>
      <div class="actions"><button id="advancedBack" class="btn secondary">Back</button><span class="spacer"></span><button id="advancedIgnore" class="btn secondary">Ignore</button><button id="finish" class="btn">Finish</button></div>
    </section>
  </main>
  <script id="askii-data" type="application/json">${assets.data}</script>
  <script nonce="${nonce}" src="${assets.script}"></script>
</body>
</html>`;
}
