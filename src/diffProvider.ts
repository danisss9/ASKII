import * as vscode from 'vscode';

// ── Diff content provider ────────────────────────────────────────────────────
// Serves in-memory content for the askii-diff:// URI scheme so VS Code's
// built-in diff editor can display original vs. AI-proposed code side by side.
export class AskiiDiffContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();

  setContent(key: string, text: string): void {
    this.contents.set(key, text);
  }

  deleteContent(key: string): void {
    this.contents.delete(key);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.path) ?? '';
  }
}

export const askiiDiffProvider = new AskiiDiffContentProvider();
