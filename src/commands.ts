import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionResponse, getLLMExplanation } from './providers';
import { getWorkspaceStructure, parseWorkspaceActions } from '@common/workspace';
import { escapeHtml, escapeJsonString, unescapeJsonString, extractCode } from '@common/utils';
import { getRandomKaomoji } from '@common/kaomoji';

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

  try {
    const prompt = `Code:\n\`\`\`\n${selectedText}\n\`\`\`\n\nQuestion: ${question}`;
    const responseText = await getExtensionResponse(prompt);

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
    const workspaceStructure = await getWorkspaceStructure(workspaceRoot.uri.fsPath);
    let completedActions = 0;
    let roundCount = 0;

    const systemPrompt = `You are ASKII, an AI agent that can create, modify, view, and delete files in a workspace.

Current workspace structure:
\`\`\`
${workspaceStructure}
\`\`\`

You have access to the following action types:
- {"type": "view", "path": "path/to/file"} - View file contents, responses will be sent back to you
- {"type": "create", "path": "path/to/file", "content": "file content"}
- {"type": "modify", "path": "path/to/file", "oldContent": "text to replace", "newContent": "replacement text"}
- {"type": "delete", "path": "path/to/file"}

Always respond with ONLY a valid JSON array containing the actions. You can request to view files to inspect them, and their contents will be sent back to you for further analysis.`;

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

      const viewActions = actions.filter((a) => a.type === 'view');
      const otherActions = actions.filter((a) => a.type !== 'view');

      const viewResults: { [key: string]: string } = {};
      for (const action of viewActions) {
        const filePath = path.join(workspaceRoot.uri.fsPath, action.path);
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          viewResults[action.path] = escapeJsonString(content);
        } catch {
          viewResults[action.path] = `Error: Cannot read file`;
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
        }
      }

      if (Object.keys(viewResults).length > 0) {
        userMessage = `File contents retrieved:\n${JSON.stringify(viewResults, null, 2)}\n\nBased on these files, what would you like to do next? Respond with only a JSON array of actions or an empty array [] if done.`;
        roundCount++;
      } else {
        break;
      }
    }

    vscode.window.showInformationMessage(`Completed ${completedActions} actions! (⌐■_■)`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    vscode.window.showErrorMessage(`ASKII Do failed: ${errorMsg}`);
  }
}
