// ── ASKII task panel webview ─────────────────────────────────────────────────
// Renders the Do/Control run as a vertical timeline: header with a status
// badge, one node per round/action/confirm, and a footer that swaps between a
// Cancel button (run active) and a follow-up input (run finished). All state
// comes from host messages — the page itself is stateless across resets.

import type { WebviewAssets } from './webviewAssets';

export function getTaskPanelHtml(nonce: string, assets: WebviewAssets): string {

  const panelHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${assets.cspSource}; script-src 'nonce-${nonce}'; img-src data:">
  <link rel="stylesheet" href="${assets.style}">
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
  <script nonce="${nonce}" src="${assets.script}"></script>
</body>
</html>`;
  return panelHtml;
}
