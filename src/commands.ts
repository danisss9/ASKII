import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import {
  getExtensionResponse,
  getExtensionResponseStreaming,
  getExtensionResponseWithImage,
  getLLMExplanation,
} from './providers';
import { getWorkspaceStructure, parseWorkspaceActions } from '@common/workspace';
import { escapeHtml, escapeJsonString, unescapeJsonString, extractCode } from '@common/utils';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import {
  buildControlSystemPrompt,
  parseControlAction,
  takeScreenshot,
  describeAction,
  executeControlAction,
} from '@common/control';

export async function askAskiiCommand() {
  const editor = vscode.window.activeTextEditor;
  const selectedText = editor ? editor.document.getText(editor.selection) : '';
  const languageId = editor?.document.languageId ?? '';
  const fileName = editor ? path.basename(editor.document.fileName) : '';

  const hasSelection = selectedText.length > 0;

  const question = await vscode.window.showInputBox({
    prompt: hasSelection ? 'Ask ASKII a question about the selected code' : 'Ask ASKII anything',
    placeHolder: hasSelection
      ? 'What does this code do?'
      : 'e.g., How do I reverse a string in Python?',
  });

  if (!question) {
    return;
  }

  const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

  const css = `
    body {
      font-family: var(--vscode-font-family, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px 28px;
      line-height: 1.7;
      max-width: 860px;
    }
    h1,h2,h3,h4 { color: var(--vscode-foreground); margin-top: 1.2em; }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--vscode-textCodeBlock-background, #1e1e1e);
      border-radius: 3px;
      padding: 1px 5px;
      font-size: 0.92em;
    }
    pre {
      background: var(--vscode-textCodeBlock-background, #1e1e1e);
      border-radius: 5px;
      padding: 12px 16px;
      overflow-x: auto;
    }
    pre code { background: none; padding: 0; }
    blockquote {
      border-left: 3px solid var(--vscode-activityBarBadge-background, #007acc);
      margin: 0; padding-left: 12px; opacity: 0.85;
    }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid var(--vscode-editorWidget-border, #555); padding: 6px 10px; }
    th { background: var(--vscode-textCodeBlock-background); }
    a { color: var(--vscode-textLink-foreground, #4daafc); }
    hr { border: none; border-top: 1px solid var(--vscode-editorWidget-border, #555); }
    .thinking { opacity: 0.6; font-style: italic; }
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.6em;
    }
    .header-row h2 { margin: 0; opacity: 0.85; font-size: 1em; font-weight: 600; }
    .btn-group { display: flex; gap: 2px; align-items: center; }
    .icon-btn {
      display: none;
      align-items: center;
      justify-content: center;
      background: none;
      border: none;
      cursor: pointer;
      padding: 4px;
      color: var(--vscode-foreground);
      opacity: 0.55;
      border-radius: 4px;
      transition: opacity 0.15s;
    }
    .icon-btn:hover { opacity: 1; }
    #copyBtn.copied { opacity: 1; color: var(--vscode-terminal-ansiGreen, #4ec9b0); }
  `;

  const panelHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>${css}</style></head>
<body>
  <div class="header-row">
    <h2 id="title">ASKII is thinking... (๑•﹏•)</h2>
    <div class="btn-group">
      <button id="followUpBtn" class="icon-btn" title="Ask a follow-up" onclick="sendFollowUp()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
      </button>
      <button id="copyBtn" class="icon-btn" title="Copy response" onclick="copyResponse()">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
      </button>
    </div>
  </div>
  <div id="content"><p class="thinking">Waiting for response...</p></div>
  <script>
    const vscode = acquireVsCodeApi();
    let rawText = '';
    function showBtns(visible) {
      const d = visible ? 'inline-flex' : 'none';
      document.getElementById('copyBtn').style.display = d;
      document.getElementById('followUpBtn').style.display = d;
    }
    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'update') {
        document.getElementById('content').innerHTML = msg.html;
      } else if (msg.type === 'done') {
        rawText = msg.text;
        document.getElementById('content').innerHTML = msg.html;
        document.getElementById('title').textContent = 'ASKII Says: (⌐■_■)';
        showBtns(true);
      } else if (msg.type === 'thinking') {
        showBtns(false);
        document.getElementById('title').textContent = 'ASKII is thinking... (๑•﹏•)';
        document.getElementById('content').innerHTML = '<p class="thinking">Waiting for response...</p>';
      } else if (msg.type === 'error') {
        document.getElementById('title').textContent = 'Error';
        document.getElementById('content').innerHTML = msg.html;
        showBtns(false);
      }
    });
    function sendFollowUp() {
      showBtns(false);
      vscode.postMessage({ type: 'followup' });
    }
    function copyResponse() {
      navigator.clipboard.writeText(rawText).then(() => {
        const btn = document.getElementById('copyBtn');
        btn.classList.add('copied');
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
        }, 1500);
      });
    }
  </script>
</body>
</html>`;

  const panel = vscode.window.createWebviewPanel(
    'askiiOutput',
    'ASKII Response',
    vscode.ViewColumn.Beside,
    { enableScripts: true },
  );

  panel.webview.html = panelHtml;

  const codeContext = hasSelection
    ? `File: ${fileName}\nLanguage: ${languageId}\nCode:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n`
    : '';
  let history = '';
  let currentQuestion = question;
  let panelDisposed = false;
  panel.onDidDispose(() => {
    panelDisposed = true;
  });

  while (!panelDisposed) {
    const fullPrompt = codeContext + history + `Question: ${currentQuestion}`;
    let accumulated = '';

    try {
      await getExtensionResponseStreaming(fullPrompt, (chunk) => {
        accumulated += chunk;
        panel.webview.postMessage({ type: 'update', html: md.render(accumulated) });
      });

      history += `Question: ${currentQuestion}\n\nAnswer: ${accumulated}\n\n`;
      panel.webview.postMessage({ type: 'done', html: md.render(accumulated), text: accumulated });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      panel.webview.postMessage({ type: 'error', html: `<p>${escapeHtml(errorMsg)}</p>` });
      break;
    }

    // Wait for a follow-up request or panel close
    const nextQuestion = await new Promise<string | null>((resolve) => {
      const msgDisp = panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'followup') {
          msgDisp.dispose();
          dispDisp.dispose();
          const q = await vscode.window.showInputBox({
            prompt: 'Ask a follow-up question',
            placeHolder: 'What else would you like to know?',
          });
          resolve(q || null);
        }
      });
      const dispDisp = panel.onDidDispose(() => {
        msgDisp.dispose();
        resolve(null);
      });
    });

    if (nextQuestion === null) {
      break;
    }
    currentQuestion = nextQuestion;
    panel.webview.postMessage({ type: 'thinking' });
  }
}

export async function askiiEditCommand() {
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

  const editConfig = vscode.workspace.getConfiguration('askii');
  const formatAfterEdit = editConfig.get<boolean>('formatAfterEdit') ?? false;

  try {
    const prompt = `Update this code:\n\`\`\`\n${selectedText}\n\`\`\`\n\nRequest: ${question}\n\nReturn only the updated code without explanation.`;
    const responseText = await getExtensionResponse(prompt);
    const code = extractCode(responseText);

    await editor.edit((editBuilder: vscode.TextEditorEdit) => {
      editBuilder.replace(editor.selection, code);
    });

    if (formatAfterEdit) {
      await vscode.commands.executeCommand('editor.action.formatDocument');
    }

    vscode.window.showInformationMessage('Code updated! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    vscode.window.showErrorMessage(`ASKII Edit failed: ${errorMsg}`);
  }
}

export async function askiiDoCommand() {
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
  const maxRounds = config.get<number>('doMaxRounds') || 5;
  const autoConfirm = config.get<boolean>('doAutoConfirm') ?? false;
  const formatAfterEdit = config.get<boolean>('formatAfterEdit') ?? false;

  try {
    const workspaceStructure = getWorkspaceStructure(workspaceRoot.uri.fsPath);
    let completedActions = 0;
    let roundCount = 0;

    const systemPrompt = `You are ASKII, an AI agent that can create, modify, view, delete, rename, and list files in a workspace.

Current workspace structure:
\`\`\`
${workspaceStructure}
\`\`\`

You have access to the following action types:
- {"type": "view", "path": "path/to/file"} - View file contents, responses will be sent back to you
- {"type": "list", "path": "path/to/folder"} - List files in a folder, results will be sent back to you
- {"type": "create", "path": "path/to/file", "content": "file content"}
- {"type": "modify", "path": "path/to/file", "oldContent": "text to replace", "newContent": "replacement text"}
- {"type": "rename", "path": "old/path", "newPath": "new/path"} - Rename or move a file
- {"type": "delete", "path": "path/to/file"}

Always respond with ONLY a valid JSON array containing the actions. You can request to view files or list folders to inspect them, and their contents will be sent back to you for further analysis.`;

    let userMessage = question;

    while (roundCount < maxRounds) {
      const fullPrompt =
        roundCount === 0
          ? `${systemPrompt}\n\nUser request: ${userMessage}`
          : `${systemPrompt}\n\n${userMessage}`;

      const responseText = await getExtensionResponse(fullPrompt);
      const actions = parseWorkspaceActions(responseText);

      if (actions.length === 0) {
        break;
      }

      const viewActions = actions.filter((a) => a.type === 'view' || a.type === 'list');
      const otherActions = actions.filter((a) => a.type !== 'view' && a.type !== 'list');

      const viewResults: { [key: string]: string } = {};
      for (const action of viewActions) {
        const filePath = path.join(workspaceRoot.uri.fsPath, action.path);
        try {
          if (action.type === 'list') {
            const entries = fs.readdirSync(filePath).map((name) => {
              const stat = fs.statSync(path.join(filePath, name));
              return `${name} [${stat.isDirectory() ? 'folder' : 'file'}]`;
            });
            viewResults[action.path] = entries.join('\n');
          } else {
            viewResults[action.path] = escapeJsonString(fs.readFileSync(filePath, 'utf-8'));
          }
        } catch {
          viewResults[action.path] = `Error: Cannot read path`;
        }
      }

      for (const action of otherActions) {
        const filePath = path.join(workspaceRoot.uri.fsPath, action.path);

        if (action.type === 'create') {
          const confirmed =
            autoConfirm ||
            (await vscode.window.showInformationMessage(
              `Create file: ${action.path}?`,
              { modal: false },
              'Create',
              'Skip',
            )) === 'Create';
          if (confirmed) {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            const unescapedContent = action.content ? unescapeJsonString(action.content) : '';
            fs.writeFileSync(filePath, unescapedContent);
            completedActions++;
            vscode.window.showInformationMessage(`✓ Created: ${action.path}`);
            if (formatAfterEdit) {
              const uri = vscode.Uri.file(filePath);
              const doc = await vscode.workspace.openTextDocument(uri);
              const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
                'vscode.executeFormatDocumentProvider',
                doc.uri,
                { tabSize: 2, insertSpaces: true },
              );
              if (edits && edits.length > 0) {
                const workspaceEdit = new vscode.WorkspaceEdit();
                workspaceEdit.set(doc.uri, edits);
                await vscode.workspace.applyEdit(workspaceEdit);
                await doc.save();
              }
            }
          }
        } else if (action.type === 'modify') {
          const confirmed =
            autoConfirm ||
            (await vscode.window.showInformationMessage(
              `Modify file: ${action.path}?`,
              { modal: false },
              'Modify',
              'Skip',
            )) === 'Modify';
          if (confirmed) {
            try {
              const content = fs.readFileSync(filePath, 'utf-8');
              const oldContent = action.oldContent ? unescapeJsonString(action.oldContent) : '';
              const newContent = action.newContent ? unescapeJsonString(action.newContent) : '';
              const updated = content.replace(oldContent, newContent);
              fs.writeFileSync(filePath, updated);
              completedActions++;
              vscode.window.showInformationMessage(`✓ Modified: ${action.path}`);
              if (formatAfterEdit) {
                const uri = vscode.Uri.file(filePath);
                const doc = await vscode.workspace.openTextDocument(uri);
                const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
                  'vscode.executeFormatDocumentProvider',
                  doc.uri,
                  { tabSize: 2, insertSpaces: true },
                );
                if (edits && edits.length > 0) {
                  const workspaceEdit = new vscode.WorkspaceEdit();
                  workspaceEdit.set(doc.uri, edits);
                  await vscode.workspace.applyEdit(workspaceEdit);
                  await doc.save();
                }
              }
            } catch {
              vscode.window.showErrorMessage(`Cannot modify file: ${action.path}`);
            }
          }
        } else if (action.type === 'delete') {
          const confirmed =
            autoConfirm ||
            (await vscode.window.showWarningMessage(
              `Delete file: ${action.path}? This cannot be undone.`,
              { modal: false },
              'Delete',
              'Cancel',
            )) === 'Delete';
          if (confirmed) {
            try {
              fs.unlinkSync(filePath);
              completedActions++;
              vscode.window.showInformationMessage(`✓ Deleted: ${action.path}`);
            } catch {
              vscode.window.showErrorMessage(`Cannot delete file: ${action.path}`);
            }
          }
        } else if (action.type === 'rename') {
          const newFilePath = action.newPath
            ? path.join(workspaceRoot.uri.fsPath, action.newPath)
            : null;
          if (!newFilePath) {
            vscode.window.showErrorMessage(`Rename missing newPath: ${action.path}`);
          } else {
            const confirmed =
              autoConfirm ||
              (await vscode.window.showInformationMessage(
                `Rename: ${action.path} → ${action.newPath}?`,
                { modal: false },
                'Rename',
                'Skip',
              )) === 'Rename';
            if (confirmed) {
              try {
                const newDir = path.dirname(newFilePath);
                if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
                fs.renameSync(filePath, newFilePath);
                completedActions++;
                vscode.window.showInformationMessage(
                  `✓ Renamed: ${action.path} → ${action.newPath}`,
                );
              } catch {
                vscode.window.showErrorMessage(`Cannot rename: ${action.path}`);
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

    vscode.window.showInformationMessage(`Completed ${completedActions} actions! (⌐■_■)`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    vscode.window.showErrorMessage(`ASKII Do failed: ${errorMsg}`);
  }
}

export async function askiiControlCommand() {
  const instruction = await vscode.window.showInputBox({
    prompt: 'Give ASKII a screen control instruction',
    placeHolder: 'e.g., Open Notepad and type hello world',
  });

  if (!instruction) return;

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = config.get<number>('doMaxRounds') ?? 5;
  const autoConfirm = config.get<boolean>('doAutoConfirm') ?? false;

  const outputChannel = vscode.window.createOutputChannel('ASKII Control');
  outputChannel.show(true);
  outputChannel.appendLine(`ASKII Control started ${getRandomThinkingKaomoji()}`);
  outputChannel.appendLine(`Instruction: ${instruction}`);
  outputChannel.appendLine('');

  let round = 0;

  try {
    while (round < maxRounds) {
      outputChannel.appendLine(`Round ${round + 1}/${maxRounds} — taking screenshot...`);

      const { base64: imageBase64, width: screenW, height: screenH } = await takeScreenshot();

      const prompt =
        round === 0
          ? `Instruction to complete: ${instruction}\n\nAnalyze the screenshot and determine the next action.`
          : `Continuing instruction: ${instruction}\n\nAnalyze the updated screenshot and determine the next action, or return DONE if the instruction is complete.`;

      outputChannel.appendLine('Asking AI...');
      const response = await getExtensionResponseWithImage(
        `${buildControlSystemPrompt(screenW, screenH)}\n\n${prompt}`,
        imageBase64,
      );

      const action = parseControlAction(response);

      if (!action) {
        outputChannel.appendLine('Error: could not parse action from AI response.');
        outputChannel.appendLine(`Raw response: ${response}`);
        break;
      }

      if (action.action === 'DONE') {
        outputChannel.appendLine(`\nDone! ${getRandomKaomoji()}`);
        outputChannel.appendLine(`Reasoning: ${action.reasoning}`);
        break;
      }

      const desc = describeAction(action);
      outputChannel.appendLine(`Action: ${desc}`);
      outputChannel.appendLine(`Reasoning: ${action.reasoning}`);

      if (!autoConfirm) {
        const choice = await vscode.window.showInformationMessage(
          `ASKII Control: ${desc}`,
          { modal: false },
          'Execute',
          'Stop',
        );
        if (choice !== 'Execute') {
          outputChannel.appendLine('Stopped by user.');
          break;
        }
      }

      outputChannel.appendLine('Executing...');
      await executeControlAction(action, screenW, screenH);
      outputChannel.appendLine('Done.\n');

      round++;
    }

    if (round >= maxRounds) {
      outputChannel.appendLine(`Max rounds (${maxRounds}) reached.`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    outputChannel.appendLine(`Error: ${errorMsg}`);
    vscode.window.showErrorMessage(`ASKII Control failed: ${errorMsg}`);
  }
}
