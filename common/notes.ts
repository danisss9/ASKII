import MiniSearch from 'minisearch';

// ── Types ────────────────────────────────────────────────────────────────────

export type NoteKind = 'note' | 'task' | 'reminder';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface NoteContext {
  fileName?: string;
  languageId?: string;
  selectedText?: string;
  workspaceFolder?: string;
}

export interface NoteEntry {
  id: string;
  kind: NoteKind;
  text: string;
  summary?: string;
  tags: string[];
  createdAt: string; // ISO8601
  workspaceTag?: string;
  pinned?: boolean;
  // task-specific
  priority?: TaskPriority;
  done?: boolean;
  // reminder-specific
  dueAt?: string; // ISO8601
  fired?: boolean;
  missed?: boolean;
  recur?: RecurRule;
  // event-based trigger (instead of a time): fire on a VS Code event
  event?: EventTrigger;
  // attachment
  screenshotPath?: string;
  context?: NoteContext;
}

// ── MiniSearch index ──────────────────────────────────────────────────────────

interface NoteDoc {
  id: string;
  kind: NoteKind;
  text: string;
  tags: string;
  workspaceTag: string;
  priority: string;
}

const MS_OPTIONS: ConstructorParameters<typeof MiniSearch<NoteDoc>>[0] = {
  fields: ['text', 'tags'],
  storeFields: ['id', 'kind', 'text', 'tags', 'workspaceTag', 'priority'],
  searchOptions: {
    boost: { tags: 2 },
    fuzzy: 0.2,
    prefix: true,
  },
};

export interface NoteSearchResult {
  entry: NoteEntry;
  score: number;
}

/**
 * Build a fresh MiniSearch index from an in-memory array of notes.
 * The index is rebuilt on every search call (notes are small and few), so we
 * don't persist it to disk like the wiki index.
 */
function buildIndex(notes: NoteEntry[]): MiniSearch<NoteDoc> {
  const ms = new MiniSearch<NoteDoc>(MS_OPTIONS);
  const docs: NoteDoc[] = notes.map((n) => ({
    id: n.id,
    kind: n.kind,
    text: n.text,
    tags: (n.tags ?? []).join(' '),
    workspaceTag: n.workspaceTag ?? '',
    priority: n.priority ?? '',
  }));
  ms.addAll(docs);
  return ms;
}

/**
 * Full-text search across all notes. Returns matching entries ranked by
 * relevance. An empty query returns all notes (most-recent first).
 */
export function searchNotes(query: string, notes: NoteEntry[], topK = 50): NoteSearchResult[] {
  if (!query.trim()) {
    return notes
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, topK)
      .map((entry) => ({ entry, score: 0 }));
  }

  const ms = buildIndex(notes);
  const results = ms.search(query).slice(0, topK) as (ReturnType<typeof ms.search>[number] &
    NoteDoc)[];
  const byId = new Map(notes.map((n) => [n.id, n]));
  const out: NoteSearchResult[] = [];
  for (const r of results) {
    const entry = byId.get(r.id);
    if (entry) {out.push({ entry, score: r.score });}
  }
  return out;
}

// ── Reminder trigger parsing (local regex, LLM fallback handled in src/notes.ts) ──

/** A recurrence rule for reminders that fire repeatedly. */
export interface RecurRule {
  type: 'daily' | 'weekly' | 'weekdays' | 'weekends' | 'monthly' | 'yearly' | 'interval';
  /** weekly: 0 (Sun)–6 (Sat). monthly: day of month (1–31, clamped per month). yearly: day of month when `month` is set. */
  day?: number;
  /** weekly: all target days (0–6); used instead of `day` for multi-weekday rules ("every mon, wed, fri"). */
  days?: number[];
  /** yearly: month (0=Jan–11=Dec) when the rule is anchored to a date ("every year on july 8"). */
  month?: number;
  /** interval rules: fire every `interval` `unit`s. */
  interval?: number;
  unit?: 'minute' | 'hour' | 'day' | 'week' | 'month';
  /** Local wall-clock time "HH:MM" for calendar rules. */
  time?: string;
}

export interface ReminderTrigger {
  dueAt: string | null;
  recur: RecurRule | null;
}

// ── Event triggers (non-time) ─────────────────────────────────────────────────

export type EventType = 'startup' | 'workspaceOpen' | 'fileOpen' | 'fileSave';

/**
 * A trigger tied to a VS Code event instead of a clock time. One-shot triggers
 * fire once ("when I open VS Code") and are then marked fired; `everyTime`
 * triggers fire on each matching event ("every time I save package.json").
 */
export interface EventTrigger {
  type: EventType;
  /** fileOpen/fileSave: file name/glob matched against the document. workspaceOpen: workspace folder name. */
  pattern?: string;
  /** Fire on every matching event instead of just the next one. */
  everyTime?: boolean;
}

/** Case-insensitive file pattern match: exact/glob on basename or path. */
export function eventPatternMatches(
  pattern: string | undefined,
  fileName: string,
  filePath?: string,
): boolean {
  if (!pattern || !pattern.trim()) {return true;}
  const p = pattern.trim().toLowerCase();
  const test = (s: string): boolean => {
    const l = s.toLowerCase().replace(/\\/g, '/');
    if (p.includes('*') || p.includes('?')) {
      const re = new RegExp(
        '^' +
          p
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]') +
          '$',
      );
      return re.test(l) || re.test(l.split('/').pop() ?? '');
    }
    if (l === p || l.endsWith('/' + p)) {return true;}
    // ".env"-style patterns match the basename suffix at a boundary.
    if (p.startsWith('.') && (l.split('/').pop() ?? '').endsWith(p)) {return true;}
    return false;
  };
  return test(fileName) || (filePath ? test(filePath) : false);
}

/** Human-readable event trigger for UI labels and notifications. */
export function describeEventTrigger(e: EventTrigger): string {
  const every = e.everyTime ? 'every time' : 'next time';
  switch (e.type) {
    case 'startup':
      return `${every} you open VS Code`;
    case 'workspaceOpen':
      return e.pattern ? `${every} you open the ${e.pattern} workspace` : `${every} you open a workspace`;
    case 'fileOpen':
      return e.pattern ? `${every} you open ${e.pattern}` : `${every} you open a file`;
    case 'fileSave':
      return e.pattern ? `${every} you save ${e.pattern}` : `${every} you save`;
  }
}

// Shared "when(ever) / every time / next time (I/you)" prefix for event phrases.
const WHEN_PREFIX = String.raw`\b(?:next\s+time|when(?:ever)?|each\s+time|every\s+time)\s+(?:i|you)\s+(?:next\s+)?`;

// Words that read as an article/pronoun rather than a file extension
// ("when I open the file" means any file, not "*.the").
const NON_EXT_WORDS = /^(?:the|a|an|any|this|that|these|those|my|our|file|files|some)$/;

/**
 * Detect event-based trigger phrases and return the trigger, or null.
 *
 * Recognised examples:
 *   "when I open VS Code", "next time you open vscode", "on startup",
 *   "when VS Code starts", "every time I open VS Code"
 *   "when I open this workspace", "every time I switch to the project"
 *   "when I open package.json", "every time I save .env", "when I open a ts file",
 *   "when I save this file", "when I save" (any file)
 *
 * `workspaceFolder` names the workspace for "this workspace" triggers;
 * `currentFileName` is captured for "this file" triggers.
 */
export function parseEventTrigger(
  text: string,
  workspaceFolder?: string,
  currentFileName?: string,
): EventTrigger | null {
  const t = normalizeTriggerText(text);
  if (!t) {return null;}

  const everyTime =
    /\b(?:every|each)\s+time\b/.test(t) ||
    /\bwhenever\b/.test(t) ||
    /\bevery\s+(?:vs\.?\s?code\s+)?startup\b/.test(t);

  // "when I open/start VS Code", "on startup", "when VS Code starts"
  if (
    new RegExp(WHEN_PREFIX + String.raw`(?:open|start|launch|relaunch|restart)\s+(?:vs\.?\s?code|vscode|the\s+editor)\b`).test(t) ||
    /\b(?:on|at)\s+(?:vs\.?\s?code\s+|vscode\s+)?startup\b/.test(t) ||
    /\bwhen\s+(?:vs\.?\s?code|vscode)\s+(?:starts|opens|launches|relaunches)\b/.test(t)
  ) {
    return { type: 'startup', everyTime };
  }

  // "when I open this workspace / the project / this repo"
  if (
    new RegExp(
      WHEN_PREFIX + String.raw`(?:open|enter|launch|switch\s+to)\s+(?:this|the)\s+(?:workspace|project|repo(?:sitory)?|folder|directory)\b`,
    ).test(t)
  ) {
    return { type: 'workspaceOpen', pattern: workspaceFolder, everyTime };
  }

  // "when I save this file" / "when I open this file"
  const thisFile = t.match(new RegExp(WHEN_PREFIX + String.raw`(open|save|edit)\s+this\s+file\b`));
  if (thisFile) {
    if (!currentFileName) {return null;}
    return { type: thisFile[1] === 'save' ? 'fileSave' : 'fileOpen', pattern: currentFileName, everyTime };
  }

  // "when I open a ts file", "every time I save .md files", "when I open the file"
  const extFile = t.match(
    new RegExp(WHEN_PREFIX + String.raw`(open|save|edit)\s+(?:(?:a|an|any|the)\s+)?\.?([\w-]+)?\s*files?\b`),
  );
  if (extFile) {
    const word = extFile[2];
    const type: EventType = extFile[1] === 'save' ? 'fileSave' : 'fileOpen';
    return { type, pattern: word && !NON_EXT_WORDS.test(word) ? `*.${word}` : undefined, everyTime };
  }

  // "when I open package.json", "every time I save .env", "when I open src/index.ts"
  const named = t.match(
    new RegExp(
      WHEN_PREFIX + String.raw`(open|save|edit)\s+(?:the\s+|my\s+)?([\w@./\\-]+\.[\w@-]+|\.[\w@-]+)\b`,
    ),
  );
  if (named) {
    return { type: named[1] === 'save' ? 'fileSave' : 'fileOpen', pattern: named[2].replace(/\\/g, '/'), everyTime };
  }

  // bare "when(ever) I save" — any file
  if (/\b(?:when(?:ever)?|every\s+time|each\s+time)\s+(?:i\s+)?save\b/.test(t)) {
    return { type: 'fileSave', everyTime };
  }

  return null;
}

const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
/**
 * A month name or its abbreviation, captured — and nothing longer: a loose
 * "jun[a-z]*" would read "2 junit tests" as June 2 and "mark 3" as March 3.
 */
const MONTH_RE = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?`;

// Time-of-day defaults for part-of-day words (24h clock).
const PART_DEFAULT: Record<string, number> = {
  morning: 9,
  afternoon: 14,
  evening: 18,
  night: 20,
  tonight: 20,
};

// Part-of-day words used after a clock time ("9 in the morning") imply am/pm.
// Values feed parseTimeOfDay, which expects am/pm-style suffixes.
const PART_AP: Record<string, string> = {
  morning: 'am',
  afternoon: 'pm',
  evening: 'pm',
  night: 'pm',
};

// Word numbers usable as counts in duration phrases ("in two hours").
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
};

/** Resolve a duration-phrase count: digits, word numbers, "a couple of", "a few", "a/an". */
function resolveCount(raw: string): number {
  const s = raw.trim();
  if (/couple/.test(s)) {return 2;}
  if (/few/.test(s)) {return 3;}
  if (/^[\d.]/.test(s)) {return parseFloat(s);}
  if (s === 'a' || s === 'an') {return 1;}
  return WORD_NUMBERS[s] ?? 0;
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function unitMs(u: string): number | null {
  if (/^(?:seconds?|secs?|s)$/.test(u)) {return 1_000;}
  if (/^(?:minutes?|mins?|m)$/.test(u)) {return MIN;}
  if (/^(?:hours?|hrs?|h)$/.test(u)) {return HOUR;}
  if (/^(?:days?|d)$/.test(u)) {return DAY;}
  if (/^(?:weeks?|w)$/.test(u)) {return 7 * DAY;}
  if (/^(?:months?|mo)$/.test(u)) {return 30 * DAY;} // approx, like the old behaviour
  return null;
}

function normalizeTriggerText(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?…]+$/, '');
}

function applyAmPm(h: number, ap?: string): number {
  if (ap?.startsWith('p') && h < 12) {return h + 12;}
  if (ap?.startsWith('a') && h === 12) {return 0;}
  return h;
}

/** Parse "9", "9am", "9:30 pm", "17:05", "noon", "midnight" to 24h hours/minutes. */
function parseTimeOfDay(raw: string): { h: number; m: number } | null {
  const s = raw.trim();
  if (s === 'noon') {return { h: 12, m: 0 };}
  if (s === 'midnight') {return { h: 0, m: 0 };}
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/);
  if (!m) {return null;}
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h > 23 || min > 59) {return null;}
  h = applyAmPm(h, m[3]);
  if (h > 23) {return null;}
  return { h, m: min };
}

function atTime(base: Date, h: number, m: number): Date {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

function weekdayIndex(word: string): number {
  const w = word.toLowerCase();
  if (w === 'tues') {return 2;}
  if (w === 'thurs') {return 4;}
  if (w === 'weds') {return 3;}
  for (let i = 0; i < 7; i++) {
    if (WEEKDAY_NAMES[i].startsWith(w) && w.length >= 3) {return i;}
  }
  return -1;
}

function monthIndex(word: string): number {
  const w = word.replace(/\.$/, '');
  const full = MONTH_NAMES.indexOf(w);
  if (full !== -1) {return full;}
  for (let i = 0; i < 12; i++) {
    if (MONTH_NAMES[i].startsWith(w) && w.length >= 3) {return i;}
  }
  return -1;
}

/**
 * Match an optional trailing time-of-day on a day phrase: "at 5", "9am",
 * "9:30 pm", "at 17:05", "at noon", "at midnight", "in the evening".
 * Group layout: [1]=hour [2]=min [3]=am/pm [4]=part-of-day word.
 * "noon"/"midnight" match without capturing — callers then fall back to
 * extractExplicitTime(), which understands them.
 */
const TRAILING_TOD = String.raw`(?:\s+(?:at\s+)?(?:noon|midnight|(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\s*o'?clock)?(?:\s*(?:in\s+the\s+)?(morning|afternoon|evening)|\s*at\s+(night))?))?`;

/** Extract "at 5pm" / "at 17:05" / "5:30pm" / "at noon" / "half past 5" / "9 in the morning" from a string, else null. */
function extractExplicitTime(t: string): { h: number; m: number } | null {
  const noon = t.match(/\b(?:at\s+)?(noon|midnight)\b/);
  if (noon) {return { h: noon[1] === 'noon' ? 12 : 0, m: 0 };}
  const half = t.match(/\b(?:a\s+)?half\s+past\s+(\d{1,2})\b(?:\s*(a\.?m\.?|p\.?m\.?))?/);
  if (half) {
    const tod = parseTimeOfDay(`${half[1]}:30${half[2] ?? ''}`);
    if (tod) {return tod;}
  }
  const quarter = t.match(
    /\b(?:a\s+)?quarter\s+(?:past\s+(\d{1,2})|to\s+(\d{1,2}))(?:\s*(a\.?m\.?|p\.?m\.?))?\b/,
  );
  if (quarter) {
    const past = quarter[1] !== undefined;
    const hRaw = parseInt((past ? quarter[1] : quarter[2]) as string, 10);
    const tod = parseTimeOfDay(`${past ? hRaw : hRaw - 1}:${past ? '15' : '45'}${quarter[3] ?? ''}`);
    if (tod) {return tod;}
  }
  const m =
    t.match(
      /\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\s*o'?clock)?(?:\s*(?:in\s+the\s+)?(morning|afternoon|evening)|\s*at\s+(night))?\b/,
    ) ??
    t.match(/\b(\d{1,2})(?::(\d{2}))\s*(a\.?m\.?|p\.?m\.?)?(?:\s*(?:in\s+the\s+)?(morning|afternoon|evening)|\s*at\s+(night))?\b/) ??
    t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/);
  if (!m) {return null;}
  const ap = (m[3] ?? m[4] ?? m[5]) as string | undefined;
  return parseTimeOfDay(`${m[1]}:${m[2] ?? '00'}${ap ? (PART_AP[ap] ?? ap) : ''}`);
}

/** Result date must land after `now`; roll forward a day when it's past. */
function rollForward(d: Date, now: Date): Date {
  if (d.getTime() <= now.getTime()) {d.setDate(d.getDate() + 1);}
  return d;
}

function parseAmPmGroup(h: string | undefined, m: string | undefined, ap: string | undefined): { h: number; m: number } | null {
  if (!h) {return null;}
  return parseTimeOfDay(`${h}:${m ?? '00'}${ap ?? ''}`);
}

/**
 * Read a TRAILING_TOD group triple off a day-phrase match. Guards against
 * stray bare numbers ("tomorrow 15 people") being read as times: without
 * am/pm, a plain "at", or explicit minutes, hours above 12 are rejected.
 * A trailing part-of-day word ("at 5 in the evening") supplies am/pm.
 */
function todFromGroups(m: RegExpMatchArray, i: number): { h: number; m: number } | null {
  const part = ((m[i + 3] ?? m[i + 4]) as string | undefined) ?? undefined;
  const ap = (m[i + 2] as string | undefined) ?? (part ? PART_AP[part] : undefined);
  const tod = parseAmPmGroup(m[i] as string, m[i + 1] as string | undefined, ap);
  if (!tod) {return null;}
  const hasAp = Boolean(m[i + 2]) || Boolean(part);
  const hasMinutes = Boolean(m[i + 1]);
  if (!hasAp && !hasMinutes && !/\b(?:at|@)\b/.test(m[0]) && tod.h > 12) {return null;}
  return tod;
}

/** Bare part-of-day word ("on friday evening", "tomorrow night") → default hour. */
function extractPartOfDay(t: string): { h: number; m: number } | null {
  const part = t.match(/\b(morning|afternoon|evening|night)\b/);
  if (!part) {return null;}
  return { h: PART_DEFAULT[part[1]], m: 0 };
}

/**
 * Best-effort local parsing of relative/absolute time trigger phrases,
 * searched anywhere in the text.
 * Returns an ISO8601 string or null if no phrase is recognised.
 *
 * Recognised examples:
 *   "in 2 hours", "in 30 minutes", "in 1 hour and 30 minutes", "in 1h30m",
 *   "in 90 seconds", "in half an hour", "in an hour and a half", "in a bit",
 *   "in two hours", "in a couple of hours", "in a few minutes", "in a fortnight",
 *   "20 minutes from now", "an hour from now"
 *   "today at 5pm", "later today", "this morning/afternoon/evening"
 *   "tonight", "tonight at 8pm", "at 5pm", "at 17:30", "at noon", "at midnight",
 *   "tomorrow at noon", "at 9 in the morning", "half past 5", "quarter to 6"
 *   "tomorrow", "tomorrow 9am", "tomorrow at 14:30", "tomorrow morning",
 *   "this time tomorrow", "first thing in the morning"
 *   "day after tomorrow"
 *   "on friday", "this fri", "by tuesday at 5pm", "next monday", "friday at 9am",
 *   "friday evening", "friday next week"
 *   "next week", "next week on wednesday at 10am", "next month", "this weekend"
 *   "end of day", "eod", "end of week", "eow", "end of month", "eom",
 *   "end of year", "eoy"
 *   "on the 15th", "by the 1st of next month"
 *   "jul 8", "july 8th 2026", "8 july at 3pm"
 *   "2026-07-08", "2026-07-08 14:30", "2026-07-08T14:30:00"
 */
export function parseReminderTimeLocal(text: string, now: Date = new Date()): string | null {
  const t = normalizeTriggerText(text);
  if (!t) {return null;}

  // Absolute ISO / date-time (optionally prefixed with "on")
  const abs = t.match(/\b(?:on\s+)?(\d{4}-\d{2}-\d{2})(?:[ t](\d{2}:\d{2}(?::\d{2})?))?\b/);
  if (abs) {
    const iso = abs[2] ? `${abs[1]}T${abs[2]}` : `${abs[1]}T09:00:00`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {return d.toISOString();}
  }

  // "july 8th", "jul 8 2026 at 3pm" / "8 july", "the 8th of july at 3pm"
  const md =
    t.match(
      new RegExp(
        String.raw`\b${MONTH_RE}\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?` +
          TRAILING_TOD +
          String.raw`\b`,
      ),
    ) ??
    t.match(
      new RegExp(
        String.raw`\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_RE}(?:\s*,?\s*(\d{4}))?` +
          TRAILING_TOD +
          String.raw`\b`,
      ),
    );
  if (md) {
    // First alternative: md[1]=month, md[2]=day. Second: md[1]=day, md[2]=month.
    const monthIsFirst = !/^\d/.test(md[1]);
    const month = monthIndex((monthIsFirst ? md[1] : md[2]) as string);
    const day = parseInt((monthIsFirst ? md[2] : md[1]) as string, 10);
    if (month !== -1 && day >= 1 && day <= 31) {
      const year = md[3] ? parseInt(md[3], 10) : now.getFullYear();
      let d = new Date(year, month, day);
      if (!md[3] && d.getTime() < now.getTime() - DAY) {d = new Date(year + 1, month, day);}
      const tod = todFromGroups(md, 4);
      // No explicit time → default to 9:00 like the ISO date path.
      d.setHours(tod ? tod.h : 9, tod ? tod.m : 0, 0, 0);
      if (!isNaN(d.getTime())) {return rollForward(d, now).toISOString();}
    }
  }

  // "on the 15th", "by the 1st of next month" — day of month, no month name
  const dom = t.match(
    new RegExp(
      String.raw`\b(?:on|by|before|due)\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:\s+of\s+(this|next)\s+month)?` +
        TRAILING_TOD +
        String.raw`\b`,
    ),
  );
  if (dom) {
    const day = parseInt(dom[1], 10);
    if (day >= 1 && day <= 31) {
      // Groups: [1]=day [2]=this/next, then TRAILING_TOD's [3]=hour [4]=min [5]=am/pm [6]=part.
      const tod = todFromGroups(dom, 3) ?? extractExplicitTime(t);
      const nextMonth = dom[2] === 'next';
      const mk = (mo: number): Date => {
        const d = new Date(now.getFullYear(), mo, day);
        d.setHours(tod ? tod.h : 9, tod ? tod.m : 0, 0, 0);
        return d;
      };
      let d = mk(now.getMonth() + (nextMonth ? 1 : 0));
      // "on the 15th" with no month: still ahead this month, else next month.
      if (!nextMonth && d.getTime() <= now.getTime()) {d = mk(now.getMonth() + 1);}
      if (!isNaN(d.getTime())) {return d.toISOString();}
    }
  }

  // ── Relative durations ─────────────────────────────────────────────────────

  // Count token: digits, common word numbers, "a couple of", "a few".
  // ("a"/"an" alone are handled by the wordy branch below so "in an hour
  // and a half" keeps its compound meaning.)
  const COUNT = String.raw`(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|a\s+couple\s+of|couple\s+of|a\s+few|few)`;
  const UNITS = String.raw`(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?)`;

  // "in 2 hours", "in two hours", "in 1 hour and 30 minutes", "in a couple of hours"
  const rel = t.match(
    new RegExp(
      String.raw`\bin\s+` +
        COUNT +
        String.raw`\s*` +
        UNITS +
        String.raw`(?:\s*(?:and|,)?\s*` +
        COUNT +
        String.raw`\s*` +
        UNITS +
        String.raw`)?\b`,
    ),
  );
  if (rel) {
    const ms1 = resolveCount(rel[1]) * (unitMs(rel[2]) ?? 0);
    const ms2 = rel[3] ? resolveCount(rel[3]) * (unitMs(rel[4] ?? '') ?? 0) : 0;
    return new Date(now.getTime() + ms1 + ms2).toISOString();
  }

  // Compact "in 1h30m", "in 90s"
  const compact = t.match(/\bin\s+((?:\d+(?:\.\d+)?[smhdw])+)\b/);
  if (compact) {
    let ms = 0;
    for (const part of compact[1].matchAll(/(\d+(?:\.\d+)?)([smhdw])/g)) {
      ms += parseFloat(part[1]) * (unitMs(part[2]) ?? 0);
    }
    if (ms > 0) {return new Date(now.getTime() + ms).toISOString();}
  }

  // "in an hour", "in half an hour", "in an hour and a half"
  const words = t.match(
    /\bin\s+(half\s+an?|an?)\s*(second|minute|hour|day|week)\b(?:\s*and\s*a\s*half\b)?/,
  );
  if (words) {
    let n = 1;
    if (words[1].startsWith('half')) {n = 0.5;}
    if (/\band\s+a\s+half\b/.test(words[0])) {n += 0.5;}
    const ms = n * (unitMs(words[2] + 's') ?? 0);
    return new Date(now.getTime() + ms).toISOString();
  }

  // "in a minute", "in a sec", "in a moment", "in a bit", "in a while"
  const vague = t.match(/\bin\s+a\s+(second|sec|minute|min|moment|bit|while)\b/);
  if (vague) {
    const ms =
      vague[1] === 'second' || vague[1] === 'sec'
        ? 1_000
        : vague[1] === 'bit'
          ? 30 * MIN
          : vague[1] === 'while'
            ? HOUR
            : MIN;
    return new Date(now.getTime() + ms).toISOString();
  }

  // "20 minutes from now", "an hour from now", "two days from now"
  const fromNow = t.match(
    new RegExp(
      String.raw`\b(a|an|` + COUNT + String.raw`)\s*` + UNITS + String.raw`\s+from\s+now\b`,
    ),
  );
  if (fromNow) {
    // Groups: [1]=count (outer alt) [2]=count (COUNT's own group) [3]=unit.
    return new Date(now.getTime() + resolveCount(fromNow[1]) * (unitMs(fromNow[3]) ?? 0)).toISOString();
  }

  // "in a fortnight"
  if (/\bin\s+a\s+fortnight\b/.test(t)) {
    return new Date(now.getTime() + 14 * DAY).toISOString();
  }

  // ── Day phrases ────────────────────────────────────────────────────────────

  // "this time tomorrow" / "same time tomorrow" — tomorrow, same clock time
  if (/\b(?:this|same)\s+time\s+tomorrow\b/.test(t)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return atTime(d, now.getHours(), now.getMinutes()).toISOString();
  }

  // "first thing in the morning" — next 9:00 ("first thing tomorrow" is
  // handled by the tomorrow branch below, which also defaults to 9:00)
  if (/\bfirst\s+thing\s+in\s+the\s+morning\b/.test(t)) {
    return rollForward(atTime(now, 9, 0), now).toISOString();
  }

  // "day after tomorrow [at 5pm]"
  const dat = t.match(
    new RegExp(String.raw`\bday\s+after\s+tomorrow` + TRAILING_TOD + String.raw`\b`),
  );
  if (dat) {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    // Time may trail the phrase ("at 5") or precede it ("at 5, day after …").
    const tod = todFromGroups(dat, 1) ?? extractExplicitTime(t) ?? extractPartOfDay(t);
    return rollForward(tod ? atTime(d, tod.h, tod.m) : atTime(d, 9, 0), now).toISOString();
  }

  // "tomorrow morning/afternoon/evening/night [at 5]"
  const tomPart = t.match(
    new RegExp(
      String.raw`\btomorrow\s+(morning|afternoon|evening|night)` + TRAILING_TOD + String.raw`\b`,
    ),
  );
  if (tomPart) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    const explicit = todFromGroups(tomPart, 2);
    const h = explicit ? explicit.h : PART_DEFAULT[tomPart[1]];
    return atTime(d, h, explicit ? explicit.m : 0).toISOString();
  }

  // "tomorrow [at 9am]" (bare tomorrow defaults to 9:00, as before)
  const tom = t.match(
    new RegExp(String.raw`\btomorrow` + TRAILING_TOD + String.raw`\b`),
  );
  if (tom) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    const tod = todFromGroups(tom, 1) ?? extractExplicitTime(t) ?? extractPartOfDay(t);
    return atTime(d, tod ? tod.h : 9, tod ? tod.m : 0).toISOString();
  }

  // "tonight [at 8pm]" (bare tonight defaults to 20:00)
  const tonight = t.match(
    new RegExp(String.raw`\btonight` + TRAILING_TOD + String.raw`\b`),
  );
  if (tonight) {
    const d = new Date(now);
    const tod = todFromGroups(tonight, 1) ?? extractExplicitTime(t) ?? extractPartOfDay(t);
    return rollForward(atTime(d, tod ? tod.h : 20, tod ? tod.m : 0), now).toISOString();
  }

  // "next week on wednesday at 10am" / "next week [on <weekday>]"
  const nextWeekDay = t.match(
    new RegExp(
      String.raw`\bnext\s+week(?:\s+on\s+)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thurs|fri|sat)` +
        TRAILING_TOD +
        String.raw`\b`,
    ),
  );
  if (nextWeekDay) {
    const target = weekdayIndex(nextWeekDay[1]);
    if (target !== -1) {
      const tod =
        todFromGroups(nextWeekDay, 2) ?? extractExplicitTime(t) ?? extractPartOfDay(t);
      let d = new Date(now);
      do {
        d.setDate(d.getDate() + 1);
      } while (d.getDay() !== 1);
      d.setDate(d.getDate() + ((target - 1 + 7) % 7));
      d = tod ? atTime(d, tod.h, tod.m) : atTime(d, 9, 0);
      return d.toISOString();
    }
  }

  // "friday next week" — weekday named before "next week"
  const revNextWeek = t.match(
    new RegExp(
      String.raw`\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thurs|fri|sat)\s+next\s+week` +
        TRAILING_TOD +
        String.raw`\b`,
    ),
  );
  if (revNextWeek) {
    const target = weekdayIndex(revNextWeek[1]);
    if (target !== -1) {
      const tod =
        todFromGroups(revNextWeek, 2) ?? extractExplicitTime(t) ?? extractPartOfDay(t);
      // Monday of next week, then advance to the target day.
      let d = new Date(now);
      do {
        d.setDate(d.getDate() + 1);
      } while (d.getDay() !== 1);
      d.setDate(d.getDate() + ((target - 1 + 7) % 7));
      return (tod ? atTime(d, tod.h, tod.m) : atTime(d, 9, 0)).toISOString();
    }
  }
  if (/\bnext\s+week\b/.test(t)) {
    const d = new Date(now);
    do {
      d.setDate(d.getDate() + 1);
    } while (d.getDay() !== 1);
    return atTime(d, 9, 0).toISOString();
  }

  // "next month"
  if (/\bnext\s+month\b/.test(t)) {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
    return atTime(d, 9, 0).toISOString();
  }

  // "next monday [at 9am]" — next occurrence; same-day rolls a week out
  const next = t.match(
    new RegExp(
      String.raw`\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thurs|fri|sat)` +
        TRAILING_TOD +
        String.raw`\b`,
    ),
  );
  if (next) {
    const target = weekdayIndex(next[1]);
    if (target !== -1) {
      const d = new Date(now);
      let diff = (target - d.getDay() + 7) % 7;
      if (diff === 0) {diff = 7;}
      d.setDate(d.getDate() + diff);
      const tod = todFromGroups(next, 2) ?? extractExplicitTime(t) ?? extractPartOfDay(t);
      return atTime(d, tod ? tod.h : 9, tod ? tod.m : 0).toISOString();
    }
  }

  // "<weekday>" with a preposition: "on friday", "this fri", "by tuesday",
  // "due friday", "before saturday", plus optional time.
  const onDay = t.match(
    new RegExp(
      String.raw`\b(?:on|this|by|before|until|due(?:\s+on)?)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thurs|fri|sat)` +
        TRAILING_TOD +
        String.raw`\b`,
    ),
  );
  if (onDay) {
    const target = weekdayIndex(onDay[1]);
    if (target !== -1) {
      // Same-day references keep today only when the time is still ahead;
      // otherwise roll to next week. Time may trail ("on fri at 5") or
      // precede ("at 5 on fri") the weekday.
      const tod =
        todFromGroups(onDay, 2) ?? extractExplicitTime(t) ?? extractPartOfDay(t);
      const d = atTime(now, tod ? tod.h : 9, tod ? tod.m : 0);
      let diff = (target - d.getDay() + 7) % 7;
      if (diff === 0 && d.getTime() <= now.getTime()) {diff = 7;}
      d.setDate(d.getDate() + diff);
      return d.toISOString();
    }
  }

  // "this weekend [at 2pm]", "over the weekend [at 2pm]"
  const weekend = t.match(
    new RegExp(String.raw`\b(?:this|over\s+the)\s+weekend` + TRAILING_TOD + String.raw`\b`),
  );
  if (weekend) {
    const tod = todFromGroups(weekend, 1);
    let d = new Date(now);
    // Next Saturday; a Sunday reference means today.
    const diff = d.getDay() === 0 ? 0 : (6 - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + diff);
    d = atTime(d, tod ? tod.h : 10, tod ? tod.m : 0);
    return rollForward(d, now).toISOString();
  }

  // "today at 5pm", "later today", "this morning/afternoon/evening/night"
  const todayAt = t.match(
    new RegExp(String.raw`\b(?:today|later\s+today)` + TRAILING_TOD + String.raw`\b`),
  );
  if (todayAt) {
    // "today" phrases stay on today. noon/midnight match without capturing,
    // hence the extractExplicitTime fallback.
    const tod = todFromGroups(todayAt, 1) ?? extractExplicitTime(todayAt[0]);
    if (!tod) {
      // Bare "today" / "later today": 9:00 if still ahead, else a few hours
      // out — but not past the evening (and never tomorrow)
      const nine = atTime(now, 9, 0);
      if (nine.getTime() > now.getTime()) {return nine.toISOString();}
      const evening = atTime(now, 22, 0);
      const later = Math.min(now.getTime() + 3 * HOUR, Math.max(evening.getTime(), now.getTime() + HOUR / 2));
      return new Date(later).toISOString();
    }
    let candidate = atTime(now, tod.h, tod.m);
    // Like bare "at 5": an hour without an am/pm hint that has passed is PM
    const hinted = /\d\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])|\b(?:morning|afternoon|evening|night)\b/.test(
      todayAt[0],
    );
    if (!hinted && tod.h < 12 && candidate.getTime() <= now.getTime()) {
      const pm = atTime(now, tod.h + 12, tod.m);
      if (pm.getTime() > now.getTime()) {candidate = pm;}
    }
    return rollForward(candidate, now).toISOString();
  }
  const thisPart = t.match(
    new RegExp(
      String.raw`\bthis\s+(morning|afternoon|evening|night)` + TRAILING_TOD + String.raw`\b`,
    ),
  );
  if (thisPart) {
    const explicit = todFromGroups(thisPart, 2);
    const h = explicit ? explicit.h : PART_DEFAULT[thisPart[1]];
    const d = new Date(now);
    return rollForward(atTime(d, h, explicit ? explicit.m : 0), now).toISOString();
  }

  // "end of day" / "eod" → today 18:00; "end of week" / "eow" → friday 17:00
  if (/\b(?:end\s+of\s+(?:the\s+)?day|eod)\b/.test(t)) {
    return rollForward(atTime(now, 18, 0), now).toISOString();
  }
  if (/\b(?:end\s+of\s+(?:the\s+)?week|eow)\b/.test(t)) {
    const d = new Date(now);
    let diff = (5 - d.getDay() + 7) % 7;
    if (diff === 0 && atTime(d, 17, 0).getTime() <= now.getTime()) {diff = 7;}
    d.setDate(d.getDate() + diff);
    return atTime(d, 17, 0).toISOString();
  }

  // "end of month" / "eom" → last day of the month 17:00;
  // "end of year" / "eoy" → Dec 31 17:00
  if (/\b(?:end\s+of\s+(?:the\s+)?month|eom)\b/.test(t)) {
    const d = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return rollForward(atTime(d, 17, 0), now).toISOString();
  }
  if (/\b(?:end\s+of\s+(?:the\s+)?year|eoy)\b/.test(t)) {
    const d = new Date(now.getFullYear(), 11, 31);
    return rollForward(atTime(d, 17, 0), now).toISOString();
  }

  // "at noon", "at midnight" (next occurrence)
  const noon = t.match(/\b(?:at\s+)?(noon|midnight)\b/);
  if (noon) {
    const d = new Date(now);
    return rollForward(atTime(d, noon[1] === 'noon' ? 12 : 0, 0), now).toISOString();
  }

  // "at 5pm" / "at 17:30" / "at 9 in the morning" (no day) — today if still
  // ahead, else tomorrow
  const atTimeM = t.match(
    /\b(?:at|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\s*o'?clock)?(?:\s*(?:in\s+the\s+)?(morning|afternoon|evening)|\s*at\s+(night))?\b/,
  );
  if (atTimeM) {
    const ap = (atTimeM[3] ?? atTimeM[4] ?? atTimeM[5]) as string | undefined;
    const base = parseAmPmGroup(atTimeM[1], atTimeM[2], ap ? (PART_AP[ap] ?? ap) : undefined);
    if (base) {
      const d = new Date(now);
      let candidate = atTime(d, base.h, base.m);
      // No am/pm hint given and the hour is past? Try the PM reading, then tomorrow.
      if (!ap && candidate.getTime() <= now.getTime() && base.h <= 12) {
        const pm = atTime(d, base.h === 12 ? 12 : base.h + 12, base.m);
        if (pm.getTime() > now.getTime()) {candidate = pm;}
      }
      return rollForward(candidate, now).toISOString();
    }
  }

  // Last resort: any other recognisable clock time — "9:30", "11pm", "half past 5"
  const anyTod = extractExplicitTime(t);
  if (anyTod) {
    const am = atTime(now, anyTod.h, anyTod.m);
    // Like the "at N" branch: an hour given without an am/pm or part-of-day
    // hint picks its next occurrence, trying the PM reading first.
    const hinted =
      /\b(?:a\.?m\.?|p\.?m\.?)\b/.test(t) ||
      /\b(?:in\s+the\s+)?(?:morning|afternoon|evening)\b|\bat\s+night\b/.test(t);
    if (!hinted && anyTod.h <= 12 && am.getTime() <= now.getTime()) {
      const pm = atTime(now, anyTod.h === 12 ? 12 : anyTod.h + 12, anyTod.m);
      if (pm.getTime() > now.getTime()) {return pm.toISOString();}
    }
    return rollForward(am, now).toISOString();
  }

  return null;
}

// ── Recurrence triggers ("every ...") ────────────────────────────────────────

function hhmm(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function intervalUnit(u: string): RecurRule['unit'] {
  if (/^mo/.test(u)) {return 'month';}
  if (/^m/.test(u)) {return 'minute';}
  if (/^h/.test(u)) {return 'hour';}
  if (/^w/.test(u)) {return 'week';}
  return 'day';
}

/** Extract an explicit "at 9am"-style time from a recurrence phrase. */
function recurTime(t: string, fallbackH: number): string {
  const explicit = extractExplicitTime(t);
  return explicit ? hhmm(explicit.h, explicit.m) : hhmm(fallbackH, 0);
}

/**
 * Detect recurring-trigger phrases and return the rule, or null.
 *
 * Recognised examples:
 *   "every day at 9am", "daily", "daily at 8:30"
 *   "every morning", "every afternoon", "every evening", "every night"
 *   "every monday [at 10]", "every monday and wednesday at 6pm",
 *   "every mon, wed, fri", "weekly on friday at 5pm", "every week on mon"
 *   "every weekday at 9am", "every weekend"
 *   "every 2 hours", "every 30 minutes", "every other day",
 *   "every hour", "hourly", "every half hour", "every quarter hour",
 *   "biweekly", "fortnightly", "quarterly"
 *   "every month", "monthly", "every month on the 15th", "every 15th of the month",
 *   "every year", "yearly", "every year on july 8", "annually on 8 july"
 */
export function parseRecurrence(text: string, now: Date = new Date()): RecurRule | null {
  const t = normalizeTriggerText(text);
  if (!t) {return null;}

  const WD = String.raw`(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|weds|thu|thurs|fri|sat)`;

  // "every 2 hours", "every 30 minutes"
  let m = t.match(
    /\b(?:every|each)\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?)\b/,
  );
  if (m) {
    const n = parseInt(m[1], 10);
    // Rules have minute granularity — "every 30 seconds" is every minute, not
    // (as intervalUnit's fallback would make it) every 30 days
    if (/^s/.test(m[2])) {
      return { type: 'interval', interval: Math.max(1, Math.ceil(n / 60)), unit: 'minute' };
    }
    return { type: 'interval', interval: n, unit: intervalUnit(m[2]) };
  }

  // "every other day/week/month"
  m = t.match(/\b(?:every|each)\s+other\s+(day|week|month)\b/);
  if (m) {return { type: 'interval', interval: 2, unit: intervalUnit(m[1]) };}

  // "every hour", "hourly", "every half hour", "every quarter hour"
  if (/\bevery\s+half\s+hours?\b/.test(t)) {
    return { type: 'interval', interval: 30, unit: 'minute' };
  }
  if (/\bevery\s+quarter\s+hours?\b/.test(t)) {
    return { type: 'interval', interval: 15, unit: 'minute' };
  }
  if (/\b(?:every|each)\s+hours?\b/.test(t) || /\bhourly\b/.test(t)) {
    return { type: 'interval', interval: 1, unit: 'hour' };
  }

  // "biweekly", "fortnightly" → every 2 weeks; "quarterly", "every quarter" → every 3 months
  if (/\b(?:bi[- ]?weekly|fortnightly)\b/.test(t)) {
    return { type: 'interval', interval: 2, unit: 'week' };
  }
  if (/\b(?:quarterly|every\s+quarters?)\b/.test(t)) {
    return { type: 'interval', interval: 3, unit: 'month' };
  }

  // "every weekday [at 9am]"
  if (/\b(?:every|each)\s+weekdays?\b/.test(t)) {
    return { type: 'weekdays', time: recurTime(t, 9) };
  }

  // "every weekend [at 10am]"
  if (/\b(?:every|each)\s+weekends?\b/.test(t)) {
    return { type: 'weekends', time: recurTime(t, 10) };
  }

  // "every monday and wednesday [at 6pm]", "every mon, wed, fri",
  // "weekly on monday and friday" — multiple weekdays in one rule
  m = t.match(
    new RegExp(
      String.raw`\b(?:weekly\s+on\s+|(?:every|each)(?:\s+week)?\s+(?:on)?\s*)` +
        String.raw`(` +
        WD +
        String.raw`)((?:\s*(?:,|and|&)\s*(` +
        WD +
        String.raw`))+)\b`,
    ),
  );
  if (m) {
    const days = [weekdayIndex(m[1])];
    for (const extra of m[2].matchAll(new RegExp(String.raw`(?:,|and|&)\s*(` + WD + String.raw`)`, 'g'))) {
      const d = weekdayIndex(extra[1]);
      if (d !== -1) {days.push(d);}
    }
    const uniq = Array.from(new Set(days)).sort((a, b) => a - b);
    if (uniq.length > 1 && !uniq.includes(-1)) {
      return { type: 'weekly', days: uniq, time: recurTime(t, 9) };
    }
  }

  // "every (week )on friday", "every friday", "weekly on friday"
  m = t.match(new RegExp(String.raw`\b(?:every|each)(?:\s+week)?\s+on\s+(` + WD + String.raw`)\b`));
  if (!m) {m = t.match(new RegExp(String.raw`\b(?:every|each)\s+(` + WD + String.raw`)\b`));}
  if (m) {
    const day = weekdayIndex(m[1]);
    if (day !== -1) {return { type: 'weekly', day, time: recurTime(t, 9) };}
  }
  m = t.match(new RegExp(String.raw`\bweekly(?:\s+on\s+(` + WD + String.raw`))?\b`));
  if (m) {
    return { type: 'weekly', day: m[1] ? weekdayIndex(m[1]) : now.getDay(), time: recurTime(t, 9) };
  }

  // "every day", "daily", "every morning/afternoon/evening/night"
  m = t.match(/\b(?:every|each)\s+(day|morning|afternoon|evening|night)\b/);
  if (m) {
    return {
      type: 'daily',
      time: recurTime(t, PART_DEFAULT[m[1]] ?? 9),
    };
  }
  if (/\bdaily\b/.test(t)) {return { type: 'daily', time: recurTime(t, 9) };}

  // "every month on the 15th", "monthly on the 15th", "every 15th of the month"
  // (the ordinal suffix keeps "every 2 months" on the interval path above)
  m =
    t.match(/\b(?:every|each)\s+months?\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/) ??
    t.match(/\bmonthly\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\b/) ??
    t.match(/\b(?:every|each)\s+(\d{1,2})(?:st|nd|rd|th)\s+of\s+(?:the\s+)?months?\b/);
  if (m) {
    const day = parseInt(m[1], 10);
    if (day >= 1 && day <= 31) {
      return { type: 'monthly', day, time: recurTime(t, 9) };
    }
  }

  // "every month", "monthly"
  if (/\b(?:every|each)\s+months?\b/.test(t) || /\bmonthly\b/.test(t)) {
    return { type: 'monthly', day: now.getDate(), time: recurTime(t, 9) };
  }

  // "every year on july 8", "annually on 8 july", "yearly on jul 8th at 9am"
  m = t.match(
    new RegExp(
      String.raw`\b(?:every\s+years?|yearly|annually)\s+on\s+(?:the\s+)?` +
        String.raw`(?:${MONTH_RE}\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_RE})\b`,
    ),
  );
  if (m) {
    const month = monthIndex((m[1] ?? m[4]) as string);
    const day = parseInt((m[2] ?? m[3]) as string, 10);
    if (month !== -1 && day >= 1 && day <= 31) {
      return { type: 'yearly', month, day, time: recurTime(t, 9) };
    }
  }

  // "every year", "yearly", "annually"
  if (/\b(?:every|each)\s+years?\b/.test(t) || /\byearly\b/.test(t) || /\bannually\b/.test(t)) {
    return { type: 'yearly', time: recurTime(t, 9) };
  }

  return null;
}

/** Next occurrence strictly after `after`, or null if the rule is malformed. */
export function computeNextOccurrence(rule: RecurRule, after: Date): Date | null {
  const [hStr, mStr] = (rule.time ?? '09:00').split(':');
  const h = parseInt(hStr, 10) || 0;
  const m = parseInt(mStr, 10) || 0;

  const nextMatchingDay = (from: Date, matches: (d: Date) => boolean): Date => {
    const d = atTime(from, h, m);
    while (!matches(d) || d.getTime() <= after.getTime()) {d.setDate(d.getDate() + 1);}
    return d;
  };

  switch (rule.type) {
    case 'daily':
      return nextMatchingDay(after, () => true);
    case 'weekdays':
      return nextMatchingDay(after, (d) => d.getDay() >= 1 && d.getDay() <= 5);
    case 'weekends':
      return nextMatchingDay(after, (d) => d.getDay() === 0 || d.getDay() === 6);
    case 'weekly': {
      const targetDays =
        rule.days && rule.days.length
          ? rule.days
          : rule.day !== undefined
            ? [rule.day]
            : null;
      if (!targetDays) {return null;}
      return nextMatchingDay(after, (d) => targetDays.includes(d.getDay()));
    }
    case 'monthly': {
      const day = Math.min(Math.max(rule.day ?? after.getDate(), 1), 31);
      const mk = (y: number, mo: number): Date => {
        const last = new Date(y, mo + 1, 0).getDate();
        const d = new Date(y, mo, Math.min(day, last));
        d.setHours(h, m, 0, 0);
        return d;
      };
      let d = mk(after.getFullYear(), after.getMonth());
      while (d.getTime() <= after.getTime()) {
        const n = new Date(d.getFullYear(), d.getMonth() + 1, 1);
        d = mk(n.getFullYear(), n.getMonth());
      }
      return d;
    }
    case 'yearly': {
      // Anchored to a date ("every year on july 8"): next occurrence of that
      // month/day; day is clamped for Feb 29 in non-leap years.
      if (rule.month !== undefined && rule.day !== undefined) {
        const mk = (y: number): Date => {
          const last = new Date(y, rule.month! + 1, 0).getDate();
          const d = new Date(y, rule.month!, Math.min(rule.day!, last));
          d.setHours(h, m, 0, 0);
          return d;
        };
        let d = mk(after.getFullYear());
        if (d.getTime() <= after.getTime()) {d = mk(after.getFullYear() + 1);}
        return d;
      }
      const d = new Date(after);
      d.setHours(h, m, 0, 0);
      d.setFullYear(d.getFullYear() + 1);
      return d;
    }
    case 'interval': {
      const unit = rule.unit ?? 'day';
      const n = Math.max(rule.interval ?? 1, 1);
      if (unit === 'month') {
        const d = new Date(after);
        d.setMonth(d.getMonth() + n);
        return d;
      }
      const ms = unit === 'minute' ? MIN : unit === 'hour' ? HOUR : unit === 'week' ? 7 * DAY : DAY;
      return new Date(after.getTime() + n * ms);
    }
  }
}

function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem10 === 1 && rem100 !== 11) {return `${n}st`;}
  if (rem10 === 2 && rem100 !== 12) {return `${n}nd`;}
  if (rem10 === 3 && rem100 !== 13) {return `${n}rd`;}
  return `${n}th`;
}

/** Human-readable recurrence for UI labels and notifications. */
export function describeRecurrence(rule: RecurRule): string {
  const time = rule.time;
  const at = time
    ? ' at ' +
      (() => {
        const [hStr, mStr] = time.split(':');
        let h = parseInt(hStr, 10);
        const m = parseInt(mStr, 10);
        const ap = h < 12 ? 'am' : 'pm';
        if (h === 0) {h = 12;}
        else if (h > 12) {h -= 12;}
        return `${h}:${String(m).padStart(2, '0')} ${ap}`;
      })()
    : '';
  switch (rule.type) {
    case 'daily':
      return `daily${at}`;
    case 'weekdays':
      return `every weekday${at}`;
    case 'weekends':
      return `every weekend${at}`;
    case 'weekly': {
      if (rule.days && rule.days.length > 1) {
        const names = rule.days.map((d) => WEEKDAY_NAMES[d]);
        const list =
          names.length === 2
            ? names.join(' and ')
            : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
        return `every ${list}${at}`;
      }
      return rule.day !== undefined
        ? `every ${WEEKDAY_NAMES[rule.day]}${at}`
        : `every week${at}`;
    }
    case 'monthly':
      return rule.day !== undefined ? `every month on the ${ordinal(rule.day)}${at}` : `every month${at}`;
    case 'yearly':
      return rule.month !== undefined && rule.day !== undefined
        ? `every year on ${MONTH_NAMES[rule.month]} ${rule.day}${at}`
        : `every year${at}`;
    case 'interval':
      return `every ${rule.interval ?? 1} ${rule.unit}${(rule.interval ?? 1) > 1 ? 's' : ''}`;
  }
}

/**
 * Parse both a one-shot time trigger and a recurrence trigger from free text.
 * A recurrence wins and yields its first future occurrence as `dueAt`.
 */
export function parseReminderTrigger(text: string, now: Date = new Date()): ReminderTrigger {
  const recur = parseRecurrence(text, now);
  if (recur) {
    const next = computeNextOccurrence(recur, now);
    return { dueAt: next ? next.toISOString() : null, recur };
  }
  return { dueAt: parseReminderTimeLocal(text, now), recur: null };
}
