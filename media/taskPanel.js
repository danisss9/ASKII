// ASKII taskPanel webview script — loaded by src via asWebviewUri.
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
    m.textContent = '\u2192 ' + data.answered;
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
        cursor.textContent = '\u258d';
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
