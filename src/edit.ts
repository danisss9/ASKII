import * as vscode from 'vscode';
import * as path from 'path';
import { getExtensionResponse } from './providers';
import { extractCode } from '@common/utils';
import { askiiDiffProvider } from './diffProvider';
import { getCodeWikiContext, getWikiContext } from './commandUtils';

export async function askiiEditCommand() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('No active editor');
    return;
  }

  // Snapshot selection now — it may shift while we await LLM work
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  const selectedText = hasSelection ? editor.document.getText(selection) : null;
  const fullFileText = editor.document.getText();
  const snapshotVersion = editor.document.version;

  const languageId = editor.document.languageId ?? '';
  const fileName = path.basename(editor.document.fileName);

  const question = await vscode.window.showInputBox({
    prompt: 'What changes would you like to make?',
    placeHolder: 'e.g., Add error handling, optimize for performance',
  });

  if (!question) {
    return;
  }

  const editConfig = vscode.workspace.getConfiguration('askii');
  const formatAfterEdit = editConfig.get<boolean>('formatAfterEdit') ?? false;

  try {
    const metaLines = [
      fileName ? `File: ${fileName}` : null,
      languageId ? `Language: ${languageId}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const wikiCtxEdit = await getWikiContext(question);
    const wikiSectionEdit = wikiCtxEdit ? `Relevant documentation:\n${wikiCtxEdit}\n\n` : '';
    const codeWikiCtxEdit = await getCodeWikiContext(question);
    const codeWikiSectionEdit = codeWikiCtxEdit
      ? `Relevant code from the codebase:\n${codeWikiCtxEdit}\n\n`
      : '';

    let prompt: string;
    if (hasSelection && selectedText !== null) {
      // Pass full file as context, but ask only for the selected portion back
      prompt =
        wikiSectionEdit +
        codeWikiSectionEdit +
        `${metaLines ? metaLines + '\n' : ''}` +
        `Full file context:\n\`\`\`${languageId}\n${fullFileText}\n\`\`\`\n\n` +
        `Update only this selected section:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n` +
        `Request: ${question}\n\n` +
        `Return ONLY the updated replacement for the selected section, without surrounding context or explanation.`;
    } else {
      // No selection — edit the entire file
      prompt =
        wikiSectionEdit +
        codeWikiSectionEdit +
        `${metaLines ? metaLines + '\n' : ''}` +
        `Update this file:\n\`\`\`${languageId}\n${fullFileText}\n\`\`\`\n\n` +
        `Request: ${question}\n\n` +
        `Return only the updated code without explanation.`;
    }

    const responseText = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ASKII is editing... (•_•)>⌐■-■',
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        try {
          return await getExtensionResponse(
            prompt,
            'You are ASKII, a precise coding assistant. Return only the requested code, no explanation.',
            'general',
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) {
            return null;
          }
          throw error;
        } finally {
          sub.dispose();
        }
      },
    );
    if (responseText === null) {
      vscode.window.setStatusBarMessage('ASKII Edit cancelled.', 3000);
      return;
    }
    const code = extractCode(responseText);
    if (!code.trim()) {
      vscode.window.showWarningMessage('ASKII Edit: the model returned no code — nothing was changed.');
      return;
    }

    // The original text being replaced (selection or full file)
    const originalText = selectedText ?? fullFileText;

    // The selection/range snapshot is only valid for the text it was taken from
    if (editor.document.version !== snapshotVersion) {
      vscode.window.showWarningMessage(
        'ASKII Edit: the file changed while ASKII was editing — edit not applied. (´･_･`)',
      );
      return;
    }

    // ── Apply the edit immediately ────────────────────────────────────────────
    const applied = await editor.edit((editBuilder: vscode.TextEditorEdit) => {
      if (hasSelection && selectedText !== null) {
        editBuilder.replace(selection, code);
      } else {
        const fullRange = new vscode.Range(
          editor.document.positionAt(0),
          editor.document.positionAt(fullFileText.length),
        );
        editBuilder.replace(fullRange, code);
      }
    });
    if (!applied) {
      vscode.window.showErrorMessage('ASKII Edit: the edit could not be applied to the editor.');
      return;
    }

    // Formatting only adds an undo step when it actually changed something
    let formatted = false;
    if (formatAfterEdit) {
      const versionBeforeFormat = editor.document.version;
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      await vscode.commands.executeCommand('editor.action.formatDocument');
      formatted = editor.document.version !== versionBeforeFormat;
    }
    const versionAfterEdit = editor.document.version;

    // ── Show diff + undo offer ────────────────────────────────────────────────
    const diffId = `edit-${Date.now()}`;
    askiiDiffProvider.setContent(`original-${diffId}`, originalText);
    askiiDiffProvider.setContent(`proposed-${diffId}`, code);

    const originalUri = vscode.Uri.parse(`askii-diff:original-${diffId}`);
    const proposedUri = vscode.Uri.parse(`askii-diff:proposed-${diffId}`);

    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      `ASKII Edit: ${fileName} (⌐■_■)`,
      { viewColumn: vscode.ViewColumn.Beside, preview: true },
    );

    const undoChoice = await vscode.window.showInformationMessage(
      'Code updated! (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧',
      'Undo',
    );

    askiiDiffProvider.deleteContent(`original-${diffId}`);
    askiiDiffProvider.deleteContent(`proposed-${diffId}`);

    if (undoChoice === 'Undo') {
      // The undo stack only holds just ASKII's edit while nothing else
      // changed the file — otherwise "undo" would revert the user's typing
      if (editor.document.isClosed || editor.document.version !== versionAfterEdit) {
        vscode.window.showWarningMessage(
          'ASKII Edit: the file changed after the edit, so it was not reverted automatically — use Undo (Ctrl+Z) in the editor.',
        );
        return;
      }
      // Re-focus the original editor so undo targets the right document
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      if (formatted) {
        await vscode.commands.executeCommand('undo');
      }
      await vscode.commands.executeCommand('undo');
      vscode.window.showInformationMessage('Edit reverted. (ᵔᴥᵔ)');
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    vscode.window.showErrorMessage(`ASKII Edit failed: ${errorMsg}`);
  }
}
