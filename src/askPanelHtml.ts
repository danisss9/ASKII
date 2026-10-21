import type { WebviewAssets } from './webviewAssets';

/**
 * HTML for the Ask answer panel. Behavior lives in media/ask.js and styles
 * in media/ask.css; answers arrive as rendered markdown via postMessage.
 */
export function getAskPanelHtml(nonce: string, assets: WebviewAssets): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${assets.cspSource}; script-src 'nonce-${nonce}'">
  <link rel="stylesheet" href="${assets.style}">
</head>
<body>
  <div class="header-row">
    <h2 id="title">ASKII is thinking... (๑•﹏•)</h2>
    <div class="btn-group">
      <button id="stopBtn" class="icon-btn" title="Stop generating">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="6" y="6" width="12" height="12" rx="1"></rect>
        </svg>
      </button>
      <button id="historyBtn" class="icon-btn" title="View conversation history">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 3v5h5"></path>
          <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"></path>
          <polyline points="12 7 12 12 15 14"></polyline>
        </svg>
      </button>
      <button id="followUpBtn" class="icon-btn" title="Ask a follow-up">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
      </button>
      <button id="copyBtn" class="icon-btn" title="Copy response">
        <svg class="icon-copy" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
        </svg>
        <svg class="icon-check" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </button>
    </div>
  </div>
  <div id="content"><p class="thinking">Waiting for response...</p></div>
  <script nonce="${nonce}" src="${assets.script}"></script>
</body>
</html>`;
}
