import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  type NoteEntry,
  type NoteKind,
  type TaskPriority,
  type NoteContext,
  type RecurRule,
  type EventTrigger,
  parseReminderTimeLocal,
  parseReminderTrigger,
  parseRecurrence,
  parseEventTrigger,
  computeNextOccurrence,
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

export async function captureScreenshot(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  try {
    const dir = path.join(context.globalStorageUri.fsPath, 'notes-screenshots');
    if (!fs.existsSync(dir)) {fs.mkdirSync(dir, { recursive: true });}
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
  recur: RecurRule | null;
  event: EventTrigger | null;
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
- "task"  : an actionable item that should be done. Extract a priority: "low" | "medium" | "high". If the text names a deadline ("by friday", "due 2026-07-08", "finish today at 5pm"), also extract "dueAt" as an ISO8601 timestamp in UTC.
- "reminder" : something the user wants to be pinged about. Extract "dueAt" as an ISO8601 timestamp in UTC. Resolve relative phrases against the current date/time above. Phrases you can rely on resolving include: "in 90 seconds", "in 30 minutes", "in 2 hours", "in 1 hour and 30 minutes", "in 1h30m", "in half an hour", "in a bit", "in two hours", "in a couple of hours", "in a few minutes", "in a fortnight", "20 minutes from now", "an hour from now", "at 5pm", "at 17:30", "at noon", "at midnight", "tomorrow at noon", "at 9 in the morning", "half past 5", "quarter to 6", "today at 3pm", "later today", "this morning/afternoon/evening", "tonight at 8pm", "tomorrow", "tomorrow 9am", "tomorrow morning/afternoon/evening", "this time tomorrow", "first thing in the morning", "day after tomorrow", "on friday", "this fri", "by tuesday", "due monday at 9am", "friday evening", "next monday", "next week on wednesday at 10am", "friday next week", "next month", "this weekend", "over the weekend", "end of day", "eod", "end of week", "eow", "end of month", "eom", "end of year", "eoy", "on the 15th", "by the 1st of next month", "july 8th", "8 july 2026 at 3pm", "2026-07-08 14:30".

Recurring triggers: if the user wants a repeating trigger ("every day at 9am", "daily", "every morning", "every weekday at 9", "every monday at 10", "every monday and wednesday at 6pm", "every mon, wed, fri", "weekly on friday at 5pm", "every weekend", "every 2 hours", "every 30 minutes", "every hour", "hourly", "every half hour", "every quarter hour", "every other day", "biweekly", "fortnightly", "every month", "monthly", "quarterly", "every month on the 15th", "every 15th of the month", "every year", "yearly", "every year on july 8"), extract "dueAt" for the FIRST occurrence, and mention the recurrence phrase verbatim inside "summary". Recurring TASKS are valid too ("water the plants every 3 days", "submit the weekly report every friday") — set kind "task"; the recurrence phrase itself is detected automatically from the text.

Event triggers: phrases like "when I open VS Code", "on startup", "when I open this workspace", "when I open/save <file>" ("when I open package.json", "every time I save .env", "when I save a ts file", "when I save this file") are valid triggers tied to editor events instead of a time. They are detected automatically from the text — for them leave "dueAt" null and do NOT set "needsClarification". If the text names BOTH a time and an event, keep the time in "dueAt" (the event is ignored).

Rules:
- If the user's text is ambiguous about WHEN a reminder should fire (e.g. "later", "soon", "remind me"), set "needsClarification": true and provide a short "clarifyingQuestion" asking for a concrete time. Otherwise set "needsClarification": false and "clarifyingQuestion": null.
- "remind me to stretch" with no time = ambiguous (needsClarification). "remind me to stretch every hour" = recurring (not ambiguous).
- Extract up to 5 short lowercase tags (single words or hyphenated phrases) that describe the topic.
- "summary" is a short (<= 80 chars) human-readable title for the entry.
- Respond with ONLY a single JSON object, no markdown, no extra text.

Output schema:
{"kind":"note"|"task"|"reminder","priority":"low"|"medium"|"high"|null,"dueAt":<ISO8601 or null>,"tags":[],"needsClarification":false,"clarifyingQuestion":null,"summary":""}`;

function buildClassifyPrompt(text: string, context: NoteContext): string {
  const ctxLines: string[] = [];
  if (context.workspaceFolder) {ctxLines.push(`- Workspace: ${context.workspaceFolder}`);}
  if (context.fileName)
    {ctxLines.push(`- Open file: ${context.fileName} (${context.languageId ?? '?'})`);}
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
  if (start !== -1 && end !== -1 && end > start) {s = s.slice(start, end + 1);}
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
  if (!Array.isArray(v)) {return [];}
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
        if (!isNaN(d.getTime())) {dueAt = d.toISOString();}
      }
      // Recurrence detection stays local — the rule format is ours. Tasks can
      // recur too ("water the plants every 3 days").
      const recur = kind === 'note' ? null : parseRecurrence(text, now);
      let event: EventTrigger | null = null;
      if (recur) {
        const first = computeNextOccurrence(recur, now);
        if (first) {dueAt = first.toISOString();}
      } else if (!dueAt && !needsClarification) {
        // Event triggers ("when I open VS Code", "when I save .env") come
        // before clock-time parsing; a time phrase wins if an event isn't found.
        event = kind === 'note' ? null : parseEventTrigger(text, context.workspaceFolder, context.fileName);
        if (!event && kind === 'reminder') {
          dueAt = parseReminderTimeLocal(text, now);
          if (!dueAt) {
            return {
              kind,
              priority,
              dueAt: null,
              recur: null,
              event: null,
              tags,
              needsClarification: true,
              clarifyingQuestion:
                'When should I remind you? (e.g. "in 2 hours", "tomorrow 9am", "every day at 9am", "2026-07-08 14:30")',
              summary,
            };
          }
        } else if (!event && kind === 'task') {
          dueAt = parseReminderTimeLocal(text, now);
        }
      }
      return { kind, priority, dueAt, recur, event, tags, needsClarification, clarifyingQuestion, summary };
    }
  } catch {
    // fall through to heuristic
  }

  // Heuristic fallback (no LLM available)
  const lower = text.toLowerCase();
  let kind: NoteKind = 'note';
  let priority: TaskPriority | null = null;
  let needsClarification = false;
  let clarifyingQuestion: string | null = null;

  const trigger = parseReminderTrigger(text, now);
  const { dueAt, recur } = trigger;
  // Event triggers are only used when no time trigger was found.
  let event = parseEventTrigger(text, context.workspaceFolder, context.fileName);
  if (event && (dueAt || recur)) {event = null;}
  const hasTimeTrigger = Boolean(dueAt || recur || event);

  const reminderWord =
    /\b(?:remind|reminder|ping me|notify|alert|wake me|follow up|appointment)\b/.test(lower) ||
    /\bdon'?t (?:let me )?forget\b/.test(lower) ||
    /\bremember to\b/.test(lower);
  const taskWord =
    /\b(?:task|todo|to-do|fix|implement|add|create|write|update|refactor|review|ship|deploy|release|debug|finish|complete|build|migrate|integrate|draft|prepare|submit|buy|pay|send|book)\b/.test(
      lower,
    ) ||
    /\b(?:need to|needs to|should|must|have to|gotta|plan to|going to|want to)\b/.test(lower) ||
    /^\s*(?:do|try|check|make|read|watch|ask|pick up|set up|clean up)\b/.test(lower);
  // "meeting at 3pm" / "call mom tomorrow" — only a reminder with a time trigger.
  const scheduledEvent =
    hasTimeTrigger &&
    /\b(?:meeting|standup|stand-up|appointment|call|text|email|deadline|due|interview)\b/.test(
      lower,
    );

  if (reminderWord || scheduledEvent || ((recur || event) && !taskWord)) {
    // A recurrence or event trigger with no task wording is still a trigger
    // ("standup every weekday at 9am", "when I open VS Code, check email"),
    // so treat it as a reminder.
    kind = 'reminder';
    if (!hasTimeTrigger) {
      needsClarification = true;
      clarifyingQuestion =
        'When should I remind you? (e.g. "in 2 hours", "tomorrow 9am", "every day at 9am")';
    }
  } else if (taskWord) {
    kind = 'task';
    if (/\b(?:high|critical|urgent|asap|p0)\b/.test(lower)) {priority = 'high';}
    else if (/\b(?:low|minor|whenever|someday|p3)\b/.test(lower)) {priority = 'low';}
    else {priority = 'medium';}
  }

  return {
    kind,
    priority,
    dueAt,
    recur: kind === 'note' ? null : (recur ?? null),
    event: kind === 'note' ? null : event,
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
  // Tasks can carry a deadline trigger; reminders always can. Tasks may also
  // recur ("water the plants every 3 days") or fire on an event ("when I open
  // VS Code") — classify sets dueAt to the first occurrence in the recur case.
  const triggered =
    cls.kind === 'reminder' ||
    (cls.kind === 'task' && (Boolean(cls.dueAt) || Boolean(cls.event)));
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
    dueAt: triggered ? (cls.dueAt ?? undefined) : undefined,
    fired: triggered ? false : undefined,
    missed: cls.kind === 'reminder' ? false : undefined,
    recur: triggered ? (cls.recur ?? undefined) : undefined,
    event: triggered ? (cls.event ?? undefined) : undefined,
    screenshotPath,
    context,
  };
}
