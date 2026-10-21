import * as vscode from 'vscode';
import { webviewAssets } from './webviewAssets';

/**
 * Builds the ASKII Note webview HTML (redesigned UI). Kept separate from
 * notesPanel.ts so the panel lifecycle / message handling stays readable.
 *
 * All colors come from VS Code theme variables so the panel adapts to any
 * theme (light / dark / high contrast). Icons are inline SVGs — no font or
 * image assets, CSP-safe.
 */
export function getNotePanelHtml(
  nonce: string,
  webview: vscode.Webview,
  titleKaomoji: string,
  snoozeMinutes: number,
): string {
  const assets = webviewAssets(webview, 'notesPanel', { snoozeMinutes });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${assets.cspSource}; script-src 'nonce-${nonce}'">
  <link rel="stylesheet" href="${assets.style}">
</head>
<body>
  <header>
    <h1>ASKII Note<span class="kao">${titleKaomoji}</span></h1>
    <span id="status" class="status-pill" role="status"></span>
  </header>

  <div class="toolbar">
    <div class="search-wrap">
      <span class="lead-ic"></span>
      <input id="search" type="text" placeholder="Search notes, tasks, reminders…" />
      <button id="clearSearch" class="icon-btn" title="Clear search" aria-label="Clear search"></button>
    </div>
    <div class="chips">
      <button class="chip active" id="chipAll" title="Show all entries">All</button>
      <button class="chip" data-kind="note" title="Show only notes"></button>
      <button class="chip" data-kind="task" title="Show only tasks"></button>
      <button class="chip" data-kind="reminder" title="Show only reminders"></button>
      <span class="task-counter" id="taskCounter" title="Tasks completed"></span>
    </div>
  </div>

  <main id="list"></main>

  <footer>
    <div class="hints">
      <button class="hint" data-prefix="" title="Plain note (no prefix)">plain note</button>
      <button class="hint" data-prefix="task: " title="Prepend the task prefix">task:</button>
      <button class="hint" data-prefix="remind me to " title="Prepend the reminder prefix">remind me to…</button>
      <button class="hint" data-prefix="every day at 9am " title="Prepend a recurring trigger">every day…</button>
      <button class="hint" data-prefix="when I open VS Code, " title="Prepend an event trigger">when I open…</button>
    </div>
    <div class="composer">
      <textarea id="input" rows="1" placeholder="Write a note, task, or reminder…"></textarea>
      <button id="shotBtn" class="icon-btn" title="Attach a full-screen screenshot" aria-label="Attach screenshot" aria-pressed="false"></button>
      <button id="sendBtn" class="btn" title="Send (Enter · Shift+Enter for a new line)">Send</button>
    </div>
  </footer>

  <div id="clarifyOverlay" class="clarify-overlay">
    <div class="clarify-box">
      <div class="clarify-kao">(・_・?)</div>
      <p id="clarifyQuestion"></p>
      <input id="clarifyInput" type="text" />
      <div class="clarify-actions">
        <button id="clarifyCancel" class="btn secondary">Cancel</button>
        <button id="clarifyOk" class="btn">Answer</button>
      </div>
    </div>
  </div>

  <script id="askii-data" type="application/json">${assets.data}</script>
  <script nonce="${nonce}" src="${assets.script}"></script>
</body>
</html>`;
}
