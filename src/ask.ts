import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';
import MarkdownIt from 'markdown-it';
import { getExtensionResponseStreaming } from './providers';
import { escapeHtml } from '@common/utils';
import {
  autoLinkFileReferences,
  makePathResolver,
  parseLocationHref,
  FILE_CITATION_INSTRUCTIONS,
} from '@common/links';
import { getCodeWikiContext, getWikiContext } from './commandUtils';

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
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
  <style nonce="${nonce}">${css}</style>
</head>
<body>
  <div class="header-row">
    <h2 id="title">ASKII is thinking... (๑•﹏•)</h2>
    <div class="btn-group">
      <button id="stopBtn" class="icon-btn" title="Stop generating">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="6" y="6" width="12" height="12" rx="1"></rect>
        </svg>
      </button>
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
    const stopBtn = document.getElementById('stopBtn');
    stopBtn.style.display = 'inline-flex';
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
      // Stop is the opposite: only while an answer is being generated
      stopBtn.style.display = visible ? 'none' : 'inline-flex';
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
        stopBtn.style.display = 'none';
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
    stopBtn.addEventListener('click', () => {
      stopBtn.style.display = 'none';
      vscode.postMessage({ type: 'stop' });
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
          post({ type: 'copied' });
        },
        () => {
          post({ type: 'copyFailed' });
        },
      );
    } else if (msg.type === 'stop') {
      turnController?.abort();
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
      post({ type: 'history', html });
    }
  });

  const codeContext = hasSelection
    ? `File: ${fileName}\nLanguage: ${languageId}\nCode:\n\`\`\`${languageId}\n${selectedText}\n\`\`\`\n\n`
    : '';
  let history = '';
  let currentQuestion = question;
  let panelDisposed = false;
  // The in-flight answer's request — aborted by Stop or by closing the panel
  let turnController: AbortController | undefined;
  panel.onDidDispose(() => {
    panelDisposed = true;
    turnController?.abort();
  });
  // postMessage on a disposed webview throws — every send goes through here
  const post = (message: unknown): void => {
    if (panelDisposed) {return;}
    try {
      void panel.webview.postMessage(message).then(undefined, () => undefined);
    } catch {
      // disposed between the check and the call
    }
  };

  while (!panelDisposed) {
    const wikiCtx = await getWikiContext(currentQuestion);
    const wikiSection = wikiCtx ? `Relevant documentation:\n${wikiCtx}\n\n` : '';
    const codeWikiCtx = await getCodeWikiContext(currentQuestion);
    const codeWikiSection = codeWikiCtx ? `Relevant code from the codebase:\n${codeWikiCtx}\n\n` : '';
    const fullPrompt =
      wikiSection + codeWikiSection + codeContext + history + `Question: ${currentQuestion}`;
    let accumulated = '';
    const controller = new AbortController();
    turnController = controller;

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
              post({ type: 'update', html: renderAccumulated() });
            }, 50);
          }
        },
        'You are ASKII, a precise coding assistant. Answer concisely.\n\n' +
        FILE_CITATION_INSTRUCTIONS,
        controller.signal,
      ).finally(() => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
      });

      history += `Question: ${currentQuestion}\n\nAnswer: ${accumulated}\n\n`;
      conversation.push({ question: currentQuestion, answer: accumulated });
      post({ type: 'done', html: renderAccumulated(), text: accumulated });
    } catch (error) {
      if (panelDisposed) {
        break;
      }
      if (controller.signal.aborted) {
        // Stopped: keep what arrived so far and allow a follow-up
        const partial = accumulated ? `${accumulated}\n\n*(stopped)*` : '*(stopped)*';
        if (accumulated) {
          history += `Question: ${currentQuestion}\n\nAnswer: ${accumulated}\n\n`;
          conversation.push({ question: currentQuestion, answer: accumulated });
        }
        accumulated = partial;
        post({ type: 'done', html: renderAccumulated(), text: partial });
      } else {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        post({ type: 'error', html: `<p>${escapeHtml(errorMsg)}</p>` });
        break;
      }
    } finally {
      turnController = undefined;
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
        post({ type: 'cancelled' });
        continue;
      }
      nextQuestion = answer;
    }

    if (nextQuestion === null) {
      break;
    }
    currentQuestion = nextQuestion;
    post({ type: 'thinking' });
  }
}
