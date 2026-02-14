/**
 * ASKII - AI Code Assistant with Style
 *
 * An AI-powered VS Code extension that provides inline code explanations with kaomoji (｡◕‿◕｡)
 * Supports Ollama, GitHub Copilot, and LM Studio for AI-powered insights.
 *
 * Features:
 * - Inline decorations with kaomoji and AI explanations
 * - GitLens-style hover tooltips for full message display
 * - Configurable AI providers (Ollama, GitHub Copilot, LM Studio)
 * - Smart caching to minimize API calls
 * - Debounced requests for optimal performance
 * - Three command modes: Ask, Edit, Do
 * - Status bar button for quick access
 */

import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import { LMStudioClient } from '@lmstudio/sdk';
import * as fs from 'fs';
import * as path from 'path';

// Array of kaomoji to randomly select from
const kaomojis = [
  '(◕‿◕)',
  'ヽ(´▽`)/',
  '(｡◕‿◕｡)',
  '(づ｡◕‿‿◕｡)づ',
  'ʕ•ᴥ•ʔ',
  '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧',
  '(◕ᴗ◕✿)',
  '(｡♥‿♥｡)',
  '♪(┌・。・)┌',
  '(ﾉ´ヮ`)ﾉ*: ･ﾟ',
  '(￣▽￣)ノ',
  '(◠‿◠)',
  '(•‿•)',
  '╰(*°▽°*)╯',
  '(≧◡≦)',
  '(☞ﾟヮﾟ)☞',
  '(づ￣ ³￣)づ',
  'ヾ(⌐■_■)ノ♪',
  '(ง •̀_•́)ง',
  '(╯°□°）╯︵ ┻━┻',
  '┬─┬ ノ( ゜-゜ノ)',
  '( •_•)>⌐■-■',
  '(⌐■_■)',
  '¯\\_(ツ)_/¯',
  '( ͡° ͜ʖ ͡°)',
  'ಠ_ಠ',
];

// Thinking kaomojis shown while waiting for response
const thinkingKaomojis = ['(๑•﹏•)', '(・_・ヾ', '( ˘ω˘ )', '(´-ω-`)', '( ´ ▽ ` )'];

// Decoration type for the inline annotations
let decorationType: vscode.TextEditorDecorationType;
let statusBarItem: vscode.StatusBarItem;

// Cache for line explanations to avoid redundant API calls
const explanationCache = new Map<string, { kaomoji: string; explanation: string }>();

// Debounce timer and abort controller for cancelling requests
let debounceTimer: NodeJS.Timeout | undefined;
let thinkingTimer: NodeJS.Timeout | undefined;
let currentAbortController: AbortController | undefined;

// Function to get a random kaomoji
function getRandomKaomoji(): string {
  return kaomojis[Math.floor(Math.random() * kaomojis.length)];
}

// Function to get a random thinking kaomoji
function getRandomThinkingKaomoji(): string {
  return thinkingKaomojis[Math.floor(Math.random() * thinkingKaomojis.length)];
}

// Get LLM explanation based on current platform setting
async function getLLMExplanation(lineText: string, abortSignal?: AbortSignal): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'ollama';
  const mode = config.get<string>('inlineHelperMode') || 'funny';

  // If mode is off, return empty
  if (mode === 'off') {
    return '';
  }

  const isHelpful = mode === 'helpful';

  try {
    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    if (platform === 'copilot') {
      return await getCopilotExplanation(lineText, isHelpful, abortSignal);
    } else if (platform === 'lmstudio') {
      return await getLMStudioExplanation(lineText, isHelpful, abortSignal);
    } else {
      // Default to ollama
      return await getOllamaExplanation(lineText, isHelpful, abortSignal);
    }
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return `Error: ${errorMessage}`;
  }
}

// Function to call GitHub Copilot Language Model API
async function getCopilotExplanation(
  lineText: string,
  isHelpful: boolean,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const copilotModel = config.get<string>('copilotModel') || 'gpt-4o';

  try {
    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: copilotModel,
    });

    if (models.length === 0) {
      return 'Error: GitHub Copilot not available';
    }

    const model = models[0];

    const systemPrompt = isHelpful
      ? 'You are ASKII, a helpful coding assistant. Provide clear, concise explanations.'
      : 'You are ASKII, a witty coding assistant. Provide humorous comments.';

    const userPrompt = isHelpful
      ? `Explain this code in one sentence: ${lineText}`
      : `Make a funny comment about this code in one sentence: ${lineText}`;

    const messages = [
      vscode.LanguageModelChatMessage.User(systemPrompt),
      vscode.LanguageModelChatMessage.User(userPrompt),
    ];

    const chatResponse = await model.sendRequest(
      messages,
      {},
      new vscode.CancellationTokenSource().token,
    );

    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    let responseText = '';
    for await (const fragment of chatResponse.text) {
      responseText += fragment;
    }

    return responseText || 'No explanation available.';
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return `Error: ${errorMessage}`;
  }
}

// Function to call Ollama API
async function getOllamaExplanation(
  lineText: string,
  isHelpful: boolean,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const llmUrl = config.get<string>('llmUrl') || 'http://localhost:11434';
  const ollamaModel = config.get<string>('ollamaModel') || 'gemma3:270m';

  try {
    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    const ollama = new Ollama({ host: llmUrl });

    const systemPrompt = isHelpful
      ? 'You are ASKII, a helpful coding assistant. Provide clear, concise explanations.'
      : 'You are ASKII, a witty coding assistant. Provide humorous comments.';

    const userPrompt = isHelpful
      ? `Explain this code in one sentence: ${lineText}`
      : `Make a funny comment about this code in one sentence: ${lineText}`;

    const response = await ollama.generate({
      model: ollamaModel,
      system: systemPrompt,
      prompt: userPrompt,
      stream: false,
    });

    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    return response.response || 'No explanation available.';
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return `Error: ${errorMessage}`;
  }
}

// Function to call LM Studio API
async function getLMStudioExplanation(
  lineText: string,
  isHelpful: boolean,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const lmStudioModel = config.get<string>('lmStudioModel') || 'qwen/qwen3-coder-30b';
  const llmUrl = config.get<string>('llmUrl') || 'http://localhost:1234';

  try {
    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    const systemPrompt = isHelpful
      ? 'You are ASKII, a helpful coding assistant. Provide clear, concise explanations.'
      : 'You are ASKII, a witty coding assistant. Provide humorous comments.';

    const userPrompt = isHelpful
      ? `Explain this code in one sentence: ${lineText}`
      : `Make a funny comment about this code in one sentence: ${lineText}`;

    const client = new LMStudioClient({
      baseUrl: llmUrl,
    });
    const model = await client.llm.model(lmStudioModel);
    const result = await model.respond([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    if (abortSignal?.aborted) {
      throw new Error('Request cancelled');
    }

    return result.content || 'No explanation available.';
  } catch (error) {
    if (abortSignal?.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return `Error: ${errorMessage}`;
  }
}

// Function to update decorations for the current line
async function updateDecorations(editor: vscode.TextEditor | undefined) {
  if (!editor) {
    return;
  }

  const mode =
    vscode.workspace.getConfiguration('askii').get<string>('inlineHelperMode') || 'funny';
  if (mode === 'off') {
    editor.setDecorations(decorationType, []);
    return;
  }

  const position = editor.selection.active;
  const currentLine = editor.document.lineAt(position.line);
  const lineText = currentLine.text.trim();

  editor.setDecorations(decorationType, []);

  if (!lineText || lineText.length <= 3) {
    return;
  }

  const cacheKey = `${editor.document.uri.toString()}:${position.line}:${lineText}`;

  if (explanationCache.has(cacheKey)) {
    const cached = explanationCache.get(cacheKey)!;
    showDecoration(editor, position.line, cached.kaomoji, cached.explanation);
    return;
  }

  if (currentAbortController) {
    currentAbortController.abort();
  }

  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  if (thinkingTimer) {
    clearTimeout(thinkingTimer);
  }

  const abortController = new AbortController();
  currentAbortController = abortController;

  thinkingTimer = setTimeout(() => {
    const thinkingKaomoji = getRandomThinkingKaomoji();
    showDecoration(editor, position.line, thinkingKaomoji, 'thinking...');
  }, 300);

  debounceTimer = setTimeout(async () => {
    try {
      const kaomoji = getRandomKaomoji();
      const explanation = await getLLMExplanation(lineText, abortController.signal);

      if (!abortController.signal.aborted) {
        explanationCache.set(cacheKey, { kaomoji, explanation });
        showDecoration(editor, position.line, kaomoji, explanation);
      }
    } catch (error) {
      if (error instanceof Error && error.message !== 'Request cancelled') {
        console.error('Error getting explanation:', error);
      }
    }
  }, 1000);
}

// Helper function to show decoration
function showDecoration(
  editor: vscode.TextEditor,
  lineNumber: number,
  kaomoji: string,
  text: string,
) {
  const currentLine = editor.document.lineAt(lineNumber);
  const lineLength = currentLine.text.length;
  const range = new vscode.Range(
    new vscode.Position(lineNumber, lineLength),
    new vscode.Position(lineNumber, lineLength),
  );

  const maxLength = 100;
  const isTruncated = text.length > maxLength;
  const displayText = isTruncated ? text.substring(0, maxLength) + '...' : text;
  const isThinking = text === 'thinking...';

  const decoration: any = {
    range: range,
    renderOptions: {
      after: {
        contentText: ` ${kaomoji} ${displayText}`,
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        fontStyle: 'italic',
      },
    },
  };

  if (isTruncated && !isThinking) {
    decoration.hoverMessage = new vscode.MarkdownString(`${kaomoji} **ASKII Says:**\n\n${text}`);
  }

  editor.setDecorations(decorationType, [decoration]);
}

// Hover provider to show full explanation
class AskiiHoverProvider implements vscode.HoverProvider {
  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Hover> {
    const line = position.line;
    const lineText = document.lineAt(line).text.trim();

    if (!lineText) {
      return null;
    }

    const cacheKey = `${document.uri.toString()}:${line}:${lineText}`;
    if (explanationCache.has(cacheKey)) {
      const cached = explanationCache.get(cacheKey)!;
      const maxLength = 100;

      if (cached.explanation.length > maxLength && cached.explanation !== 'thinking...') {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown(`${cached.kaomoji} **ASKII Says:**\n\n`);
        markdown.appendText(cached.explanation);
        markdown.isTrusted = true;

        return new vscode.Hover(markdown);
      }
    }

    return null;
  }
}

// Ask ASKII command - sends selected text + question to LLM
async function askAskiiCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor');
    return;
  }

  const selectedText = editor.document.getText(editor.selection);
  if (!selectedText) {
    vscode.window.showErrorMessage('No text selected');
    return;
  }

  const question = await vscode.window.showInputBox({
    prompt: 'Ask ASKII a question about the selected code',
    placeHolder: 'What does this code do?',
  });

  if (!question) {
    return;
  }

  // Create output panel
  const panel = vscode.window.createWebviewPanel(
    'askiiOutput',
    'ASKII Response',
    vscode.ViewColumn.Beside,
    {},
  );

  panel.webview.html = `
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          .response { white-space: pre-wrap; word-wrap: break-word; }
        </style>
      </head>
      <body>
        <h2>ASKII is thinking... (๑•﹏•)</h2>
        <div id="response" class="response"></div>
      </body>
    </html>
  `;

  // Get LLM response
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'ollama';

  try {
    let responseText = '';
    const prompt = `Code:\n\`\`\`\n${selectedText}\n\`\`\`\n\nQuestion: ${question}`;

    if (platform === 'copilot') {
      responseText = await getCopilotResponse(prompt);
    } else if (platform === 'lmstudio') {
      responseText = await getLMStudioResponse(prompt);
    } else {
      responseText = await getOllamaResponse(prompt);
    }

    // Update panel with response
    panel.webview.html = `
      <html>
        <head>
          <style>
            body { font-family: Arial, sans-serif; padding: 20px; line-height: 1.6; }
            .response { white-space: pre-wrap; word-wrap: break-word; }
            h2 { color: #333; }
          </style>
        </head>
        <body>
          <h2>ASKII Says: (⌐■_■)</h2>
          <div id="response" class="response">${escapeHtml(responseText)}</div>
        </body>
      </html>
    `;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    panel.webview.html = `
      <html>
        <body>
          <h2>Error</h2>
          <p>${escapeHtml(errorMsg)}</p>
        </body>
      </html>
    `;
  }
}

// ASKII Edit command - replaces selected text with LLM response
async function askiiEditCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor');
    return;
  }

  const selectedText = editor.document.getText(editor.selection);
  if (!selectedText) {
    vscode.window.showErrorMessage('No text selected');
    return;
  }

  const question = await vscode.window.showInputBox({
    prompt: 'What changes would you like to make?',
    placeHolder: 'e.g., Add error handling, optimize for performance',
  });

  if (!question) {
    return;
  }

  vscode.window.showInformationMessage('ASKII is editing... (•_•)>⌐■-■');

  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'ollama';

  try {
    const prompt = `Update this code:\n\`\`\`\n${selectedText}\n\`\`\`\n\nRequest: ${question}\n\nReturn only the updated code without explanation.`;

    let responseText = '';

    if (platform === 'copilot') {
      responseText = await getCopilotResponse(prompt);
    } else if (platform === 'lmstudio') {
      responseText = await getLMStudioResponse(prompt);
    } else {
      responseText = await getOllamaResponse(prompt);
    }

    // Extract code from response (handle markdown code blocks)
    let code = responseText.trim();
    if (code.startsWith('```')) {
      code = code
        .replace(/^```[a-z]*\n?/, '')
        .replace(/\n?```$/, '')
        .trim();
    }

    // Replace selected text
    await editor.edit((editBuilder: vscode.TextEditorEdit) => {
      editBuilder.replace(editor.selection, code);
    });

    vscode.window.showInformationMessage('Code updated! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    vscode.window.showErrorMessage(`ASKII Edit failed: ${errorMsg}`);
  }
}

// ASKII Do command - performs actions on workspace
async function askiiDoCommand() {
  const question = await vscode.window.showInputBox({
    prompt: 'What would you like ASKII to do?',
    placeHolder: 'e.g., Create a test file, refactor common patterns',
  });

  if (!question) {
    return;
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace found');
    return;
  }

  vscode.window.showInformationMessage('ASKII is working... (๑•﹏•)');

  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'ollama';

  try {
    // Get workspace structure
    const workspaceStructure = await getWorkspaceStructure(workspaceRoot.uri.fsPath);

    const prompt = `You are ASKII, an AI agent that can create, modify, or view files in a workspace.

Current workspace structure:
\`\`\`
${workspaceStructure}
\`\`\`

User request: ${question}

For each action you want to perform, use these commands:
- VIEW: view|path/to/file
- CREATE: create|path/to/file|content
- MODIFY: modify|path/to/file|old_content|new_content
- DELETE: delete|path/to/file

Respond with the actions separated by newlines.`;

    let responseText = '';

    if (platform === 'copilot') {
      responseText = await getCopilotResponse(prompt);
    } else if (platform === 'lmstudio') {
      responseText = await getLMStudioResponse(prompt);
    } else {
      responseText = await getOllamaResponse(prompt);
    }

    // Parse and execute actions
    const lines = responseText.split('\n');
    const actions = lines.filter((line) => line.match(/^(VIEW|CREATE|MODIFY|DELETE)\|/));

    let completedActions = 0;

    for (const action of actions) {
      const [cmd, ...args] = action.split('|');
      const filePath = path.join(workspaceRoot.uri.fsPath, args[0]);

      if (cmd === 'VIEW') {
        // No confirmation for VIEW
        const content = fs.readFileSync(filePath, 'utf-8');
        const document = await vscode.workspace.openTextDocument(filePath);
        vscode.window.showTextDocument(document);
        completedActions++;
      } else if (cmd === 'CREATE' && args[1]) {
        // Confirm CREATE
        const confirmed = await vscode.window.showWarningMessage(
          `Create file: ${args[0]}?`,
          { modal: true },
          'Create',
          'Skip',
        );
        if (confirmed === 'Create') {
          const dir = path.dirname(filePath);
          if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
          }
          fs.writeFileSync(filePath, args[1]);
          const document = await vscode.workspace.openTextDocument(filePath);
          vscode.window.showTextDocument(document);
          completedActions++;
        }
      } else if (cmd === 'MODIFY' && args.length >= 3) {
        // Confirm MODIFY
        const confirmed = await vscode.window.showWarningMessage(
          `Modify file: ${args[0]}?`,
          { modal: true },
          'Modify',
          'Skip',
        );
        if (confirmed === 'Modify') {
          const oldContent = args[1];
          const newContent = args[2];
          const content = fs.readFileSync(filePath, 'utf-8');
          const updated = content.replace(oldContent, newContent);
          fs.writeFileSync(filePath, updated);
          completedActions++;
        }
      } else if (cmd === 'DELETE') {
        // Confirm DELETE with stronger warning
        const confirmed = await vscode.window.showErrorMessage(
          `Delete file: ${args[0]}? This cannot be undone.`,
          { modal: true },
          'Delete',
          'Cancel',
        );
        if (confirmed === 'Delete') {
          fs.unlinkSync(filePath);
          completedActions++;
        }
      }
    }

    vscode.window.showInformationMessage(`Completed ${completedActions} actions! (⌐■_■)`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    vscode.window.showErrorMessage(`ASKII Do failed: ${errorMsg}`);
  }
}

// Helper function to get workspace structure
async function getWorkspaceStructure(dirPath: string, prefix = ''): Promise<string> {
  let structure = '';
  try {
    const files = fs.readdirSync(dirPath);
    const filtered = files.filter(
      (f: string) => !f.startsWith('.') && f !== 'node_modules' && f !== 'dist',
    );

    for (const file of filtered.slice(0, 50)) {
      const filePath = path.join(dirPath, file);
      const stat = fs.statSync(filePath);
      structure += `${prefix}${file}${stat.isDirectory() ? '/' : ''}\n`;

      if (stat.isDirectory() && prefix.length < 6) {
        structure += await getWorkspaceStructure(filePath, prefix + '  ');
      }
    }
  } catch (_) {
    // Ignore errors
  }

  return structure;
}

// Helper functions for LLM responses
async function getOllamaResponse(prompt: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const llmUrl = config.get<string>('llmUrl') || 'http://localhost:11434';
  const ollamaModel = config.get<string>('ollamaModel') || 'gemma3:270m';

  const ollama = new Ollama({ host: llmUrl });
  const response = await ollama.generate({
    model: ollamaModel,
    prompt: prompt,
    stream: false,
  });

  return response.response || 'No response';
}

async function getCopilotResponse(prompt: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const copilotModel = config.get<string>('copilotModel') || 'gpt-4o';

  const models = await vscode.lm.selectChatModels({
    vendor: 'copilot',
    family: copilotModel,
  });

  if (models.length === 0) {
    throw new Error('GitHub Copilot not available');
  }

  const model = models[0];
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];

  const chatResponse = await model.sendRequest(
    messages,
    {},
    new vscode.CancellationTokenSource().token,
  );

  let responseText = '';
  for await (const fragment of chatResponse.text) {
    responseText += fragment;
  }

  return responseText;
}

async function getLMStudioResponse(prompt: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const lmStudioModel = config.get<string>('lmStudioModel') || 'qwen/qwen3-coder-30b';
  const llmUrl = config.get<string>('llmUrl') || 'http://localhost:1234';

  try {
    const client = new LMStudioClient({
      baseUrl: llmUrl,
    });
    const model = await client.llm.model(lmStudioModel);
    const result = await model.respond(prompt);
    return result.content || 'No response';
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`LM Studio error: ${errorMessage}`);
  }
}

// Helper function to escape HTML
function escapeHtml(text: string): string {
  const map: { [key: string]: string } = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  };
  return text.replace(/[&<>"']/g, (c) => map[c]);
}

// Activation function
export function activate(context: vscode.ExtensionContext) {
  console.log('ASKII extension is now active!');

  decorationType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    after: {
      margin: '0 0 0 2em',
    },
  });

  // Hover provider
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { scheme: '*', language: '*' },
      new AskiiHoverProvider(),
    ),
  );

  // Clear cache command
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.clearCache', () => {
      explanationCache.clear();
      vscode.window.showInformationMessage('ASKII cache cleared! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧');
      if (vscode.window.activeTextEditor) {
        updateDecorations(vscode.window.activeTextEditor);
      }
    }),
  );

  // Ask ASKII command
  context.subscriptions.push(vscode.commands.registerCommand('askii.askQuestion', askAskiiCommand));

  // ASKII Edit command
  context.subscriptions.push(vscode.commands.registerCommand('askii.editCode', askiiEditCommand));

  // ASKII Do command
  context.subscriptions.push(vscode.commands.registerCommand('askii.doTask', askiiDoCommand));

  // Status bar item
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = '(⌐■_■)';
  statusBarItem.tooltip = 'Click for ASKII commands';
  statusBarItem.command = 'askii.showCommandMenu';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Command menu for status bar
  context.subscriptions.push(
    vscode.commands.registerCommand('askii.showCommandMenu', async () => {
      const selected = await vscode.window.showQuickPick([
        { label: '$(comment) Ask ASKII', command: 'askii.askQuestion' },
        { label: '$(edit) ASKII Edit', command: 'askii.editCode' },
        { label: '$(files) ASKII Do', command: 'askii.doTask' },
        { label: '$(refresh) Clear Cache', command: 'askii.clearCache' },
      ]);

      if (selected) {
        vscode.commands.executeCommand(selected.command);
      }
    }),
  );

  // Text editor events
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(
      async (event: vscode.TextEditorSelectionChangeEvent) => {
        await updateDecorations(event.textEditor);
      },
    ),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(async (editor: vscode.TextEditor | undefined) => {
      await updateDecorations(editor);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
      if (event.document === vscode.window.activeTextEditor?.document) {
        const uri = event.document.uri.toString();
        for (const key of explanationCache.keys()) {
          if (key.startsWith(uri)) {
            explanationCache.delete(key);
          }
        }
      }
    }),
  );

  if (vscode.window.activeTextEditor) {
    updateDecorations(vscode.window.activeTextEditor);
  }

  context.subscriptions.push(decorationType);
}

export function deactivate() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  if (thinkingTimer) {
    clearTimeout(thinkingTimer);
  }
  if (currentAbortController) {
    currentAbortController.abort();
  }
  explanationCache.clear();
}
