// ASKII ask webview script — loaded by src via asWebviewUri.
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
