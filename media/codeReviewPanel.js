// ASKII codeReviewPanel webview script — loaded by src via asWebviewUri.
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
