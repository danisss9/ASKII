import * as vscode from 'vscode';

/**
 * HTML for the ASKII Code Review panel. The host sends the whole review state
 * as {type:'state', state} and the script re-renders from it; model text is
 * only ever inserted with textContent.
 */
export function getCodeReviewPanelHtml(
  webview: vscode.Webview,
  nonce: string,
  kaomoji: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); }
    button { font: inherit; }
    .shell { width: min(900px, calc(100% - 32px)); margin: 0 auto; padding: 20px 0 40px; }
    header { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding-bottom: 14px; border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .heading { flex: 1; min-width: 220px; }
    h1 { margin: 0; font-size: 18px; }
    .kaomoji { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); font-weight: normal; margin-left: 6px; }
    .subtitle { margin: 4px 0 0; color: var(--vscode-descriptionForeground); }
    .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
    .count { color: var(--vscode-descriptionForeground); }
    .toggle { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    .toggle input { margin: 0; accent-color: var(--vscode-focusBorder); }
    .btn { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 1px solid var(--vscode-button-border, transparent); border-radius: 4px; padding: 4px 12px; cursor: pointer; }
    .btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .btn.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .btn.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .btn:disabled { opacity: .55; cursor: default; }
    .btn:focus-visible, .loc:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    .hidden { display: none !important; }
    .notice { display: flex; align-items: center; gap: 10px; margin: 18px 0; padding: 12px 14px; border-radius: 6px; background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-editorWidget-border); }
    .notice.error { color: var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground); border-color: var(--vscode-inputValidation-errorBorder); }
    .spinner { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent; animation: spin .8s linear infinite; }
    .list { display: grid; gap: 10px; margin-top: 16px; }
    .card { border: 1px solid var(--vscode-editorWidget-border); border-left-width: 3px; border-radius: 6px; padding: 12px 14px; background: var(--vscode-sideBar-background); }
    .card.sev-error { border-left-color: var(--vscode-editorError-foreground, #f14c4c); }
    .card.sev-warning { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
    .card.sev-info { border-left-color: var(--vscode-editorInfo-foreground, #3794ff); }
    .card.fixed { opacity: .6; }
    .card.fixed .title { text-decoration: line-through; }
    .card-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
    .badge { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; padding: 1px 7px; border-radius: 9px; border: 1px solid currentColor; }
    .badge.sev-error { color: var(--vscode-editorError-foreground, #f14c4c); }
    .badge.sev-warning { color: var(--vscode-editorWarning-foreground, #cca700); }
    .badge.sev-info { color: var(--vscode-editorInfo-foreground, #3794ff); }
    .badge.done { color: var(--vscode-testing-iconPassed, #73c991); }
    .loc { color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; background: none; border: 0; padding: 0; cursor: pointer; text-align: left; word-break: break-all; }
    .loc:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .title { font-weight: 600; margin: 0 0 6px; }
    .desc, .rec { margin: 0 0 6px; line-height: 1.5; white-space: pre-wrap; }
    .rec-label { font-weight: 600; }
    .fix-error { margin: 6px 0; color: var(--vscode-errorForeground); white-space: pre-wrap; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
    .actions .spinner { width: 12px; height: 12px; }
    .empty { text-align: center; color: var(--vscode-descriptionForeground); margin: 36px 0; }
    .empty .face { font-family: var(--vscode-editor-font-family, monospace); font-size: 20px; display: block; margin-bottom: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 2.4s; } }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="heading">
        <h1>ASKII Code Review<span class="kaomoji">${kaomoji}</span></h1>
        <p class="subtitle" id="subtitle"></p>
      </div>
      <div class="controls">
        <span class="count" id="count"></span>
        <label class="toggle"><input type="checkbox" id="showFixed" checked> Show fixed</label>
        <button class="btn secondary hidden" id="stop">Stop</button>
        <button class="btn secondary hidden" id="rerun">Re-run review</button>
      </div>
    </header>
    <div class="notice hidden" id="notice"><span class="spinner hidden" id="noticeSpinner"></span><span id="noticeText"></span></div>
    <div class="list" id="list"></div>
    <div class="empty hidden" id="empty"><span class="face" id="emptyFace"></span><span id="emptyText"></span></div>
  </div>
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const saved = vscode.getState() || {};
      let showFixed = saved.showFixed !== false;
      let state = null;

      const $ = (id) => document.getElementById(id);
      const showFixedInput = $('showFixed');
      showFixedInput.checked = showFixed;

      function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined) { node.textContent = text; }
        return node;
      }

      function button(label, act, id, secondary) {
        const b = el('button', secondary ? 'btn secondary' : 'btn', label);
        b.dataset.act = act;
        b.dataset.id = id;
        return b;
      }

      function renderCard(p) {
        const card = el('div', 'card sev-' + p.severity + (p.status === 'fixed' ? ' fixed' : ''));
        const head = el('div', 'card-head');
        head.appendChild(el('span', 'badge sev-' + p.severity, p.severity));
        const loc = el('button', 'loc', p.line ? p.file + ':' + p.line : p.file);
        loc.dataset.act = 'openFile';
        loc.dataset.id = p.id;
        loc.title = 'Open ' + p.file;
        head.appendChild(loc);
        if (p.status === 'fixed') {
          head.appendChild(el('span', 'badge done', p.fixedBy === 'auto' ? 'Fixed (auto)' : 'Fixed (manual)'));
        }
        card.appendChild(head);
        card.appendChild(el('p', 'title', p.title));
        if (p.description && p.description !== p.title) {
          card.appendChild(el('p', 'desc', p.description));
        }
        if (p.recommendation) {
          const rec = el('p', 'rec');
          rec.appendChild(el('span', 'rec-label', 'Recommendation: '));
          rec.appendChild(document.createTextNode(p.recommendation));
          card.appendChild(rec);
        }
        if (p.error) {
          card.appendChild(el('p', 'fix-error', p.error));
        }

        const actions = el('div', 'actions');
        if (p.status === 'fixed') {
          actions.appendChild(button('Reopen', 'reopen', p.id, true));
        } else if (p.status === 'fixing') {
          const fixing = button('Fixing…', 'autoFix', p.id, false);
          fixing.disabled = true;
          actions.appendChild(fixing);
          actions.appendChild(el('span', 'spinner'));
          actions.appendChild(button('Cancel', 'cancelFix', p.id, true));
        } else {
          actions.appendChild(button('Auto Fix', 'autoFix', p.id, false));
          actions.appendChild(button('Fixed It', 'markFixed', p.id, true));
        }
        card.appendChild(actions);
        return card;
      }

      function render() {
        if (!state) { return; }
        const problems = state.problems;
        const fixedCount = problems.filter((p) => p.status === 'fixed').length;
        const running = state.status === 'running';

        $('subtitle').textContent = state.repoName
          ? state.repoName + ' · ' + state.fileCount + (state.fileCount === 1 ? ' changed file' : ' changed files')
          : '';
        $('count').textContent = problems.length > 0 ? fixedCount + ' of ' + problems.length + ' fixed' : '';
        $('stop').classList.toggle('hidden', !running);
        $('rerun').classList.toggle('hidden', running);

        const notice = $('notice');
        notice.classList.toggle('error', state.status === 'error');
        $('noticeSpinner').classList.toggle('hidden', !running);
        const noticeText = running
          ? 'Reviewing uncommitted changes… ' + (state.thinking || '')
          : state.status === 'cancelled'
            ? 'Review stopped.'
            : state.status === 'error'
              ? state.message || 'The review failed.'
              : '';
        $('noticeText').textContent = noticeText;
        notice.classList.toggle('hidden', !noticeText);

        const list = $('list');
        list.replaceChildren();
        const visible = problems.filter((p) => showFixed || p.status !== 'fixed');
        for (const p of visible) {
          list.appendChild(renderCard(p));
        }

        const empty = $('empty');
        let emptyText = '';
        let emptyFace = '';
        if (state.status === 'done' && problems.length === 0) {
          emptyFace = '(ﾉ◕ヮ◕)ﾉ*:･ﾟ✧';
          emptyText = 'No problems found in your uncommitted changes.';
        } else if (problems.length > 0 && visible.length === 0) {
          emptyFace = '(⌐■_■)';
          emptyText = 'All problems are fixed. Turn on "Show fixed" to see them.';
        }
        $('emptyFace').textContent = emptyFace;
        $('emptyText').textContent = emptyText;
        empty.classList.toggle('hidden', !emptyText);
      }

      showFixedInput.addEventListener('change', () => {
        showFixed = showFixedInput.checked;
        vscode.setState({ showFixed: showFixed });
        render();
      });
      $('stop').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
      $('rerun').addEventListener('click', () => vscode.postMessage({ type: 'rerun' }));
      $('list').addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target.closest('[data-act]') : null;
        if (!target || target.disabled) { return; }
        vscode.postMessage({ type: target.dataset.act, id: target.dataset.id });
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'state') {
          state = msg.state;
          render();
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}
