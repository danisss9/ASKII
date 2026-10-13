import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/** Minimal shape of a commit entry returned by the Git extension's log(). */
export interface GitLogCommitLike {
  message?: string;
}

interface GitChangeLike {
  uri: vscode.Uri;
  status: number;
}

export interface GitRepositoryLike {
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
  log?(options?: { maxEntries?: number }): Promise<GitLogCommitLike[]>;
  state: {
    indexChanges?: GitChangeLike[];
    workingTreeChanges?: GitChangeLike[];
    untrackedChanges?: GitChangeLike[];
  };
  rootUri: vscode.Uri;
}

interface GitApiLike {
  repositories: GitRepositoryLike[];
}

// Status.UNTRACKED in the Git extension's API.
const GIT_STATUS_UNTRACKED = 7;

// Cap each untracked file so one large new file doesn't crowd out the diff.
const MAX_UNTRACKED_FILE_CHARS = 8_000;

/**
 * Returns the rootUri of the SourceControl that an scm/title button passes as
 * its argument; the command palette and status-bar menu pass nothing (or an
 * unrelated argument).
 */
export function rootUriFromArg(sourceControl?: unknown): vscode.Uri | undefined {
  const rootUri = (sourceControl as { rootUri?: unknown } | undefined)?.rootUri;
  return rootUri instanceof vscode.Uri ? rootUri : undefined;
}

/**
 * Acquires the built-in vscode.git extension's API and returns the repository
 * to operate on. Prefers the repository the command was invoked on (the
 * Source Control view passes its SourceControl), then the one whose root
 * contains the active editor's file; falls back to the first repository.
 * Returns null with an actionable reason if Git is unavailable or no repo is open.
 */
export async function getGitRepository(
  requestedRoot?: vscode.Uri,
): Promise<{ repo: GitRepositoryLike; reason?: string } | { repo: null; reason: string }> {
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

  if (requestedRoot) {
    const requested = api.repositories.find(
      (repo) => repo.rootUri.toString() === requestedRoot.toString(),
    );
    if (requested) {
      return { repo: requested };
    }
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

/** Repo-relative path with forward slashes. */
function relativePath(repo: GitRepositoryLike, uri: vscode.Uri): string {
  return path.relative(repo.rootUri.fsPath, uri.fsPath).replace(/\\/g, '/');
}

async function readUntrackedFile(uri: vscode.Uri): Promise<string | null> {
  try {
    const stat = await fs.promises.stat(uri.fsPath);
    if (!stat.isFile()) {
      return null;
    }
    const text = await fs.promises.readFile(uri.fsPath, 'utf8');
    if (text.includes('\0')) {
      return null; // binary
    }
    return text.length > MAX_UNTRACKED_FILE_CHARS
      ? `${text.slice(0, MAX_UNTRACKED_FILE_CHARS)}\n…[file truncated]`
      : text;
  } catch {
    return null;
  }
}

/**
 * Collects every uncommitted change: the staged diff, the unstaged diff and
 * the contents of untracked files (which git diff leaves out). Returns the
 * repo-relative changed file list and the combined text, truncated at maxChars.
 */
export async function collectUncommittedChanges(
  repo: GitRepositoryLike,
  maxChars: number,
): Promise<{ files: string[]; diff: string }> {
  const staged = repo.state.indexChanges ?? [];
  const working = repo.state.workingTreeChanges ?? [];
  const untracked = [
    ...working.filter((c) => c.status === GIT_STATUS_UNTRACKED),
    ...(repo.state.untrackedChanges ?? []),
  ];

  const files = [
    ...new Set([...staged, ...working, ...untracked].map((c) => relativePath(repo, c.uri))),
  ];

  const sections: string[] = [];
  try {
    const stagedDiff = staged.length > 0 ? await repo.diff(true) : '';
    if (stagedDiff.trim()) {
      sections.push(`Staged diff:\n${stagedDiff}`);
    }
    const workingDiff = await repo.diff(false);
    if (workingDiff.trim()) {
      sections.push(`Unstaged diff:\n${workingDiff}`);
    }
  } catch {
    // Diff unavailable — the file list and untracked contents still help.
  }

  const seen = new Set<string>();
  for (const change of untracked) {
    const rel = relativePath(repo, change.uri);
    if (seen.has(rel)) {
      continue;
    }
    seen.add(rel);
    const text = await readUntrackedFile(change.uri);
    if (text !== null) {
      sections.push(`New untracked file ${rel}:\n${text}`);
    }
  }

  const raw = sections.join('\n\n');
  const diff = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…[diff truncated]` : raw;
  return { files, diff };
}
