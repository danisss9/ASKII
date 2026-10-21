import * as vscode from 'vscode';
import { webviewAssets } from './webviewAssets';

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
  const assets = webviewAssets(webview, 'codeReviewPanel');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${assets.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
  <link rel="stylesheet" href="${assets.style}">
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
  <script nonce="${nonce}" src="${assets.script}"></script>
</body>
</html>`;
}
