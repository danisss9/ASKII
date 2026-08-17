import type { PluginListenerHandle } from '@capacitor/core';
import type { AskiiHttpPlugin, ChatStreamOptions } from './askii-http.plugin';

/**
 * AskiiHttpWeb — the web fallback. Implements streaming with the standard
 * `fetch` + `ReadableStream` so `ionic serve` works. In the production Android
 * WebView this would hit CORS; the native Kotlin plugin replaces it on device.
 *
 * Events are delivered through Capacitor's `notifyListeners`/`addListener`
 * transport (event names `onChunk` and `onDone`), mirroring the native plugin.
 */
interface ChunkEvent {
  streamId: string;
  delta: string;
}
interface DoneEvent {
  streamId: string;
}

export class AskiiHttpWeb implements AskiiHttpPlugin {
  private listeners: Record<string, Set<(e: unknown) => void>> = {
    onChunk: new Set(),
    onDone: new Set(),
  };
  private controllers = new Map<string, AbortController>();

  // Capacitor web plugins receive `addListener` calls — wire them to our sets.
  // (The proxy created by `registerPlugin` routes addListener here.)
  async addListener(
    eventName: 'onChunk' | 'onDone',
    listener: (e: unknown) => void,
  ): Promise<PluginListenerHandle> {
    const set = this.listeners[eventName] ?? (this.listeners[eventName] = new Set());
    set.add(listener);
    return {
      remove: async (): Promise<void> => {
        set.delete(listener);
      },
    };
  }

  async removeAllListeners(): Promise<void> {
    this.listeners.onChunk.clear();
    this.listeners.onDone.clear();
  }

  private emit(eventName: string, payload: unknown): void {
    (this.listeners[eventName] ?? []).forEach((l) => {
      try {
        l(payload);
      } catch {
        /* ignore */
      }
    });
  }

  async streamChat(opts: ChatStreamOptions): Promise<void> {
    const ac = new AbortController();
    this.controllers.set(opts.streamId, ac);
    // Fire-and-forget: resolve immediately so the service generator can consume
    // chunks as they arrive; emit `onChunk`/`onDone` asynchronously.
    void webFetchStream(
      opts,
      ac.signal,
      (delta) => this.emit('onChunk', { streamId: opts.streamId, delta } satisfies ChunkEvent),
    )
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.emit('onChunk', { streamId: opts.streamId, delta: `\n[stream error: ${message}]` } satisfies ChunkEvent);
      })
      .finally(() => {
        this.controllers.delete(opts.streamId);
        this.emit('onDone', { streamId: opts.streamId } satisfies DoneEvent);
      });
  }

  async cancel(streamId: string): Promise<void> {
    this.controllers.get(streamId)?.abort();
  }
}

/** Build the right request per-provider and stream deltas via `onChunk`. */
async function webFetchStream(
  opts: ChatStreamOptions,
  signal: AbortSignal,
  onChunk: (delta: string) => void,
): Promise<void> {
  const isAnthropic =
    opts.provider === 'anthropic' ||
    (opts.provider === 'opencodego' && /^(qwen|minimax)/i.test(opts.model.trim()));
  const hasImage = !!opts.imageBase64;

  if (opts.provider === 'ollama') {
    const url = (opts.ollamaUrl ?? 'http://localhost:11434').replace(/\/$/, '') + '/api/chat';
    const messages = opts.messages.map((m, i) => {
      if (hasImage && i === opts.messages.length - 1 && m.role === 'user') {
        return { ...m, images: [opts.imageBase64] };
      }
      return m;
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: opts.model, stream: true, messages }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}`);
    for await (const delta of ndjsonDelta(res.body, (o) => o?.message?.content ?? '')) onChunk(delta);
    return;
  }

  if (isAnthropic) {
    const base =
      opts.provider === 'opencodego'
        ? 'https://opencode.ai/zen/go' // anthropic SDK drops trailing /v1
        : 'https://api.anthropic.com/v1';
    const url = (opts.baseUrl ?? base).replace(/\/$/, '') + '/messages';
    const system = opts.messages.find((m) => m.role === 'system')?.content;
    const rawMsgs = opts.messages.filter((m) => m.role !== 'system');
    // For vision: convert last user message to Anthropic content blocks
    const msgs = hasImage
      ? rawMsgs.map((m, i) => {
          if (i === rawMsgs.length - 1 && m.role === 'user') {
            return {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: opts.imageBase64 } },
                { type: 'text', text: m.content },
              ],
            };
          }
          return m;
        })
      : rawMsgs;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': opts.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 4096,
        stream: true,
        ...(system ? { system } : {}),
        messages: msgs,
      }),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`Anthropic ${res.status}`);
    for await (const delta of sseDelta(res.body, (o) => (o?.type === 'content_block_delta' && o?.delta?.type === 'text_delta' ? o.delta.text : ''))) {
      onChunk(delta);
    }
    return;
  }

  // OpenAI-compatible (askiicloud / openai / opencodego non-anthropic / lmstudio)
  let base: string;
  if (opts.provider === 'lmstudio') {
    base = (opts.lmStudioUrl ?? 'http://localhost:1234')
      .replace(/^ws:\/\//i, 'http://')
      .replace(/\/$/, '');
    if (!base.endsWith('/v1')) base += '/v1';
  } else if (opts.provider === 'openai') {
    base = (opts.openaiUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  } else if (opts.provider === 'opencodego') {
    base = (opts.baseUrl ?? 'https://opencode.ai/zen/go/v1').replace(/\/$/, '');
  } else {
    // askiicloud
    base = (opts.baseUrl ?? 'https://api.askii.dev/v1').replace(/\/$/, '');
  }
  const url = base + '/chat/completions';
  // For vision: convert last user message to OpenAI multimodal content
  const messages = hasImage
    ? opts.messages.map((m, i) => {
        if (i === opts.messages.length - 1 && m.role === 'user') {
          return {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${opts.imageBase64}` } },
              { type: 'text', text: m.content },
            ],
          };
        }
        return m;
      })
    : opts.messages;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey ?? ''}`,
    },
    body: JSON.stringify({ model: opts.model, stream: true, messages }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`OpenAI-compat ${res.status}`);
  for await (const delta of sseDelta(res.body, (o) => o?.choices?.[0]?.delta?.content ?? '')) {
    onChunk(delta);
  }
}

/** Parse an SSE body, yielding the text delta resolved by `pick`. */
async function* sseDelta(
  body: ReadableStream<Uint8Array>,
  pick: (o: any) => string,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) !== -1) {
      const record = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of record.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const obj = JSON.parse(payload);
          const delta = pick(obj);
          if (delta) yield delta;
        } catch {
          /* ignore malformed */
        }
      }
    }
  }
}

/** Parse NDJSON (Ollama) — one JSON object per line. */
async function* ndjsonDelta(
  body: ReadableStream<Uint8Array>,
  pick: (o: any) => string,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const delta = pick(obj);
        if (delta) yield delta;
      } catch {
        /* ignore */
      }
    }
  }
}