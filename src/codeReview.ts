import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionResponse } from './providers';
import { collectUncommittedChanges, getGitRepository, rootUriFromArg } from './git';
import {
  buildFixSystemPrompt,
  buildFixUserPrompt,
  buildReviewSystemPrompt,
  buildReviewUserPrompt,
  minimalEdit,
  parseFixResponse,
  parseReviewProblems,
  type ReviewProblem,
} from '@common/codeReview';
import { applyModifyAction, sandboxPath } from '@common/workspace';
import { beginReviewPanel, finishReviewPanel, revealReviewPanel } from './codeReviewPanel';

// Sentinel returned by providers when the model produces no text.
const NO_RESPONSE = 'No response';

// Reviews need more of the diff than commit messages do, but still cap it so
// a huge changeset doesn't blow up the context window or latency.
const MAX_REVIEW_DIFF_CHARS = 40_000;

// Files larger than this are sent to the fix model as an excerpt around the
// problem's line instead of in full.
const MAX_FIX_FILE_CHARS = 60_000;
const FIX_EXCERPT_RADIUS_LINES = 200;

// Context key that swaps the SCM review button for a stop button.
const RUNNING_CONTEXT_KEY = 'askii.codeReviewRunning';

// Aborts the in-flight review; set only while one is running.
let activeReview: AbortController | undefined;

function setRunning(running: boolean): void {
  void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, running);
}

/** Stops the in-flight code review (the SCM stop button). */
export function cancelCodeReviewCommand(): void {
  activeReview?.abort();
}

/**
 * Resolves a problem's repo-relative path inside the repository. Models
 * sometimes keep the diff's "a/" / "b/" prefixes, so those are retried
 * without the prefix when the literal path doesn't exist.
 */
function resolveProblemPath(repoRoot: string, file: string): string {
  const direct = sandboxPath(repoRoot, file);
  if (fs.existsSync(direct)) {
    return direct;
  }
  const unprefixed = file.replace(/^[ab]\//, '');
  if (unprefixed !== file) {
    const stripped = sandboxPath(repoRoot, unprefixed);
    if (fs.existsSync(stripped)) {
      return stripped;
    }
  }
  throw new Error(`File not found: ${file}`);
}

async function openProblem(repoRoot: string, problem: ReviewProblem): Promise<void> {
  const uri = vscode.Uri.file(resolveProblemPath(repoRoot, problem.file));
  const line = Math.max(0, (problem.line ?? 1) - 1);
  const position = new vscode.Position(line, 0);
  await vscode.window.showTextDocument(uri, {
    preview: false,
    selection: new vscode.Range(position, position),
  });
}

/** The file text to send to the fix model: whole, or an excerpt for big files. */
function fileForFixPrompt(
  text: string,
  line: number | undefined,
): { text: string; startLine?: number } {
  if (text.length <= MAX_FIX_FILE_CHARS) {
    return { text };
  }
  const lines = text.split('\n');
  const center = Math.max(0, (line ?? 1) - 1);
  const from = Math.max(0, center - FIX_EXCERPT_RADIUS_LINES);
  const to = Math.min(lines.length, center + FIX_EXCERPT_RADIUS_LINES);
  return { text: lines.slice(from, to).join('\n'), startLine: from + 1 };
}

/**
 * Asks the main model for a fix to one problem and applies it to the open
 * document as an unsaved, undoable edit, then reveals the changed range.
 */
async function autoFixProblem(
  repoRoot: string,
  problem: ReviewProblem,
  signal: AbortSignal,
): Promise<void> {
  const uri = vscode.Uri.file(resolveProblemPath(repoRoot, problem.file));
  // openTextDocument includes unsaved edits, so the fix targets what the user sees.
  const document = await vscode.workspace.openTextDocument(uri);
  // Work on LF text: models answer with \n, which would never match CRLF files.
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const promptFile = fileForFixPrompt(document.getText().replace(/\r\n/g, '\n'), problem.line);

  const raw = await getExtensionResponse(
    buildFixUserPrompt(problem, promptFile.text, promptFile.startLine),
    buildFixSystemPrompt(),
    'general',
    signal,
  );
  if (signal.aborted) {
    return; // some providers ignore the signal — drop a late result
  }

  const action = parseFixResponse(raw, problem.file);
  if (!action) {
    throw new Error('The model did not return a usable fix. Try again or fix it manually.');
  }
  action.oldContent = action.oldContent?.replace(/\r\n/g, '\n');
  action.newContent = action.newContent?.replace(/\r\n/g, '\n');

  // Re-read: the user may have edited the file while the model was thinking.
  const current = document.getText();
  const result = applyModifyAction(current.replace(/\r\n/g, '\n'), action);
  if ('error' in result) {
    throw new Error(
      'The suggested fix no longer matches the file. Try Auto Fix again or fix it manually.',
    );
  }
  const updated = eol === '\r\n' ? result.text.replace(/\n/g, '\r\n') : result.text;
  const change = minimalEdit(current, updated);
  if (change.start === change.end && !change.text) {
    throw new Error('The suggested fix did not change the file.');
  }

  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    uri,
    new vscode.Range(document.positionAt(change.start), document.positionAt(change.end)),
    change.text,
  );
  if (!(await vscode.workspace.applyEdit(edit))) {
    throw new Error('VS Code could not apply the fix.');
  }

  const start = document.positionAt(change.start);
  const end = document.positionAt(change.start + change.text.length);
  await vscode.window.showTextDocument(document, {
    preview: false,
    selection: new vscode.Range(start, end),
  });
}

export async function codeReviewCommand(sourceControl?: unknown): Promise<void> {
  if (activeReview) {
    revealReviewPanel(); // already running — the SCM button is a stop button meanwhile
    return;
  }

  const { repo, reason } = await getGitRepository(rootUriFromArg(sourceControl));
  if (!repo) {
    const choice = await vscode.window.showErrorMessage(`ASKII: ${reason}`, 'Open Source Control');
    if (choice === 'Open Source Control') {
      vscode.commands.executeCommand('workbench.view.scm');
    }
    return;
  }

  const { files, diff } = await collectUncommittedChanges(repo, MAX_REVIEW_DIFF_CHARS);
  if (files.length === 0 && !diff.trim()) {
    vscode.window.showInformationMessage('ASKII: No uncommitted changes to review. (´･_･`)');
    return;
  }

  const abortController = new AbortController();
  const { signal } = abortController;
  activeReview = abortController;
  setRunning(true);

  const repoRoot = repo.rootUri.fsPath;
  beginReviewPanel(
    { repoName: path.basename(repoRoot), fileCount: files.length },
    {
      cancel: () => abortController.abort(),
      rerun: () => void codeReviewCommand({ rootUri: repo.rootUri }),
      autoFix: (problem, fixSignal) => autoFixProblem(repoRoot, problem, fixSignal),
      open: (problem) => openProblem(repoRoot, problem),
    },
  );

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: 'ASKII: Reviewing uncommitted changes…',
        cancellable: true,
      },
      async (_progress, token) => {
        const cancelSub = token.onCancellationRequested(() => abortController.abort());
        try {
          const raw = await getExtensionResponse(
            buildReviewUserPrompt(files, diff),
            buildReviewSystemPrompt(),
            'general',
            signal,
          );
          // Some providers ignore the signal — drop a result that arrives late.
          if (signal.aborted) {
            finishReviewPanel('cancelled');
            return;
          }
          if (!raw || raw.trim() === NO_RESPONSE) {
            finishReviewPanel('error', { message: 'The model returned no review. Try again.' });
            return;
          }
          const problems = parseReviewProblems(raw);
          if (!problems) {
            finishReviewPanel('error', {
              message: "Couldn't read the model's review response. Try again.",
            });
            return;
          }
          finishReviewPanel('done', { problems });
        } catch (e) {
          if (signal.aborted) {
            finishReviewPanel('cancelled');
            return;
          }
          const msg = e instanceof Error ? e.message : String(e);
          finishReviewPanel('error', { message: `The review failed: ${msg}` });
        } finally {
          cancelSub.dispose();
        }
      },
    );
  } finally {
    if (activeReview === abortController) {
      activeReview = undefined;
    }
    setRunning(false);
  }
}
