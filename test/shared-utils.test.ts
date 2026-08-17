import assert from 'assert';
import test from 'node:test';
import { escapeHtml, escapeJsonString, unescapeJsonString, extractCode } from '../shared/utils';

test('escapeHtml escapes the five XML-special characters', () => {
  assert.strictEqual(escapeHtml(`<a href="x" class='y'>&</a>`), '&lt;a href=&quot;x&quot; class=&#039;y&#039;&gt;&amp;&lt;/a&gt;');
});

test('escapeJsonString / unescapeJsonString roundtrip newlines and quotes', () => {
  const raw = 'line1\nline2\ttab"quote"\\backslash\rreturn';
  const escaped = escapeJsonString(raw);
  assert.ok(!escaped.includes('\n'), 'newline must be escaped');
  assert.strictEqual(unescapeJsonString(escaped), raw);
});

test('extractCode strips fenced code blocks', () => {
  assert.strictEqual(extractCode('```ts\nconst x = 1;\n```'), 'const x = 1;');
  assert.strictEqual(extractCode('plain text'), 'plain text');
  assert.strictEqual(extractCode('```\nfoo\n```'), 'foo');
});