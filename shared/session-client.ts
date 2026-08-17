/**
 * Transport-agnostic client for the ASKII remote-session broker.
 *
 * Uses the global `fetch` + `ReadableStream` (available in Node 18+, modern
 * browsers, and Capacitor's WebView). No Node-specific imports, so this is
 * safe to import from the extension, the CLI, and the Android app alike.
 *
 * The broker contract (see `shared/protocol.ts`):
 *   POST   {base}/sessions/pair            -> PairResponse
 *   POST   {base}/sessions                 -> CreateSessionResponse
 *   GET    {base}/sessions/:id/events?token=...   (SSE of SessionEvent)
 *   POST   {base}/sessions/:id/messages?token=... (SessionCommand)
 *   GET    {base}/devices/:id/commands?token=...  (SSE of DeviceCommand, app side)
 */

import { ASKII_CLOUD_URL } from './providers';
import type {
  PairRequest,
  PairResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  SessionEvent,
  SessionCommand,
  DeviceCommand,
} from './protocol';

export interface SessionClientOptions {
  /** Broker base URL. Defaults to the ASKII Cloud API root. */
  baseUrl?: string;
  /** Default auth token (ASKII Cloud API key) appended as `Authorization: Bearer …`. */
  apiKey?: string;
  /** Optional injected fetch (for tests or CapacitorHttp bridging). */
  fetchImpl?: typeof fetch;
}

interface WireEvent {
  event: string;
  data: unknown;
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function withAuth(headers: Record<string, string>, token?: string): Record<string, string> {
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

/**
 * Parse a `text/event-stream` response body into an async iterator of decoded
 * event objects. Handles `\n\n` (and `\r\n\r\n`) record separators and the
 * `event:` / `data:` field conventions.
 */
async function* parseSseStream(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
  signal?: AbortSignal,
): AsyncGenerator<WireEvent> {
  if (!body) return;
  const reader = isWebStream(body)
    ? body.getReader()
    : nodeReaderFromReadable(body as NodeJS.ReadableStream);

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value as Uint8Array, { stream: true });

      // Split complete records (separated by a blank line). Keep the trailing
      // partial in the buffer for the next iteration.
      let sep: number;
      // Normalise CRLF to LF for simpler splitting.
      buffer = buffer.replace(/\r\n/g, '\n');
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const record = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const ev = parseRecord(record);
        if (ev) yield ev;
      }
    }
  } finally {
    if (!isWebStream(body)) {
      (reader as { cancel?: () => void; releaseLock?: () => void }).cancel?.();
    }
  }
}

function isWebStream(s: unknown): s is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== 'undefined' && s instanceof ReadableStream;
}

function nodeReaderFromReadable(stream: NodeJS.ReadableStream): {
  read: () => Promise<{ value: Uint8Array | undefined; done: boolean }>;
  cancel: () => void;
} {
  stream.resume?.();
  return {
    read: () =>
      new Promise((resolve, reject) => {
        const onData = (chunk: Buffer) => {
          cleanup();
          resolve({ value: new Uint8Array(chunk), done: false });
        };
        const onEnd = () => {
          cleanup();
          resolve({ value: undefined, done: true });
        };
        const onError = (err: unknown) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          stream.off('data', onData);
          stream.off('end', onEnd);
          stream.off('error', onError);
        };
        stream.once('data', onData);
        stream.once('end', onEnd);
        stream.once('error', onError);
      }),
    cancel: () => (stream as { destroy?: () => void }).destroy?.(),
  };
}

function parseRecord(record: string): WireEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of record.split('\n')) {
    if (!line || line.startsWith(':')) continue; // comment / heartbeat
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(dataStr) };
  } catch {
    return { event, data: dataStr };
  }
}

/** Decode the event payload delivered by the broker into a SessionEvent. */
function asSessionEvent(ev: WireEvent): SessionEvent {
  return ev.data as SessionEvent;
}

function asDeviceCommand(ev: WireEvent): DeviceCommand {
  return ev.data as DeviceCommand;
}

export class SessionClient {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SessionClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? ASKII_CLOUD_URL;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        'SessionClient: no global fetch available. Pass `fetchImpl` explicitly.',
      );
    }
  }

  // ── Pairing ──────────────────────────────────────────────────────────────

  async pair(req: PairRequest): Promise<PairResponse> {
    return this.postJson<PairResponse>('/sessions/pair', req, req.apiKey);
  }

  // ── Session lifecycle (controller side) ──────────────────────────────────

  async createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.postJson<CreateSessionResponse>('/sessions', req, req.apiKey);
  }

  async send(sessionId: string, token: string, cmd: SessionCommand): Promise<void> {
    const res = await this.fetchImpl(
      joinUrl(this.baseUrl, `/sessions/${encodeURIComponent(sessionId)}/messages`),
      {
        method: 'POST',
        headers: withAuth({ 'Content-Type': 'application/json' }, token),
        body: JSON.stringify(cmd),
      },
    );
    if (!res.ok) throw await httpError(res);
  }

  /** SSE stream of events for a session (controller watches / approves). */
  async *events(
    sessionId: string,
    token: string,
    signal?: AbortSignal,
  ): AsyncGenerator<SessionEvent, void, unknown> {
    const url = joinUrl(
      this.baseUrl,
      `/sessions/${encodeURIComponent(sessionId)}/events`,
    );
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: withAuth({ Accept: 'text/event-stream' }, token),
      signal,
    });
    if (!res.ok) throw await httpError(res);
    for await (const ev of parseSseStream(res.body as ReadableStream<Uint8Array> | null, signal)) {
      yield asSessionEvent(ev);
    }
  }

  // ── Subscriber stream (app side) ──────────────────────────────────────────

  /** SSE stream of commands the controller sends to a paired device (app side). */
  async *commands(
    deviceId: string,
    pairingToken: string,
    signal?: AbortSignal,
  ): AsyncGenerator<DeviceCommand, void, unknown> {
    const url = joinUrl(
      this.baseUrl,
      `/devices/${encodeURIComponent(deviceId)}/commands`,
    );
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: withAuth({ Accept: 'text/event-stream' }, pairingToken),
      signal,
    });
    if (!res.ok) throw await httpError(res);
    for await (const ev of parseSseStream(res.body as ReadableStream<Uint8Array> | null, signal)) {
      yield asDeviceCommand(ev);
    }
  }

  /**
   * Publish a session event from the executor (the Android app) back to the
   * broker, which fans it out to the controller's event stream. App side only.
   */
  async publishEvent(
    deviceId: string,
    sessionId: string,
    pairingToken: string,
    event: SessionEvent,
  ): Promise<void> {
    const url = joinUrl(
      this.baseUrl,
      `/devices/${encodeURIComponent(deviceId)}/sessions/${encodeURIComponent(sessionId)}/events`,
    );
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json' }, pairingToken),
      body: JSON.stringify(event),
    });
    if (!res.ok) throw await httpError(res);
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async postJson<T>(path: string, body: unknown, token?: string): Promise<T> {
    const res = await this.fetchImpl(joinUrl(this.baseUrl, path), {
      method: 'POST',
      headers: withAuth({ 'Content-Type': 'application/json' }, token ?? this.apiKey),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(res);
    return (await res.json()) as T;
  }
}

async function httpError(res: Response): Promise<Error> {
  let detail = `${res.status} ${res.statusText}`;
  try {
    const text = await res.text();
    if (text) detail = `${detail}: ${text.slice(0, 400)}`;
  } catch {
    // ignore — keep the simpler status line
  }
  return new Error(detail);
}