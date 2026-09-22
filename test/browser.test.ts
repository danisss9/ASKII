import assert from 'assert';
import test from 'node:test';
import {
  buildBrowserCandidates,
  detectBrowserExecutable,
  normalizeNavigateUrl,
  parseBrowserResponse,
} from '../common/browser';

test('buildBrowserCandidates returns win32 paths in preference order', () => {
  const env = {
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramFiles: 'C:\\Program Files',
    LOCALAPPDATA: 'C:\\Users\\dani\\AppData\\Local',
  };
  const candidates = buildBrowserCandidates('win32', env);
  assert.ok(candidates.length >= 12);
  assert.strictEqual(
    candidates[0],
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  );
  assert.ok(
    candidates.includes('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'),
  );
  assert.ok(candidates.includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert.ok(
    candidates.includes(
      'C:\\Users\\dani\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ),
  );
});

test('buildBrowserCandidates returns macOS app bundles', () => {
  const candidates = buildBrowserCandidates('darwin', {});
  assert.ok(candidates[0].includes('Google Chrome.app'));
  assert.ok(candidates.some((c) => c.includes('Microsoft Edge.app')));
});

test('buildBrowserCandidates searches PATH on linux', () => {
  const env = { PATH: '/usr/bin:/usr/local/bin' };
  const candidates = buildBrowserCandidates('linux', env);
  assert.ok(candidates.includes('/usr/bin/google-chrome'));
  assert.ok(candidates.includes('/usr/local/bin/microsoft-edge'));
  assert.ok(!candidates.some((c) => c.includes('\\')));
});

test('detectBrowserExecutable returns a string or undefined', () => {
  const result = detectBrowserExecutable();
  assert.ok(result === undefined || (typeof result === 'string' && result.length > 0));
});

test('normalizeNavigateUrl adds schemes and resolves relative paths', () => {
  const base = 'https://en.wikipedia.org/wiki/Foo';
  assert.strictEqual(normalizeNavigateUrl('example.com', base), 'https://example.com');
  assert.strictEqual(normalizeNavigateUrl('www.wikipedia.org', base), 'https://www.wikipedia.org');
  assert.strictEqual(
    normalizeNavigateUrl('sub.domain.co/path?q=1', base),
    'https://sub.domain.co/path?q=1',
  );
  assert.strictEqual(normalizeNavigateUrl('localhost:3000', base), 'http://localhost:3000');
  assert.strictEqual(
    normalizeNavigateUrl('192.168.0.1:8080/admin', base),
    'http://192.168.0.1:8080/admin',
  );
  assert.strictEqual(
    normalizeNavigateUrl('/wiki/Main_Page', base),
    'https://en.wikipedia.org/wiki/Main_Page',
  );
  assert.strictEqual(normalizeNavigateUrl('//other.com/x', base), 'https://other.com/x');
  assert.strictEqual(normalizeNavigateUrl('about:blank', base), 'about:blank');
  assert.strictEqual(normalizeNavigateUrl(' https://example.com ', base), 'https://example.com');
  assert.strictEqual(normalizeNavigateUrl('"https://example.com"', base), 'https://example.com');
  assert.strictEqual(
    normalizeNavigateUrl('[Example](https://example.com)', base),
    'https://example.com',
  );
});

test('parseBrowserResponse accepts single objects, arrays and fenced output', () => {
  const single = parseBrowserResponse('```json\n{"action":"DONE","reasoning":"done"}\n```');
  assert.deepStrictEqual(single, { type: 'done', reasoning: 'done' });

  const arr = parseBrowserResponse(
    '[{"action":"goto","url":"x","reasoning":"r"},{"action":"DONE","reasoning":"d"}]',
  );
  assert.strictEqual(arr?.type, 'actions');
  assert.strictEqual(arr?.actions.length, 1); // DONE filtered out of arrays

  assert.strictEqual(parseBrowserResponse('not json at all'), null);
  assert.strictEqual(parseBrowserResponse('[]'), null);
});
