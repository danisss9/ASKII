import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import { getExtensionResponse, getExtensionResponseWithImage, getLLMExplanation } from './providers';
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

  const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

  const webviewCss = `
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
    h2.header { margin-top: 0; opacity: 0.85; font-size: 1em; font-weight: 600; }
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
  `;

  const makeHtml = (title: string, bodyContent: string) => `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><style>${webviewCss}</style></head>
<body>
  <h2 class="header">${title}</h2>
  ${bodyContent}
</body>
</html>`;

  const panel = vscode.window.createWebviewPanel(
    'askiiOutput',
    'ASKII Response',
    vscode.ViewColumn.Beside,
    { enableScripts: false },
  );

  panel.webview.html = makeHtml(
    'ASKII is thinking... (๑•﹏•)',
    '<p class="thinking">Waiting for response...</p>',
  );

  try {
    const prompt = `Code:\n\`\`\`\n${selectedText}\n\`\`\`\n\nQuestion: ${question}`;
    const responseText = await getExtensionResponse(prompt);
    panel.webview.html = makeHtml('ASKII Says: (⌐■_■)', md.render(responseText));
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    panel.webview.html = makeHtml('Error', `<p>${escapeHtml(errorMsg)}</p>`);
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
                vscode.window.showInformationMessage(`✓ Renamed: ${action.path} → ${action.newPath}`);
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
