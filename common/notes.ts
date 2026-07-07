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
  // task-specific
  priority?: TaskPriority;
  done?: boolean;
  // reminder-specific
  dueAt?: string; // ISO8601
  fired?: boolean;
  missed?: boolean;
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
    if (entry) out.push({ entry, score: r.score });
  }
  return out;
}

// ── Reminder time parsing (local regex, LLM fallback handled in src/notes.ts) ──

/**
 * Best-effort local parsing of common relative/absolute time phrases.
 * Returns an ISO8601 string or null if the phrase isn't recognised.
 *
 * Recognised examples:
 *   "in 2 hours", "in 30 minutes", "in 10 mins", "in 2 days"
 *   "tomorrow", "tomorrow 9am", "tomorrow at 14:30"
 *   "tonight at 8pm"
 *   "next monday", "next friday 9am"
 *   "2026-07-08", "2026-07-08 14:30", "2026-07-08T14:30:00"
 */
export function parseReminderTimeLocal(text: string, now: Date = new Date()): string | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;

  // "in N <unit>"
  const rel = t.match(
    /^in\s+(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|h(?:ours?|rs?)?|days?|weeks?|months?)\b/i,
  );
  if (rel) {
    const n = parseFloat(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith('min')
      ? n * 60_000
      : unit.startsWith('h')
        ? n * 3_600_000
        : unit.startsWith('day')
          ? n * 86_400_000
          : unit.startsWith('week')
            ? n * 7 * 86_400_000
            : n * 30 * 86_400_000; // month (approx)
    return new Date(now.getTime() + ms).toISOString();
  }

  // "tomorrow [at] [h](:mm) [am|pm]"
  const tom = t.match(/^tomorrow(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (tom) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    if (tom[1]) {
      let h = parseInt(tom[1], 10);
      const m = tom[2] ? parseInt(tom[2], 10) : 0;
      const ap = tom[3]?.toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      d.setHours(h, m, 0, 0);
    } else {
      d.setHours(9, 0, 0, 0);
    }
    return d.toISOString();
  }

  // "tonight at [h](:mm) [am|pm]"
  const tonight = t.match(/^tonight\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (tonight) {
    const d = new Date(now);
    let h = parseInt(tonight[1], 10);
    const m = tonight[2] ? parseInt(tonight[2], 10) : 0;
    const ap = tonight[3]?.toLowerCase() ?? 'pm';
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  }

  // "next <weekday> [at [h](:mm) [am|pm]]"
  const next = t.match(/^next\s+(\w+)(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i);
  if (next) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const target = days.indexOf(next[1].toLowerCase());
    if (target !== -1) {
      const d = new Date(now);
      let diff = (target - d.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      d.setDate(d.getDate() + diff);
      if (next[2]) {
        let h = parseInt(next[2], 10);
        const m = next[3] ? parseInt(next[3], 10) : 0;
        const ap = next[4]?.toLowerCase();
        if (ap === 'pm' && h < 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
        d.setHours(h, m, 0, 0);
      } else {
        d.setHours(9, 0, 0, 0);
      }
      return d.toISOString();
    }
  }

  // Absolute ISO / date-time
  const abs = t.match(/^(\d{4}-\d{2}-\d{2})(?:[ t](\d{2}:\d{2}(?::\d{2})?))?$/i);
  if (abs) {
    const iso = abs[2] ? `${abs[1]}T${abs[2]}` : `${abs[1]}T09:00:00`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  return null;
}
