import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
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
  backupOrRecordCreated,
  applyModifyAction,
  INVALID_ACTIONS_FEEDBACK,
  deleteAllBackups,
  restoreAllBackups,
  hasBackups,
  type WorkspaceAction,
  type ActionResult,
} from '@common/workspace';
import { type ChatMessage } from '@common/providers';
import { escapeHtml, decodeIfDoubleEscaped, extractCode } from '@common/utils';
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
  parseBrowserResponse,
  describeBrowserAction,
  executeBrowserAction,
  takePageScreenshot,
  detectBrowserExecutable,
} from '@common/browser';
import { buildWikiIndex, hasWikiIndex, searchWiki } from '@common/wiki';
import {
  rebuildCodeWikiIndex,
  searchCodeWiki,
  hasCodeWikiIndex,
} from '@common/codewiki';
import {
  autoLinkFileReferences,
  makePathResolver,
  parseLocationHref,
  FILE_CITATION_INSTRUCTIONS,
} from '@common/links';
import {
  acquireTaskPanel,
  addTimelineEntry,
  beginTaskSession,
  endTaskSession,
  flushEntryStream,
  requestChoice,
  setTaskCanceller,
  setTaskStatus,
  streamToEntry,
  sweepPendingEntries,
  updateTimelineEntry,
  waitForFollowUp,
} from './taskPanel';

async function getWikiContext(query: string): Promise<string> {
  try {
    const config = vscode.workspace.getConfiguration('askii');
    if (!(config.get<boolean>('wikiEnabled') ?? false)) {return '';}
    const wikiPath = config.get<string>('wikiPath') ?? '';
    if (!wikiPath || !hasWikiIndex(wikiPath)) {return '';}
    return await searchWiki(wikiPath, query);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[askii wiki] ${message}`);
    return '';
  }
}

async function getCodeWikiContext(query: string): Promise<string> {
  try {
    const config = vscode.workspace.getConfiguration('askii');
    if (!(config.get<boolean>('codeWikiEnabled') ?? false)) {return '';}
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {return '';}
    return await searchCodeWiki(root, query);
  } catch (error) {
    // Retrieval must never break the command — log and continue without context
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[askii code wiki] ${message}`);
    return '';
  }
}

// ── Ask answer citations ─────────────────────────────────────────────────────
// Answers cite locations as `path:line`; the panel rewrites those into
// askii-open:// links and clicking one lands here to open the exact spot.
async function openAskiiLocation(href: string): Promise<void> {
  const loc = parseLocationHref(href);
  if (!loc) {return;}
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(loc.path));
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
    });
    if (loc.line !== undefined) {
      const lastLine = Math.max(0, doc.lineCount - 1);
      const start = Math.min(Math.max(0, loc.line - 1), lastLine);
      const end = Math.min(Math.max(0, (loc.endLine ?? loc.line) - 1), lastLine);
      const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    vscode.window.showErrorMessage(`ASKII: could not open ${loc.path} — ${message}`);
  }
}

export async function askAskiiCommand() {
  const nonce = randomBytes(16).toString('base64');
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

  // Citation candidates resolve against the workspace root and the docs-wiki
  // folder, so both code and documentation references become clickable
  const resolveLocation = makePathResolver([
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    vscode.workspace.getConfiguration('askii').get<string>('wikiPath'),
  ]);

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
    .icon-btn.active { opacity: 1; color: var(--vscode-textLink-foreground, #4daafc); }
    #copyBtn.copied { opacity: 1; color: var(--vscode-terminal-ansiGreen, #4ec9b0); }
    #copyBtn .icon-check { display: none; }
    #copyBtn.copied .icon-copy { display: none; }
    #copyBtn.copied .icon-check { display: inline-block; animation: check-pop 0.25s ease-out; }
    @keyframes check-pop {
      from { transform: scale(0.4); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    .history-entry { margin: 0 0 1.2em; }
    .history-entry:last-child { margin-bottom: 0; }
    .history-q {
      font-weight: 600;
      font-size: 0.92em;
      background: var(--vscode-input-background, rgba(128,128,128,0.12));
      border-left: 3px solid var(--vscode-activityBarBadge-background, #007acc);
      border-radius: 3px;
      padding: 4px 10px;
      margin-bottom: 0.5em;
      opacity: 0.9;
    }
    .stream-cursor {
      display: inline-block;
      opacity: 0.7;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }
  `;

  const panelHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
  <style>${css}</style>
</head>
<body>
  <div class="header-row">
    <h2 id="title">ASKII is thinking... (๑•﹏•)</h2>
    <div class="btn-group">
      <button id="historyBtn" class="icon-btn" title="View conversation history">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 3v5h5"></path>
          <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"></path>
          <polyline points="12 7 12 12 15 14"></polyline>
        </svg>
      </button>
      <button id="followUpBtn" class="icon-btn" title="Ask a follow-up">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
      </button>
      <button id="copyBtn" class="icon-btn" title="Copy response">
        <svg class="icon-copy" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <svg class="icon-check" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </button>
    </div>
  </div>
  <div id="content"><p class="thinking">Waiting for response...</p></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const contentEl = document.getElementById('content');
    const titleEl = document.getElementById('title');
    const copyBtn = document.getElementById('copyBtn');
    const followUpBtn = document.getElementById('followUpBtn');
    const historyBtn = document.getElementById('historyBtn');
    let rawText = '';
    let showingHistory = false;
    let savedHtml = '';
    let savedTitle = 'ASKII Says: (⌐■_■)';
    function resetHistoryView() {
      showingHistory = false;
      historyBtn.classList.remove('active');
      historyBtn.title = 'View conversation history';
    }
    function showBtns(visible) {
      const d = visible ? 'inline-flex' : 'none';
      copyBtn.style.display = d;
      followUpBtn.style.display = d;
      historyBtn.style.display = d;
    }
    function flashCopied() {
      copyBtn.classList.add('copied');
      setTimeout(() => copyBtn.classList.remove('copied'), 1500);
    }
    function showCopyError() {
      copyBtn.title = 'Copy failed';
      copyBtn.style.color = 'var(--vscode-errorForeground, #f48771)';
      copyBtn.style.opacity = '1';
      setTimeout(() => {
        copyBtn.title = 'Copy response';
        copyBtn.style.color = '';
        copyBtn.style.opacity = '';
      }, 2000);
    }
    window.addEventListener('message', event => {
      const msg = event.data;
      if (typeof msg !== 'object' || msg === null) return;
      const safeHtml = typeof msg.html === 'string' ? msg.html : '';
      if (msg.type === 'update') {
        contentEl.innerHTML = safeHtml;
        const cursor = document.createElement('span');
        cursor.className = 'stream-cursor';
        cursor.textContent = '▍';
        contentEl.appendChild(cursor);
      } else if (msg.type === 'done') {
        rawText = typeof msg.text === 'string' ? msg.text : '';
        contentEl.innerHTML = safeHtml;
        titleEl.textContent = 'ASKII Says: (⌐■_■)';
        showBtns(true);
      } else if (msg.type === 'thinking') {
        rawText = '';
        showBtns(false);
        resetHistoryView();
        titleEl.textContent = 'ASKII is thinking... (๑•﹏•)';
        contentEl.innerHTML = '<p class="thinking">Waiting for response...</p>';
      } else if (msg.type === 'history') {
        if (!showingHistory) {
          showingHistory = true;
          savedHtml = contentEl.innerHTML;
          savedTitle = titleEl.textContent;
          historyBtn.classList.add('active');
          historyBtn.title = 'Back to response';
          titleEl.textContent = 'Conversation history';
        }
        contentEl.innerHTML = safeHtml;
      } else if (msg.type === 'cancelled') {
        titleEl.textContent = 'ASKII Says: (⌐■_■)';
        showBtns(true);
      } else if (msg.type === 'copied') {
        flashCopied();
      } else if (msg.type === 'copyFailed') {
        showCopyError();
      } else if (msg.type === 'error') {
        titleEl.textContent = 'Error';
        contentEl.innerHTML = safeHtml;
        showBtns(false);
      }
    });
    // Inline onclick attributes are blocked by this page's CSP (script-src 'nonce-...'),
    // so the buttons are wired up here from the nonce'd script instead.
    historyBtn.addEventListener('click', () => {
      if (showingHistory) {
        resetHistoryView();
        titleEl.textContent = savedTitle;
        contentEl.innerHTML = savedHtml;
      } else {
        vscode.postMessage({ type: 'requestHistory' });
      }
    });
    followUpBtn.addEventListener('click', () => {
      showBtns(false);
      vscode.postMessage({ type: 'followup' });
    });
    copyBtn.addEventListener('click', () => {
      if (rawText === '') return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(rawText).then(flashCopied, () => {
          vscode.postMessage({ type: 'copy', text: rawText });
        });
      } else {
        vscode.postMessage({ type: 'copy', text: rawText });
      }
    });
    // path:line citations are rewritten into askii-open:// links; clicking one
    // hands the href to the host, which opens the file at that exact spot
    contentEl.addEventListener('click', (e) => {
      const anchor = e.target instanceof Element ? e.target.closest('a') : null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      if (href.startsWith('askii-open:')) {
        e.preventDefault();
        vscode.postMessage({ type: 'openLocation', href });
      }
    });
  </script>
</body>
</html>`;

  const panel = vscode.window.createWebviewPanel(
    'askiiOutput',
    'ASKII Response',
    vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [] },
  );

  panel.webview.html = panelHtml;

  // Full transcript of this panel's conversation (question + answer per turn), kept in
  // sync alongside `history` so the webview can browse previous messages on demand.
  const conversation: Array<{ question: string; answer: string }> = [];

  // Copy & history requests are honored for the whole panel lifetime — the webview falls
  // back to the clipboard path when its own access is unavailable (e.g. unfocused webview).
  panel.webview.onDidReceiveMessage((msg) => {
    if (typeof msg !== 'object' || msg === null) {return;}
    if (msg.type === 'copy' && typeof msg.text === 'string') {
      void vscode.env.clipboard.writeText(msg.text).then(
        () => {
          if (!panelDisposed) {panel.webview.postMessage({ type: 'copied' });}
        },
        () => {
          if (!panelDisposed) {panel.webview.postMessage({ type: 'copyFailed' });}
        },
      );
    } else if (msg.type === 'openLocation' && typeof msg.href === 'string') {
      void openAskiiLocation(msg.href);
    } else if (msg.type === 'requestHistory') {
      const html =
        conversation.length === 0
          ? '<p class="thinking">No previous messages yet.</p>'
          : conversation
              .map((entry) => {
                let answerHtml: string;
                try {
                  answerHtml = md.render(
                    autoLinkFileReferences(entry.answer, { resolve: resolveLocation }),
                  );
                } catch {
                  answerHtml = `<pre>${escapeHtml(entry.answer)}</pre>`;
                }
                return `<div class="history-entry"><div class="history-q">${escapeHtml(entry.question)}</div>${answerHtml}</div>`;
              })
              .join('<hr>');
      if (!panelDisposed) {panel.webview.postMessage({ type: 'history', html });}
    }
  });

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
    const wikiCtx = await getWikiContext(currentQuestion);
    const wikiSection = wikiCtx ? `Relevant documentation:\n${wikiCtx}\n\n` : '';
    const codeWikiCtx = await getCodeWikiContext(currentQuestion);
    const codeWikiSection = codeWikiCtx ? `Relevant code from the codebase:\n${codeWikiCtx}\n\n` : '';
    const fullPrompt =
      wikiSection + codeWikiSection + codeContext + history + `Question: ${currentQuestion}`;
    let accumulated = '';

    const renderAccumulated = (): string => {
      try {
        return md.render(autoLinkFileReferences(accumulated, { resolve: resolveLocation }));
      } catch {
        return `<pre>${escapeHtml(accumulated)}</pre>`;
      }
    };

    try {
      // Markdown re-parses are expensive, so bursts of chunks that arrive within the
      // flush interval are batched into a single render + postMessage.
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      await getExtensionResponseStreaming(
        fullPrompt,
        (chunk) => {
          if (panelDisposed) {return;}
          accumulated += chunk;
          if (flushTimer === null) {
            flushTimer = setTimeout(() => {
              flushTimer = null;
              if (!panelDisposed) {
                panel.webview.postMessage({ type: 'update', html: renderAccumulated() });
              }
            }, 50);
          }
        },
        'You are ASKII, a precise coding assistant. Answer concisely.\n\n' +
        FILE_CITATION_INSTRUCTIONS,
      );
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      history += `Question: ${currentQuestion}\n\nAnswer: ${accumulated}\n\n`;
      conversation.push({ question: currentQuestion, answer: accumulated });
      panel.webview.postMessage({ type: 'done', html: renderAccumulated(), text: accumulated });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      panel.webview.postMessage({ type: 'error', html: `<p>${escapeHtml(errorMsg)}</p>` });
      break;
    }

    // Wait for a follow-up request or panel close. An empty answer means the user
    // dismissed the input box — go back to waiting instead of dead-ending the panel.
    let nextQuestion: string | null = null;
    while (nextQuestion === null) {
      const answer = await new Promise<string | null>((resolve) => {
        let settled = false;
        const settle = (value: string | null): void => {
          if (settled) {return;}
          settled = true;
          msgDisp.dispose();
          dispDisp.dispose();
          resolve(value);
        };
        const msgDisp = panel.webview.onDidReceiveMessage(async (msg) => {
          if (typeof msg !== 'object' || msg === null) {return;}
          if (msg.type === 'followup') {
            settle(
              (await vscode.window.showInputBox({
                prompt: 'Ask a follow-up question',
                placeHolder: 'What else would you like to know?',
              })) ?? '',
            );
          }
        });
        const dispDisp = panel.onDidDispose(() => settle(null));
      });
      if (answer === null) {
        break; // panel closed while waiting
      }
      if (answer === '') {
        panel.webview.postMessage({ type: 'cancelled' });
        continue;
      }
      nextQuestion = answer;
    }

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

    const responseText = await getExtensionResponse(
      prompt,
      'You are ASKII, a precise coding assistant. Return only the requested code, no explanation.',
    );
    const code = extractCode(responseText);

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

export async function askiiDoCommand() {
  const question = await vscode.window.showInputBox({
    prompt: 'What would you like ASKII to do?',
    placeHolder: 'e.g., Create a test file, refactor common patterns',
  });

  if (!question) {return;}

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace found');
    return;
  }

  if (!beginTaskSession()) {
    vscode.window.showInformationMessage('ASKII is already running a task — see the ASKII task panel.');
    return;
  }

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = config.get<number>('doMaxRounds') || 20;
  const autoConfirm = config.get<boolean>('doAutoConfirm') ?? false;
  const formatAfterEdit = config.get<boolean>('formatAfterEdit') ?? false;
  const rootPath = workspaceRoot.uri.fsPath;

  try {
    deleteAllBackups(rootPath);
  } catch {
    // Backup cleanup is best-effort; don't block the run on it
  }

  const channel = vscode.window.createOutputChannel('ASKII Do');
  channel.appendLine(`Task: ${question}`);

  const abortController = new AbortController();
  setTaskCanceller(() => {
    abortController.abort();
    channel.appendLine('\nStopped by user.');
  });

  acquireTaskPanel('ASKII Do');

  // Wiki availability only depends on settings/indexes — resolve once per session
  const wikiPath = config.get<string>('wikiPath') ?? '';
  const wikiEnabled = config.get<boolean>('wikiEnabled') ?? false;
  const wikiAvailable = !!(wikiEnabled && wikiPath && hasWikiIndex(wikiPath));
  const codeWikiEnabled = config.get<boolean>('codeWikiEnabled') ?? false;
  const codeWikiAvailable = codeWikiEnabled && hasCodeWikiIndex(rootPath);

  const messages: ChatMessage[] = [];
  let currentTask: string | null = question;

  while (currentTask) {
    if (currentTask !== question) {
      channel.appendLine(`\nFollow-up task: ${currentTask}`);
    }
    setTaskStatus('running', currentTask);

    let completedActions = 0;
    let roundCount = 0;
    let taskComplete = false;
    let errorMsg: string | null = null;

    try {
      if (messages.length === 0) {
        const workspaceStructure = getWorkspaceStructure(rootPath);
        const systemPrompt = buildDoSystemPrompt(
          workspaceStructure,
          wikiAvailable,
          codeWikiAvailable,
        );
        messages.push(
          { role: 'system', content: systemPrompt },
          { role: 'user', content: currentTask },
        );
      } else {
        messages.push({ role: 'user', content: currentTask });
      }

      while (roundCount < maxRounds && !abortController.signal.aborted) {
        channel.appendLine(`\n[Round ${roundCount + 1}/${maxRounds}]`);

        const roundEntry = addTimelineEntry({
          kind: 'round',
          title: `Round ${roundCount + 1} of ${maxRounds}`,
          status: 'pending',
        });

        channel.append('AI: ');
        const responseText = await getExtensionChatStreaming(messages, (chunk) => {
          channel.append(chunk);
          streamToEntry(roundEntry, chunk);
        });
        flushEntryStream(roundEntry);
        channel.appendLine('');
        updateTimelineEntry(roundEntry, { status: 'ok' });
        messages.push({ role: 'assistant', content: responseText });

        const actions = parseWorkspaceActions(responseText);
        if (actions === null) {
          channel.appendLine('Response was not a valid JSON action array — asking again.');
          addTimelineEntry({
            kind: 'info',
            title: 'Unreadable response — asking the model again',
            status: 'error',
          });
          messages.push({ role: 'user', content: INVALID_ACTIONS_FEEDBACK });
          roundCount++;
          continue;
        }
        if (actions.length === 0) {
          channel.appendLine('No actions returned. Done.');
          addTimelineEntry({
            kind: 'done',
            title: 'Task complete',
            detail: responseText.trim() ? _timelineSnippet(responseText) : undefined,
          });
          taskComplete = true;
          break;
        }

        const readActions = actions.filter(
          (a) =>
            a.type === 'view' ||
            a.type === 'list' ||
            a.type === 'search' ||
            a.type === 'wiki_search' ||
            a.type === 'code_search',
        );
        const writeActions = actions.filter(
          (a) =>
            a.type !== 'view' &&
            a.type !== 'list' &&
            a.type !== 'search' &&
            a.type !== 'wiki_search' &&
            a.type !== 'code_search',
        );

        const feedbackParts: string[] = [];

        // ── Read actions (no confirmation) ──────────────────────────────────────
        const viewResults: Record<string, string> = {};
        for (const action of readActions) {
          if (action.type === 'view' && action.paths) {
            for (const p of action.paths) {
              channel.appendLine(`Viewing: ${p}`);
              const entry = addTimelineEntry({
                kind: 'action',
                title: `View: ${p}`,
                status: 'pending',
              });
              try {
                const result = executeViewAction(
                  { ...action, path: p, paths: undefined },
                  rootPath,
                );
                viewResults[p] = result;
                updateTimelineEntry(entry, { status: 'ok', detail: _timelineSnippet(result) });
              } catch (e) {
                const msg = `Error: ${e instanceof Error ? e.message : 'Cannot read'}`;
                viewResults[p] = msg;
                updateTimelineEntry(entry, { status: 'error', detail: msg });
              }
            }
            continue;
          }

          const entry = addTimelineEntry({
            kind: 'action',
            title: _doReadLabel(action),
            status: 'pending',
          });
          try {
            if (action.type === 'wiki_search') {
              const q = action.query ?? '';
              channel.appendLine(`Wiki search: "${q}"`);
              const result =
                wikiPath && hasWikiIndex(wikiPath)
                  ? (await searchWiki(wikiPath, q)) || 'No wiki results found'
                  : 'Wiki not available — set askii.wikiPath and run Reload Wikis';
              viewResults[`wiki_search:${q}`] = result;
              updateTimelineEntry(entry, { status: 'ok', detail: _timelineSnippet(result) });
            } else if (action.type === 'code_search') {
              const q = action.query ?? '';
              channel.appendLine(`Code search: "${q}"`);
              const result = codeWikiAvailable
                ? (await searchCodeWiki(rootPath, q)) || 'No code wiki results found'
                : 'Code wiki not available — enable askii.codeWikiEnabled and run Reload Wikis';
              viewResults[`code_search:${q}`] = result;
              updateTimelineEntry(entry, { status: 'ok', detail: _timelineSnippet(result) });
            } else if (action.type === 'search') {
              channel.appendLine(`Search: "${action.pattern}"`);
              const result = executeSearchAction(action, rootPath);
              viewResults[`search:${action.pattern}`] = result;
              updateTimelineEntry(entry, { status: 'ok', detail: _timelineSnippet(result) });
            } else {
              channel.appendLine(
                `${action.type === 'list' ? 'Listing' : 'Viewing'}: ${action.path}`,
              );
              const result = executeViewAction(action, rootPath);
              viewResults[action.path!] = result;
              updateTimelineEntry(entry, { status: 'ok', detail: _timelineSnippet(result) });
            }
          } catch (e) {
            const msg = `Error: ${e instanceof Error ? e.message : 'Cannot read path'}`;
            viewResults[action.path ?? 'unknown'] = msg;
            updateTimelineEntry(entry, { status: 'error', detail: msg });
          }
        }

        if (Object.keys(viewResults).length > 0) {
          feedbackParts.push(`File/search results:\n${JSON.stringify(viewResults, null, 2)}`);
        }

        // ── Write actions (with confirmation) ───────────────────────────────────
        const actionResults: ActionResult[] = [];

        for (const action of writeActions) {
          if (abortController.signal.aborted) {break;}

          // run has no path — handle it before the sandbox check
          if (action.type === 'run') {
            channel.appendLine(`Run: ${action.command}`);
            const runEntry = addTimelineEntry({
              kind: 'action',
              title: `Run: ${action.command}`,
              status: 'pending',
            });
            const choice = await requestChoice(
              runEntry,
              'Run this command in the workspace?',
              ['Run', 'Skip'],
            );
            if (choice !== 'Run') {
              updateTimelineEntry(runEntry, { status: 'skipped' });
              actionResults.push({ action: `run:${action.command}`, status: 'skipped' });
              continue;
            }
            try {
              // Async exec: execSync would freeze the whole extension host
              // (including the Cancel button) for up to the 30 s timeout.
              const { exec } = await import('child_process');
              const { promisify } = await import('util');
              const { stdout: output } = await promisify(exec)(action.command!, {
                cwd: rootPath,
                encoding: 'utf-8',
                timeout: 30000,
              });
              channel.appendLine(`Run output: ${output.substring(0, 200)}`);
              updateTimelineEntry(runEntry, { status: 'ok', detail: _timelineSnippet(output, 500) });
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
              updateTimelineEntry(runEntry, { status: 'error', detail: _timelineSnippet(detail, 500) });
              actionResults.push({
                action: `run:${action.command}`,
                status: 'error',
                detail: detail.substring(0, 500),
              });
            }
            continue;
          }

          // Sandbox check
          let filePath: string;
          try {
            if (!action.path) {throw new Error(`${action.type} requires path`);}
            filePath = sandboxPath(rootPath, action.path);
          } catch (e) {
            const msg = e instanceof Error ? e.message : 'Path error';
            channel.appendLine(`BLOCKED: ${msg}`);
            addTimelineEntry({
              kind: 'error',
              title: `Blocked: ${_doConfirmMessage(action)}`,
              detail: msg,
            });
            actionResults.push({
              action: `${action.type}:${action.path}`,
              status: 'error',
              detail: msg,
            });
            continue;
          }

          // Confirmation for all other write actions — asked in the panel
          const confirmMsg = _doConfirmMessage(action);
          const writeEntry = addTimelineEntry({
            kind: 'action',
            title: confirmMsg,
            status: 'pending',
          });
          let confirmed = autoConfirm;
          if (!confirmed) {
            confirmed =
              (await requestChoice(writeEntry, undefined, ['Confirm', 'Skip'])) === 'Confirm';
          }

          if (!confirmed) {
            updateTimelineEntry(writeEntry, { status: 'skipped' });
            actionResults.push({ action: `${action.type}:${action.path}`, status: 'skipped' });
            continue;
          }

          try {
            const result = await _executeWriteAction(action, filePath, rootPath, formatAfterEdit);
            if (result === 'ok') {completedActions++;}
            actionResults.push({
              action: `${action.type}:${action.path}`,
              status: result === 'ok' ? 'ok' : 'error',
              detail: result === 'ok' ? undefined : result,
            });
            updateTimelineEntry(writeEntry, {
              title: _doActionLabel(action),
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
            updateTimelineEntry(writeEntry, { status: 'error', detail });
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

        if (feedbackParts.length === 0) {break;}

        messages.push({
          role: 'user',
          content:
            feedbackParts.join('\n\n') +
            '\n\nWhat would you like to do next? Respond with only a JSON array of actions or [] if done.',
        });

        roundCount++;
      }

      if (roundCount >= maxRounds && !taskComplete && !abortController.signal.aborted) {
        channel.appendLine(`Max rounds (${maxRounds}) reached.`);
        addTimelineEntry({ kind: 'info', title: `Max rounds (${maxRounds}) reached`, status: 'error' });
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        errorMsg = error instanceof Error ? error.message : 'Unknown error';
      }
    } finally {
      endTaskSession();
    }

    if (errorMsg) {
      channel.appendLine(`\nError: ${errorMsg}`);
      addTimelineEntry({ kind: 'error', title: 'ASKII Do failed', detail: errorMsg });
      setTaskStatus('error', errorMsg);
      vscode.window.showErrorMessage(`ASKII Do failed: ${errorMsg}`);
      sweepPendingEntries();
      break;
    }
    if (abortController.signal.aborted) {
      channel.appendLine(`\nCompleted ${completedActions} actions before stopping. (⌐■_■)`);
      addTimelineEntry({ kind: 'info', title: 'Stopped by user' });
      setTaskStatus('cancelled', `Completed ${completedActions} action(s) before stopping`);
      sweepPendingEntries();
      break;
    }

    setTaskStatus('done', `Completed ${completedActions} action(s)`);
    if (!taskComplete) {
      vscode.window.showInformationMessage(`ASKII Do: ${completedActions} actions completed.`);
    }

    // Keep-or-undo is answered in the panel; dismissing the panel keeps the
    // changes (matching the old dialog's Esc behavior).
    if (hasBackups(rootPath)) {
      const choiceEntry = addTimelineEntry({
        kind: 'confirm',
        title: `${completedActions} action(s) completed`,
        status: 'pending',
      });
      const choice = await requestChoice(
        choiceEntry,
        'Keep these changes?',
        ['Keep changes', 'Undo all'],
      );
      if (choice === 'Undo all') {
        const { restored, deleted } = restoreAllBackups(rootPath);
        deleteAllBackups(rootPath);
        channel.appendLine(
          `Undone — restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
        );
        updateTimelineEntry(choiceEntry, {
          status: 'ok',
          detail: `Restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
        });
        vscode.window.showInformationMessage(
          `ASKII Do: Restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
        );
      } else if (choice === 'Keep changes') {
        deleteAllBackups(rootPath);
        updateTimelineEntry(choiceEntry, { status: 'ok' });
      } else {
        updateTimelineEntry(choiceEntry, { status: 'skipped' });
      }
    }

    // Cancel pressed while the keep/undo choice was up ends the session.
    if (abortController.signal.aborted) {
      addTimelineEntry({ kind: 'info', title: 'Stopped by user' });
      setTaskStatus('cancelled', 'Stopped by user');
      sweepPendingEntries();
      break;
    }

    currentTask = await waitForFollowUp();
    if (currentTask && !beginTaskSession()) {
      // Another command took the panel over while we were idle
      break;
    }
  }
}

async function runBrowserTask(task: string) {
  if (!beginTaskSession()) {
    vscode.window.showInformationMessage('ASKII is already running a task — see the ASKII task panel.');
    return;
  }

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = config.get<number>('doMaxRounds') ?? 20;
  const autoConfirm = config.get<boolean>('doAutoConfirm') ?? false;
  const headless = config.get<boolean>('browserHeadless') ?? false;
  const chromePath = config.get<string>('chromePath') || detectBrowserExecutable();

  const outputChannel = vscode.window.createOutputChannel('ASKII Control (Browser)');
  outputChannel.appendLine(`ASKII Control (Browser) started ${getRandomThinkingKaomoji()}`);
  outputChannel.appendLine(`Task: ${task}`);
  outputChannel.appendLine('');

  const abortController = new AbortController();
  setTaskCanceller(() => {
    abortController.abort();
    outputChannel.appendLine('Stopped by user.');
  });

  acquireTaskPanel('ASKII Control (Browser)');

  const puppeteer = await import('puppeteer-core');
  let browser: import('puppeteer-core').Browser | undefined;
  let page: import('puppeteer-core').Page | undefined;

  let currentTask: string | null = task;

  while (currentTask) {
    if (currentTask !== task) {
      outputChannel.appendLine(`\nTask: ${currentTask}`);
    }
    setTaskStatus('running', currentTask);

    let round = 0;
    let taskComplete = false;
    let stoppedByChoice = false;
    let errorMsg: string | null = null;
    let errorLogged = false;

    try {
      // Relaunch if the user closed the window (or its tab) since the last task
      if (browser && (!browser.connected || !page || page.isClosed())) {
        await browser.close().catch(() => undefined);
        browser = undefined;
        page = undefined;
      }
      if (!browser) {
        if (!chromePath) {
          throw new Error(
            'No Chromium-based browser found. Install Chrome or Edge, or set askii.chromePath to your browser executable (e.g. C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe).',
          );
        }
        outputChannel.appendLine('Launching browser...');
        outputChannel.appendLine(`Browser executable: ${chromePath}`);
        browser = await puppeteer.launch({
          headless: headless ? true : false,
          executablePath: chromePath,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
        });

        const [firstPage] = await browser.pages();
        await firstPage.setViewport(null);
        page = firstPage;
      }

      while (round < maxRounds && !abortController.signal.aborted) {
        outputChannel.appendLine(`Round ${round + 1}/${maxRounds} — capturing screenshot...`);
        const roundEntry = addTimelineEntry({
          kind: 'round',
          title: `Round ${round + 1} of ${maxRounds}`,
          status: 'pending',
        });

        const imageBase64 = await takePageScreenshot(page!);
        const currentUrl = page!.url();

        outputChannel.appendLine(`Current URL: ${currentUrl}`);
        updateTimelineEntry(roundEntry, {
          screenshot: `data:image/png;base64,${imageBase64}`,
          detail: currentUrl,
        });

        const systemPrompt = buildBrowserSystemPrompt();
        const userPrompt =
          round === 0
            ? `Task: ${currentTask}\n\nCurrent URL: ${currentUrl}\n\nAnalyze the screenshot and determine the next action.`
            : `Continuing task: ${currentTask}\n\nCurrent URL: ${currentUrl}\n\nAnalyze the screenshot and return the next action or DONE.`;

        outputChannel.appendLine('Asking AI...');
        const rawResponse = await getExtensionResponseWithImage(
          `${systemPrompt}\n\n${userPrompt}`,
          imageBase64,
        );

        if (abortController.signal.aborted) {break;}

        const parsed = parseBrowserResponse(rawResponse);

        if (!parsed) {
          outputChannel.appendLine('Error: could not parse AI response.');
          outputChannel.appendLine(`Raw: ${rawResponse}`);
          addTimelineEntry({
            kind: 'error',
            title: 'Could not parse AI response',
            detail: _timelineSnippet(rawResponse, 1000),
          });
          errorMsg = 'Could not parse AI response.';
          errorLogged = true;
          break;
        }

        if (parsed.type === 'done') {
          outputChannel.appendLine(`\nDone! ${getRandomKaomoji()}`);
          outputChannel.appendLine(`Reasoning: ${parsed.reasoning}`);
          updateTimelineEntry(roundEntry, { status: 'ok' });
          addTimelineEntry({
            kind: 'done',
            title: 'Task complete',
            detail: parsed.reasoning || undefined,
          });
          taskComplete = true;
          break;
        }

        updateTimelineEntry(roundEntry, { status: 'ok' });

        let stopped = false;
        for (const action of parsed.actions) {
          if (abortController.signal.aborted) {
            stopped = true;
            break;
          }

          const description = describeBrowserAction(action);
          outputChannel.appendLine(`Action: ${description}`);
          outputChannel.appendLine(`Reasoning: ${action.reasoning}`);

          const actionEntry = addTimelineEntry({
            kind: 'action',
            title: description,
            detail: action.reasoning,
            status: 'pending',
          });

          if (!autoConfirm) {
            const choice = await requestChoice(actionEntry, undefined, ['Execute', 'Stop']);
            if (choice !== 'Execute' || abortController.signal.aborted) {
              outputChannel.appendLine('Stopped by user.');
              stopped = true;
              stoppedByChoice = true;
              updateTimelineEntry(actionEntry, { status: 'skipped' });
              break;
            }
          }

          try {
            await executeBrowserAction(action, page!);
            outputChannel.appendLine('Done.\n');
            updateTimelineEntry(actionEntry, { status: 'ok' });
          } catch (execErr) {
            const msg = execErr instanceof Error ? execErr.message : 'Unknown error';
            outputChannel.appendLine(`Action failed: ${msg}`);
            updateTimelineEntry(actionEntry, {
              status: 'error',
              detail: `${action.reasoning}\nFailed: ${msg}`.trim(),
            });
            vscode.window.showWarningMessage(
              `ASKII Control (Browser): ${description} failed — ${msg}`,
            );
          }
        }
        if (stopped) {break;}

        round++;
      }

      if (round >= maxRounds && !taskComplete && !abortController.signal.aborted) {
        outputChannel.appendLine(`Max rounds (${maxRounds}) reached.`);
        addTimelineEntry({
          kind: 'info',
          title: `Max rounds (${maxRounds}) reached`,
          status: 'error',
        });
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        errorMsg = error instanceof Error ? error.message : 'Unknown error';
      }
    } finally {
      endTaskSession();
    }

    if (errorMsg) {
      outputChannel.appendLine(`Error: ${errorMsg}`);
      if (!errorLogged) {
        addTimelineEntry({ kind: 'error', title: 'ASKII Control (Browser) failed', detail: errorMsg });
      }
      setTaskStatus('error', errorMsg);
      vscode.window.showErrorMessage(`ASKII Control (Browser) failed: ${errorMsg}`);
      sweepPendingEntries();
      break;
    }
    if (abortController.signal.aborted || stoppedByChoice) {
      addTimelineEntry({ kind: 'info', title: 'Stopped by user' });
      setTaskStatus('cancelled', 'Stopped by user');
      sweepPendingEntries();
      break;
    }

    setTaskStatus('done', taskComplete ? 'Task complete' : `Finished after ${round} round(s)`);
    currentTask = await waitForFollowUp();
    if (currentTask && !beginTaskSession()) {
      // Another command took the panel over while we were idle
      break;
    }
  }

  // The session is over. A headless browser is invisible and would otherwise
  // linger until VS Code exits; a visible one is left open for the user.
  if (browser && headless) {
    await browser.close().catch(() => undefined);
  }
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
      if (!action.newPath) {return 'copy requires newPath';}
      const destPath = sandboxPath(rootPath, action.newPath);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {fs.mkdirSync(destDir, { recursive: true });}
      backupOrRecordCreated(rootPath, destPath);
      fs.copyFileSync(filePath, destPath);
      return 'ok';
    }

    case 'create':
    case 'write': {
      // Either type may target an existing file — back it up rather than
      // recording it as created (undo would otherwise delete the original).
      backupOrRecordCreated(rootPath, filePath);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true });}
      fs.writeFileSync(filePath, decodeIfDoubleEscaped(action.content ?? ''));
      if (formatAfterEdit) {await _applyFormat(filePath);}
      return 'ok';
    }

    case 'modify': {
      const result = applyModifyAction(fs.readFileSync(filePath, 'utf-8'), action);
      if ('error' in result) {return result.error;}
      writeBackup(rootPath, filePath);
      fs.writeFileSync(filePath, result.text);
      if (formatAfterEdit) {await _applyFormat(filePath);}
      return 'ok';
    }

    case 'delete': {
      writeBackup(rootPath, filePath);
      fs.unlinkSync(filePath);
      return 'ok';
    }

    case 'rename': {
      if (!action.newPath) {return 'rename requires newPath';}
      writeBackup(rootPath, filePath);
      const newFilePath = sandboxPath(rootPath, action.newPath);
      const newDir = path.dirname(newFilePath);
      if (!fs.existsSync(newDir)) {fs.mkdirSync(newDir, { recursive: true });}
      backupOrRecordCreated(rootPath, newFilePath);
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

function _doReadLabel(action: WorkspaceAction): string {
  switch (action.type) {
    case 'view':
      return `View: ${action.path}`;
    case 'list':
      return `List: ${action.path}`;
    case 'search':
      return `Search: ${action.pattern}`;
    case 'wiki_search':
      return `Wiki search: ${action.query}`;
    case 'code_search':
      return `Code search: ${action.query}`;
    default:
      return action.type;
  }
}

// Timeline details are rendered as text — keep them readable, not exhaustive
function _timelineSnippet(text: string, max = 400): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.substring(0, max)}…` : trimmed;
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
  const wikiEnabled = config.get<boolean>('wikiEnabled') ?? false;
  const wikiPath = config.get<string>('wikiPath') ?? '';
  const codeWikiEnabled = config.get<boolean>('codeWikiEnabled') ?? false;

  if (!wikiEnabled && !codeWikiEnabled) {
    vscode.window.showInformationMessage(
      'ASKII: No wikis enabled — turn on Wiki RAG or Code Wiki in settings first.',
    );
    return;
  }

  const summaries: string[] = [];
  const warnings: string[] = [];
  const abortController = new AbortController();
  const { signal } = abortController;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ASKII: Reloading wikis...',
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => abortController.abort());
      const downloadProgress = (_file: string, receivedMB: number, totalMB: number) => {
        progress.report({
          message: `Downloading embedding model (${receivedMB.toFixed(0)}/${totalMB.toFixed(0)} MB)...`,
        });
      };

      // Docs wiki (vector index over .md files)
      if (wikiEnabled) {
        if (!wikiPath) {
          warnings.push('docs wiki skipped — set askii.wikiPath');
        } else if (!fs.existsSync(wikiPath)) {
          warnings.push(`docs wiki skipped — path not found: ${wikiPath}`);
        } else {
          try {
            progress.report({ message: 'Indexing wiki .md files...' });
            const stats = await buildWikiIndex(wikiPath, {
              onProgress: (stage, current, total) => {
                if (stage === 'indexing') {
                  progress.report({ message: `Wiki: file ${current}/${total}...` });
                }
              },
              onDownloadProgress: downloadProgress,
              signal,
            });
            summaries.push(`wiki: ${stats.chunkCount} chunks from ${stats.fileCount} file(s)`);
          } catch (error) {
            if (signal.aborted) return;
            warnings.push(
              `docs wiki failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }
      }

      // Code wiki (vector index over workspace code)
      if (codeWikiEnabled) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
          warnings.push('code wiki skipped — no workspace folder open');
        } else {
          try {
            progress.report({ message: 'Indexing workspace code (code wiki)...' });
            const stats = await rebuildCodeWikiIndex(root, {
              onProgress: (stage, current, total) => {
                if (stage === 'indexing') {
                  progress.report({ message: `Code wiki: file ${current}/${total}...` });
                }
              },
              onDownloadProgress: downloadProgress,
              signal,
            });
            summaries.push(
              `code wiki: ${stats.chunkCount} chunks from ${stats.fileCount} file(s) ` +
                `(${stats.embeddedFiles} embedded, ${stats.cachedFiles} reused)`,
            );
          } catch (error) {
            if (signal.aborted) return;
            warnings.push(
              `code wiki failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }
      }
    },
  );

  if (signal.aborted) {
    // Any wiki that finished before the cancel is still reported
    const done = summaries.length > 0 ? ` (completed — ${summaries.join(' — ')})` : '';
    vscode.window.showInformationMessage(
      `ASKII: Wiki reload cancelled — existing indexes kept${done}`,
    );
    return;
  }
  if (summaries.length > 0) {
    vscode.window.showInformationMessage(`ASKII: ${summaries.join(' — ')} (⌐■_■)`);
  }
  if (warnings.length > 0) {
    vscode.window.showWarningMessage(`ASKII: ${warnings.join(' — ')}`);
  }
}

export async function askiiControlCommand() {
  // First: pick what ASKII should control — the screen or the browser
  const mode = await vscode.window.showQuickPick<
    vscode.QuickPickItem & { target: 'screen' | 'browser' }
  >(
    [
      {
        label: '$(screen-full) Screen',
        description: 'Control the whole screen with mouse & keyboard',
        target: 'screen',
      },
      {
        label: '$(browser) Browser',
        description: 'Launch and control a Chrome browser',
        target: 'browser',
      },
    ],
    { placeHolder: 'What should ASKII control?' },
  );

  if (!mode) {return;}

  // Then: ask for the task
  const instruction = await vscode.window.showInputBox({
    prompt:
      mode.target === 'browser'
        ? 'Give ASKII a browser task'
        : 'Give ASKII a screen control instruction',
    placeHolder:
      mode.target === 'browser'
        ? 'e.g., Go to https://example.com and click Learn more'
        : 'e.g., Open Notepad and type hello world',
  });

  if (!instruction) {return;}

  if (mode.target === 'browser') {
    await runBrowserTask(instruction);
    return;
  }

  await runScreenControlTask(instruction);
}

async function runScreenControlTask(instruction: string) {
  const missingDeps = checkControlDependencies();
  if (missingDeps.length > 0) {
    vscode.window.showErrorMessage(
      `ASKII Control: missing required tools:\n${missingDeps.join('\n')}`,
    );
    return;
  }

  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = config.get<number>('doMaxRounds') ?? 20;
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
      if (!pick) {return;}
      monitorId = pick.id;
    }
  } catch {
    // proceed with default monitor
  }

  if (!beginTaskSession()) {
    vscode.window.showInformationMessage('ASKII is already running a task — see the ASKII task panel.');
    return;
  }

  const outputChannel = vscode.window.createOutputChannel('ASKII Control');
  outputChannel.appendLine(`ASKII Control started ${getRandomThinkingKaomoji()}`);
  outputChannel.appendLine(`Instruction: ${instruction}`);
  outputChannel.appendLine('');

  const abortController = new AbortController();
  const history: ControlHistoryEntry[] = [];
  let round = 0;
  let prevScreenshot: string | undefined;
  let systemInfo: SystemInfo | undefined;

  setTaskCanceller(() => {
    abortController.abort();
    outputChannel.appendLine('Stopped by user.');
  });

  acquireTaskPanel('ASKII Control');

  let currentTask: string | null = instruction;

  while (currentTask) {
    if (currentTask !== instruction) {
      outputChannel.appendLine(`\nInstruction: ${currentTask}`);
    }
    setTaskStatus('running', currentTask);

    round = 0;
    let taskComplete = false;
    let stoppedByChoice = false;
    let errorMsg: string | null = null;
    let errorLogged = false;

    try {
      while (round < maxRounds && !abortController.signal.aborted) {
        outputChannel.appendLine(`Round ${round + 1}/${maxRounds} — taking screenshot...`);
        const roundEntry = addTimelineEntry({
          kind: 'round',
          title: `Round ${round + 1} of ${maxRounds}`,
          status: 'pending',
        });

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

        updateTimelineEntry(roundEntry, {
          screenshot: `data:image/png;base64,${imageBase64}`,
          detail: screenChanged ? undefined : 'Screen unchanged since last action.',
        });

        const prompt =
          round === 0
            ? `Instruction to complete: ${currentTask}\n\nAnalyze the screenshot and determine the next action(s).`
            : `Continuing instruction: ${currentTask}\n\nAnalyze the updated screenshot and return the next action(s) or DONE.`;

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
          addTimelineEntry({
            kind: 'error',
            title: 'Could not parse AI response',
            detail: _timelineSnippet(rawResponse, 1000),
          });
          errorMsg = 'Could not parse AI response.';
          errorLogged = true;
          break;
        }

        if (parsed.type === 'done') {
          outputChannel.appendLine(`\nDone! ${getRandomKaomoji()}`);
          outputChannel.appendLine(`Reasoning: ${parsed.reasoning}`);
          updateTimelineEntry(roundEntry, { status: 'ok' });
          addTimelineEntry({
            kind: 'done',
            title: 'Task complete',
            detail: parsed.reasoning || undefined,
          });
          taskComplete = true;
          break;
        }

        updateTimelineEntry(roundEntry, { status: 'ok' });

        const { actions } = parsed;

        // Planned actions show in the timeline before the batch confirmation
        const plannedEntries = actions.map((a) =>
          addTimelineEntry({
            kind: 'action',
            title: describeAction(a as ControlAction),
            detail: a.reasoning,
            status: 'pending',
          }),
        );
        actions.forEach((a, i) => {
          const label = actions.length > 1 ? `Action ${i + 1}/${actions.length}` : 'Action';
          outputChannel.appendLine(`${label}: ${describeAction(a as ControlAction)}`);
          outputChannel.appendLine(`Reasoning: ${a.reasoning}`);
        });

        // Confirm
        if (!autoConfirm) {
          const batchLabel =
            actions.length === 1
              ? describeAction(actions[0] as ControlAction)
              : `${actions.length} actions`;
          const confirmTarget =
            plannedEntries.length > 0 ? plannedEntries[plannedEntries.length - 1] : roundEntry;
          const choice = await requestChoice(confirmTarget, `Execute ${batchLabel}?`, [
            'Execute',
            'Stop',
          ]);
          if (choice !== 'Execute' || abortController.signal.aborted) {
            outputChannel.appendLine('Stopped by user.');
            stoppedByChoice = true;
            for (const id of plannedEntries) {
              updateTimelineEntry(id, { status: 'skipped' });
            }
            break;
          }
          // Small delay between confirmation and execution
          await new Promise<void>((resolve) => setTimeout(resolve, 1500));
        }

        // Resolve click_text actions to coordinates via a second LLM call
        for (let i = 0; i < actions.length; i++) {
          const a = actions[i] as ControlAction;
          if (a.action === 'click_text') {
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
                  updateTimelineEntry(plannedEntries[i], {
                    detail: `Resolved "${ct.text}" → (${coords.x}, ${coords.y})`,
                  });
                }
              }
            } catch {
              outputChannel.appendLine(
                `Warning: could not resolve text "${ct.text}" to coordinates`,
              );
              addTimelineEntry({
                kind: 'info',
                title: `Could not resolve "${ct.text}" to coordinates`,
                status: 'error',
              });
            }
          }
        }

        // Execute sequence
        for (let i = 0; i < actions.length; i++) {
          const a = actions[i] as ControlAction;
          if (abortController.signal.aborted) {break;}
          await executeControlAction(a, screenW, screenH, abortController.signal);
          history.push({
            round: round + 1,
            description: describeAction(a),
            reasoning: a.reasoning,
            screenChanged: true,
          });
          updateTimelineEntry(plannedEntries[i], { status: 'ok' });
        }
        outputChannel.appendLine('Done.\n');

        round++;
      }

      if (round >= maxRounds && !taskComplete && !abortController.signal.aborted) {
        outputChannel.appendLine(`Max rounds (${maxRounds}) reached.`);
        addTimelineEntry({
          kind: 'info',
          title: `Max rounds (${maxRounds}) reached`,
          status: 'error',
        });
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        errorMsg = error instanceof Error ? error.message : 'Unknown error';
      }
    } finally {
      endTaskSession();
    }

    if (errorMsg) {
      outputChannel.appendLine(`Error: ${errorMsg}`);
      if (!errorLogged) {
        addTimelineEntry({ kind: 'error', title: 'ASKII Control failed', detail: errorMsg });
      }
      setTaskStatus('error', errorMsg);
      vscode.window.showErrorMessage(`ASKII Control failed: ${errorMsg}`);
      sweepPendingEntries();
      break;
    }
    if (abortController.signal.aborted || stoppedByChoice) {
      addTimelineEntry({ kind: 'info', title: 'Stopped by user' });
      setTaskStatus('cancelled', 'Stopped by user');
      sweepPendingEntries();
      break;
    }

    setTaskStatus('done', taskComplete ? 'Task complete' : `Finished after ${round} round(s)`);
    currentTask = await waitForFollowUp();
    if (currentTask && !beginTaskSession()) {
      // Another command took the panel over while we were idle
      break;
    }
  }
}
