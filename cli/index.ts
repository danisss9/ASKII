import {
  getWorkspaceStructure,
  parseWorkspaceActions,
  sandboxPath,
  executeViewAction,
  executeSearchAction,
  buildDoSystemPrompt,
  writeBackup,
  recordCreatedFile,
  deleteAllBackups,
  restoreAllBackups,
  hasBackups,
  type WorkspaceAction,
  type ActionResult,
} from '@common/workspace';
import { unescapeJsonString, extractCode } from '@common/utils';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import {
  getOllamaResponse,
  getLMStudioResponse,
  getOllamaChat,
  getLMStudioChat,
  getOpenAIResponse,
  getOpenAIChat,
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
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

interface Config {
  platform: 'ollama' | 'lmstudio' | 'openai';
  url: string;
  model: string;
  openaiApiKey: string;
  openaiBaseURL: string | undefined;
  mode: 'helpful' | 'funny';
  maxRounds: number;
  yes: boolean;
  headless: boolean;
  chromePath: string | undefined;
}

function getFlagValue(flags: string[], ...names: string[]): string | undefined {
  for (const name of names) {
    const i = flags.indexOf(name);
    if (i !== -1 && flags[i + 1] && !flags[i + 1].startsWith('-')) {
      return flags[i + 1];
    }
  }
}

function hasFlag(flags: string[], ...names: string[]): boolean {
  return names.some((n) => flags.includes(n));
}

function getConfig(flags: string[]): Config {
  const platform = (getFlagValue(flags, '-p', '--platform') ||
    process.env.ASKII_PLATFORM ||
    'ollama') as 'ollama' | 'lmstudio';

  const ollamaUrl =
    getFlagValue(flags, '--ollama-url') || process.env.ASKII_OLLAMA_URL || 'http://localhost:11434';

  const lmStudioUrl =
    getFlagValue(flags, '--lmstudio-url') ||
    process.env.ASKII_LMSTUDIO_URL ||
    'ws://localhost:1234';

  const ollamaModel =
    getFlagValue(flags, '--ollama-model') || process.env.ASKII_OLLAMA_MODEL || 'gemma3:270m';

  const lmStudioModel =
    getFlagValue(flags, '--lmstudio-model') ||
    process.env.ASKII_LMSTUDIO_MODEL ||
    'qwen/qwen3-coder-30b';

  const openaiModel =
    getFlagValue(flags, '--openai-model') || process.env.ASKII_OPENAI_MODEL || 'gpt-4o';

  const openaiApiKey = getFlagValue(flags, '--openai-key') || process.env.ASKII_OPENAI_KEY || '';

  const openaiBaseURL =
    getFlagValue(flags, '--openai-url') || process.env.ASKII_OPENAI_URL || undefined;

  const modelMap: Record<string, string> = {
    lmstudio: lmStudioModel,
    openai: openaiModel,
  };

  return {
    platform,
    url: platform === 'lmstudio' ? lmStudioUrl : ollamaUrl,
    model: modelMap[platform] ?? ollamaModel,
    openaiApiKey,
    openaiBaseURL,
    mode: (getFlagValue(flags, '--mode') || process.env.ASKII_MODE || 'funny') as
      | 'helpful'
      | 'funny',
    maxRounds: parseInt(getFlagValue(flags, '--max-rounds') || process.env.ASKII_MAX_ROUNDS || '5'),
    yes: hasFlag(flags, '-y', '--yes'),
    headless: hasFlag(flags, '--headless'),
    chromePath: getFlagValue(flags, '--chrome-path') || process.env.ASKII_CHROME_PATH || undefined,
  };
}

async function getResponse(
  config: Config,
  prompt: string,
  system?: string,
  imageBase64?: string,
): Promise<string> {
  if (config.platform === 'lmstudio') {
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

async function getChatResponse(config: Config, messages: ChatMessage[]): Promise<string> {
  if (config.platform === 'lmstudio') {
    return getLMStudioChat(messages, config.url, config.model);
  } else if (config.platform === 'openai') {
    return getOpenAIChat(messages, config.openaiApiKey, config.model, config.openaiBaseURL);
  }
  return getOllamaChat(messages, config.url, config.model);
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

function printHelp() {
  console.log(`ASKII CLI ( •_•)>⌐■-■ (⌐■_■)
AI code assistant for your terminal

Usage: askii <command> [options]

Commands:
  ask <question>        Ask a question about code
  edit <instruction>    Edit code and print the result to stdout
  explain <line>        Explain a single line of code
  do <task>             Agentic task runner — creates, modifies, and deletes files
  control <instruction> Screen control — takes screenshots and drives mouse/keyboard
  browse <task>         Browser agent — launches Puppeteer and navigates the web

Options:
  -p, --platform <p>         LLM platform: ollama, lmstudio, openai (default: ollama)
      --ollama-url <url>     Ollama server URL (default: http://localhost:11434)
      --lmstudio-url <url>   LM Studio server URL (default: ws://localhost:1234)
      --ollama-model <m>     Ollama model (default: gemma3:270m)
      --lmstudio-model <m>   LM Studio model (default: qwen/qwen3-coder-30b)
      --openai-key <key>     OpenAI API key (env: ASKII_OPENAI_KEY)
      --openai-model <m>     OpenAI model (default: gpt-4o)
      --openai-url <url>     OpenAI-compatible base URL (env: ASKII_OPENAI_URL)
      --mode <mode>          Response mode: helpful, funny (default: funny)
      --max-rounds <n>       Max agent rounds for "do" / "control" / "browse" (default: 5)
      --dir <path>           Working directory for "do" (default: cwd)
  -c, --code <code>          Code input (alternative to stdin)
      --lang <language>      Language of the code (e.g. typescript, python)
      --file <filename>      Filename of the code (e.g. src/utils.ts)
      --headless             Run Puppeteer in headless mode for "browse" (default: visible)
      --chrome-path <path>   Path to Chrome/Chromium executable for "browse" (env: ASKII_CHROME_PATH)
  -y, --yes                  Auto-confirm all actions
  -h, --help                 Show help

Environment variables:
  ASKII_PLATFORM
  ASKII_OLLAMA_URL      ASKII_LMSTUDIO_URL
  ASKII_OLLAMA_MODEL    ASKII_LMSTUDIO_MODEL
  ASKII_OPENAI_KEY      ASKII_OPENAI_MODEL    ASKII_OPENAI_URL
  ASKII_MODE            ASKII_MAX_ROUNDS

Examples:
  cat myfile.ts | askii ask "what does this do?"
  cat myfile.ts | askii ask --lang typescript --file src/utils.ts "what does this do?"
  cat myfile.ts | askii edit "add error handling"
  askii explain "const x = arr.reduce((a, b) => a + b, 0)"
  askii do "create a Jest test file for src/utils.ts"
  askii do --yes "scaffold a README for this project"
  askii -p lmstudio --lmstudio-model "my-model" do "refactor index.ts"
  askii control --ollama-model llava "open Notepad and type hello world"
  askii control --yes --ollama-model llava "click the search bar and search for cats"
  askii browse --ollama-model llava "go to https://example.com and click Learn more"
  askii browse --yes --headless --ollama-model llava "search Google for Node.js"
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || 'help';
  const flags = argv;
  const positional = argv.filter((a) => !a.startsWith('-'));

  if (hasFlag(flags, '-h', '--help') || command === 'help') {
    printHelp();
    process.exit(0);
  }

  const config = getConfig(flags);

  if (command === 'ask') {
    const stdin = await readStdin();
    const code = getFlagValue(flags, '-c', '--code') || stdin;
    const question = positional.slice(1).join(' ');
    const lang = getFlagValue(flags, '--lang');
    const file = getFlagValue(flags, '--file');

    if (!question) {
      console.error('Error: provide a question as an argument');
      process.exit(1);
    }

    let prompt: string;
    if (code) {
      const metaLines = [file ? `File: ${file}` : null, lang ? `Language: ${lang}` : null]
        .filter(Boolean)
        .join('\n');
      const codeBlock = `\`\`\`${lang ?? ''}\n${code}\n\`\`\``;
      prompt = `${metaLines ? metaLines + '\n' : ''}Code:\n${codeBlock}\n\nQuestion: ${question}`;
    } else {
      prompt = `Question: ${question}`;
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
    const prompt = `${metaLines ? metaLines + '\n' : ''}Update this code:\n\`\`\`${lang ?? ''}\n${code}\n\`\`\`\n\nRequest: ${instruction}\n\nReturn only the updated code without explanation.`;

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

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

    try {
      const workspaceStructure = getWorkspaceStructure(workDir);
      console.error(`\nWorkspace: ${workDir}\n\`\`\`\n${workspaceStructure}\`\`\`\n`);

      const systemPrompt = buildDoSystemPrompt(workspaceStructure);
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task },
      ];

      let completedActions = 0;
      let roundCount = 0;

      while (roundCount < config.maxRounds) {
        console.error(`\n[Round ${roundCount + 1}/${config.maxRounds}]`);

        const responseText = await getChatResponse(config, messages);
        messages.push({ role: 'assistant', content: responseText });

        const actions = parseWorkspaceActions(responseText);
        if (actions.length === 0) {
          console.error('No actions returned. Done.');
          break;
        }

        const readActions = actions.filter(
          (a) => a.type === 'view' || a.type === 'list' || a.type === 'search',
        );
        const writeActions = actions.filter(
          (a) => a.type !== 'view' && a.type !== 'list' && a.type !== 'search',
        );

        const feedbackParts: string[] = [];

        // ── Read actions ──────────────────────────────────────────────────────
        const viewResults: Record<string, string> = {};
        for (const action of readActions) {
          try {
            if (action.type === 'search') {
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
  } else if (command === 'control') {
    const instruction = positional.slice(1).join(' ');

    if (!instruction) {
      console.error('Error: provide an instruction as an argument');
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
    } finally {
      if (browser) {
        console.error('Closing browser...');
        await browser.close().catch(() => undefined);
      }
    }
  } else {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }
}

main();
