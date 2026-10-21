// ── ASKII task panel webview ─────────────────────────────────────────────────
// Renders the Do/Control run as a vertical timeline: header with a status
// badge, one node per round/action/confirm, and a footer that swaps between a
// Cancel button (run active) and a follow-up input (run finished). All state
// comes from host messages — the page itself is stateless across resets.

export function getTaskPanelHtml(nonce: string): string {
  const css = `
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family, Arial, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .hidden { display: none !important; }

    /* ── Header ─────────────────────────────────────────────────────────── */
    #header {
      padding: 10px 16px;
      border-bottom: 1px solid var(--vscode-editorWidget-border, #444);
      flex: none;
    }
    #title { margin: 0 0 2px; font-size: 1.05em; font-weight: 600; }
    .status-row { display: flex; align-items: center; gap: 7px; min-height: 18px; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    body[data-status="running"] .status-dot { background: var(--vscode-charts-blue, #4daafc); animation: pulse 1.2s ease-in-out infinite; }
    body[data-status="awaiting"] .status-dot { background: var(--vscode-charts-orange, #d18616); }
    body[data-status="done"] .status-dot { background: var(--vscode-charts-green, #4ec9b0); }
    body[data-status="cancelled"] .status-dot { background: var(--vscode-descriptionForeground, #999); }
    body[data-status="error"] .status-dot { background: var(--vscode-charts-red, #f48771); }
    #statusText { font-size: 12px; }
    #statusMsg {
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #999);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    @keyframes pulse { 50% { opacity: 0.35; } }

    /* ── Timeline ───────────────────────────────────────────────────────── */
    #timeline { flex: 1; overflow-y: auto; padding: 14px 16px 20px; }
    .entry {
      position: relative;
      display: grid;
      grid-template-columns: 18px 1fr;
      column-gap: 10px;
      padding: 5px 0;
    }
    .entry::before {
      content: '';
      position: absolute;
      left: 8px;
      top: 26px;
      bottom: -7px;
      width: 1px;
      background: var(--vscode-editorWidget-border, #444);
    }
    #timeline .entry:last-child::before { display: none; }
    .entry-icon {
      width: 18px; height: 18px;
      display: flex; align-items: center; justify-content: center;
      position: relative; z-index: 1;
      background: var(--vscode-editor-background);
      border-radius: 50%;
      color: var(--vscode-descriptionForeground, #999);
    }
    .entry-icon svg { width: 13px; height: 13px; }
    .entry.s-ok .entry-icon { color: var(--vscode-charts-green, #4ec9b0); }
    .entry.s-error .entry-icon { color: var(--vscode-charts-red, #f48771); }
    .entry.s-skipped .entry-icon { color: var(--vscode-descriptionForeground, #999); }
    .entry.k-round .entry-icon { color: var(--vscode-charts-blue, #4daafc); }
    .entry.k-info .entry-icon { color: var(--vscode-charts-blue, #4daafc); }
    .entry.k-confirm .entry-icon { color: var(--vscode-charts-orange, #d18616); }
    .entry.k-done .entry-icon { color: var(--vscode-charts-green, #4ec9b0); }
    .row { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .entry-title { flex: 1; min-width: 0; word-break: break-word; }
    .entry.s-skipped .entry-title { opacity: 0.55; }
    .entry-time { flex: none; font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
    .spinner {
      width: 11px; height: 11px; border-radius: 50%;
      border: 2px solid var(--vscode-editorWidget-border, #444);
      border-top-color: var(--vscode-focusBorder, #4daafc);
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Confirm message + option buttons */
    .confirm-box { grid-column: 2; margin-top: 4px; }
    .confirm-msg { margin: 0 0 6px; opacity: 0.9; }
    .btn-row { display: flex; gap: 6px; }
    .opt-btn {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: none; border-radius: 3px;
      padding: 3px 12px;
      font-size: 12px; font-family: inherit;
      cursor: pointer;
    }
    .opt-btn.primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    .opt-btn:hover:not(:disabled) { filter: brightness(1.15); }
    .opt-btn:disabled { opacity: 0.45; cursor: default; }
    .opt-btn.chosen { outline: 1px solid var(--vscode-focusBorder, #4daafc); opacity: 1; }
    .answered { grid-column: 2; margin-top: 3px; font-size: 12px; color: var(--vscode-descriptionForeground, #999); }

    /* Collapsible blocks (streamed AI text, details, screenshots) */
    details.block { grid-column: 2; margin-top: 4px; min-width: 0; }
    details.block summary {
      cursor: pointer;
      font-size: 12px;
      color: var(--vscode-descriptionForeground, #999);
      user-select: none;
    }
    details.block summary:hover { color: var(--vscode-foreground); }
    details.block pre {
      margin: 5px 0 0;
      padding: 8px 10px;
      background: var(--vscode-textCodeBlock-background, #1e1e1e);
      border-radius: 4px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 300px;
      overflow-y: auto;
    }
    details.block img {
      display: block;
      margin-top: 5px;
      max-width: 100%;
      border: 1px solid var(--vscode-editorWidget-border, #444);
      border-radius: 4px;
    }
    .stream-cursor {
      display: inline-block;
      opacity: 0.7;
      animation: blink 1s step-end infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }

    /* ── Footer ─────────────────────────────────────────────────────────── */
    #footer {
      flex: none;
      display: flex;
      gap: 8px;
      align-items: center;
      padding: 10px 16px;
      border-top: 1px solid var(--vscode-editorWidget-border, #444);
    }
    #cancelBtn {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
      border: none; border-radius: 3px;
      padding: 5px 16px;
      font-size: 13px; font-family: inherit;
      cursor: pointer;
    }
    #cancelBtn:hover:not(:disabled) { filter: brightness(1.15); }
    #cancelBtn:disabled { opacity: 0.5; cursor: default; }
    #followUpRow { flex: 1; display: flex; gap: 8px; }
    #followUpInput {
      flex: 1;
      background: var(--vscode-input-background, rgba(128,128,128,0.12));
      color: var(--vscode-input-foreground, inherit);
      border: 1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #444));
      border-radius: 3px;
      padding: 5px 8px;
      font-size: 13px;
      font-family: inherit;
    }
    #followUpInput:focus { outline: 1px solid var(--vscode-focusBorder, #4daafc); }
    #sendBtn {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 3px;
      padding: 5px 14px;
      font-size: 13px; font-family: inherit;
      cursor: pointer;
    }
    #sendBtn:hover { filter: brightness(1.15); }
  `;

  const panelHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data:">
  <style nonce="${nonce}">${css}</style>
</head>
<body data-status="done">
  <div id="header">
    <h2 id="title">ASKII</h2>
    <div class="status-row">
      <span class="status-dot"></span>
      <span id="statusText">Done</span>
      <span id="statusMsg"></span>
    </div>
  </div>
  <div id="timeline"></div>
  <div id="footer">
    <button id="cancelBtn" class="hidden">Cancel</button>
    <div id="followUpRow">
      <input id="followUpInput" type="text" placeholder="Give ASKII a follow-up task..." />
      <button id="sendBtn">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const timelineEl = document.getElementById('timeline');
    const titleEl = document.getElementById('title');
    const statusTextEl = document.getElementById('statusText');
    const statusMsgEl = document.getElementById('statusMsg');
    const cancelBtn = document.getElementById('cancelBtn');
    const followUpRow = document.getElementById('followUpRow');
    const followUpInput = document.getElementById('followUpInput');
    const sendBtn = document.getElementById('sendBtn');

    // id -> { data, root, streamPre }
    const entries = new Map();
    let autoFollow = true;

    const STATUS_LABELS = {
      running: 'Running',
      awaiting: 'Waiting for your answer',
      done: 'Done',
      cancelled: 'Cancelled',
      error: 'Error',
    };

    const svg = {
      check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
      x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
      info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
      help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      xCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      skip: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg>',
      dot: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.5" fill="currentColor"/></svg>',
    };

    function iconFor(e) {
      if (e.status === 'pending') { return '<span class="spinner"></span>'; }
      if (e.kind === 'done') { return svg.checkCircle; }
      if (e.kind === 'error') { return svg.xCircle; }
      if (e.kind === 'confirm') { return e.status === 'ok' || e.answered ? svg.check : svg.help; }
      if (e.kind === 'round') { return svg.dot; }
      if (e.kind === 'info') { return svg.info; }
      if (e.status === 'ok') { return svg.check; }
      if (e.status === 'skipped') { return svg.skip; }
      if (e.status === 'error') { return svg.x; }
      return svg.dot;
    }

    function nearBottom() {
      return timelineEl.scrollHeight - timelineEl.scrollTop - timelineEl.clientHeight < 60;
    }
    function scrollToBottom() {
      timelineEl.scrollTop = timelineEl.scrollHeight;
    }
    timelineEl.addEventListener('scroll', () => { autoFollow = nearBottom(); });

    // Rebuilds an entry's DOM from its data. The caller is responsible for
    // swapping the new node into the timeline (capturing e.root BEFORE calling,
    // since the swap target must be the previously attached node) and for
    // updating e.root/e.streamPre afterwards.
    function renderEntry(id) {
      const e = entries.get(id);
      if (!e) { return null; }
      const data = e.data;

      const root = document.createElement('div');
      root.className = 'entry k-' + data.kind + (data.status ? ' s-' + data.status : '');
      root.dataset.id = String(id);

      const row = document.createElement('div');
      row.className = 'row';
      const icon = document.createElement('span');
      icon.className = 'entry-icon';
      icon.innerHTML = iconFor(data);
      const title = document.createElement('span');
      title.className = 'entry-title';
      title.textContent = data.title || '';
      const time = document.createElement('span');
      time.className = 'entry-time';
      time.textContent = data.time || '';
      row.append(icon, title, time);
      root.appendChild(row);

      // Confirm prompt + option buttons (only while unanswered)
      if (data.options && data.options.length > 0 && data.status === 'pending' && !data.answered) {
        const box = document.createElement('div');
        box.className = 'confirm-box';
        if (data.confirmMessage) {
          const m = document.createElement('div');
          m.className = 'confirm-msg';
          m.textContent = data.confirmMessage;
          box.appendChild(m);
        }
        const btnRow = document.createElement('div');
        btnRow.className = 'btn-row';
        data.options.forEach((opt, i) => {
          const b = document.createElement('button');
          b.className = 'opt-btn' + (i === 0 ? ' primary' : '');
          b.textContent = opt;
          b.addEventListener('click', () => {
            data.answered = opt;
            btnRow.querySelectorAll('button').forEach((x) => { x.disabled = true; });
            b.classList.add('chosen');
            vscode.postMessage({ type: 'confirmResult', id: id, answer: opt });
          });
          btnRow.appendChild(b);
        });
        box.appendChild(btnRow);
        root.appendChild(box);
      }
      if (data.answered && data.status === 'pending') {
        const m = document.createElement('div');
        m.className = 'answered';
        m.textContent = '\\u2192 ' + data.answered;
        root.appendChild(m);
      }

      let streamPre = null;
      if (data.stream) {
        const d = document.createElement('details');
        d.className = 'block';
        if (data.status === 'pending') { d.open = true; }
        const s = document.createElement('summary');
        s.textContent = 'AI response';
        streamPre = document.createElement('pre');
        streamPre.textContent = data.stream;
        d.append(s, streamPre);
        root.appendChild(d);
      }

      if (data.detail) {
        const d = document.createElement('details');
        d.className = 'block';
        const s = document.createElement('summary');
        s.textContent = 'Details';
        const pre = document.createElement('pre');
        pre.textContent = data.detail;
        d.append(s, pre);
        root.appendChild(d);
      }

      if (data.screenshot) {
        const d = document.createElement('details');
        d.className = 'block';
        const s = document.createElement('summary');
        s.textContent = 'Screenshot';
        const img = document.createElement('img');
        img.src = data.screenshot;
        img.alt = 'Agent screenshot';
        d.append(s, img);
        root.appendChild(d);
      }

      return { root: root, streamPre: streamPre };
    }
    // Re-renders an entry and swaps the freshly built node in for the
    // previously attached one. The old node must be captured before rendering
    // — the render is what produces the replacement.
    function swapEntryNode(e, id) {
      const oldRoot = e.root;
      const built = renderEntry(id);
      if (!built) { return; }
      e.root = built.root;
      e.streamPre = built.streamPre;
      if (oldRoot && oldRoot.parentNode) {
        oldRoot.replaceWith(built.root);
      } else if (!oldRoot) {
        timelineEl.appendChild(built.root);
      }
    }

    function setStatus(status, message) {
      document.body.dataset.status = status;
      statusTextEl.textContent = STATUS_LABELS[status] || status;
      statusMsgEl.textContent = message || '';
      cancelBtn.classList.toggle('hidden', !(status === 'running' || status === 'awaiting'));
      cancelBtn.disabled = false;
      const showFollowUp = status === 'done';
      followUpRow.classList.toggle('hidden', !showFollowUp);
      if (showFollowUp) { followUpInput.focus(); }
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (typeof msg !== 'object' || msg === null) { return; }
      const stick = nearBottom();
      switch (msg.type) {
        case 'reset': {
          titleEl.textContent = msg.title || 'ASKII';
          timelineEl.innerHTML = '';
          entries.clear();
          setStatus('running', '');
          break;
        }
        case 'entry': {
          const e = { data: msg.entry, root: null, streamPre: null };
          entries.set(msg.entry.id, e);
          swapEntryNode(e, msg.entry.id);
          break;
        }
        case 'entryUpdate': {
          const e = entries.get(msg.id);
          if (!e) { break; }
          e.data = Object.assign({}, e.data, msg.patch);
          swapEntryNode(e, msg.id);
          break;
        }
        case 'entryStream': {
          const e = entries.get(msg.id);
          if (!e) { break; }
          e.data.stream = msg.text;
          if (e.streamPre) {
            e.streamPre.textContent = msg.text;
            const cursor = document.createElement('span');
            cursor.className = 'stream-cursor';
            cursor.textContent = '\\u258d';
            e.streamPre.appendChild(cursor);
          } else {
            swapEntryNode(e, msg.id);
          }
          break;
        }
        case 'confirm': {
          const e = entries.get(msg.id);
          if (!e) { break; }
          e.data.confirmMessage = msg.message;
          e.data.options = msg.options;
          e.data.status = 'pending';
          swapEntryNode(e, msg.id);
          break;
        }
        case 'status': {
          setStatus(msg.status, msg.message);
          break;
        }
      }
      if (stick) { scrollToBottom(); }
    });

    cancelBtn.addEventListener('click', () => {
      cancelBtn.disabled = true;
      vscode.postMessage({ type: 'cancel' });
    });

    function submitFollowUp() {
      const text = followUpInput.value.trim();
      if (!text) { return; }
      vscode.postMessage({ type: 'followup', text: text });
      followUpInput.value = '';
    }
    sendBtn.addEventListener('click', submitFollowUp);
    followUpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitFollowUp(); }
    });
  </script>
</body>
</html>`;
  return panelHtml;
}
