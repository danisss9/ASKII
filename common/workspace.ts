import * as fs from 'fs';
import * as path from 'path';

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
    | 'run'
    | 'copy'
    | 'mkdir';
  path?: string;
  paths?: string[];     // multi-file view
  newPath?: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
  startLine?: number;   // partial view / line-range modify (1-indexed)
  endLine?: number;
  pattern?: string;     // search
  command?: string;     // run
}

export type ActionResult = {
  action: string;
  status: 'ok' | 'skipped' | 'error';
  detail?: string;
};

export function getWorkspaceStructure(dirPath: string): string {
  let structure = '';
  try {
    const files = fs.readdirSync(dirPath);
    const filtered = files.filter(
      (f: string) => !f.startsWith('.') && f !== 'node_modules' && f !== 'dist',
    );

    for (const file of filtered.slice(0, 100)) {
      const stat = fs.statSync(path.join(dirPath, file));
      const isDir = stat.isDirectory();
      structure += `${file} [${isDir ? 'folder' : 'file'}]\n`;
    }
  } catch (_) {
    // Ignore errors
  }
  return structure;
}

export function parseWorkspaceActions(responseText: string): WorkspaceAction[] {
  const ALL_TYPES = [
    'view', 'create', 'modify', 'write', 'delete', 'rename',
    'list', 'search', 'run', 'copy', 'mkdir',
  ];
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('No JSON array found in response');
    }

    const actions = JSON.parse(jsonMatch[0]) as WorkspaceAction[];

    if (!Array.isArray(actions)) {
      throw new Error('Response is not an array');
    }

    return actions.filter((action) => {
      if (!action.type) return false;
      return ALL_TYPES.includes(action.type);
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error('Failed to parse workspace actions:', errorMsg);
    return [];
  }
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

const LIST_EXCLUDED = new Set(['node_modules', 'dist', '.git']);

/**
 * Executes a view (single file, optional line range) or list action.
 * Returns raw string content/listing.
 */
export function executeViewAction(action: WorkspaceAction, workspaceRoot: string): string {
  if (action.type === 'list') {
    const dirPath = sandboxPath(workspaceRoot, action.path ?? '.');
    const entries = fs.readdirSync(dirPath)
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
          const regex = new RegExp(pattern, 'i');
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
export function buildDoSystemPrompt(workspaceStructure: string): string {
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
