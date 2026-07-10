import assert from 'assert';
import test from 'node:test';
import { buildCommitMessageSystemPrompt, getCommitMessageStyle } from '../src/commitMessageStyle';

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
