import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { suite, test } from 'mocha';
import { runDoAgent, type DoConfirmRequest, type DoEvent } from '../common/doAgent';
import { type ChatMessage, type ChatReply } from '../common/providers';
import {
  getWritePathPolicy,
  parseWorkspaceResponse,
  runShellCommand,
  sandboxPath,
} from '../common/workspace';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'askii-do-'));
}

/** A scripted model: returns the replies in order, then "[]". */
function scriptedChat(replies: Array<string | ChatReply>) {
  let i = 0;
  return async (): Promise<ChatReply> => {
    const next = replies[i++] ?? '[]';
    return typeof next === 'string' ? { text: next, truncated: false } : next;
  };
}

suite('common/workspace — sandboxPath and write policy', () => {
  test('blocks ../ and absolute escapes', () => {
    const root = tmpWorkspace();
    assert.throws(() => sandboxPath(root, '../outside.txt'), /Path traversal blocked/);
    assert.throws(() => sandboxPath(root, path.join(os.tmpdir(), 'x.txt')), /Path traversal blocked/);
    assert.strictEqual(sandboxPath(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  });

  test('blocks a symlink inside the workspace that points outside it', function () {
    const root = tmpWorkspace();
    const outside = tmpWorkspace();
    try {
      fs.symlinkSync(outside, path.join(root, 'link'), 'dir');
    } catch {
      this.skip(); // no symlink permission (Windows without developer mode)
    }
    assert.throws(() => sandboxPath(root, 'link/secret.txt'), /resolves outside the workspace/);
    assert.throws(() => sandboxPath(root, 'link'), /resolves outside the workspace/);
  });

  test('blocks writing through a dangling symlink', function () {
    const root = tmpWorkspace();
    try {
      fs.symlinkSync(path.join(os.tmpdir(), `askii-missing-${Date.now()}`), path.join(root, 'dangling'));
    } catch {
      this.skip();
    }
    assert.throws(() => sandboxPath(root, 'dangling'), /dangling symlink/);
  });

  test('allows symlinks that stay inside the workspace', function () {
    const root = tmpWorkspace();
    fs.mkdirSync(path.join(root, 'real'));
    try {
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'), 'dir');
    } catch {
      this.skip();
    }
    assert.strictEqual(sandboxPath(root, 'alias/x.ts'), path.join(root, 'alias', 'x.ts'));
  });

  test('classifies .git/.askii as blocked and editor/hook folders as sensitive', () => {
    const root = tmpWorkspace();
    const at = (p: string) => getWritePathPolicy(root, path.join(root, p));
    assert.strictEqual(at('.git/hooks/pre-commit'), 'blocked');
    assert.strictEqual(at('sub/.git/config'), 'blocked');
    assert.strictEqual(at('.askii/backups/x'), 'blocked');
    assert.strictEqual(at('.vscode/tasks.json'), 'sensitive');
    assert.strictEqual(at('.husky/pre-push'), 'sensitive');
    assert.strictEqual(at('src/.gitignore'), 'allowed');
    assert.strictEqual(at('src/index.ts'), 'allowed');
  });

  test('parseWorkspaceResponse reports unknown action types', () => {
    const parsed = parseWorkspaceResponse('[{"type":"view","path":"a"},{"type":"explode"},{"x":1}]');
    assert.deepStrictEqual(parsed?.actions, [{ type: 'view', path: 'a' }]);
    assert.deepStrictEqual(parsed?.ignoredTypes, ['explode', '(missing type)']);
    assert.strictEqual(parseWorkspaceResponse('no array'), null);
  });
});

suite('common/workspace — runShellCommand', () => {
  test('returns stdout and stderr, and the exit status', async () => {
    const ok = await runShellCommand('echo out && echo err 1>&2', os.tmpdir());
    assert.strictEqual(ok.ok, true);
    assert.match(ok.output, /out/);
    assert.match(ok.output, /err/);
    const failed = await runShellCommand('exit 3', os.tmpdir());
    assert.strictEqual(failed.ok, false);
    assert.match(failed.output, /code 3/);
  });

  test('kills the command on timeout and on abort', async function () {
    this.timeout(10_000);
    const sleep = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > NUL' : 'sleep 30';
    const started = Date.now();
    const timedOut = await runShellCommand(sleep, os.tmpdir(), { timeoutMs: 300 });
    assert.strictEqual(timedOut.timedOut, true);
    assert.strictEqual(timedOut.ok, false);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const aborted = await runShellCommand(sleep, os.tmpdir(), { signal: controller.signal });
    assert.strictEqual(aborted.ok, false);
    assert.ok(Date.now() - started < 8000);
  });
});

suite('common/doAgent — runDoAgent', () => {
  function baseOptions(root: string, replies: Array<string | ChatReply>) {
    const events: DoEvent[] = [];
    const confirms: DoConfirmRequest[] = [];
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
    ];
    return {
      events,
      confirms,
      messages,
      options: {
        workspaceRoot: root,
        messages,
        maxRounds: 5,
        signal: new AbortController().signal,
        autoConfirm: true,
        chat: scriptedChat(replies),
        confirm: async (request: DoConfirmRequest) => {
          confirms.push(request);
          return true;
        },
        emit: (event: DoEvent) => events.push(event),
      },
    };
  }

  test('writes files, feeds results back and finishes on []', async () => {
    const root = tmpWorkspace();
    const { options, messages } = baseOptions(root, [
      '[{"type":"create","path":"a.txt","content":"hi"}]',
      '[]',
    ]);
    const result = await runDoAgent(options);
    assert.strictEqual(result.outcome, 'complete');
    assert.strictEqual(result.completedActions, 1);
    assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf-8'), 'hi');
    assert.match(messages[3].content, /Action results/);
  });

  test('never writes into .git even with auto-confirm', async () => {
    const root = tmpWorkspace();
    const { options, confirms, events } = baseOptions(root, [
      '[{"type":"write","path":".git/hooks/pre-commit","content":"rm -rf /"}]',
    ]);
    await runDoAgent(options);
    assert.ok(!fs.existsSync(path.join(root, '.git', 'hooks', 'pre-commit')));
    assert.strictEqual(confirms.length, 0);
    assert.ok(events.some((e) => e.type === 'action-end' && e.status === 'blocked'));
  });

  test('sensitive paths and run commands are confirmed even with auto-confirm', async () => {
    const root = tmpWorkspace();
    const { options, confirms } = baseOptions(root, [
      '[{"type":"write","path":".vscode/tasks.json","content":"{}"},{"type":"write","path":"ok.txt","content":"x"},{"type":"run","command":"echo hi"}]',
    ]);
    await runDoAgent(options);
    assert.deepStrictEqual(
      confirms.map((c) => c.kind),
      ['sensitive', 'run'],
    );
  });

  test('a declined confirmation skips the action', async () => {
    const root = tmpWorkspace();
    const { options } = baseOptions(root, ['[{"type":"create","path":"no.txt","content":"x"}]']);
    const result = await runDoAgent({ ...options, autoConfirm: false, confirm: async () => false });
    assert.strictEqual(result.completedActions, 0);
    assert.ok(!fs.existsSync(path.join(root, 'no.txt')));
  });

  test('a truncated reply is not applied and the model is asked for smaller steps', async () => {
    const root = tmpWorkspace();
    const { options, messages } = baseOptions(root, [
      { text: '[{"type":"write","path":"big.txt","content":"partial"}]', truncated: true },
      '[]',
    ]);
    await runDoAgent(options);
    assert.ok(!fs.existsSync(path.join(root, 'big.txt')));
    assert.match(messages[3].content, /cut off/);
  });

  test('unknown action types are reported back to the model', async () => {
    const root = tmpWorkspace();
    const { options, messages, events } = baseOptions(root, ['[{"type":"teleport"}]', '[]']);
    await runDoAgent(options);
    assert.ok(events.some((e) => e.type === 'notice'));
    assert.match(messages[3].content, /teleport/);
  });

  test('stops at max rounds and when aborted', async () => {
    const root = tmpWorkspace();
    const looping = Array.from({ length: 10 }, () => '[{"type":"list","path":"."}]');
    const { options } = baseOptions(root, looping);
    const capped = await runDoAgent({ ...options, maxRounds: 2 });
    assert.strictEqual(capped.outcome, 'max-rounds');

    const controller = new AbortController();
    controller.abort();
    const aborted = await runDoAgent({ ...baseOptions(root, looping).options, signal: controller.signal });
    assert.strictEqual(aborted.outcome, 'aborted');
  });
});
