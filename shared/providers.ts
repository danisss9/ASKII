/**
 * Provider catalog + shared types for ASKII.
 *
 * This module is pure (no Node, no network) so it can be imported by the VS
 * Code extension, the CLI, the Android app, and the relay broker.
 *
 * The actual provider HTTP/SDK call implementations live in `common/providers`
 * (for Node runtimes). The app re-implements the transport on top of a native
 * OkHttp plugin — see `app/src-plugins/askii-http`.
 */

export type ProviderId =
  | 'ollama'
  | 'lmstudio'
  | 'openai'
  | 'anthropic'
  | 'opencodego'
  | 'askiicloud';

/** The ordered list of selectable provider ids (used by settings UIs). */
export const PLATFORMS: ProviderId[] = [
  'ollama',
  'lmstudio',
  'openai',
  'anthropic',
  'opencodego',
  'askiicloud',
];

/** opencode Go (https://opencode.ai/go) — hosted, OpenAI-compatible inference service. */
export const OPENCODE_GO_URL = 'https://opencode.ai/zen/go/v1';

/** ASKII Cloud — in-house, OpenAI-compatible inference service (https://api.askii.dev). */
export const ASKII_CLOUD_URL = 'https://api.askii.dev/v1';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Canonical default model per provider. Runtime override sources (env vars,
 * VS Code settings) layer on top of this in their respective consumers; this
 * map intentionally avoids touching `process`/DOM globals so it stays pure.
 */
export const PLATFORM_DEFAULT_MODELS: Record<ProviderId, string> = {
  ollama: 'gemma4:e4b',
  lmstudio: 'qwen/qwen3-coder-30b',
  openai: 'gpt-5-mini',
  anthropic: 'claude-sonnet-4-6',
  opencodego: 'glm-5.2',
  askiicloud: 'askii-default',
};

/** Human-facing labels for each provider. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  ollama: 'Ollama (local)',
  lmstudio: 'LM Studio (local)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  opencodego: 'opencode Go',
  askiicloud: 'ASKII Cloud',
};

/** Whether a provider needs an API key (cloud) vs. just a URL (local). */
export const PROVIDER_NEEDS_KEY: Record<ProviderId, boolean> = {
  ollama: false,
  lmstudio: false,
  openai: true,
  anthropic: true,
  opencodego: true,
  askiicloud: true,
};

/**
 * Qwen + MiniMax are served over opencode Go's Anthropic-compatible /messages
 * endpoint; every other model uses the OpenAI-compatible /chat/completions
 * endpoint.
 */
export function isOpenCodeGoAnthropicModel(model: string): boolean {
  return /^(qwen|minimax)/i.test((model || '').trim());
}