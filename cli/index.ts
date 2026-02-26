import { getWorkspaceStructure, parseWorkspaceActions } from '@common/workspace';
import { unescapeJsonString } from '@common/utils';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { Ollama } from 'ollama';
import { LMStudioClient } from '@lmstudio/sdk';

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

  const defaultUrl =
    platform === 'lmstudio' ? 'ws://localhost:1234' : 'http://localhost:11434';

  return {
    platform,
    url: getFlagValue(flags, '--url') || process.env.ASKII_URL || defaultUrl,
    model:
      getFlagValue(flags, '-m', '--model') ||
      process.env.ASKII_MODEL ||
      (platform === 'lmstudio' ? 'qwen/qwen3-coder-30b' : 'gemma3:270m'),
    mode: (getFlagValue(flags, '--mode') ||
      process.env.ASKII_MODE ||
      'funny') as 'helpful' | 'funny',
    maxRounds: parseInt(
      getFlagValue(flags, '--max-rounds') || process.env.ASKII_MAX_ROUNDS || '5',
    ),
    yes: hasFlag(flags, '-y', '--yes'),
  };
}

async function getResponse(config: Config, prompt: string, system?: string): Promise<string> {
  if (config.platform === 'lmstudio') {
    const client = new LMStudioClient({ baseUrl: config.url });
    const model = await client.llm.model(config.model);
    const messages: { role: 'system' | 'user'; content: string }[] = system
      ? [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ]
      : [{ role: 'user', content: prompt }];
    const result = await model.respond(messages);
    return result.content || 'No response';
  } else {
    const ollama = new Ollama({ host: config.url });
    const response = await ollama.generate({
      model: config.model,
      system,
      prompt,
      stream: false,
    });
    return response.response || 'No response';
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

async function confirm(rl: readline.Interface, question: string, autoYes: boolean): Promise<boolean> {
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

Options:
  -p, --platform <platform>  LLM platform: ollama, lmstudio (default: ollama)
      --url <url>            LLM server URL
  -m, --model <model>        Model to use
      --mode <mode>          Response mode: helpful, funny (default: funny)
      --max-rounds <n>       Max agent rounds for "do" (default: 5)
      --dir <path>           Working directory for "do" (default: cwd)
  -c, --code <code>          Code input (alternative to stdin)
  -y, --yes                  Auto-confirm all file operations in "do"
  -h, --help                 Show help

Environment variables:
  ASKII_PLATFORM, ASKII_URL, ASKII_MODEL, ASKII_MODE, ASKII_MAX_ROUNDS

Examples:
  cat myfile.ts | askii ask "what does this do?"
  cat myfile.ts | askii edit "add error handling"
  askii explain "const x = arr.reduce((a, b) => a + b, 0)"
  askii do "create a Jest test file for src/utils.ts"
  askii do --yes "scaffold a README for this project"
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

    if (!question) {
      console.error('Error: provide a question as an argument');
      process.exit(1);
    }

    const prompt = code
      ? `Code:\n\`\`\`\n${code}\n\`\`\`\n\nQuestion: ${question}`
      : `Question: ${question}`;

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
      let response = await getResponse(config, prompt);
      if (response.startsWith('```')) {
        response = response
          .replace(/^```[a-z]*\n?/, '')
          .replace(/\n?```$/, '')
          .trim();
      }
      console.log(response);
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
      const workspaceStructure = await getWorkspaceStructure(workDir);
      let completedActions = 0;
      let roundCount = 0;

      const systemPrompt = `You are ASKII, an AI agent that can create, modify, view, and delete files in a workspace.

Current workspace structure:
\`\`\`
${workspaceStructure}
\`\`\`

You have access to the following action types:
- {"type": "view", "path": "path/to/file"} - View file contents
- {"type": "create", "path": "path/to/file", "content": "file content"}
- {"type": "modify", "path": "path/to/file", "oldContent": "text to replace", "newContent": "replacement text"}
- {"type": "delete", "path": "path/to/file"}

Always respond with ONLY a valid JSON array containing the actions. You can request to view files to inspect them, and their contents will be sent back to you.`;

      let userMessage = task;

      while (roundCount < config.maxRounds) {
        const fullPrompt =
          roundCount === 0
            ? `${systemPrompt}\n\nUser request: ${userMessage}`
            : `${systemPrompt}\n\n${userMessage}`;

        const responseText = await getResponse(config, fullPrompt);
        const actions = parseWorkspaceActions(responseText);

        if (actions.length === 0) break;

        const viewActions = actions.filter((a) => a.type === 'view');
        const otherActions = actions.filter((a) => a.type !== 'view');

        const viewResults: Record<string, string> = {};
        for (const action of viewActions) {
          const filePath = path.join(workDir, action.path);
          try {
            viewResults[action.path] = fs.readFileSync(filePath, 'utf-8');
          } catch {
            viewResults[action.path] = 'Error: Cannot read file';
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
          }
        }

        if (Object.keys(viewResults).length > 0) {
          userMessage = `File contents retrieved:\n${JSON.stringify(viewResults, null, 2)}\n\nBased on these files, what would you like to do next? Respond with only a JSON array of actions or an empty array [] if done.`;
          roundCount++;
        } else {
          break;
        }
      }

      rl.close();
      console.error(`\nCompleted ${completedActions} actions! ${getRandomKaomoji()}`);
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
