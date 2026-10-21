import * as fs from 'fs';
import * as path from 'path';
import { balancedJsonAt, decodeIfDoubleEscaped } from './utils';

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
      if (fs.statSync(fullPath).isDirectory()) {
        walk(fullPath);
      } else {
        const rel = path.relative(backupDir, fullPath);
        const dest = path.join(workspaceRoot, rel);
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
      const list: string[] = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
      for (const rel of list) {
        try {
          const fullPath = path.join(workspaceRoot, rel);
          if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
            deleted.push(rel);
          }
        } catch {
          /* best-effort */
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

/**
 * Parses the model's action array. Returns null when no valid JSON array could
 * be found — distinct from [] ("task complete") so callers can ask again.
 */
export function parseWorkspaceActions(responseText: string): WorkspaceAction[] | null {
  const ALL_TYPES = [
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
  const text = responseText.trim().replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');

  // Whole response first, then the balanced [...] starting at each of the
  // first few '[' — prose around the array may itself contain brackets.
  const candidates = [text];
  for (
    let start = text.indexOf('['), tries = 0;
    start !== -1 && tries < 20;
    start = text.indexOf('[', start + 1), tries++
  ) {
    const slice = balancedArrayAt(text, start);
    if (slice) {candidates.push(slice);}
  }

  for (const candidate of candidates) {
    let actions: unknown;
    try {
      actions = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(actions)) {continue;}
    return (actions as WorkspaceAction[]).filter(
      (action) => !!action && typeof action.type === 'string' && ALL_TYPES.includes(action.type),
    );
  }
  console.error('Failed to parse workspace actions: no valid JSON array found in response');
  return null;
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

/** Resolves relativePath under workspaceRoot and throws if it escapes the root. */
export function sandboxPath(workspaceRoot: string, relativePath: string): string {
  const normalizedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(workspaceRoot, relativePath);
  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return resolved;
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
  const filePath = sandboxPath(workspaceRoot, action.path!);
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (action.startLine !== undefined || action.endLine !== undefined) {
    const lines = raw.split('\n');
    const start = (action.startLine ?? 1) - 1; // 1-indexed → 0-indexed
    const end = action.endLine ?? lines.length;
    return lines.slice(start, end).join('\n');
  }
  return raw;
}

/**
 * Recursively greps the workspace for pattern, excluding node_modules/dist/.git.
 * Returns "file:line: match" lines.
 */
export function executeSearchAction(action: WorkspaceAction, workspaceRoot: string): string {
  const pattern = action.pattern ?? '';
  if (!pattern) {return 'Error: search requires a pattern';}

  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (LIST_EXCLUDED.has(name)) {continue;}
      const fullPath = path.join(dir, name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(fullPath);
      } else {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escapedPattern, 'i');
          lines.forEach((line, i) => {
            if (regex.test(line)) {
              const rel = path.relative(workspaceRoot, fullPath);
              results.push(`${rel}:${i + 1}: ${line.trim()}`);
            }
          });
        } catch {
          // Skip binary or unreadable files
        }
      }
    }
  }

  walk(workspaceRoot);
  return results.length > 0 ? results.join('\n') : 'No matches found';
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
