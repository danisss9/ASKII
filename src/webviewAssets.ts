import * as vscode from 'vscode';

// Webview scripts and styles live in media/<panel>.js / .css (plain files,
// loaded through asWebviewUri) instead of strings inlined into the HTML.

let extensionUri: vscode.Uri | undefined;

export function initWebviewAssets(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
}

/** The folder webviews may load ASKII's own assets from (for localResourceRoots). */
export function mediaRoot(): vscode.Uri {
  if (!extensionUri) {
    throw new Error('ASKII webview assets used before activation');
  }
  return vscode.Uri.joinPath(extensionUri, 'media');
}

export interface WebviewAssets {
  script: string;
  style: string;
  cspSource: string;
  /** JSON for the <script type="application/json" id="askii-data"> block. */
  data: string;
}

/** Safe to embed in HTML: no "<" or ">" can close the surrounding element. */
export function serializeForHtml(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

export function webviewAssets(webview: vscode.Webview, panel: string, data?: unknown): WebviewAssets {
  const root = mediaRoot();
  return {
    script: webview.asWebviewUri(vscode.Uri.joinPath(root, `${panel}.js`)).toString(),
    style: webview.asWebviewUri(vscode.Uri.joinPath(root, `${panel}.css`)).toString(),
    cspSource: webview.cspSource,
    data: serializeForHtml(data),
  };
}
