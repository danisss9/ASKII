import assert from 'assert';
import test from 'node:test';
import { parseControlResponse, parseControlAction } from '../shared/control';
import { parseBrowserAction, describeBrowserAction } from '../shared/browser';
import { parseWorkspaceActions } from '../shared/workspace';

test('parseControlAction parses a single action object', () => {
  const a = parseControlAction('{"action":"mouse_left_click","x":10,"y":20,"reasoning":"r"}');
  assert.ok(a);
  assert.strictEqual(a!.action, 'mouse_left_click');
  if (a!.action === 'mouse_left_click') {
    assert.strictEqual(a!.x, 10);
    assert.strictEqual(a!.y, 20);
  }
});

test('parseControlAction tolerates markdown fences', () => {
  const a = parseControlAction('```json\n{"action":"DONE","reasoning":"ok"}\n```');
  assert.ok(a);
  assert.strictEqual(a!.action, 'DONE');
});

test('parseControlResponse parses an action array', () => {
  const r = parseControlResponse('[{"action":"mouse_move","x":1,"y":2,"reasoning":""}]');
  assert.ok(r);
  assert.strictEqual(r!.type, 'actions');
  if (r!.type === 'actions') assert.strictEqual(r!.actions.length, 1);
});

test('parseControlResponse parses DONE', () => {
  const r = parseControlResponse('{"action":"DONE","reasoning":"finished"}');
  assert.ok(r);
  assert.strictEqual(r!.type, 'done');
});

test('parseBrowserAction parses a goto and describeBrowserAction labels it', () => {
  const a = parseBrowserAction('{"action":"goto","url":"https://example.com","reasoning":"r"}');
  assert.ok(a);
  if (a!.action === 'goto') {
    assert.strictEqual(a!.url, 'https://example.com');
    assert.strictEqual(describeBrowserAction(a!), 'Navigate to https://example.com');
  }
});

test('parseWorkspaceActions filters to known action types', () => {
  const actions = parseWorkspaceActions(
    '[{"type":"view","path":"a.ts"},{"type":"bogus"},{"type":"list","path":"src"}]',
  );
  assert.strictEqual(actions.length, 2);
  assert.strictEqual(actions[0].type, 'view');
  assert.strictEqual(actions[1].type, 'list');
});

test('parseWorkspaceActions returns [] when no JSON array present', () => {
  assert.deepStrictEqual(parseWorkspaceActions('no json here'), []);
});