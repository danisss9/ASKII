import * as vscode from 'vscode';
import { mediaRoot, webviewAssets } from './webviewAssets';
import { getAskPanelHtml } from './askPanelHtml';
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




  const panel = vscode.window.createWebviewPanel(
    'askiiOutput',
    'ASKII Response',
    vscode.ViewColumn.Beside,
    { enableScripts: true, localResourceRoots: [mediaRoot()] },
  );

  panel.webview.html = getAskPanelHtml(nonce, webviewAssets(panel.webview, 'ask'));

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
