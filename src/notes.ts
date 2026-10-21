import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { type NoteEntry, type NoteContext } from '@common/notes';
import {
  buildNoteEntry,
  classifyNote,
  genNoteId,
  type ClassificationResult,
} from '@common/noteClassify';
import { getExtensionResponse } from './providers';
import { log } from './log';

// ── Storage (global, tagged by workspace) ─────────────────────────────────────

const STATE_KEY = 'askii.notes';

export function loadNotes(context: vscode.ExtensionContext): NoteEntry[] {
  const raw = context.globalState.get<NoteEntry[]>(STATE_KEY);
  return Array.isArray(raw) ? raw : [];
}

/**
 * Persists the notes. globalState updates its in-memory value immediately,
 * so later loadNotes() calls see the change; the returned promise settles
 * when it is written to disk, and a failed write is logged, not dropped.
 */
export function saveNotes(context: vscode.ExtensionContext, notes: NoteEntry[]): Promise<void> {
  return Promise.resolve(context.globalState.update(STATE_KEY, notes)).catch((error: unknown) =>
    log.error('Could not save ASKII notes', error),
  );
}

export const genId = genNoteId;

// ── Mutations (used by the Note panel) ────────────────────────────────────────

/**
 * Update an entry's text in place. Returns true if the entry was found and
 * the new text was non-empty. Callers are responsible for refreshing any UI.
 */
export function updateNoteText(
  context: vscode.ExtensionContext,
  id: string,
  text: string,
): boolean {
  const clean = text.trim();
  if (!id || !clean) {return false;}
  const notes = loadNotes(context);
  const i = notes.findIndex((n) => n.id === id);
  if (i === -1) {return false;}
  notes[i].text = clean;
  saveNotes(context, notes);
  return true;
}

/**
 * Snooze a triggered entry (reminder or task with a due date) by N minutes:
 * un-fires it and pushes dueAt into the future. Does NOT re-arm the scheduler
 * — the caller must call `rescheduleAll(loadNotes(context))` afterwards.
 */
export function snoozeNote(context: vscode.ExtensionContext, id: string, minutes: number): boolean {
  if (!id || !(minutes > 0)) {return false;}
  const notes = loadNotes(context);
  const i = notes.findIndex((n) => n.id === id);
  if (i === -1 || !notes[i].dueAt) {return false;}
  notes[i].fired = false;
  notes[i].missed = false;
  notes[i].dueAt = new Date(Date.now() + minutes * 60_000).toISOString();
  saveNotes(context, notes);
  return true;
}

function currentWorkspaceTag(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? folder.name : undefined;
}

// ── Context capture ───────────────────────────────────────────────────────────

export function captureContext(): NoteContext {
  const editor = vscode.window.activeTextEditor;
  const ctx: NoteContext = {
    workspaceFolder: currentWorkspaceTag(),
  };
  if (editor) {
    ctx.fileName = path.basename(editor.document.fileName);
    ctx.languageId = editor.document.languageId;
    const sel = editor.selection;
    if (!sel.isEmpty) {
      const text = editor.document.getText(sel);
      ctx.selectedText = text.length > 2000 ? text.slice(0, 2000) + '…[truncated]' : text;
    }
  }
  return ctx;
}

// ── Screenshot capture & storage ──────────────────────────────────────────────

export function getScreenshotDir(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, 'notes-screenshots');
}

/** True when filePath is a screenshot ASKII Note stored itself. */
export function isNoteScreenshot(context: vscode.ExtensionContext, filePath: string): boolean {
  const rel = path.relative(getScreenshotDir(context), path.resolve(filePath));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.toLowerCase().endsWith('.png');
}

/** Deletes a note's screenshot file (best-effort). */
export function deleteNoteScreenshot(context: vscode.ExtensionContext, filePath?: string): void {
  if (!filePath || !isNoteScreenshot(context, filePath)) {return;}
  try {
    fs.unlinkSync(filePath);
  } catch {
    // already gone
  }
}

export async function captureScreenshot(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  try {
    const dir = getScreenshotDir(context);
    if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true });}
    // Loaded on first use — keeps jimp / screenshot-desktop out of activation
    const { takeScreenshot } = await import('../common/control.js');
    const { base64 } = await takeScreenshot();
    const id = genId();
    const file = path.join(dir, `${id}.png`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return file;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    vscode.window.showWarningMessage(`ASKII Note: screenshot failed (${msg})`);
    return undefined;
  }
}

// ── AI classification ─────────────────────────────────────────────────────────

export type { ClassificationResult };

/** Classifies a note with the general model; see @common/noteClassify. */
export function classifyNoteInput(
  text: string,
  context: NoteContext,
): Promise<ClassificationResult> {
  return classifyNote(text, context, (prompt, system) => getExtensionResponse(prompt, system));
}

export function buildEntry(
  text: string,
  cls: ClassificationResult,
  context: NoteContext,
  screenshotPath?: string,
): NoteEntry {
  return buildNoteEntry(text, cls, context, screenshotPath);
}
