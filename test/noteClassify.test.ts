import assert from 'assert';
import { suite, test } from 'mocha';
import { buildNoteEntry, classifyNote } from '../common/noteClassify';

const NOW = new Date('2026-07-06T10:00:00Z'); // a Monday

const answer = (obj: object) => async () => JSON.stringify(obj);
const failing = async (): Promise<string> => {
  throw new Error('offline');
};

suite('common/noteClassify', () => {
  test('uses the model answer, coercing unknown values', async () => {
    const cls = await classifyNote(
      'fix the login bug',
      {},
      answer({ kind: 'task', priority: 'urgent', tags: ['Auth', 3, ''], summary: ' Login bug ' }),
      NOW,
    );
    assert.strictEqual(cls.kind, 'task');
    assert.strictEqual(cls.priority, null); // "urgent" is not a valid priority
    assert.deepStrictEqual(cls.tags, ['auth']);
    assert.strictEqual(cls.summary, 'Login bug');
  });

  test('accepts the JSON object wrapped in prose or fences', async () => {
    const cls = await classifyNote(
      'buy milk',
      {},
      async () => 'Here you go:\n```json\n{"kind":"task","priority":"low","summary":"Milk"}\n```',
      NOW,
    );
    assert.strictEqual(cls.kind, 'task');
    assert.strictEqual(cls.priority, 'low');
  });

  test('a reminder without a time asks for one', async () => {
    const cls = await classifyNote('remind me to stretch', {}, answer({ kind: 'reminder' }), NOW);
    assert.strictEqual(cls.needsClarification, true);
    assert.ok(cls.clarifyingQuestion);
  });

  test('recurrences are detected locally and dueAt set to the first occurrence', async () => {
    const cls = await classifyNote(
      'standup every weekday at 9am',
      {},
      answer({ kind: 'reminder', dueAt: null }),
      NOW,
    );
    assert.ok(cls.recur);
    assert.ok(cls.dueAt && new Date(cls.dueAt).getTime() > NOW.getTime());
  });

  test('falls back to the keyword heuristic when the model fails', async () => {
    const task = await classifyNote('need to fix the build asap', {}, failing, NOW);
    assert.strictEqual(task.kind, 'task');
    assert.strictEqual(task.priority, 'high');

    const reminder = await classifyNote('remind me in 30 minutes to call mom', {}, failing, NOW);
    assert.strictEqual(reminder.kind, 'reminder');
    assert.strictEqual(new Date(reminder.dueAt!).getTime(), NOW.getTime() + 30 * 60_000);

    const note = await classifyNote('the wifi password is on the fridge', {}, failing, NOW);
    assert.strictEqual(note.kind, 'note');
  });

  test('buildNoteEntry only arms triggers on reminders and tasks', async () => {
    const note = buildNoteEntry('x', await classifyNote('just a note', {}, failing, NOW), {});
    assert.strictEqual(note.fired, undefined);
    const reminder = buildNoteEntry(
      'r',
      await classifyNote('remind me in 2 hours', {}, failing, NOW),
      { workspaceFolder: 'proj' },
    );
    assert.strictEqual(reminder.fired, false);
    assert.strictEqual(reminder.workspaceTag, 'proj');
    assert.match(reminder.id, /^[0-9a-f]{16}/);
  });
});
