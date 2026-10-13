import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionResponse } from './providers';
import { buildCommitMessageSystemPrompt, getCommitMessageStyle } from './commitMessageStyle';
import { getGitRepository, rootUriFromArg, type GitRepositoryLike } from './git';

// Sentinel returned by providers when the model produces no text.
const NO_RESPONSE = 'No response';

// Cap the diff we send to the model so a huge changeset doesn't blow up the
// context window or latency. The file summary is always sent in full.
const MAX_DIFF_CHARS = 12_000;

// The repository's recent commit messages are sent to the model as style
// examples so generated messages match the user's existing habits.
const MAX_RECENT_COMMITS = 10;

// Cap each example message so huge commit bodies don't dominate the prompt.
const MAX_EXAMPLE_MESSAGE_CHARS = 500;

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
 * to the working-tree diff when nothing is staged. Returns a file summary and
 * a (possibly truncated) unified diff.
 */
async function collectDiff(
  repo: GitRepositoryLike,
): Promise<{ diff: string; fileSummary: string; hasStaged: boolean }> {
  const stagedFiles = (repo.state.indexChanges ?? []).map((c) => path.basename(c.uri.fsPath));
  const workingFiles = (repo.state.workingTreeChanges ?? []).map((c) =>
    path.basename(c.uri.fsPath),
  );

  // Prefer staged diff; fall back to working-tree diff.
  let raw = '';
  let hasStaged = stagedFiles.length > 0;
  try {
    if (hasStaged) {
      raw = await repo.diff(true);
    }
    if (!raw || !raw.trim()) {
      raw = await repo.diff(false);
      hasStaged = false;
    }
  } catch {
    raw = '';
  }

  const diff =
    raw.length > MAX_DIFF_CHARS ? `${raw.slice(0, MAX_DIFF_CHARS)}\n…[diff truncated]` : raw;

  const changedFiles = hasStaged ? stagedFiles : workingFiles;
  const fileSummary =
    changedFiles.length > 0 ? changedFiles.join('\n') : '(no file list available)';

  return { diff, fileSummary, hasStaged };
}

/**
 * Formats one example commit message: caps its length and indents wrapped
 * lines so multi-line messages stay nested under their numbered bullet.
 */
function formatExampleMessage(message: string): string {
  const normalized = message.replace(/\r\n/g, '\n').trim();
  const capped =
    normalized.length > MAX_EXAMPLE_MESSAGE_CHARS
      ? `${normalized.slice(0, MAX_EXAMPLE_MESSAGE_CHARS)}…`
      : normalized;
  return capped.replace(/\n/g, '\n   ');
}

/**
 * Fetches the repository's last commit messages to use as style examples for
 * the model. Returns '' when the log is unavailable (older Git extension,
 * no commits yet) so the prompt simply omits the section.
 */
async function collectRecentCommitMessages(repo: GitRepositoryLike): Promise<string> {
  if (!repo.log) {
    return '';
  }
  let messages: string[];
  try {
    const commits = await repo.log({ maxEntries: MAX_RECENT_COMMITS });
    messages = (commits ?? [])
      .map((c) => (c.message ?? '').trim())
      .filter(Boolean)
      .map(formatExampleMessage);
  } catch {
    return '';
  }
  if (messages.length === 0) {
    return '';
  }
  return (
    'Recent commit messages (style examples from this repository):\n' +
    messages.map((m, i) => `${i + 1}. ${m}`).join('\n')
  );
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

  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Cleans the model output into a bare commit message: strips markdown fences,
 * leading/trailing quotes, and common "Commit message:" labels.
 */
function cleanCommitMessage(raw: string): string {
  let text = raw.trim();

  // Strip surrounding markdown code fences.
  const fenceMatch = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Strip a leading "Commit message:" / "Message:" label.
  text = text.replace(/^(commit\s*message|message)\s*[:\-]\s*/i, '');

  // Strip surrounding quotes.
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text.trim();
}

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

  const { diff, fileSummary, hasStaged } = await collectDiff(repo);
  if (!diff.trim() && fileSummary === '(no file list available)') {
    vscode.window.showInformationMessage('ASKII: No changes to commit. (´･_･`)');
    return;
  }

  const instructions = loadCommitInstructions();
  const style = getCommitMessageStyle(config.get<string>('commitMessageStyle'));
  const system = buildCommitMessageSystemPrompt(style, instructions);
  const examples = await collectRecentCommitMessages(repo);

  const scope = hasStaged ? 'staged' : 'working-tree';
  const userPrompt =
    `Changed files (${scope}):\n${fileSummary}\n\n` +
    `Unified diff (${scope}):\n${diff || '(empty)'}\n\n` +
    (examples ? `${examples}\n\n` : '') +
    (examples
      ? 'Write the commit message now, matching the style of the example messages above.'
      : 'Write the commit message now.');

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
          config.get<string>('llmInlinePlatform'),
          config.get<string>('llmInlineModel'),
          signal,
        );

        // Some providers ignore the signal — drop a result that arrives late.
        if (signal.aborted) {
          vscode.window.setStatusBarMessage('ASKII: Commit message generation stopped.', 3000);
          return;
        }

        if (!raw || raw.trim() === NO_RESPONSE) {
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
