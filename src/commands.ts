import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import MarkdownIt from 'markdown-it';

// ── Diff content provider ────────────────────────────────────────────────────
// Serves in-memory content for the askii-diff:// URI scheme so VS Code's
// built-in diff editor can display original vs. AI-proposed code side by side.
export class AskiiDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();

  setContent(key: string, text: string): void {
    this.contents.set(key, text);
  }

  deleteContent(key: string): void {
    this.contents.delete(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }
}

export const askiiDiffProvider = new AskiiDiffContentProvider();
import {
  getExtensionResponse,
  getExtensionResponseStreaming,
  getExtensionResponseWithImage,
  getExtensionChatStreaming,
} from './providers';

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
import { type ChatMessage } from '@common/providers';
import { escapeHtml, unescapeJsonString, extractCode } from '@common/utils';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';
import {
  buildControlSystemPrompt,
  takeScreenshot,
  describeAction,
  executeControlAction,
  getMonitors,
  getSystemInfo,
  parseControlResponse,
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
import { buildWikiIndex, saveWikiIndex, loadWikiIndex, searchWiki } from '@common/wiki';

function getWikiContext(query: string): string {
  const config = vscode.workspace.getConfiguration('askii');
  if (!(config.get<boolean>('wikiEnabled') ?? false)) return '';
  const wikiPath = config.get<string>('wikiPath') ?? '';
  if (!wikiPath) return '';
  const index = loadWikiIndex(wikiPath);
  if (!index) return '';
  return searchWiki(query, index);
}

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

  // Wiki context is fetched once for the initial question
  const wikiCtx = getWikiContext(question);
  const wikiSection = wikiCtx ? `Relevant documentation:\n${wikiCtx}\n\n` : '';

  while (!panelDisposed) {
    const fullPrompt = wikiSection + codeContext + history + `Question: ${currentQuestion}`;
    let accumulated = '';

    try {
      await getExtensionResponseStreaming(
        fullPrompt,
        (chunk) => {
          accumulated += chunk;
          panel.webview.postMessage({ type: 'update', html: md.render(accumulated) });
        },
        'You are ASKII, a precise coding assistant. Answer concisely.',
      );

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

  // Snapshot selection now — it may shift while we await LLM work
  const selection = editor.selection;
  const hasSelection = !selection.isEmpty;
  const selectedText = hasSelection ? editor.document.getText(selection) : null;
  const fullFileText = editor.document.getText();

  const languageId = editor.document.languageId ?? '';
  const fileName = path.basename(editor.document.fileName);

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
    const metaLines = [
      fileName ? `File: ${fileName}` : null,
      languageId ? `Language: ${languageId}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const wikiCtxEdit = getWikiContext(question);
    const wikiSectionEdit = wikiCtxEdit ? `Relevant documentation:\n${wikiCtxEdit}\n\n` : '';

    let prompt: string;
    if (hasSelection && selectedText !== null) {
      // Pass full file as context, but ask only for the selected portion back
      prompt =
        wikiSectionEdit +
        `${metaLines ? metaLines + '\n' : ''}` +
        `Full file context:\n\`\`\`${languageId}\n${fullFileText}\n\`\`\`\n\n` +
        `Update only this selected section:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n` +
        `Request: ${question}\n\n` +
        `Return ONLY the updated replacement for the selected section, without surrounding context or explanation.`;
    } else {
      // No selection — edit the entire file
      prompt =
        wikiSectionEdit +
        `${metaLines ? metaLines + '\n' : ''}` +
        `Update this file:\n\`\`\`${languageId}\n${fullFileText}\n\`\`\`\n\n` +
        `Request: ${question}\n\n` +
        `Return only the updated code without explanation.`;
    }

    const responseText = await getExtensionResponse(
      prompt,
      'You are ASKII, a precise coding assistant. Return only the requested code, no explanation.',
    );
    const code = extractCode(responseText);

    // The original text being replaced (selection or full file)
    const originalText = selectedText ?? fullFileText;

    // ── Apply the edit immediately ────────────────────────────────────────────
    await editor.edit((editBuilder: vscode.TextEditorEdit) => {
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

    if (formatAfterEdit) {
      await vscode.commands.executeCommand('editor.action.formatDocument');
    }

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
      // Re-focus the original editor so undo targets the right document
      await vscode.window.showTextDocument(editor.document, editor.viewColumn);
      if (formatAfterEdit) {
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

export async function askiiDoCommand() {
  const question = await vscode.window.showInputBox({
    prompt: 'What would you like ASKII to do?',
    placeHolder: 'e.g., Create a test file, refactor common patterns',
  });

  if (!question) return;

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace found');
    return;
  }

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = config.get<number>('doMaxRounds') || 5;
  const autoConfirm = config.get<boolean>('doAutoConfirm') ?? false;
  const formatAfterEdit = config.get<boolean>('formatAfterEdit') ?? false;
  const rootPath = workspaceRoot.uri.fsPath;

  deleteAllBackups(rootPath);

  const channel = vscode.window.createOutputChannel('ASKII Do');
  channel.show(true);
  channel.appendLine(`Task: ${question}`);

  const abortController = new AbortController();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ASKII Do', cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => {
        abortController.abort();
        channel.appendLine('\nStopped by user.');
      });

  try {
    const workspaceStructure = getWorkspaceStructure(rootPath);
    const doConfig = vscode.workspace.getConfiguration('askii');
    const wikiPath = doConfig.get<string>('wikiPath') ?? '';
    const wikiAvailable = !!(wikiPath && loadWikiIndex(wikiPath));
    const systemPrompt = buildDoSystemPrompt(workspaceStructure, wikiAvailable);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: question },
    ];

    let completedActions = 0;
    let roundCount = 0;

    while (roundCount < maxRounds && !abortController.signal.aborted) {
      channel.appendLine(`\n[Round ${roundCount + 1}/${maxRounds}]`);

      channel.append('AI: ');
      const responseText = await getExtensionChatStreaming(messages, (chunk) =>
        channel.append(chunk),
      );
      channel.appendLine('');
      messages.push({ role: 'assistant', content: responseText });

      const actions = parseWorkspaceActions(responseText);
      if (actions.length === 0) {
        channel.appendLine('No actions returned. Done.');
        if (responseText.trim()) {
          channel.appendLine(`Raw (first 500): ${responseText.substring(0, 500)}`);
        }
        break;
      }

      const readActions = actions.filter(
        (a) => a.type === 'view' || a.type === 'list' || a.type === 'search' || a.type === 'wiki_search',
      );
      const writeActions = actions.filter(
        (a) => a.type !== 'view' && a.type !== 'list' && a.type !== 'search' && a.type !== 'wiki_search',
      );

      const feedbackParts: string[] = [];

      // ── Read actions (no confirmation) ──────────────────────────────────────
      const viewResults: Record<string, string> = {};
      for (const action of readActions) {
        try {
          if (action.type === 'wiki_search') {
            const q = action.query ?? '';
            channel.appendLine(`Wiki search: "${q}"`);
            const wikiData = wikiPath ? loadWikiIndex(wikiPath) : null;
            viewResults[`wiki_search:${q}`] = wikiData
              ? (searchWiki(q, wikiData) || 'No wiki results found')
              : 'Wiki not available — set askii.wikiPath and run Reload Wiki';
          } else if (action.type === 'search') {
            channel.appendLine(`Search: "${action.pattern}"`);
            viewResults[`search:${action.pattern}`] = executeSearchAction(action, rootPath);
          } else if (action.type === 'view' && action.paths) {
            for (const p of action.paths) {
              channel.appendLine(`Viewing: ${p}`);
              try {
                viewResults[p] = executeViewAction(
                  { ...action, path: p, paths: undefined },
                  rootPath,
                );
              } catch (e) {
                viewResults[p] = `Error: ${e instanceof Error ? e.message : 'Cannot read'}`;
              }
            }
          } else {
            channel.appendLine(`${action.type === 'list' ? 'Listing' : 'Viewing'}: ${action.path}`);
            viewResults[action.path!] = executeViewAction(action, rootPath);
          }
        } catch (e) {
          viewResults[action.path ?? 'unknown'] =
            `Error: ${e instanceof Error ? e.message : 'Cannot read path'}`;
        }
      }

      if (Object.keys(viewResults).length > 0) {
        feedbackParts.push(`File/search results:\n${JSON.stringify(viewResults, null, 2)}`);
      }

      // ── Write actions (with confirmation) ───────────────────────────────────
      const actionResults: ActionResult[] = [];

      for (const action of writeActions) {
        // Sandbox check
        let filePath: string;
        try {
          filePath = sandboxPath(rootPath, action.path!);
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Path error';
          channel.appendLine(`BLOCKED: ${msg}`);
          actionResults.push({
            action: `${action.type}:${action.path}`,
            status: 'error',
            detail: msg,
          });
          continue;
        }

        if (action.type === 'run') {
          channel.appendLine(`Run: ${action.command}`);
          const choice = await vscode.window.showInformationMessage(
            `ASKII Do — run command?\n${action.command}`,
            { modal: true },
            'Run',
            'Skip',
          );
          if (choice !== 'Run') {
            actionResults.push({ action: `run:${action.command}`, status: 'skipped' });
            continue;
          }
          try {
            const { execSync } = await import('child_process');
            const output = execSync(action.command!, {
              cwd: rootPath,
              encoding: 'utf-8',
              timeout: 30000,
            });
            channel.appendLine(`Run output: ${output.substring(0, 200)}`);
            actionResults.push({
              action: `run:${action.command}`,
              status: 'ok',
              detail: output.substring(0, 500),
            });
          } catch (e: unknown) {
            const err = e as { stdout?: string; stderr?: string; message?: string };
            const detail =
              `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message || 'Unknown error';
            channel.appendLine(`Run failed: ${detail.substring(0, 200)}`);
            actionResults.push({
              action: `run:${action.command}`,
              status: 'error',
              detail: detail.substring(0, 500),
            });
          }
          continue;
        }

        // Confirmation for all other write actions
        const confirmMsg = _doConfirmMessage(action);
        let confirmed = autoConfirm;
        if (!confirmed) {
          const choice = await vscode.window.showInformationMessage(
            `ASKII Do — ${confirmMsg}`,
            { modal: true },
            'Confirm',
            'Skip',
          );
          confirmed = choice === 'Confirm';
        }

        if (!confirmed) {
          actionResults.push({ action: `${action.type}:${action.path}`, status: 'skipped' });
          continue;
        }

        try {
          const result = await _executeWriteAction(action, filePath, rootPath, formatAfterEdit);
          if (result === 'ok') completedActions++;
          actionResults.push({
            action: `${action.type}:${action.path}`,
            status: result === 'ok' ? 'ok' : 'error',
            detail: result === 'ok' ? undefined : result,
          });
          if (result === 'ok') {
            channel.appendLine(`✓ ${_doActionLabel(action)}`);
          } else {
            channel.appendLine(`✗ Failed: ${result}`);
          }
        } catch (e) {
          const detail = e instanceof Error ? e.message : 'Unknown error';
          channel.appendLine(`✗ Failed: ${detail}`);
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

    if (abortController.signal.aborted) {
      channel.appendLine(`\nCompleted ${completedActions} actions before stopping. (⌐■_■)`);
    } else {
      if (roundCount >= maxRounds) channel.appendLine(`Max rounds (${maxRounds}) reached.`);
      channel.appendLine(`\nCompleted ${completedActions} actions! (⌐■_■)`);
    }

    if (hasBackups(rootPath)) {
      const choice = await vscode.window.showInformationMessage(
        `ASKII Do: ${completedActions} actions completed.`,
        'Confirm',
        'Undo',
      );
      if (choice === 'Undo') {
        const { restored, deleted } = restoreAllBackups(rootPath);
        deleteAllBackups(rootPath);
        channel.appendLine(
          `Undone — restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
        );
        vscode.window.showInformationMessage(
          `ASKII Do: Restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
        );
      } else if (choice === 'Confirm') {
        deleteAllBackups(rootPath);
      }
    } else {
      vscode.window.showInformationMessage(`ASKII Do: ${completedActions} actions completed.`);
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    channel.appendLine(`\nError: ${errorMsg}`);
    vscode.window.showErrorMessage(`ASKII Do failed: ${errorMsg}`);
  }

    }, // end withProgress callback
  );
}

export async function askiiBrowseCommand() {
  const task = await vscode.window.showInputBox({
    prompt: 'Give ASKII a browser task',
    placeHolder: 'e.g., Go to https://example.com and click Learn more',
  });

  if (!task) return;

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = config.get<number>('doMaxRounds') ?? 5;
  const autoConfirm = config.get<boolean>('doAutoConfirm') ?? false;
  const headless = config.get<boolean>('browserHeadless') ?? false;
  const chromePath = config.get<string>('chromePath') || undefined;

  const outputChannel = vscode.window.createOutputChannel('ASKII Browse');
  outputChannel.show(true);
  outputChannel.appendLine(`ASKII Browse started ${getRandomThinkingKaomoji()}`);
  outputChannel.appendLine(`Task: ${task}`);
  outputChannel.appendLine('');

  const abortController = new AbortController();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ASKII Browse', cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => {
        abortController.abort();
        outputChannel.appendLine('Stopped by user.');
      });

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const puppeteer = require('puppeteer-core') as typeof import('puppeteer-core');
      let browser: import('puppeteer-core').Browser | undefined;

      try {
        outputChannel.appendLine('Launching browser...');
        browser = await puppeteer.launch({
          headless: headless ? true : false,
          executablePath: chromePath,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
        });

        const [page] = await browser.pages();
        await page.setViewport(null);

        let round = 0;

        while (round < maxRounds && !abortController.signal.aborted) {
          outputChannel.appendLine(`Round ${round + 1}/${maxRounds} — capturing screenshot...`);

          const imageBase64 = await takePageScreenshot(page);
          const currentUrl = page.url();

          outputChannel.appendLine(`Current URL: ${currentUrl}`);

          const systemPrompt = buildBrowserSystemPrompt();
          const userPrompt =
            round === 0
              ? `Task: ${task}\n\nCurrent URL: ${currentUrl}\n\nAnalyze the screenshot and determine the next action.`
              : `Continuing task: ${task}\n\nCurrent URL: ${currentUrl}\n\nAnalyze the screenshot and return the next action or DONE.`;

          outputChannel.appendLine('Asking AI...');
          const rawResponse = await getExtensionResponseWithImage(
            `${systemPrompt}\n\n${userPrompt}`,
            imageBase64,
          );

          if (abortController.signal.aborted) break;

          const action = parseBrowserAction(rawResponse);

          if (!action) {
            outputChannel.appendLine('Error: could not parse AI response.');
            outputChannel.appendLine(`Raw: ${rawResponse}`);
            break;
          }

          if (action.action === 'DONE') {
            outputChannel.appendLine(`\nDone! ${getRandomKaomoji()}`);
            outputChannel.appendLine(`Reasoning: ${action.reasoning}`);
            break;
          }

          const description = describeBrowserAction(action);
          outputChannel.appendLine(`Action: ${description}`);
          outputChannel.appendLine(`Reasoning: ${action.reasoning}`);

          if (!autoConfirm) {
            const choice = await vscode.window.showInformationMessage(
              `ASKII Browse: ${description}`,
              { modal: false },
              'Execute',
              'Stop',
            );
            if (choice !== 'Execute' || abortController.signal.aborted) {
              outputChannel.appendLine('Stopped by user.');
              break;
            }
          }

          try {
            await executeBrowserAction(action, page);
            outputChannel.appendLine('Done.\n');
          } catch (execErr) {
            const msg = execErr instanceof Error ? execErr.message : 'Unknown error';
            outputChannel.appendLine(`Action failed: ${msg}`);
          }

          round++;
        }

        if (round >= maxRounds && !abortController.signal.aborted) {
          outputChannel.appendLine(`Max rounds (${maxRounds}) reached.`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`Error: ${errorMsg}`);
        vscode.window.showErrorMessage(`ASKII Browse failed: ${errorMsg}`);
      }
    },
  );
}

async function _applyFormat(filePath: string): Promise<void> {
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

async function _executeWriteAction(
  action: WorkspaceAction,
  filePath: string,
  rootPath: string,
  formatAfterEdit: boolean,
): Promise<'ok' | string> {
  switch (action.type) {
    case 'mkdir': {
      fs.mkdirSync(filePath, { recursive: true });
      return 'ok';
    }

    case 'copy': {
      if (!action.newPath) return 'copy requires newPath';
      const destPath = sandboxPath(rootPath, action.newPath);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(filePath, destPath);
      return 'ok';
    }

    case 'create':
    case 'write': {
      if (action.type === 'write') writeBackup(rootPath, filePath);
      if (action.type === 'create') recordCreatedFile(rootPath, action.path!);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const content = action.content ? unescapeJsonString(action.content) : '';
      fs.writeFileSync(filePath, content);
      if (formatAfterEdit) await _applyFormat(filePath);
      return 'ok';
    }

    case 'modify': {
      writeBackup(rootPath, filePath);
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
      } else {
        const oldContent = action.oldContent ? unescapeJsonString(action.oldContent) : '';
        const newContent = action.newContent ? unescapeJsonString(action.newContent) : '';
        if (oldContent && !existing.includes(oldContent)) {
          return `oldContent not found in ${action.path}`;
        }
        fs.writeFileSync(filePath, existing.replace(oldContent, newContent));
      }
      if (formatAfterEdit) await _applyFormat(filePath);
      return 'ok';
    }

    case 'delete': {
      writeBackup(rootPath, filePath);
      fs.unlinkSync(filePath);
      return 'ok';
    }

    case 'rename': {
      if (!action.newPath) return 'rename requires newPath';
      writeBackup(rootPath, filePath);
      const newFilePath = sandboxPath(rootPath, action.newPath);
      const newDir = path.dirname(newFilePath);
      if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
      fs.renameSync(filePath, newFilePath);
      return 'ok';
    }

    default:
      return `Unknown action type: ${(action as WorkspaceAction).type}`;
  }
}

function _doConfirmMessage(action: WorkspaceAction): string {
  switch (action.type) {
    case 'delete':
      return `Delete: ${action.path}?`;
    case 'rename':
      return `Rename: ${action.path} → ${action.newPath}?`;
    case 'copy':
      return `Copy: ${action.path} → ${action.newPath}?`;
    case 'mkdir':
      return `Create directory: ${action.path}?`;
    default: {
      const t = action.type.charAt(0).toUpperCase() + action.type.slice(1);
      return `${t}: ${action.path}?`;
    }
  }
}

function _doActionLabel(action: WorkspaceAction): string {
  switch (action.type) {
    case 'mkdir':
      return `Created directory: ${action.path}`;
    case 'copy':
      return `Copied: ${action.path} → ${action.newPath}`;
    case 'create':
      return `Created: ${action.path}`;
    case 'write':
      return `Wrote: ${action.path}`;
    case 'modify':
      return action.startLine !== undefined
        ? `Modified (lines ${action.startLine}–${action.endLine}): ${action.path}`
        : `Modified: ${action.path}`;
    case 'delete':
      return `Deleted: ${action.path}`;
    case 'rename':
      return `Renamed: ${action.path} → ${action.newPath}`;
    default:
      return `${action.type}: ${action.path}`;
  }
}

export async function askiiReloadWikiCommand() {
  const config = vscode.workspace.getConfiguration('askii');
  const wikiPath = config.get<string>('wikiPath') ?? '';
  if (!wikiPath) {
    vscode.window.showErrorMessage('ASKII: Set askii.wikiPath in settings first.');
    return;
  }
  if (!fs.existsSync(wikiPath)) {
    vscode.window.showErrorMessage(`ASKII: Wiki path not found: ${wikiPath}`);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ASKII: Indexing wiki...',
      cancellable: false,
    },
    async (progress) => {
      try {
        progress.report({ message: 'Reading .md files...' });
        const data = buildWikiIndex(wikiPath);

        progress.report({ message: `Saving index (${data.chunkCount} chunks)...` });
        saveWikiIndex(data, wikiPath);

        vscode.window.showInformationMessage(
          `ASKII: Wiki ready — ${data.chunkCount} chunks from ${data.fileCount} file(s). (⌐■_■)`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `ASKII: Wiki reload failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    },
  );
}

export async function askiiControlCommand() {
  const instruction = await vscode.window.showInputBox({
    prompt: 'Give ASKII a screen control instruction',
    placeHolder: 'e.g., Open Notepad and type hello world',
  });

  if (!instruction) return;

  const missingDeps = checkControlDependencies();
  if (missingDeps.length > 0) {
    vscode.window.showErrorMessage(
      `ASKII Control: missing required tools:\n${missingDeps.join('\n')}`,
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = config.get<number>('doMaxRounds') ?? 5;
  const autoConfirm = config.get<boolean>('doAutoConfirm') ?? false;

  // Monitor selection
  let monitorId: string | number | undefined;
  try {
    const monitors = await getMonitors();
    if (monitors.length > 1) {
      const pick = await vscode.window.showQuickPick(
        monitors.map((m) => ({ label: m.name, id: m.id })),
        { placeHolder: 'Select monitor to control' },
      );
      if (!pick) return;
      monitorId = pick.id;
    }
  } catch {
    // proceed with default monitor
  }

  const outputChannel = vscode.window.createOutputChannel('ASKII Control');
  outputChannel.show(true);
  outputChannel.appendLine(`ASKII Control started ${getRandomThinkingKaomoji()}`);
  outputChannel.appendLine(`Instruction: ${instruction}`);
  outputChannel.appendLine('');

  const abortController = new AbortController();
  const history: ControlHistoryEntry[] = [];
  let round = 0;
  let prevScreenshot: string | undefined;
  let systemInfo: SystemInfo | undefined;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ASKII Control', cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => {
        abortController.abort();
        outputChannel.appendLine('Stopped by user.');
      });

      try {
        while (round < maxRounds && !abortController.signal.aborted) {
          outputChannel.appendLine(`Round ${round + 1}/${maxRounds} — taking screenshot...`);

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

          const screenChanged = prevScreenshot === undefined || prevScreenshot !== imageBase64;
          if (prevScreenshot !== undefined && !screenChanged) {
            outputChannel.appendLine('Warning: screen unchanged since last action.');
          }
          prevScreenshot = imageBase64;

          const prompt =
            round === 0
              ? `Instruction to complete: ${instruction}\n\nAnalyze the screenshot and determine the next action(s).`
              : `Continuing instruction: ${instruction}\n\nAnalyze the updated screenshot and return the next action(s) or DONE.`;

          outputChannel.appendLine('Asking AI...');
          const rawResponse = await getExtensionResponseWithImage(
            `${buildControlSystemPrompt(screenW, screenH, systemInfo, history)}\n\n${prompt}`,
            imageBase64,
          );

          if (abortController.signal.aborted) {
            break;
          }

          const parsed = parseControlResponse(rawResponse);

          if (!parsed) {
            outputChannel.appendLine('Error: could not parse AI response.');
            outputChannel.appendLine(`Raw: ${rawResponse}`);
            break;
          }

          if (parsed.type === 'done') {
            outputChannel.appendLine(`\nDone! ${getRandomKaomoji()}`);
            outputChannel.appendLine(`Reasoning: ${parsed.reasoning}`);
            break;
          }

          let { actions } = parsed;

          // Log all planned actions
          actions.forEach((a, i) => {
            const label = actions.length > 1 ? `Action ${i + 1}/${actions.length}` : 'Action';
            outputChannel.appendLine(`${label}: ${describeAction(a as ControlAction)}`);
            outputChannel.appendLine(`Reasoning: ${a.reasoning}`);
          });

          // Confirm
          if (!autoConfirm) {
            const label =
              actions.length === 1
                ? describeAction(actions[0] as ControlAction)
                : `${actions.length} actions`;
            const choice = await vscode.window.showInformationMessage(
              `ASKII Control: ${label}`,
              { modal: false },
              'Execute',
              'Stop',
            );
            if (choice !== 'Execute' || abortController.signal.aborted) {
              outputChannel.appendLine('Stopped by user.');
              break;
            }
            // Small delay between confirmation and execution
            await new Promise<void>((resolve) => setTimeout(resolve, 1500));
          }

          // Resolve click_text actions to coordinates via a second LLM call
          for (const a of actions) {
            if ((a as ControlAction).action === 'click_text') {
              const ct = a as { action: 'click_text'; text: string; reasoning: string };
              try {
                const resolvePrompt = `Find the EXACT pixel coordinates of the UI element whose visible text is "${ct.text}". Return ONLY valid JSON: {"x": number, "y": number}`;
                const raw = await getExtensionResponseWithImage(resolvePrompt, imageBase64);
                const m = raw.match(/\{[\s\S]*?\}/);
                if (m) {
                  const coords = JSON.parse(m[0]);
                  if (typeof coords.x === 'number' && typeof coords.y === 'number') {
                    Object.assign(a, { action: 'mouse_left_click', x: coords.x, y: coords.y });
                    outputChannel.appendLine(`Resolved "${ct.text}" → (${coords.x}, ${coords.y})`);
                  }
                }
              } catch {
                outputChannel.appendLine(
                  `Warning: could not resolve text "${ct.text}" to coordinates`,
                );
              }
            }
          }

          // Execute sequence
          for (const a of actions) {
            if (abortController.signal.aborted) break;
            await executeControlAction(
              a as ControlAction,
              screenW,
              screenH,
              abortController.signal,
            );
            history.push({
              round: round + 1,
              description: describeAction(a as ControlAction),
              reasoning: a.reasoning,
              screenChanged: true,
            });
          }
          outputChannel.appendLine('Done.\n');

          round++;
        }

        if (round >= maxRounds && !abortController.signal.aborted) {
          outputChannel.appendLine(`Max rounds (${maxRounds}) reached.`);
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        outputChannel.appendLine(`Error: ${errorMsg}`);
        vscode.window.showErrorMessage(`ASKII Control failed: ${errorMsg}`);
      }
    },
  );
}
