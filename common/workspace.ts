import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import { balancedJsonAt, decodeIfDoubleEscaped, parseJsonFromModel } from './utils';

export interface WorkspaceAction {
  type:
    | 'view'
    | 'create'
    | 'modify'
    | 'write'
    | 'delete'
    | 'rename'
    | 'list'
    | 'search'
    | 'wiki_search'
    | 'code_search'
    | 'run'
    | 'copy'
    | 'mkdir';
  path?: string;
  paths?: string[]; // multi-file view
  newPath?: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
  startLine?: number; // partial view / line-range modify (1-indexed)
  endLine?: number;
  pattern?: string; // search (code grep)
  query?: string; // wiki_search / code_search (natural language)
  command?: string; // run
}

export type ActionResult = {
  action: string;
  status: 'ok' | 'skipped' | 'error';
  detail?: string;
};

const BACKUP_DIR = path.join('.askii', 'backups');
const CREATED_LOG = path.join('.askii', 'created.json');

function backupPathFor(workspaceRoot: string, filePath: string): string {
  return path.join(workspaceRoot, BACKUP_DIR, path.relative(workspaceRoot, filePath));
}

/**
 * Copy filePath into .askii/backups/, preserving relative path. No-op if file
 * doesn't exist, or if it was already backed up this session — the first
 * backup holds the pre-session original that "Undo all" must restore.
 */
export function writeBackup(workspaceRoot: string, filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) {return;}
    const backupPath = backupPathFor(workspaceRoot, filePath);
    if (fs.existsSync(backupPath)) {return;}
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(filePath, backupPath);
  } catch {
    // Best-effort — don't block the action if backup fails
  }
}

/**
 * Prepare to write a file the agent did not necessarily create: an existing
 * file is backed up, a new one is recorded as created so undo removes it.
 */
export function backupOrRecordCreated(workspaceRoot: string, filePath: string): void {
  if (fs.existsSync(filePath)) {
    writeBackup(workspaceRoot, filePath);
  } else {
    recordCreatedFile(workspaceRoot, path.relative(workspaceRoot, filePath));
  }
}

/**
 * Record a newly created file so it can be deleted on restore. Skipped when the
 * path already has a backup (deleted then re-created) — undo restores it instead.
 */
export function recordCreatedFile(workspaceRoot: string, relativePath: string): void {
  try {
    if (fs.existsSync(backupPathFor(workspaceRoot, path.resolve(workspaceRoot, relativePath)))) {
      return;
    }
    const logPath = path.join(workspaceRoot, CREATED_LOG);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    let list: string[] = [];
    if (fs.existsSync(logPath)) {
      try {
        list = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      } catch {
        /* ignore */
      }
    }
    if (!list.includes(relativePath)) {list.push(relativePath);}
    fs.writeFileSync(logPath, JSON.stringify(list));
  } catch {
    // Best-effort
  }
}

/** Delete the entire .askii/backups/ directory and created-files log. */
export function deleteAllBackups(workspaceRoot: string): void {
  const backupDir = path.join(workspaceRoot, BACKUP_DIR);
  if (fs.existsSync(backupDir)) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
  const logPath = path.join(workspaceRoot, CREATED_LOG);
  if (fs.existsSync(logPath)) {
    fs.unlinkSync(logPath);
  }
}

/** Restore all backed-up files and delete any files that were created this session. */
export function restoreAllBackups(workspaceRoot: string): {
  restored: string[];
  deleted: string[];
} {
  const backupDir = path.join(workspaceRoot, BACKUP_DIR);
  const restored: string[] = [];
  function walk(dir: string): void {
    if (!fs.existsSync(dir)) {return;}
    for (const name of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, name);
      // lstat: a symlink planted in the backup folder must not be followed
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {continue;}
      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        const rel = path.relative(backupDir, fullPath);
        let dest: string;
        try {
          dest = sandboxPath(workspaceRoot, rel);
        } catch {
          continue;
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(fullPath, dest);
        restored.push(rel);
      }
    }
  }
  walk(backupDir);

  const deleted: string[] = [];
  const logPath = path.join(workspaceRoot, CREATED_LOG);
  if (fs.existsSync(logPath)) {
    try {
      const list: unknown = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      for (const rel of Array.isArray(list) ? list : []) {
        if (typeof rel !== 'string') {continue;}
        try {
          const fullPath = sandboxPath(workspaceRoot, rel);
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            deleted.push(rel);
          }
        } catch {
          /* best-effort — outside the workspace or already gone */
        }
      }
    } catch {
      /* ignore malformed log */
    }
  }

  return { restored, deleted };
}

/** Returns true if any backups or created-file records exist for this workspace. */
export function hasBackups(workspaceRoot: string): boolean {
  return (
    fs.existsSync(path.join(workspaceRoot, BACKUP_DIR)) ||
    fs.existsSync(path.join(workspaceRoot, CREATED_LOG))
  );
}

export function getWorkspaceStructure(dirPath: string): string {
  let structure = '';
  try {
    const files = fs.readdirSync(dirPath);
    const filtered = files.filter(
      (f: string) => !f.startsWith('.') && f !== 'node_modules' && f !== 'dist',
    );

    const LISTING_LIMIT = 200;
    for (const file of filtered.slice(0, LISTING_LIMIT)) {
      const stat = fs.statSync(path.join(dirPath, file));
      const isDir = stat.isDirectory();
      structure += `${file} [${isDir ? 'folder' : 'file'}]\n`;
    }
    if (filtered.length > LISTING_LIMIT) {
      structure += `[...${filtered.length - LISTING_LIMIT} more items not shown]\n`;
    }
  } catch (_) {
    // Ignore errors
  }
  return structure;
}

/**
 * Returns the [...] that opens at text[start], matching brackets outside JSON
 * strings, or null if it never closes (e.g. output cut off mid-array).
 */
export function balancedArrayAt(text: string, start: number): string | null {
  return text[start] === '[' ? balancedJsonAt(text, start) : null;
}

/** Feedback sent back to the model when its response could not be parsed. */
export const INVALID_ACTIONS_FEEDBACK =
  'Your last response was not a valid JSON array of actions (it may have been cut off). ' +
  'Respond with ONLY a JSON array. For large files prefer several smaller modify actions over one huge write.';

const ACTION_TYPES: readonly string[] = [
  'view',
  'create',
  'modify',
  'write',
  'delete',
  'rename',
  'list',
  'search',
  'wiki_search',
  'code_search',
  'run',
  'copy',
  'mkdir',
];

export interface ParsedWorkspaceResponse {
  actions: WorkspaceAction[];
  /** Action types the model sent that ASKII does not know — reported back so it can correct itself. */
  ignoredTypes: string[];
}

/**
 * Parses the model's action array. Returns null when no valid JSON array could
 * be found — distinct from an empty list ("task complete") so callers can ask again.
 */
export function parseWorkspaceResponse(responseText: string): ParsedWorkspaceResponse | null {
  const parsed = parseJsonFromModel(responseText, Array.isArray, '[');
  if (!Array.isArray(parsed)) {
    return null;
  }
  const actions: WorkspaceAction[] = [];
  const ignoredTypes: string[] = [];
  for (const raw of parsed) {
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof type === 'string' && ACTION_TYPES.includes(type)) {
      actions.push(raw as WorkspaceAction);
    } else {
      ignoredTypes.push(typeof type === 'string' ? type : '(missing type)');
    }
  }
  return { actions, ignoredTypes };
}

/**
 * Parses the model's action array, dropping unknown action types. Returns
 * null when no valid JSON array could be found — distinct from [] ("task
 * complete") so callers can ask again.
 */
export function parseWorkspaceActions(responseText: string): WorkspaceAction[] | null {
  return parseWorkspaceResponse(responseText)?.actions ?? null;
}

/**
 * Applies a modify action to a file's text. Line-range modifies replace
 * [startLine, endLine] (1-indexed, inclusive) keeping the file's line endings;
 * string modifies replace the first occurrence of oldContent literally.
 * Returns the new text, or an error message.
 */
export function applyModifyAction(
  existing: string,
  action: WorkspaceAction,
): { text: string } | { error: string } {
  if (action.startLine !== undefined || action.endLine !== undefined) {
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const lines = existing.split(/\r?\n/);
    const start = Math.max(0, (action.startLine ?? 1) - 1);
    const end = Math.max(start, action.endLine ?? lines.length);
    const replacement = decodeIfDoubleEscaped(action.newContent ?? '').split(/\r?\n/);
    lines.splice(start, end - start, ...replacement);
    return { text: lines.join(eol) };
  }

  if (!action.oldContent) {
    return { error: `modify requires oldContent or startLine/endLine (${action.path})` };
  }
  let oldContent = action.oldContent;
  let newContent = action.newContent ?? '';
  if (!existing.includes(oldContent)) {
    // The model may have double-escaped the snippet — retry with it decoded
    const decoded = decodeIfDoubleEscaped(oldContent);
    if (decoded === oldContent || !existing.includes(decoded)) {
      return { error: `oldContent not found in ${action.path}` };
    }
    oldContent = decoded;
    newContent = decodeIfDoubleEscaped(newContent);
  }
  // Function replacer: a string replacement would expand $&, $$, $` and $'
  return { text: existing.replace(oldContent, () => newContent) };
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Real path of p, resolving symlinks in every component that exists — the
 * missing tail (a file about to be created) is appended as-is. A dangling
 * symlink is rejected: writing through it would create its target, which may
 * be anywhere.
 */
function realpathOfNearestExisting(p: string): string {
  const missing: string[] = [];
  let current = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing);
    } catch {
      let isLink = false;
      try {
        isLink = fs.lstatSync(current).isSymbolicLink();
      } catch {
        // does not exist at all — keep walking up
      }
      if (isLink) {
        throw new Error(`Path traversal blocked: ${p} goes through a dangling symlink`);
      }
      const parent = path.dirname(current);
      if (parent === current) {return p;}
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves relativePath under workspaceRoot and throws if it escapes the
 * root — lexically (../, absolute paths) or through a symlink that points
 * outside the workspace.
 */
export function sandboxPath(workspaceRoot: string, relativePath: string): string {
  const normalizedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!isInside(normalizedRoot, resolved)) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  const realRoot = realpathOfNearestExisting(normalizedRoot);
  if (!isInside(realRoot, realpathOfNearestExisting(resolved))) {
    throw new Error(`Path traversal blocked: ${relativePath} resolves outside the workspace`);
  }
  return resolved;
}

/** Folders ASKII Do never writes into: git internals (hooks run code) and its own backups. */
const BLOCKED_WRITE_DIRS = new Set(['.git', '.askii']);
/**
 * Folders whose files can make the editor or git run code (tasks, launch
 * configs, settings, hooks) — writes there are always confirmed, even with
 * auto-confirm on.
 */
const SENSITIVE_WRITE_DIRS = new Set(['.vscode', '.husky', '.githooks', '.devcontainer']);

export type WritePathPolicy = 'allowed' | 'sensitive' | 'blocked';

/** Classifies a write target inside the workspace (path from sandboxPath). */
export function getWritePathPolicy(workspaceRoot: string, filePath: string): WritePathPolicy {
  const segments = path
    .relative(path.resolve(workspaceRoot), filePath)
    .split(/[\\/]+/)
    .map((segment) => segment.toLowerCase());
  // .git anywhere (submodules); .askii only at the root, where Do keeps its backups
  if (segments.includes('.git') || BLOCKED_WRITE_DIRS.has(segments[0])) {
    return 'blocked';
  }
  return segments.some((segment) => SENSITIVE_WRITE_DIRS.has(segment)) ? 'sensitive' : 'allowed';
}

const LIST_EXCLUDED = new Set(['node_modules', 'dist', '.git', '.askii']);

/**
 * Executes a view (single file, optional line range) or list action.
 * Returns raw string content/listing.
 */
export function executeViewAction(action: WorkspaceAction, workspaceRoot: string): string {
  if (action.type === 'list') {
    const dirPath = sandboxPath(workspaceRoot, action.path ?? '.');
    const entries = fs
      .readdirSync(dirPath)
      .filter((name) => !LIST_EXCLUDED.has(name))
      .map((name) => {
        const stat = fs.statSync(path.join(dirPath, name));
        return `${name} [${stat.isDirectory() ? 'folder' : 'file'}]`;
      });
    return entries.join('\n');
  }

  // view
  if (!action.path) {
    throw new Error('view requires path');
  }
  const filePath = sandboxPath(workspaceRoot, action.path);
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (action.startLine !== undefined || action.endLine !== undefined) {
    const lines = raw.split('\n');
    const start = Math.max(0, (action.startLine ?? 1) - 1); // 1-indexed → 0-indexed
    const end = action.endLine ?? lines.length;
    return capText(lines.slice(start, end).join('\n'), MAX_VIEW_CHARS, 'use startLine/endLine to view the rest');
  }
  return capText(raw, MAX_VIEW_CHARS, 'use startLine/endLine to view the rest');
}

const MAX_VIEW_CHARS = 200_000;
const MAX_SEARCH_RESULTS = 500;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024;

function capText(text: string, max: number, hint: string): string {
  return text.length > max
    ? `${text.slice(0, max)}\n[...truncated ${text.length - max} more characters — ${hint}]`
    : text;
}

/**
 * Recursively greps the workspace for pattern (case-insensitive literal),
 * excluding node_modules/dist/.git/.askii. Symlinks are not followed — they
 * could lead outside the workspace or loop. Returns "file:line: match" lines.
 */
export function executeSearchAction(action: WorkspaceAction, workspaceRoot: string): string {
  const pattern = action.pattern ?? '';
  if (!pattern) {return 'Error: search requires a pattern';}

  const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escapedPattern, 'i');
  const results: string[] = [];
  let truncated = false;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (truncated) {return;}
      if (LIST_EXCLUDED.has(name)) {continue;}
      const fullPath = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {continue;}
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && stat.size <= MAX_SEARCH_FILE_BYTES) {
        try {
          const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              if (results.length >= MAX_SEARCH_RESULTS) {
                truncated = true;
                return;
              }
              const rel = path.relative(workspaceRoot, fullPath);
              results.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            }
          }
        } catch {
          // Skip binary or unreadable files
        }
      }
    }
  }

  walk(workspaceRoot);
  if (results.length === 0) {return 'No matches found';}
  return truncated
    ? `${results.join('\n')}\n[...more than ${MAX_SEARCH_RESULTS} matches — use a more specific pattern]`
    : results.join('\n');
}

/**
 * Executes a write action whose path was already resolved with sandboxPath.
 * Backs files up first so "Undo all" can restore them; newPath targets are
 * sandboxed here. `afterWrite` runs on files whose content changed (used by
 * the extension to format). Returns 'ok' or an error message.
 */
export async function executeWriteAction(
  action: WorkspaceAction,
  filePath: string,
  workspaceRoot: string,
  afterWrite?: (filePath: string) => Promise<void>,
): Promise<'ok' | string> {
  switch (action.type) {
    case 'mkdir': {
      fs.mkdirSync(filePath, { recursive: true });
      return 'ok';
    }

    case 'copy': {
      if (!action.newPath) {return 'copy requires newPath';}
      const destPath = sandboxPath(workspaceRoot, action.newPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      backupOrRecordCreated(workspaceRoot, destPath);
      fs.copyFileSync(filePath, destPath);
      return 'ok';
    }

    case 'create':
    case 'write': {
      // Either type may target an existing file — back it up rather than
      // recording it as created (undo would otherwise delete the original).
      backupOrRecordCreated(workspaceRoot, filePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, decodeIfDoubleEscaped(action.content ?? ''));
      await afterWrite?.(filePath);
      return 'ok';
    }

    case 'modify': {
      const result = applyModifyAction(fs.readFileSync(filePath, 'utf-8'), action);
      if ('error' in result) {return result.error;}
      writeBackup(workspaceRoot, filePath);
      fs.writeFileSync(filePath, result.text);
      await afterWrite?.(filePath);
      return 'ok';
    }

    case 'delete': {
      writeBackup(workspaceRoot, filePath);
      fs.unlinkSync(filePath);
      return 'ok';
    }

    case 'rename': {
      if (!action.newPath) {return 'rename requires newPath';}
      const newFilePath = sandboxPath(workspaceRoot, action.newPath);
      writeBackup(workspaceRoot, filePath);
      fs.mkdirSync(path.dirname(newFilePath), { recursive: true });
      backupOrRecordCreated(workspaceRoot, newFilePath);
      fs.renameSync(filePath, newFilePath);
      return 'ok';
    }

    default:
      return `Unknown action type: ${(action as WorkspaceAction).type}`;
  }
}

export interface ShellResult {
  ok: boolean;
  /** stdout followed by stderr, capped at maxOutputChars. */
  output: string;
  timedOut: boolean;
}

/** Kills a shell and everything it started (the shell alone would leave e.g. a dev server running). */
function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) {return;}
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // already exited
  }
}

/**
 * Runs a shell command for the Do agent's `run` action. On timeout or abort
 * the whole process tree is killed, not just the shell; stderr is kept even
 * when the command succeeds.
 */
export function runShellCommand(
  command: string,
  cwd: string,
  options: { signal?: AbortSignal; timeoutMs?: number; maxOutputChars?: number } = {},
): Promise<ShellResult> {
  const { signal, timeoutMs = 30_000, maxOutputChars = 1024 * 1024 } = options;
  return new Promise((resolve) => {
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const append = (current: string, chunk: Buffer): string =>
      current.length < maxOutputChars ? current + chunk.toString('utf-8') : current;

    // Own process group on POSIX (detached) so the whole tree can be killed
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr?.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    const onAbort = () => killProcessTree(child.pid);
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    let settled = false;
    const finish = (ok: boolean, fallback: string) => {
      if (settled) {return;}
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      const text = timedOut
        ? `${output}\n[timed out after ${timeoutMs / 1000}s — process killed]`.trim()
        : output || fallback;
      resolve({ ok: ok && !timedOut, output: capText(text, maxOutputChars, 'output truncated'), timedOut });
    };
    child.on('error', (error) => finish(false, error.message));
    child.on('close', (code, sig) =>
      finish(code === 0, code === null ? `Killed (${sig ?? 'signal'})` : `Exited with code ${code}`),
    );
  });
}

/** Builds the system prompt for the do command (shared by extension + CLI). */
export function buildDoSystemPrompt(
  workspaceStructure: string,
  wikiAvailable = false,
  codeWikiAvailable = false,
): string {
  const wikiAction = wikiAvailable
    ? `- {"type": "wiki_search", "query": "natural language question"} — search the documentation wiki and get relevant context back\n`
    : '';
  const codeWikiAction = codeWikiAvailable
    ? `- {"type": "code_search", "query": "natural language description of the code to find"} — semantic search over the indexed workspace code\n`
    : '';

  return `You are ASKII, an AI agent that can create, modify, view, delete, rename, list, search, run commands, copy files, and make directories in a workspace.

Current workspace structure:
\`\`\`
${workspaceStructure}
\`\`\`

Available action types (always respond with ONLY a valid JSON array, no other text):

READ ACTIONS (results returned to you, no confirmation needed):
- {"type": "view", "path": "file.ts"} — view full file contents
- {"type": "view", "path": "file.ts", "startLine": 1, "endLine": 50} — view specific line range
- {"type": "view", "paths": ["file1.ts", "file2.ts"]} — view multiple files at once
- {"type": "list", "path": "src/"} — list folder contents (node_modules/dist excluded)
- {"type": "search", "pattern": "TODO"} — grep workspace files for pattern (node_modules/dist excluded)
${wikiAction}${codeWikiAction}
WRITE ACTIONS (require confirmation):
- {"type": "create", "path": "path/to/file", "content": "full file content"} — create new file
- {"type": "write", "path": "path/to/file", "content": "full file content"} — replace entire file
- {"type": "modify", "path": "path/to/file", "oldContent": "text to find", "newContent": "replacement"} — string replacement
- {"type": "modify", "path": "path/to/file", "startLine": 10, "endLine": 20, "newContent": "replacement lines"} — line-range replacement
- {"type": "delete", "path": "path/to/file"} — delete file (backup created automatically)
- {"type": "rename", "path": "old/path", "newPath": "new/path"} — rename or move a file
- {"type": "copy", "path": "src/file.ts", "newPath": "src/file-copy.ts"} — copy a file
- {"type": "mkdir", "path": "src/new-folder"} — create a directory

EXECUTE ACTIONS (always require explicit confirmation):
- {"type": "run", "command": "npm test"} — run a shell command, returns stdout/stderr

Rules:
- Always return ONLY a valid JSON array, no explanation, no markdown fences
- Use read actions first to inspect files before modifying them
- Prefer write over modify for large changes; use line-range modify for small edits when you know exact line numbers
- Respond with [] when the task is complete`;
}
