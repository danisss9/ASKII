import {
  getWorkspaceStructure,
  parseWorkspaceActions,
  sandboxPath,
  executeViewAction,
  executeSearchAction,
  buildDoSystemPrompt,
  buildGenerateSystemPrompt,
  writeBackup,
  recordCreatedFile,
  deleteAllBackups,
  restoreAllBackups,
  hasBackups,
  type WorkspaceAction,
  type ActionResult,
} from '@common/workspace';
import { unescapeJsonString, extractCode } from '@common/utils';
import { buildWikiIndex, saveWikiIndex, loadWikiIndex, searchWiki } from '@common/wiki';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import {
  getOllamaResponse,
  getLMStudioResponse,
  getOllamaChatStreaming,
  getLMStudioChatStreaming,
  getOpenAIResponse,
  getOpenAIChatStreaming,
  getAnthropicResponse,
  getAnthropicChatStreaming,
  getOpenCodeGoResponse,
  getOpenCodeGoChatStreaming,
  OPENCODE_GO_URL,
  getAskiiCloudResponse,
  getAskiiCloudChatStreaming,
  ASKII_CLOUD_URL,
  retryLLMCall,
  type ChatMessage,
} from '@common/providers';
import {
  buildControlSystemPrompt,
  takeScreenshot,
  describeAction,
  executeControlAction,
  getMonitors,
  getSystemInfo,
  parseControlResponse,
  refineCoordinates,
  checkControlDependencies,
  type ControlAction,
  type ControlHistoryEntry,
  type SystemInfo,
} from '@common/control';
import {
  buildBrowserSystemPrompt,
  parseBrowserAction,
  describeBrowserAction,
  executeBrowserAction,
  takePageScreenshot,
} from '@common/browser';
import {
  type NoteEntry,
  type NoteKind,
  type TaskPriority,
  type NoteContext,
  searchNotes,
  parseReminderTimeLocal,
} from '@common/notes';
import { randomBytes } from 'crypto';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface Config {
  platform: 'ollama' | 'lmstudio' | 'openai' | 'anthropic' | 'opencodego' | 'askiicloud';
  url: string;
  model: string;
  openaiApiKey: string;
  openaiBaseURL: string | undefined;
  anthropicApiKey: string;
  opencodegoApiKey: string;
  opencodegoBaseURL: string;
  askiicloudApiKey: string;
  mode: 'helpful' | 'funny';
  maxRounds: number;
  yes: boolean;
  headless: boolean;
  chromePath: string | undefined;
  wikiPath: string | undefined;
  useWiki: boolean;
}

function getFlagValue(flags: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = flags.indexOf(name);
    if (i !== -1 && flags[i + 1] && !flags[i + 1].startsWith('-')) {
      return flags[i + 1];
    }
  }
  return undefined;
}

function hasFlag(flags: string[], ...names: string[]): boolean {
  return names.some((n) => flags.includes(n));
}

function getConfig(flags: string[]): Config {
  const platform = (getFlagValue(flags, '-p', '--platform') ||
    process.env.ASKII_PLATFORM ||
    'ollama') as 'ollama' | 'lmstudio' | 'openai' | 'anthropic' | 'opencodego' | 'askiicloud';

  const ollamaUrl =
    getFlagValue(flags, '--ollama-url') || process.env.ASKII_OLLAMA_URL || 'http://localhost:11434';

  const lmStudioUrl =
    getFlagValue(flags, '--lmstudio-url') ||
    process.env.ASKII_LMSTUDIO_URL ||
    'ws://localhost:1234';

  const ollamaModel =
    getFlagValue(flags, '--ollama-model') || process.env.ASKII_OLLAMA_MODEL || 'gemma4:e4b';

  const lmStudioModel =
    getFlagValue(flags, '--lmstudio-model') ||
    process.env.ASKII_LMSTUDIO_MODEL ||
    'qwen/qwen3-coder-30b';

  const openaiModel =
    getFlagValue(flags, '--openai-model') || process.env.ASKII_OPENAI_MODEL || 'gpt-5-mini';

  const openaiApiKey = getFlagValue(flags, '--openai-key') || process.env.ASKII_OPENAI_KEY || '';

  const openaiBaseURL =
    getFlagValue(flags, '--openai-url') || process.env.ASKII_OPENAI_URL || undefined;

  const anthropicApiKey =
    getFlagValue(flags, '--anthropic-key') || process.env.ASKII_ANTHROPIC_KEY || '';

  const anthropicModel =
    getFlagValue(flags, '--anthropic-model') ||
    process.env.ASKII_ANTHROPIC_MODEL ||
    'claude-sonnet-4-6';

  const opencodegoApiKey =
    getFlagValue(flags, '--opencodego-key') || process.env.ASKII_OPENCODEGO_KEY || '';

  const opencodegoModel =
    getFlagValue(flags, '--opencodego-model') || process.env.ASKII_OPENCODEGO_MODEL || 'glm-5.2';

  const opencodegoBaseURL =
    getFlagValue(flags, '--opencodego-url') || process.env.ASKII_OPENCODEGO_URL || OPENCODE_GO_URL;

  const askiicloudApiKey =
    getFlagValue(flags, '--askiicloud-key') || process.env.ASKII_CLOUD_KEY || '';

  const askiicloudModel =
    getFlagValue(flags, '--askiicloud-model') || process.env.ASKII_CLOUD_MODEL || 'askii-default';

  const modelMap: Record<string, string> = {
    lmstudio: lmStudioModel,
    openai: openaiModel,
    anthropic: anthropicModel,
    opencodego: opencodegoModel,
    askiicloud: askiicloudModel,
  };

  return {
    platform,
    url: platform === 'lmstudio' ? lmStudioUrl : ollamaUrl,
    model: modelMap[platform] ?? ollamaModel,
    openaiApiKey,
    openaiBaseURL,
    anthropicApiKey,
    opencodegoApiKey,
    opencodegoBaseURL,
    askiicloudApiKey,
    mode: (getFlagValue(flags, '--mode') || process.env.ASKII_MODE || 'funny') as
      | 'helpful'
      | 'funny',
    maxRounds: parseInt(getFlagValue(flags, '--max-rounds') || process.env.ASKII_MAX_ROUNDS || '5'),
    yes: hasFlag(flags, '-y', '--yes'),
    headless: hasFlag(flags, '--headless'),
    chromePath: getFlagValue(flags, '--chrome-path') || process.env.ASKII_CHROME_PATH || undefined,
    wikiPath: getFlagValue(flags, '--wiki-path') || process.env.ASKII_WIKI_PATH || undefined,
    useWiki: hasFlag(flags, '--use-wiki') || process.env.ASKII_USE_WIKI === '1',
  };
}

function getCliWikiContext(config: Config, query: string): string {
  if (!config.useWiki || !config.wikiPath) return '';
  const index = loadWikiIndex(config.wikiPath);
  if (!index) {
    console.error('  [wiki] No index found — run: askii wiki-reload --wiki-path <path>');
    return '';
  }
  const ctx = searchWiki(query, index);
  if (ctx) console.error(`  [wiki] Injecting ${ctx.length} chars of context`);
  return ctx;
}

async function getResponse(
  config: Config,
  prompt: string,
  system?: string,
  imageBase64?: string,
): Promise<string> {
  if (config.platform === 'anthropic') {
    return getAnthropicResponse(prompt, config.anthropicApiKey, config.model, system, imageBase64);
  } else if (config.platform === 'opencodego') {
    return getOpenCodeGoResponse(
      prompt,
      config.opencodegoApiKey,
      config.model,
      config.opencodegoBaseURL,
      system,
      imageBase64,
    );
  } else if (config.platform === 'askiicloud') {
    return getAskiiCloudResponse(
      prompt,
      config.askiicloudApiKey,
      config.model,
      ASKII_CLOUD_URL,
      system,
      imageBase64,
    );
  } else if (config.platform === 'lmstudio') {
    return getLMStudioResponse(prompt, config.url, config.model, system, imageBase64);
  } else if (config.platform === 'openai') {
    return getOpenAIResponse(
      prompt,
      config.openaiApiKey,
      config.model,
      config.openaiBaseURL,
      system,
      imageBase64,
    );
  } else {
    return getOllamaResponse(
      prompt,
      config.url,
      config.model,
      system,
      imageBase64 ? [imageBase64] : undefined,
    );
  }
}

async function getChatResponseStreaming(
  config: Config,
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
): Promise<string> {
  if (config.platform === 'anthropic') {
    return getAnthropicChatStreaming(messages, config.anthropicApiKey, config.model, onChunk);
  } else if (config.platform === 'opencodego') {
    return getOpenCodeGoChatStreaming(
      messages,
      config.opencodegoApiKey,
      config.model,
      onChunk,
      config.opencodegoBaseURL,
    );
  } else if (config.platform === 'askiicloud') {
    return getAskiiCloudChatStreaming(
      messages,
      config.askiicloudApiKey,
      config.model,
      onChunk,
      ASKII_CLOUD_URL,
    );
  } else if (config.platform === 'lmstudio') {
    return getLMStudioChatStreaming(messages, config.url, config.model, onChunk);
  } else if (config.platform === 'openai') {
    return getOpenAIChatStreaming(
      messages,
      config.openaiApiKey,
      config.model,
      onChunk,
      config.openaiBaseURL,
    );
  }
  return getOllamaChatStreaming(messages, config.url, config.model, onChunk);
}

function executeCliWriteAction(
  action: WorkspaceAction,
  filePath: string,
  workDir: string,
): 'ok' | string {
  switch (action.type) {
    case 'mkdir': {
      fs.mkdirSync(filePath, { recursive: true });
      console.error(`  ✓ Created directory: ${action.path}`);
      return 'ok';
    }

    case 'copy': {
      if (!action.newPath) return 'copy requires newPath';
      const destPath = sandboxPath(workDir, action.newPath);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(filePath, destPath);
      console.error(`  ✓ Copied: ${action.path} → ${action.newPath}`);
      return 'ok';
    }

    case 'create':
    case 'write': {
      if (action.type === 'write') writeBackup(workDir, filePath);
      if (action.type === 'create') recordCreatedFile(workDir, action.path!);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const content = action.content ? unescapeJsonString(action.content) : '';
      fs.writeFileSync(filePath, content);
      console.error(`  ✓ ${action.type === 'create' ? 'Created' : 'Wrote'}: ${action.path}`);
      return 'ok';
    }

    case 'modify': {
      writeBackup(workDir, filePath);
      const existing = fs.readFileSync(filePath, 'utf-8');
      if (action.startLine !== undefined || action.endLine !== undefined) {
        const lines = existing.split('\n');
        const start = (action.startLine ?? 1) - 1;
        const end = action.endLine ?? lines.length;
        const replacement = (action.newContent ? unescapeJsonString(action.newContent) : '').split(
          '\n',
        );
        lines.splice(start, end - start, ...replacement);
        fs.writeFileSync(filePath, lines.join('\n'));
        console.error(`  ✓ Modified (lines ${action.startLine}–${action.endLine}): ${action.path}`);
      } else {
        const oldContent = action.oldContent ? unescapeJsonString(action.oldContent) : '';
        const newContent = action.newContent ? unescapeJsonString(action.newContent) : '';
        if (oldContent && !existing.includes(oldContent)) {
          return `oldContent not found in ${action.path}`;
        }
        fs.writeFileSync(filePath, existing.replace(oldContent, newContent));
        console.error(`  ✓ Modified: ${action.path}`);
      }
      return 'ok';
    }

    case 'delete': {
      writeBackup(workDir, filePath);
      fs.unlinkSync(filePath);
      console.error(`  ✓ Deleted: ${action.path}`);
      return 'ok';
    }

    case 'rename': {
      if (!action.newPath) return 'rename requires newPath';
      writeBackup(workDir, filePath);
      const newFilePath = sandboxPath(workDir, action.newPath);
      const newDir = path.dirname(newFilePath);
      if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
      fs.renameSync(filePath, newFilePath);
      console.error(`  ✓ Renamed: ${action.path} → ${action.newPath}`);
      return 'ok';
    }

    default:
      return `Unknown action type: ${(action as WorkspaceAction).type}`;
  }
}

function buildCliConfirmMessage(action: WorkspaceAction): string {
  switch (action.type) {
    case 'delete':
      return `Delete file: ${action.path}? (backup will be created)`;
    case 'rename':
      return `Rename: ${action.path} → ${action.newPath}?`;
    case 'copy':
      return `Copy: ${action.path} → ${action.newPath}?`;
    case 'mkdir':
      return `Create directory: ${action.path}?`;
    default:
      return `${action.type}: ${action.path}?`;
  }
}

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim() || null));
  });
}

async function confirm(
  rl: readline.Interface,
  question: string,
  autoYes: boolean,
): Promise<boolean> {
  if (autoYes) {
    console.error(`${question} (auto-confirmed)`);
    return true;
  }
  return new Promise((resolve) => {
    rl.question(`${question} (y/N) `, (answer) => resolve(answer.toLowerCase() === 'y'));
  });
}

function replCompleter(line: string): [string[], string] {
  const COMMANDS = [
    '/help',
    '/ask ',
    '/do ',
    '/generate ',
    '/commit',
    '/note ',
    '/edit ',
    '/explain ',
    '/wiki-reload',
    '/platform ',
    '/model ',
    '/config',
    '/clear',
    '/exit',
    '/quit',
  ];
  if (line.startsWith('/')) {
    const hits = COMMANDS.filter((c) => c.startsWith(line));
    return [hits.length ? hits : COMMANDS, line];
  }
  return [[], line];
}

function printReplHelp(): void {
  console.log(`
REPL Commands:
  <message>                      Chat with ASKII (persistent history)
  /ask <question>                Explicit ask (same as bare text)
  /do <task> [--max-rounds N]    Run the Do agent (--yes/-y to auto-confirm)
  /generate <type> <base>        Generate a file (type: test|doc|json) — agentic, can search & ask
  /commit                        Generate a commit message from staged/working-tree diff
  /note <subcommand>             Notes / tasks / reminders (add, list, search, done, delete, due)
  /edit --file <path> <instr>    Edit a file in place
  /explain <text>                Explain a line of code
  /wiki-reload                   Rebuild the docs wiki index
  /platform <name>               Switch platform: ollama|lmstudio|openai|anthropic|opencodego|askiicloud
  /model <name>                  Switch model for current session
  /config                        Show current session config
  /clear                         Clear chat history (start a fresh conversation)
  /exit, /quit                   Exit interactive mode

Config overrides (bare flags at the prompt update session config):
  --platform <name>  --model <name>  --max-rounds <n>  --mode <mode>
`);
}

function printWelcomeBanner(config: Config): void {
  const wikiStatus = config.useWiki ? `on (${config.wikiPath ?? 'no path set'})` : 'off';
  console.error(`
ASKII ( •_•)>⌐■-■ (⌐■_■)  — interactive mode

  Platform : ${config.platform} (${config.model})
  Workspace: ${process.cwd()}
  Wiki     : ${wikiStatus}

Type a message to chat, /help for commands, /exit to quit.
`);
}

const PLATFORM_DEFAULT_MODELS: Record<string, string> = {
  ollama: process.env.ASKII_OLLAMA_MODEL || 'gemma4:e4b',
  lmstudio: process.env.ASKII_LMSTUDIO_MODEL || 'qwen/qwen3-coder-30b',
  openai: process.env.ASKII_OPENAI_MODEL || 'gpt-5-mini',
  anthropic: process.env.ASKII_ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  opencodego: process.env.ASKII_OPENCODEGO_MODEL || 'glm-5.2',
  askiicloud: process.env.ASKII_CLOUD_MODEL || 'askii-default',
};

function mergeConfigOverride(base: Config, tokens: string[]): Config {
  const result = { ...base };

  const platform = getFlagValue(tokens, '-p', '--platform');
  if (platform) {
    result.platform = platform as Config['platform'];
    // Switch to the platform's default model unless an explicit model flag is also present
    result.model = PLATFORM_DEFAULT_MODELS[platform] ?? result.model;
  }

  const model =
    getFlagValue(tokens, '--model') ??
    getFlagValue(tokens, '--ollama-model') ??
    getFlagValue(tokens, '--lmstudio-model') ??
    getFlagValue(tokens, '--openai-model') ??
    getFlagValue(tokens, '--anthropic-model') ??
    getFlagValue(tokens, '--opencodego-model') ??
    getFlagValue(tokens, '--askiicloud-model');
  if (model) result.model = model;

  const maxRoundsStr = getFlagValue(tokens, '--max-rounds');
  if (maxRoundsStr) result.maxRounds = parseInt(maxRoundsStr, 10) || result.maxRounds;

  const mode = getFlagValue(tokens, '--mode');
  if (mode) result.mode = mode as Config['mode'];

  if (hasFlag(tokens, '-y', '--yes')) result.yes = true;

  return result;
}

async function runReplAsk(question: string, config: Config, history: ChatMessage[]): Promise<void> {
  if (history.length === 0) {
    const system =
      config.mode === 'helpful'
        ? 'You are ASKII, a helpful coding assistant. Provide clear, concise answers.'
        : 'You are ASKII, a witty coding assistant who sprinkles in humor and kaomoji.';
    history.push({ role: 'system', content: system });
  }

  const wikiCtx = getCliWikiContext(config, question);
  const wikiSection = wikiCtx ? `Relevant documentation:\n${wikiCtx}\n\n` : '';

  history.push({ role: 'user', content: `${wikiSection}${question}` });

  process.stderr.write(`\nASKII: `);
  let response = '';
  try {
    response = await getChatResponseStreaming(config, history, (chunk) =>
      process.stdout.write(chunk),
    );
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : 'Unknown error'}`);
    history.pop();
    return;
  }
  process.stdout.write('\n');
  history.push({ role: 'assistant', content: response });
}

async function runReplDo(
  task: string,
  config: Config,
  rl: readline.Interface,
  abortController: AbortController,
): Promise<void> {
  const workDir = path.resolve(process.cwd());

  deleteAllBackups(workDir);
  console.error(`ASKII is working... ${getRandomThinkingKaomoji()}`);
  console.error('Press Ctrl+C to cancel.\n');

  try {
    const workspaceStructure = getWorkspaceStructure(workDir);
    console.error(`Workspace: ${workDir}\n\`\`\`\n${workspaceStructure}\`\`\`\n`);

    const wikiAvailable = !!(config.wikiPath && loadWikiIndex(config.wikiPath));
    const systemPrompt = buildDoSystemPrompt(workspaceStructure, wikiAvailable);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: task },
    ];

    let completedActions = 0;
    let roundCount = 0;

    while (roundCount < config.maxRounds && !abortController.signal.aborted) {
      console.error(`\n[Round ${roundCount + 1}/${config.maxRounds}]`);

      process.stderr.write('AI: ');
      const responseText = await retryLLMCall(
        () => getChatResponseStreaming(config, messages, (chunk) => process.stderr.write(chunk)),
        2,
        (attempt, err) =>
          console.error(`\nLLM call failed (attempt ${attempt}): ${err.message}. Retrying...`),
      );
      process.stderr.write('\n');

      if (abortController.signal.aborted) break;
      messages.push({ role: 'assistant', content: responseText });

      const actions = parseWorkspaceActions(responseText);
      if (actions.length === 0) {
        console.error('No actions returned. Done.');
        if (responseText.trim()) {
          console.error(`Raw (first 500): ${responseText.substring(0, 500)}`);
        }
        break;
      }

      const readActions = actions.filter(
        (a) =>
          a.type === 'view' || a.type === 'list' || a.type === 'search' || a.type === 'wiki_search',
      );
      const writeActions = actions.filter(
        (a) =>
          a.type !== 'view' && a.type !== 'list' && a.type !== 'search' && a.type !== 'wiki_search',
      );

      const feedbackParts: string[] = [];

      const viewResults: Record<string, string> = {};
      for (const action of readActions) {
        try {
          if (action.type === 'wiki_search') {
            const q = action.query ?? '';
            console.error(`  → Wiki search: "${q}"`);
            const wikiData = config.wikiPath ? loadWikiIndex(config.wikiPath) : null;
            viewResults[`wiki_search:${q}`] = wikiData
              ? searchWiki(q, wikiData) || 'No wiki results found'
              : 'Wiki not available — run: askii wiki-reload --wiki-path <path>';
          } else if (action.type === 'search') {
            console.error(`  → Search: "${action.pattern}"`);
            viewResults[`search:${action.pattern}`] = executeSearchAction(action, workDir);
          } else if (action.type === 'view' && action.paths) {
            for (const p of action.paths) {
              console.error(`  → Viewing: ${p}`);
              try {
                viewResults[p] = executeViewAction(
                  { ...action, path: p, paths: undefined },
                  workDir,
                );
              } catch (e) {
                viewResults[p] = `Error: ${e instanceof Error ? e.message : 'Cannot read'}`;
              }
            }
          } else {
            console.error(`  → ${action.type === 'list' ? 'Listing' : 'Viewing'}: ${action.path}`);
            viewResults[action.path!] = executeViewAction(action, workDir);
          }
        } catch (e) {
          viewResults[action.path ?? 'unknown'] =
            `Error: ${e instanceof Error ? e.message : 'Cannot read path'}`;
        }
      }

      if (Object.keys(viewResults).length > 0) {
        feedbackParts.push(`File/search results:\n${JSON.stringify(viewResults, null, 2)}`);
      }

      const actionResults: ActionResult[] = [];

      for (const action of writeActions) {
        let filePath: string;
        try {
          filePath = sandboxPath(workDir, action.path!);
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Path error';
          console.error(`  ✗ BLOCKED: ${msg}`);
          actionResults.push({
            action: `${action.type}:${action.path}`,
            status: 'error',
            detail: msg,
          });
          continue;
        }

        if (action.type === 'run') {
          console.error(`  → Run: ${action.command}`);
          const ok = await confirm(
            rl,
            `Run command: "${action.command}"? (executes shell code)`,
            false,
          );
          if (!ok) {
            actionResults.push({ action: `run:${action.command}`, status: 'skipped' });
            continue;
          }
          try {
            const { execSync } = await import('child_process');
            const output = execSync(action.command!, {
              cwd: workDir,
              encoding: 'utf-8',
              timeout: 30000,
            });
            console.error(`  ✓ Run output:\n${output}`);
            actionResults.push({
              action: `run:${action.command}`,
              status: 'ok',
              detail: output.substring(0, 500),
            });
          } catch (e: unknown) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            const detail =
              `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message || 'Unknown error';
            console.error(`  ✗ Run failed:\n${detail}`);
            actionResults.push({
              action: `run:${action.command}`,
              status: 'error',
              detail: detail.substring(0, 500),
            });
          }
          continue;
        }

        const promptMsg = buildCliConfirmMessage(action);
        const ok = await confirm(rl, promptMsg, config.yes);
        if (!ok) {
          actionResults.push({ action: `${action.type}:${action.path}`, status: 'skipped' });
          continue;
        }

        try {
          const result = executeCliWriteAction(action, filePath, workDir);
          if (result === 'ok') completedActions++;
          actionResults.push({
            action: `${action.type}:${action.path}`,
            status: result === 'ok' ? 'ok' : 'error',
            detail: result === 'ok' ? undefined : result,
          });
        } catch (e) {
          const detail = e instanceof Error ? e.message : 'Unknown error';
          console.error(`  ✗ Failed: ${detail}`);
          actionResults.push({ action: `${action.type}:${action.path}`, status: 'error', detail });
        }
      }

      if (actionResults.length > 0) {
        feedbackParts.push(`Action results: ${JSON.stringify(actionResults)}`);
      }

      if (feedbackParts.length === 0) break;

      messages.push({
        role: 'user',
        content:
          feedbackParts.join('\n\n') +
          '\n\nWhat would you like to do next? Respond with only a JSON array of actions or [] if done.',
      });

      roundCount++;
    }

    if (roundCount >= config.maxRounds) {
      console.error(`\nMax rounds (${config.maxRounds}) reached.`);
    }
    console.error(`\nCompleted ${completedActions} actions! ${getRandomKaomoji()}`);

    if (hasBackups(workDir)) {
      const doUndo = await confirm(
        rl,
        'Undo all changes? (y = restore backups, n = keep changes and delete backups)',
        false,
      );
      if (doUndo) {
        const { restored, deleted } = restoreAllBackups(workDir);
        deleteAllBackups(workDir);
        console.error(
          `Undone — restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
        );
      } else {
        deleteAllBackups(workDir);
      }
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ── Generate agent (shared by CLI command + REPL) ────────────────────────────
const GENERATE_TYPES = ['test', 'doc', 'json'] as const;
type GenerateType = (typeof GENERATE_TYPES)[number];

function normalizeGenerateType(input: string): GenerateType | undefined {
  const lower = input.toLowerCase();
  if (GENERATE_TYPES.includes(lower as GenerateType)) return lower as GenerateType;
  return undefined;
}

async function runGenerate(
  fileType: GenerateType,
  baseName: string,
  config: Config,
  workDir: string,
  rl: readline.Interface,
  abortController: AbortController,
  contextFile?: string,
  instruction?: string,
): Promise<void> {
  deleteAllBackups(workDir);
  console.error(`ASKII is generating... ${getRandomThinkingKaomoji()}`);
  console.error(`Type: ${fileType} | Base name: ${baseName}`);
  console.error('Press Ctrl+C to cancel.\n');

  try {
    const workspaceStructure = getWorkspaceStructure(workDir);
    console.error(`Workspace: ${workDir}\n\`\`\`\n${workspaceStructure}\`\`\`\n`);

    // Gather optional context from --file (acts as "current tab")
    let currentTab = '';
    let currentTabInfo = '';
    if (contextFile) {
      try {
        const fullPath = path.resolve(workDir, contextFile);
        const raw = fs.readFileSync(fullPath, 'utf-8');
        const cap = 8000;
        currentTab = raw.length > cap ? raw.substring(0, cap) + '\n…[truncated]' : raw;
        currentTabInfo = `File: ${path.basename(fullPath)} (from --file)`;
      } catch (e) {
        console.error(
          `Warning: could not read --file context: ${e instanceof Error ? e.message : 'unknown'}`,
        );
      }
    }

    const wikiAvailable = !!(config.wikiPath && loadWikiIndex(config.wikiPath));
    const systemPrompt = buildGenerateSystemPrompt({
      fileType: fileType === 'test' ? 'Test' : fileType === 'doc' ? 'Doc' : 'Json',
      baseName,
      workspaceStructure,
      wikiAvailable,
      currentTab: currentTabInfo ? `${currentTabInfo}\n${currentTab}` : '',
      selectedText: '',
    });

    const userRequestParts = [
      `Generate a ${fileType} file. Base name: "${baseName}".`,
      currentTabInfo ? `Context file: ${currentTabInfo}` : '',
      instruction ? `Extra instruction: ${instruction}` : '',
      'Inspect the workspace as needed, ask clarifications if required, then create the file.',
    ].filter(Boolean);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userRequestParts.join('\n\n') },
    ];

    let createdPath: string | undefined;
    let roundCount = 0;

    while (roundCount < config.maxRounds && !abortController.signal.aborted) {
      console.error(`\n[Round ${roundCount + 1}/${config.maxRounds}]`);

      process.stderr.write('AI: ');
      const responseText = await retryLLMCall(
        () => getChatResponseStreaming(config, messages, (chunk) => process.stderr.write(chunk)),
        2,
        (attempt, err) =>
          console.error(`\nLLM call failed (attempt ${attempt}): ${err.message}. Retrying...`),
      );
      process.stderr.write('\n');

      if (abortController.signal.aborted) break;
      messages.push({ role: 'assistant', content: responseText });

      const actions = parseWorkspaceActions(responseText);
      if (actions.length === 0) {
        console.error('No actions returned. Done.');
        break;
      }

      const readActions = actions.filter(
        (a) =>
          a.type === 'view' || a.type === 'list' || a.type === 'search' || a.type === 'wiki_search',
      );
      const clarifyActions = actions.filter((a) => a.type === 'clarify');
      const writeActions = actions.filter((a) => a.type === 'create' || a.type === 'write');

      const feedbackParts: string[] = [];

      // ── Read actions ──────────────────────────────────────────────────────
      const viewResults: Record<string, string> = {};
      for (const action of readActions) {
        try {
          if (action.type === 'wiki_search') {
            const q = action.query ?? '';
            console.error(`  → Wiki search: "${q}"`);
            const wikiData = config.wikiPath ? loadWikiIndex(config.wikiPath) : null;
            viewResults[`wiki_search:${q}`] = wikiData
              ? searchWiki(q, wikiData) || 'No wiki results found'
              : 'Wiki not available — run: askii wiki-reload --wiki-path <path>';
          } else if (action.type === 'search') {
            console.error(`  → Search: "${action.pattern}"`);
            viewResults[`search:${action.pattern}`] = executeSearchAction(action, workDir);
          } else if (action.type === 'view' && action.paths) {
            for (const p of action.paths) {
              console.error(`  → Viewing: ${p}`);
              try {
                viewResults[p] = executeViewAction(
                  { ...action, path: p, paths: undefined },
                  workDir,
                );
              } catch (e) {
                viewResults[p] = `Error: ${e instanceof Error ? e.message : 'Cannot read'}`;
              }
            }
          } else {
            console.error(`  → ${action.type === 'list' ? 'Listing' : 'Viewing'}: ${action.path}`);
            viewResults[action.path!] = executeViewAction(action, workDir);
          }
        } catch (e) {
          viewResults[action.path ?? 'unknown'] =
            `Error: ${e instanceof Error ? e.message : 'Cannot read path'}`;
        }
      }
      if (Object.keys(viewResults).length > 0) {
        feedbackParts.push(`File/search results:\n${JSON.stringify(viewResults, null, 2)}`);
      }

      // ── Clarify actions (prompt the user) ─────────────────────────────────
      if (clarifyActions.length > 0) {
        const answers: string[] = [];
        for (const action of clarifyActions) {
          const q = action.question ?? 'Please clarify';
          console.error(`  → Clarify: ${q}`);
          const answer = await new Promise<string>((resolve) => {
            rl.question(`ASKII asks: ${q} (press Enter to skip) `, (a) => resolve(a.trim()));
          });
          answers.push(`Q: ${q}\nA: ${answer || '(no answer)'}`);
        }
        feedbackParts.push(`Clarification answers:\n${answers.join('\n\n')}`);
      }

      // ── Write action (create the file directly) ───────────────────────────
      const actionResults: ActionResult[] = [];
      for (const action of writeActions) {
        let filePath: string;
        try {
          filePath = sandboxPath(workDir, action.path!);
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Path error';
          console.error(`  ✗ BLOCKED: ${msg}`);
          actionResults.push({
            action: `${action.type}:${action.path}`,
            status: 'error',
            detail: msg,
          });
          continue;
        }

        try {
          if (action.type === 'create') recordCreatedFile(workDir, action.path!);
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const content = action.content ? unescapeJsonString(action.content) : '';
          fs.writeFileSync(filePath, content);
          createdPath = filePath;
          console.error(`  ✓ Created: ${action.path}`);
          actionResults.push({ action: `create:${action.path}`, status: 'ok' });
        } catch (e) {
          const detail = e instanceof Error ? e.message : 'Unknown error';
          console.error(`  ✗ Failed: ${detail}`);
          actionResults.push({
            action: `${action.type}:${action.path}`,
            status: 'error',
            detail,
          });
        }
      }
      if (actionResults.length > 0) {
        feedbackParts.push(`Action results: ${JSON.stringify(actionResults)}`);
      }

      if (writeActions.length > 0 && createdPath) break;
      if (feedbackParts.length === 0) break;

      messages.push({
        role: 'user',
        content:
          feedbackParts.join('\n\n') +
          '\n\nContinue. Use read/clarify actions to gather more context, then finish with a single create action, or respond with [] if done.',
      });

      roundCount++;
    }

    if (roundCount >= config.maxRounds && !createdPath) {
      console.error(`\nMax rounds (${config.maxRounds}) reached.`);
    }

    if (createdPath) {
      console.error(`\nGenerated ${path.relative(workDir, createdPath)}! ${getRandomKaomoji()}`);
    } else {
      console.error('\nNo file was generated.');
    }

    if (hasBackups(workDir)) {
      const doUndo = await confirm(
        rl,
        'Undo all changes? (y = restore backups, n = keep changes and delete backups)',
        false,
      );
      if (doUndo) {
        const { restored, deleted } = restoreAllBackups(workDir);
        deleteAllBackups(workDir);
        console.error(
          `Undone — restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
        );
      } else {
        deleteAllBackups(workDir);
      }
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function handleReplInput(
  line: string,
  config: Config,
  setConfig: (c: Config) => void,
  askHistory: ChatMessage[],
  rl: readline.Interface,
  replSigintHandler: () => void,
): Promise<boolean> {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // ── Config flag overrides (bare --flags update session) ───────────────────
  if (trimmed.startsWith('--')) {
    const tokens = trimmed.split(/\s+/);
    const updated = mergeConfigOverride(config, tokens);
    setConfig(updated);
    console.error(
      `Updated — platform: ${updated.platform}, model: ${updated.model}, maxRounds: ${updated.maxRounds}`,
    );
    return false;
  }

  // ── Slash commands ────────────────────────────────────────────────────────
  if (trimmed.startsWith('/')) {
    const spaceIdx = trimmed.indexOf(' ');
    const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case '/help':
        printReplHelp();
        return false;

      case '/exit':
      case '/quit':
        return true;

      case '/clear':
        askHistory.length = 0;
        console.error('Chat history cleared. Starting a fresh conversation.');
        return false;

      case '/config': {
        const display = { ...config } as Record<string, unknown>;
        if (display.openaiApiKey) display.openaiApiKey = '***';
        if (display.anthropicApiKey) display.anthropicApiKey = '***';
        if (display.opencodegoApiKey) display.opencodegoApiKey = '***';
        if (display.askiicloudApiKey) display.askiicloudApiKey = '***';
        console.error(JSON.stringify(display, null, 2));
        return false;
      }

      case '/platform': {
        if (!rest) {
          console.error(
            'Usage: /platform <ollama|lmstudio|openai|anthropic|opencodego|askiicloud>',
          );
          return false;
        }
        const updated = mergeConfigOverride(config, ['--platform', rest]);
        setConfig(updated);
        console.error(`Platform → ${updated.platform} (${updated.model})`);
        return false;
      }

      case '/model': {
        if (!rest) {
          console.error('Usage: /model <model-name>');
          return false;
        }
        setConfig({ ...config, model: rest });
        console.error(`Model → ${rest}`);
        return false;
      }

      case '/wiki-reload': {
        const wikiPath = config.wikiPath;
        if (!wikiPath) {
          console.error('Error: set --wiki-path first or use env ASKII_WIKI_PATH');
          return false;
        }
        if (!fs.existsSync(wikiPath)) {
          console.error(`Error: wiki path not found: ${wikiPath}`);
          return false;
        }
        try {
          console.error(`Indexing wiki: ${wikiPath}`);
          const index = buildWikiIndex(wikiPath);
          saveWikiIndex(index, wikiPath);
          console.error(
            `Wiki indexed: ${index.chunkCount} chunks from ${index.fileCount} file(s). ${getRandomKaomoji()}`,
          );
        } catch (e) {
          console.error(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
        return false;
      }

      case '/explain': {
        if (!rest) {
          console.error('Usage: /explain <line of code>');
          return false;
        }
        const isHelpful = config.mode === 'helpful';
        const system = isHelpful
          ? 'You are ASKII, a helpful coding assistant. Provide clear, concise explanations.'
          : 'You are ASKII, a witty coding assistant. Provide humorous comments.';
        const prompt = isHelpful
          ? `Explain this code in one sentence: ${rest}`
          : `Make a funny comment about this code in one sentence: ${rest}`;
        console.error(`ASKII is thinking... ${getRandomThinkingKaomoji()}`);
        try {
          const response = await getResponse(config, prompt, system);
          console.log(response);
        } catch (e) {
          console.error(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
        return false;
      }

      case '/edit': {
        const editTokens = rest.split(/\s+/).filter(Boolean);
        const fileFlag = getFlagValue(editTokens, '--file', '-f');
        if (!fileFlag) {
          console.error('Usage: /edit --file <path> "<instruction>"');
          return false;
        }
        const fileIdx = editTokens.findIndex((t) => t === '--file' || t === '-f');
        const instructionTokens = editTokens.filter((_, i) => i !== fileIdx && i !== fileIdx + 1);
        const instruction = instructionTokens.join(' ').trim();
        if (!instruction) {
          console.error('Usage: /edit --file <path> "<instruction>"');
          return false;
        }
        if (!fs.existsSync(fileFlag)) {
          console.error(`Error: file not found: ${fileFlag}`);
          return false;
        }
        const code = fs.readFileSync(fileFlag, 'utf-8');
        const ext = path.extname(fileFlag).slice(1);
        const prompt = `Update this code:\n\`\`\`${ext}\n${code}\n\`\`\`\n\nRequest: ${instruction}\n\nReturn only the updated code without explanation.`;
        console.error(`ASKII is editing... (•_•)>⌐■-■`);
        try {
          const response = await getResponse(config, prompt);
          const edited = extractCode(response);
          fs.writeFileSync(fileFlag, edited);
          console.error(`  ✓ Wrote: ${fileFlag}`);
        } catch (e) {
          console.error(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
        return false;
      }

      case '/do': {
        const doTokens = rest.split(/\s+/).filter(Boolean);
        const localFlags = doTokens.filter((t) => t.startsWith('-'));
        const taskWords = doTokens.filter((t) => !t.startsWith('-'));
        const task = taskWords.join(' ');
        if (!task) {
          console.error('Usage: /do <task> [--max-rounds N] [--yes]');
          return false;
        }
        const doConfig = mergeConfigOverride(config, localFlags);

        const abortController = new AbortController();
        process.removeAllListeners('SIGINT');
        process.once('SIGINT', () => {
          abortController.abort();
          console.error('\n\nCancelled (Ctrl+C). Returning to prompt...');
        });

        await runReplDo(task, doConfig, rl, abortController);

        process.removeAllListeners('SIGINT');
        process.on('SIGINT', replSigintHandler);
        return false;
      }

      case '/generate': {
        // /generate <type> <base-name> [--file <path>] [--instruction <text>]
        const genTokens = rest.split(/\s+/).filter(Boolean);
        const genType = normalizeGenerateType(genTokens[0] ?? '');
        if (!genType) {
          console.error(
            'Usage: /generate <test|doc|json> <base-name> [--file <path>] [--instruction <text>]',
          );
          return false;
        }
        const genFlags = genTokens.filter((t) => t.startsWith('-'));
        const genWords = genTokens.filter((t) => !t.startsWith('-'));
        const genBaseName = genWords[1];
        if (!genBaseName) {
          console.error(
            'Usage: /generate <test|doc|json> <base-name> [--file <path>] [--instruction <text>]',
          );
          return false;
        }
        const genConfig = mergeConfigOverride(config, genFlags);
        const genContextFile = getFlagValue(genTokens, '--file', '-f');
        const genInstruction = getFlagValue(genTokens, '--instruction', '-i');
        const genWorkDir = path.resolve(process.cwd());

        const abortController = new AbortController();
        process.removeAllListeners('SIGINT');
        process.once('SIGINT', () => {
          abortController.abort();
          console.error('\n\nCancelled (Ctrl+C). Returning to prompt...');
        });

        await runGenerate(
          genType,
          genBaseName,
          genConfig,
          genWorkDir,
          rl,
          abortController,
          genContextFile,
          genInstruction,
        );

        process.removeAllListeners('SIGINT');
        process.on('SIGINT', replSigintHandler);
        return false;
      }

      case '/commit': {
        // Generate a commit message from staged/working-tree diff and print to stdout.
        const { execSync } = await import('child_process');
        const workDir = process.cwd();
        const MAX_DIFF_CHARS = 12_000;
        const COMMIT_SYSTEM_PROMPT = `You are an expert at writing Git commit messages.\nGiven a list of changed files and a unified diff, write a single, well-formed Git commit message.\nRules:\n- Use the Conventional Commits format when appropriate (type(scope): subject).\n- The first line is the subject: imperative mood, <= 72 characters, no trailing period.\n- Optionally follow with a blank line and a concise body explaining the \"why\" (not the \"what\").\n- Output ONLY the raw commit message text — no markdown fences, no quotes, no \"Commit message:\" label, no preamble.\n- If the diff is empty or trivial, output a single short subject line describing the change.`;
        const cleanCommitMessage = (raw: string): string => {
          let text = raw.trim();
          const fenceMatch = text.match(/^```[a-zA-Z]*\\n([\\s\\S]*?)\\n```$/);
          if (fenceMatch) text = fenceMatch[1].trim();
          text = text.replace(/^(commit\\s*message|message)\\s*[:\\-]\\s*/i, '');
          if (
            (text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith("'") && text.endsWith("'"))
          ) {
            text = text.slice(1, -1).trim();
          }
          return text.trim();
        };
        const git = (args: string[]): string => {
          try {
            return execSync('git ' + args.join(' '), { cwd: workDir, encoding: 'utf-8' });
          } catch {
            return '';
          }
        };
        try {
          if (git(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
            console.error('Error: not inside a git repository');
            return false;
          }
          let raw = git(['diff', '--cached']);
          let hasStaged = raw.trim().length > 0;
          if (!hasStaged) raw = git(['diff']);
          const nameStatus = hasStaged
            ? git(['diff', '--cached', '--name-only'])
            : git(['status', '--porcelain', '--untracked-files=no']);
          const changedFiles = nameStatus
            .split('\\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => l.replace(/^\\S+\\s+/, '').replace(/^\"|\"$/g, ''))
            .map((f) => path.basename(f));
          if (!raw.trim() && changedFiles.length === 0) {
            console.error('ASKII: No changes to commit. (´･_･`)');
            return false;
          }
          const diff =
            raw.length > MAX_DIFF_CHARS
              ? `${raw.slice(0, MAX_DIFF_CHARS)}\\n…[diff truncated]`
              : raw;
          const scope = hasStaged ? 'staged' : 'working-tree';
          const fileSummary =
            changedFiles.length > 0 ? changedFiles.join('\\n') : '(no file list available)';
          const userPrompt =
            `Changed files (${scope}):\\n${fileSummary}\\n\\n` +
            `Unified diff (${scope}):\\n${diff || '(empty)'}\\n\\n` +
            `Write the commit message now.`;
          console.error(`ASKII is generating a commit message... ${getRandomThinkingKaomoji()}`);
          const response = await getResponse(config, userPrompt, COMMIT_SYSTEM_PROMPT);
          const cleaned = cleanCommitMessage(response);
          if (!cleaned) {
            console.error('ASKII: The model returned no commit message. Try again.');
            return false;
          }
          console.log(cleaned);
        } catch (e) {
          console.error(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
        return false;
      }

      case '/note': {
        // /note <subcommand> [args...] — same as the top-level `note` command
        const noteTokens = rest.split(/\s+/).filter(Boolean);
        const noteSub = noteTokens[0] ?? 'list';
        const noteArgs = noteTokens.slice(1);
        await runNoteCommand(noteSub, noteArgs, [], config);
        return false;
      }

      case '/ask': {
        if (!rest) {
          console.error('Usage: /ask <question>');
          return false;
        }
        await runReplAsk(rest, config, askHistory);
        return false;
      }

      default:
        console.error(`Unknown command: ${cmd}. Type /help for available commands.`);
        return false;
    }
  }

  // ── Default: persistent chat ──────────────────────────────────────────────
  await runReplAsk(trimmed, config, askHistory);
  return false;
}

async function startRepl(initialConfig: Config): Promise<void> {
  let config = { ...initialConfig };
  const setConfig = (c: Config) => {
    config = c;
  };
  const askHistory: ChatMessage[] = [];

  printWelcomeBanner(config);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: replCompleter as readline.Completer,
    terminal: true,
  });

  let exiting = false;

  const replSigintHandler = () => {
    console.error('\n\nBye! ( •_•)>⌐■-■ (⌐■_■)');
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', replSigintHandler);

  rl.setPrompt('> ');
  rl.prompt();

  rl.on('line', async (rawLine: string) => {
    if (exiting) return;
    rl.pause();

    const shouldExit = await handleReplInput(
      rawLine,
      config,
      setConfig,
      askHistory,
      rl,
      replSigintHandler,
    );

    if (shouldExit) {
      exiting = true;
      console.error('\nBye! ( •_•)>⌐■-■ (⌐■_■)');
      rl.close();
      process.exit(0);
    } else {
      rl.resume();
      rl.prompt();
    }
  });

  rl.on('close', () => {
    if (!exiting) {
      console.error('\nBye! ( •_•)>⌐■-■ (⌐■_■)');
    }
    process.exit(0);
  });
}

function printHelp() {
  console.log(`ASKII CLI ( •_•)>⌐■-■ (⌐■_■)
AI code assistant for your terminal

Usage: askii <command> [options]
       askii              (no args) — start interactive mode

Commands:
  (no args)             Start interactive REPL mode
  ask <question>        Ask a question about code
  edit <instruction>    Edit code and print the result to stdout
  explain <line>        Explain a single line of code
  do <task>             Agentic task runner — creates, modifies, and deletes files
  generate <type> <base>  Agentic file generator (type: test|doc|json) — searches workspace & asks clarifications
  commit                 Generate a commit message from staged/working-tree diff and print to stdout
  note <subcommand>      Notes / tasks / reminders (add, list, search, done, delete, due)
  control <instruction> Screen control — takes screenshots and drives mouse/keyboard
  browse <task>         Browser agent — launches Puppeteer and navigates the web
  wiki-reload           Index .md files from --wiki-path into the local vector database

Options:
  -p, --platform <p>         LLM platform: ollama, lmstudio, openai, anthropic, opencodego, askiicloud (default: ollama)
      --ollama-url <url>     Ollama server URL (default: http://localhost:11434)
      --lmstudio-url <url>   LM Studio server URL (default: ws://localhost:1234)
      --ollama-model <m>     Ollama model (default: gemma4:e4b)
      --lmstudio-model <m>   LM Studio model (default: qwen/qwen3-coder-30b)
      --openai-key <key>     OpenAI API key (env: ASKII_OPENAI_KEY)
      --openai-model <m>     OpenAI model (default: gpt-5-mini)
      --openai-url <url>     OpenAI-compatible base URL (env: ASKII_OPENAI_URL)
      --anthropic-key <key>  Anthropic API key (env: ASKII_ANTHROPIC_KEY)
      --anthropic-model <m>  Anthropic model (default: claude-sonnet-4-6)
      --opencodego-key <key> opencode Go API key (env: ASKII_OPENCODEGO_KEY)
      --opencodego-model <m> opencode Go model (default: glm-5.2)
      --opencodego-url <url> opencode Go base URL (env: ASKII_OPENCODEGO_URL)
      --askiicloud-key <key> ASKII Cloud API key (env: ASKII_CLOUD_KEY)
      --askiicloud-model <m> ASKII Cloud model (default: askii-default)
      --mode <mode>          Response mode: helpful, funny (default: funny)
      --max-rounds <n>       Max agent rounds for "do" / "generate" / "control" / "browse" (default: 5)
      --dir <path>           Working directory for "do" / "generate" (default: cwd)
  -c, --code <code>          Code input (alternative to stdin)
      --lang <language>      Language of the code (e.g. typescript, python)
      --file <filename>      Filename of the code (e.g. src/utils.ts) — also used as context file for "generate"
      --headless             Run Puppeteer in headless mode for "browse" (default: visible)
      --chrome-path <path>   Path to Chrome/Chromium executable for "browse" (env: ASKII_CHROME_PATH)
      --wiki-path <path>     Path to folder with .md docs for wiki RAG (env: ASKII_WIKI_PATH)
      --use-wiki             Inject wiki context into ask/edit/do (env: ASKII_USE_WIKI=1)
  -y, --yes                  Auto-confirm all actions
  -h, --help                 Show help

Environment variables:
  ASKII_PLATFORM
  ASKII_OLLAMA_URL      ASKII_LMSTUDIO_URL
  ASKII_OLLAMA_MODEL    ASKII_LMSTUDIO_MODEL
  ASKII_OPENAI_KEY      ASKII_OPENAI_MODEL    ASKII_OPENAI_URL
  ASKII_ANTHROPIC_KEY   ASKII_ANTHROPIC_MODEL
  ASKII_OPENCODEGO_KEY  ASKII_OPENCODEGO_MODEL  ASKII_OPENCODEGO_URL
  ASKII_CLOUD_KEY       ASKII_CLOUD_MODEL
  ASKII_MODE            ASKII_MAX_ROUNDS
  ASKII_WIKI_PATH       ASKII_USE_WIKI

Examples:
  cat myfile.ts | askii ask "what does this do?"
  cat myfile.ts | askii ask --lang typescript --file src/utils.ts "what does this do?"
  cat myfile.ts | askii edit "add error handling"
  askii explain "const x = arr.reduce((a, b) => a + b, 0)"
  askii do "create a Jest test file for src/utils.ts"
  askii do --yes "scaffold a README for this project"
  askii generate test utils --file src/utils.ts --instruction "use Jest"
  askii generate doc api --dir ./my-project
  askii commit                       # print a generated commit message to stdout
  askii commit --dir ./my-project    # generate for a different repo
  askii note add "fix the login bug, high priority"
  askii note add "remind me to check the build in 30 minutes"
  askii note list                     # list all entries (most-recent first)
  askii note search "login"           # full-text search
  askii note done <id>                # toggle a task's done state
  askii note delete <id>              # delete an entry
  askii note due                      # list reminders that are due now
  askii -p lmstudio --lmstudio-model "my-model" do "refactor index.ts"
  askii control --ollama-model llava "open Notepad and type hello world"
  askii control --yes --ollama-model llava "click the search bar and search for cats"
  askii browse --ollama-model llava "go to https://example.com and click Learn more"
  askii browse --yes --headless --ollama-model llava "search Google for Node.js"
  askii wiki-reload --wiki-path ./docs
  askii ask --wiki-path ./docs --use-wiki "how do I configure the database?"
`);
}

// ── ASKII Note (CLI) ──────────────────────────────────────────────────────────
// Notes / tasks / reminders persisted to ~/.askii/notes.json, tagged by
// workspace. Mirrors src/notes.ts + src/notesPanel.ts in the extension, minus
// the webview UI and the in-process reminder scheduler (the CLI prints due
// reminders on demand via `askii note due`).

const NOTES_FILE = path.join(os.homedir(), '.askii', 'notes.json');

function noteGenId(): string {
  return randomBytes(8).toString('hex') + Date.now().toString(36);
}

function loadCliNotes(): NoteEntry[] {
  try {
    if (!fs.existsSync(NOTES_FILE)) return [];
    const raw = fs.readFileSync(NOTES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as NoteEntry[]) : [];
  } catch {
    return [];
  }
}

function saveCliNotes(notes: NoteEntry[]): void {
  const dir = path.dirname(NOTES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

function currentWorkspaceTagCli(): string | undefined {
  try {
    const cwd = process.cwd();
    return path.basename(cwd) || undefined;
  } catch {
    return undefined;
  }
}

function captureContextCli(): NoteContext {
  return {
    workspaceFolder: currentWorkspaceTagCli(),
  };
}

// ── Classification (mirrors src/notes.ts classifyNoteInput) ──────────────────

interface CliClassification {
  kind: NoteKind;
  priority: TaskPriority | null;
  dueAt: string | null;
  tags: string[];
  needsClarification: boolean;
  clarifyingQuestion: string | null;
  summary: string;
}

const NOTE_CLASSIFY_SYSTEM = `You are ASKII Note, an assistant that classifies free-text notes from the user into one of three kinds and extracts structured metadata.

Current date/time (ISO8601): {NOW}
Workspace: {WORKSPACE}

Kinds:
- "note"  : a plain piece of information to remember (no deadline, no priority).
- "task"  : an actionable item that should be done. Extract a priority: "low" | "medium" | "high".
- "reminder" : something the user wants to be pinged about at a specific time. Extract "dueAt" as an ISO8601 timestamp in UTC. Resolve relative phrases ("in 2 hours", "tomorrow 9am", "next monday") against the current date/time above.

Rules:
- If the user's text is ambiguous about WHEN a reminder should fire (e.g. "later", "soon", "remind me"), set "needsClarification": true and provide a short "clarifyingQuestion" asking for a concrete time. Otherwise set "needsClarification": false and "clarifyingQuestion": null.
- Extract up to 5 short lowercase tags (single words or hyphenated phrases) that describe the topic.
- "summary" is a short (<= 80 chars) human-readable title for the entry.
- Respond with ONLY a single JSON object, no markdown, no extra text.

Output schema:
{"kind":"note"|"task"|"reminder","priority":"low"|"medium"|"high"|null,"dueAt":<ISO8601 or null>,"tags":[],"needsClarification":false,"clarifyingQuestion":null,"summary":""}`;

function buildNoteClassifyPrompt(text: string, context: NoteContext): string {
  const ctxLines: string[] = [];
  if (context.workspaceFolder) ctxLines.push(`- Workspace: ${context.workspaceFolder}`);
  const ctxSection = ctxLines.length
    ? `\n\nContext the user currently has open:\n${ctxLines.join('\n')}`
    : '';
  return `Classify this user note:${ctxSection}\n\nUser note:\n"""\n${text}\n"""`;
}

function safeParseJsonRaw(raw: string): Record<string, unknown> | null {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function coerceKind(v: unknown): NoteKind {
  return v === 'task' || v === 'reminder' ? (v as NoteKind) : 'note';
}

function coercePriority(v: unknown): TaskPriority | null {
  return v === 'low' || v === 'medium' || v === 'high' ? (v as TaskPriority) : null;
}

function coerceTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.toLowerCase().trim())
    .filter((x) => x.length > 0)
    .slice(0, 5);
}

async function classifyNoteCli(
  text: string,
  context: NoteContext,
  config: Config,
): Promise<CliClassification> {
  const now = new Date();
  const system = NOTE_CLASSIFY_SYSTEM.replace('{NOW}', now.toISOString()).replace(
    '{WORKSPACE}',
    context.workspaceFolder ?? '(no workspace)',
  );

  try {
    const raw = await getResponse(config, buildNoteClassifyPrompt(text, context), system);
    const obj = safeParseJsonRaw(raw);
    if (obj) {
      const kind = coerceKind(obj['kind']);
      const priority = coercePriority(obj['priority']);
      const tags = coerceTags(obj['tags']);
      const needsClarification = obj['needsClarification'] === true;
      const clarifyingQuestion =
        typeof obj['clarifyingQuestion'] === 'string' ? obj['clarifyingQuestion'] : null;
      const summary =
        typeof obj['summary'] === 'string' && obj['summary'].trim()
          ? obj['summary'].trim().slice(0, 120)
          : text.slice(0, 80);
      let dueAt: string | null = null;
      if (typeof obj['dueAt'] === 'string' && obj['dueAt']) {
        const d = new Date(obj['dueAt']);
        if (!isNaN(d.getTime())) dueAt = d.toISOString();
      }
      if (kind === 'reminder' && !dueAt && !needsClarification) {
        dueAt = parseReminderTimeLocal(text, now);
        if (!dueAt) {
          return {
            kind,
            priority,
            dueAt: null,
            tags,
            needsClarification: true,
            clarifyingQuestion:
              'When should I remind you? (e.g. "in 2 hours", "tomorrow 9am", "2026-07-08 14:30")',
            summary,
          };
        }
      }
      return { kind, priority, dueAt, tags, needsClarification, clarifyingQuestion, summary };
    }
  } catch {
    // fall through to heuristic
  }

  // Heuristic fallback (mirrors src/notes.ts)
  const lower = text.toLowerCase();
  let kind: NoteKind = 'note';
  let priority: TaskPriority | null = null;
  let dueAt: string | null = null;
  let needsClarification = false;
  let clarifyingQuestion: string | null = null;

  if (/remind|reminder|ping|notify|alert/.test(lower)) {
    kind = 'reminder';
    dueAt = parseReminderTimeLocal(text, now);
    if (!dueAt) {
      needsClarification = true;
      clarifyingQuestion = 'When should I remind you? (e.g. "in 2 hours", "tomorrow 9am")';
    }
  } else if (/task|todo|to-do|fix|implement|do:|need to|should|must/.test(lower)) {
    kind = 'task';
    if (/high|critical|urgent|asap/.test(lower)) priority = 'high';
    else if (/low|minor|whenever|someday/.test(lower)) priority = 'low';
    else priority = 'medium';
  }

  return {
    kind,
    priority,
    dueAt,
    tags: [],
    needsClarification,
    clarifyingQuestion,
    summary: text.slice(0, 80),
  };
}

function buildCliEntry(text: string, cls: CliClassification, context: NoteContext): NoteEntry {
  return {
    id: noteGenId(),
    kind: cls.kind,
    text,
    summary: cls.summary,
    tags: cls.tags,
    createdAt: new Date().toISOString(),
    workspaceTag: context.workspaceFolder,
    priority: cls.kind === 'task' ? (cls.priority ?? 'medium') : undefined,
    done: cls.kind === 'task' ? false : undefined,
    dueAt: cls.kind === 'reminder' ? (cls.dueAt ?? undefined) : undefined,
    fired: cls.kind === 'reminder' ? false : undefined,
    context,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const KIND_ICON: Record<NoteKind, string> = { note: '📝', task: '✅', reminder: '⏰' };
const PRIORITY_ICON: Record<TaskPriority, string> = { low: '🟢', medium: '🟡', high: '🔴' };

function formatDue(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const delta = d.getTime() - now.getTime();
  const past = delta < 0;
  const absMin = Math.round(Math.abs(delta) / 60_000);
  let rel: string;
  if (absMin < 1) rel = 'now';
  else if (absMin < 60) rel = `${absMin}m`;
  else if (absMin < 60 * 24) rel = `${Math.round(absMin / 60)}h`;
  else rel = `${Math.round(absMin / (60 * 24))}d`;
  const local = d.toLocaleString();
  return past ? `${local} (overdue ${rel})` : `${local} (in ${rel})`;
}

function printNoteEntry(n: NoteEntry, idx?: number): void {
  const prefix = idx !== undefined ? `${idx}. ` : '';
  const icon = KIND_ICON[n.kind];
  const parts: string[] = [`${prefix}${icon} [${n.id}]`];
  if (n.kind === 'task') {
    const pIcon = n.priority ? PRIORITY_ICON[n.priority] : '';
    const done = n.done ? ' ✓ done' : '';
    parts.push(`${pIcon}${done}`);
  }
  if (n.kind === 'reminder' && n.dueAt) {
    parts.push(`due: ${formatDue(n.dueAt)}`);
    if (n.fired) parts.push('fired');
    if (n.missed) parts.push('missed');
  }
  console.log(parts.join('  '));
  console.log(`    ${n.summary ?? n.text}`);
  if (n.text && n.text !== n.summary) {
    const snip = n.text.length > 200 ? n.text.slice(0, 200) + '…' : n.text;
    console.log(`    "${snip}"`);
  }
  const meta: string[] = [];
  if (n.workspaceTag) meta.push(`ws:${n.workspaceTag}`);
  if (n.tags?.length) meta.push(`#${n.tags.join(' #')}`);
  meta.push(`created ${new Date(n.createdAt).toLocaleString()}`);
  console.log(`    ${meta.join(' · ')}`);
}

// ── Subcommands ───────────────────────────────────────────────────────────────

async function noteAdd(
  text: string,
  flags: string[],
  config: Config,
  rl?: readline.Interface,
): Promise<void> {
  const attachScreenshot = hasFlag(flags, '--shot', '--screenshot');
  const ctx = captureContextCli();

  let screenshotPath: string | undefined;
  if (attachScreenshot) {
    try {
      const dir = path.join(path.dirname(NOTES_FILE), 'notes-screenshots');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const { base64 } = await takeScreenshot();
      const id = noteGenId();
      screenshotPath = path.join(dir, `${id}.png`);
      fs.writeFileSync(screenshotPath, Buffer.from(base64, 'base64'));
      console.error(`  ✓ Screenshot saved: ${screenshotPath}`);
    } catch (e) {
      console.error(
        `  Warning: screenshot failed (${e instanceof Error ? e.message : 'Unknown error'})`,
      );
    }
  }

  let cls = await classifyNoteCli(text, ctx, config);

  // Clarifying-question loop (max 2 rounds), only in interactive REPL
  let rounds = 0;
  while (cls.needsClarification && cls.clarifyingQuestion && rl && rounds < 2) {
    console.error(`\n  ${cls.clarifyingQuestion}`);
    const answer = await new Promise<string | null>((resolve) => {
      rl.question('  > ', (a) => resolve(a.trim() || null));
    });
    if (answer === null) {
      // user cancelled — save as a plain note
      cls = {
        kind: 'note',
        priority: null,
        dueAt: null,
        tags: cls.tags,
        needsClarification: false,
        clarifyingQuestion: null,
        summary: text.slice(0, 80),
      };
      break;
    }
    const combined = `${text}\n\n[clarified: ${answer}]`;
    cls = await classifyNoteCli(combined, ctx, config);
    rounds++;
  }

  if (cls.needsClarification && cls.clarifyingQuestion && !rl) {
    // Non-interactive: print the question and save as a plain note
    console.error(`  Note: ${cls.clarifyingQuestion} (saving as a plain note)`);
    cls = {
      kind: 'note',
      priority: null,
      dueAt: null,
      tags: cls.tags,
      needsClarification: false,
      clarifyingQuestion: null,
      summary: text.slice(0, 80),
    };
  }

  const entry = buildCliEntry(text, cls, ctx);
  if (screenshotPath) entry.screenshotPath = screenshotPath;

  const notes = loadCliNotes();
  notes.push(entry);
  saveCliNotes(notes);

  console.error(`  ✓ Saved ${entry.kind}! ${getRandomKaomoji()}`);
  printNoteEntry(entry);
}

function noteList(query: string): void {
  const notes = loadCliNotes();
  if (notes.length === 0) {
    console.log('No notes yet. Add one with: askii note add "<text>"');
    return;
  }
  const results = searchNotes(query, notes);
  if (query) console.log(`Search results for "${query}" (${results.length}):`);
  else console.log(`Notes (${results.length}, most-recent first):`);
  console.log('');
  results.forEach((r, i) => printNoteEntry(r.entry, i + 1));
}

function noteToggleDone(id: string): void {
  const notes = loadCliNotes();
  const i = notes.findIndex((n) => n.id === id);
  if (i === -1) {
    console.error(`Error: no entry with id "${id}"`);
    process.exit(1);
  }
  if (notes[i].kind !== 'task') {
    console.error(`Error: entry ${id} is a ${notes[i].kind}, not a task`);
    process.exit(1);
  }
  notes[i].done = !notes[i].done;
  saveCliNotes(notes);
  console.log(`  ✓ Task ${id} marked ${notes[i].done ? 'done' : 'not done'}`);
}

function noteDelete(id: string): void {
  const notes = loadCliNotes();
  const i = notes.findIndex((n) => n.id === id);
  if (i === -1) {
    console.error(`Error: no entry with id "${id}"`);
    process.exit(1);
  }
  const removed = notes.splice(i, 1)[0];
  saveCliNotes(notes);
  console.log(`  ✓ Deleted ${removed.kind} ${id}`);
}

function noteDue(): void {
  const notes = loadCliNotes();
  const now = Date.now();
  const due = notes.filter(
    (n) => n.kind === 'reminder' && n.dueAt && !n.fired && new Date(n.dueAt).getTime() <= now,
  );
  if (due.length === 0) {
    console.log('No reminders are due. (´･_･`)');
    return;
  }
  console.log(`⏰ ${due.length} reminder(s) due:\n`);
  due.forEach((n, i) => {
    printNoteEntry(n, i + 1);
    // Mark as fired + missed (CLI has no background scheduler)
    n.fired = true;
    n.missed = true;
  });
  saveCliNotes(notes);
  console.error('\n  (Reminders marked as fired. Use `askii note add` to create new ones.)');
}

async function runNoteCommand(
  sub: string,
  args: string[],
  flags: string[],
  config: Config,
  rl?: readline.Interface,
): Promise<void> {
  switch (sub) {
    case 'add': {
      const text = args.join(' ').trim();
      if (!text) {
        console.error('Usage: askii note add "<text>"');
        console.error('Examples:');
        console.error('  askii note add "the API rate limit is 100 req/min"');
        console.error('  askii note add "task: fix the login bug, high priority"');
        console.error('  askii note add "remind me to check the build in 30 minutes"');
        console.error('  askii note add --shot "remember this screen state"');
        process.exit(1);
      }
      console.error(`ASKII Note is classifying... ${getRandomThinkingKaomoji()}`);
      await noteAdd(text, flags, config, rl);
      break;
    }
    case 'list':
    case 'ls': {
      noteList(args.join(' '));
      break;
    }
    case 'search':
    case 'find': {
      const query = args.join(' ');
      if (!query) {
        console.error('Usage: askii note search "<query>"');
        process.exit(1);
      }
      noteList(query);
      break;
    }
    case 'done':
    case 'check': {
      const id = args[0];
      if (!id) {
        console.error('Usage: askii note done <id>');
        process.exit(1);
      }
      noteToggleDone(id);
      break;
    }
    case 'delete':
    case 'rm':
    case 'remove': {
      const id = args[0];
      if (!id) {
        console.error('Usage: askii note delete <id>');
        process.exit(1);
      }
      noteDelete(id);
      break;
    }
    case 'due':
    case 'reminders': {
      noteDue();
      break;
    }
    case 'help':
    case '--help':
    case '-h': {
      console.log(`ASKII Note — notes / tasks / reminders

Usage: askii note <subcommand> [args]

Subcommands:
  add "<text>"            Add a note / task / reminder (AI auto-classifies)
  add --shot "<text>"      Attach a full-screen screenshot to the entry
  list [query]             List all entries, or filter by full-text query
  search "<query>"         Full-text search across all entries
  done <id>                Toggle a task's done state
  delete <id>              Delete an entry
  due                      List reminders that are due now (marks them fired)

Notes are stored globally at ${NOTES_FILE}, tagged by workspace.

Examples:
  askii note add "fix the login bug, high priority"
  askii note add "remind me to check the build in 30 minutes"
  askii note list
  askii note search "login"
  askii note done abc12345...
  askii note due
`);
      break;
    }
    default: {
      console.error(`Unknown note subcommand: ${sub}`);
      console.error('Run `askii note help` for usage.');
      process.exit(1);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = argv;
  const positional = argv.filter((a) => !a.startsWith('-'));
  const command = positional[0] ?? '';

  if (hasFlag(flags, '-h', '--help') || command === 'help') {
    printHelp();
    process.exit(0);
  }

  const config = getConfig(flags);

  // No command given → interactive REPL mode
  if (!command) {
    await startRepl(config);
    return;
  }

  if (command === 'wiki-reload') {
    const wikiPath =
      config.wikiPath || getFlagValue(flags, '--wiki-path') || process.env.ASKII_WIKI_PATH;
    if (!wikiPath) {
      console.error('Error: provide --wiki-path <path> or set ASKII_WIKI_PATH');
      process.exit(1);
    }
    if (!fs.existsSync(wikiPath)) {
      console.error(`Error: wiki path not found: ${wikiPath}`);
      process.exit(1);
    }
    try {
      console.error(`Indexing wiki files in: ${wikiPath}`);
      const index = buildWikiIndex(wikiPath);
      saveWikiIndex(index, wikiPath);
      console.error(
        `Wiki indexed: ${index.chunkCount} chunks from ${index.fileCount} file(s). ${getRandomKaomoji()}`,
      );
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  } else if (command === 'ask') {
    const stdin = await readStdin();
    const code = getFlagValue(flags, '-c', '--code') || stdin;
    const question = positional.slice(1).join(' ');
    const lang = getFlagValue(flags, '--lang');
    const file = getFlagValue(flags, '--file');

    if (!question) {
      console.error('Error: provide a question as an argument');
      process.exit(1);
    }

    const wikiCtxAsk = getCliWikiContext(config, question);
    const wikiSectionAsk = wikiCtxAsk ? `Relevant documentation:\n${wikiCtxAsk}\n\n` : '';

    let prompt: string;
    if (code) {
      const metaLines = [file ? `File: ${file}` : null, lang ? `Language: ${lang}` : null]
        .filter(Boolean)
        .join('\n');
      const codeBlock = `\`\`\`${lang ?? ''}\n${code}\n\`\`\``;
      prompt = `${wikiSectionAsk}${metaLines ? metaLines + '\n' : ''}Code:\n${codeBlock}\n\nQuestion: ${question}`;
    } else {
      prompt = `${wikiSectionAsk}Question: ${question}`;
    }

    console.error(`ASKII is thinking... ${getRandomThinkingKaomoji()}`);

    try {
      const response = await getResponse(config, prompt);
      console.log(`\nASKII Says: ${getRandomKaomoji()}\n`);
      console.log(response);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  } else if (command === 'commit') {
    // Generate a commit message from the staged (or working-tree) git diff
    // and print it to stdout. Mirrors src/commitMessage.ts in the extension.
    const { execSync } = await import('child_process');
    const workDir = getFlagValue(flags, '--dir') || process.cwd();

    const MAX_DIFF_CHARS = 12_000;
    const COMMIT_SYSTEM_PROMPT = `You are an expert at writing Git commit messages.
Given a list of changed files and a unified diff, write a single, well-formed Git commit message.
Rules:
- Use the Conventional Commits format when appropriate (type(scope): subject).
- The first line is the subject: imperative mood, <= 72 characters, no trailing period.
- Optionally follow with a blank line and a concise body explaining the "why" (not the "what").
- Output ONLY the raw commit message text — no markdown fences, no quotes, no "Commit message:" label, no preamble.
- If the diff is empty or trivial, output a single short subject line describing the change.`;

    function cleanCommitMessage(raw: string): string {
      let text = raw.trim();
      const fenceMatch = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
      if (fenceMatch) text = fenceMatch[1].trim();
      text = text.replace(/^(commit\s*message|message)\s*[:\-]\s*/i, '');
      if (
        (text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'"))
      ) {
        text = text.slice(1, -1).trim();
      }
      return text.trim();
    }

    function git(args: string[]): string {
      try {
        return execSync('git ' + args.join(' '), { cwd: workDir, encoding: 'utf-8' });
      } catch {
        return '';
      }
    }

    try {
      // Confirm we are inside a git repo.
      const insideRepo = git(['rev-parse', '--is-inside-work-tree']).trim();
      if (insideRepo !== 'true') {
        console.error('Error: not inside a git repository');
        process.exit(1);
      }

      // Prefer staged diff; fall back to working-tree diff.
      let raw = git(['diff', '--cached']);
      let hasStaged = raw.trim().length > 0;
      if (!hasStaged) {
        raw = git(['diff']);
      }

      // File list (staged or working-tree).
      const nameStatus = hasStaged
        ? git(['diff', '--cached', '--name-only'])
        : git(['status', '--porcelain', '--untracked-files=no']);
      const changedFiles = nameStatus
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => l.replace(/^\S+\s+/, '').replace(/^"|"$/g, ''))
        .map((f) => path.basename(f));

      if (!raw.trim() && changedFiles.length === 0) {
        console.error('ASKII: No changes to commit. (´･_･`)');
        process.exit(0);
      }

      const diff =
        raw.length > MAX_DIFF_CHARS ? `${raw.slice(0, MAX_DIFF_CHARS)}\n…[diff truncated]` : raw;

      const scope = hasStaged ? 'staged' : 'working-tree';
      const fileSummary =
        changedFiles.length > 0 ? changedFiles.join('\n') : '(no file list available)';
      const userPrompt =
        `Changed files (${scope}):\n${fileSummary}\n\n` +
        `Unified diff (${scope}):\n${diff || '(empty)'}\n\n` +
        `Write the commit message now.`;

      console.error(`ASKII is generating a commit message... ${getRandomThinkingKaomoji()}`);
      const response = await getResponse(config, userPrompt, COMMIT_SYSTEM_PROMPT);
      const cleaned = cleanCommitMessage(response);
      if (!cleaned) {
        console.error('ASKII: The model returned no commit message. Try again.');
        process.exit(1);
      }
      // Print only the commit message to stdout (pipe-friendly).
      console.log(cleaned);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  } else if (command === 'edit') {
    const stdin = await readStdin();
    const code = getFlagValue(flags, '-c', '--code') || stdin;
    const instruction = positional.slice(1).join(' ');
    const lang = getFlagValue(flags, '--lang');
    const file = getFlagValue(flags, '--file');

    if (!code) {
      console.error('Error: provide code via stdin or -c/--code');
      process.exit(1);
    }
    if (!instruction) {
      console.error('Error: provide an instruction as an argument');
      process.exit(1);
    }

    const metaLines = [file ? `File: ${file}` : null, lang ? `Language: ${lang}` : null]
      .filter(Boolean)
      .join('\n');
    const wikiCtxEdit = getCliWikiContext(config, instruction);
    const wikiSectionEdit = wikiCtxEdit ? `Relevant documentation:\n${wikiCtxEdit}\n\n` : '';
    const prompt = `${wikiSectionEdit}${metaLines ? metaLines + '\n' : ''}Update this code:\n\`\`\`${lang ?? ''}\n${code}\n\`\`\`\n\nRequest: ${instruction}\n\nReturn only the updated code without explanation.`;

    console.error(`ASKII is editing... (•_•)>⌐■-■`);

    try {
      const response = await getResponse(config, prompt);
      console.log(extractCode(response));
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  } else if (command === 'explain') {
    const stdin = await readStdin();
    const line = positional.slice(1).join(' ') || stdin;

    if (!line) {
      console.error('Error: provide a line of code as an argument or via stdin');
      process.exit(1);
    }

    const isHelpful = config.mode === 'helpful';
    const system = isHelpful
      ? 'You are ASKII, a helpful coding assistant. Provide clear, concise explanations.'
      : 'You are ASKII, a witty coding assistant. Provide humorous comments.';
    const prompt = isHelpful
      ? `Explain this code in one sentence: ${line}`
      : `Make a funny comment about this code in one sentence: ${line}`;

    console.error(`ASKII is thinking... ${getRandomThinkingKaomoji()}`);

    try {
      const response = await getResponse(config, prompt, system);
      console.log(response);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  } else if (command === 'do') {
    const task = positional.slice(1).join(' ');

    if (!task) {
      console.error('Error: provide a task as an argument');
      process.exit(1);
    }

    const workDir = path.resolve(getFlagValue(flags, '--dir') || process.cwd());

    deleteAllBackups(workDir);

    console.error(`ASKII is working... ${getRandomThinkingKaomoji()}`);
    console.error('Press Ctrl+C to stop at any time.\n');

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const abortController = new AbortController();

    process.once('SIGINT', () => {
      abortController.abort();
      console.error('\n\nStopped by user (Ctrl+C).');
      rl.close();
      process.exit(0);
    });

    try {
      const workspaceStructure = getWorkspaceStructure(workDir);
      console.error(`\nWorkspace: ${workDir}\n\`\`\`\n${workspaceStructure}\`\`\`\n`);

      const wikiAvailableDo = !!(config.wikiPath && loadWikiIndex(config.wikiPath));
      const systemPrompt = buildDoSystemPrompt(workspaceStructure, wikiAvailableDo);
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task },
      ];

      let completedActions = 0;
      let roundCount = 0;

      while (roundCount < config.maxRounds && !abortController.signal.aborted) {
        console.error(`\n[Round ${roundCount + 1}/${config.maxRounds}]`);

        process.stderr.write('AI: ');
        const responseText = await retryLLMCall(
          () => getChatResponseStreaming(config, messages, (chunk) => process.stderr.write(chunk)),
          2,
          (attempt, err) =>
            console.error(`\nLLM call failed (attempt ${attempt}): ${err.message}. Retrying...`),
        );
        process.stderr.write('\n');

        if (abortController.signal.aborted) break;
        messages.push({ role: 'assistant', content: responseText });

        const actions = parseWorkspaceActions(responseText);
        if (actions.length === 0) {
          console.error('No actions returned. Done.');
          if (responseText.trim()) {
            console.error(`Raw (first 500): ${responseText.substring(0, 500)}`);
          }
          break;
        }

        const readActions = actions.filter(
          (a) =>
            a.type === 'view' ||
            a.type === 'list' ||
            a.type === 'search' ||
            a.type === 'wiki_search',
        );
        const writeActions = actions.filter(
          (a) =>
            a.type !== 'view' &&
            a.type !== 'list' &&
            a.type !== 'search' &&
            a.type !== 'wiki_search',
        );

        const feedbackParts: string[] = [];

        // ── Read actions ──────────────────────────────────────────────────────
        const viewResults: Record<string, string> = {};
        for (const action of readActions) {
          try {
            if (action.type === 'wiki_search') {
              const q = action.query ?? '';
              console.error(`  → Wiki search: "${q}"`);
              const wikiData = config.wikiPath ? loadWikiIndex(config.wikiPath) : null;
              viewResults[`wiki_search:${q}`] = wikiData
                ? searchWiki(q, wikiData) || 'No wiki results found'
                : 'Wiki not available — run: askii wiki-reload --wiki-path <path>';
            } else if (action.type === 'search') {
              console.error(`  → Search: "${action.pattern}"`);
              viewResults[`search:${action.pattern}`] = executeSearchAction(action, workDir);
            } else if (action.type === 'view' && action.paths) {
              for (const p of action.paths) {
                console.error(`  → Viewing: ${p}`);
                try {
                  viewResults[p] = executeViewAction(
                    { ...action, path: p, paths: undefined },
                    workDir,
                  );
                } catch (e) {
                  viewResults[p] = `Error: ${e instanceof Error ? e.message : 'Cannot read'}`;
                }
              }
            } else {
              console.error(
                `  → ${action.type === 'list' ? 'Listing' : 'Viewing'}: ${action.path}`,
              );
              viewResults[action.path!] = executeViewAction(action, workDir);
            }
          } catch (e) {
            viewResults[action.path ?? 'unknown'] =
              `Error: ${e instanceof Error ? e.message : 'Cannot read path'}`;
          }
        }

        if (Object.keys(viewResults).length > 0) {
          feedbackParts.push(`File/search results:\n${JSON.stringify(viewResults, null, 2)}`);
        }

        // ── Write actions ─────────────────────────────────────────────────────
        const actionResults: ActionResult[] = [];

        for (const action of writeActions) {
          // Sandbox validation
          let filePath: string;
          try {
            filePath = sandboxPath(workDir, action.path!);
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Path error';
            console.error(`  ✗ BLOCKED: ${msg}`);
            actionResults.push({
              action: `${action.type}:${action.path}`,
              status: 'error',
              detail: msg,
            });
            continue;
          }

          if (action.type === 'run') {
            // run ALWAYS requires explicit confirmation — ignores -y/--yes
            console.error(`  → Run: ${action.command}`);
            const ok = await confirm(
              rl,
              `Run command: "${action.command}"? (executes shell code)`,
              false,
            );
            if (!ok) {
              actionResults.push({ action: `run:${action.command}`, status: 'skipped' });
              continue;
            }
            try {
              const { execSync } = await import('child_process');
              const output = execSync(action.command!, {
                cwd: workDir,
                encoding: 'utf-8',
                timeout: 30000,
              });
              console.error(`  ✓ Run output:\n${output}`);
              actionResults.push({
                action: `run:${action.command}`,
                status: 'ok',
                detail: output.substring(0, 500),
              });
            } catch (e: unknown) {
              const err = e as { stdout?: string; stderr?: string; message?: string };
              const detail =
                `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message || 'Unknown error';
              console.error(`  ✗ Run failed:\n${detail}`);
              actionResults.push({
                action: `run:${action.command}`,
                status: 'error',
                detail: detail.substring(0, 500),
              });
            }
            continue;
          }

          const promptMsg = buildCliConfirmMessage(action);
          const ok = await confirm(rl, promptMsg, config.yes);
          if (!ok) {
            actionResults.push({ action: `${action.type}:${action.path}`, status: 'skipped' });
            continue;
          }

          try {
            const result = executeCliWriteAction(action, filePath, workDir);
            if (result === 'ok') completedActions++;
            actionResults.push({
              action: `${action.type}:${action.path}`,
              status: result === 'ok' ? 'ok' : 'error',
              detail: result === 'ok' ? undefined : result,
            });
          } catch (e) {
            const detail = e instanceof Error ? e.message : 'Unknown error';
            console.error(`  ✗ Failed: ${detail}`);
            actionResults.push({
              action: `${action.type}:${action.path}`,
              status: 'error',
              detail,
            });
          }
        }

        if (actionResults.length > 0) {
          feedbackParts.push(`Action results: ${JSON.stringify(actionResults)}`);
        }

        if (feedbackParts.length === 0) break;

        messages.push({
          role: 'user',
          content:
            feedbackParts.join('\n\n') +
            '\n\nWhat would you like to do next? Respond with only a JSON array of actions or [] if done.',
        });

        roundCount++;
      }

      if (roundCount >= config.maxRounds) {
        console.error(`\nMax rounds (${config.maxRounds}) reached.`);
      }
      console.error(`\nCompleted ${completedActions} actions! ${getRandomKaomoji()}`);

      if (hasBackups(workDir)) {
        const doUndo = await confirm(
          rl,
          'Undo all changes? (y = restore backups, n = keep changes and delete backups)',
          false,
        );
        if (doUndo) {
          const { restored, deleted } = restoreAllBackups(workDir);
          deleteAllBackups(workDir);
          console.error(
            `Undone — restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
          );
        } else {
          deleteAllBackups(workDir);
        }
      }
      rl.close();
    } catch (error) {
      rl.close();
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  } else if (command === 'generate') {
    // askii generate <type> <base-name> [--file <path>] [--instruction <text>] [--dir <path>]
    const typeFlag = getFlagValue(flags, '--type');
    const positionalType = positional[1];
    const rawType = typeFlag || positionalType;
    if (!rawType) {
      console.error(
        'Error: provide a file type (test, doc, json) — e.g. askii generate test myComponent',
      );
      process.exit(1);
    }
    const fileType = normalizeGenerateType(rawType);
    if (!fileType) {
      console.error(`Error: unknown type "${rawType}". Choose one of: test, doc, json`);
      process.exit(1);
    }
    const baseName = typeFlag ? positional[1] : positional[2];
    if (!baseName) {
      console.error('Error: provide a base name — e.g. askii generate test myComponent');
      process.exit(1);
    }
    const workDir = path.resolve(getFlagValue(flags, '--dir') || process.cwd());
    const contextFile = getFlagValue(flags, '--file', '-f');
    const instruction = getFlagValue(flags, '--instruction', '-i');

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const abortController = new AbortController();

    process.once('SIGINT', () => {
      abortController.abort();
      console.error('\n\nStopped by user (Ctrl+C).');
      rl.close();
      process.exit(0);
    });

    try {
      await runGenerate(
        fileType,
        baseName,
        config,
        workDir,
        rl,
        abortController,
        contextFile,
        instruction,
      );
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    } finally {
      rl.close();
    }
  } else if (command === 'control') {
    const instruction = positional.slice(1).join(' ');

    if (!instruction) {
      console.error('Error: provide an instruction as an argument');
      process.exit(1);
    }

    const missingDeps = checkControlDependencies();
    if (missingDeps.length > 0) {
      console.error(
        `Error: missing required tools:\n${missingDeps.map((d) => `  - ${d}`).join('\n')}`,
      );
      process.exit(1);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const abortController = new AbortController();

    // Handle Ctrl+C gracefully
    process.once('SIGINT', () => {
      abortController.abort();
      console.error('\n\nStopped by user (Ctrl+C).');
      rl.close();
      process.exit(0);
    });

    try {
      console.error(`ASKII Control starting... ${getRandomThinkingKaomoji()}`);
      console.error(`Instruction: ${instruction}`);
      console.error('(Make sure your model supports vision/images)');
      console.error('Press Ctrl+C to stop at any time.\n');

      // Monitor selection
      let monitorId: string | number | undefined;
      try {
        const monitors = await getMonitors();
        if (monitors.length > 1) {
          console.error('Available monitors:');
          monitors.forEach((m, i) => console.error(`  [${i + 1}] ${m.name}`));
          const answer = await new Promise<string>((resolve) => {
            rl.question('Select monitor (number, default=1): ', resolve);
          });
          const idx = Math.max(0, Math.min(monitors.length - 1, (parseInt(answer) || 1) - 1));
          monitorId = monitors[idx].id;
          console.error(`Using: ${monitors[idx].name}\n`);
        }
      } catch {
        // proceed with default monitor
      }

      const history: ControlHistoryEntry[] = [];
      const ZOOM_ACTIONS = new Set(['mouse_left_click', 'mouse_right_click', 'mouse_double_click']);
      let round = 0;
      let prevScreenshot: string | undefined;
      let systemInfo: SystemInfo | undefined;

      while (round < config.maxRounds && !abortController.signal.aborted) {
        console.error(`Round ${round + 1}/${config.maxRounds} — taking screenshot...`);

        const {
          base64: imageBase64,
          width: screenW,
          height: screenH,
          physWidth,
          physHeight,
        } = await takeScreenshot(monitorId);

        if (!systemInfo) {
          systemInfo = await getSystemInfo(physWidth, physHeight);
        }

        if (prevScreenshot !== undefined && prevScreenshot === imageBase64) {
          console.error('Warning: screen unchanged since last action.');
        }
        const screenChanged = prevScreenshot === undefined || prevScreenshot !== imageBase64;
        prevScreenshot = imageBase64;

        const prompt =
          round === 0
            ? `Instruction to complete: ${instruction}\n\nAnalyze the screenshot and determine the next action(s).`
            : `Continuing instruction: ${instruction}\n\nAnalyze the updated screenshot and return the next action(s) or DONE.`;

        console.error('Asking AI...');
        const rawResponse = await getResponse(
          config,
          prompt,
          buildControlSystemPrompt(screenW, screenH, systemInfo, history),
          imageBase64,
        );

        if (abortController.signal.aborted) break;

        const parsed = parseControlResponse(rawResponse);

        if (!parsed) {
          console.error('Error: could not parse AI response.');
          console.error(`Raw response: ${rawResponse}`);
          break;
        }

        if (parsed.type === 'done') {
          console.error(`\nDone! ${getRandomKaomoji()}`);
          console.error(`Reasoning: ${parsed.reasoning}`);
          break;
        }

        let { actions } = parsed;

        // Two-phase zoom: refine coordinates for a single position-based click
        if (actions.length === 1 && ZOOM_ACTIONS.has(actions[0].action)) {
          const a = actions[0] as ControlAction & { x: number; y: number };
          try {
            console.error('Refining coordinates (zoom)...');
            const imgBuf = Buffer.from(imageBase64, 'base64');
            const refined = await refineCoordinates(
              imgBuf,
              a.x,
              a.y,
              screenW,
              screenH,
              a,
              (sys, img) => getResponse(config, sys, undefined, img),
            );
            if (refined) {
              console.error(`Zoom: (${a.x}, ${a.y}) → (${refined.x}, ${refined.y})`);
              a.x = refined.x;
              a.y = refined.y;
            }
          } catch {
            // zoom failed — use original coordinates
          }
        }

        // Log planned actions
        actions.forEach((a, i) => {
          const label = actions.length > 1 ? `Action ${i + 1}/${actions.length}` : 'Action';
          console.error(`\n${label}:    ${describeAction(a as ControlAction)}`);
          console.error(`Reasoning: ${a.reasoning}`);
        });

        // Confirm
        const confirmMsg =
          actions.length === 1
            ? 'Execute this action?'
            : `Execute these ${actions.length} actions?`;
        const ok = await confirm(rl, confirmMsg, config.yes);
        if (!ok || abortController.signal.aborted) {
          console.error('Stopped.');
          break;
        }

        // Resolve click_text actions to coordinates via a second LLM call
        for (const a of actions) {
          if ((a as ControlAction).action === 'click_text') {
            const ct = a as { action: 'click_text'; text: string; reasoning: string };
            try {
              const resolvePrompt = `Find the EXACT pixel coordinates of the UI element whose visible text is "${ct.text}". Return ONLY valid JSON: {"x": number, "y": number}`;
              const raw = await getResponse(config, resolvePrompt, undefined, imageBase64);
              const m = raw.match(/\{[\s\S]*?\}/);
              if (m) {
                const coords = JSON.parse(m[0]);
                if (typeof coords.x === 'number' && typeof coords.y === 'number') {
                  Object.assign(a, { action: 'mouse_left_click', x: coords.x, y: coords.y });
                  console.error(`Resolved "${ct.text}" → (${coords.x}, ${coords.y})`);
                }
              }
            } catch {
              console.error(`Warning: could not resolve text "${ct.text}" to coordinates`);
            }
          }
        }

        // Execute sequence
        for (const a of actions) {
          if (abortController.signal.aborted) break;
          await executeControlAction(a as ControlAction, screenW, screenH, abortController.signal);
          history.push({
            round: round + 1,
            description: describeAction(a as ControlAction),
            reasoning: a.reasoning,
            screenChanged,
          });
        }
        console.error('Executed.\n');

        round++;
      }

      if (round >= config.maxRounds && !abortController.signal.aborted) {
        console.error(`Max rounds (${config.maxRounds}) reached.`);
      }

      rl.close();
    } catch (error) {
      rl.close();
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  } else if (command === 'note') {
    // ASKII Note — notes / tasks / reminders, persisted to ~/.askii/notes.json
    const subcommand = positional[1] ?? 'list';
    const noteArgs = positional.slice(2);
    await runNoteCommand(subcommand, noteArgs, flags, config);
  } else if (command === 'browse') {
    const task = positional.slice(1).join(' ');

    if (!task) {
      console.error('Error: provide a task as an argument');
      process.exit(1);
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const abortController = new AbortController();

    process.once('SIGINT', () => {
      abortController.abort();
      console.error('\n\nStopped by user (Ctrl+C).');
      rl.close();
      process.exit(0);
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
    let browser: import('puppeteer-core').Browser | undefined;

    try {
      console.error(`ASKII Browse starting... ${getRandomThinkingKaomoji()}`);
      console.error(`Task: ${task}`);
      console.error('(Make sure your model supports vision/images)');
      console.error('Press Ctrl+C to stop at any time.\n');

      browser = await puppeteer.launch({
        headless: config.headless ? true : false,
        executablePath: config.chromePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
      });

      const [page] = await browser.pages();
      await page.setViewport(null);

      let round = 0;

      while (round < config.maxRounds && !abortController.signal.aborted) {
        console.error(`Round ${round + 1}/${config.maxRounds} — capturing screenshot...`);

        const imageBase64 = await takePageScreenshot(page);
        const currentUrl = page.url();

        console.error(`Current URL: ${currentUrl}`);

        const userPrompt =
          round === 0
            ? `Task: ${task}\n\nCurrent URL: ${currentUrl}\n\nAnalyze the screenshot and determine the next action.`
            : `Continuing task: ${task}\n\nCurrent URL: ${currentUrl}\n\nAnalyze the screenshot and return the next action or DONE.`;

        console.error('Asking AI...');
        const rawResponse = await getResponse(
          config,
          userPrompt,
          buildBrowserSystemPrompt(),
          imageBase64,
        );

        if (abortController.signal.aborted) break;

        const action = parseBrowserAction(rawResponse);

        if (!action) {
          console.error('Error: could not parse AI response.');
          console.error(`Raw response: ${rawResponse}`);
          break;
        }

        if (action.action === 'DONE') {
          console.error(`\nDone! ${getRandomKaomoji()}`);
          console.error(`Reasoning: ${action.reasoning}`);
          break;
        }

        console.error(`\nAction:    ${describeBrowserAction(action)}`);
        console.error(`Reasoning: ${action.reasoning}`);

        const ok = await confirm(rl, 'Execute this action?', config.yes);
        if (!ok || abortController.signal.aborted) {
          console.error('Stopped.');
          break;
        }

        try {
          await executeBrowserAction(action, page);
          console.error('Executed.\n');
        } catch (execErr) {
          console.error(
            `Action failed: ${execErr instanceof Error ? execErr.message : 'Unknown error'}`,
          );
        }

        round++;
      }

      if (round >= config.maxRounds && !abortController.signal.aborted) {
        console.error(`Max rounds (${config.maxRounds}) reached.`);
      }

      rl.close();
    } catch (error) {
      rl.close();
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
}

main();
