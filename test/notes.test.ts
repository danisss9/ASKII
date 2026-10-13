import assert from 'assert';
import { suite, test } from 'mocha';
import {
  parseReminderTimeLocal,
  parseReminderTrigger,
  parseRecurrence,
  parseEventTrigger,
  eventPatternMatches,
  describeEventTrigger,
  computeNextOccurrence,
  describeRecurrence,
  type RecurRule,
} from '../common/notes';

// Fixed "now": Thursday 2026-09-10, 14:30 local time.
const NOW = new Date(2026, 8, 10, 14, 30, 0);

function local(y: number, mo: number, d: number, h: number, mi: number, s = 0): string {
  return new Date(y, mo, d, h, mi, s, 0).toISOString();
}

function assertDue(text: string, expected: string): void {
  assert.strictEqual(parseReminderTimeLocal(text, NOW), expected, `"${text}"`);
}

suite('parseReminderTimeLocal — relative durations', () => {
  test('simple units', () => {
    assertDue('in 2 hours', local(2026, 8, 10, 16, 30));
    assertDue('in 30 minutes', local(2026, 8, 10, 15, 0));
    assertDue('in 10 mins', local(2026, 8, 10, 14, 40));
    assertDue('in 2 days', local(2026, 8, 12, 14, 30));
    assertDue('in 1.5 hours', local(2026, 8, 10, 16, 0));
  });

  test('compound durations', () => {
    assertDue('in 1 hour and 30 minutes', local(2026, 8, 10, 16, 0));
    assertDue('in 1 hour 30 minutes', local(2026, 8, 10, 16, 0));
    assertDue('in 1h30m', local(2026, 8, 10, 16, 0));
    assertDue('in 90 seconds', local(2026, 8, 10, 14, 31, 30));
  });

  test('wordy and vague durations', () => {
    assertDue('in half an hour', local(2026, 8, 10, 15, 0));
    assertDue('in an hour', local(2026, 8, 10, 15, 30));
    assertDue('in an hour and a half', local(2026, 8, 10, 16, 0));
    assertDue('in a minute', local(2026, 8, 10, 14, 31));
    assertDue('in a bit', local(2026, 8, 10, 15, 0));
  });

  test('"N units from now"', () => {
    assertDue('20 minutes from now', local(2026, 8, 10, 14, 50));
  });

  test('phrases found anywhere in the text', () => {
    assertDue('remind me to stretch in 10 minutes', local(2026, 8, 10, 14, 40));
    assertDue('call mom tomorrow at 5pm', local(2026, 8, 11, 17, 0));
  });
});

suite('parseReminderTimeLocal — day phrases', () => {
  test('tomorrow with optional time and part-of-day', () => {
    assertDue('tomorrow', local(2026, 8, 11, 9, 0));
    assertDue('tomorrow 9am', local(2026, 8, 11, 9, 0));
    assertDue('tomorrow at 14:30', local(2026, 8, 11, 14, 30));
    assertDue('tomorrow morning', local(2026, 8, 11, 9, 0));
    assertDue('tomorrow evening', local(2026, 8, 11, 18, 0));
  });

  test('today-ish phrases', () => {
    assertDue('tonight', local(2026, 8, 10, 20, 0));
    assertDue('tonight at 8pm', local(2026, 8, 10, 20, 0));
    assertDue('at 5pm', local(2026, 8, 10, 17, 0));
    assertDue('at 17:30', local(2026, 8, 10, 17, 30));
    assertDue('at noon', local(2026, 8, 11, 12, 0)); // 12:00 already passed
    assertDue('this evening', local(2026, 8, 10, 18, 0));
    assertDue('this morning', local(2026, 8, 11, 9, 0)); // morning passed → rolls
    assertDue('day after tomorrow', local(2026, 8, 12, 9, 0));
  });

  test('"today" phrases stay on today', () => {
    assertDue('later today', local(2026, 8, 10, 17, 30)); // 9:00 passed → a few hours out
    assertDue('check the build today', local(2026, 8, 10, 17, 30));
    assertDue('today at 5', local(2026, 8, 10, 17, 0)); // 5am passed, 5pm ahead
    assertDue('today at 4:15', local(2026, 8, 10, 16, 15));
    assertDue('today at 5pm', local(2026, 8, 10, 17, 0));
    assert.strictEqual(
      parseReminderTimeLocal('later today', new Date(2026, 8, 10, 7, 0)),
      local(2026, 8, 10, 9, 0), // morning: 9:00 is still ahead
    );
    assert.strictEqual(
      parseReminderTimeLocal('later today', new Date(2026, 8, 10, 21, 0)),
      local(2026, 8, 10, 22, 0), // evening: capped, never tomorrow
    );
  });

  test('bare "at N" picks the next occurrence of that hour', () => {
    assertDue('at 5', local(2026, 8, 10, 17, 0)); // 5am passed, 5pm ahead
    assertDue('at 9', local(2026, 8, 10, 21, 0)); // 9pm is the next "9 o'clock"
  });

  test('weekdays with prepositions', () => {
    // 2026-09-10 is a Thursday; Friday is tomorrow.
    assertDue('on friday', local(2026, 8, 11, 9, 0));
    assertDue('this fri at 5pm', local(2026, 8, 11, 17, 0));
    assertDue('by tuesday', local(2026, 8, 15, 9, 0));
    assertDue('next monday', local(2026, 8, 14, 9, 0));
    assertDue('next friday', local(2026, 8, 11, 9, 0)); // next occurrence (tomorrow)
    assertDue('next week', local(2026, 8, 14, 9, 0)); // next Monday
    assertDue('next week on wednesday', local(2026, 8, 16, 9, 0));
    assertDue('this weekend', local(2026, 8, 12, 10, 0)); // Saturday
    assertDue('next month', local(2026, 9, 10, 9, 0));
  });

  test('time may precede the day phrase', () => {
    // NOW is a Thursday and 15:00 is still ahead → "on thursday" means today.
    assertDue('sync at 3pm on thursday', local(2026, 8, 10, 15, 0));
    assertDue('sync at 3pm on friday', local(2026, 8, 11, 15, 0));
    assertDue('meet at 9am tomorrow', local(2026, 8, 11, 9, 0));
  });

  test('end of day / week', () => {
    assertDue('eod', local(2026, 8, 10, 18, 0));
    assertDue('end of the week', local(2026, 8, 11, 17, 0)); // Friday
  });

  test('month-day dates', () => {
    assertDue('jul 8 2027', local(2027, 6, 8, 9, 0));
    assertDue('july 8th at 3pm', local(2027, 6, 8, 15, 0)); // rolled to next year
    assertDue('8 july 2027', local(2027, 6, 8, 9, 0));
    assertDue('sept 3 2027', local(2027, 8, 3, 9, 0));
    assertDue('the 3rd of september 2027', local(2027, 8, 3, 9, 0));
  });

  test('words that merely start like a month are not dates', () => {
    assertDue('write 2 junit tests in 3 hours', local(2026, 8, 10, 17, 30));
    assertDue('fix 2 decorators in 1 hour', local(2026, 8, 10, 15, 30));
    assertDue('call mark 3 times in 2 days', local(2026, 8, 12, 14, 30));
  });

  test('absolute ISO dates', () => {
    assertDue('2026-12-25', local(2026, 11, 25, 9, 0));
    assertDue('on 2026-12-25 14:30', local(2026, 11, 25, 14, 30));
  });

  test('guards against stray numbers being read as times', () => {
    // "tomorrow 15 people" must not become 15:00 — falls back to 9am.
    assertDue('tomorrow 15 people are coming', local(2026, 8, 11, 9, 0));
    assert.strictEqual(parseReminderTimeLocal('hello world', NOW), null);
    assert.strictEqual(parseReminderTimeLocal('', NOW), null);
  });
});

suite('parseReminderTimeLocal — more triggers', () => {
  test('word-number and vague durations', () => {
    assertDue('in two hours', local(2026, 8, 10, 16, 30));
    assertDue('in three days', local(2026, 8, 13, 14, 30));
    assertDue('in fifteen minutes', local(2026, 8, 10, 14, 45));
    assertDue('in a couple of hours', local(2026, 8, 10, 16, 30));
    assertDue('in a few minutes', local(2026, 8, 10, 14, 33));
    assertDue('in a fortnight', local(2026, 8, 24, 14, 30));
  });

  test('durations from now with word numbers and articles', () => {
    assertDue('an hour from now', local(2026, 8, 10, 15, 30));
    assertDue('a week from now', local(2026, 8, 17, 14, 30));
    assertDue('two days from now', local(2026, 8, 12, 14, 30));
  });

  test('noon and midnight combine with day phrases', () => {
    assertDue('tomorrow at noon', local(2026, 8, 11, 12, 0));
    assertDue('tomorrow noon', local(2026, 8, 11, 12, 0));
    assertDue('on friday at noon', local(2026, 8, 11, 12, 0));
    assertDue('noon tomorrow', local(2026, 8, 11, 12, 0));
  });

  test('part-of-day after a clock time', () => {
    assertDue('tomorrow at 5 in the evening', local(2026, 8, 11, 17, 0));
    assertDue('tomorrow at 11 at night', local(2026, 8, 11, 23, 0));
    assertDue('at 9 in the morning', local(2026, 8, 11, 9, 0)); // today 9am passed → rolls
  });

  test('half past / quarter past / quarter to', () => {
    assertDue('half past 5', local(2026, 8, 10, 17, 30));
    assertDue('quarter past 5', local(2026, 8, 10, 17, 15));
    assertDue('quarter to 6', local(2026, 8, 10, 17, 45));
    assertDue('tomorrow at half past 9', local(2026, 8, 11, 9, 30));
  });

  test('day of month without a month name', () => {
    assertDue('on the 15th', local(2026, 8, 15, 9, 0));
    assertDue('on the 15th at 4pm', local(2026, 8, 15, 16, 0));
    assertDue('by the 1st of next month', local(2026, 9, 1, 9, 0));
    // The 3rd already passed this month → next month.
    assertDue('on the 3rd', local(2026, 9, 3, 9, 0));
  });

  test('end of month / end of year', () => {
    assertDue('eom', local(2026, 8, 30, 17, 0)); // Sep has 30 days
    assertDue('end of the month', local(2026, 8, 30, 17, 0));
    assertDue('eoy', local(2026, 11, 31, 17, 0));
    assertDue('end of year', local(2026, 11, 31, 17, 0));
  });

  test('this time tomorrow keeps the clock time', () => {
    assertDue('this time tomorrow', local(2026, 8, 11, 14, 30));
    assertDue('same time tomorrow', local(2026, 8, 11, 14, 30));
  });

  test('first thing in the morning', () => {
    // 9:00 already passed at 14:30 → rolls to tomorrow 9am.
    assertDue('first thing in the morning', local(2026, 8, 11, 9, 0));
  });

  test('weekday next week (reversed order)', () => {
    assertDue('friday next week', local(2026, 8, 18, 9, 0));
    assertDue('monday next week at 10am', local(2026, 8, 14, 10, 0));
  });

  test('over the weekend and bare part-of-day after a weekday', () => {
    assertDue('over the weekend', local(2026, 8, 12, 10, 0)); // Saturday
    assertDue('on friday evening', local(2026, 8, 11, 18, 0));
    assertDue('next monday morning', local(2026, 8, 14, 9, 0));
  });

  test('bare clock times without "at"', () => {
    // "9:30" alone at 14:30 → next 9:30 is the PM reading (like "at 9").
    assertDue('9:30', local(2026, 8, 10, 21, 30));
    assertDue('remind me 11pm', local(2026, 8, 10, 23, 0));
  });
});

suite('parseRecurrence', () => {
  test('daily variants', () => {
    assert.deepStrictEqual(parseRecurrence('every day at 9am', NOW), {
      type: 'daily',
      time: '09:00',
    });
    assert.deepStrictEqual(parseRecurrence('daily', NOW), { type: 'daily', time: '09:00' });
    assert.deepStrictEqual(parseRecurrence('every morning', NOW), {
      type: 'daily',
      time: '09:00',
    });
    assert.deepStrictEqual(parseRecurrence('every evening', NOW), {
      type: 'daily',
      time: '18:00',
    });
  });

  test('weekday rules', () => {
    assert.deepStrictEqual(parseRecurrence('every weekday at 9am', NOW), {
      type: 'weekdays',
      time: '09:00',
    });
    assert.deepStrictEqual(parseRecurrence('every weekend', NOW), {
      type: 'weekends',
      time: '10:00',
    });
    assert.deepStrictEqual(parseRecurrence('every monday at 10am', NOW), {
      type: 'weekly',
      day: 1,
      time: '10:00',
    });
    assert.deepStrictEqual(parseRecurrence('weekly on friday at 5pm', NOW), {
      type: 'weekly',
      day: 5,
      time: '17:00',
    });
  });

  test('interval rules', () => {
    assert.deepStrictEqual(parseRecurrence('every 2 hours', NOW), {
      type: 'interval',
      interval: 2,
      unit: 'hour',
    });
    assert.deepStrictEqual(parseRecurrence('every 30 minutes', NOW), {
      type: 'interval',
      interval: 30,
      unit: 'minute',
    });
    assert.deepStrictEqual(parseRecurrence('every other day', NOW), {
      type: 'interval',
      interval: 2,
      unit: 'day',
    });
    // Rules have minute granularity — seconds round up, never fall through to days
    assert.deepStrictEqual(parseRecurrence('every 30 seconds', NOW), {
      type: 'interval',
      interval: 1,
      unit: 'minute',
    });
    assert.deepStrictEqual(parseRecurrence('every 150 secs', NOW), {
      type: 'interval',
      interval: 3,
      unit: 'minute',
    });
  });

  test('month/year rules', () => {
    assert.deepStrictEqual(parseRecurrence('every month', NOW), {
      type: 'monthly',
      day: 10,
      time: '09:00',
    });
    assert.deepStrictEqual(parseRecurrence('every year', NOW), { type: 'yearly', time: '09:00' });
  });

  test('non-recurring text returns null', () => {
    assert.strictEqual(parseRecurrence('remind me in 2 hours', NOW), null);
    assert.strictEqual(parseRecurrence('buy milk tomorrow', NOW), null);
  });

  test('hourly variants', () => {
    assert.deepStrictEqual(parseRecurrence('every hour', NOW), {
      type: 'interval',
      interval: 1,
      unit: 'hour',
    });
    assert.deepStrictEqual(parseRecurrence('hourly', NOW), {
      type: 'interval',
      interval: 1,
      unit: 'hour',
    });
    assert.deepStrictEqual(parseRecurrence('every half hour', NOW), {
      type: 'interval',
      interval: 30,
      unit: 'minute',
    });
    assert.deepStrictEqual(parseRecurrence('every quarter hour', NOW), {
      type: 'interval',
      interval: 15,
      unit: 'minute',
    });
  });

  test('biweekly / fortnightly / quarterly', () => {
    assert.deepStrictEqual(parseRecurrence('biweekly', NOW), {
      type: 'interval',
      interval: 2,
      unit: 'week',
    });
    assert.deepStrictEqual(parseRecurrence('fortnightly', NOW), {
      type: 'interval',
      interval: 2,
      unit: 'week',
    });
    assert.deepStrictEqual(parseRecurrence('quarterly', NOW), {
      type: 'interval',
      interval: 3,
      unit: 'month',
    });
  });

  test('multi-weekday rules', () => {
    assert.deepStrictEqual(parseRecurrence('every monday and wednesday at 6pm', NOW), {
      type: 'weekly',
      days: [1, 3],
      time: '18:00',
    });
    assert.deepStrictEqual(parseRecurrence('every mon, wed, fri', NOW), {
      type: 'weekly',
      days: [1, 3, 5],
      time: '09:00',
    });
    assert.deepStrictEqual(parseRecurrence('weekly on tuesday & thursday', NOW), {
      type: 'weekly',
      days: [2, 4],
      time: '09:00',
    });
  });

  test('monthly on the Nth', () => {
    assert.deepStrictEqual(parseRecurrence('every month on the 15th', NOW), {
      type: 'monthly',
      day: 15,
      time: '09:00',
    });
    assert.deepStrictEqual(parseRecurrence('monthly on the 1st at noon', NOW), {
      type: 'monthly',
      day: 1,
      time: '12:00',
    });
    assert.deepStrictEqual(parseRecurrence('every 15th of the month', NOW), {
      type: 'monthly',
      day: 15,
      time: '09:00',
    });
  });

  test('yearly anchored to a date', () => {
    assert.deepStrictEqual(parseRecurrence('every year on july 8', NOW), {
      type: 'yearly',
      month: 6,
      day: 8,
      time: '09:00',
    });
    assert.deepStrictEqual(parseRecurrence('annually on 8 july', NOW), {
      type: 'yearly',
      month: 6,
      day: 8,
      time: '09:00',
    });
  });

  test('numeric "every N months" stays an interval, not a day-of-month', () => {
    assert.deepStrictEqual(parseRecurrence('every 2 months', NOW), {
      type: 'interval',
      interval: 2,
      unit: 'month',
    });
    assert.deepStrictEqual(parseRecurrence('every 2 weeks', NOW), {
      type: 'interval',
      interval: 2,
      unit: 'week',
    });
  });
});

suite('computeNextOccurrence', () => {
  const at = (h: number, m: number): string => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  test('daily rolls to tomorrow when today\u2019s time passed', () => {
    const next = computeNextOccurrence({ type: 'daily', time: at(9, 0) }, NOW);
    assert.strictEqual(next?.toISOString(), local(2026, 8, 11, 9, 0));
  });

  test('weekdays skip the weekend', () => {
    // Friday 17:00 → next weekday is Monday 09:00.
    const friday = new Date(2026, 8, 11, 17, 0, 0);
    const next = computeNextOccurrence({ type: 'weekdays', time: at(9, 0) }, friday);
    assert.strictEqual(next?.toISOString(), local(2026, 8, 14, 9, 0));
  });

  test('weekly lands on the target weekday', () => {
    const next = computeNextOccurrence({ type: 'weekly', day: 1, time: at(10, 0) }, NOW);
    assert.strictEqual(next?.toISOString(), local(2026, 8, 14, 10, 0)); // Monday
  });

  test('multi-weekday picks the next matching day', () => {
    // NOW is Thursday 14:30 → Mon/Wed/Fri rule: Friday 09:00 is the next
    // occurrence strictly after now.
    const next = computeNextOccurrence(
      { type: 'weekly', days: [1, 3, 5], time: at(9, 0) },
      NOW,
    );
    assert.strictEqual(next?.toISOString(), local(2026, 8, 11, 9, 0));
    // Friday afternoon → Monday 09:00.
    const friday = new Date(2026, 8, 11, 15, 0, 0);
    const nextMonday = computeNextOccurrence({ type: 'weekly', days: [1, 3, 5], time: at(9, 0) }, friday);
    assert.strictEqual(nextMonday?.toISOString(), local(2026, 8, 14, 9, 0));
  });

  test('yearly with month/day lands on the date', () => {
    const next = computeNextOccurrence({ type: 'yearly', month: 6, day: 8, time: at(9, 0) }, NOW);
    assert.strictEqual(next?.toISOString(), local(2027, 6, 8, 9, 0));
    // Before the date this year → this year's occurrence.
    const before = new Date(2026, 5, 1, 12, 0, 0);
    const thisYear = computeNextOccurrence({ type: 'yearly', month: 6, day: 8, time: at(9, 0) }, before);
    assert.strictEqual(thisYear?.toISOString(), local(2026, 6, 8, 9, 0));
  });

  test('monthly clamps short months', () => {
    // Jan 31 → Feb clamps to the 28th (2027 is not a leap year).
    const jan31 = new Date(2027, 0, 31, 12, 0, 0);
    const next = computeNextOccurrence({ type: 'monthly', day: 31, time: at(9, 0) }, jan31);
    assert.strictEqual(next?.toISOString(), local(2027, 1, 28, 9, 0));
  });

  test('interval adds the unit', () => {
    const next = computeNextOccurrence(
      { type: 'interval', interval: 2, unit: 'hour' },
      NOW,
    );
    assert.strictEqual(next?.toISOString(), local(2026, 8, 10, 16, 30));
  });
});

suite('describeRecurrence', () => {
  test('formats rules for humans', () => {
    assert.strictEqual(describeRecurrence({ type: 'daily', time: '09:00' }), 'daily at 9:00 am');
    assert.strictEqual(
      describeRecurrence({ type: 'weekly', day: 5, time: '17:00' }),
      'every friday at 5:00 pm',
    );
    assert.strictEqual(
      describeRecurrence({ type: 'weekdays', time: '09:00' }),
      'every weekday at 9:00 am',
    );
    assert.strictEqual(
      describeRecurrence({ type: 'interval', interval: 2, unit: 'hour' }),
      'every 2 hours',
    );
    assert.strictEqual(
      describeRecurrence({ type: 'monthly', day: 1, time: '09:00' }),
      'every month on the 1st at 9:00 am',
    );
    assert.strictEqual(
      describeRecurrence({ type: 'weekly', days: [1, 3], time: '09:00' }),
      'every monday and wednesday at 9:00 am',
    );
    assert.strictEqual(
      describeRecurrence({ type: 'weekly', days: [1, 3, 5], time: '09:00' }),
      'every monday, wednesday and friday at 9:00 am',
    );
    assert.strictEqual(
      describeRecurrence({ type: 'yearly', month: 6, day: 8, time: '09:00' }),
      'every year on july 8 at 9:00 am',
    );
  });
});

suite('parseReminderTrigger', () => {
  test('recurring text yields the rule and its first occurrence', () => {
    const trig = parseReminderTrigger('standup every weekday at 9am', NOW);
    assert.ok(trig.recur);
    assert.strictEqual(trig.recur.type, 'weekdays');
    assert.strictEqual(trig.dueAt, local(2026, 8, 11, 9, 0));
  });

  test('multi-weekday recurring text yields a days[] rule', () => {
    const trig = parseReminderTrigger('gym every monday and wednesday at 6pm', NOW);
    assert.ok(trig.recur);
    assert.strictEqual(trig.recur.type, 'weekly');
    assert.deepStrictEqual(trig.recur.days, [1, 3]);
    // NOW is Thursday → next matching day is Monday the 14th.
    assert.strictEqual(trig.dueAt, local(2026, 8, 14, 18, 0));
  });

  test('one-shot text yields only a dueAt', () => {
    const trig = parseReminderTrigger('remind me in 2 hours', NOW);
    assert.strictEqual(trig.recur, null);
    assert.strictEqual(trig.dueAt, local(2026, 8, 10, 16, 30));
  });

  test('no trigger at all', () => {
    const trig = parseReminderTrigger('just a plain thought', NOW);
    assert.strictEqual(trig.recur, null);
    assert.strictEqual(trig.dueAt, null);
  });

  test('recurring rules are typed as RecurRule', () => {
    const rule: RecurRule = { type: 'daily', time: '07:15' };
    assert.strictEqual(rule.type, 'daily');
  });
});

suite('parseEventTrigger', () => {
  test('startup phrases', () => {
    assert.deepStrictEqual(parseEventTrigger('remind me when I open VS Code'), {
      type: 'startup',
      everyTime: false,
    });
    assert.deepStrictEqual(parseEventTrigger('check email every time I open vscode'), {
      type: 'startup',
      everyTime: true,
    });
    assert.deepStrictEqual(parseEventTrigger('next time you open VS Code, stretch'), {
      type: 'startup',
      everyTime: false,
    });
    assert.deepStrictEqual(parseEventTrigger('run the backup on startup'), {
      type: 'startup',
      everyTime: false,
    });
    assert.deepStrictEqual(parseEventTrigger('when VS Code starts'), {
      type: 'startup',
      everyTime: false,
    });
  });

  test('workspace phrases', () => {
    assert.deepStrictEqual(parseEventTrigger('when I open this workspace', 'ASKII'), {
      type: 'workspaceOpen',
      pattern: 'ASKII',
      everyTime: false,
    });
    assert.deepStrictEqual(parseEventTrigger('every time I switch to the project'), {
      type: 'workspaceOpen',
      pattern: undefined,
      everyTime: true,
    });
  });

  test('file phrases', () => {
    assert.deepStrictEqual(parseEventTrigger('remind me when I open package.json'), {
      type: 'fileOpen',
      pattern: 'package.json',
      everyTime: false,
    });
    assert.deepStrictEqual(parseEventTrigger('every time I save .env'), {
      type: 'fileSave',
      pattern: '.env',
      everyTime: true,
    });
    assert.deepStrictEqual(parseEventTrigger('when I open a ts file'), {
      type: 'fileOpen',
      pattern: '*.ts',
      everyTime: false,
    });
    assert.deepStrictEqual(parseEventTrigger('when I open the file'), {
      type: 'fileOpen',
      pattern: undefined,
      everyTime: false,
    });
    assert.deepStrictEqual(parseEventTrigger('when I save this file', undefined, 'index.ts'), {
      type: 'fileSave',
      pattern: 'index.ts',
      everyTime: false,
    });
    // "this file" needs a current file to resolve against.
    assert.strictEqual(parseEventTrigger('when I save this file'), null);
    assert.deepStrictEqual(parseEventTrigger('when I open src/index.ts'), {
      type: 'fileOpen',
      pattern: 'src/index.ts',
      everyTime: false,
    });
    assert.deepStrictEqual(parseEventTrigger('remind me to commit when I save'), {
      type: 'fileSave',
      everyTime: false,
    });
  });

  test('no false triggers', () => {
    assert.strictEqual(parseEventTrigger('remind me in 2 hours'), null);
    assert.strictEqual(parseEventTrigger('buy milk tomorrow'), null);
    assert.strictEqual(parseEventTrigger('remind me to stretch'), null);
    assert.strictEqual(parseEventTrigger('the door opens when I push it'), null);
  });
});

suite('eventPatternMatches', () => {
  test('exact and boundary-suffix matching', () => {
    assert.strictEqual(eventPatternMatches('package.json', 'package.json', '/w/package.json'), true);
    assert.strictEqual(
      eventPatternMatches('package.json', 'package.json', '/w/src/package.json'),
      true,
    );
    assert.strictEqual(
      eventPatternMatches('package.json', 'my-package.json', '/w/my-package.json'),
      false,
    );
    assert.strictEqual(eventPatternMatches('.env', '.env', '/w/project/.env'), true);
    assert.strictEqual(eventPatternMatches('src/index.ts', 'index.ts', '/w/src/index.ts'), true);
  });

  test('glob patterns and no-pattern', () => {
    assert.strictEqual(eventPatternMatches('*.ts', 'index.ts', '/w/src/index.ts'), true);
    assert.strictEqual(eventPatternMatches('*.ts', 'index.js', '/w/index.js'), false);
    assert.strictEqual(eventPatternMatches('*test*', '/w/src/foo.test.ts', 'foo.test.ts'), true);
    assert.strictEqual(eventPatternMatches(undefined, 'anything.txt'), true);
    assert.strictEqual(eventPatternMatches('', 'anything.txt'), true);
  });
});

suite('describeEventTrigger', () => {
  test('formats event triggers for humans', () => {
    assert.strictEqual(describeEventTrigger({ type: 'startup' }), 'next time you open VS Code');
    assert.strictEqual(
      describeEventTrigger({ type: 'startup', everyTime: true }),
      'every time you open VS Code',
    );
    assert.strictEqual(
      describeEventTrigger({ type: 'fileSave', pattern: '.env', everyTime: true }),
      'every time you save .env',
    );
    assert.strictEqual(
      describeEventTrigger({ type: 'workspaceOpen', pattern: 'ASKII' }),
      'next time you open the ASKII workspace',
    );
    assert.strictEqual(
      describeEventTrigger({ type: 'fileOpen' }),
      'next time you open a file',
    );
  });
});
