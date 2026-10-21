import assert from 'assert';
import { suite, test } from 'mocha';
import { normalizeControlAction, parseControlResponse } from '../common/control';
import { balancedJsonAt, parseJsonFromModel } from '../common/utils';

suite('common/utils — JSON extraction from model output', () => {
  test('balancedJsonAt handles nested objects, arrays and brackets in strings', () => {
    const text = 'x {"a":{"b":[1,2]},"s":"}]"} tail';
    assert.strictEqual(balancedJsonAt(text, 2), '{"a":{"b":[1,2]},"s":"}]"}');
    assert.strictEqual(balancedJsonAt('[{"a":1}', 0), null); // cut off
    assert.strictEqual(balancedJsonAt('[1}', 0), null); // mismatched
    assert.strictEqual(balancedJsonAt('abc', 0), null);
  });

  test('parseJsonFromModel finds nested objects in prose (non-greedy regex used to cut them)', () => {
    const value = parseJsonFromModel(
      'Sure! {"action":"mouse_scroll","x":1,"y":2,"meta":{"k":1},"direction":"up"} Done.',
    );
    assert.deepStrictEqual(value, {
      action: 'mouse_scroll',
      x: 1,
      y: 2,
      meta: { k: 1 },
      direction: 'up',
    });
  });

  test('parseJsonFromModel does not over-capture across two arrays', () => {
    const value = parseJsonFromModel('First [1,2] then [3]', Array.isArray);
    assert.deepStrictEqual(value, [1, 2]);
  });

  test('parseJsonFromModel returns undefined when nothing acceptable parses', () => {
    assert.strictEqual(parseJsonFromModel('no json here'), undefined);
    assert.strictEqual(parseJsonFromModel('[1]', (v) => !Array.isArray(v)), undefined);
  });
});

suite('common/control — parseControlResponse', () => {
  test('accepts fenced single actions and DONE', () => {
    assert.deepStrictEqual(parseControlResponse('```json\n{"action":"DONE","reasoning":"ok"}\n```'), {
      type: 'done',
      reasoning: 'ok',
    });
    const r = parseControlResponse('{"action":"mouse_left_click","x":"10","y":20.4,"reasoning":"r"}');
    assert.deepStrictEqual(r, {
      type: 'actions',
      actions: [{ action: 'mouse_left_click', x: 10, y: 20.4, reasoning: 'r' }],
    });
  });

  test('rejects non-numeric coordinates and unknown scroll directions', () => {
    assert.strictEqual(
      parseControlResponse('{"action":"mouse_left_click","x":"left","y":2,"reasoning":""}'),
      null,
    );
    assert.strictEqual(
      parseControlResponse('{"action":"mouse_scroll","x":1,"y":2,"direction":"sideways"}'),
      null,
    );
    assert.strictEqual(parseControlResponse('{"action":"format_disk"}'), null);
  });

  test('rejects a whole sequence when one step is malformed', () => {
    assert.strictEqual(
      parseControlResponse(
        '[{"action":"mouse_left_click","x":1},{"action":"keyboard_input","text":"secret"}]',
      ),
      null,
    );
  });

  test('drops DONE from arrays and clamps scroll amount', () => {
    const r = parseControlResponse(
      '[{"action":"mouse_scroll","x":1,"y":2,"direction":"DOWN","amount":50},{"action":"DONE"}]',
    );
    assert.deepStrictEqual(r, {
      type: 'actions',
      actions: [{ action: 'mouse_scroll', x: 1, y: 2, direction: 'down', amount: 10, reasoning: '' }],
    });
  });

  test('normalizeControlAction requires non-empty keys and text', () => {
    assert.strictEqual(normalizeControlAction({ action: 'key_press', key: '' }), null);
    assert.strictEqual(normalizeControlAction({ action: 'click_text' }), null);
    assert.deepStrictEqual(normalizeControlAction({ action: 'keyboard_input', text: '' }), {
      action: 'keyboard_input',
      text: '',
      reasoning: '',
    });
  });
});
