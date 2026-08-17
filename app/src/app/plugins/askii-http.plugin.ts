import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/**
 * AskiiHttp — a native networking plugin (OkHttp) that bypasses the WebView's
 * Same-Origin / CORS restrictions and provides true token streaming from cloud
 * providers (OpenAI-compatible / Anthropic-compatible / Ollama / LM Studio).
 *
 * The TypeScript interface below is what the Angular services call. The native
 * Kotlin implementation (Android) is part of a later phase; until it lands, a
 * web implementation falls back to the standard `fetch` API (which is fine for
 * `ionic serve` but will hit CORS in the production WebView).
 */

export interface ChatStreamOptions {
  /** Which provider backend to talk to. */
  provider: string;
  model: string;
  /** Cloud API key (for cloud providers). */
  apiKey?: string;
  /** OpenAI-compatible base URL (with /v1). */
  baseUrl?: string;
  /** Ollama host URL. */
  ollamaUrl?: string;
  /** LM Studio base URL (http). */
  lmStudioUrl?: string;
  /** OpenAI-compatible base URL override (Azure, etc.). */
  openaiUrl?: string;
  /** Chat history (last message is the current user turn). */
  messages: Array<{ role: string; content: string }>;
  /** Identifier for this stream; emitted back on `onChunk` / `onDone`. */
  streamId: string;
  /** Optional base64 PNG (no data: prefix) to attach to the last user message
   *  for vision-capable models (browser/control modes). */
  imageBase64?: string;
}

export interface AskiiHttpPlugin {
  /** Start a streaming chat. Emits `onChunk` { streamId, delta } and `onDone` { streamId }. */
  streamChat(opts: ChatStreamOptions): Promise<void>;
  /** Cancel an in-flight stream by streamId. */
  cancel(streamId: string): Promise<void>;
  // Capacitor event listener plumbing (provided by the native bridge at runtime).
  addListener(eventName: 'onChunk' | 'onDone', listener: (e: unknown) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

/**
 * Registered plugin handle. On native (Android), Capacitor proxies to the
 * Kotlin bridge; on web, it falls back to the web implementation below.
 */
export const AskiiHttp = registerPlugin<AskiiHttpPlugin>('AskiiHttp', {
  web: () => import('./askii-http.web').then((m) => new m.AskiiHttpWeb()),
});