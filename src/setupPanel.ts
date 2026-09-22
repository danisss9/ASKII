import * as vscode from 'vscode';
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
  isProviderId,
} from './setupCore';

export const SETUP_COMPLETE_KEY = 'askii.setup.completed';
const SETUP_PROGRESS_KEY = 'askii.setup.progress';

type SetupStep = 'provider' | 'models' | 'options';

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
  return {
    inlineCompletionEnabled: config.get<boolean>('inlineCompletionEnabled') ?? false,
    inlineCompletionEagerness: eagerness === 'low' || eagerness === 'high' ? eagerness : 'medium',
    inlineHelperMode:
      helperMode === 'helpful' || helperMode === 'funny' || helperMode === 'wiki'
        ? helperMode
        : 'off',
    formatAfterEdit: config.get<boolean>('formatAfterEdit') ?? false,
    doAutoConfirm: config.get<boolean>('doAutoConfirm') ?? false,
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
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
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
  return {
    inlineCompletionEnabled: message.inlineCompletionEnabled === true,
    inlineCompletionEagerness: eagerness,
    inlineHelperMode: helperMode,
    formatAfterEdit: message.formatAfterEdit === true,
    doAutoConfirm: message.doAutoConfirm === true,
  };
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

function serializeForHtml(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function getSetupHtml(webview: vscode.Webview, nonce: string, state: SetupState): string {
  const initialState = serializeForHtml(state);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; color: var(--vscode-foreground); background: radial-gradient(circle at 50% -20%, var(--vscode-editor-inactiveSelectionBackground), transparent 50%), var(--vscode-editor-background); font-family: var(--vscode-font-family, sans-serif); }
    button, input, select { font: inherit; }
    .shell { width: min(840px, calc(100% - 32px)); margin: 0 auto; padding: 30px 0 48px; }
    .hero { text-align: center; margin-bottom: 24px; animation: welcome .65s ease both; }
    .mascot { font: 700 28px/1.2 var(--vscode-editor-font-family, monospace); letter-spacing: 2px; display: inline-block; animation: float 2.6s ease-in-out infinite; }
    h1 { font-size: 26px; margin: 10px 0 6px; }
    .subtitle { color: var(--vscode-descriptionForeground); margin: 0; }
    .steps { display: flex; justify-content: center; gap: 8px; margin: 20px 0 26px; }
    .dot { width: 34px; height: 5px; border-radius: 9px; background: var(--vscode-progressBar-background); opacity: .25; transition: opacity .2s, transform .2s; }
    .dot.active { opacity: 1; transform: scaleX(1.12); }
    .screen { display: none; }
    .screen.active { display: block; animation: enter .28s ease both; }
    .panel { border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border)); background: var(--vscode-sideBar-background); border-radius: 14px; padding: 24px; box-shadow: 0 12px 36px rgba(0,0,0,.12); }
    .panel h2 { margin: 0 0 6px; font-size: 20px; }
    .lead { color: var(--vscode-descriptionForeground); margin: 0 0 20px; }
    .providers { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
    .provider { text-align: left; color: inherit; background: var(--vscode-editor-background); border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border)); border-radius: 9px; padding: 14px; cursor: pointer; opacity: 0; animation: card .35s ease forwards; }
    .provider:hover { border-color: var(--vscode-focusBorder); }
    .provider.selected { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .provider strong { display: block; margin-bottom: 4px; }
    .provider span { display: block; font-size: 12px; line-height: 1.45; color: var(--vscode-descriptionForeground); }
    .provider.selected span { color: inherit; opacity: .82; }
    .connection { margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--vscode-editorWidget-border); }
    .field { margin-bottom: 14px; }
    .field label, .field-title { display: block; font-weight: 600; margin-bottom: 6px; }
    .hint { display: block; color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 5px; line-height: 1.4; }
    input, select { width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border)); border-radius: 5px; padding: 9px 10px; outline: none; }
    input:focus, select:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); }
    .saved { color: var(--vscode-testing-iconPassed, #73c991); font-size: 12px; margin-left: 6px; }
    .models { display: grid; gap: 14px; }
    .model-card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-editorWidget-border); border-radius: 9px; padding: 15px; }
    .model-card label { font-weight: 600; display: block; margin-bottom: 4px; }
    .warning, .error { border-radius: 6px; padding: 10px 12px; margin: 12px 0; font-size: 13px; }
    .warning { color: var(--vscode-editorWarning-foreground); background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); }
    .error { color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); border: 1px solid var(--vscode-inputValidation-errorBorder); display: none; }
    .error.show { display: block; }
    .option { display: flex; align-items: flex-start; gap: 11px; padding: 13px 0; border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .option:last-child { border-bottom: 0; }
    .option input[type=checkbox] { width: auto; margin-top: 3px; }
    .option-body { flex: 1; }
    .option-body label { font-weight: 600; display: block; }
    .option select { margin-top: 8px; max-width: 280px; }
    .danger { color: var(--vscode-errorForeground); }
    .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 22px; }
    .actions .spacer { flex: 1; }
    .btn { border: 0; border-radius: 5px; padding: 9px 16px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn:disabled { opacity: .5; cursor: default; }
    .loader { display: none; align-items: center; gap: 10px; margin-right: auto; color: var(--vscode-descriptionForeground); }
    .loader.show { display: flex; }
    .spinner { width: 20px; height: 20px; border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes welcome { from { opacity: 0; transform: translateY(-12px); } }
    @keyframes enter { from { opacity: 0; transform: translateX(15px); } }
    @keyframes card { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
    @keyframes float { 50% { transform: translateY(-5px) rotate(-1deg); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (max-width: 620px) { .providers { grid-template-columns: 1fr; } .panel { padding: 18px; } .actions { flex-wrap: wrap; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <div class="mascot" aria-hidden="true">(⌐■_■)</div>
      <h1>Welcome to ASKII</h1>
      <p class="subtitle">Connect a provider, choose your models, and tune the experience.</p>
    </header>
    <div class="steps" aria-label="Setup progress"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>

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
      <h2>Optional settings</h2><p class="lead">Finish applies these globally. Ignore keeps their current values.</p>
      <div class="option"><input id="inlineCompletionEnabled" type="checkbox"><div class="option-body"><label for="inlineCompletionEnabled">Inline code completion</label><span class="hint">Show Copilot-style ghost-text suggestions.</span><select id="inlineCompletionEagerness"><option value="low">Low — 1200 ms</option><option value="medium">Medium — 500 ms</option><option value="high">High — 200 ms</option></select></div></div>
      <div class="option"><div class="option-body"><label for="inlineHelperMode">Inline helper mode</label><span class="hint">Add concise explanations, jokes, or wiki context beside code.</span><select id="inlineHelperMode"><option value="off">Off</option><option value="helpful">Helpful</option><option value="funny">Funny</option><option value="wiki">Wiki</option></select></div></div>
      <div class="option"><input id="formatAfterEdit" type="checkbox"><div class="option-body"><label for="formatAfterEdit">Format after edits</label><span class="hint">Run the configured formatter after ASKII changes a file.</span></div></div>
      <div class="option"><input id="doAutoConfirm" type="checkbox"><div class="option-body"><label for="doAutoConfirm">Automatically confirm actions</label><span class="hint danger">ASKII may create, modify, or delete files without asking first.</span></div></div>
      <div id="optionsError" class="error" role="alert"></div>
      <div class="actions"><button id="optionsBack" class="btn secondary">Back</button><span class="spacer"></span><button id="ignore" class="btn secondary">Ignore</button><button id="finish" class="btn">Finish</button></div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${initialState};
    const screens = { provider: document.getElementById('providerScreen'), models: document.getElementById('modelsScreen'), options: document.getElementById('optionsScreen') };
    const dots = Array.from(document.querySelectorAll('.dot'));
    const stepIndex = { provider: 0, models: 1, options: 2 };
    let selectedProvider = state.provider;
    let currentStep = state.step;

    function showError(id, text) { const el = document.getElementById(id); el.textContent = text || ''; el.classList.toggle('show', Boolean(text)); }
    function showStep(step) { currentStep = step; Object.entries(screens).forEach(([name, el]) => el.classList.toggle('active', name === step)); dots.forEach((dot, index) => dot.classList.toggle('active', index <= stepIndex[step])); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    function providerDefinition() { return state.providers.find((provider) => provider.id === selectedProvider); }
    function selectProvider(provider) {
      selectedProvider = provider;
      document.querySelectorAll('.provider').forEach((card) => card.classList.toggle('selected', card.dataset.provider === provider));
      const definition = providerDefinition();
      document.getElementById('apiKeyField').hidden = definition.connection !== 'apiKey';
      document.getElementById('serverUrlField').hidden = definition.connection !== 'serverUrl';
      document.getElementById('openaiUrlField').hidden = !definition.supportsCustomBaseUrl;
      document.getElementById('savedCredential').textContent = state.savedCredentials[provider] ? '✓ saved' : '';
      document.getElementById('serverUrl').value = provider === 'ollama' ? state.urls.ollama : provider === 'lmstudio' ? state.urls.lmstudio : '';
      document.getElementById('openaiUrl').value = state.urls.openai;
      document.getElementById('apiKey').value = '';
      showError('providerError', '');
    }
    const providersHost = document.getElementById('providers');
    state.providers.forEach((provider, index) => {
      const card = document.createElement('button'); card.type = 'button'; card.className = 'provider'; card.dataset.provider = provider.id; card.style.animationDelay = (index * 55) + 'ms';
      const title = document.createElement('strong'); title.textContent = provider.label; const description = document.createElement('span'); description.textContent = provider.description;
      card.append(title, description); card.addEventListener('click', () => selectProvider(provider.id)); providersHost.appendChild(card);
    });

    function buildModelControl(role, value) {
      const host = document.getElementById(role + 'ModelHost'); host.textContent = '';
      const control = document.createElement(state.manualModels ? 'input' : 'select'); control.id = role + 'Model'; control.dataset.role = role;
      if (state.manualModels) { control.type = 'text'; control.placeholder = 'Enter the exact model ID'; control.value = value || ''; }
      else { const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = 'Choose a model…'; control.appendChild(placeholder); state.models.forEach((model) => { const option = document.createElement('option'); option.value = model; option.textContent = model; control.appendChild(option); }); control.value = value || ''; }
      host.appendChild(control);
    }
    function renderModels() {
      document.getElementById('modelLead').textContent = state.manualModels ? 'Enter the exact model ID for each ASKII role.' : state.models.length + ' models found for ' + providerDefinition().label + '.';
      const warning = document.getElementById('modelWarning'); warning.hidden = !state.modelWarning; warning.textContent = state.modelWarning;
      buildModelControl('general', state.selections.general); buildModelControl('inline', state.selections.inline); buildModelControl('vision', state.selections.vision);
    }
    document.getElementById('inlineCompletionEnabled').checked = state.options.inlineCompletionEnabled;
    document.getElementById('inlineCompletionEagerness').value = state.options.inlineCompletionEagerness;
    document.getElementById('inlineHelperMode').value = state.options.inlineHelperMode;
    document.getElementById('formatAfterEdit').checked = state.options.formatAfterEdit;
    document.getElementById('doAutoConfirm').checked = state.options.doAutoConfirm;

    document.getElementById('providerNext').addEventListener('click', () => {
      const definition = providerDefinition(); const apiKey = document.getElementById('apiKey').value.trim(); const serverUrl = document.getElementById('serverUrl').value.trim();
      if (definition.connection === 'apiKey' && !apiKey && !state.savedCredentials[selectedProvider]) { showError('providerError', 'Enter an API key.'); return; }
      if (definition.connection === 'serverUrl' && !serverUrl) { showError('providerError', 'Enter a server URL.'); return; }
      showError('providerError', ''); document.getElementById('providerLoader').classList.add('show'); document.getElementById('providerNext').disabled = true;
      vscode.postMessage({ type: 'validateProvider', provider: selectedProvider, apiKey, serverUrl, openaiBaseUrl: document.getElementById('openaiUrl').value.trim() });
    });
    document.getElementById('modelsBack').addEventListener('click', () => showStep('provider'));
    document.getElementById('modelsNext').addEventListener('click', () => {
      const values = { general: document.getElementById('generalModel').value.trim(), inline: document.getElementById('inlineModel').value.trim(), vision: document.getElementById('visionModel').value.trim() };
      if (!values.general || !values.inline || !values.vision) { showError('modelsError', 'Choose a model for all three roles.'); return; }
      state.selections = values; showError('modelsError', ''); document.getElementById('modelsNext').disabled = true; vscode.postMessage({ type: 'saveModels', provider: selectedProvider, ...values });
    });
    document.getElementById('optionsBack').addEventListener('click', () => showStep('models'));
    document.getElementById('ignore').addEventListener('click', () => { document.getElementById('ignore').disabled = true; document.getElementById('finish').disabled = true; vscode.postMessage({ type: 'ignore' }); });
    document.getElementById('finish').addEventListener('click', () => { document.getElementById('ignore').disabled = true; document.getElementById('finish').disabled = true; vscode.postMessage({ type: 'finish', inlineCompletionEnabled: document.getElementById('inlineCompletionEnabled').checked, inlineCompletionEagerness: document.getElementById('inlineCompletionEagerness').value, inlineHelperMode: document.getElementById('inlineHelperMode').value, formatAfterEdit: document.getElementById('formatAfterEdit').checked, doAutoConfirm: document.getElementById('doAutoConfirm').checked }); });

    window.addEventListener('message', (event) => {
      const message = event.data; if (!message || typeof message !== 'object') return;
      if (message.type === 'providerValidated') {
        document.getElementById('providerLoader').classList.remove('show'); document.getElementById('providerNext').disabled = false; document.getElementById('apiKey').value = '';
        state.savedCredentials[selectedProvider] = message.savedCredential || state.savedCredentials[selectedProvider]; state.models = message.models; state.manualModels = message.manual; state.modelWarning = message.warning; state.selections = message.selections; renderModels(); showStep('models');
      } else if (message.type === 'modelsSaved') { document.getElementById('modelsNext').disabled = false; showStep('options'); }
      else if (message.type === 'setupError') {
        if (message.operation === 'validateProvider') { document.getElementById('providerLoader').classList.remove('show'); document.getElementById('providerNext').disabled = false; showError('providerError', message.message); }
        else if (message.operation === 'saveModels') { document.getElementById('modelsNext').disabled = false; showError('modelsError', message.message); }
        else { document.getElementById('ignore').disabled = false; document.getElementById('finish').disabled = false; showError('optionsError', message.message); }
      }
    });
    selectProvider(selectedProvider); renderModels(); showStep(currentStep);
  </script>
</body>
</html>`;
}
