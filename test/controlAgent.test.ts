import assert from 'assert';
import { suite, test } from 'mocha';
import type { Page } from 'puppeteer-core';
import {
  runBrowserAgent,
  runScreenAgent,
  type ControlEvent,
  type ScreenSession,
} from '../common/controlAgent';
import type { ControlAction } from '../common/control';

/** Replies with the scripted answers in order, then DONE. */
function scripted(replies: string[]) {
  const prompts: string[] = [];
  let i = 0;
  const ask = async (system: string, prompt: string): Promise<string> => {
    prompts.push(`${system}\n${prompt}`);
    return replies[i++] ?? '{"action":"DONE","reasoning":"finished"}';
  };
  return { ask, prompts };
}

function fakeScreen(frames: string[]) {
  let frame = 0;
  const executed: ControlAction[] = [];
  return {
    executed,
    io: {
      takeScreenshot: async () => ({
        base64: frames[Math.min(frame++, frames.length - 1)],
        width: 100,
        height: 100,
        physWidth: 100,
        physHeight: 100,
      }),
      getSystemInfo: async () => ({ os: 'test' }),
      executeControlAction: async (a: ControlAction) => {
        executed.push(a);
      },
    },
  };
}

function fakePage() {
  let url = 'about:blank';
  const calls: string[] = [];
  const page = {
    url: () => url,
    screenshot: async () => 'img',
    goto: async (u: string) => {
      calls.push(`goto ${u}`);
      url = u;
    },
    click: async (selector: string) => {
      calls.push(`click ${selector}`);
      if (selector === '#missing') {
        throw new Error('No element found');
      }
    },
  } as unknown as Page;
  return { page, calls };
}

const noop = () => undefined;

suite('common/controlAgent — screen', () => {
  test('resolves click_text before asking, then executes the confirmed actions', async () => {
    const screen = fakeScreen(['a', 'b']);
    const { ask } = scripted([
      '{"action":"click_text","text":"OK","reasoning":"press ok"}',
      '{"x": 40, "y": 60}',
    ]);
    const confirmMessages: string[] = [];
    const session: ScreenSession = { history: [] };
    const result = await runScreenAgent({
      task: 'press ok',
      maxRounds: 5,
      signal: new AbortController().signal,
      autoConfirm: false,
      session,
      ask,
      confirm: async ({ message }) => {
        confirmMessages.push(message);
        return true;
      },
      emit: noop,
      io: screen.io,
    });
    assert.strictEqual(result.outcome, 'complete');
    // The user approved the resolved position, not the label
    assert.match(confirmMessages[0], /40/);
    assert.deepStrictEqual(screen.executed, [
      { action: 'mouse_left_click', x: 40, y: 60, reasoning: 'press ok' },
    ]);
    assert.strictEqual(session.history.length, 1);
  });

  test('declining stops the run without executing', async () => {
    const screen = fakeScreen(['a']);
    const { ask } = scripted(['{"action":"key_press","key":"Enter","reasoning":"r"}']);
    const events: ControlEvent[] = [];
    const result = await runScreenAgent({
      task: 't',
      maxRounds: 5,
      signal: new AbortController().signal,
      autoConfirm: false,
      session: { history: [] },
      ask,
      confirm: async () => false,
      emit: (e) => events.push(e),
      io: screen.io,
    });
    assert.strictEqual(result.outcome, 'stopped');
    assert.strictEqual(screen.executed.length, 0);
    assert.ok(events.some((e) => e.type === 'action-update' && e.status === 'skipped'));
  });

  test('marks actions that left the screen unchanged in the history sent to the model', async () => {
    const screen = fakeScreen(['same', 'same', 'same']);
    const { ask, prompts } = scripted([
      '{"action":"key_press","key":"Enter","reasoning":"submit"}',
      '{"action":"key_press","key":"Tab","reasoning":"next"}',
    ]);
    await runScreenAgent({
      task: 't',
      maxRounds: 5,
      signal: new AbortController().signal,
      autoConfirm: true,
      session: { history: [] },
      ask,
      confirm: async () => true,
      emit: noop,
      io: screen.io,
    });
    assert.match(prompts[1], /Enter.*screen did not change/);
  });

  test('a malformed reply ends with parse-error', async () => {
    const screen = fakeScreen(['a']);
    const result = await runScreenAgent({
      task: 't',
      maxRounds: 3,
      signal: new AbortController().signal,
      autoConfirm: true,
      session: { history: [] },
      ask: async () => '{"action":"mouse_left_click","x":"left"}',
      confirm: async () => true,
      emit: noop,
      io: screen.io,
    });
    assert.strictEqual(result.outcome, 'parse-error');
    assert.strictEqual(screen.executed.length, 0);
  });
});

suite('common/controlAgent — browser', () => {
  test('runs actions, reports failures and blocked URLs, and finishes on DONE', async () => {
    const { page, calls } = fakePage();
    const { ask } = scripted([
      '[{"action":"goto","url":"https://example.com"},{"action":"click","selector":"#missing"},{"action":"goto","url":"file:///etc/passwd"}]',
    ]);
    const events: ControlEvent[] = [];
    const result = await runBrowserAgent({
      task: 't',
      maxRounds: 5,
      signal: new AbortController().signal,
      autoConfirm: true,
      page,
      ask,
      confirm: async () => true,
      emit: (e) => events.push(e),
    });
    assert.strictEqual(result.outcome, 'complete');
    assert.deepStrictEqual(calls, ['goto https://example.com', 'click #missing']);
    const failures = events.filter((e) => e.type === 'action-update' && e.status === 'error');
    assert.strictEqual(failures.length, 2);
  });

  test('asks before every action unless auto-confirm is on', async () => {
    const { page, calls } = fakePage();
    const { ask } = scripted(['[{"action":"goto","url":"https://a.b"},{"action":"back"}]']);
    let asked = 0;
    const result = await runBrowserAgent({
      task: 't',
      maxRounds: 5,
      signal: new AbortController().signal,
      autoConfirm: false,
      page,
      ask,
      confirm: async () => ++asked === 1,
      emit: noop,
    });
    assert.strictEqual(result.outcome, 'stopped');
    assert.strictEqual(asked, 2);
    assert.deepStrictEqual(calls, ['goto https://a.b']);
  });
});
