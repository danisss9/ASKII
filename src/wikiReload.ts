import * as vscode from 'vscode';
import * as fs from 'fs';
import { buildWikiIndex } from '@common/wiki';
import { rebuildCodeWikiIndex } from '@common/codewiki';

// The startup auto-reload and a manual reload must not rebuild the same index at once
let wikiReloadRunning = false;

export async function askiiReloadWikiCommand() {
  if (wikiReloadRunning) {
    vscode.window.showInformationMessage('ASKII: Wikis are already being reloaded.');
    return;
  }
  wikiReloadRunning = true;
  try {
    await reloadWikis();
  } finally {
    wikiReloadRunning = false;
  }
}

async function reloadWikis() {
  const config = vscode.workspace.getConfiguration('askii');
  const wikiEnabled = config.get<boolean>('wikiEnabled') ?? false;
  const wikiPath = config.get<string>('wikiPath') ?? '';
  const codeWikiEnabled = config.get<boolean>('codeWikiEnabled') ?? false;

  if (!wikiEnabled && !codeWikiEnabled) {
    vscode.window.showInformationMessage(
      'ASKII: No wikis enabled — turn on Wiki RAG or Code Wiki in settings first.',
    );
    return;
  }

  const summaries: string[] = [];
  const warnings: string[] = [];
  const abortController = new AbortController();
  const { signal } = abortController;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'ASKII: Reloading wikis...',
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => abortController.abort());
      const downloadProgress = (_file: string, receivedMB: number, totalMB: number) => {
        progress.report({
          message: `Downloading embedding model (${receivedMB.toFixed(0)}/${totalMB.toFixed(0)} MB)...`,
        });
      };

      // Docs wiki (vector index over .md files)
      if (wikiEnabled) {
        if (!wikiPath) {
          warnings.push('docs wiki skipped — set askii.wikiPath');
        } else if (!fs.existsSync(wikiPath)) {
          warnings.push(`docs wiki skipped — path not found: ${wikiPath}`);
        } else {
          try {
            progress.report({ message: 'Indexing wiki .md files...' });
            const stats = await buildWikiIndex(wikiPath, {
              onProgress: (stage, current, total) => {
                if (stage === 'indexing') {
                  progress.report({ message: `Wiki: file ${current}/${total}...` });
                }
              },
              onDownloadProgress: downloadProgress,
              signal,
            });
            summaries.push(`wiki: ${stats.chunkCount} chunks from ${stats.fileCount} file(s)`);
          } catch (error) {
            if (signal.aborted) {return;}
            warnings.push(
              `docs wiki failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }
      }

      // Code wiki (vector index over workspace code)
      if (codeWikiEnabled) {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) {
          warnings.push('code wiki skipped — no workspace folder open');
        } else {
          try {
            progress.report({ message: 'Indexing workspace code (code wiki)...' });
            const stats = await rebuildCodeWikiIndex(root, {
              onProgress: (stage, current, total) => {
                if (stage === 'indexing') {
                  progress.report({ message: `Code wiki: file ${current}/${total}...` });
                }
              },
              onDownloadProgress: downloadProgress,
              signal,
            });
            summaries.push(
              `code wiki: ${stats.chunkCount} chunks from ${stats.fileCount} file(s) ` +
                `(${stats.embeddedFiles} embedded, ${stats.cachedFiles} reused)`,
            );
          } catch (error) {
            if (signal.aborted) {return;}
            warnings.push(
              `code wiki failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
            );
          }
        }
      }
    },
  );

  if (signal.aborted) {
    // Any wiki that finished before the cancel is still reported
    const done = summaries.length > 0 ? ` (completed — ${summaries.join(' — ')})` : '';
    vscode.window.showInformationMessage(
      `ASKII: Wiki reload cancelled — existing indexes kept${done}`,
    );
    return;
  }
  if (summaries.length > 0) {
    vscode.window.showInformationMessage(`ASKII: ${summaries.join(' — ')} (⌐■_■)`);
  }
  if (warnings.length > 0) {
    vscode.window.showWarningMessage(`ASKII: ${warnings.join(' — ')}`);
  }
}
