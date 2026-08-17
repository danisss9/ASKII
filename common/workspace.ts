import * as fs from 'fs';
import * as path from 'path';
import type { WorkspaceAction, ActionResult } from '@shared/workspace';

// Pure types / parser / prompt builders now live in @shared/workspace so the
// Android app can import them without pulling `fs`/`path`. Re-exported here
// for back-compat with existing @common/workspace importers.
export {
  parseWorkspaceActions,
  buildDoSystemPrompt,
  buildGenerateSystemPrompt,
  type WorkspaceAction,
  type ActionResult,
} from '@shared/workspace';

const BACKUP_DIR = path.join('.askii', 'backups');
const CREATED_LOG = path.join('.askii', 'created.json');

/** Copy filePath into .askii/backups/, preserving relative path. No-op if file doesn't exist. */
export function writeBackup(workspaceRoot: string, filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const rel = path.relative(workspaceRoot, filePath);
    const backupPath = path.join(workspaceRoot, BACKUP_DIR, rel);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(filePath, backupPath);
  } catch {
    // Best-effort — don't block the action if backup fails
  }
}

/** Record a newly created file so it can be deleted on restore. */
export function recordCreatedFile(workspaceRoot: string, relativePath: string): void {
  try {
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
    if (!list.includes(relativePath)) list.push(relativePath);
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
    if (!fs.existsSync(dir)) return;
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
  if (!pattern) return 'Error: search requires a pattern';

  const results: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (LIST_EXCLUDED.has(name)) continue;
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

// `parseWorkspaceActions`, `buildDoSystemPrompt`, and `buildGenerateSystemPrompt`
// now live in @shared/workspace (re-exported above).
