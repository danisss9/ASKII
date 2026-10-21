import assert from 'assert';
import { suite, test } from 'mocha';
import {
  MAX_COMMIT_DIFF_CHARS,
  buildCommitMessageSystemPrompt,
  buildCommitUserPrompt,
  cleanCommitMessage,
  formatCommitExamples,
  getCommitMessageStyle,
} from '../common/commitMessage';
suite('common/commitMessage', () => {
  test('getCommitMessageStyle normalizes supported aliases', () => {
    assert.strictEqual(getCommitMessageStyle('OneLiner'), 'oneliner');
    assert.strictEqual(getCommitMessageStyle('brief'), 'brief');
    assert.strictEqual(getCommitMessageStyle('Descriptive'), 'descriptive');
    assert.strictEqual(getCommitMessageStyle('unknown'), 'brief');
  });

  test('buildCommitMessageSystemPrompt includes the selected style guidance', () => {
    const prompt = buildCommitMessageSystemPrompt('oneliner', 'Keep it short.');

    assert.match(prompt, /Preferred commit message style: OneLiner/);
    assert.match(prompt, /single-line subject only/);
    assert.match(prompt, /Additional instructions from the user:/);
    assert.match(prompt, /Keep it short\./);
  });

  test('formatCommitExamples numbers, caps and indents example messages', () => {
    const out = formatCommitExamples(['feat: a\n\nbody line', '', 'x'.repeat(600)]);
    assert.match(out, /^Recent commit messages/);
    assert.match(out, /1\. feat: a\n   \n   body line/);
    assert.match(out, /2\. x{500}…/);
    assert.strictEqual(formatCommitExamples(['', '  ']), '');
  });

  test('buildCommitUserPrompt truncates the diff and mentions examples only when present', () => {
    const prompt = buildCommitUserPrompt({
      files: ['a.ts'],
      diff: 'd'.repeat(MAX_COMMIT_DIFF_CHARS + 10),
      staged: true,
      examples: '',
    });
    assert.match(prompt, /Changed files \(staged\):\na\.ts/);
    assert.match(prompt, /…\[diff truncated\]/);
    assert.match(prompt, /Write the commit message now\.$/);
    const withExamples = buildCommitUserPrompt({ files: [], diff: '', staged: false, examples: 'EX' });
    assert.match(withExamples, /\(no file list available\)/);
    assert.match(withExamples, /matching the style/);
  });

  test('cleanCommitMessage strips fences, labels and quotes', () => {
    assert.strictEqual(cleanCommitMessage('```\nfix: x\n```'), 'fix: x');
    assert.strictEqual(cleanCommitMessage('Commit message: feat: y'), 'feat: y');
    assert.strictEqual(cleanCommitMessage('"chore: z"'), 'chore: z');
  });
});

