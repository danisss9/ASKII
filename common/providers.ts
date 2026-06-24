import { Ollama } from 'ollama';
import { type ChatMessageInput, LMStudioClient } from '@lmstudio/sdk';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// opencode Go (https://opencode.ai/go) — hosted, OpenAI-compatible inference service.
export const OPENCODE_GO_URL = 'https://opencode.ai/zen/go/v1';

// ASKII Cloud — in-house, OpenAI-compatible inference service (https://api.askii.dev).
export const ASKII_CLOUD_URL = 'https://api.askii.dev/v1';

// Qwen + MiniMax are served over opencode Go's Anthropic-compatible /messages endpoint;
// every other model uses the OpenAI-compatible /chat/completions endpoint.
export function isOpenCodeGoAnthropicModel(model: string): boolean {
  return /^(qwen|minimax)/i.test((model || '').trim());
}

export async function getOllamaResponse(
  prompt: string,
  url: string,
  model: string,
  system?: string,
  images?: string[],
  signal?: AbortSignal,
): Promise<string> {
  // The ollama client's abort() only cancels *streamed* requests, so for this non-streaming call we
  // inject a custom fetch that carries the AbortSignal — that actually tears down the in-flight request.
  const fetchWithSignal: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal: init?.signal ?? signal });
  const ollama = new Ollama({ host: url, ...(signal ? { fetch: fetchWithSignal } : {}) });
  const response = await ollama.generate({ model, system, prompt, stream: false, images });
  return response.response || 'No response';
}

export async function getOllamaResponseStreaming(
  prompt: string,
  url: string,
  model: string,
  onChunk: (chunk: string) => void,
  system?: string,
  images?: string[],
): Promise<void> {
  const ollama = new Ollama({ host: url });
  const stream = await ollama.generate({ model, system, prompt, stream: true, images });
  for await (const chunk of stream) {
    if (chunk.response) onChunk(chunk.response);
  }
}

export async function getOllamaChat(
  messages: ChatMessage[],
  url: string,
  model: string,
): Promise<string> {
  const ollama = new Ollama({ host: url });
  const response = await ollama.chat({
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: false,
  });
  return response.message.content || 'No response';
}

export async function getOllamaChatStreaming(
  messages: ChatMessage[],
  url: string,
  model: string,
  onChunk: (chunk: string) => void,
): Promise<string> {
  const ollama = new Ollama({ host: url });
  const stream = await ollama.chat({
    model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
  });
  let full = '';
  for await (const chunk of stream) {
    const text = chunk.message.content;
    if (text) { onChunk(text); full += text; }
  }
  return full;
}

export async function getLMStudioResponse(
  prompt: string,
  url: string,
  model: string,
  system?: string,
  imageBase64?: string,
  // Accepted for signature symmetry with the other providers. The LM Studio SDK has no clean
  // per-request abort, so cancellation here is best-effort — callers still discard stale results.
  _signal?: AbortSignal,
): Promise<string> {
  try {
    const client = new LMStudioClient({ baseUrl: url });
    const llmModel = await client.llm.model(model);
    const userMessage: ChatMessageInput = { role: 'user', content: prompt };
    if (imageBase64) {
      const fileHandle = await client.files.prepareImageBase64('screenshot.png', imageBase64);
      userMessage.images = [fileHandle];
    }
    const messages: ChatMessageInput[] = system
      ? [{ role: 'system', content: system }, userMessage]
      : [userMessage];
    const result = await llmModel.respond(messages);
    return result.content || 'No response';
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`LM Studio error: ${errorMessage}`);
  }
}

export async function getOpenAIResponse(
  prompt: string,
  apiKey: string,
  model: string,
  baseURL?: string,
  system?: string,
  imageBase64?: string,
  signal?: AbortSignal,
): Promise<string> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (system) messages.push({ role: 'system', content: system });
  if (imageBase64) {
    messages.push({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        { type: 'text', text: prompt },
      ],
    });
  } else {
    messages.push({ role: 'user', content: prompt });
  }
  const response = await client.chat.completions.create({ model, messages }, { signal });
  return response.choices[0]?.message?.content || 'No response';
}

export async function getOpenAIChat(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  baseURL?: string,
): Promise<string> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const oaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const response = await client.chat.completions.create({ model, messages: oaiMessages });
  return response.choices[0]?.message?.content || 'No response';
}

export async function getOpenAIChatStreaming(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  onChunk: (chunk: string) => void,
  baseURL?: string,
): Promise<string> {
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const oaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const stream = await client.chat.completions.create({ model, messages: oaiMessages, stream: true });
  let full = '';
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content ?? '';
    if (text) { onChunk(text); full += text; }
  }
  return full;
}

export async function getLMStudioChat(
  messages: ChatMessage[],
  url: string,
  model: string,
): Promise<string> {
  try {
    const client = new LMStudioClient({ baseUrl: url });
    const llmModel = await client.llm.model(model);
    const lmsMessages: ChatMessageInput[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const result = await llmModel.respond(lmsMessages);
    return result.content || 'No response';
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`LM Studio error: ${errorMessage}`);
  }
}

export async function getLMStudioChatStreaming(
  messages: ChatMessage[],
  url: string,
  model: string,
  onChunk: (chunk: string) => void,
): Promise<string> {
  // LM Studio SDK does not expose a streaming chat interface; deliver as one chunk.
  const result = await getLMStudioChat(messages, url, model);
  onChunk(result);
  return result;
}

export async function getAnthropicResponse(
  prompt: string,
  apiKey: string,
  model: string,
  system?: string,
  imageBase64?: string,
  baseURL?: string,
  signal?: AbortSignal,
): Promise<string> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const userContent: Anthropic.MessageParam['content'] = imageBase64
    ? [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
        { type: 'text', text: prompt },
      ]
    : prompt;
  const response = await client.messages.create(
    {
      model,
      max_tokens: 4096,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content: userContent }],
    },
    { signal },
  );
  const block = response.content.find((b) => b.type === 'text');
  return block?.type === 'text' ? block.text : 'No response';
}

export async function getAnthropicChat(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  baseURL?: string,
): Promise<string> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const systemMsg = messages.find((m) => m.role === 'system');
  const filtered = messages.filter((m) => m.role !== 'system');
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: filtered.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  });
  const block = response.content.find((b) => b.type === 'text');
  return block?.type === 'text' ? block.text : 'No response';
}

export async function getAnthropicChatStreaming(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  onChunk: (chunk: string) => void,
  baseURL?: string,
): Promise<string> {
  const client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  const systemMsg = messages.find((m) => m.role === 'system');
  const filtered = messages.filter((m) => m.role !== 'system');
  const stream = client.messages.stream({
    model,
    max_tokens: 4096,
    ...(systemMsg ? { system: systemMsg.content } : {}),
    messages: filtered.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  });
  let full = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      onChunk(event.delta.text);
      full += event.delta.text;
    }
  }
  return full;
}

// The Anthropic SDK appends `/v1/messages`, so its base must be the opencode Go URL with the
// trailing `/v1` removed (e.g. https://opencode.ai/zen/go). The OpenAI SDK keeps the `/v1` base.
function opencodeGoAnthropicBase(baseURL: string): string {
  return baseURL.replace(/\/v1\/?$/, '');
}

export async function getOpenCodeGoResponse(
  prompt: string,
  apiKey: string,
  model: string,
  baseURL: string = OPENCODE_GO_URL,
  system?: string,
  imageBase64?: string,
  signal?: AbortSignal,
): Promise<string> {
  return isOpenCodeGoAnthropicModel(model)
    ? getAnthropicResponse(prompt, apiKey, model, system, imageBase64, opencodeGoAnthropicBase(baseURL), signal)
    : getOpenAIResponse(prompt, apiKey, model, baseURL, system, imageBase64, signal);
}

export async function getOpenCodeGoChat(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  baseURL: string = OPENCODE_GO_URL,
): Promise<string> {
  return isOpenCodeGoAnthropicModel(model)
    ? getAnthropicChat(messages, apiKey, model, opencodeGoAnthropicBase(baseURL))
    : getOpenAIChat(messages, apiKey, model, baseURL);
}

export async function getOpenCodeGoChatStreaming(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  onChunk: (chunk: string) => void,
  baseURL: string = OPENCODE_GO_URL,
): Promise<string> {
  return isOpenCodeGoAnthropicModel(model)
    ? getAnthropicChatStreaming(messages, apiKey, model, onChunk, opencodeGoAnthropicBase(baseURL))
    : getOpenAIChatStreaming(messages, apiKey, model, onChunk, baseURL);
}

// ASKII Cloud is purely OpenAI-compatible, so these are thin wrappers over the OpenAI calls
// that pin the base URL to the ASKII Cloud endpoint by default.
export async function getAskiiCloudResponse(
  prompt: string,
  apiKey: string,
  model: string,
  baseURL: string = ASKII_CLOUD_URL,
  system?: string,
  imageBase64?: string,
  signal?: AbortSignal,
): Promise<string> {
  return getOpenAIResponse(prompt, apiKey, model, baseURL, system, imageBase64, signal);
}

export async function getAskiiCloudChat(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  baseURL: string = ASKII_CLOUD_URL,
): Promise<string> {
  return getOpenAIChat(messages, apiKey, model, baseURL);
}

export async function getAskiiCloudChatStreaming(
  messages: ChatMessage[],
  apiKey: string,
  model: string,
  onChunk: (chunk: string) => void,
  baseURL: string = ASKII_CLOUD_URL,
): Promise<string> {
  return getOpenAIChatStreaming(messages, apiKey, model, onChunk, baseURL);
}

export async function retryLLMCall<T>(
  fn: () => Promise<T>,
  maxRetries = 2,
  onRetry?: (attempt: number, error: Error) => void,
): Promise<T> {
  let lastError: Error = new Error('Unknown error');
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries && onRetry) {
        onRetry(attempt + 1, lastError);
      }
    }
  }
  throw lastError;
}
