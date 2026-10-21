import assert from 'assert';
import * as http from 'http';
import { type AddressInfo } from 'net';
import { suite, test } from 'mocha';
import {
  RequestTimeoutError,
  complete,
  isAbortError,
  isRetryableError,
  retryLLMCall,
} from '../common/providers';

function statusError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

/** An OpenAI-compatible server stub; `handler` decides each response. */
async function withServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, hit: number) => void,
  run: (baseURL: string, hits: () => number) => Promise<void>,
): Promise<void> {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => handler(req, res, hits));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, () => hits);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function completion(text: string, finish = 'stop'): string {
  return JSON.stringify({
    id: 'x',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }],
  });
}

suite('common/providers — retry policy', () => {
  test('retries network errors, 429 and 5xx — never 4xx or aborts', () => {
    assert.strictEqual(isRetryableError(statusError(429)), true);
    assert.strictEqual(isRetryableError(statusError(503)), true);
    assert.strictEqual(isRetryableError(statusError(408)), true);
    assert.strictEqual(isRetryableError(statusError(401)), false);
    assert.strictEqual(isRetryableError(statusError(400)), false);
    assert.strictEqual(isRetryableError(Object.assign(new Error('x'), { code: 'ECONNRESET' })), true);
    assert.strictEqual(isRetryableError(new TypeError('fetch failed')), true);
    assert.strictEqual(isRetryableError(Object.assign(new Error('a'), { name: 'AbortError' })), false);
    assert.strictEqual(isRetryableError(new RequestTimeoutError(1000)), false);
  });

  test('retryLLMCall backs off, gives up after the limit and skips non-retryable errors', async () => {
    let calls = 0;
    const delays: number[] = [];
    await assert.rejects(
      retryLLMCall(
        async () => {
          calls++;
          throw statusError(503);
        },
        { retries: 2, baseDelayMs: 1, onRetry: (_a, _e, d) => delays.push(d) },
      ),
    );
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(delays, [1, 2]);

    calls = 0;
    await assert.rejects(
      retryLLMCall(
        async () => {
          calls++;
          throw statusError(401);
        },
        { retries: 2, baseDelayMs: 1 },
      ),
    );
    assert.strictEqual(calls, 1);
  });
});

suite('common/providers — complete()', () => {
  test('returns the reply and flags token-limit truncation', async () => {
    await withServer(
      (_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(completion('partial', 'length'));
      },
      async (baseURL) => {
        const reply = await complete(
          { platform: 'openai', model: 'm', apiKey: 'k', baseURL },
          { messages: [{ role: 'user', content: 'hi' }] },
        );
        assert.deepStrictEqual(reply, { text: 'partial', truncated: true });
      },
    );
  });

  test('retries a 503 once and then succeeds', async () => {
    await withServer(
      (_req, res, hit) => {
        res.setHeader('content-type', 'application/json');
        if (hit === 1) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: { message: 'busy' } }));
        } else {
          res.end(completion('ok'));
        }
      },
      async (baseURL, hits) => {
        const reply = await complete(
          { platform: 'openai', model: 'm', apiKey: 'k', baseURL },
          { messages: [{ role: 'user', content: 'hi' }], onRetry: () => undefined },
        );
        assert.strictEqual(reply.text, 'ok');
        assert.strictEqual(hits(), 2);
      },
    );
  });

  test('does not retry a 401', async () => {
    await withServer(
      (_req, res) => {
        res.statusCode = 401;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'bad key' } }));
      },
      async (baseURL, hits) => {
        await assert.rejects(
          complete(
            { platform: 'openai', model: 'm', apiKey: 'k', baseURL },
            { messages: [{ role: 'user', content: 'hi' }] },
          ),
        );
        assert.strictEqual(hits(), 1);
      },
    );
  });

  test('aborting tears down an in-flight request', async function () {
    this.timeout(5000);
    await withServer(
      () => {
        /* never respond */
      },
      async (baseURL) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 100);
        const started = Date.now();
        await assert.rejects(
          complete(
            { platform: 'openai', model: 'm', apiKey: 'k', baseURL },
            { messages: [{ role: 'user', content: 'hi' }], signal: controller.signal },
          ),
          (error: unknown) => isAbortError(error),
        );
        assert.ok(Date.now() - started < 2000);
      },
    );
  });

  test('times out a request that never answers', async function () {
    this.timeout(5000);
    await withServer(
      () => {
        /* never respond */
      },
      async (baseURL) => {
        await assert.rejects(
          complete(
            { platform: 'ollama', model: 'm', baseURL: baseURL.replace(/\/v1$/, '') },
            { messages: [{ role: 'user', content: 'hi' }], timeoutMs: 200 },
          ),
          RequestTimeoutError,
        );
      },
    );
  });
});
