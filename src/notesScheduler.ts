import * as vscode from 'vscode';
import { type NoteEntry } from '@common/notes';
import { loadNotes, saveNotes } from './notes';

// ── Scheduler state ───────────────────────────────────────────────────────────

const timers = new Map<string, NodeJS.Timeout>();
let _context: vscode.ExtensionContext | undefined;

// Event fired whenever notes are mutated by the scheduler (reminder fired /
// snoozed / dismissed) so open panels can refresh their list.
const _notesChangedEmitter = new vscode.EventEmitter<void>();
export const onNotesChanged: vscode.Event<void> = _notesChangedEmitter.event;

// Cap setTimeout at 24h; longer deltas re-arm on fire.
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

function clearAllTimers(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}

function playReminderSound(): void {
  const config = vscode.workspace.getConfiguration('askii');
  if (!(config.get<boolean>('noteReminderSound') ?? true)) return;
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
  if (note.context?.workspaceFolder) parts.push(`Workspace: ${note.context.workspaceFolder}`);
  if (note.context?.fileName) parts.push(`File: ${note.context.fileName}`);
  if (note.context?.selectedText) {
    const snip =
      note.context.selectedText.length > 120
        ? note.context.selectedText.slice(0, 120) + '…'
        : note.context.selectedText;
    parts.push(`Selection: "${snip}"`);
  }
  return parts.length ? `\n\nContext:\n${parts.join('\n')}` : '';
}

async function fireReminder(note: NoteEntry): Promise<void> {
  if (!_context) return;
  const notes = loadNotes(_context);
  const idx = notes.findIndex((n) => n.id === note.id);
  if (idx === -1) return;
  // If already fired (e.g. snooze re-arm race), don't double-fire.
  if (notes[idx].fired) return;
  notes[idx].fired = true;
  notes[idx].missed = false;
  saveNotes(_context, notes);

  playReminderSound();

  const body = `⏰ ${note.summary ?? note.text}${contextSummary(note)}`;
  const choice = await vscode.window.showInformationMessage(
    body,
    { modal: false },
    'Open',
    'Snooze 10m',
    'Dismiss',
  );

  if (choice === 'Open') {
    vscode.commands.executeCommand('askii.noteTask', { selectId: note.id });
  } else if (choice === 'Snooze 10m') {
    const config = vscode.workspace.getConfiguration('askii');
    const mins = config.get<number>('noteSnoozeMinutes') ?? 10;
    const fresh = loadNotes(_context);
    const i = fresh.findIndex((n) => n.id === note.id);
    if (i !== -1) {
      fresh[i].fired = false;
      fresh[i].dueAt = new Date(Date.now() + mins * 60_000).toISOString();
      saveNotes(_context, fresh);
      rescheduleAll(fresh);
    }
  }
  // 'Dismiss' or undefined: leave fired=true, no reschedule.

  _notesChangedEmitter.fire();
}

function arm(note: NoteEntry): void {
  if (!_context) return;
  if (note.kind !== 'reminder' || !note.dueAt || note.fired) return;
  const due = new Date(note.dueAt).getTime();
  const delta = due - Date.now();
  if (delta <= 0) {
    // Past due — fire immediately and mark missed
    const notes = loadNotes(_context);
    const i = notes.findIndex((n) => n.id === note.id);
    if (i !== -1 && !notes[i].fired) {
      notes[i].missed = true;
      saveNotes(_context, notes);
      fireReminder(notes[i]);
    }
    return;
  }
  const delay = Math.min(delta, MAX_TIMEOUT_MS);
  const t = setTimeout(() => {
    timers.delete(note.id);
    // If we hit the cap, re-arm for the remainder instead of firing.
    if (delta > MAX_TIMEOUT_MS) {
      arm(note);
      return;
    }
    fireReminder(note);
  }, delay);
  timers.set(note.id, t);
}

/**
 * Re-arm all reminder timers from the given notes array. Call after every
 * save to keep the scheduler in sync.
 */
export function rescheduleAll(notes: NoteEntry[]): void {
  clearAllTimers();
  for (const n of notes) arm(n);
}

/**
 * Start the reminder scheduler. Call once in activate().
 */
export function startNoteScheduler(context: vscode.ExtensionContext): void {
  _context = context;
  const notes = loadNotes(context);
  rescheduleAll(notes);
}

/**
 * Stop all timers (called on deactivate).
 */
export function stopNoteScheduler(): void {
  clearAllTimers();
  _context = undefined;
}
