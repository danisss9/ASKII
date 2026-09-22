import * as vscode from 'vscode';

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
  const css = `
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      font-family: var(--vscode-font-family, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      display: flex;
      flex-direction: column;
    }
    button { font-family: inherit; }
    :focus { outline: none; }
    :focus-visible { outline: 1px solid var(--vscode-focusBorder, #007acc); outline-offset: 1px; }

    /* ── Header ─────────────────────────────────────────────────────────── */
    header {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--vscode-editorWidget-border, #333);
      flex: none;
    }
    header h1 { font-size: 1em; margin: 0; font-weight: 600; letter-spacing: .02em; }
    .kao { opacity: .85; font-weight: 400; margin-left: 4px; }
    .status-pill {
      margin-left: auto; display: inline-flex; align-items: center; gap: 7px;
      font-size: .85em; color: var(--vscode-descriptionForeground, #999);
      min-height: 18px;
    }
    .spinner {
      width: 11px; height: 11px; border-radius: 50%;
      border: 2px solid var(--vscode-editorWidget-border, #444);
      border-top-color: var(--vscode-foreground, #ccc);
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Toolbar: search + filter chips ─────────────────────────────────── */
    .toolbar {
      flex: none; padding: 10px 16px 8px;
      display: flex; flex-direction: column; gap: 8px;
      border-bottom: 1px solid var(--vscode-editorWidget-border, #333);
    }
    .search-wrap {
      display: flex; align-items: center; gap: 6px;
      background: var(--vscode-input-background, #222);
      color: var(--vscode-input-placeholderForeground, #888);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #333));
      border-radius: 6px; padding: 0 4px 0 8px;
      transition: border-color .12s;
    }
    .search-wrap:focus-within { border-color: var(--vscode-focusBorder, #007acc); }
    .search-wrap .lead-ic { display: inline-flex; }
    #search {
      flex: 1; border: none; background: transparent; outline: none;
      color: var(--vscode-input-foreground, #eee);
      font-family: inherit; font-size: .95em; padding: 6px 0; min-width: 0;
    }
    #search::placeholder { color: var(--vscode-input-placeholderForeground, #777); }
    #clearSearch { display: none; }
    #clearSearch.show { display: inline-flex; }

    .chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .chip {
      display: inline-flex; align-items: center; gap: 5px;
      border: 1px solid var(--vscode-editorWidget-border, #444);
      border-radius: 999px; background: transparent;
      color: var(--vscode-foreground, #ddd);
      font-size: .85em; padding: 2px 10px; cursor: pointer;
      transition: background-color .12s, color .12s, border-color .12s;
    }
    .chip .ic { width: 13px; height: 13px; }
    .chip:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
    .chip.active {
      background: var(--vscode-button-background, #0e639c);
      border-color: transparent;
      color: var(--vscode-button-foreground, #fff);
    }
    .task-counter {
      margin-left: auto; display: none; align-items: center; gap: 5px;
      color: var(--vscode-descriptionForeground, #999);
      font-size: .85em; user-select: none;
    }
    .task-counter.show { display: inline-flex; }
    .task-counter .ic { width: 13px; height: 13px; }
    .task-counter.all-done { color: var(--vscode-charts-green, #89d185); }

    /* ── List & grouping ────────────────────────────────────────────────── */
    #list { flex: 1; overflow-y: auto; padding: 6px 14px 20px; }
    .group-h {
      display: flex; align-items: center; gap: 6px;
      margin: 16px 2px 8px;
      color: var(--vscode-descriptionForeground, #999);
      font-size: .8em; font-weight: 600; text-transform: uppercase; letter-spacing: .07em;
    }
    .group-h:first-child { margin-top: 6px; }
    .group-h .group-title { display: inline-flex; align-items: center; gap: 5px; }
    .group-h .ic { width: 12px; height: 12px; }
    .group-h::after { content: ''; flex: 1; height: 1px; background: var(--vscode-editorWidget-border, #333); }

    .entry {
      display: flex; gap: 4px;
      border: 1px solid var(--vscode-editorWidget-border, #333);
      border-radius: 8px;
      margin-bottom: 8px;
      background: var(--vscode-editor-background);
      transition: background-color .12s, border-color .12s;
      animation: fadeUp .18s ease-out;
    }
    .entry:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.08)); }
    .entry.selected {
      border-color: var(--vscode-focusBorder, #007acc);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder, #007acc);
    }
    @keyframes fadeUp { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }

    .accent { width: 3px; border-radius: 8px 0 0 8px; flex: none; }
    .accent.note { background: var(--vscode-charts-blue, #4daafc); }
    .accent.task { background: var(--vscode-charts-yellow, #d7ba7d); }
    .accent.task.done { background: var(--vscode-charts-green, #89d185); }
    .accent.reminder { background: var(--vscode-charts-red, #f48771); }

    .entry-main { flex: 1; min-width: 0; padding: 9px 12px 8px 8px; }

    .entry-head {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      font-size: .8em; margin-bottom: 4px;
    }
    .kind-label { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
    .kind-label .ic { width: 14px; height: 14px; }
    .kind-label.note .ic { color: var(--vscode-charts-blue, #4daafc); }
    .kind-label.task .ic { color: var(--vscode-charts-yellow, #d7ba7d); }
    .kind-label.task.is-done .ic { color: var(--vscode-charts-green, #89d185); }
    .kind-label.reminder .ic { color: var(--vscode-charts-red, #f48771); }

    .pin-mark { display: inline-flex; color: var(--vscode-charts-yellow, #d7ba7d); }
    .pin-mark .ic { width: 12px; height: 12px; }

    .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .dot.high { background: var(--vscode-charts-red, #f48771); }
    .dot.medium { background: var(--vscode-charts-yellow, #d7ba7d); }
    .dot.low { background: var(--vscode-charts-green, #89d185); }

    .badge {
      font-size: .8em; padding: 1px 8px; border-radius: 999px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
    }
    .badge.done { background: var(--vscode-charts-green, #2d6a1f); color: #fff; }
    .badge.missed { background: var(--vscode-charts-red, #a93226); color: #fff; }

    .tagchip {
      border: 1px solid transparent; border-radius: 999px; cursor: pointer;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #eee);
      font-size: .8em; padding: 0 7px; line-height: 1.5;
      transition: border-color .12s;
    }
    .tagchip:hover { border-color: var(--vscode-focusBorder, #007acc); }

    .ws-tag {
      margin-left: auto; display: inline-flex; align-items: center; gap: 4px;
      color: var(--vscode-descriptionForeground, #999); font-size: .9em;
    }
    .ws-tag .ic { width: 12px; height: 12px; }

    .entry-summary { font-weight: 600; margin: 2px 0; }
    .entry-text { white-space: pre-wrap; word-break: break-word; opacity: .92; }
    .entry.task-done .entry-summary,
    .entry.task-done .entry-text { opacity: .5; text-decoration: line-through; }

    .entry-meta {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      margin-top: 6px; font-size: .8em;
      color: var(--vscode-descriptionForeground, #999);
    }
    .due { display: inline-flex; align-items: center; gap: 4px; }
    .due .ic { width: 12px; height: 12px; }
    .due.overdue { color: var(--vscode-errorForeground, #f48771); font-weight: 600; }
    .fired-mark { font-style: italic; }

    .ctx {
      margin-top: 8px; border-radius: 6px;
      background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.1));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: .85em; padding: 5px 8px;
    }
    .ctx .ctx-line { display: flex; align-items: center; gap: 5px; }
    .ctx .ctx-line .ic { width: 12px; height: 12px; flex: none; opacity: .7; }
    .ctx .ctx-sel { display: flex; gap: 5px; align-items: flex-start; position: relative; margin-top: 2px; }
    .ctx.has-sel { cursor: pointer; }
    .ctx .ctx-cut { flex: none; opacity: .7; display: inline-flex; margin-top: 1px; }
    .ctx .ctx-cut .ic { width: 12px; height: 12px; }
    .ctx .ctx-text { white-space: pre-wrap; word-break: break-word; max-height: 1.5em; overflow: hidden; min-width: 0; }
    .ctx.open .ctx-text { max-height: none; }
    .ctx.has-sel .ctx-sel::after { content: '▾'; margin-left: auto; flex: none; opacity: .6; }
    .ctx.has-sel.open .ctx-sel::after { content: '▴'; }

    .thumb {
      max-width: 180px; max-height: 100px; margin-top: 8px; display: block;
      border: 1px solid var(--vscode-editorWidget-border, #444);
      border-radius: 6px; cursor: zoom-in;
      transition: border-color .12s;
    }
    .thumb:hover { border-color: var(--vscode-focusBorder, #007acc); }

    .entry-actions {
      display: flex; gap: 2px; margin-top: 6px; opacity: 0;
      transition: opacity .12s;
    }
    .entry:hover .entry-actions,
    .entry:focus-within .entry-actions,
    .entry.selected .entry-actions { opacity: 1; }

    .icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 26px; height: 26px; border: none; border-radius: 6px;
      background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground, #ccc));
      cursor: pointer; transition: background-color .12s, color .12s;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
    .icon-btn.on { color: var(--vscode-charts-yellow, #d7ba7d); }
    .icon-btn.active { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
    .icon-btn .ic { width: 15px; height: 15px; }

    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 6px; padding: 6px 14px;
      font-size: .9em; cursor: pointer; white-space: nowrap;
      transition: background-color .12s;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    .btn.secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    .btn .ic { width: 14px; height: 14px; }

    /* ── Inline edit mode ───────────────────────────────────────────────── */
    .edit-box { margin-top: 6px; }
    .edit-ta {
      width: 100%; min-height: 72px; max-height: 220px; resize: vertical;
      background: var(--vscode-input-background, #222);
      color: var(--vscode-input-foreground, #eee);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #444));
      border-radius: 6px; padding: 7px 9px;
      font-family: inherit; font-size: .95em;
      transition: border-color .12s;
    }
    .edit-ta:focus { border-color: var(--vscode-focusBorder, #007acc); }
    .edit-actions { display: flex; gap: 6px; margin-top: 6px; }
    .btn.small { padding: 3px 10px; font-size: .8em; }

    /* ── Empty state ────────────────────────────────────────────────────── */
    .empty {
      display: flex; flex-direction: column; align-items: center; gap: 8px;
      text-align: center; padding: 56px 20px;
      color: var(--vscode-descriptionForeground, #999);
    }
    .empty-kao { font-size: 22px; }
    .empty-msg { font-size: .95em; }

    /* ── Footer composer ────────────────────────────────────────────────── */
    footer {
      flex: none; border-top: 1px solid var(--vscode-editorWidget-border, #333);
      padding: 8px 16px 12px;
    }
    .hints { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; }
    .hint {
      background: none; border: none; cursor: pointer; padding: 1px 7px;
      border-radius: 4px; font-size: .8em;
      color: var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground, #888));
      transition: color .12s, background-color .12s;
    }
    .hint:hover { color: var(--vscode-foreground, #eee); background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
    .composer {
      display: flex; align-items: flex-end; gap: 6px;
      background: var(--vscode-input-background, #222);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #444));
      border-radius: 8px; padding: 5px 5px 5px 10px;
      transition: border-color .12s;
    }
    .composer:focus-within { border-color: var(--vscode-focusBorder, #007acc); }
    #input {
      flex: 1; border: none; outline: none; resize: none;
      background: transparent; color: var(--vscode-input-foreground, #eee);
      font-family: inherit; font-size: .95em; line-height: 1.45;
      padding: 4px 0; min-height: 26px; max-height: 132px;
      overflow-y: hidden;
    }
    #input::placeholder { color: var(--vscode-input-placeholderForeground, #777); }

    /* ── Clarify modal ──────────────────────────────────────────────────── */
    .clarify-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,.45);
      display: none; align-items: center; justify-content: center; z-index: 10;
    }
    .clarify-overlay.show { display: flex; }
    .clarify-box {
      background: var(--vscode-editor-background, #1e1e1e);
      border: 1px solid var(--vscode-editorWidget-border, #555);
      border-radius: 10px; padding: 18px; max-width: 440px; width: 90%;
      box-shadow: 0 8px 30px rgba(0,0,0,.35);
    }
    .clarify-kao { font-size: 18px; margin-bottom: 4px; }
    .clarify-box p { margin: 0 0 12px; }
    .clarify-box input {
      width: 100%; box-sizing: border-box;
      background: var(--vscode-input-background, #222);
      color: var(--vscode-input-foreground, #eee);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #555));
      border-radius: 6px; padding: 8px 10px; font-family: inherit;
      transition: border-color .12s;
    }
    .clarify-box input:focus { border-color: var(--vscode-focusBorder, #007acc); }
    .clarify-actions { margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end; }

    /* ── Scrollbars ─────────────────────────────────────────────────────── */
    ::-webkit-scrollbar { width: 10px; height: 10px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background, rgba(121,121,121,.4));
      border-radius: 5px; border: 2px solid transparent; background-clip: content-box;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground, rgba(121,121,121,.7));
      background-clip: content-box;
    }
    ::-webkit-scrollbar-thumb:active {
      background: var(--vscode-scrollbarSlider-activeBackground, rgba(121,121,121,.95));
      background-clip: content-box;
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; transition: none !important; }
    }
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
  <style>${css}</style>
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

  <script nonce="${nonce}">
    (function () {
      'use strict';
      var vscode = acquireVsCodeApi();
      var SNOOZE_MIN = ${snoozeMinutes};

      var EMPTY_KAOS = ['(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧', '(◕‿◕)', '♪(┌・。・)┌', '(づ｡◕‿‿◕｡)づ', '(≧◡≦)'];
      var NOMATCH_KAOS = ['(╥﹏╥)', '(・_・;)', '(⊙_⊙)', '(￣_￣;)'];

      // ── Icons (inline SVG, codicon-style strokes) ────────────────────────
      var ICONS = {
        note: '<path d="M4 1.75h5.25L13 5.5v8.75H4z"/><path d="M9.25 1.75V5.5H13"/><path d="M6.25 8.5h3.5M6.25 11h2.5"/>',
        task: '<circle cx="8" cy="8" r="6.25"/><path d="m5.25 8.25 1.85 1.85 3.65-4.2"/>',
        reminder: '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.75V8l2.4 1.55"/>',
        pin: '<circle cx="10" cy="6" r="3.25"/><path d="m7.75 8.25-5 5"/>',
        edit: '<path d="M11.25 2 14 4.75 6.25 12.5 3 13l.5-3.25z"/><path d="m10 3.25 2.75 2.75"/>',
        trash: '<path d="M2.75 4.5h10.5"/><path d="M6.25 4.5V2.75h3.5V4.5"/><path d="M4.25 4.5l.75 8.75h6l.75-8.75"/><path d="M6.75 7v4M9.25 7v4"/>',
        camera: '<rect x="1.75" y="4.25" width="12.5" height="9" rx="1.5"/><path d="M5.25 4.25 6.25 2.5h3.5l1 1.75"/><circle cx="8" cy="8.75" r="2.25"/>',
        send: '<path d="M14.25 1.75 1.75 7l4.75 2 2 4.75z"/><path d="M14.25 1.75 6.5 9"/>',
        search: '<circle cx="6.75" cy="6.75" r="4.5"/><path d="m10.5 10.5 3.25 3.25"/>',
        close: '<path d="m4 4 8 8M12 4l-8 8"/>',
        snooze: '<circle cx="8" cy="8.5" r="5"/><path d="M8 6.25v2.25l1.75 1"/><path d="M2.5 3.75 4 2.5M13.5 3.75 12 2.5"/>',
        bellOff: '<path d="M4.5 9.25V6a3.5 3.5 0 0 1 7 0v3.25L12.75 11H3.25z"/><path d="M6.75 12.5a1.3 1.3 0 0 0 2.5 0"/><path d="m2.5 2.25 11 11.5"/>',
        folder: '<path d="M1.75 3.75h4.5l1.5 2h6.5v7h-12.5z"/>',
        scissors: '<circle cx="4.25" cy="4.25" r="1.75"/><circle cx="4.25" cy="11.75" r="1.75"/><path d="M5.75 5.5 13 13M13 3 5.75 10.5"/>'
      };
      function icon(name) {
        return '<svg class="ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
      }

      // ── State & element handles ──────────────────────────────────────────
      var attachShot = false;
      var activeKinds = new Set();
      var lastEntries = [];
      var emptyTimer = null;

      var listEl = document.getElementById('list');
      var inputEl = document.getElementById('input');
      var searchEl = document.getElementById('search');
      var statusEl = document.getElementById('status');
      var clearBtn = document.getElementById('clearSearch');
      var chipAll = document.getElementById('chipAll');
      var counterEl = document.getElementById('taskCounter');
      var shotBtn = document.getElementById('shotBtn');
      var sendBtn = document.getElementById('sendBtn');
      var clarifyOverlay = document.getElementById('clarifyOverlay');
      var clarifyQuestionEl = document.getElementById('clarifyQuestion');
      var clarifyInput = document.getElementById('clarifyInput');

      function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
      }

      // ── Status pill ──────────────────────────────────────────────────────
      function setStatus(mode, kao) {
        statusEl.innerHTML = '';
        if (mode === 'thinking') {
          statusEl.appendChild(el('span', 'spinner'));
          statusEl.appendChild(el('span', null, kao || 'thinking…'));
        } else if (mode === 'done') {
          statusEl.textContent = kao ? 'saved ' + kao : 'saved';
        }
      }

      // ── Formatting helpers ───────────────────────────────────────────────
      function fmtRel(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        var mins = Math.floor((Date.now() - d.getTime()) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + 'm ago';
        var hrs = Math.floor(mins / 60);
        if (hrs < 24) return hrs + 'h ago';
        var days = Math.floor(hrs / 24);
        if (days === 1) return 'yesterday';
        if (days < 7) return days + 'd ago';
        return d.toLocaleDateString();
      }

      function fmtDueParts(iso) {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        var diff = d.getTime() - Date.now();
        var abs = Math.abs(diff);
        var days = Math.floor(abs / 86400000);
        var hrs = Math.floor((abs % 86400000) / 3600000);
        var mins = Math.floor((abs % 3600000) / 60000);
        var span = days > 0 ? days + 'd ' + hrs + 'h' : hrs > 0 ? hrs + 'h ' + mins + 'm' : mins + 'm';
        return {
          text: (diff >= 0 ? 'due in ' : 'overdue ') + span,
          overdue: diff < 0,
          title: d.toLocaleString()
        };
      }

      function updateDueEl(dueEl) {
        var p = fmtDueParts(dueEl.getAttribute('data-due'));
        if (!p) return;
        var t = dueEl.querySelector('.due-text');
        if (t) t.textContent = p.text;
        dueEl.classList.toggle('overdue', p.overdue);
        dueEl.title = p.title;
      }

      // Live countdown: refresh due labels every 30s.
      setInterval(function () {
        var els = document.querySelectorAll('[data-due]');
        for (var i = 0; i < els.length; i++) updateDueEl(els[i]);
      }, 30000);

      // ── Entry rendering ──────────────────────────────────────────────────
      function renderEntry(n) {
        var card = el('div', 'entry kind-' + n.kind + (n.done ? ' task-done' : '') + (n.selected ? ' selected' : ''));
        card.dataset.id = n.id;

        card.appendChild(el('div', 'accent ' + n.kind + (n.kind === 'task' && n.done ? ' done' : '')));

        var mainEl = el('div', 'entry-main');
        card.appendChild(mainEl);

        var head = el('div', 'entry-head');
        mainEl.appendChild(head);

        var kindEl = el('span', 'kind-label ' + n.kind + (n.kind === 'task' && n.done ? ' is-done' : ''));
        kindEl.innerHTML = icon(n.kind);
        kindEl.appendChild(el('span', null, n.kind));
        head.appendChild(kindEl);

        if (n.pinned) {
          var pm = el('span', 'pin-mark');
          pm.title = 'Pinned';
          pm.innerHTML = icon('pin');
          head.appendChild(pm);
        }
        if (n.kind === 'task' && n.priority && !n.done) {
          var dot = el('span', 'dot ' + n.priority);
          dot.title = n.priority + ' priority';
          head.appendChild(dot);
        }
        if (n.kind === 'task' && n.done) head.appendChild(el('span', 'badge done', 'done'));
        if (n.kind === 'reminder' && n.missed) head.appendChild(el('span', 'badge missed', 'missed'));

        var tags = n.tags || [];
        for (var ti = 0; ti < tags.length; ti++) {
          (function (t) {
            var c = el('button', 'tagchip', '#' + t);
            c.title = 'Search this tag';
            c.addEventListener('click', function () {
              searchEl.value = t;
              updateClearBtn();
              fireSearchNow();
            });
            head.appendChild(c);
          })(tags[ti]);
        }
        if (n.workspaceTag) {
          var w = el('span', 'ws-tag');
          w.title = 'Workspace: ' + n.workspaceTag;
          w.innerHTML = icon('folder');
          w.appendChild(el('span', null, n.workspaceTag));
          head.appendChild(w);
        }

        if (n.summary) mainEl.appendChild(el('div', 'entry-summary', n.summary));
        mainEl.appendChild(el('div', 'entry-text', n.text));

        var meta = el('div', 'entry-meta');
        var created = el('span', null, 'created ' + fmtRel(n.createdAt));
        created.title = new Date(n.createdAt).toLocaleString();
        meta.appendChild(created);
        if (n.kind === 'reminder' && n.dueAt) {
          var due = el('span', 'due');
          due.setAttribute('data-due', n.dueAt);
          due.title = new Date(n.dueAt).toLocaleString();
          due.innerHTML = icon('reminder');
          due.appendChild(el('span', 'due-text'));
          meta.appendChild(due);
          updateDueEl(due);
          if (n.fired) meta.appendChild(el('span', 'fired-mark', 'fired'));
        }
        mainEl.appendChild(meta);

        if (n.context && (n.context.fileName || n.context.selectedText)) {
          var ctx = el('div', 'ctx');
          if (n.context.selectedText) ctx.classList.add('has-sel');
          if (n.context.fileName) {
            var line = el('div', 'ctx-line');
            line.innerHTML = icon('note');
            line.appendChild(el('span', null, n.context.fileName + (n.context.languageId ? ' (' + n.context.languageId + ')' : '')));
            ctx.appendChild(line);
          }
          if (n.context.selectedText) {
            var sel = el('div', 'ctx-sel');
            var cut = el('span', 'ctx-cut');
            cut.innerHTML = icon('scissors');
            sel.appendChild(cut);
            sel.appendChild(el('span', 'ctx-text', n.context.selectedText));
            ctx.appendChild(sel);
            ctx.title = 'Click to expand/collapse the captured selection';
            ctx.addEventListener('click', function () { ctx.classList.toggle('open'); });
          }
          mainEl.appendChild(ctx);
        }

        if (n.screenshotUri) {
          var img = document.createElement('img');
          img.className = 'thumb';
          img.src = n.screenshotUri;
          img.alt = 'Attached screenshot';
          img.title = 'Click to open';
          img.addEventListener('click', function () {
            vscode.postMessage({ type: 'openScreenshot', path: n.screenshotPath });
          });
          mainEl.appendChild(img);
        }

        var actions = el('div', 'entry-actions');
        function act(ic, label, fn) {
          var b = el('button', 'icon-btn');
          b.title = label;
          b.setAttribute('aria-label', label);
          b.innerHTML = icon(ic);
          b.addEventListener('click', fn);
          actions.appendChild(b);
        }
        var pinBtn;
        act('pin', n.pinned ? 'Unpin' : 'Pin', function () {
          vscode.postMessage({ type: 'togglePin', id: n.id });
        });
        pinBtn = actions.lastChild;
        if (n.pinned) pinBtn.classList.add('on');
        act('edit', 'Edit text', function () { startEdit(card, n); });
        if (n.kind === 'task') {
          act('task', n.done ? 'Mark undone' : 'Mark done', function () {
            vscode.postMessage({ type: 'toggleTask', id: n.id });
          });
        }
        if (n.kind === 'reminder' && !n.fired) {
          if (n.dueAt) {
            act('snooze', 'Snooze ' + SNOOZE_MIN + 'm', function () {
              vscode.postMessage({ type: 'snoozeReminder', id: n.id });
            });
          }
          act('bellOff', 'Dismiss reminder', function () {
            vscode.postMessage({ type: 'dismissReminder', id: n.id });
          });
        }
        act('trash', 'Delete', function () {
          vscode.postMessage({ type: 'deleteEntry', id: n.id });
        });
        mainEl.appendChild(actions);

        return card;
      }

      // ── Inline edit mode ─────────────────────────────────────────────────
      function startEdit(card, n) {
        var textEl = card.querySelector('.entry-text');
        if (!textEl || card.querySelector('.edit-box')) return;
        var box = el('div', 'edit-box');
        var ta = document.createElement('textarea');
        ta.className = 'edit-ta';
        ta.value = n.text;
        box.appendChild(ta);

        var row = el('div', 'edit-actions');
        var save = el('button', 'btn small', 'Save');
        save.addEventListener('click', function () {
          vscode.postMessage({ type: 'updateEntry', id: n.id, text: ta.value });
          setStatus('thinking');
        });
        var rec = el('button', 'btn small secondary', 'Re-classify');
        rec.title = 'Save this text and re-run AI classification';
        rec.addEventListener('click', function () {
          vscode.postMessage({ type: 'reclassify', id: n.id, text: ta.value });
          setStatus('thinking');
        });
        var cancel = el('button', 'btn small secondary', 'Cancel');
        cancel.addEventListener('click', function () { renderList(lastEntries); });
        row.appendChild(save);
        row.appendChild(rec);
        row.appendChild(cancel);
        box.appendChild(row);

        textEl.style.display = 'none';
        textEl.parentNode.insertBefore(box, textEl.nextSibling);
        ta.focus();
        ta.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save.click(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
        });
      }

      // ── List rendering with grouping ─────────────────────────────────────
      function groupKey(n) {
        var d = new Date(n.createdAt);
        if (isNaN(d.getTime())) return 'earlier';
        var now = new Date();
        var startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        var t = d.getTime();
        if (t >= startToday) return 'today';
        if (t >= startToday - 86400000) return 'yesterday';
        if (t >= startToday - 7 * 86400000) return 'week';
        return 'earlier';
      }

      var GROUPS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This week'], ['earlier', 'Earlier']];

      function renderList(entries) {
        if (emptyTimer) { clearInterval(emptyTimer); emptyTimer = null; }
        listEl.innerHTML = '';
        lastEntries = entries || [];
        if (!lastEntries.length) { renderEmpty(); return; }

        var pinned = [];
        var buckets = { today: [], yesterday: [], week: [], earlier: [] };
        for (var i = 0; i < lastEntries.length; i++) {
          var n = lastEntries[i];
          if (n.pinned) pinned.push(n);
          else buckets[groupKey(n)].push(n);
        }

        function section(label, arr, isPinned) {
          var h = el('div', 'group-h');
          var t = el('span', 'group-title');
          if (isPinned) t.innerHTML = icon('pin');
          t.appendChild(el('span', null, label));
          h.appendChild(t);
          listEl.appendChild(h);
          for (var j = 0; j < arr.length; j++) listEl.appendChild(renderEntry(arr[j]));
        }

        if (pinned.length) section('Pinned', pinned, true);
        for (var g = 0; g < GROUPS.length; g++) {
          if (buckets[GROUPS[g][0]].length) section(GROUPS[g][1], buckets[GROUPS[g][0]], false);
        }
      }

      function renderEmpty() {
        var wrap = el('div', 'empty');
        var kao = el('div', 'empty-kao');
        var msg = el('div', 'empty-msg');
        wrap.appendChild(kao);
        wrap.appendChild(msg);
        listEl.appendChild(wrap);
        var filtered = searchEl.value.trim() !== '' || activeKinds.size > 0;
        var pool = filtered ? NOMATCH_KAOS : EMPTY_KAOS;
        var i = Math.floor(Math.random() * pool.length);
        kao.textContent = pool[i];
        msg.textContent = filtered ? 'No matches. Try another search.' : 'No notes yet. Type below to add one.';
        emptyTimer = setInterval(function () {
          i = (i + 1) % pool.length;
          kao.textContent = pool[i];
        }, 4000);
      }

      // ── Task counter ─────────────────────────────────────────────────────
      var counterTxt = el('span');
      counterEl.innerHTML = icon('task');
      counterEl.appendChild(counterTxt);
      function updateCounter(s) {
        if (!s || !s.tasksTotal) { counterEl.classList.remove('show'); return; }
        counterEl.classList.add('show');
        counterTxt.textContent = s.tasksDone + '/' + s.tasksTotal + ' done';
        counterEl.title = s.tasksDone + ' of ' + s.tasksTotal + ' tasks completed';
        counterEl.classList.toggle('all-done', s.tasksDone === s.tasksTotal);
      }

      // ── Search & filter chips ────────────────────────────────────────────
      var searchTimer = null;
      function fireSearchNow() {
        if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
        vscode.postMessage({ type: 'requestList', query: searchEl.value, kinds: Array.from(activeKinds) });
      }
      function updateClearBtn() {
        clearBtn.classList.toggle('show', searchEl.value !== '');
      }
      searchEl.addEventListener('input', function () {
        updateClearBtn();
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(fireSearchNow, 150);
      });
      clearBtn.addEventListener('click', function () {
        searchEl.value = '';
        updateClearBtn();
        fireSearchNow();
        searchEl.focus();
      });

      var KIND_LABELS = { note: 'Notes', task: 'Tasks', reminder: 'Reminders' };
      var kindChips = document.querySelectorAll('.chip[data-kind]');
      function syncChips() {
        chipAll.classList.toggle('active', activeKinds.size === 0);
        kindChips.forEach(function (c) {
          c.classList.toggle('active', activeKinds.has(c.getAttribute('data-kind')));
        });
      }
      kindChips.forEach(function (c) {
        var k = c.getAttribute('data-kind');
        c.innerHTML = icon(k) + '<span>' + KIND_LABELS[k] + '</span>';
        c.addEventListener('click', function () {
          if (activeKinds.has(k)) activeKinds.delete(k);
          else activeKinds.add(k);
          syncChips();
          fireSearchNow();
        });
      });
      chipAll.addEventListener('click', function () {
        activeKinds.clear();
        syncChips();
        fireSearchNow();
      });

      // ── Composer ─────────────────────────────────────────────────────────
      function autosize() {
        inputEl.style.height = 'auto';
        var capped = inputEl.scrollHeight > 132;
        inputEl.style.height = Math.min(inputEl.scrollHeight, 132) + 'px';
        inputEl.style.overflowY = capped ? 'auto' : 'hidden';
      }
      inputEl.addEventListener('input', autosize);

      function send() {
        var text = inputEl.value.trim();
        if (!text) return;
        vscode.postMessage({ type: 'submit', text: text, attachScreenshot: attachShot });
        inputEl.value = '';
        attachShot = false;
        shotBtn.classList.remove('active');
        shotBtn.setAttribute('aria-pressed', 'false');
        autosize();
        setStatus('thinking');
      }
      sendBtn.addEventListener('click', send);
      inputEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          send();
        }
      });

      shotBtn.innerHTML = icon('camera');
      shotBtn.addEventListener('click', function () {
        attachShot = !attachShot;
        shotBtn.classList.toggle('active', attachShot);
        shotBtn.setAttribute('aria-pressed', attachShot ? 'true' : 'false');
        shotBtn.title = attachShot
          ? 'Screenshot attached — click to remove'
          : 'Attach a full-screen screenshot';
      });

      sendBtn.innerHTML = icon('send') + '<span>Send</span>';

      var PREFIXES = ['task: ', 'remind me to '];
      document.querySelectorAll('.hint').forEach(function (h) {
        h.addEventListener('click', function () {
          var p = h.getAttribute('data-prefix') || '';
          var v = inputEl.value;
          if (p) {
            for (var i = 0; i < PREFIXES.length; i++) {
              if (v.indexOf(PREFIXES[i]) === 0) v = v.slice(PREFIXES[i].length);
            }
            if (v.indexOf(p) !== 0) v = p + v;
            inputEl.value = v;
          } else {
            for (var j = 0; j < PREFIXES.length; j++) {
              if (v.indexOf(PREFIXES[j]) === 0) v = v.slice(PREFIXES[j].length);
            }
            inputEl.value = v;
          }
          inputEl.focus();
          autosize();
        });
      });

      // ── Clarify modal ────────────────────────────────────────────────────
      document.getElementById('clarifyOk').addEventListener('click', function () {
        var v = clarifyInput.value.trim();
        clarifyOverlay.classList.remove('show');
        vscode.postMessage({ type: 'clarifyAnswer', answer: v });
        clarifyInput.value = '';
      });
      document.getElementById('clarifyCancel').addEventListener('click', function () {
        clarifyOverlay.classList.remove('show');
        vscode.postMessage({ type: 'clarifyCancel' });
        clarifyInput.value = '';
      });
      clarifyInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') document.getElementById('clarifyOk').click();
      });

      // ── Host messages ────────────────────────────────────────────────────
      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (typeof msg !== 'object' || msg === null) return;
        if (msg.type === 'entries') {
          renderList(msg.entries);
          if (msg.stats) updateCounter(msg.stats);
        } else if (msg.type === 'status') {
          if (msg.status === 'thinking') setStatus('thinking', msg.kaomoji);
          else if (msg.status === 'done') setStatus('done', msg.kaomoji);
        } else if (msg.type === 'clarify') {
          clarifyQuestionEl.textContent = msg.question;
          clarifyOverlay.classList.add('show');
          clarifyInput.focus();
        } else if (msg.type === 'selectEntry') {
          var entry = listEl.querySelector('.entry[data-id="' + msg.id + '"]');
          if (entry) {
            entry.classList.add('selected');
            entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      });

      // ── Init ─────────────────────────────────────────────────────────────
      document.querySelector('.search-wrap .lead-ic').innerHTML = icon('search');
      clearBtn.innerHTML = icon('close');
      autosize();
      vscode.postMessage({ type: 'requestList' });
      inputEl.focus();
    })();
  </script>
</body>
</html>`;
}
