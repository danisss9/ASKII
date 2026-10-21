import { randomUUID } from 'crypto';
import { Ollama, type Message as OllamaMessage } from 'ollama';
import { type ChatMessageInput, LMStudioClient } from '@lmstudio/sdk';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export const PLATFORM_IDS = [
  'ollama',
  'lmstudio',
  'openai',
  'anthropic',
  'opencodego',
  'askiicloud',
] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === 'string' && (PLATFORM_IDS as readonly string[]).includes(value);
}

// opencode Go (https://opencode.ai/go) — hosted, OpenAI-compatible inference service.
export const OPENCODE_GO_URL = 'https://opencode.ai/zen/go/v1';

// ASKII Cloud — in-house, OpenAI-compatible inference service (https://api.askii.dev).
export const ASKII_CLOUD_URL = 'https://api.askii.dev/v1';

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
export const DEFAULT_LMSTUDIO_URL = 'ws://localhost:1234';

/** Default per-request timeout. Long enough for a slow local model writing a big file. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Default output-token budget where the API requires one (Anthropic). */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// Qwen + MiniMax are served over opencode Go's Anthropic-compatible /messages endpoint;
// every other model uses the OpenAI-compatible /chat/completions endpoint.
export function isOpenCodeGoAnthropicModel(model: string): boolean {
  return /^(qwen|minimax)/i.test((model || '').trim());
}

// opencode Go requires clients to identify themselves: a client-specific user agent plus a
// stable `x-opencode-session` id that groups requests into conversations so the service can
// route them and prime prompt caches. See https://opencode.ai/docs/go/#where-can-i-use-it.
let opencodeGoSessionId: string | undefined;

function getOpenCodeGoSessionId(): string {
  // One id per process: a CLI run is a single conversation, and the extension host reuses it
  // across its many short requests (which also maximises opencode Go prompt-cache hits).
  opencodeGoSessionId ??= randomUUID();
  return opencodeGoSessionId;
}

// Replaced at build time by esbuild `define` with the bundle's own package
// version (extension or CLI); undefined in the tsc-compiled test output.
declare const __ASKII_VERSION__: string | undefined;

export function getAskiiVersion(): string {
  return typeof __ASKII_VERSION__ === 'string' && __ASKII_VERSION__ ? __ASKII_VERSION__ : 'unknown';
}

export function getAskiiUserAgent(): string {
  return `askii/${getAskiiVersion()}`;
}

export function getOpenCodeGoHeaders(): Record<string, string> {
  return {
    'User-Agent': getAskiiUserAgent(),
    'x-opencode-session': getOpenCodeGoSessionId(),
  };
}

// ── Request / reply types ────────────────────────────────────────────────────

export interface ProviderConnection {
  platform: PlatformId;
  model: string;
  /** API key (openai, anthropic, opencodego, askiicloud). */
  apiKey?: string;
  /**
   * Server URL (ollama, lmstudio) or base URL override (openai — empty means
   * api.openai.com; opencodego / askiicloud default to their service URL).
   */
  baseURL?: string;
}

export interface CompletionRequest {
  /** Conversation; a leading system message is passed as the system prompt. */
  messages: ChatMessage[];
  /** Base64 PNG attached to the last user message (vision features). */
  image?: string;
  /** Stream the reply through this callback when set. */
  onChunk?: (chunk: string) => void;
  signal?: AbortSignal;
  /** Whole-request timeout; defaults to DEFAULT_REQUEST_TIMEOUT_MS. 0 disables it. */
  timeoutMs?: number;
  /** Output-token cap. Only sent where the API requires one unless set explicitly. */
  maxTokens?: number;
  /** Retries for transient failures (network, 408/429/5xx) before any output arrived. */
  retries?: number;
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export interface ChatReply {
  text: string;
  /** True when the model stopped because it hit the output-token limit. */
  truncated: boolean;
}

export class RequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The model did not finish within ${Math.round(timeoutMs / 1000)} s (request timed out).`);
    this.name = 'RequestTimeoutError';
  }
}

export class RequestAbortedError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'AbortError';
  }
}

// ── Signals ──────────────────────────────────────────────────────────────────

/**
 * One signal that aborts when the caller's signal does or the timeout fires.
 * `dispose` must be called when the request settles to clear the timer.
 */
function requestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener('abort', onAbort, { once: true });
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort(new RequestTimeoutError(timeoutMs));
        }, timeoutMs)
      : undefined;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function splitSystem(messages: ChatMessage[]): { system?: string; rest: ChatMessage[] } {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  return { system: system || undefined, rest: messages.filter((m) => m.role !== 'system') };
}

function lastUserIndex(messages: { role?: string }[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      return i;
    }
  }
  return -1;
}

// ── Providers ────────────────────────────────────────────────────────────────

type ProviderCall = (
  conn: ProviderConnection,
  req: CompletionRequest,
  signal: AbortSignal,
  emit: (chunk: string) => void,
) => Promise<ChatReply>;

const callOllama: ProviderCall = async (conn, req, signal, emit) => {
  // The client's own abort() only covers streams; a fetch that carries the
  // signal tears down every request.
  const fetchWithSignal: typeof fetch = (input, init) => fetch(input, { ...init, signal });
  const ollama = new Ollama({ host: conn.baseURL || DEFAULT_OLLAMA_URL, fetch: fetchWithSignal });
  const messages: OllamaMessage[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
  if (req.image) {
    const i = lastUserIndex(messages);
    if (i >= 0) {
      messages[i] = { ...messages[i], images: [req.image] };
    }
  }
  const options = req.maxTokens ? { num_predict: req.maxTokens } : undefined;
  if (!req.onChunk) {
    const response = await ollama.chat({ model: conn.model, messages, stream: false, options });
    return { text: response.message.content, truncated: response.done_reason === 'length' };
  }
  const stream = await ollama.chat({ model: conn.model, messages, stream: true, options });
  const onAbort = () => stream.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let text = '';
  let truncated = false;
  try {
    for await (const chunk of stream) {
      if (chunk.message.content) {
        text += chunk.message.content;
        emit(chunk.message.content);
      }
      if (chunk.done) {
        truncated = chunk.done_reason === 'length';
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return { text, truncated };
};

const callLMStudio: ProviderCall = async (conn, req, signal, emit) => {
  try {
    const client = new LMStudioClient({ baseUrl: conn.baseURL || DEFAULT_LMSTUDIO_URL });
    const llmModel = await client.llm.model(conn.model);
    const messages: ChatMessageInput[] = req.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    if (req.image) {
      const i = lastUserIndex(messages);
      if (i >= 0) {
        const fileHandle = await client.files.prepareImageBase64('screenshot.png', req.image);
        messages[i] = { ...messages[i], images: [fileHandle] };
      }
    }
    if (signal.aborted) {
      throw new RequestAbortedError();
    }
    const prediction = llmModel.respond(messages, {
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
      ...(req.onChunk ? { onPredictionFragment: (f: { content: string }) => emit(f.content) } : {}),
    });
    const onAbort = () => void prediction.cancel();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await prediction.result();
      if (signal.aborted) {
        throw new RequestAbortedError();
      }
      return {
        text: result.content,
        truncated: result.stats.stopReason === 'maxPredictedTokensReached',
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`LM Studio error: ${errorMessage}`);
  }
};

async function callOpenAICompatible(
  conn: ProviderConnection,
  req: CompletionRequest,
  signal: AbortSignal,
  emit: (chunk: string) => void,
  baseURL: string | undefined,
  headers: Record<string, string>,
): Promise<ChatReply> {
  // SDK retries are off: retries are decided once, in complete()
  const client = new OpenAI({
    apiKey: conn.apiKey ?? '',
    maxRetries: 0,
    ...(baseURL ? { baseURL } : {}),
    defaultHeaders: headers,
  });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = req.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  if (req.image) {
    const i = lastUserIndex(messages);
    if (i >= 0) {
      messages[i] = {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${req.image}` } },
          { type: 'text', text: req.messages[i].content },
        ],
      };
    }
  }
  const limit = req.maxTokens ? { max_completion_tokens: req.maxTokens } : {};
  if (!req.onChunk) {
    const response = await client.chat.completions.create(
      { model: conn.model, messages, ...limit },
      { signal },
    );
    const choice = response.choices[0];
    return { text: choice?.message?.content ?? '', truncated: choice?.finish_reason === 'length' };
  }
  const stream = await client.chat.completions.create(
    { model: conn.model, messages, stream: true, ...limit },
    { signal },
  );
  let text = '';
  let truncated = false;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta?.content ?? '';
    if (delta) {
      text += delta;
      emit(delta);
    }
    if (choice?.finish_reason) {
      truncated = choice.finish_reason === 'length';
    }
  }
  return { text, truncated };
}

async function callAnthropicCompatible(
  conn: ProviderConnection,
  req: CompletionRequest,
  signal: AbortSignal,
  emit: (chunk: string) => void,
  baseURL: string | undefined,
  headers: Record<string, string>,
): Promise<ChatReply> {
  const client = new Anthropic({
    apiKey: conn.apiKey ?? '',
    maxRetries: 0,
    ...(baseURL ? { baseURL } : {}),
    defaultHeaders: headers,
  });
  const { system, rest } = splitSystem(req.messages);
  const messages: Anthropic.MessageParam[] = rest.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));
  if (req.image) {
    const i = lastUserIndex(messages);
    if (i >= 0) {
      messages[i] = {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: req.image } },
          { type: 'text', text: rest[i].content },
        ],
      };
    }
  }
  const params = {
    model: conn.model,
    max_tokens: req.maxTokens || DEFAULT_MAX_OUTPUT_TOKENS,
    ...(system ? { system } : {}),
    messages,
  };
  if (!req.onChunk) {
    const response = await client.messages.create(params, { signal });
    const text = response.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('');
    return { text, truncated: response.stop_reason === 'max_tokens' };
  }
  const stream = client.messages.stream(params, { signal });
  let text = '';
  let truncated = false;
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text;
      emit(event.delta.text);
    } else if (event.type === 'message_delta') {
      truncated = event.delta.stop_reason === 'max_tokens';
    }
  }
  return { text, truncated };
}

// The Anthropic SDK appends `/v1/messages`, so its base must be the opencode Go URL with the
// trailing `/v1` removed (e.g. https://opencode.ai/zen/go). The OpenAI SDK keeps the `/v1` base.
function opencodeGoAnthropicBase(baseURL: string): string {
  return baseURL.replace(/\/v1\/?$/, '');
}

const PROVIDERS: Record<PlatformId, ProviderCall> = {
  ollama: callOllama,
  lmstudio: callLMStudio,
  openai: (conn, req, signal, emit) =>
    callOpenAICompatible(conn, req, signal, emit, conn.baseURL || undefined, {
      'User-Agent': getAskiiUserAgent(),
    }),
  anthropic: (conn, req, signal, emit) =>
    callAnthropicCompatible(conn, req, signal, emit, conn.baseURL || undefined, {
      'User-Agent': getAskiiUserAgent(),
    }),
  opencodego: (conn, req, signal, emit) => {
    const base = conn.baseURL || OPENCODE_GO_URL;
    return isOpenCodeGoAnthropicModel(conn.model)
      ? callAnthropicCompatible(conn, req, signal, emit, opencodeGoAnthropicBase(base), getOpenCodeGoHeaders())
      : callOpenAICompatible(conn, req, signal, emit, base, getOpenCodeGoHeaders());
  },
  askiicloud: (conn, req, signal, emit) =>
    callOpenAICompatible(conn, req, signal, emit, conn.baseURL || ASKII_CLOUD_URL, {
      'User-Agent': getAskiiUserAgent(),
    }),
};

// ── Retries ──────────────────────────────────────────────────────────────────

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const e = error as { status?: unknown; status_code?: unknown; response?: { status?: unknown } };
  for (const value of [e.status, e.status_code, e.response?.status]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

const RETRYABLE_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * True for failures worth retrying: dropped connections, 408/409/429 and 5xx.
 * Never for cancellation, timeouts or other 4xx (a bad key or request fails
 * the same way every time).
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof RequestAbortedError || error instanceof RequestTimeoutError) {
    return false;
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'AbortError' || name === 'APIUserAbortError') {
    return false;
  }
  const status = errorStatus(error);
  if (status !== undefined) {
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') {
    return true;
  }
  const code =
    (error as { code?: unknown } | null)?.code ??
    (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (typeof code === 'string' && RETRYABLE_CODES.has(code)) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|socket hang up|network error|connection (reset|refused|closed)/i.test(message);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RequestAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RequestAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Calls fn, retrying transient failures (see isRetryableError) with
 * exponential backoff — 1 s, 2 s, 4 s … capped at 8 s. Stops at once when
 * signal aborts or the error is not retryable.
 */
export async function retryLLMCall<T>(
  fn: () => Promise<T>,
  options: {
    retries?: number;
    signal?: AbortSignal;
    shouldRetry?: (error: unknown) => boolean;
    onRetry?: (attempt: number, error: Error, delayMs: number) => void;
    baseDelayMs?: number;
  } = {},
): Promise<T> {
  const { retries = 2, signal, shouldRetry = isRetryableError, onRetry, baseDelayMs = 1000 } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (signal?.aborted || attempt >= retries || !shouldRetry(e)) {
        throw e;
      }
      const error = e instanceof Error ? e : new Error(String(e));
      const delayMs = Math.min(baseDelayMs * 2 ** attempt, 8000);
      onRetry?.(attempt + 1, error, delayMs);
      await sleep(delayMs, signal);
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Sends one request to the configured provider. Honours the abort signal and
 * timeout on every provider (in-flight requests are torn down, not just
 * ignored), retries transient failures that happened before any output was
 * streamed, and reports whether the reply was cut off by the token limit.
 */
export async function complete(
  conn: ProviderConnection,
  req: CompletionRequest,
): Promise<ChatReply> {
  const call = PROVIDERS[conn.platform];
  if (!call) {
    throw new Error(`Unknown LLM platform: ${conn.platform}`);
  }
  const timeoutMs = req.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let streamed = false;
  const emit = (chunk: string) => {
    if (chunk) {
      streamed = true;
      req.onChunk?.(chunk);
    }
  };

  return retryLLMCall(
    async () => {
      const scoped = requestSignal(req.signal, timeoutMs);
      try {
        return await call(conn, req, scoped.signal, emit);
      } catch (error) {
        if (req.signal?.aborted) {
          throw new RequestAbortedError();
        }
        if (scoped.timedOut()) {
          throw new RequestTimeoutError(timeoutMs);
        }
        throw error;
      } finally {
        scoped.dispose();
      }
    },
    {
      retries: req.retries ?? 2,
      signal: req.signal,
      // Once output reached the caller a retry would duplicate it
      shouldRetry: (error) => !streamed && isRetryableError(error),
      onRetry: req.onRetry,
    },
  );
}

/** Convenience wrapper: a single prompt (plus optional system prompt) → reply text. */
export async function completePrompt(
  conn: ProviderConnection,
  prompt: string,
  options: Omit<CompletionRequest, 'messages'> & { system?: string } = {},
): Promise<ChatReply> {
  const { system, ...rest } = options;
  const messages: ChatMessage[] = system
    ? [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ]
    : [{ role: 'user', content: prompt }];
  return complete(conn, { ...rest, messages });
}

export function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return error instanceof RequestAbortedError || name === 'AbortError' || name === 'APIUserAbortError';
}
