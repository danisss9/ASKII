/**
 * Pure (runtime-agnostic) subset of the workspace-agent module: the action
 * types, the action-array parser, and the Do / Generate system-prompt
 * builders.
 *
 * The Node filesystem execution (sandbox, view/list/search, backups, workspace
 * structure) lives in the companion `common/workspace` module. The Android app
 * provides its own execution on top of `@capacitor/filesystem`.
 */

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
    | 'run'
    | 'copy'
    | 'mkdir'
    | 'clarify';
  path?: string;
  paths?: string[]; // multi-file view
  newPath?: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
  startLine?: number; // partial view / line-range modify (1-indexed)
  endLine?: number;
  pattern?: string; // search (code grep)
  query?: string; // wiki_search (natural language)
  command?: string; // run
  question?: string; // clarify (question to ask the user)
}

export type ActionResult = {
  action: string;
  status: 'ok' | 'skipped' | 'error';
  detail?: string;
};

const ALL_ACTION_TYPES = [
  'view',
  'create',
  'modify',
  'write',
  'delete',
  'rename',
  'list',
  'search',
  'wiki_search',
  'run',
  'copy',
  'mkdir',
  'clarify',
];

export function parseWorkspaceActions(responseText: string): WorkspaceAction[] {
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
      return ALL_ACTION_TYPES.includes(action.type);
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    // console is available in both Node and the browser; keep the existing
    // behaviour (best-effort diagnostic) without pulling any Node modules.
    console.error('Failed to parse workspace actions:', errorMsg);
    return [];
  }
}

/** Builds the system prompt for the do command (shared by extension + CLI). */
export function buildDoSystemPrompt(workspaceStructure: string, wikiAvailable = false): string {
  const wikiAction = wikiAvailable
    ? `- {"type": "wiki_search", "query": "natural language question"} — search the documentation wiki and get relevant context back\n`
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
${wikiAction}
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

/** Builds the system prompt for the generate command (shared by extension + CLI). */
export function buildGenerateSystemPrompt(opts: {
  fileType: 'Test' | 'Doc' | 'Json';
  baseName: string;
  workspaceStructure: string;
  wikiAvailable: boolean;
  currentTab?: string;
  selectedText?: string;
}): string {
  const { fileType, baseName, workspaceStructure, wikiAvailable, currentTab, selectedText } = opts;
  const wikiAction = wikiAvailable
    ? `- {"type": "wiki_search", "query": "natural language question"} — search the documentation wiki and get relevant context back\n`
    : '';

  const typeGuidance =
    fileType === 'Test'
      ? 'Generate a test file for the requested target. Infer the test framework from the workspace (package.json scripts, existing *.test.* files, imports). Place tests next to the source or in the workspace test folder, following existing conventions.'
      : fileType === 'Doc'
        ? 'Generate a Markdown documentation file. Use clear headings, code examples, and reference real symbols/paths from the workspace.'
        : 'Generate a JSON file (e.g. schema, config, fixture, sample data). Output must be valid JSON.';

  const contextBlock = [
    currentTab ? `\nCurrent tab (truncated):\n\`\`\`\n${currentTab}\n\`\`\`` : '',
    selectedText ? `\nSelected text from current tab:\n\`\`\`\n${selectedText}\n\`\`\`` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return `You are ASKII, an AI agent that generates a single ${fileType} file in the workspace.

Target file type: ${fileType}
Base name provided by user: ${baseName}
${typeGuidance}

Current workspace structure:
\`\`\`
${workspaceStructure}
\`\`\`${contextBlock}

Available action types (always respond with ONLY a valid JSON array, no other text):

READ ACTIONS (results returned to you, no confirmation needed):
- {"type": "view", "path": "file.ts"} — view full file contents
- {"type": "view", "path": "file.ts", "startLine": 1, "endLine": 50} — view specific line range
- {"type": "view", "paths": ["file1.ts", "file2.ts"]} — view multiple files at once
- {"type": "list", "path": "src/"} — list folder contents (node_modules/dist excluded)
- {"type": "search", "pattern": "TODO"} — grep workspace files for pattern (node_modules/dist excluded)
${wikiAction}
CLARIFY ACTION (ask the user a question when you need more information):
- {"type": "clarify", "question": "Which test framework should I use?"} — the user's answer is returned to you

WRITE ACTION (finish the task with exactly one of these):
- {"type": "create", "path": "path/to/file", "content": "full file content"} — create the generated file

Rules:
- Always return ONLY a valid JSON array, no explanation, no markdown fences
- Use read actions first to inspect the workspace and gather context before generating
- Use clarify sparingly — only when you cannot reasonably infer the answer from the workspace
- Decide the full path (including extension and folder) based on the file type, base name, and workspace conventions
- Finish with exactly one create action containing the complete file content
- Respond with [] only if the task is cancelled or impossible`;
}