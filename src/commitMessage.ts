import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getExtensionResponse } from './providers';
import { buildCommitMessageSystemPrompt, getCommitMessageStyle } from './commitMessageStyle';

// Sentinel returned by providers when the model produces no text.
const NO_RESPONSE = 'No response';

// Cap the diff we send to the model so a huge changeset doesn't blow up the
// context window or latency. The file summary is always sent in full.
const MAX_DIFF_CHARS = 12_000;

// Commit messages are short — keep generation tight.
const COMMIT_MAX_TOKENS = 256;

interface GitRepositoryLike {
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
  state: {
    indexChanges?: { uri: vscode.Uri; status: number }[];
    workingTreeChanges?: { uri: vscode.Uri; status: number }[];
  };
  rootUri: vscode.Uri;
}

interface GitApiLike {
  repositories: GitRepositoryLike[];
}

/**
 * Acquires the built-in vscode.git extension's API and returns the repository
 * to operate on. Prefers the repository whose root contains the active editor's
 * file; falls back to the first repository. Returns null with an actionable
 * reason if Git is unavailable or no repo is open.
 */
async function getGitRepository(): Promise<
  { repo: GitRepositoryLike; reason?: string } | { repo: null; reason: string }
> {
  const gitExt = vscode.extensions.getExtension('vscode.git');
  if (!gitExt) {
    return { repo: null, reason: 'The built-in Git extension is not available.' };
  }
  if (!gitExt.isActive) {
    await gitExt.activate();
  }
  const api = (gitExt.exports as { getAPI?(version: number): GitApiLike })?.getAPI?.(1);
  if (!api || api.repositories.length === 0) {
    return { repo: null, reason: 'No Git repository found in the current workspace.' };
  }

  const active = vscode.window.activeTextEditor;
  if (active) {
    const activePath = active.document.uri.fsPath;
    for (const repo of api.repositories) {
      try {
        const rel = path.relative(repo.rootUri.fsPath, activePath);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          return { repo };
        }
      } catch {
        // ignore — fall through to default
      }
    }
  }
  return { repo: api.repositories[0] };
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

export async function generateCommitMessageCommand(): Promise<void> {
  const config = vscode.workspace.getConfiguration('askii');

  const { repo, reason } = await getGitRepository();
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

  const scope = hasStaged ? 'staged' : 'working-tree';
  const userPrompt =
    `Changed files (${scope}):\n${fileSummary}\n\n` +
    `Unified diff (${scope}):\n${diff || '(empty)'}\n\n` +
    `Write the commit message now.`;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.SourceControl,
      title: 'ASKII: Generating commit message…',
      cancellable: false,
    },
    async () => {
      try {
        const raw = await getExtensionResponse(
          userPrompt,
          system,
          config.get<string>('llmInlinePlatform'),
          config.get<string>('llmInlineModel'),
        );

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
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`ASKII: Failed to generate commit message: ${msg}`);
      }
    },
  );
}
