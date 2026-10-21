import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { getTaskPanelHtml } from './taskPanelHtml';

// ── Timeline panel for ASKII Do / ASKII Control runs ────────────────────────
// Single-instance webview that renders a run as a vertical timeline with a
// Cancel button while the run is active and a follow-up input once it ends.
// The Do/Control loops in commands.ts feed it entries and use requestChoice()
// for the Confirm/Skip prompts that used to be modal dialogs.

export type TaskStatus = 'running' | 'awaiting' | 'done' | 'cancelled' | 'error';

export interface TimelineEntry {
  id: number;
  kind: 'round' | 'action' | 'info' | 'confirm' | 'error' | 'done';
  title: string;
  detail?: string;
  status?: 'pending' | 'ok' | 'skipped' | 'error';
  time: string;
  screenshot?: string;
  stream?: string;
  options?: string[];
  confirmMessage?: string;
}

let panel: vscode.WebviewPanel | undefined;
let disposed = true;
let entrySeq = 0;
let sessionActive = false;
let currentStatus: TaskStatus = 'done';
let canceller: (() => void) | undefined;
let pendingConfirm: { id: number; resolve: (answer: string | null) => void } | undefined;
let pendingFollowUp: { resolve: (text: string | null) => void } | undefined;
const entryStatuses = new Map<number, TimelineEntry['status']>();
const streamBuffers = new Map<
  number,
  { text: string; timer: ReturnType<typeof setTimeout> | null }
>();

function post(message: unknown): void {
  if (!panel || disposed) {return;}
  void panel.webview.postMessage(message);
}

function nowStamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── Session guard ────────────────────────────────────────────────────────────
// Only one Do/Control run may drive the panel at a time; a second command
// started while one is active gets rejected with a message instead of
// interleaving two runs into the same timeline.

export function beginTaskSession(): boolean {
  if (sessionActive) {return false;}
  sessionActive = true;
  return true;
}

export function endTaskSession(): void {
  sessionActive = false;
}

// ── Panel lifecycle ──────────────────────────────────────────────────────────

export function acquireTaskPanel(title: string): void {
  entrySeq = 0;
  entryStatuses.clear();
  // Pending flushes would otherwise post the old run's text into the new
  // run's entries, which reuse the same ids
  for (const buf of streamBuffers.values()) {
    if (buf.timer !== null) { clearTimeout(buf.timer); }
  }
  streamBuffers.clear();
  // Stale waiters from a previous session resolve as "no answer" so their
  // command loops exit cleanly when a new run takes the panel over.
  if (pendingConfirm) { pendingConfirm.resolve(null); pendingConfirm = undefined; }
  if (pendingFollowUp) { pendingFollowUp.resolve(null); pendingFollowUp = undefined; }

  if (panel) {
    disposed = false;
    panel.title = title;
    panel.reveal(vscode.ViewColumn.Beside, true);
    post({ type: 'reset', title });
    return;
  }

  disposed = false;
  const nonce = randomBytes(16).toString('base64');
  panel = vscode.window.createWebviewPanel(
    'askiiTask',
    title,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
  );
  panel.iconPath = vscode.Uri.parse(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
      ),
  );
  panel.webview.html = getTaskPanelHtml(nonce);
  panel.webview.onDidReceiveMessage(handlePanelMessage);
  panel.onDidDispose(() => {
    panel = undefined;
    disposed = true;
    // A closed panel cancels an active run and resolves any pending waits.
    canceller?.();
    if (pendingConfirm) { pendingConfirm.resolve(null); pendingConfirm = undefined; }
    if (pendingFollowUp) { pendingFollowUp.resolve(null); pendingFollowUp = undefined; }
  });
}

function handlePanelMessage(msg: unknown): void {
  if (typeof msg !== 'object' || msg === null) {return;}
  const m = msg as { type?: string; id?: number; answer?: unknown; text?: unknown };
  if (m.type === 'cancel') {
    const fn = canceller;
    canceller = undefined;
    if (fn) {fn();}
    if (pendingConfirm) {
      const resolve = pendingConfirm.resolve;
      pendingConfirm = undefined;
      resolve(null);
    }
  } else if (m.type === 'confirmResult' && typeof m.id === 'number') {
    if (pendingConfirm && pendingConfirm.id === m.id) {
      const resolve = pendingConfirm.resolve;
      pendingConfirm = undefined;
      resolve(typeof m.answer === 'string' ? m.answer : null);
    }
  } else if (m.type === 'followup') {
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    if (text === '' || !pendingFollowUp) {return;}
    const resolve = pendingFollowUp.resolve;
    pendingFollowUp = undefined;
    resolve(text);
  }
}

// ── Timeline API (called by the Do/Control loops) ────────────────────────────

export function addTimelineEntry(entry: Omit<TimelineEntry, 'id' | 'time'>): number {
  const id = ++entrySeq;
  entryStatuses.set(id, entry.status);
  post({ type: 'entry', entry: { ...entry, id, time: nowStamp() } });
  return id;
}

export function updateTimelineEntry(id: number, patch: Partial<TimelineEntry>): void {
  if (patch.status !== undefined) { entryStatuses.set(id, patch.status); }
  post({ type: 'entryUpdate', id, patch });
}

// Terminal failure/cancel paths leave freshly-created action entries spinning
// forever; flip any still-pending entries to "skipped" so the timeline settles.
export function sweepPendingEntries(): void {
  for (const [id, status] of entryStatuses) {
    if (status === 'pending') { updateTimelineEntry(id, { status: 'skipped' }); }
  }
}

export function streamToEntry(id: number, chunk: string): void {
  if (!panel || disposed) {return;}
  let buf = streamBuffers.get(id);
  if (!buf) {
    buf = { text: '', timer: null };
    streamBuffers.set(id, buf);
  }
  buf.text += chunk;
  if (buf.timer === null) {
    const b = buf;
    b.timer = setTimeout(() => {
      b.timer = null;
      post({ type: 'entryStream', id, text: b.text });
    }, 50);
  }
}

export function flushEntryStream(id: number): void {
  const buf = streamBuffers.get(id);
  if (!buf) {return;}
  if (buf.timer !== null) { clearTimeout(buf.timer); buf.timer = null; }
  post({ type: 'entryStream', id, text: buf.text });
}

export function setTaskStatus(status: TaskStatus, message?: string): void {
  currentStatus = status;
  post({ type: 'status', status, message });
}

export function setTaskCanceller(fn: () => void): void {
  canceller = fn;
}

// Renders Confirm/Skip-style buttons under an existing entry and pauses the
// run until the user answers. Resolves null when the panel is closed or the
// run is cancelled while waiting — callers treat that as "skip"/"keep".
export function requestChoice(
  entryId: number,
  message: string | undefined,
  options: string[],
): Promise<string | null> {
  if (!panel || disposed) {return Promise.resolve(null);}
  const statusBeforeChoice = currentStatus;
  return new Promise((resolve) => {
    pendingConfirm = {
      id: entryId,
      resolve: (answer) => {
        // Hand the status back (running mid-run, done after the keep/undo
        // choice) unless a terminal status already took over.
        if (currentStatus === 'awaiting') { setTaskStatus(statusBeforeChoice); }
        resolve(answer);
      },
    };
    post({ type: 'confirm', id: entryId, message, options });
    currentStatus = 'awaiting';
    post({ type: 'status', status: 'awaiting' });
  });
}

// Resolves with the follow-up instruction typed into the panel footer, or null
// when the panel is closed/taken over while waiting.
export function waitForFollowUp(): Promise<string | null> {
  if (!panel || disposed) {return Promise.resolve(null);}
  return new Promise((resolve) => {
    pendingFollowUp = { resolve };
  });
}
