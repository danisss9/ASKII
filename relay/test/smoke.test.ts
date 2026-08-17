import assert from 'assert';
import test from 'node:test';
import { createApp, startServer } from '../server';

const BASE_HOST = '127.0.0.1';

async function jpost(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: unknown; text: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, json, text };
}

/** Open an SSE stream and collect `count` events (or throw after `timeoutMs`). */
function sseStream(
  base: string,
  path: string,
  count: number,
  timeoutMs = 4000,
): { promise: Promise<Array<{ type: string; data: unknown }>>; abort: () => void } {
  const controller = new AbortController();
  const promise = (async () => {
    const res = await fetch(`${base}${path}`, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.strictEqual(res.status, 200, `SSE ${path} status ${res.status}`);
    assert.ok(res.body, 'no SSE body');
    const events: Array<{ type: string; data: unknown }> = [];
    const decoder = new TextDecoder();
    let buf = '';
    const reader = res.body.getReader();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      while (events.length < count) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value as Uint8Array, { stream: true }).replace(/\r\n/g, '\n');
        let sep: number;
        while ((sep = buf.indexOf('\n\n')) !== -1) {
          const record = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (!record || record.startsWith(':')) continue;
          let type = 'message';
          const dataLines: string[] = [];
          for (const line of record.split('\n')) {
            const colon = line.indexOf(':');
            const field = colon === -1 ? line : line.slice(0, colon);
            const val = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
            if (field === 'event') type = val;
            else if (field === 'data') dataLines.push(val);
          }
          if (dataLines.length) {
            try {
              events.push({ type, data: JSON.parse(dataLines.join('\n')) });
            } catch {
              events.push({ type, data: dataLines.join('\n') });
            }
          }
        }
      }
    } finally {
      clearTimeout(timer);
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
    return events;
  })();
  return { promise, abort: () => controller.abort() };
}

test('relay: pair → createSession → start command reaches device subscriber', async () => {
  const server = await startServer(0, BASE_HOST);
  const base = `http://${BASE_HOST}:${server.port}`;
  try {
    const pair = await jpost(base, '/v1/sessions/pair', {
      deviceName: 'pixel-test',
      apiKey: 'k',
    });
    assert.strictEqual(pair.status, 200);
    const { deviceId, pairingToken } = pair.json as { deviceId: string; pairingToken: string };

    // App subscribes to device commands BEFORE the session is created.
    const sub = sseStream(base, `/v1/devices/${deviceId}/commands?token=${pairingToken}`, 1);

    const created = await jpost(base, '/v1/sessions', {
      deviceId,
      pairingToken,
      mode: 'ask',
      options: { provider: 'askiicloud', model: 'askii-smart' },
      prompt: 'hello from controller',
      apiKey: 'k',
    });
    assert.strictEqual(created.status, 200);
    const { sessionId } = created.json as { sessionId: string };

    const cmds = await sub.promise;
    assert.strictEqual(cmds.length, 1);
    assert.strictEqual(cmds[0].type, 'start');
    const startData = cmds[0].data as { sessionId: string; mode: string; prompt: string };
    assert.strictEqual(startData.sessionId, sessionId);
    assert.strictEqual(startData.mode, 'ask');
    assert.strictEqual(startData.prompt, 'hello from controller');
    sub.abort();
  } finally {
    await server.close();
  }
});

test('relay: app publishes events → controller event subscriber receives them in order', async () => {
  const server = await startServer(0, BASE_HOST);
  const base = `http://${BASE_HOST}:${server.port}`;
  try {
    const pair = await jpost(base, '/v1/sessions/pair', { deviceName: 'pixel-2', apiKey: 'k' });
    const { deviceId, pairingToken } = pair.json as { deviceId: string; pairingToken: string };
    const created = await jpost(base, '/v1/sessions', {
      deviceId,
      pairingToken,
      mode: 'do',
      options: { provider: 'askiicloud', model: 'askii-smart' },
      prompt: 'create a file',
      apiKey: 'k',
    });
    const { sessionId } = created.json as { sessionId: string };

    // App publishes a streaming chunk and a done event to the broker.
    await jpost(
      base,
      `/v1/devices/${deviceId}/sessions/${sessionId}/events?token=${pairingToken}`,
      { type: 'chunk', delta: 'hello ' },
    );
    await jpost(
      base,
      `/v1/devices/${deviceId}/sessions/${sessionId}/events?token=${pairingToken}`,
      { type: 'chunk', delta: 'world' },
    );
    await jpost(
      base,
      `/v1/devices/${deviceId}/sessions/${sessionId}/events?token=${pairingToken}`,
      { type: 'done', summary: 'finished' },
    );

    // Controller subscribes AFTER publishing and should still get all 4 events
    // (session_created was enqueued at create time; the rest were buffered).
    const sub = sseStream(base, `/v1/sessions/${sessionId}/events?token=${pairingToken}`, 4);
    const events = await sub.promise;
    assert.strictEqual(events.length, 4);
    assert.strictEqual(events[0].type, 'session_created');
    assert.strictEqual(events[1].type, 'chunk');
    assert.strictEqual(events[2].type, 'chunk');
    assert.strictEqual(events[3].type, 'done');
    sub.abort();
  } finally {
    await server.close();
  }
});

test('relay: controller reply command is delivered to the device subscriber', async () => {
  const server = await startServer(0, BASE_HOST);
  const base = `http://${BASE_HOST}:${server.port}`;
  try {
    const pair = await jpost(base, '/v1/sessions/pair', { deviceName: 'pixel-3', apiKey: 'k' });
    const { deviceId, pairingToken } = pair.json as { deviceId: string; pairingToken: string };
    const created = await jpost(base, '/v1/sessions', {
      deviceId,
      pairingToken,
      mode: 'ask',
      options: { provider: 'askiicloud', model: 'askii-smart' },
      prompt: 'q',
      apiKey: 'k',
    });
    const { sessionId } = created.json as { sessionId: string };

    const sub = sseStream(base, `/v1/devices/${deviceId}/commands?token=${pairingToken}`, 2);

    await jpost(base, `/v1/sessions/${sessionId}/messages?token=${pairingToken}`, {
      type: 'reply',
      content: 'thanks, continue',
    });

    const cmds = await sub.promise;
    assert.strictEqual(cmds.length, 2);
    assert.strictEqual(cmds[0].type, 'start');
    assert.strictEqual(cmds[1].type, 'reply');
    assert.strictEqual((cmds[1].data as { content: string }).content, 'thanks, continue');
    sub.abort();
  } finally {
    await server.close();
  }
});

test('relay: rejects commands with a wrong pairing token', async () => {
  const server = await startServer(0, BASE_HOST);
  const base = `http://${BASE_HOST}:${server.port}`;
  try {
    const pair = await jpost(base, '/v1/sessions/pair', { deviceName: 'pixel-4', apiKey: 'k' });
    const { deviceId } = pair.json as { deviceId: string; pairingToken: string };
    const created = await jpost(base, '/v1/sessions', {
      deviceId,
      pairingToken: 'WRONG',
      mode: 'ask',
      options: { provider: 'askiicloud', model: 'x' },
      prompt: 'q',
      apiKey: 'k',
    });
    assert.strictEqual(created.status, 403);
  } finally {
    await server.close();
  }
});

// `createApp` is exported and used above via startServer; this asserts it builds
// an Express app without throwing (cheap connectivity guard for non-HTTP tests).
test('relay: createApp returns an Express-like app with routing methods', () => {
  const app = createApp();
  assert.strictEqual(typeof app.get, 'function');
  assert.strictEqual(typeof app.post, 'function');
  assert.strictEqual(typeof app.listen, 'function');
});