import * as vscode from 'vscode';
import * as path from 'path';
import {
  type NoteEntry,
  computeNextOccurrence,
  describeRecurrence,
  describeEventTrigger,
  eventPatternMatches,
} from '@common/notes';
import { loadNotes, saveNotes } from './notes';

// ── Scheduler state ───────────────────────────────────────────────────────────

const timers = new Map<string, NodeJS.Timeout>();
let _context: vscode.ExtensionContext | undefined;
let eventListenersRegistered = false;
let startupTimer: NodeJS.Timeout | undefined;

// Delay before event triggers tied to activation fire, so the window settles.
const STARTUP_FIRE_DELAY_MS = 4_000;

// Event fired whenever notes are mutated by the scheduler (reminder fired /
// snoozed / dismissed) so open panels can refresh their list.
const _notesChangedEmitter = new vscode.EventEmitter<void>();
export const onNotesChanged: vscode.Event<void> = _notesChangedEmitter.event;

// Cap setTimeout at 24h; longer deltas re-arm on fire.
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function clearAllTimers(): void {
  for (const t of timers.values()) {clearTimeout(t);}
  timers.clear();
}

function playReminderSound(): void {
  const config = vscode.workspace.getConfiguration('askii');
  if (!(config.get<boolean>('noteReminderSound') ?? true)) {return;}
  // VS Code has no cross-platform sound API; best-effort via a terminal bell
  // through the integrated terminal is noisy, so we rely on the notification
  // toast itself. (A bundled wav played via the panel's Audio API is handled
  // in notesPanel.ts when the panel is open.)
  try {
    vscode.commands.executeCommand('workbench.action.playSound', 'notification');
  } catch {
    // no-op — some VS Code builds don't expose this command
  }
}

function contextSummary(note: NoteEntry): string {
  const parts: string[] = [];
  if (note.context?.workspaceFolder) {parts.push(`Workspace: ${note.context.workspaceFolder}`);}
  if (note.context?.fileName) {parts.push(`File: ${note.context.fileName}`);}
  if (note.context?.selectedText) {
    const snip =
      note.context.selectedText.length > 120
        ? note.context.selectedText.slice(0, 120) + '…'
        : note.context.selectedText;
    parts.push(`Selection: "${snip}"`);
  }
  return parts.length ? `\n\nContext:\n${parts.join('\n')}` : '';
}

/** An entry the timer scheduler should arm: reminders, and tasks with a deadline. */
function isTriggered(note: NoteEntry): boolean {
  return (
    Boolean(note.dueAt) && (note.kind === 'reminder' || (note.kind === 'task' && !note.done))
  );
}

/** Event-trigger entries (no dueAt) that still need to fire. */
function isEventPending(note: NoteEntry): boolean {
  return (
    Boolean(note.event) &&
    !note.fired &&
    (note.kind === 'reminder' || (note.kind === 'task' && !note.done))
  );
}

async function fireTrigger(note: NoteEntry): Promise<void> {
  if (!_context) {return;}
  const notes = loadNotes(_context);
  const idx = notes.findIndex((n) => n.id === note.id);
  if (idx === -1) {return;}
  // If already fired (e.g. snooze re-arm race), don't double-fire.
  if (notes[idx].fired) {return;}

  const recur = notes[idx].recur;
  const event = notes[idx].event;
  const isTask = notes[idx].kind === 'task';

  if (recur) {
    // Recurring triggers roll to the next occurrence and re-arm; they never
    // stay "fired". Snoozing below simply overrides the rolled-forward time.
    const next = computeNextOccurrence(recur, new Date());
    if (next) {
      notes[idx].dueAt = next.toISOString();
    } else {
      notes[idx].fired = true; // malformed rule — stop firing
    }
  } else if (event) {
    // Event triggers: one-shot entries are done after firing; every-time
    // entries stay armed for the next matching event.
    notes[idx].fired = !event.everyTime;
  } else {
    notes[idx].fired = true;
  }
  // `missed` is left as arm() set it (true when firing late) so the panel's
  // missed badge can show; snooze and dismiss clear it.
  saveNotes(_context, notes);

  playReminderSound();

  const title = isTask ? '⏳ Task due' : '⏰ Reminder';
  const when = event
    ? ` (${describeEventTrigger(event)})`
    : recur
      ? ` (repeats ${describeRecurrence(recur)})`
      : '';
  const body = `${title}${when}: ${notes[idx].summary ?? notes[idx].text}${contextSummary(notes[idx])}`;
  const snoozeMins = vscode.workspace.getConfiguration('askii').get<number>('noteSnoozeMinutes') ?? 10;
  const snoozeLabel = `Snooze ${snoozeMins}m`;
  const buttons = isTask
    ? event
      ? ['Open', 'Done', 'Dismiss']
      : ['Open', 'Done', snoozeLabel]
    : event
      ? ['Open', 'Dismiss']
      : ['Open', snoozeLabel, 'Dismiss'];
  const choice = await vscode.window.showInformationMessage(body, { modal: false }, ...buttons);

  if (choice === 'Open') {
    vscode.commands.executeCommand('askii.noteTask', { selectId: note.id });
  } else if (choice === 'Done' && isTask) {
    const fresh = loadNotes(_context);
    const i = fresh.findIndex((n) => n.id === note.id);
    if (i !== -1) {
      fresh[i].done = true;
      fresh[i].fired = true;
      saveNotes(_context, fresh);
    }
  } else if (choice === snoozeLabel) {
    const fresh = loadNotes(_context);
    const i = fresh.findIndex((n) => n.id === note.id);
    if (i !== -1) {
      fresh[i].fired = false;
      fresh[i].missed = false;
      fresh[i].dueAt = new Date(Date.now() + snoozeMins * 60_000).toISOString();
      saveNotes(_context, fresh);
    }
  } else if (choice === 'Dismiss') {
    const fresh = loadNotes(_context);
    const i = fresh.findIndex((n) => n.id === note.id);
    if (i !== -1 && fresh[i].missed) {
      fresh[i].missed = false;
      saveNotes(_context, fresh);
    }
  }
  // No choice (toast closed) or a rolled-forward recurring trigger: stored
  // state already reflects what happens next.

  rescheduleAll(loadNotes(_context));
  _notesChangedEmitter.fire();
}

function arm(note: NoteEntry): void {
  if (!_context) {return;}
  if (!isTriggered(note) || note.fired) {return;}
  let due = new Date(note.dueAt!).getTime();
  if (note.recur) {
    // Recurring triggers roll forward to the next occurrence instead of
    // firing late or being marked missed.
    if (due <= Date.now()) {
      const next = computeNextOccurrence(note.recur, new Date());
      if (!next) {return;}
      due = next.getTime();
      const notes = loadNotes(_context);
      const i = notes.findIndex((n) => n.id === note.id);
      if (i !== -1) {
        notes[i].dueAt = next.toISOString();
        notes[i].missed = false;
        saveNotes(_context, notes);
      }
    }
  } else if (due <= Date.now()) {
    // Past due — fire immediately and mark missed
    const notes = loadNotes(_context);
    const i = notes.findIndex((n) => n.id === note.id);
    if (i !== -1 && !notes[i].fired) {
      notes[i].missed = true;
      saveNotes(_context, notes);
      fireTrigger(notes[i]);
    }
    return;
  }
  const delta = due - Date.now();
  const delay = Math.min(delta, MAX_TIMEOUT_MS);
  const t = setTimeout(() => {
    timers.delete(note.id);
    // If we hit the cap, re-arm for the remainder instead of firing.
    if (delta > MAX_TIMEOUT_MS) {
      arm(note);
      return;
    }
    fireTrigger(note);
  }, delay);
  timers.set(note.id, t);
}

/**
 * Re-arm all reminder timers from the given notes array. Call after every
 * save to keep the scheduler in sync. Event triggers are not re-armed here —
 * they fire from activation and editor listeners registered once at startup.
 */
export function rescheduleAll(notes: NoteEntry[]): void {
  clearAllTimers();
  for (const n of notes) {arm(n);}
}

// ── Event triggers ────────────────────────────────────────────────────────────

function workspaceNames(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => f.name.toLowerCase());
}

/** Fire every pending event note matched by `matcher`, serially. */
async function fireMatchingEventNotes(matcher: (n: NoteEntry) => boolean): Promise<void> {
  if (!_context) {return;}
  const notes = loadNotes(_context);
  for (const n of notes) {
    if (!n.event || !isEventPending(n) || !matcher(n)) {continue;}
    // fireTrigger re-loads and re-checks fired state, so a note that fired
    // while we were awaiting an earlier notification is skipped.
    await fireTrigger(n);
  }
}

/**
 * Check activation-tied event triggers ("when I open VS Code", "when I open
 * this workspace"). Runs once per window, shortly after startup.
 */
function checkStartupEventTriggers(): void {
  const wsNames = workspaceNames();
  void fireMatchingEventNotes((n) => {
    const ev = n.event!;
    if (ev.type === 'startup') {return true;}
    if (ev.type === 'workspaceOpen') {
      // No pattern (created outside any workspace) → any workspace counts.
      if (!ev.pattern) {return wsNames.length > 0;}
      return wsNames.includes(ev.pattern.toLowerCase());
    }
    return false;
  });
}

function handleDocumentEvent(
  doc: vscode.TextDocument | undefined,
  type: 'fileOpen' | 'fileSave',
): void {
  if (!doc) {return;}
  const name = path.basename(doc.fileName);
  void fireMatchingEventNotes((n) => {
    const ev = n.event!;
    return ev.type === type && eventPatternMatches(ev.pattern, name, doc.fileName);
  });
}

function registerEventListeners(): void {
  if (eventListenersRegistered || !_context) {return;}
  eventListenersRegistered = true;
  _context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // Opening a file = its editor becoming active.
      if (editor) {handleDocumentEvent(editor.document, 'fileOpen');}
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      handleDocumentEvent(doc, 'fileSave');
    }),
  );
}

/**
 * Start the reminder scheduler. Call once in activate().
 */
export function startNoteScheduler(context: vscode.ExtensionContext): void {
  _context = context;
  const notes = loadNotes(context);
  rescheduleAll(notes);
  registerEventListeners();
  // Activation-tied triggers fire a few seconds in, once the window settles.
  clearTimeout(startupTimer);
  startupTimer = setTimeout(checkStartupEventTriggers, STARTUP_FIRE_DELAY_MS);
}

/**
 * Stop all timers (called on deactivate).
 */
export function stopNoteScheduler(): void {
  clearAllTimers();
  clearTimeout(startupTimer);
  startupTimer = undefined;
  _context = undefined;
}
