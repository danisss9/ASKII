import * as vscode from 'vscode';
import { getExtensionChatStreaming } from './providers';
import {
  getWorkspaceStructure,
  buildDoSystemPrompt,
  deleteAllBackups,
  restoreAllBackups,
  hasBackups,
} from '@common/workspace';
import { runDoAgent } from '@common/doAgent';
import { type ChatMessage } from '@common/providers';
import { hasWikiIndex, searchWiki } from '@common/wiki';
import { searchCodeWiki, hasCodeWikiIndex } from '@common/codewiki';
import {
  acquireTaskPanel,
  addTimelineEntry,
  beginTaskSession,
  endTaskSession,
  flushEntryStream,
  requestChoice,
  setTaskCanceller,
  setTaskStatus,
  streamToEntry,
  sweepPendingEntries,
  updateTimelineEntry,
  waitForFollowUp,
} from './taskPanel';
import {
  applyFormat,
  getAgentChannel,
  timelineSnippet,
} from './commandUtils';

export async function askiiDoCommand() {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage(
      'ASKII Do edits files and runs commands, so it is disabled in Restricted Mode. Trust this workspace to use it.',
    );
    return;
  }

  const question = await vscode.window.showInputBox({
    prompt: 'What would you like ASKII to do?',
    placeHolder: 'e.g., Create a test file, refactor common patterns',
  });

  if (!question) {return;}

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('No workspace found');
    return;
  }

  if (!beginTaskSession()) {
    vscode.window.showInformationMessage('ASKII is already running a task — see the ASKII task panel.');
    return;
  }
  // The session is held until the keep-or-undo choice is answered: a second
  // Do started before that would delete this run's backups.
  let ownsSession = true;
  const releaseSession = () => {
    if (ownsSession) {
      ownsSession = false;
      endTaskSession();
    }
  };

  try {
    await runDoSession(question, workspaceRoot.uri.fsPath, releaseSession, () => {
      ownsSession = beginTaskSession();
      return ownsSession;
    });
  } finally {
    releaseSession();
  }
}

async function runDoSession(
  question: string,
  rootPath: string,
  releaseSession: () => void,
  reacquireSession: () => boolean,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('askii');
  const maxRounds = Math.max(1, config.get<number>('doMaxRounds') ?? 20);
  const autoConfirm = config.get<boolean>('doAutoConfirm') ?? false;
  const formatAfterEdit = config.get<boolean>('formatAfterEdit') ?? false;

  try {
    deleteAllBackups(rootPath);
  } catch {
    // Backup cleanup is best-effort; don't block the run on it
  }

  const channel = getAgentChannel('ASKII Do');
  channel.appendLine(`\nTask: ${question}`);

  acquireTaskPanel('ASKII Do');

  // Wiki availability only depends on settings/indexes — resolve once per session
  const wikiPath = config.get<string>('wikiPath') ?? '';
  const wikiEnabled = config.get<boolean>('wikiEnabled') ?? false;
  const wikiAvailable = !!(wikiEnabled && wikiPath && hasWikiIndex(wikiPath));
  const codeWikiEnabled = config.get<boolean>('codeWikiEnabled') ?? false;
  const codeWikiAvailable = codeWikiEnabled && hasCodeWikiIndex(rootPath);

  const messages: ChatMessage[] = [];
  let currentTask: string | null = question;

  while (currentTask) {
    if (currentTask !== question) {
      channel.appendLine(`\nFollow-up task: ${currentTask}`);
    }
    setTaskStatus('running', currentTask);

    const abortController = new AbortController();
    setTaskCanceller(() => {
      abortController.abort();
      channel.appendLine('\nStopped by user.');
    });

    if (messages.length === 0) {
      const systemPrompt = buildDoSystemPrompt(
        getWorkspaceStructure(rootPath),
        wikiAvailable,
        codeWikiAvailable,
      );
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: currentTask });

    // Agent event id → timeline entry id
    const entries = new Map<number, number>();
    let completedActions = 0;
    let taskComplete = false;
    let errorMsg: string | null = null;

    try {
      const result = await runDoAgent({
        workspaceRoot: rootPath,
        messages,
        maxRounds,
        signal: abortController.signal,
        autoConfirm,
        chat: (msgs, onChunk, signal) => getExtensionChatStreaming(msgs, onChunk, signal),
        confirm: async ({ id, kind, message }) => {
          const entry = entries.get(id);
          if (entry === undefined) {
            return false;
          }
          if (kind === 'run') {
            return (
              (await requestChoice(entry, 'Run this command in the workspace?', ['Run', 'Skip'])) ===
              'Run'
            );
          }
          const prompt =
            kind === 'sensitive'
              ? `${message} This file can make VS Code or git run code — review it carefully.`
              : undefined;
          return (await requestChoice(entry, prompt, ['Confirm', 'Skip'])) === 'Confirm';
        },
        emit: (event) => {
          switch (event.type) {
            case 'round-start':
              channel.appendLine(`\n[Round ${event.round}/${event.maxRounds}]`);
              channel.append('AI: ');
              entries.set(
                event.id,
                addTimelineEntry({
                  kind: 'round',
                  title: `Round ${event.round} of ${event.maxRounds}`,
                  status: 'pending',
                }),
              );
              break;
            case 'chunk': {
              channel.append(event.text);
              const entry = entries.get(event.id);
              if (entry !== undefined) {
                streamToEntry(entry, event.text);
              }
              break;
            }
            case 'round-end': {
              channel.appendLine(event.truncated ? '\n[response cut off at the token limit]' : '');
              const entry = entries.get(event.id);
              if (entry !== undefined) {
                flushEntryStream(entry);
                updateTimelineEntry(entry, { status: 'ok' });
              }
              break;
            }
            case 'invalid-response':
              channel.appendLine(
                event.truncated
                  ? 'Response was cut off at the output token limit — asking for smaller steps.'
                  : 'Response was not a valid JSON action array — asking again.',
              );
              addTimelineEntry({
                kind: 'info',
                title: event.truncated
                  ? 'Response cut off — asking the model for smaller steps'
                  : 'Unreadable response — asking the model again',
                status: 'error',
              });
              break;
            case 'complete':
              taskComplete = true;
              channel.appendLine('No actions returned. Done.');
              addTimelineEntry({
                kind: 'done',
                title: 'Task complete',
                detail: event.responseText.trim() ? timelineSnippet(event.responseText) : undefined,
              });
              break;
            case 'notice':
              channel.appendLine(event.message);
              addTimelineEntry({ kind: 'info', title: event.message, status: 'error' });
              break;
            case 'action-start':
              channel.appendLine(event.label);
              entries.set(
                event.id,
                addTimelineEntry({ kind: 'action', title: event.label, status: 'pending' }),
              );
              break;
            case 'action-end': {
              const entry = entries.get(event.id);
              const detail =
                event.detail === undefined
                  ? undefined
                  : timelineSnippet(event.detail, event.action.type === 'run' ? 500 : 400);
              if (event.status === 'blocked') {
                channel.appendLine(`BLOCKED: ${event.detail}`);
              } else if (event.status === 'error') {
                channel.appendLine(`✗ Failed: ${event.detail ?? ''}`);
              } else if (event.status === 'ok' && !READ_ACTION_TYPES.has(event.action.type)) {
                channel.appendLine(`✓ ${event.label}`);
              }
              if (entry !== undefined) {
                updateTimelineEntry(entry, {
                  title: event.label,
                  status: event.status === 'blocked' ? 'error' : event.status,
                  detail,
                });
              }
              break;
            }
            case 'max-rounds':
              channel.appendLine(`Max rounds (${event.maxRounds}) reached.`);
              addTimelineEntry({
                kind: 'info',
                title: `Max rounds (${event.maxRounds}) reached`,
                status: 'error',
              });
              break;
          }
        },
        searchWiki: wikiAvailable ? (q) => searchWiki(wikiPath, q) : undefined,
        searchCode: codeWikiAvailable ? (q) => searchCodeWiki(rootPath, q) : undefined,
        wikiUnavailableMessage: 'Wiki not available — set askii.wikiPath and run Reload Wikis',
        codeWikiUnavailableMessage:
          'Code wiki not available — enable askii.codeWikiEnabled and run Reload Wikis',
        afterWrite: formatAfterEdit ? applyFormat : undefined,
      });
      completedActions = result.completedActions;
    } catch (error) {
      if (!abortController.signal.aborted) {
        errorMsg = error instanceof Error ? error.message : 'Unknown error';
      }
    }

    if (errorMsg) {
      channel.appendLine(`\nError: ${errorMsg}`);
      addTimelineEntry({ kind: 'error', title: 'ASKII Do failed', detail: errorMsg });
      setTaskStatus('error', errorMsg);
      vscode.window.showErrorMessage(`ASKII Do failed: ${errorMsg}`);
      sweepPendingEntries();
    } else if (abortController.signal.aborted) {
      channel.appendLine(`\nCompleted ${completedActions} actions before stopping. (⌐■_■)`);
      addTimelineEntry({ kind: 'info', title: 'Stopped by user' });
      setTaskStatus('cancelled', `Completed ${completedActions} action(s) before stopping`);
      sweepPendingEntries();
    } else {
      setTaskStatus('done', `Completed ${completedActions} action(s)`);
      if (!taskComplete) {
        vscode.window.showInformationMessage(`ASKII Do: ${completedActions} actions completed.`);
      }
    }

    // Keep-or-undo is answered in the panel — also after an error or a stop,
    // so partial changes can be rolled back. Dismissing the panel keeps them.
    if (hasBackups(rootPath)) {
      const choiceEntry = addTimelineEntry({
        kind: 'confirm',
        title: `${completedActions} action(s) completed`,
        status: 'pending',
      });
      const choice = await requestChoice(
        choiceEntry,
        'Keep these changes?',
        ['Keep changes', 'Undo all'],
      );
      if (choice === 'Undo all') {
        const { restored, deleted } = restoreAllBackups(rootPath);
        deleteAllBackups(rootPath);
        channel.appendLine(
          `Undone — restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
        );
        updateTimelineEntry(choiceEntry, {
          status: 'ok',
          detail: `Restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
        });
        vscode.window.showInformationMessage(
          `ASKII Do: Restored ${restored.length} file(s), deleted ${deleted.length} created file(s).`,
        );
      } else if (choice === 'Keep changes') {
        deleteAllBackups(rootPath);
        updateTimelineEntry(choiceEntry, { status: 'ok' });
      } else {
        updateTimelineEntry(choiceEntry, { status: 'skipped' });
      }
    }

    if (errorMsg || abortController.signal.aborted) {
      break;
    }

    // Idle while waiting for a follow-up: another command may take the panel
    releaseSession();
    currentTask = await waitForFollowUp();
    if (currentTask && !reacquireSession()) {
      break;
    }
  }
}

const READ_ACTION_TYPES = new Set(['view', 'list', 'search', 'wiki_search', 'code_search']);
