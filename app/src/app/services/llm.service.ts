import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import { AskiiHttp } from '../plugins/askii-http.plugin';
import type { AppConfig } from './config.service';
import type { ChatMessage } from '../models/chat';

interface QueueItem {
  delta?: string;
  done?: boolean;
  error?: string;
}

/**
 * LlmService — the app's single entry point for talking to LLMs.
 *
 * It always goes through the `AskiiHttp` Capacitor plugin:
 *  - on native Android, the Kotlin plugin streams via OkHttp (bypasses CORS);
 *  - on web / `ionic serve`, the web implementation streams via `fetch`.
 *
 * The plugin emits incremental chunks (`onChunk`) and a terminal `onDone`; this
 * service surfaces them as a plain async generator of text deltas, so callers
 * can render tokens as they arrive.
 */
@Injectable({ providedIn: 'root' })
export class LlmService {
  private streamCounter = 0;

  /** Stream a chat completion. Yields text deltas as they arrive. */
  async *streamChat(
    cfg: AppConfig,
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<string, void, unknown> {
    const streamId = `s${++this.streamCounter}_${Date.now()}`;

    const queue: QueueItem[] = [];
    let resolveNext: ((v: QueueItem) => void) | null = null;
    const push = (item: QueueItem): void => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(item);
      } else {
        queue.push(item);
      }
    };

    let chunkHandle: PluginListenerHandle | undefined;
    let doneHandle: PluginListenerHandle | undefined;
    const abort = (): void => {
      AskiiHttp.cancel(streamId).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort);

    try {
      chunkHandle = await AskiiHttp.addListener('onChunk', (e: unknown) => {
        const ev = e as { streamId: string; delta: string };
        if (ev.streamId === streamId) push({ delta: ev.delta });
      });
      doneHandle = await AskiiHttp.addListener('onDone', (e: unknown) => {
        const ev = e as { streamId: string };
        if (ev.streamId === streamId) push({ done: true });
      });

      const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));

      // The plugin resolves once the stream is *started* (native) or scheduled
      // (web fire-and-forget). Chunks arrive asynchronously via the listeners.
      AskiiHttp.streamChat({
        streamId,
        provider: cfg.provider,
        model: cfg.model,
        apiKey:
          cfg.provider === 'askiicloud'
            ? cfg.apiKey
            : (cfg.keys as Record<string, string>)[cfg.provider] ?? '',
        baseUrl: cfg.provider === 'askiicloud' ? cfg.brokerUrl : undefined,
        ollamaUrl: cfg.ollamaUrl,
        lmStudioUrl: cfg.lmStudioUrl,
        openaiUrl: cfg.openaiUrl || undefined,
        messages: apiMessages,
      }).catch((err: unknown) => push({ error: err instanceof Error ? err.message : String(err) }));

      while (true) {
        const next: QueueItem =
          queue.length > 0 ? (queue.shift() as QueueItem) : await new Promise<QueueItem>((r) => (resolveNext = r));
        if (next.error) throw new Error(next.error);
        if (next.done) break;
        if (next.delta) yield next.delta;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      await chunkHandle?.remove();
      await doneHandle?.remove();
    }
  }

  /** Non-streaming completion (used by Note classification, Edit, etc.). */
  async complete(cfg: AppConfig, messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
    let full = '';
    for await (const delta of this.streamChat(cfg, messages, signal)) full += delta;
    return full;
  }

  /**
   * Non-streaming completion with an image attached to the last user message
   * (for vision-capable models — browser/control agent rounds). The image
   * is a raw base64 PNG string (no `data:` prefix).
   */
  async completeWithImage(
    cfg: AppConfig,
    system: string,
    prompt: string,
    imageBase64: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const streamId = `img_${++this.streamCounter}_${Date.now()}`;
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];

    let full = '';
    for await (const delta of this.streamChatRaw(cfg, messages, streamId, imageBase64, signal)) {
      full += delta;
    }
    return full;
  }

  /** Low-level stream with explicit streamId + image (used by completeWithImage). */
  private async *streamChatRaw(
    cfg: AppConfig,
    messages: ChatMessage[],
    streamId: string,
    imageBase64: string | undefined,
    signal?: AbortSignal,
  ): AsyncGenerator<string, void, unknown> {
    const queue: QueueItem[] = [];
    let resolveNext: ((v: QueueItem) => void) | null = null;
    const push = (item: QueueItem): void => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(item);
      } else {
        queue.push(item);
      }
    };

    let chunkHandle: PluginListenerHandle | undefined;
    let doneHandle: PluginListenerHandle | undefined;
    const abort = (): void => {
      AskiiHttp.cancel(streamId).catch(() => undefined);
    };
    signal?.addEventListener('abort', abort);

    try {
      chunkHandle = await AskiiHttp.addListener('onChunk', (e: unknown) => {
        const ev = e as { streamId: string; delta: string };
        if (ev.streamId === streamId) push({ delta: ev.delta });
      });
      doneHandle = await AskiiHttp.addListener('onDone', (e: unknown) => {
        const ev = e as { streamId: string };
        if (ev.streamId === streamId) push({ done: true });
      });

      const apiMessages = messages.map((m) => ({ role: m.role, content: m.content }));

      AskiiHttp.streamChat({
        streamId,
        provider: cfg.provider,
        model: cfg.model,
        apiKey:
          cfg.provider === 'askiicloud'
            ? cfg.apiKey
            : (cfg.keys as Record<string, string>)[cfg.provider] ?? '',
        baseUrl: cfg.provider === 'askiicloud' ? cfg.brokerUrl : undefined,
        ollamaUrl: cfg.ollamaUrl,
        lmStudioUrl: cfg.lmStudioUrl,
        openaiUrl: cfg.openaiUrl || undefined,
        messages: apiMessages,
        imageBase64,
      }).catch((err: unknown) => push({ error: err instanceof Error ? err.message : String(err) }));

      while (true) {
        const next: QueueItem =
          queue.length > 0 ? (queue.shift() as QueueItem) : await new Promise<QueueItem>((r) => (resolveNext = r));
        if (next.error) throw new Error(next.error);
        if (next.done) break;
        if (next.delta) yield next.delta;
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      await chunkHandle?.remove();
      await doneHandle?.remove();
    }
  }

  get isNative(): boolean {
    return Capacitor.isNativePlatform();
  }
}