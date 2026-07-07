import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { type NoteEntry, searchNotes } from '@common/notes';
import {
  loadNotes,
  saveNotes,
  captureContext,
  captureScreenshot,
  classifyNoteInput,
  buildEntry,
} from './notes';
import { rescheduleAll, onNotesChanged } from './notesScheduler';
import { escapeHtml } from '@common/utils';
import { getRandomKaomoji, getRandomThinkingKaomoji } from '@common/kaomoji';

// ── Single-instance panel ────────────────────────────────────────────────────

let currentPanel: vscode.WebviewPanel | undefined;
let currentContext: vscode.ExtensionContext | undefined;
let notesChangedSub: vscode.Disposable | undefined;

export async function askiiNoteCommand(
  context: vscode.ExtensionContext,
  args?: { selectId?: string },
): Promise<void> {
  currentContext = context;

  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active, false);
    if (args?.selectId) {
      currentPanel.webview.postMessage({ type: 'selectEntry', id: args.selectId });
    }
    refreshList();
    return;
  }

  const nonce = randomBytes(16).toString('base64');

  const panel = vscode.window.createWebviewPanel(
    'askiiNote',
    `ASKII Note ${getRandomKaomoji()}`,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [context.globalStorageUri],
    },
  );
  panel.iconPath = vscode.Uri.parse(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>',
      ),
  );

  panel.webview.html = getHtml(nonce, panel.webview);

  panel.webview.onDidReceiveMessage((msg) => handleWebviewMessage(panel, context, msg));

  panel.onDidDispose(() => {
    currentPanel = undefined;
    notesChangedSub?.dispose();
    notesChangedSub = undefined;
  });

  currentPanel = panel;

  notesChangedSub = onNotesChanged(() => refreshList());

  // Initial list
  refreshList();
  if (args?.selectId) {
    panel.webview.postMessage({ type: 'selectEntry', id: args.selectId });
  }
}

// ── List refresh ─────────────────────────────────────────────────────────────

function refreshList(query?: string): void {
  if (!currentPanel || !currentContext) return;
  const notes = loadNotes(currentContext);
  const results = searchNotes(query ?? '', notes);
  const entries = results.map((r) => {
    const n = r.entry;
    let screenshotUri: string | undefined;
    if (n.screenshotPath && currentPanel) {
      screenshotUri = currentPanel.webview
        .asWebviewUri(vscode.Uri.file(n.screenshotPath))
        .toString();
    }
    return { ...n, screenshotUri };
  });
  currentPanel.webview.postMessage({ type: 'entries', entries });
}

// ── Message handler ───────────────────────────────────────────────────────────

async function handleWebviewMessage(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  msg: unknown,
): Promise<void> {
  if (typeof msg !== 'object' || msg === null) return;
  const m = msg as { type: string; [k: string]: unknown };

  switch (m.type) {
    case 'requestList': {
      refreshList(typeof m.query === 'string' ? m.query : undefined);
      break;
    }

    case 'submit': {
      const text = typeof m.text === 'string' ? m.text.trim() : '';
      if (!text) break;
      const attachScreenshot = m.attachScreenshot === true;
      panel.webview.postMessage({ type: 'status', status: 'thinking' });

      const ctx = captureContext();
      let screenshotPath: string | undefined;
      if (attachScreenshot) {
        screenshotPath = await captureScreenshot(context);
      }

      let cls = await classifyNoteInput(text, ctx);
      // Clarifying-question loop (max 2 rounds)
      let rounds = 0;
      while (cls.needsClarification && cls.clarifyingQuestion && rounds < 2) {
        panel.webview.postMessage({
          type: 'clarify',
          question: cls.clarifyingQuestion,
        });
        const answer = await waitForClarifyAnswer(panel);
        if (answer === null) {
          // user cancelled the clarification — save as a plain note
          cls = {
            kind: 'note',
            priority: null,
            dueAt: null,
            tags: cls.tags,
            needsClarification: false,
            clarifyingQuestion: null,
            summary: text.slice(0, 80),
          };
          break;
        }
        const combined = `${text}\n\n[clarified: ${answer}]`;
        cls = await classifyNoteInput(combined, ctx);
        rounds++;
      }

      const entry = buildEntry(text, cls, ctx, screenshotPath);
      const notes = loadNotes(context);
      notes.push(entry);
      saveNotes(context, notes);
      rescheduleAll(notes);

      panel.webview.postMessage({ type: 'status', status: 'done', kaomoji: getRandomKaomoji() });
      refreshList();
      break;
    }

    case 'deleteEntry': {
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) break;
      const notes = loadNotes(context).filter((n) => n.id !== id);
      saveNotes(context, notes);
      rescheduleAll(notes);
      refreshList();
      break;
    }

    case 'toggleTask': {
      const id = typeof m.id === 'string' ? m.id : '';
      if (!id) break;
      const notes = loadNotes(context);
      const i = notes.findIndex((n) => n.id === id);
      if (i !== -1 && notes[i].kind === 'task') {
        notes[i].done = !notes[i].done;
        saveNotes(context, notes);
      }
      refreshList();
      break;
    }

    case 'openScreenshot': {
      const p = typeof m.path === 'string' ? m.path : '';
      if (p) {
        const uri = vscode.Uri.file(p);
        await vscode.commands.executeCommand('vscode.open', uri);
      }
      break;
    }
  }
}

function waitForClarifyAnswer(panel: vscode.WebviewPanel): Promise<string | null> {
  return new Promise((resolve) => {
    const disp = panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as { type: string; answer?: unknown };
      if (m.type === 'clarifyAnswer') {
        disp.dispose();
        resolve(typeof m.answer === 'string' && m.answer.trim() ? m.answer.trim() : null);
      } else if (m.type === 'clarifyCancel') {
        disp.dispose();
        resolve(null);
      }
    });
  });
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function getHtml(nonce: string, _webview: vscode.Webview): string {
  const css = `
    body {
      font-family: var(--vscode-font-family, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }
    header {
      padding: 10px 14px;
      border-bottom: 1px solid var(--vscode-editorWidget-border, #333);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    header h1 { font-size: 1em; margin: 0; opacity: 0.9; font-weight: 600; }
    #status { font-size: 0.85em; opacity: 0.7; margin-left: auto; }
    #search {
      padding: 8px 12px;
      border: none;
      border-bottom: 1px solid var(--vscode-editorWidget-border, #333);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: 0.95em;
      outline: none;
    }
    #search::placeholder { color: var(--vscode-input-placeholderForeground); }
    #list {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }
    .entry {
      border: 1px solid var(--vscode-editorWidget-border, #333);
      border-radius: 6px;
      padding: 10px 12px;
      margin-bottom: 8px;
      background: var(--vscode-editor-inactiveSelectionBackground, transparent);
    }
    .entry.selected { outline: 2px solid var(--vscode-focusBorder, #007acc); }
    .entry-head {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
      font-size: 0.8em;
      opacity: 0.85;
    }
    .kind { font-weight: 600; }
    .kind.note { color: var(--vscode-textLink-foreground, #4daafc); }
    .kind.task { color: var(--vscode-terminal-ansiYellow, #d7ba7d); }
    .kind.reminder { color: var(--vscode-terminal-ansiRed, #f48771); }
    .badge {
      font-size: 0.75em;
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
    }
    .badge.high { background: #c0392b; }
    .badge.medium { background: #d68910; }
    .badge.low { background: #28a745; }
    .badge.done { background: #28a745; }
    .badge.missed { background: #c0392b; }
    .ws-tag { margin-left: auto; opacity: 0.6; }
    .entry-text { white-space: pre-wrap; word-break: break-word; margin: 4px 0; }
    .entry-summary { font-weight: 600; margin-bottom: 2px; }
    .entry-meta { font-size: 0.75em; opacity: 0.6; margin-top: 4px; }
    .entry-actions { margin-top: 6px; display: flex; gap: 6px; }
    .entry-actions button {
      background: none;
      border: 1px solid var(--vscode-editorWidget-border, #555);
      color: var(--vscode-foreground);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8em;
    }
    .entry-actions button:hover { background: var(--vscode-button-hoverBackground, #2a2a2a); }
    .thumb {
      max-width: 160px;
      max-height: 90px;
      margin-top: 6px;
      border: 1px solid var(--vscode-editorWidget-border, #555);
      border-radius: 4px;
      cursor: pointer;
    }
    .ctx {
      font-size: 0.75em;
      opacity: 0.6;
      margin-top: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      background: var(--vscode-textCodeBlock-background, #1e1e1e);
      padding: 4px 6px;
      border-radius: 3px;
      white-space: pre-wrap;
      max-height: 80px;
      overflow: hidden;
    }
    footer {
      border-top: 1px solid var(--vscode-editorWidget-border, #333);
      padding: 10px;
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }
    #input {
      flex: 1;
      min-height: 60px;
      max-height: 160px;
      resize: vertical;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #555));
      border-radius: 4px;
      padding: 8px;
      font-family: inherit;
      font-size: 0.95em;
      outline: none;
    }
    #input:focus { border-color: var(--vscode-focusBorder, #007acc); }
    #input::placeholder { color: var(--vscode-input-placeholderForeground); }
    .btn {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 4px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 0.9em;
      white-space: nowrap;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    .btn.secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    .clarify-overlay {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.5);
      display: none;
      align-items: center; justify-content: center;
      z-index: 10;
    }
    .clarify-overlay.show { display: flex; }
    .clarify-box {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-editorWidget-border, #555);
      border-radius: 8px;
      padding: 16px;
      max-width: 420px;
      width: 90%;
    }
    .clarify-box p { margin: 0 0 10px 0; }
    .clarify-box input {
      width: 100%; box-sizing: border-box;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #555));
      border-radius: 4px; padding: 8px; font-family: inherit;
    }
    .clarify-box .clarify-actions { margin-top: 10px; display: flex; gap: 8px; justify-content: flex-end; }
    .empty { text-align: center; opacity: 0.5; padding: 40px 20px; }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${_webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
  <style>${css}</style>
</head>
<body>
  <header>
    <h1>ASKII Note (⌐■_■)</h1>
    <span id="status"></span>
  </header>
  <input id="search" type="text" placeholder="🔍 Search notes, tasks, reminders…" />
  <div id="list"><div class="empty">No notes yet. Type below to add one. (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧</div></div>
  <footer>
    <textarea id="input" placeholder="Write a note, task, or reminder… e.g. &#10;• 'API rate limit is 100 req/min'&#10;• 'task: fix login bug, high priority'&#10;• 'remind me to check the build in 30 minutes'"></textarea>
    <button id="shotBtn" class="btn secondary" title="Attach a full-screen screenshot">📎 Shot</button>
    <button id="sendBtn" class="btn">Send</button>
  </footer>

  <div id="clarifyOverlay" class="clarify-overlay">
    <div class="clarify-box">
      <p id="clarifyQuestion"></p>
      <input id="clarifyInput" type="text" />
      <div class="clarify-actions">
        <button id="clarifyCancel" class="btn secondary">Cancel</button>
        <button id="clarifyOk" class="btn">Answer</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let attachShot = false;
    let pendingClarify = null;

    const listEl = document.getElementById('list');
    const inputEl = document.getElementById('input');
    const searchEl = document.getElementById('search');
    const statusEl = document.getElementById('status');

    function setStatus(text) { statusEl.textContent = text || ''; }

    function fmtDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      const now = new Date();
      const diff = d - now;
      const abs = Math.abs(diff);
      const days = Math.floor(abs / 86400000);
      const hrs = Math.floor((abs % 86400000) / 3600000);
      const mins = Math.floor((abs % 3600000) / 60000);
      let rel;
      if (days > 0) rel = days + 'd ' + hrs + 'h';
      else if (hrs > 0) rel = hrs + 'h ' + mins + 'm';
      else rel = mins + 'm';
      const prefix = diff >= 0 ? 'in ' : 'overdue ';
      return d.toLocaleString() + ' (' + prefix + rel + ')';
    }

    function kindIcon(kind) {
      return kind === 'task' ? '✓ task' : kind === 'reminder' ? '⏰ reminder' : '📝 note';
    }

    function renderEntry(n) {
      const div = document.createElement('div');
      div.className = 'entry' + (n.selected ? ' selected' : '');
      div.dataset.id = n.id;

      const head = document.createElement('div');
      head.className = 'entry-head';
      const kindSpan = document.createElement('span');
      kindSpan.className = 'kind ' + n.kind;
      kindSpan.textContent = kindIcon(n.kind);
      head.appendChild(kindSpan);

      if (n.kind === 'task' && n.priority) {
        const b = document.createElement('span');
        b.className = 'badge ' + n.priority;
        b.textContent = n.priority;
        head.appendChild(b);
      }
      if (n.kind === 'task' && n.done) {
        const b = document.createElement('span');
        b.className = 'badge done';
        b.textContent = 'done';
        head.appendChild(b);
      }
      if (n.kind === 'reminder' && n.missed) {
        const b = document.createElement('span');
        b.className = 'badge missed';
        b.textContent = 'missed';
        head.appendChild(b);
      }
      if (n.tags && n.tags.length) {
        const t = document.createElement('span');
        t.className = 'badge';
        t.textContent = '#' + n.tags.join(' #');
        head.appendChild(t);
      }
      if (n.workspaceTag) {
        const w = document.createElement('span');
        w.className = 'ws-tag';
        w.textContent = '📁 ' + n.workspaceTag;
        head.appendChild(w);
      }
      div.appendChild(head);

      if (n.summary) {
        const s = document.createElement('div');
        s.className = 'entry-summary';
        s.textContent = n.summary;
        div.appendChild(s);
      }
      const txt = document.createElement('div');
      txt.className = 'entry-text';
      txt.textContent = n.text;
      div.appendChild(txt);

      if (n.kind === 'reminder' && n.dueAt) {
        const meta = document.createElement('div');
        meta.className = 'entry-meta';
        meta.textContent = '⏰ ' + fmtDate(n.dueAt) + (n.fired ? ' · fired' : '');
        div.appendChild(meta);
      }
      if (n.context && (n.context.fileName || n.context.selectedText)) {
        const ctx = document.createElement('div');
        ctx.className = 'ctx';
        const parts = [];
        if (n.context.fileName) parts.push('📄 ' + n.context.fileName + (n.context.languageId ? ' (' + n.context.languageId + ')' : ''));
        if (n.context.selectedText) parts.push('✂ ' + n.context.selectedText.slice(0, 200));
        ctx.textContent = parts.join('\\n');
        div.appendChild(ctx);
      }
      if (n.screenshotUri) {
        const img = document.createElement('img');
        img.className = 'thumb';
        img.src = n.screenshotUri;
        img.title = 'Click to open screenshot';
        img.addEventListener('click', () => {
          vscode.postMessage({ type: 'openScreenshot', path: n.screenshotPath });
        });
        div.appendChild(img);
      }

      const actions = document.createElement('div');
      actions.className = 'entry-actions';
      if (n.kind === 'task') {
        const tb = document.createElement('button');
        tb.textContent = n.done ? 'Mark undone' : 'Mark done';
        tb.addEventListener('click', () => vscode.postMessage({ type: 'toggleTask', id: n.id }));
        actions.appendChild(tb);
      }
      const del = document.createElement('button');
      del.textContent = '🗑 Delete';
      del.addEventListener('click', () => vscode.postMessage({ type: 'deleteEntry', id: n.id }));
      actions.appendChild(del);
      div.appendChild(actions);

      return div;
    }

    function renderList(entries) {
      listEl.innerHTML = '';
      if (!entries || entries.length === 0) {
        const e = document.createElement('div');
        e.className = 'empty';
        e.textContent = searchEl.value ? 'No matches. (╥﹏╥)' : 'No notes yet. Type below to add one. (ﾉ◕ヮ◕)ﾉ*:･ﾟ✧';
        listEl.appendChild(e);
        return;
      }
      for (const n of entries) listEl.appendChild(renderEntry(n));
    }

    function send() {
      const text = inputEl.value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'submit', text, attachScreenshot: attachShot });
      inputEl.value = '';
      attachShot = false;
      document.getElementById('shotBtn').style.background = '';
      setStatus('thinking… (๑•﹏•)');
    }

    document.getElementById('sendBtn').addEventListener('click', send);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    });

    document.getElementById('shotBtn').addEventListener('click', () => {
      attachShot = !attachShot;
      const btn = document.getElementById('shotBtn');
      btn.style.background = attachShot ? 'var(--vscode-button-background, #0e639c)' : '';
      btn.textContent = attachShot ? '📎 Shot ✓' : '📎 Shot';
    });

    let searchTimer;
    searchEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        vscode.postMessage({ type: 'requestList', query: searchEl.value });
      }, 150);
    });

    // Clarify overlay
    document.getElementById('clarifyOk').addEventListener('click', () => {
      const v = document.getElementById('clarifyInput').value.trim();
      document.getElementById('clarifyOverlay').classList.remove('show');
      vscode.postMessage({ type: 'clarifyAnswer', answer: v });
      document.getElementById('clarifyInput').value = '';
    });
    document.getElementById('clarifyCancel').addEventListener('click', () => {
      document.getElementById('clarifyOverlay').classList.remove('show');
      vscode.postMessage({ type: 'clarifyCancel' });
      document.getElementById('clarifyInput').value = '';
    });
    document.getElementById('clarifyInput').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('clarifyOk').click();
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (typeof msg !== 'object' || msg === null) return;
      if (msg.type === 'entries') {
        renderList(msg.entries);
      } else if (msg.type === 'status') {
        if (msg.status === 'thinking') setStatus('thinking… (๑•﹏•)');
        else if (msg.status === 'done') setStatus(msg.kaomoji ? 'saved ' + msg.kaomoji : 'saved');
      } else if (msg.type === 'clarify') {
        document.getElementById('clarifyQuestion').textContent = msg.question;
        document.getElementById('clarifyOverlay').classList.add('show');
        document.getElementById('clarifyInput').focus();
      } else if (msg.type === 'selectEntry') {
        const el = listEl.querySelector('.entry[data-id="' + msg.id + '"]');
        if (el) { el.classList.add('selected'); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      }
    });

    vscode.postMessage({ type: 'requestList' });
    inputEl.focus();
  </script>
</body>
</html>`;
}
