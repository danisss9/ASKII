import { getWorkspaceStructure, parseWorkspaceActions } from '@common/workspace';
import { unescapeJsonString, extractCode } from '@common/utils';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import { getOllamaResponse, getLMStudioResponse } from '@common/providers';
import {
  buildControlSystemPrompt,
  parseControlAction,
  takeScreenshot,
  describeAction,
  executeControlAction,
} from '@common/control';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';

interface Config {
  platform: 'ollama' | 'lmstudio';
  url: string;
  model: string;
  mode: 'helpful' | 'funny';
  maxRounds: number;
  yes: boolean;
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

  return {
    platform,
    url: platform === 'lmstudio' ? lmStudioUrl : ollamaUrl,
    model: platform === 'lmstudio' ? lmStudioModel : ollamaModel,
    mode: (getFlagValue(flags, '--mode') || process.env.ASKII_MODE || 'funny') as
      | 'helpful'
      | 'funny',
    maxRounds: parseInt(getFlagValue(flags, '--max-rounds') || process.env.ASKII_MAX_ROUNDS || '5'),
    yes: hasFlag(flags, '-y', '--yes'),
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

Options:
  -p, --platform <p>         LLM platform: ollama, lmstudio (default: ollama)
      --ollama-url <url>     Ollama server URL (default: http://localhost:11434)
      --lmstudio-url <url>   LM Studio server URL (default: ws://localhost:1234)
      --ollama-model <m>     Ollama model (default: gemma3:270m)
      --lmstudio-model <m>   LM Studio model (default: qwen/qwen3-coder-30b)
      --mode <mode>          Response mode: helpful, funny (default: funny)
      --max-rounds <n>       Max agent rounds for "do" / "control" (default: 5)
      --dir <path>           Working directory for "do" (default: cwd)
  -c, --code <code>          Code input (alternative to stdin)
      --lang <language>      Language of the code (e.g. typescript, python)
      --file <filename>      Filename of the code (e.g. src/utils.ts)
  -y, --yes                  Auto-confirm all actions
  -h, --help                 Show help

Environment variables:
  ASKII_PLATFORM
  ASKII_OLLAMA_URL      ASKII_LMSTUDIO_URL
  ASKII_OLLAMA_MODEL    ASKII_LMSTUDIO_MODEL
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

    if (!code) {
      console.error('Error: provide code via stdin or -c/--code');
      process.exit(1);
    }
    if (!instruction) {
      console.error('Error: provide an instruction as an argument');
      process.exit(1);
    }

    const prompt = `Update this code:\n\`\`\`\n${code}\n\`\`\`\n\nRequest: ${instruction}\n\nReturn only the updated code without explanation.`;

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

    const workDir = getFlagValue(flags, '--dir') || process.cwd();

    console.error(`ASKII is working... ${getRandomThinkingKaomoji()}`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

    try {
      const workspaceStructure = getWorkspaceStructure(workDir);
      console.error(`\nWorkspace: ${workDir}\n\`\`\`\n${workspaceStructure}\`\`\`\n`);
      let completedActions = 0;
      let roundCount = 0;

      const systemPrompt = `You are ASKII, an AI agent that can create, modify, view, delete, rename, and list files in a workspace.

Current workspace structure:
\`\`\`
${workspaceStructure}
\`\`\`

You have access to the following action types:
- {"type": "view", "path": "path/to/file"} - View file contents, results sent back to you
- {"type": "list", "path": "path/to/folder"} - List files in a folder, results sent back to you
- {"type": "create", "path": "path/to/file", "content": "file content"}
- {"type": "modify", "path": "path/to/file", "oldContent": "text to replace", "newContent": "replacement text"}
- {"type": "rename", "path": "old/path", "newPath": "new/path"} - Rename or move a file
- {"type": "delete", "path": "path/to/file"}

Always respond with ONLY a valid JSON array containing the actions. You can request to view files or list folders to inspect them, and their contents will be sent back to you.`;

      let userMessage = task;

      while (roundCount < config.maxRounds) {
        const fullPrompt =
          roundCount === 0
            ? `${systemPrompt}\n\nUser request: ${userMessage}`
            : `${systemPrompt}\n\n${userMessage}`;

        const responseText = await getResponse(config, fullPrompt);
        const actions = parseWorkspaceActions(responseText);

        if (actions.length === 0) break;

        const viewActions = actions.filter((a) => a.type === 'view' || a.type === 'list');
        const otherActions = actions.filter((a) => a.type !== 'view' && a.type !== 'list');

        const viewResults: Record<string, string> = {};
        for (const action of viewActions) {
          const filePath = path.join(workDir, action.path);
          try {
            if (action.type === 'list') {
              console.error(`  → Listing: ${action.path}`);
              const entries = fs.readdirSync(filePath).map((name) => {
                const stat = fs.statSync(path.join(filePath, name));
                return `${name} [${stat.isDirectory() ? 'folder' : 'file'}]`;
              });
              viewResults[action.path] = entries.join('\n');
            } else {
              console.error(`  → Viewing: ${action.path}`);
              viewResults[action.path] = fs.readFileSync(filePath, 'utf-8');
            }
          } catch {
            viewResults[action.path] = 'Error: Cannot read path';
          }
        }

        for (const action of otherActions) {
          const filePath = path.join(workDir, action.path);

          if (action.type === 'create') {
            const ok = await confirm(rl, `Create file: ${action.path}?`, config.yes);
            if (ok) {
              const dir = path.dirname(filePath);
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
              const content = action.content ? unescapeJsonString(action.content) : '';
              fs.writeFileSync(filePath, content);
              completedActions++;
              console.error(`  ✓ Created: ${action.path}`);
            }
          } else if (action.type === 'modify') {
            const ok = await confirm(rl, `Modify file: ${action.path}?`, config.yes);
            if (ok) {
              try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const oldContent = action.oldContent ? unescapeJsonString(action.oldContent) : '';
                const newContent = action.newContent ? unescapeJsonString(action.newContent) : '';
                fs.writeFileSync(filePath, content.replace(oldContent, newContent));
                completedActions++;
                console.error(`  ✓ Modified: ${action.path}`);
              } catch {
                console.error(`  ✗ Cannot modify: ${action.path}`);
              }
            }
          } else if (action.type === 'delete') {
            const ok = await confirm(
              rl,
              `Delete file: ${action.path}? This cannot be undone.`,
              config.yes,
            );
            if (ok) {
              try {
                fs.unlinkSync(filePath);
                completedActions++;
                console.error(`  ✓ Deleted: ${action.path}`);
              } catch {
                console.error(`  ✗ Cannot delete: ${action.path}`);
              }
            }
          } else if (action.type === 'rename') {
            if (!action.newPath) {
              console.error(`  ✗ Rename missing newPath: ${action.path}`);
            } else {
              const newFilePath = path.join(workDir, action.newPath);
              const ok = await confirm(
                rl,
                `Rename: ${action.path} → ${action.newPath}?`,
                config.yes,
              );
              if (ok) {
                try {
                  const newDir = path.dirname(newFilePath);
                  if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
                  fs.renameSync(filePath, newFilePath);
                  completedActions++;
                  console.error(`  ✓ Renamed: ${action.path} → ${action.newPath}`);
                } catch {
                  console.error(`  ✗ Cannot rename: ${action.path}`);
                }
              }
            }
          }
        }

        if (Object.keys(viewResults).length > 0) {
          userMessage = `File contents retrieved:\n${JSON.stringify(viewResults, null, 2)}\n\nWhat would you like to do next? Respond with only a JSON array of actions or an empty array [] if done.`;
        } else {
          userMessage = `Actions completed. What would you like to do next? Respond with only a JSON array of actions or an empty array [] if done.`;
        }
        roundCount++;
      }

      rl.close();
      console.error(`\nCompleted ${completedActions} actions! ${getRandomKaomoji()}`);
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

    try {
      console.error(`ASKII Control starting... ${getRandomThinkingKaomoji()}`);
      console.error(`Instruction: ${instruction}`);
      console.error('(Make sure your model supports vision/images)\n');

      let round = 0;

      while (round < config.maxRounds) {
        console.error(`Round ${round + 1}/${config.maxRounds} — taking screenshot...`);

        const { base64: imageBase64, width: screenW, height: screenH } = await takeScreenshot();

        const prompt =
          round === 0
            ? `Instruction to complete: ${instruction}\n\nAnalyze the screenshot and determine the next action.`
            : `Continuing instruction: ${instruction}\n\nAnalyze the updated screenshot and determine the next action, or return DONE if the instruction is complete.`;

        console.error('Asking AI...');
        const response = await getResponse(
          config,
          prompt,
          buildControlSystemPrompt(screenW, screenH),
          imageBase64,
        );

        const action = parseControlAction(response);

        if (!action) {
          console.error('Error: could not parse action from AI response.');
          console.error(`Raw response: ${response}`);
          break;
        }

        if (action.action === 'DONE') {
          console.error(`\nDone! ${getRandomKaomoji()}`);
          console.error(`Reasoning: ${action.reasoning}`);
          break;
        }

        const desc = describeAction(action);
        console.error(`\nAction:    ${desc}`);
        console.error(`Reasoning: ${action.reasoning}`);

        const ok = await confirm(rl, 'Execute this action?', config.yes);
        if (!ok) {
          console.error('Stopped.');
          break;
        }

        await executeControlAction(action, screenW, screenH);
        console.error('Executed.\n');

        round++;
      }

      if (round >= config.maxRounds) {
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
