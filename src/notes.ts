import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  type NoteEntry,
  type NoteKind,
  type TaskPriority,
  type NoteContext,
  parseReminderTimeLocal,
} from '@common/notes';
import { getExtensionResponse } from './providers';
import { takeScreenshot } from '@common/control';

// ── Storage (global, tagged by workspace) ─────────────────────────────────────

const STATE_KEY = 'askii.notes';

export function loadNotes(context: vscode.ExtensionContext): NoteEntry[] {
  const raw = context.globalState.get<NoteEntry[]>(STATE_KEY);
  return Array.isArray(raw) ? raw : [];
}

export function saveNotes(context: vscode.ExtensionContext, notes: NoteEntry[]): void {
  context.globalState.update(STATE_KEY, notes);
}

export function genId(): string {
  return randomBytes(8).toString('hex') + Date.now().toString(36);
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

export async function captureScreenshot(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  try {
    const dir = path.join(context.globalStorageUri.fsPath, 'notes-screenshots');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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

export interface ClassificationResult {
  kind: NoteKind;
  priority: TaskPriority | null;
  dueAt: string | null;
  tags: string[];
  needsClarification: boolean;
  clarifyingQuestion: string | null;
  summary: string;
}

const CLASSIFY_SYSTEM = `You are ASKII Note, an assistant that classifies free-text notes from the user into one of three kinds and extracts structured metadata.

Current date/time (ISO8601): {NOW}
Workspace: {WORKSPACE}

Kinds:
- "note"  : a plain piece of information to remember (no deadline, no priority).
- "task"  : an actionable item that should be done. Extract a priority: "low" | "medium" | "high".
- "reminder" : something the user wants to be pinged about at a specific time. Extract "dueAt" as an ISO8601 timestamp in UTC. Resolve relative phrases ("in 2 hours", "tomorrow 9am", "next monday") against the current date/time above.

Rules:
- If the user's text is ambiguous about WHEN a reminder should fire (e.g. "later", "soon", "remind me"), set "needsClarification": true and provide a short "clarifyingQuestion" asking for a concrete time. Otherwise set "needsClarification": false and "clarifyingQuestion": null.
- Extract up to 5 short lowercase tags (single words or hyphenated phrases) that describe the topic.
- "summary" is a short (<= 80 chars) human-readable title for the entry.
- Respond with ONLY a single JSON object, no markdown, no extra text.

Output schema:
{"kind":"note"|"task"|"reminder","priority":"low"|"medium"|"high"|null,"dueAt":<ISO8601 or null>,"tags":[],"needsClarification":false,"clarifyingQuestion":null,"summary":""}`;

function buildClassifyPrompt(text: string, context: NoteContext): string {
  const ctxLines: string[] = [];
  if (context.workspaceFolder) ctxLines.push(`- Workspace: ${context.workspaceFolder}`);
  if (context.fileName)
    ctxLines.push(`- Open file: ${context.fileName} (${context.languageId ?? '?'})`);
  if (context.selectedText) {
    const snip =
      context.selectedText.length > 600
        ? context.selectedText.slice(0, 600) + '…'
        : context.selectedText;
    ctxLines.push(`- Selected text:\n\`\`\`\n${snip}\n\`\`\``);
  }
  const ctxSection = ctxLines.length
    ? `\n\nContext the user currently has open:\n${ctxLines.join('\n')}`
    : '';
  return `Classify this user note:${ctxSection}\n\nUser note:\n"""\n${text}\n"""`;
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  let s = raw.trim();
  // strip markdown fences if present
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // grab the first {...} block if there's surrounding noise
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) s = s.slice(start, end + 1);
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function coerceKind(v: unknown): NoteKind {
  return v === 'task' || v === 'reminder' ? (v as NoteKind) : 'note';
}

function coercePriority(v: unknown): TaskPriority | null {
  return v === 'low' || v === 'medium' || v === 'high' ? (v as TaskPriority) : null;
}

function coerceTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.toLowerCase().trim())
    .filter((x) => x.length > 0)
    .slice(0, 5);
}

/**
 * Classify a free-text note. May call the LLM; falls back to a heuristic
 * (note kind, no priority, local time parse) if the LLM fails or is unavailable.
 */
export async function classifyNoteInput(
  text: string,
  context: NoteContext,
): Promise<ClassificationResult> {
  const now = new Date();
  const system = CLASSIFY_SYSTEM.replace('{NOW}', now.toISOString()).replace(
    '{WORKSPACE}',
    context.workspaceFolder ?? '(no workspace)',
  );

  try {
    const raw = await getExtensionResponse(buildClassifyPrompt(text, context), system);
    const obj = safeParseJson(raw);
    if (obj) {
      const kind = coerceKind(obj['kind']);
      const priority = coercePriority(obj['priority']);
      const tags = coerceTags(obj['tags']);
      const needsClarification = obj['needsClarification'] === true;
      const clarifyingQuestion =
        typeof obj['clarifyingQuestion'] === 'string' ? obj['clarifyingQuestion'] : null;
      const summary =
        typeof obj['summary'] === 'string' && obj['summary'].trim()
          ? obj['summary'].trim().slice(0, 120)
          : text.slice(0, 80);
      let dueAt: string | null = null;
      if (typeof obj['dueAt'] === 'string' && obj['dueAt']) {
        const d = new Date(obj['dueAt']);
        if (!isNaN(d.getTime())) dueAt = d.toISOString();
      }
      // If reminder but no dueAt and not asking for clarification, try local parse
      if (kind === 'reminder' && !dueAt && !needsClarification) {
        dueAt = parseReminderTimeLocal(text, now);
        if (!dueAt) {
          return {
            kind,
            priority,
            dueAt: null,
            tags,
            needsClarification: true,
            clarifyingQuestion:
              'When should I remind you? (e.g. "in 2 hours", "tomorrow 9am", "2026-07-08 14:30")',
            summary,
          };
        }
      }
      return { kind, priority, dueAt, tags, needsClarification, clarifyingQuestion, summary };
    }
  } catch {
    // fall through to heuristic
  }

  // Heuristic fallback
  const lower = text.toLowerCase();
  let kind: NoteKind = 'note';
  let priority: TaskPriority | null = null;
  let dueAt: string | null = null;
  let needsClarification = false;
  let clarifyingQuestion: string | null = null;

  if (/remind|reminder|ping|notify|alert/.test(lower)) {
    kind = 'reminder';
    dueAt = parseReminderTimeLocal(text, now);
    if (!dueAt) {
      needsClarification = true;
      clarifyingQuestion = 'When should I remind you? (e.g. "in 2 hours", "tomorrow 9am")';
    }
  } else if (/task|todo|to-do|fix|implement|do:|need to|should|must/.test(lower)) {
    kind = 'task';
    if (/high|critical|urgent|asap/.test(lower)) priority = 'high';
    else if (/low|minor|whenever|someday/.test(lower)) priority = 'low';
    else priority = 'medium';
  }

  return {
    kind,
    priority,
    dueAt,
    tags: [],
    needsClarification,
    clarifyingQuestion,
    summary: text.slice(0, 80),
  };
}

// ── Build a NoteEntry from a classification ───────────────────────────────────

export function buildEntry(
  text: string,
  cls: ClassificationResult,
  context: NoteContext,
  screenshotPath?: string,
): NoteEntry {
  return {
    id: genId(),
    kind: cls.kind,
    text,
    summary: cls.summary,
    tags: cls.tags,
    createdAt: new Date().toISOString(),
    workspaceTag: context.workspaceFolder,
    priority: cls.kind === 'task' ? (cls.priority ?? 'medium') : undefined,
    done: cls.kind === 'task' ? false : undefined,
    dueAt: cls.kind === 'reminder' ? (cls.dueAt ?? undefined) : undefined,
    fired: cls.kind === 'reminder' ? false : undefined,
    screenshotPath,
    context,
  };
}
