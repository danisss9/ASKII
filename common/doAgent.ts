// The ASKII Do agent loop, shared by the extension and the CLI. Callers own
// the UI (timeline panel / terminal), the session (follow-ups, keep-or-undo)
// and the LLM call; this module owns the rounds: ask the model, parse its
// actions, run reads, confirm and run writes, and feed the results back.

import { type ChatMessage, type ChatReply } from './providers';
import {
  INVALID_ACTIONS_FEEDBACK,
  executeSearchAction,
  executeViewAction,
  executeWriteAction,
  getWritePathPolicy,
  parseWorkspaceResponse,
  runShellCommand,
  sandboxPath,
  type ActionResult,
  type WorkspaceAction,
} from './workspace';

export type DoActionStatus = 'ok' | 'error' | 'skipped' | 'blocked';

export type DoEvent =
  | { type: 'round-start'; id: number; round: number; maxRounds: number }
  | { type: 'chunk'; id: number; text: string }
  | { type: 'round-end'; id: number; truncated: boolean }
  | { type: 'invalid-response'; truncated: boolean }
  | { type: 'complete'; responseText: string }
  | { type: 'notice'; message: string }
  | { type: 'action-start'; id: number; action: WorkspaceAction; label: string }
  | {
      type: 'action-end';
      id: number;
      action: WorkspaceAction;
      status: DoActionStatus;
      label: string;
      detail?: string;
    }
  | { type: 'max-rounds'; maxRounds: number };

export interface DoConfirmRequest {
  /** Id of the action-start event this confirmation belongs to. */
  id: number;
  action: WorkspaceAction;
  /** 'run' executes shell code; 'sensitive' writes a file that can run code (tasks, hooks, ...). */
  kind: 'write' | 'run' | 'sensitive';
  message: string;
}

export interface DoAgentOptions {
  workspaceRoot: string;
  /** Conversation so far, ending with the new user task. Appended to in place. */
  messages: ChatMessage[];
  maxRounds: number;
  signal: AbortSignal;
  /** Skip confirmation for ordinary writes. `run` and sensitive paths are always confirmed. */
  autoConfirm: boolean;
  chat: (
    messages: ChatMessage[],
    onChunk: (chunk: string) => void,
    signal: AbortSignal,
  ) => Promise<ChatReply>;
  confirm: (request: DoConfirmRequest) => Promise<boolean>;
  emit: (event: DoEvent) => void;
  /** Docs wiki search; undefined when no wiki is indexed. */
  searchWiki?: (query: string) => Promise<string>;
  /** Code wiki search; undefined when the code wiki is unavailable. */
  searchCode?: (query: string) => Promise<string>;
  wikiUnavailableMessage?: string;
  codeWikiUnavailableMessage?: string;
  /** Called after a file's content was written (create / write / modify). */
  afterWrite?: (filePath: string) => Promise<void>;
  /** Timeout for `run` actions. */
  runTimeoutMs?: number;
}

export interface DoAgentResult {
  completedActions: number;
  outcome: 'complete' | 'max-rounds' | 'aborted';
}

const READ_TYPES = new Set(['view', 'list', 'search', 'wiki_search', 'code_search']);

const NEXT_STEP_PROMPT =
  '\n\nWhat would you like to do next? Respond with only a JSON array of actions or [] if done.';

const TRUNCATED_FEEDBACK =
  'Your last response was cut off because it hit the output token limit, so it was not applied. ' +
  'Respond with ONLY a JSON array, and split large files into several smaller modify actions ' +
  'instead of one huge write.';

export function describeDoConfirm(action: WorkspaceAction): string {
  switch (action.type) {
    case 'delete':
      return `Delete: ${action.path}? (backup will be created)`;
    case 'rename':
      return `Rename: ${action.path} → ${action.newPath}?`;
    case 'copy':
      return `Copy: ${action.path} → ${action.newPath}?`;
    case 'mkdir':
      return `Create directory: ${action.path}?`;
    case 'run':
      return `Run: ${action.command}?`;
    default: {
      const t = action.type.charAt(0).toUpperCase() + action.type.slice(1);
      return `${t}: ${action.path}?`;
    }
  }
}

export function describeDoRead(action: WorkspaceAction): string {
  switch (action.type) {
    case 'view':
      return `View: ${action.path}`;
    case 'list':
      return `List: ${action.path ?? '.'}`;
    case 'search':
      return `Search: ${action.pattern}`;
    case 'wiki_search':
      return `Wiki search: ${action.query}`;
    case 'code_search':
      return `Code search: ${action.query}`;
    default:
      return action.type;
  }
}

export function describeDoDone(action: WorkspaceAction): string {
  switch (action.type) {
    case 'mkdir':
      return `Created directory: ${action.path}`;
    case 'copy':
      return `Copied: ${action.path} → ${action.newPath}`;
    case 'create':
      return `Created: ${action.path}`;
    case 'write':
      return `Wrote: ${action.path}`;
    case 'modify':
      return action.startLine !== undefined || action.endLine !== undefined
        ? `Modified (lines ${action.startLine}–${action.endLine}): ${action.path}`
        : `Modified: ${action.path}`;
    case 'delete':
      return `Deleted: ${action.path}`;
    case 'rename':
      return `Renamed: ${action.path} → ${action.newPath}`;
    case 'run':
      return `Ran: ${action.command}`;
    default:
      return `${action.type}: ${action.path}`;
  }
}

function actionKey(action: WorkspaceAction): string {
  return action.type === 'run' ? `run:${action.command}` : `${action.type}:${action.path}`;
}

/**
 * Resolves and classifies every path a write touches (path and newPath).
 * Returns the resolved main path, whether it needs a forced confirmation, or
 * the reason it is blocked.
 */
function checkWriteTargets(
  action: WorkspaceAction,
  workspaceRoot: string,
): { filePath: string; sensitive: boolean } | { blocked: string } {
  try {
    if (!action.path) {
      return { blocked: `${action.type} requires path` };
    }
    const filePath = sandboxPath(workspaceRoot, action.path);
    const targets = [filePath];
    if (action.newPath) {
      targets.push(sandboxPath(workspaceRoot, action.newPath));
    }
    let sensitive = false;
    for (const target of targets) {
      const policy = getWritePathPolicy(workspaceRoot, target);
      if (policy === 'blocked') {
        return {
          blocked: `Protected path: ASKII Do never writes inside .git/ or .askii/ (${action.path}${
            action.newPath ? ` → ${action.newPath}` : ''
          })`,
        };
      }
      sensitive ||= policy === 'sensitive';
    }
    return { filePath, sensitive };
  } catch (e) {
    return { blocked: e instanceof Error ? e.message : 'Path error' };
  }
}

/** Runs the Do agent for the task at the end of `options.messages`. */
export async function runDoAgent(options: DoAgentOptions): Promise<DoAgentResult> {
  const { workspaceRoot, messages, maxRounds, signal, emit } = options;
  let nextId = 1;
  let completedActions = 0;

  for (let round = 0; round < maxRounds; round++) {
    if (signal.aborted) {
      return { completedActions, outcome: 'aborted' };
    }

    const roundId = nextId++;
    emit({ type: 'round-start', id: roundId, round: round + 1, maxRounds });
    const reply = await options.chat(
      messages,
      (text) => emit({ type: 'chunk', id: roundId, text }),
      signal,
    );
    emit({ type: 'round-end', id: roundId, truncated: reply.truncated });
    if (signal.aborted) {
      return { completedActions, outcome: 'aborted' };
    }
    messages.push({ role: 'assistant', content: reply.text });

    const parsed = parseWorkspaceResponse(reply.text);
    if (parsed === null || (reply.truncated && parsed.actions.length > 0)) {
      // A cut-off reply is never applied: its last write may be incomplete.
      emit({ type: 'invalid-response', truncated: reply.truncated });
      messages.push({
        role: 'user',
        content: reply.truncated ? TRUNCATED_FEEDBACK : INVALID_ACTIONS_FEEDBACK,
      });
      continue;
    }
    const { actions, ignoredTypes } = parsed;
    if (actions.length === 0 && ignoredTypes.length === 0) {
      emit({ type: 'complete', responseText: reply.text });
      return { completedActions, outcome: 'complete' };
    }

    const feedbackParts: string[] = [];
    if (ignoredTypes.length > 0) {
      const message = `Ignored unknown action type(s): ${ignoredTypes.join(', ')}`;
      emit({ type: 'notice', message });
      feedbackParts.push(
        `${message}. Use only the action types listed in the instructions.`,
      );
    }

    // ── Read actions (no confirmation) ────────────────────────────────────
    const viewResults: Record<string, string> = {};
    for (const action of actions.filter((a) => READ_TYPES.has(a.type))) {
      const reads =
        action.type === 'view' && action.paths
          ? action.paths.map((p) => ({ ...action, path: p, paths: undefined }))
          : [action];
      for (const read of reads) {
        const id = nextId++;
        const label = describeDoRead(read);
        emit({ type: 'action-start', id, action: read, label });
        let key = read.path ?? 'unknown';
        try {
          let result: string;
          if (read.type === 'wiki_search') {
            key = `wiki_search:${read.query ?? ''}`;
            result = options.searchWiki
              ? (await options.searchWiki(read.query ?? '')) || 'No wiki results found'
              : (options.wikiUnavailableMessage ?? 'Wiki not available');
          } else if (read.type === 'code_search') {
            key = `code_search:${read.query ?? ''}`;
            result = options.searchCode
              ? (await options.searchCode(read.query ?? '')) || 'No code wiki results found'
              : (options.codeWikiUnavailableMessage ?? 'Code wiki not available');
          } else if (read.type === 'search') {
            key = `search:${read.pattern}`;
            result = executeSearchAction(read, workspaceRoot);
          } else {
            result = executeViewAction(read, workspaceRoot);
          }
          viewResults[key] = result;
          emit({ type: 'action-end', id, action: read, status: 'ok', label, detail: result });
        } catch (e) {
          const msg = `Error: ${e instanceof Error ? e.message : 'Cannot read path'}`;
          viewResults[key] = msg;
          emit({ type: 'action-end', id, action: read, status: 'error', label, detail: msg });
        }
      }
    }
    if (Object.keys(viewResults).length > 0) {
      feedbackParts.push(`File/search results:\n${JSON.stringify(viewResults, null, 2)}`);
    }

    // ── Write and run actions (confirmed) ─────────────────────────────────
    const actionResults: ActionResult[] = [];
    for (const action of actions.filter((a) => !READ_TYPES.has(a.type))) {
      if (signal.aborted) {
        break;
      }
      const id = nextId++;
      const message = describeDoConfirm(action);
      emit({ type: 'action-start', id, action, label: message });

      if (action.type === 'run') {
        if (!action.command) {
          const detail = 'run requires command';
          emit({ type: 'action-end', id, action, status: 'error', label: message, detail });
          actionResults.push({ action: actionKey(action), status: 'error', detail });
          continue;
        }
        // run is ALWAYS confirmed — auto-confirm never applies to shell code
        if (!(await options.confirm({ id, action, kind: 'run', message }))) {
          emit({ type: 'action-end', id, action, status: 'skipped', label: message });
          actionResults.push({ action: actionKey(action), status: 'skipped' });
          continue;
        }
        const result = await runShellCommand(action.command, workspaceRoot, {
          signal,
          timeoutMs: options.runTimeoutMs,
        });
        const detail = result.output.substring(0, 2000);
        emit({
          type: 'action-end',
          id,
          action,
          status: result.ok ? 'ok' : 'error',
          label: describeDoDone(action),
          detail: result.output,
        });
        actionResults.push({ action: actionKey(action), status: result.ok ? 'ok' : 'error', detail });
        continue;
      }

      const target = checkWriteTargets(action, workspaceRoot);
      if ('blocked' in target) {
        emit({
          type: 'action-end',
          id,
          action,
          status: 'blocked',
          label: `Blocked: ${message}`,
          detail: target.blocked,
        });
        actionResults.push({ action: actionKey(action), status: 'error', detail: target.blocked });
        continue;
      }

      const kind = target.sensitive ? 'sensitive' : 'write';
      const confirmed =
        (options.autoConfirm && kind === 'write') ||
        (await options.confirm({ id, action, kind, message }));
      if (!confirmed) {
        emit({ type: 'action-end', id, action, status: 'skipped', label: message });
        actionResults.push({ action: actionKey(action), status: 'skipped' });
        continue;
      }

      try {
        const result = await executeWriteAction(
          action,
          target.filePath,
          workspaceRoot,
          options.afterWrite,
        );
        const ok = result === 'ok';
        if (ok) {
          completedActions++;
        }
        emit({
          type: 'action-end',
          id,
          action,
          status: ok ? 'ok' : 'error',
          label: ok ? describeDoDone(action) : message,
          detail: ok ? undefined : result,
        });
        actionResults.push({
          action: actionKey(action),
          status: ok ? 'ok' : 'error',
          detail: ok ? undefined : result,
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : 'Unknown error';
        emit({ type: 'action-end', id, action, status: 'error', label: message, detail });
        actionResults.push({ action: actionKey(action), status: 'error', detail });
      }
    }
    if (actionResults.length > 0) {
      feedbackParts.push(`Action results: ${JSON.stringify(actionResults)}`);
    }

    if (signal.aborted) {
      return { completedActions, outcome: 'aborted' };
    }
    messages.push({ role: 'user', content: feedbackParts.join('\n\n') + NEXT_STEP_PROMPT });
  }

  emit({ type: 'max-rounds', maxRounds });
  return { completedActions, outcome: 'max-rounds' };
}
