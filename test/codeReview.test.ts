import assert from 'assert';
import { suite, test } from 'mocha';
import {
  minimalEdit,
  normalizeReviewPath,
  parseFixResponse,
  parseReviewProblems,
} from '../common/codeReview';
import { applyModifyAction } from '../common/workspace';

suite('common/codeReview — parseReviewProblems', () => {
  test('parses a fenced JSON array and sorts by severity', () => {
    const problems = parseReviewProblems(
      '```json\n[' +
        '{"file":"src/b.ts","line":4,"severity":"info","title":"Minor","description":"d","recommendation":"r"},' +
        '{"file":"src/a.ts","line":"12","severity":"error","title":"Bug","description":"Null deref","recommendation":"Guard it"}' +
        ']\n```',
    );
    assert.ok(problems);
    assert.deepStrictEqual(
      problems.map((p) => [p.file, p.line, p.severity, p.title]),
      [
        ['src/a.ts', 12, 'error', 'Bug'],
        ['src/b.ts', 4, 'info', 'Minor'],
      ],
    );
    assert.strictEqual(problems[0].recommendation, 'Guard it');
    assert.notStrictEqual(problems[0].id, problems[1].id);
  });

  test('finds the array inside surrounding prose that has brackets', () => {
    const problems = parseReviewProblems(
      'Here is my review [draft]:\n[{"file":"x.ts","title":"T","description":"D"}]\nDone.',
    );
    assert.strictEqual(problems?.length, 1);
    assert.strictEqual(problems[0].severity, 'warning');
    assert.strictEqual(problems[0].line, undefined);
  });

  test('returns [] for "no problems" and null for unreadable output', () => {
    assert.deepStrictEqual(parseReviewProblems('[]'), []);
    assert.strictEqual(parseReviewProblems('Looks good to me!'), null);
    assert.strictEqual(parseReviewProblems('[{"file": "a.ts", "title": '), null);
  });

  test('drops invalid entries and normalizes severity and paths', () => {
    const problems = parseReviewProblems(
      JSON.stringify([
        null,
        'oops',
        { title: 'no file' },
        { file: 'a.ts' },
        { file: '.\\src\\c.ts', severity: 'CRITICAL', title: 'Crit', line: -3 },
        { path: './d.ts', severity: 'suggestion', description: 'First line\nmore' },
      ]),
    );
    assert.deepStrictEqual(
      problems?.map((p) => [p.file, p.severity, p.title, p.line]),
      [
        ['src/c.ts', 'error', 'Crit', undefined],
        ['d.ts', 'info', 'First line', undefined],
      ],
    );
  });

  test('normalizeReviewPath strips ./ and converts backslashes', () => {
    assert.strictEqual(normalizeReviewPath('  .\\src\\a.ts '), 'src/a.ts');
  });
});

suite('common/codeReview — parseFixResponse', () => {
  test('parses a fenced fix and applies it with applyModifyAction', () => {
    const action = parseFixResponse(
      '```json\n{"oldContent":"return a.b;","newContent":"return a?.b;"}\n```',
      'src/a.ts',
    );
    assert.ok(action);
    assert.strictEqual(action.type, 'modify');
    assert.strictEqual(action.path, 'src/a.ts');
    const result = applyModifyAction('function f(a) {\n  return a.b;\n}\n', action);
    assert.deepStrictEqual(result, { text: 'function f(a) {\n  return a?.b;\n}\n' });
  });

  test('a snippet missing from the file yields an apply error', () => {
    const action = parseFixResponse('{"oldContent":"nope","newContent":"x"}', 'a.ts');
    assert.ok(action);
    assert.ok('error' in applyModifyAction('const y = 1;\n', action));
  });

  test('returns null for empty, no-op or unreadable fixes', () => {
    assert.strictEqual(parseFixResponse('{"oldContent":"","newContent":""}', 'a.ts'), null);
    assert.strictEqual(parseFixResponse('{"oldContent":"x","newContent":"x"}', 'a.ts'), null);
    assert.strictEqual(parseFixResponse('I cannot fix this.', 'a.ts'), null);
  });
});

suite('common/codeReview — minimalEdit', () => {
  test('returns only the differing span', () => {
    const before = 'line1\nreturn a.b;\nline3\n';
    const after = 'line1\nreturn a?.b;\nline3\n';
    const edit = minimalEdit(before, after);
    assert.strictEqual(
      before.slice(0, edit.start) + edit.text + before.slice(edit.end),
      after,
    );
    assert.strictEqual(edit.text, '?');
  });

  test('handles pure insertion, deletion and identical text', () => {
    assert.deepStrictEqual(minimalEdit('ab', 'aXb'), { start: 1, end: 1, text: 'X' });
    assert.deepStrictEqual(minimalEdit('aXb', 'ab'), { start: 1, end: 2, text: '' });
    assert.deepStrictEqual(minimalEdit('same', 'same'), { start: 4, end: 4, text: '' });
  });
});
