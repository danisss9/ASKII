import {
  getWorkspaceStructure,
  buildDoSystemPrompt,
  deleteAllBackups,
  restoreAllBackups,
  hasBackups,
} from '@common/workspace';
import { runDoAgent } from '@common/doAgent';
import {
  runBrowserAgent,
  runScreenAgent,
  type ControlEvent,
  type VisionAsk,
} from '@common/controlAgent';
import { buildNoteEntry, classifyNote, genNoteId } from '@common/noteClassify';
import {
  MAX_RECENT_COMMITS,
  buildCommitMessageSystemPrompt,
  buildCommitUserPrompt,
  cleanCommitMessage,
  formatCommitExamples,
  type CommitMessageStyle,
} from '@common/commitMessage';
import { extractCode } from '@common/utils';
import { buildWikiIndex, hasWikiIndex, searchWiki } from '@common/wiki';
import {
  rebuildCodeWikiIndex,
  searchCodeWiki,
  hasCodeWikiIndex,
} from '@common/codewiki';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import { FILE_CITATION_INSTRUCTIONS } from '@common/links';
import {
  OPENCODE_GO_URL,
  ASKII_CLOUD_URL,
  DEFAULT_LMSTUDIO_URL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  complete,
  completePrompt,
  getAskiiVersion,
  isPlatformId,
  type ChatMessage,
  type ChatReply,
  type PlatformId,
  type ProviderConnection,
} from '@common/providers';
import { checkControlDependencies, getMonitors, takeScreenshot } from '@common/control';
import { browserLaunchArgs, detectBrowserExecutable } from '@common/browser';
import {
  type NoteEntry,
  type NoteKind,
  type TaskPriority,
  type NoteContext,
  searchNotes,
  computeNextOccurrence,
  describeRecurrence,
  describeEventTrigger,
} from '@common/notes';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface Config {
  platform: PlatformId;
  url: string;
  ollamaUrl: string;
  lmStudioUrl: string;
  model: string;
  openaiApiKey: string;
  openaiBaseURL: string | undefined;
  anthropicApiKey: string;
  opencodegoApiKey: string;
  opencodegoBaseURL: string;
  askiicloudApiKey: string;
  askiicloudBaseURL: string;
  mode: 'helpful' | 'funny';
  maxRounds: number;
  timeoutMs: number;
  yes: boolean;
  headless: boolean;
  controlTarget: 'screen' | 'browser';
  chromePath: string | undefined;
  wikiPath: string | undefined;
  useWiki: boolean;
  useCodeWiki: boolean;
  commitStyle: CommitMessageStyle;
}

/** Exit code for a run stopped with Ctrl+C (128 + SIGINT), as shells expect. */
const EXIT_INTERRUPTED = 130;
/** Exit code for invalid command-line usage. */
const EXIT_USAGE = 2;

/** A usage error (bad flag value, unknown platform...) — printed, then exit code 2. */
class UsageError extends Error {}

function getFlagValue(flags: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = flags.indexOf(name);
    // A value may start with '-' only if it is a number ("--max-rounds -1" is still rejected later)
    if (i !== -1 && flags[i + 1] !== undefined && (!flags[i + 1].startsWith('-') || /^-\d/.test(flags[i + 1]))) {
      return flags[i + 1];
    }
  }
  return undefined;
}

function hasFlag(flags: string[], ...names: string[]): boolean {
  return names.some((n) => flags.includes(n));
}

// Every flag that takes a value (everything passed to getFlagValue) — their
// values must not be mistaken for the command or the task/question text.
const VALUE_FLAGS = new Set([
  '-p',
  '--platform',
  '--ollama-url',
  '--ollama-model',
  '--lmstudio-url',
  '--lmstudio-model',
  '--openai-key',
  '--openai-model',
  '--openai-url',
  '--anthropic-key',
  '--anthropic-model',
  '--opencodego-key',
  '--opencodego-model',
  '--opencodego-url',
  '--askiicloud-key',
  '--askiicloud-model',
  '--askiicloud-url',
  '--model',
  '--mode',
  '--max-rounds',
  '--timeout',
  '--target',
  '--chrome-path',
  '--dir',
  '--wiki-path',
  '--commit-style',
  '-c',
  '--code',
  '--lang',
  '--file',
  '-f',
]);

const BOOLEAN_FLAGS = new Set([
  '-h',
  '--help',
  '-v',
  '--version',
  '-y',
  '--yes',
  '--headless',
  '--use-wiki',
  '--use-code-wiki',
  '--shot',
  '--screenshot',
]);

/** Non-flag tokens, skipping each value flag's value (same rule as getFlagValue). */
function getPositionals(tokens: string[]): string[] {
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('-') && !/^-\d/.test(token)) {
      if (VALUE_FLAGS.has(token) && tokens[i + 1] !== undefined && (!tokens[i + 1].startsWith('-') || /^-\d/.test(tokens[i + 1]))) i++;
      continue;
    }
    positionals.push(token);
  }
  return positionals;
}

/** Flags that are neither known value flags nor known switches. */
function getUnknownFlags(tokens: string[]): string[] {
  return tokens.filter(
    (t) => t.startsWith('-') && !/^-\d/.test(t) && !VALUE_FLAGS.has(t) && !BOOLEAN_FLAGS.has(t),
  );
}

function parsePositiveInt(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value.trim()) || parseInt(value, 10) < 1) {
    throw new UsageError(`${name} must be a positive whole number (got: '${value}')`);
  }
  return parseInt(value, 10);
}

function getConfig(flags: string[]): Config {
  const platformValue = getFlagValue(flags, '-p', '--platform') || process.env.ASKII_PLATFORM || 'ollama';
  if (!isPlatformId(platformValue)) {
    throw new UsageError(
      `Unknown platform '${platformValue}' — use ollama, lmstudio, openai, anthropic, opencodego or askiicloud`,
    );
  }
  const platform = platformValue;

  const ollamaUrl =
    getFlagValue(flags, '--ollama-url') || process.env.ASKII_OLLAMA_URL || DEFAULT_OLLAMA_URL;

  const lmStudioUrl =
    getFlagValue(flags, '--lmstudio-url') || process.env.ASKII_LMSTUDIO_URL || DEFAULT_LMSTUDIO_URL;

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

  const askiicloudBaseURL =
    getFlagValue(flags, '--askiicloud-url') || process.env.ASKII_CLOUD_URL || ASKII_CLOUD_URL;

  const modelMap: Record<string, string> = {
    lmstudio: lmStudioModel,
    openai: openaiModel,
    anthropic: anthropicModel,
    opencodego: opencodegoModel,
    askiicloud: askiicloudModel,
  };

  const mode = getFlagValue(flags, '--mode') || process.env.ASKII_MODE || 'funny';
  if (mode !== 'helpful' && mode !== 'funny') {
    throw new UsageError(`--mode must be 'helpful' or 'funny' (got: '${mode}')`);
  }

  const commitStyle = getFlagValue(flags, '--commit-style') || process.env.ASKII_COMMIT_STYLE || 'oneliner';
  if (commitStyle !== 'oneliner' && commitStyle !== 'brief' && commitStyle !== 'descriptive') {
    throw new UsageError(
      `--commit-style must be 'oneliner', 'brief' or 'descriptive' (got: '${commitStyle}')`,
    );
  }

  const timeoutSeconds = parsePositiveInt(
    getFlagValue(flags, '--timeout') || process.env.ASKII_TIMEOUT,
    '--timeout',
    DEFAULT_REQUEST_TIMEOUT_MS / 1000,
  );

  return {
    platform,
    url: platform === 'lmstudio' ? lmStudioUrl : ollamaUrl,
    ollamaUrl,
    lmStudioUrl,
    model: modelMap[platform] ?? ollamaModel,
    openaiApiKey,
    openaiBaseURL,
    anthropicApiKey,
    opencodegoApiKey,
    opencodegoBaseURL,
    askiicloudApiKey,
    askiicloudBaseURL,
    mode,
    maxRounds: parsePositiveInt(
      getFlagValue(flags, '--max-rounds') || process.env.ASKII_MAX_ROUNDS,
      '--max-rounds',
      5,
    ),
    timeoutMs: timeoutSeconds * 1000,
    yes: hasFlag(flags, '-y', '--yes'),
    headless: hasFlag(flags, '--headless'),
    controlTarget: (getFlagValue(flags, '--target') ||
      process.env.ASKII_CONTROL_TARGET ||
      'screen') as Config['controlTarget'],
    chromePath: getFlagValue(flags, '--chrome-path') || process.env.ASKII_CHROME_PATH || undefined,
    wikiPath: getFlagValue(flags, '--wiki-path') || process.env.ASKII_WIKI_PATH || undefined,
    useWiki: hasFlag(flags, '--use-wiki') || process.env.ASKII_USE_WIKI === '1',
    useCodeWiki: hasFlag(flags, '--use-code-wiki') || process.env.ASKII_USE_CODE_WIKI === '1',
    commitStyle,
  };
}

async function getCliWikiContext(config: Config, query: string): Promise<string> {
  if (!config.useWiki || !config.wikiPath) return '';
  if (!hasWikiIndex(config.wikiPath)) {
    console.error('  [wiki] No index found — run: askii wiki-reload --wiki-path <path>');
    return '';
  }
  try {
    const ctx = await searchWiki(config.wikiPath, query);
    if (ctx) console.error(`  [wiki] Injecting ${ctx.length} chars of context`);
    return ctx;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Search failed';
    console.error(`  [wiki] ${message}`);
    return '';
  }
}

async function getCliCodeWikiContext(config: Config, query: string): Promise<string> {
  if (!config.useCodeWiki) return '';
  try {
    const ctx = await searchCodeWiki(process.cwd(), query);
    if (ctx) console.error(`  [code wiki] Injecting ${ctx.length} chars of context`);
    return ctx;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Search failed';
    console.error(`  [code wiki] ${message} — run: askii wiki-reload`);
    return '';
  }
}

/**
 * Rebuilds the code wiki index for dir with CLI progress output.
 * Shared by the wiki-reload command and the /wiki-reload REPL command.
 */
async function reloadCliCodeWiki(dir: string): Promise<void> {
  console.error(`Indexing code wiki: ${dir}`);
  const stats = await rebuildCodeWikiIndex(dir, {
    onProgress: (stage, current, total) => {
      if (stage === 'indexing') {
        process.stderr.write(`\r  code wiki: file ${current}/${total}`);
      }
    },
  });
  process.stderr.write('\n');
  console.error(
    `Code wiki indexed: ${stats.chunkCount} chunks from ${stats.fileCount} file(s) ` +
      `(${stats.embeddedFiles} embedded, ${stats.cachedFiles} reused). ${getRandomKaomoji()}`,
  );
}

function getConnection(config: Config): ProviderConnection {
  const { platform, model } = config;
  switch (platform) {
    case 'ollama':
      return { platform, model, baseURL: config.ollamaUrl };
    case 'lmstudio':
      return { platform, model, baseURL: config.lmStudioUrl };
    case 'openai':
      return { platform, model, apiKey: config.openaiApiKey, baseURL: config.openaiBaseURL };
    case 'anthropic':
      return { platform, model, apiKey: config.anthropicApiKey };
    case 'opencodego':
      return { platform, model, apiKey: config.opencodegoApiKey, baseURL: config.opencodegoBaseURL };
    case 'askiicloud':
      return { platform, model, apiKey: config.askiicloudApiKey, baseURL: config.askiicloudBaseURL };
  }
}

function logRetry(attempt: number, error: Error, delayMs: number): void {
  console.error(`\nLLM call failed (${error.message}) — retry ${attempt} in ${delayMs / 1000}s...`);
}

async function getResponse(
  config: Config,
  prompt: string,
  system?: string,
  imageBase64?: string,
  signal?: AbortSignal,
): Promise<string> {
  const reply = await completePrompt(getConnection(config), prompt, {
    system,
    image: imageBase64,
    signal,
    timeoutMs: config.timeoutMs,
    onRetry: logRetry,
  });
  return reply.text;
}

async function getChatResponseStreaming(
  config: Config,
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<ChatReply> {
  return complete(getConnection(config), {
    messages,
    onChunk,
    signal,
    timeoutMs: config.timeoutMs,
    onRetry: logRetry,
  });
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
    // Input already ended (piped stdin ran out) or closes while asking: that's a "no"
    const onClose = () => {
      console.error(`${question} (no input — answered no)`);
      resolve(false);
    };
    try {
      rl.once('close', onClose);
      rl.question(`${question} (y/N) `, (answer) => {
        rl.off('close', onClose);
        resolve(answer.trim().toLowerCase() === 'y');
      });
    } catch {
      rl.off('close', onClose);
      onClose();
    }
  });
}

function replCompleter(line: string): [string[], string] {
  const COMMANDS = [
    '/help',
    '/ask ',
    '/do ',
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
  /commit                        Generate a commit message from staged/working-tree diff
  /note <subcommand>             Notes / tasks / reminders (add, list, search, done, delete, due)
  /edit --file <path> <instr>    Edit a file in place
  /explain <text>                Explain a line of code
  /wiki-reload                   Rebuild the enabled wiki indexes (docs and/or code)
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
  const codeWikiStatus = config.useCodeWiki ? 'on (local embeddinggemma2)' : 'off';
  console.error(`
ASKII ( •_•)>⌐■-■ (⌐■_■)  — interactive mode

  Platform : ${config.platform} (${config.model})
  Workspace: ${process.cwd()}
  Wiki     : ${wikiStatus}
  Code wiki: ${codeWikiStatus}

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
    if (!isPlatformId(platform)) {
      throw new UsageError(
        `Unknown platform '${platform}' — use ollama, lmstudio, openai, anthropic, opencodego or askiicloud`,
      );
    }
    result.platform = platform;
    // Ollama and LM Studio listen on different servers (http vs ws)
    result.url = platform === 'lmstudio' ? result.lmStudioUrl : result.ollamaUrl;
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

  result.maxRounds = parsePositiveInt(
    getFlagValue(tokens, '--max-rounds'),
    '--max-rounds',
    result.maxRounds,
  );

  const mode = getFlagValue(tokens, '--mode');
  if (mode) result.mode = mode as Config['mode'];

  if (hasFlag(tokens, '--use-code-wiki')) result.useCodeWiki = true;

  if (hasFlag(tokens, '-y', '--yes')) result.yes = true;

  return result;
}

async function runReplAsk(question: string, config: Config, history: ChatMessage[]): Promise<void> {
  if (history.length === 0) {
    const system =
      config.mode === 'helpful'
        ? 'You are ASKII, a helpful coding assistant. Provide clear, concise answers.\n\n' +
          FILE_CITATION_INSTRUCTIONS
        : 'You are ASKII, a witty coding assistant who sprinkles in humor and kaomoji.\n\n' +
          FILE_CITATION_INSTRUCTIONS;
    history.push({ role: 'system', content: system });
  }

  const wikiCtx = await getCliWikiContext(config, question);
  const wikiSection = wikiCtx ? `Relevant documentation:\n${wikiCtx}\n\n` : '';

  const codeWikiCtx = await getCliCodeWikiContext(config, question);
  const codeWikiSection = codeWikiCtx
    ? `Relevant code from the codebase:\n${codeWikiCtx}\n\n`
    : '';

  history.push({ role: 'user', content: `${wikiSection}${codeWikiSection}${question}` });

  process.stderr.write(`\nASKII: `);
  let response = '';
  try {
    const reply = await getChatResponseStreaming(config, history, (chunk) =>
      process.stdout.write(chunk),
    );
    response = reply.text;
  } catch (err) {
    console.error(`\nError: ${err instanceof Error ? err.message : 'Unknown error'}`);
    history.pop();
    return;
  }
  process.stdout.write('\n');
  history.push({ role: 'assistant', content: response });
}

/**
 * Runs the Do agent in workDir with terminal output and y/N confirmations,
 * then offers to undo every change. Shared by `askii do` and the REPL /do.
 * Returns the number of completed write actions.
 */
async function runCliDo(
  task: string,
  config: Config,
  rl: readline.Interface,
  workDir: string,
  signal: AbortSignal,
): Promise<number> {
  deleteAllBackups(workDir);
  console.error(`ASKII is working... ${getRandomThinkingKaomoji()}`);
  console.error('Press Ctrl+C to stop at any time.\n');

  const workspaceStructure = getWorkspaceStructure(workDir);
  console.error(`Workspace: ${workDir}\n\`\`\`\n${workspaceStructure}\`\`\`\n`);

  const wikiPath = config.wikiPath;
  const wikiAvailable = !!(wikiPath && hasWikiIndex(wikiPath));
  const codeWikiAvailable = config.useCodeWiki && hasCodeWikiIndex(workDir);
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: buildDoSystemPrompt(workspaceStructure, wikiAvailable, codeWikiAvailable),
    },
    { role: 'user', content: task },
  ];

  let completedActions = 0;
  try {
    const result = await runDoAgent({
      workspaceRoot: workDir,
      messages,
      maxRounds: config.maxRounds,
      signal,
      autoConfirm: config.yes,
      chat: (msgs, onChunk, chatSignal) =>
        getChatResponseStreaming(config, msgs, onChunk, chatSignal),
      confirm: ({ kind, message, action }) => {
        if (kind === 'run') {
          // run ALWAYS requires explicit confirmation — ignores -y/--yes
          return confirm(rl, `Run command: "${action.command}"? (executes shell code)`, false);
        }
        if (kind === 'sensitive') {
          return confirm(
            rl,
            `${message} (this file can make your editor or git run code — confirmation required even with --yes)`,
            false,
          );
        }
        return confirm(rl, message, config.yes);
      },
      emit: (event) => {
        switch (event.type) {
          case 'round-start':
            console.error(`\n[Round ${event.round}/${event.maxRounds}]`);
            process.stderr.write('AI: ');
            break;
          case 'chunk':
            process.stderr.write(event.text);
            break;
          case 'round-end':
            process.stderr.write(event.truncated ? '\n[response cut off at the token limit]\n' : '\n');
            break;
          case 'invalid-response':
            console.error(
              event.truncated
                ? '  ✗ Response was cut off at the output token limit — asking for smaller steps.'
                : '  ✗ Response was not a valid JSON action array — asking again.',
            );
            break;
          case 'complete':
            console.error('No actions returned. Done.');
            break;
          case 'notice':
            console.error(`  ! ${event.message}`);
            break;
          case 'action-start':
            if (READ_ACTION_TYPES.has(event.action.type) || event.action.type === 'run') {
              console.error(`  → ${event.label}`);
            }
            break;
          case 'action-end':
            if (event.status === 'blocked') {
              console.error(`  ✗ BLOCKED: ${event.detail}`);
            } else if (event.status === 'error') {
              console.error(`  ✗ Failed: ${event.detail ?? event.label}`);
            } else if (event.status === 'ok' && event.action.type === 'run') {
              console.error(`  ✓ Run output:\n${event.detail ?? ''}`);
            } else if (event.status === 'ok' && !READ_ACTION_TYPES.has(event.action.type)) {
              console.error(`  ✓ ${event.label}`);
            }
            break;
          case 'max-rounds':
            console.error(`\nMax rounds (${event.maxRounds}) reached.`);
            break;
        }
      },
      searchWiki: wikiAvailable && wikiPath ? (q) => searchWiki(wikiPath, q) : undefined,
      searchCode: codeWikiAvailable ? (q) => searchCodeWiki(workDir, q) : undefined,
      wikiUnavailableMessage: 'Wiki not available — run: askii wiki-reload --wiki-path <path>',
      codeWikiUnavailableMessage:
        'Code wiki not available — run: askii wiki-reload (with --use-code-wiki)',
    });
    completedActions = result.completedActions;
  } catch (error) {
    if (!signal.aborted) {
      console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  console.error(
    signal.aborted
      ? `\nStopped after ${completedActions} action(s).`
      : `\nCompleted ${completedActions} actions! ${getRandomKaomoji()}`,
  );

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
  return completedActions;
}

const READ_ACTION_TYPES = new Set(['view', 'list', 'search', 'wiki_search', 'code_search']);

async function handleReplInput(
  line: string,
  config: Config,
  setConfig: (c: Config) => void,
  askHistory: ChatMessage[],
  rl: readline.Interface,
  setInterrupt: (handler: (() => void) | null) => void,
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
        let reloaded = false;

        if (config.wikiPath) {
          if (!fs.existsSync(config.wikiPath)) {
            console.error(`Error: wiki path not found: ${config.wikiPath}`);
          } else {
            try {
              console.error(`Indexing wiki: ${config.wikiPath}`);
              const stats = await buildWikiIndex(config.wikiPath, {
                onProgress: (stage, current, total) => {
                  if (stage === 'indexing') {
                    process.stderr.write(`\r  wiki: file ${current}/${total}`);
                  }
                },
              });
              process.stderr.write('\n');
              console.error(
                `Wiki indexed: ${stats.chunkCount} chunks from ${stats.fileCount} file(s). ${getRandomKaomoji()}`,
              );
            } catch (e) {
              process.stderr.write('\n');
              console.error(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
          }
          reloaded = true;
        }

        if (config.useCodeWiki) {
          try {
            await reloadCliCodeWiki(path.resolve(process.cwd()));
          } catch (e) {
            console.error(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
          }
          reloaded = true;
        }

        if (!reloaded) {
          console.error(
            'Nothing to reload — set --wiki-path (docs wiki) and/or --use-code-wiki (code wiki) first.',
          );
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
        const task = getPositionals(doTokens).join(' ');
        if (!task) {
          console.error('Usage: /do <task> [--max-rounds N] [--yes]');
          return false;
        }
        const doConfig = mergeConfigOverride(config, doTokens);

        const abortController = new AbortController();
        setInterrupt(() => {
          if (abortController.signal.aborted) return;
          abortController.abort();
          console.error('\n\nCancelled (Ctrl+C). Returning to prompt...');
        });
        // Keep reading keypresses during the run so Ctrl+C is seen (the line
        // handler paused rl, which would leave it buffered until the next prompt).
        // Throws if input already ended (piped stdin) — nothing to read then.
        try {
          rl.resume();
        } catch {
          // readline closed
        }

        await runCliDo(task, doConfig, rl, path.resolve(process.cwd()), abortController.signal);
        return false;
      }

      case '/commit': {
        // Generate a commit message from staged/working-tree diff and print to stdout.
        try {
          const message = await generateCliCommitMessage(process.cwd(), config);
          if (message === null) {
            console.error('ASKII: No changes to commit. (´･_･`)');
          } else if (!message) {
            console.error('ASKII: The model returned no commit message. Try again.');
          } else {
            console.log(message);
          }
        } catch (e) {
          console.error(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
        return false;
      }

      case '/note': {
        // /note <subcommand> [args...] — same as the top-level `note` command
        const noteTokens = rest.split(/\s+/).filter(Boolean);
        const notePositionals = getPositionals(noteTokens);
        const noteSub = notePositionals[0] ?? 'list';
        const noteArgs = notePositionals.slice(1);
        try {
          // rl enables the clarifying-question loop; flags carry e.g. --shot
          await runNoteCommand(noteSub, noteArgs, noteTokens, config, rl);
        } catch (e) {
          // CommandFailed already printed its message
          if (!(e instanceof CommandFailed)) {
            console.error(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
          }
        }
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
  let busy = false;

  const bye = () => {
    console.error('\nBye! ( •_•)>⌐■-■ (⌐■_■)');
    process.exit(0);
  };

  const replSigintHandler = () => {
    exiting = true;
    console.error('\n\nBye! ( •_•)>⌐■-■ (⌐■_■)');
    rl.close();
    process.exit(0);
  };
  // A running command (e.g. /do) can claim Ctrl+C to cancel itself instead of
  // quitting. On a TTY readline holds stdin in raw mode, so Ctrl+C arrives as
  // rl's 'SIGINT' event, not as a process signal — listen for both.
  let interruptHandler: (() => void) | null = null;
  const setInterrupt = (handler: (() => void) | null) => {
    interruptHandler = handler;
  };
  const onInterrupt = () => (interruptHandler ?? replSigintHandler)();
  rl.on('SIGINT', onInterrupt);
  process.on('SIGINT', onInterrupt);

  rl.setPrompt('> ');
  rl.prompt();

  // Commands run one at a time: lines typed (or piped) while one is running
  // wait their turn instead of running concurrently. rl.question answers
  // (confirm prompts) bypass this queue.
  const queue: string[] = [];
  let inputClosed = false;

  const drain = async () => {
    busy = true;
    rl.pause();
    while (queue.length > 0) {
      const rawLine = queue.shift()!;
      let shouldExit = false;
      try {
        shouldExit = await handleReplInput(rawLine, config, setConfig, askHistory, rl, setInterrupt);
      } catch (e) {
        console.error(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
      } finally {
        setInterrupt(null);
      }
      if (shouldExit) {
        exiting = true;
        rl.close();
        bye();
      }
    }
    busy = false;
    // Piped input ended while commands were still running
    if (inputClosed) bye();
    rl.resume();
    rl.prompt();
  };

  rl.on('line', (rawLine: string) => {
    if (exiting) return;
    queue.push(rawLine);
    if (!busy) void drain();
  });

  rl.on('close', () => {
    inputClosed = true;
    // Let a running command finish first — drain() exits when it's done
    if (!exiting && !busy) bye();
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
  commit                 Generate a commit message from staged/working-tree diff and print to stdout
  note <subcommand>      Notes / tasks / reminders (add, list, search, done, delete, due)
  control <task>         Screen & browser agent — --target screen (default) or --target browser
  browse <task>          Alias for control --target browser
  wiki-reload           Reload the enabled wikis — docs (--wiki-path) and/or code (--use-code-wiki)

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
      --askiicloud-url <url> ASKII Cloud base URL (env: ASKII_CLOUD_URL, default: https://api.askii.dev/v1)
      --timeout <seconds>    Per-request timeout (env: ASKII_TIMEOUT, default: 600)
      --commit-style <s>     "commit" style: oneliner, brief, descriptive (env: ASKII_COMMIT_STYLE, default: oneliner)
      --mode <mode>          Response mode: helpful, funny (default: funny)
      --max-rounds <n>       Max agent rounds for "do" / "control" (default: 5)
      --dir <path>           Working directory for "do" (default: cwd)
  -c, --code <code>          Code input (alternative to stdin)
      --lang <language>      Language of the code (e.g. typescript, python)
      --file <filename>      Filename of the code (e.g. src/utils.ts)
      --target <t>           Control target for "control": screen or browser (env: ASKII_CONTROL_TARGET, default: screen)
      --headless             Run Puppeteer in headless mode for "control --target browser" (default: visible)
      --chrome-path <path>   Path to Chrome/Chromium executable for "control --target browser" (env: ASKII_CHROME_PATH)
      --wiki-path <path>     Path to folder with .md docs for wiki RAG (env: ASKII_WIKI_PATH)
      --use-wiki             Inject wiki context into ask/edit/do (env: ASKII_USE_WIKI=1)
      --use-code-wiki        Inject code wiki context into ask/edit/do (env: ASKII_USE_CODE_WIKI=1)
  -y, --yes                  Auto-confirm file edits in "do" (shell commands and files that can run
                             code — .vscode/, .husky/, git hooks — are always confirmed)
  -v, --version              Print the version
  -h, --help                 Show help

API keys: prefer the environment variables below over --*-key flags — flag values are
visible to other users in the process list and stay in your shell history.

Exit codes: 0 success, 1 error, 2 invalid usage, 130 stopped with Ctrl+C

Environment variables:
  ASKII_PLATFORM
  ASKII_OLLAMA_URL      ASKII_LMSTUDIO_URL
  ASKII_OLLAMA_MODEL    ASKII_LMSTUDIO_MODEL
  ASKII_OPENAI_KEY      ASKII_OPENAI_MODEL    ASKII_OPENAI_URL
  ASKII_ANTHROPIC_KEY   ASKII_ANTHROPIC_MODEL
  ASKII_OPENCODEGO_KEY  ASKII_OPENCODEGO_MODEL  ASKII_OPENCODEGO_URL
  ASKII_CLOUD_KEY       ASKII_CLOUD_MODEL     ASKII_CLOUD_URL
  ASKII_MODE            ASKII_MAX_ROUNDS      ASKII_CONTROL_TARGET  ASKII_TIMEOUT
  ASKII_WIKI_PATH       ASKII_USE_WIKI      ASKII_USE_CODE_WIKI

Examples:
  cat myfile.ts | askii ask "what does this do?"
  cat myfile.ts | askii ask --lang typescript --file src/utils.ts "what does this do?"
  cat myfile.ts | askii edit "add error handling"
  askii explain "const x = arr.reduce((a, b) => a + b, 0)"
  askii do "create a Jest test file for src/utils.ts"
  askii do --yes "scaffold a README for this project"
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
  askii control --target browser --ollama-model llava "go to https://example.com and click Learn more"
  askii control --target browser --yes --headless --ollama-model llava "search Google for Node.js"
  askii browse --ollama-model llava "check the title of https://github.com"    # alias for control --target browser
  askii wiki-reload --wiki-path ./docs
  askii ask --wiki-path ./docs --use-wiki "how do I configure the database?"
  askii wiki-reload --use-code-wiki    # build the code wiki (runs embeddinggemma2 locally)
  askii ask --use-code-wiki "where is buildDoSystemPrompt defined?"
`);
}

// ── ASKII Note (CLI) ──────────────────────────────────────────────────────────
// Notes / tasks / reminders persisted to ~/.askii/notes.json, tagged by
// workspace. Mirrors src/notes.ts + src/notesPanel.ts in the extension, minus
// the webview UI and the in-process reminder scheduler (the CLI prints due
// reminders on demand via `askii note due`).

const NOTES_FILE = path.join(os.homedir(), '.askii', 'notes.json');


/**
 * Reads ~/.askii/notes.json. A file that exists but is not a notes array is
 * never treated as "no notes" — saving over it would wipe every entry — so a
 * copy is kept and the command fails with a message instead.
 */
function loadCliNotes(): NoteEntry[] {
  if (!fs.existsSync(NOTES_FILE)) return [];
  const raw = fs.readFileSync(NOTES_FILE, 'utf-8');
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    const backup = `${NOTES_FILE}.corrupt-${Date.now()}`;
    fs.copyFileSync(NOTES_FILE, backup);
    throw new Error(
      `${NOTES_FILE} is not a valid notes file, so it was left untouched (a copy is at ${backup}). Fix or remove it and try again.`,
    );
  }
  return parsed as NoteEntry[];
}

/** Writes the notes atomically (temp file + rename), so a crash never leaves half a file. */
function saveCliNotes(notes: NoteEntry[]): void {
  const dir = path.dirname(NOTES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${NOTES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(notes, null, 2));
  fs.renameSync(tmp, NOTES_FILE);
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
  if (n.dueAt) {
    parts.push(`due: ${formatDue(n.dueAt)}`);
    if (n.fired && !n.recur) parts.push('fired');
    if (n.missed && !n.done) parts.push(n.kind === 'task' ? 'overdue' : 'missed');
  }
  if (n.recur) parts.push(`repeats ${describeRecurrence(n.recur)}`);
  if (n.event) parts.push(`when: ${describeEventTrigger(n.event)}`);
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
      const id = genNoteId();
      screenshotPath = path.join(dir, `${id}.png`);
      fs.writeFileSync(screenshotPath, Buffer.from(base64, 'base64'));
      console.error(`  ✓ Screenshot saved: ${screenshotPath}`);
    } catch (e) {
      console.error(
        `  Warning: screenshot failed (${e instanceof Error ? e.message : 'Unknown error'})`,
      );
    }
  }

  let cls = await classifyNote(text, ctx, (prompt, system) => getResponse(config, prompt, system));

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
        recur: null,
        event: null,
        tags: cls.tags,
        needsClarification: false,
        clarifyingQuestion: null,
        summary: text.slice(0, 80),
      };
      break;
    }
    const combined = `${text}\n\n[clarified: ${answer}]`;
    cls = await classifyNote(combined, ctx, (prompt, system) =>
      getResponse(config, prompt, system),
    );
    rounds++;
  }

  if (cls.needsClarification && cls.clarifyingQuestion && !rl) {
    // Non-interactive: print the question and save as a plain note
    console.error(`  Note: ${cls.clarifyingQuestion} (saving as a plain note)`);
    cls = {
      kind: 'note',
      priority: null,
      dueAt: null,
      recur: null,
      event: null,
      tags: cls.tags,
      needsClarification: false,
      clarifyingQuestion: null,
      summary: text.slice(0, 80),
    };
  }

  const entry = buildNoteEntry(text, cls, ctx);
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

/**
 * A command failed after printing its own error/usage message. Thrown instead
 * of process.exit(1) so the REPL survives; one-shot commands exit with code 1.
 */
class CommandFailed extends Error {}

function noteToggleDone(id: string): void {
  const notes = loadCliNotes();
  const i = notes.findIndex((n) => n.id === id);
  if (i === -1) {
    console.error(`Error: no entry with id "${id}"`);
    throw new CommandFailed();
  }
  if (notes[i].kind !== 'task') {
    console.error(`Error: entry ${id} is a ${notes[i].kind}, not a task`);
    throw new CommandFailed();
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
    throw new CommandFailed();
  }
  const removed = notes.splice(i, 1)[0];
  saveCliNotes(notes);
  console.log(`  ✓ Deleted ${removed.kind} ${id}`);
}

function noteDue(): void {
  const notes = loadCliNotes();
  const now = Date.now();
  const due = notes.filter(
    (n) => n.dueAt && !n.fired && !n.done && new Date(n.dueAt).getTime() <= now,
  );
  if (due.length === 0) {
    console.log('No reminders are due. (´･_･`)');
    return;
  }
  console.log(`⏰ ${due.length} trigger(s) due:\n`);
  due.forEach((n, i) => {
    printNoteEntry(n, i + 1);
    if (n.recur) {
      // Recurring: roll to the next occurrence instead of marking fired.
      const next = computeNextOccurrence(n.recur, new Date(now));
      if (next) n.dueAt = next.toISOString();
      else n.fired = true;
    } else {
      // One-shot: mark as fired + missed (CLI has no background scheduler)
      n.fired = true;
      n.missed = true;
    }
  });
  saveCliNotes(notes);
  console.error('\n  (Triggers processed. Use `askii note add` to create new ones.)');
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
        throw new CommandFailed();
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
        throw new CommandFailed();
      }
      noteList(query);
      break;
    }
    case 'done':
    case 'check': {
      const id = args[0];
      if (!id) {
        console.error('Usage: askii note done <id>');
        throw new CommandFailed();
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
        throw new CommandFailed();
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
      throw new CommandFailed();
    }
  }
}

// ── ASKII Control (Screen / Browser) ──────────────────────────────────────────
// One entry point for both control targets: `askii control` drives the screen
// by default or the browser via --target browser / ASKII_CONTROL_TARGET, and
// `askii browse` is an alias for browser mode. Mirrors askiiControlCommand /
// runScreenControlTask / runBrowserTask in src/commands.ts.

/** Terminal rendering of Control agent events (shared by screen and browser). */
function printControlEvent(event: ControlEvent): void {
  switch (event.type) {
    case 'round-start':
      console.error(`Round ${event.round}/${event.maxRounds} — taking screenshot...`);
      break;
    case 'screenshot':
      if (event.note) console.error(event.note);
      console.error('Asking AI...');
      break;
    case 'parse-error':
      console.error('Error: could not parse AI response.');
      console.error(`Raw response: ${event.raw}`);
      break;
    case 'done':
      console.error(`\nDone! ${getRandomKaomoji()}`);
      console.error(`Reasoning: ${event.reasoning}`);
      break;
    case 'action-planned':
      console.error(`\nAction:    ${event.label}`);
      console.error(`Reasoning: ${event.reasoning}`);
      break;
    case 'action-update':
      if (event.detail) console.error(event.detail);
      if (event.status === 'ok') console.error('Executed.');
      if (event.status === 'error') console.error('Action failed.');
      break;
    case 'notice':
      console.error(`${event.level === 'warning' ? 'Warning: ' : ''}${event.message}`);
      break;
    case 'max-rounds':
      console.error(`Max rounds (${event.maxRounds}) reached.`);
      break;
    case 'round-end':
      break;
  }
}

function cliVisionAsk(config: Config): VisionAsk {
  return (system, prompt, image, signal) =>
    getResponse(config, prompt, system || undefined, image, signal);
}

async function runScreenControl(instruction: string, config: Config): Promise<void> {
  const missingDeps = checkControlDependencies();
  if (missingDeps.length > 0) {
    console.error(
      `Error: missing required tools:\n${missingDeps.map((d) => `  - ${d}`).join('\n')}`,
    );
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const abortController = new AbortController();

  // Handle Ctrl+C gracefully. On a TTY readline holds stdin in raw mode, so
  // Ctrl+C arrives as rl's 'SIGINT' event rather than a process signal.
  const stop = () => {
    abortController.abort();
    console.error('\n\nStopped by user (Ctrl+C).');
    rl.close();
    process.exit(EXIT_INTERRUPTED);
  };
  process.once('SIGINT', stop);
  rl.on('SIGINT', stop);

  try {
    console.error(`ASKII Control (Screen) starting... ${getRandomThinkingKaomoji()}`);
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

    const result = await runScreenAgent({
      task: instruction,
      maxRounds: config.maxRounds,
      signal: abortController.signal,
      autoConfirm: config.yes,
      monitorId,
      session: { history: [] },
      refineClicks: true,
      ask: cliVisionAsk(config),
      confirm: ({ message }) => confirm(rl, message, false),
      emit: printControlEvent,
    });
    rl.close();
    if (result.outcome === 'stopped') console.error('Stopped.');
    if (result.outcome === 'parse-error') process.exit(1);
  } catch (error) {
    rl.close();
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }
}

async function runBrowserControl(task: string, config: Config): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const abortController = new AbortController();

  const puppeteer = await import('puppeteer-core');
  let browser: import('puppeteer-core').Browser | undefined;

  // On a TTY readline holds stdin in raw mode, so Ctrl+C arrives as rl's
  // 'SIGINT' event rather than a process signal — listen for both.
  const stop = () => {
    abortController.abort();
    console.error('\n\nStopped by user (Ctrl+C).');
    rl.close();
    void Promise.resolve(browser?.close())
      .catch(() => undefined)
      .finally(() => process.exit(EXIT_INTERRUPTED));
  };
  process.once('SIGINT', stop);
  rl.on('SIGINT', stop);

  let failed = false;
  try {
    console.error(`ASKII Control (Browser) starting... ${getRandomThinkingKaomoji()}`);
    console.error(`Task: ${task}`);
    console.error('(Make sure your model supports vision/images)');
    console.error('Press Ctrl+C to stop at any time.\n');

    const executablePath = config.chromePath || detectBrowserExecutable();
    if (!executablePath) {
      console.error(
        'Error: no Chromium-based browser found. Install Chrome or Edge, or pass --chrome-path / set ASKII_CHROME_PATH to your browser executable.',
      );
      process.exit(1);
    }
    console.error(`Browser executable: ${executablePath}`);

    browser = await puppeteer.launch({
      headless: config.headless ? true : false,
      executablePath,
      args: browserLaunchArgs(),
    });

    const [page] = await browser.pages();
    await page.setViewport(null);

    const result = await runBrowserAgent({
      task,
      maxRounds: config.maxRounds,
      signal: abortController.signal,
      autoConfirm: config.yes,
      page,
      ask: cliVisionAsk(config),
      confirm: ({ message }) => confirm(rl, message, false),
      emit: printControlEvent,
    });
    if (result.outcome === 'stopped') console.error('Stopped.');
    failed = result.outcome === 'parse-error';
    rl.close();
  } catch (error) {
    rl.close();
    console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    failed = true;
  }

  // The launched browser keeps the event loop alive. Headless (or failed):
  // close it so the CLI exits. Headed: leave it for inspection — Puppeteer
  // kills it when Node exits, so wait until the user closes the window (or
  // presses Ctrl+C).
  if (browser?.connected) {
    if (config.headless || failed) {
      await browser.close();
    } else {
      console.error('Browser left open — close it (or press Ctrl+C) to exit.');
      const openBrowser = browser;
      await new Promise<void>((resolve) => openBrowser.once('disconnected', () => resolve()));
    }
  }
  if (failed) process.exit(1);
}

/**
 * Generates a commit message from the staged (or, failing that, working-tree)
 * git diff in workDir. Shared by the `commit` command and the REPL's /commit;
 * mirrors src/commitMessage.ts in the extension. Returns null when there is
 * nothing to commit and '' when the model returned no message; throws when
 * workDir is not a git repository or the LLM call fails.
 */
async function generateCliCommitMessage(workDir: string, config: Config): Promise<string | null> {
  const { execFileSync } = await import('child_process');

  function git(args: string[]): string {
    try {
      // Large buffer: a big staged diff (e.g. a lockfile) would otherwise
      // overflow the 1 MB default and silently come back empty.
      return execFileSync('git', args, {
        cwd: workDir,
        encoding: 'utf-8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      return '';
    }
  }

  // Confirm we are inside a git repo.
  if (git(['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
    throw new Error('not inside a git repository');
  }

  // Prefer staged diff; fall back to working-tree diff.
  let diff = git(['diff', '--cached']);
  const hasStaged = diff.trim().length > 0;
  if (!hasStaged) {
    diff = git(['diff']);
  }

  // File list (staged or working-tree).
  const nameStatus = hasStaged
    ? git(['diff', '--cached', '--name-only'])
    : git(['status', '--porcelain', '--untracked-files=no']);
  const files = nameStatus
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (hasStaged ? l : l.replace(/^\S+\s+/, '')).replace(/^"|"$/g, ''))
    .map((f) => path.basename(f));

  if (!diff.trim() && files.length === 0) {
    return null;
  }

  // Recent commit messages give the model concrete style examples
  const examples = formatCommitExamples(
    git(['log', '-n', String(MAX_RECENT_COMMITS), '-z', '--format=%B']).split('\0'),
  );
  const userPrompt = buildCommitUserPrompt({ files, diff, staged: hasStaged, examples });
  const system = buildCommitMessageSystemPrompt(config.commitStyle, '');

  console.error(`ASKII is generating a commit message... ${getRandomThinkingKaomoji()}`);
  const response = await getResponse(config, userPrompt, system);
  return cleanCommitMessage(response);
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = argv;
  const positional = getPositionals(argv);
  const command = positional[0] ?? '';

  if (hasFlag(flags, '-v', '--version') || command === 'version') {
    console.log(getAskiiVersion());
    process.exit(0);
  }

  if (hasFlag(flags, '-h', '--help') || command === 'help') {
    printHelp();
    process.exit(0);
  }

  const unknownFlags = getUnknownFlags(flags);
  if (unknownFlags.length > 0) {
    console.error(`Warning: ignoring unknown option(s): ${unknownFlags.join(', ')} (see askii --help)`);
  }

  const config = getConfig(flags);

  // No command given → interactive REPL mode
  if (!command) {
    await startRepl(config);
    return;
  }

  if (command === 'wiki-reload') {
    const wikiPath = config.wikiPath || getFlagValue(flags, '--wiki-path') || process.env.ASKII_WIKI_PATH;
    const codeWikiRequested = config.useCodeWiki;
    if (!wikiPath && !codeWikiRequested) {
      console.error(
        'Error: nothing to reload — provide --wiki-path <path> (docs wiki) and/or --use-code-wiki (code wiki)',
      );
      process.exit(1);
    }
    let failed = false;

    if (wikiPath) {
      if (!fs.existsSync(wikiPath)) {
        console.error(`Error: wiki path not found: ${wikiPath}`);
        failed = true;
      } else {
        try {
          console.error(`Indexing wiki files in: ${wikiPath}`);
          const stats = await buildWikiIndex(wikiPath, {
            onProgress: (stage, current, total) => {
              if (stage === 'indexing') {
                process.stderr.write(`\r  wiki: file ${current}/${total}`);
              }
            },
          });
          process.stderr.write('\n');
          console.error(
            `Wiki indexed: ${stats.chunkCount} chunks from ${stats.fileCount} file(s). ${getRandomKaomoji()}`,
          );
        } catch (error) {
          process.stderr.write('\n');
          console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
          failed = true;
        }
      }
    }

    if (codeWikiRequested) {
      try {
        await reloadCliCodeWiki(path.resolve(getFlagValue(flags, '--dir') || process.cwd()));
      } catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        failed = true;
      }
    }

    if (failed) process.exit(1);
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

    const wikiCtxAsk = await getCliWikiContext(config, question);
    const wikiSectionAsk = wikiCtxAsk ? `Relevant documentation:\n${wikiCtxAsk}\n\n` : '';

    const codeWikiCtxAsk = await getCliCodeWikiContext(config, question);
    const codeWikiSectionAsk = codeWikiCtxAsk
      ? `Relevant code from the codebase:\n${codeWikiCtxAsk}\n\n`
      : '';

    let prompt: string;
    if (code) {
      const metaLines = [file ? `File: ${file}` : null, lang ? `Language: ${lang}` : null]
        .filter(Boolean)
        .join('\n');
      const codeBlock = `\`\`\`${lang ?? ''}\n${code}\n\`\`\``;
      prompt = `${wikiSectionAsk}${codeWikiSectionAsk}${metaLines ? metaLines + '\n' : ''}Code:\n${codeBlock}\n\nQuestion: ${question}`;
    } else {
      prompt = `${wikiSectionAsk}${codeWikiSectionAsk}Question: ${question}`;
    }
    prompt += `\n\n${FILE_CITATION_INSTRUCTIONS}`;

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
    // and print it to stdout.
    try {
      const message = await generateCliCommitMessage(
        getFlagValue(flags, '--dir') || process.cwd(),
        config,
      );
      if (message === null) {
        console.error('ASKII: No changes to commit. (´･_･`)');
        process.exit(0);
      }
      if (!message) {
        console.error('ASKII: The model returned no commit message. Try again.');
        process.exit(1);
      }
      // Print only the commit message to stdout (pipe-friendly).
      console.log(message);
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
    const wikiCtxEdit = await getCliWikiContext(config, instruction);
    const wikiSectionEdit = wikiCtxEdit ? `Relevant documentation:\n${wikiCtxEdit}\n\n` : '';
    const codeWikiCtxEdit = await getCliCodeWikiContext(config, instruction);
    const codeWikiSectionEdit = codeWikiCtxEdit
      ? `Relevant code from the codebase:\n${codeWikiCtxEdit}\n\n`
      : '';
    const prompt = `${wikiSectionEdit}${codeWikiSectionEdit}${metaLines ? metaLines + '\n' : ''}Update this code:\n\`\`\`${lang ?? ''}\n${code}\n\`\`\`\n\nRequest: ${instruction}\n\nReturn only the updated code without explanation.`;

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
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const abortController = new AbortController();

    // On a TTY readline holds stdin in raw mode, so Ctrl+C arrives as rl's
    // 'SIGINT' event rather than a process signal — listen for both. The
    // first Ctrl+C stops the agent (and the in-flight request) and still
    // offers the undo prompt; a second one exits immediately.
    const stop = () => {
      if (abortController.signal.aborted) {
        rl.close();
        process.exit(EXIT_INTERRUPTED);
      }
      abortController.abort();
      console.error('\n\nStopping (Ctrl+C) — press Ctrl+C again to exit immediately.');
    };
    process.on('SIGINT', stop);
    rl.on('SIGINT', stop);

    await runCliDo(task, config, rl, workDir, abortController.signal);
    rl.close();
    if (abortController.signal.aborted) {
      process.exit(EXIT_INTERRUPTED);
    }
  } else if (command === 'control' || command === 'browse') {
    // ASKII Control — screen (default) or browser, picked via --target /
    // ASKII_CONTROL_TARGET. `browse` is an alias for browser mode.
    const task = positional.slice(1).join(' ');

    if (!task) {
      console.error('Error: provide a task as an argument');
      process.exit(1);
    }

    const target = command === 'browse' ? 'browser' : config.controlTarget;
    if (target !== 'screen' && target !== 'browser') {
      console.error(`Error: --target must be 'screen' or 'browser' (got: '${target}')`);
      process.exit(1);
    }

    if (target === 'browser') {
      await runBrowserControl(task, config);
    } else {
      await runScreenControl(task, config);
    }
  } else if (command === 'note') {
    // ASKII Note — notes / tasks / reminders, persisted to ~/.askii/notes.json
    const subcommand = positional[1] ?? 'list';
    const noteArgs = positional.slice(2);
    try {
      await runNoteCommand(subcommand, noteArgs, flags, config);
    } catch (e) {
      // CommandFailed already printed its message
      if (!(e instanceof CommandFailed)) {
        console.error(`Error: ${e instanceof Error ? e.message : 'Unknown error'}`);
      }
      process.exit(1);
    }
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`Error: ${error.message}`);
    process.exit(EXIT_USAGE);
  }
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
