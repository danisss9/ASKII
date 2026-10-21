import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionResponse } from './providers';
import { log } from './log';
import {
  MAX_RECENT_COMMITS,
  buildCommitMessageSystemPrompt,
  buildCommitUserPrompt,
  cleanCommitMessage,
  formatCommitExamples,
  getCommitMessageStyle,
} from '@common/commitMessage';
import { getGitRepository, rootUriFromArg, type GitRepositoryLike } from './git';

// Context key that swaps the SCM sparkle button for a stop button.
const RUNNING_CONTEXT_KEY = 'askii.commitMessageRunning';

// Aborts the in-flight generation; set only while one is running.
let activeGeneration: AbortController | undefined;

function setRunning(running: boolean): void {
  void vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, running);
}

/** Stops the in-flight commit message generation (the SCM stop button). */
export function cancelCommitMessageCommand(): void {
  activeGeneration?.abort();
}

/**
 * Collects the diff to send to the model. Prefers staged changes; falls back
 * to the working-tree diff when nothing is staged.
 */
async function collectDiff(
  repo: GitRepositoryLike,
): Promise<{ diff: string; files: string[]; hasStaged: boolean }> {
  const stagedFiles = (repo.state.indexChanges ?? []).map((c) => path.basename(c.uri.fsPath));
  const workingFiles = (repo.state.workingTreeChanges ?? []).map((c) =>
    path.basename(c.uri.fsPath),
  );

  // Prefer staged diff; fall back to working-tree diff.
  let diff = '';
  let hasStaged = stagedFiles.length > 0;
  try {
    if (hasStaged) {
      diff = await repo.diff(true);
    }
    if (!diff || !diff.trim()) {
      diff = await repo.diff(false);
      hasStaged = false;
    }
  } catch {
    diff = '';
  }

  return { diff, files: hasStaged ? stagedFiles : workingFiles, hasStaged };
}

/**
 * Fetches the repository's last commit messages as style examples. Returns ''
 * when the log is unavailable (older Git extension, no commits yet).
 */
async function collectRecentCommitMessages(repo: GitRepositoryLike): Promise<string> {
  if (!repo.log) {
    return '';
  }
  try {
    const commits = await repo.log({ maxEntries: MAX_RECENT_COMMITS });
    return formatCommitExamples((commits ?? []).map((c) => c.message ?? ''));
  } catch {
    return '';
  }
}

/**
 * Reads the user's custom instruction .md file (if configured and present) and
 * returns its text to append to the system prompt. Returns '' when unset/missing.
 */
function loadCommitInstructions(): string {
  const config = vscode.workspace.getConfiguration('askii');
  const setting = (config.get<string>('commitMessageInstructions') ?? '').trim();
  if (!setting) {
    return '';
  }

  let filePath = setting;
  if (!path.isAbsolute(filePath)) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root) {
      return '';
    }
    filePath = path.join(root, filePath);
  }

  // Only plain instruction files are read into the prompt — the setting can
  // come from a repo's .vscode/settings.json, and must not be able to pull an
  // arbitrary file (an SSH key, a .env) into a request.
  if (!INSTRUCTION_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    log.warn(`askii.commitMessageInstructions ignored: ${filePath} is not a .md or .txt file`);
    return '';
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_INSTRUCTIONS_BYTES) {
      return '';
    }
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

const INSTRUCTION_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const MAX_INSTRUCTIONS_BYTES = 64 * 1024;

export async function generateCommitMessageCommand(sourceControl?: unknown): Promise<void> {
  if (activeGeneration) {
    return; // already running — the SCM button is a stop button meanwhile
  }
  const abortController = new AbortController();
  activeGeneration = abortController;
  setRunning(true);
  try {
    await generateCommitMessage(sourceControl, abortController.signal);
  } finally {
    activeGeneration = undefined;
    setRunning(false);
  }
}

async function generateCommitMessage(sourceControl: unknown, signal: AbortSignal): Promise<void> {
  const config = vscode.workspace.getConfiguration('askii');

  const { repo, reason } = await getGitRepository(rootUriFromArg(sourceControl));
  if (!repo) {
    const choice = await vscode.window.showErrorMessage(`ASKII: ${reason}`, 'Open Source Control');
    if (choice === 'Open Source Control') {
      vscode.commands.executeCommand('workbench.view.scm');
    }
    return;
  }

  const { diff, files, hasStaged } = await collectDiff(repo);
  if (!diff.trim() && files.length === 0) {
    vscode.window.showInformationMessage('ASKII: No changes to commit. (´･_･`)');
    return;
  }

  const instructions = loadCommitInstructions();
  const style = getCommitMessageStyle(config.get<string>('commitMessageStyle'));
  const system = buildCommitMessageSystemPrompt(style, instructions);
  const examples = await collectRecentCommitMessages(repo);

  const userPrompt = buildCommitUserPrompt({ files, diff, staged: hasStaged, examples });

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: 'ASKII: Generating commit message…',
      cancellable: true,
    },
    async (_progress, token) => {
      const cancelSub = token.onCancellationRequested(() => activeGeneration?.abort());
      try {
        const raw = await getExtensionResponse(
          userPrompt,
          system,
          'inline',
          signal,
        );

        // Some providers ignore the signal — drop a result that arrives late.
        if (signal.aborted) {
          vscode.window.setStatusBarMessage('ASKII: Commit message generation stopped.', 3000);
          return;
        }

        if (!raw || !raw.trim()) {
          vscode.window.showWarningMessage(
            'ASKII: The model returned no commit message. Try again.',
          );
          return;
        }

        const cleaned = cleanCommitMessage(raw);
        if (!cleaned) {
          vscode.window.showWarningMessage(
            'ASKII: The model returned no commit message. Try again.',
          );
          return;
        }

        // Don't silently throw away a message the user already typed
        const existing = repo.inputBox.value.trim();
        if (existing && existing !== cleaned) {
          const choice = await vscode.window.showWarningMessage(
            'ASKII: The commit message box already has text. Replace it with the generated message?',
            'Replace',
            'Keep mine',
          );
          if (choice !== 'Replace') {
            return;
          }
        }
        repo.inputBox.value = cleaned;
        vscode.window.showInformationMessage('ASKII: Commit message generated! (⌐■_■)');
      } catch (e) {
        if (signal.aborted) {
          vscode.window.setStatusBarMessage('ASKII: Commit message generation stopped.', 3000);
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`ASKII: Failed to generate commit message: ${msg}`);
      } finally {
        cancelSub.dispose();
      }
    },
  );
}
