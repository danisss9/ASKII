import assert from 'assert';
import test from 'node:test';
import { parseReminderTimeLocal, searchNotes, type NoteEntry } from '../shared/notes';

const NOW = new Date('2026-08-14T10:00:00Z');

test('parseReminderTimeLocal parses "in N minutes/hours/days"', () => {
  const m = parseReminderTimeLocal('in 30 minutes', NOW);
  assert.ok(m, 'minutes should parse');
  assert.strictEqual(m, new Date('2026-08-14T10:30:00Z').toISOString());

  const h = parseReminderTimeLocal('in 2 hours', NOW);
  assert.strictEqual(h, new Date('2026-08-14T12:00:00Z').toISOString());

  const d = parseReminderTimeLocal('in 1 day', NOW);
  assert.strictEqual(d, new Date('2026-08-15T10:00:00Z').toISOString());
});

test('parseReminderTimeLocal parses absolute ISO date-times (local interpretation)', () => {
  // Naive date-times are interpreted in the runtime's local timezone (by design),
  // then returned as an ISO8601 UTC string — so the expected value mirrors that.
  const expected = new Date(2026, 8, 1, 14, 30).toISOString();
  assert.strictEqual(parseReminderTimeLocal('2026-09-01 14:30', NOW), expected);
});

test('parseReminderTimeLocal returns null for unrecognised phrases', () => {
  assert.strictEqual(parseReminderTimeLocal('sometime soon', NOW), null);
  assert.strictEqual(parseReminderTimeLocal('', NOW), null);
});

test('searchNotes empty query returns most-recent first', () => {
  const notes: NoteEntry[] = [
    { id: '1', kind: 'note', text: 'oldest', tags: [], createdAt: '2026-01-01T00:00:00Z' },
    { id: '2', kind: 'note', text: 'newest', tags: [], createdAt: '2026-08-01T00:00:00Z' },
  ];
  const results = searchNotes('', notes);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].entry.id, '2');
});

test('searchNotes full-text query ranks matching notes and boosts tags', () => {
  const notes: NoteEntry[] = [
    { id: 'a', kind: 'note', text: 'rate limit notes', tags: ['api'], createdAt: '2026-01-02T00:00:00Z' },
    { id: 'b', kind: 'note', text: 'unrelated text', tags: [], createdAt: '2026-01-01T00:00:00Z' },
    { id: 'c', kind: 'note', text: 'api gateway', tags: ['network'], createdAt: '2026-01-03T00:00:00Z' },
  ];
  const results = searchNotes('api', notes);
  assert.ok(results.length >= 2, 'both api-related notes should match');
  assert.ok(
    results.every((r) => r.entry.id === 'a' || r.entry.id === 'c'),
    'only api-tagged/text notes match',
  );
});