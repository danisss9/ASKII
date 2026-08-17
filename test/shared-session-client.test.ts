import assert from 'assert';
import test from 'node:test';
import { SessionClient } from '../shared/session-client';
import type {
  PairResponse,
  CreateSessionResponse,
  SessionEvent,
  DeviceCommand,
} from '../shared/protocol';

/** Minimal in-memory SSE body built from a sequence of wire records. */
function sseBody(records: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = records.map(
    (r) =>
      encoder.encode(
        `event: ${r.event}\ndata: ${JSON.stringify(r.data)}\n\n`,
      ),
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** A fetch impl that mirrors a tiny session broker for the tests below. */
function makeBrokerFetch(): typeof fetch {
  const sessions = new Map<string, Array<{ event: string; data: SessionEvent }>>();
  const devices = new Map<string, Array<{ event: string; data: DeviceCommand }>>();
  let sessionCounter = 0;
  let deviceCounter = 0;

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.endsWith('/sessions/pair') && method === 'POST') {
      const deviceId = `dev-${++deviceCounter}`;
      return new Response(
        JSON.stringify({
          deviceId,
          pairingToken: `tok-${deviceId}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        } satisfies PairResponse),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    if (url.endsWith('/sessions') && method === 'POST') {
      const sessionId = `ses-${++sessionCounter}`;
      const queue: Array<{ event: string; data: SessionEvent }> = [
        { event: 'session_created', data: { type: 'session_created', sessionId } },
      ];
      sessions.set(sessionId, queue);
      return new Response(
        JSON.stringify({ sessionId } satisfies CreateSessionResponse),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const eventsMatch = url.match(/\/sessions\/([^/]+)\/events$/);
    if (eventsMatch && method === 'GET') {
      const id = eventsMatch[1];
      const queue = sessions.get(id) ?? [];
      return new Response(sseBody(queue), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    const cmdMatch = url.match(/\/devices\/([^/]+)\/commands$/);
    if (cmdMatch && method === 'GET') {
      const id = cmdMatch[1];
      const queue = devices.get(id) ?? [];
      return new Response(sseBody(queue), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }

    if (url.match(/\/devices\/([^/]+)\/sessions\/([^/]+)\/events$/) && method === 'POST') {
      // App → broker event publish: capture into the session queue so a later
      // controller SSE drain sees it.
      const m = url.match(/\/sessions\/([^/]+)\/events$/);
      const sid = m![1];
      const body = JSON.parse(init?.body as string);
      const queue = sessions.get(sid) ?? (sessions.set(sid, []), sessions.get(sid)!);
      queue.push({ event: body.type, data: body });
      return new Response(null, { status: 204 });
    }

    if (url.includes('/messages') && method === 'POST') {
      return new Response(null, { status: 204 });
    }

    return new Response('not found', { status: 404 });
  };
}

test('SessionClient.pair resolves the pairing response', async () => {
  const client = new SessionClient({ baseUrl: 'http://test', fetchImpl: makeBrokerFetch() });
  const res = await client.pair({ deviceName: 'pixel', apiKey: 'k' });
  assert.ok(res.deviceId.startsWith('dev-'));
  assert.ok(res.pairingToken.startsWith('tok-'));
});

test('SessionClient.createSession + events streams session_created then done', async () => {
  const client = new SessionClient({ baseUrl: 'http://test', fetchImpl: makeBrokerFetch() });
  const { sessionId } = await client.createSession({
    deviceId: 'dev-1',
    pairingToken: 'tok-dev-1',
    mode: 'ask',
    options: { provider: 'askiicloud', model: 'askii-smart' },
    prompt: 'hello',
    apiKey: 'k',
  });
  // Executor publishes the terminal done event.
  await client.publishEvent('dev-1', sessionId, 'tok-dev-1', {
    type: 'done',
    summary: 'ok',
  });
  const seen: SessionEvent[] = [];
  for await (const ev of client.events(sessionId, 't')) seen.push(ev);
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].type, 'session_created');
  assert.strictEqual(seen[1].type, 'done');
});

test('SessionClient.commands yields nothing for an idle device', async () => {
  const client = new SessionClient({ baseUrl: 'http://test', fetchImpl: makeBrokerFetch() });
  const cmds: DeviceCommand[] = [];
  const ac = new AbortController();
  // Abort immediately so the empty SSE stream resolves quickly.
  setTimeout(() => ac.abort(), 5);
  try {
    for await (const c of client.commands('dev-nope', 'tok', ac.signal)) cmds.push(c);
  } catch {
    // An abort can surface as an error depending on timing; that's fine.
  }
  assert.strictEqual(cmds.length, 0);
});

test('SessionClient.publishEvent (app side) fans out to the controller event stream', async () => {
  const client = new SessionClient({ baseUrl: 'http://test', fetchImpl: makeBrokerFetch() });
  const { sessionId } = await client.createSession({
    deviceId: 'dev-1',
    pairingToken: 'tok-dev-1',
    mode: 'ask',
    options: { provider: 'askiicloud', model: 'askii-smart' },
    prompt: 'hi',
    apiKey: 'k',
  });
  // Executor (app) publishes an assistant message event.
  await client.publishEvent('dev-1', sessionId, 'tok-dev-1', {
    type: 'message',
    role: 'assistant',
    content: 'hello back',
  });
  // Controller drains the event stream AFTER the publish and should still see
  // the queued session_created + message events in order.
  const seen: SessionEvent[] = [];
  for await (const ev of client.events(sessionId, 't')) seen.push(ev);
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].type, 'session_created');
  assert.strictEqual(seen[1].type, 'message');
  if (seen[1].type === 'message') assert.strictEqual(seen[1].content, 'hello back');
});