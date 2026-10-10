import assert from 'assert';
import { suite, test } from 'mocha';
import {
  autoLinkFileReferences,
  buildLocationHref,
  parseLocationHref,
} from '../common/links';

// Only `src/app.ts` exists — everything else stays a plain citation.
// Backslashes are normalized first, mirroring makePathResolver's behavior.
const resolve = (candidate: string): string | null =>
  candidate.replace(/\\/g, '/') === 'src/app.ts' ? '/ws/src/app.ts' : null;

function hrefOf(markdown: string, label: string): string {
  const marker = `[${label}](`;
  const idx = markdown.indexOf(marker);
  assert.ok(idx >= 0, `expected a link labelled ${label} in: ${markdown}`);
  const start = idx + marker.length;
  const end = markdown.indexOf(')', start);
  return markdown.slice(start, end);
}

suite('autoLinkFileReferences', () => {
  test('rewrites resolved path:line references into askii-open links', () => {
    const out = autoLinkFileReferences('Look at src/app.ts:42 for the details.', { resolve });
    assert.strictEqual(
      out,
      'Look at [src/app.ts:42](askii-open://open?path=%2Fws%2Fsrc%2Fapp.ts&line=42) for the details.',
    );
  });

  test('leaves unresolved references untouched', () => {
    const text = 'missing.ts:42 is not a real file.';
    assert.strictEqual(autoLinkFileReferences(text, { resolve }), text);
  });

  test('supports line ranges', () => {
    const out = autoLinkFileReferences('The block at src/app.ts:10-20 does the work.', { resolve });
    const loc = parseLocationHref(hrefOf(out, 'src/app.ts:10-20'));
    assert.strictEqual(loc?.path, '/ws/src/app.ts');
    assert.strictEqual(loc?.line, 10);
    assert.strictEqual(loc?.endLine, 20);
  });

  test('skips fenced code blocks but links surrounding prose', () => {
    const md = 'Before.\n\n```\nsrc/app.ts:42\n```\n\nAfter src/app.ts:7.';
    const out = autoLinkFileReferences(md, { resolve });
    assert.ok(out.includes('```\nsrc/app.ts:42\n```'), 'citation inside the fence must stay plain');
    assert.ok(out.includes('[src/app.ts:7]('), 'citation in prose must be linked');
  });

  test('skips inline code spans', () => {
    const text = 'The helper `src/app.ts:42` is backticked.';
    assert.strictEqual(autoLinkFileReferences(text, { resolve }), text);
  });

  test('copes with trailing punctuation and several citations per line', () => {
    const out = autoLinkFileReferences('First src/app.ts:1. Then src/app.ts:2!', { resolve });
    assert.ok(out.includes('[src/app.ts:1](askii-open://open?path=%2Fws%2Fsrc%2Fapp.ts&line=1).'));
    assert.ok(out.includes('[src/app.ts:2](askii-open://open?path=%2Fws%2Fsrc%2Fapp.ts&line=2)!'));
  });

  test('does not touch URLs or markdown link targets', () => {
    const text = 'See https://example.com/a.ts:12 and [x](src/app.ts:42) today.';
    assert.strictEqual(autoLinkFileReferences(text, { resolve }), text);
  });

  test('normalizes backslash separators written by the model', () => {
    const out = autoLinkFileReferences('Look at src\\app.ts:42 here.', { resolve });
    const loc = parseLocationHref(hrefOf(out, 'src\\app.ts:42'));
    assert.strictEqual(loc?.path, '/ws/src/app.ts');
  });

  test('does nothing without a resolver', () => {
    const text = 'src/app.ts:42';
    assert.strictEqual(autoLinkFileReferences(text), text);
  });
});

suite('location hrefs', () => {
  test('round-trips paths with spaces and parentheses', () => {
    const href = buildLocationHref('/ws/my (dir)/my file.ts', 7, 9);
    assert.ok(!/[() ]/.test(href), 'href must be markdown-destination safe');
    const loc = parseLocationHref(href);
    assert.strictEqual(loc?.path, '/ws/my (dir)/my file.ts');
    assert.strictEqual(loc?.line, 7);
    assert.strictEqual(loc?.endLine, 9);
  });

  test('line-less hrefs omit line numbers', () => {
    const loc = parseLocationHref(buildLocationHref('/ws/a.ts'));
    assert.strictEqual(loc?.path, '/ws/a.ts');
    assert.strictEqual(loc?.line, undefined);
    assert.strictEqual(loc?.endLine, undefined);
  });

  test('rejects foreign schemes and pathless hrefs', () => {
    assert.strictEqual(parseLocationHref('https://example.com/a?path=x'), null);
    assert.strictEqual(parseLocationHref('askii-open://open'), null);
    assert.strictEqual(parseLocationHref('askii-open://open?line=3'), null);
  });
});
