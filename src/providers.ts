import * as vscode from 'vscode';
import {
  getOllamaResponse,
  getOllamaResponseStreaming,
  getOllamaChat,
  getOllamaChatStreaming,
  getLMStudioResponse,
  getLMStudioChat,
  getLMStudioChatStreaming,
  getOpenAIResponse,
  getOpenAIChat,
  getOpenAIChatStreaming,
  getAnthropicResponse,
  getAnthropicChat,
  getAnthropicChatStreaming,
  getOpenCodeGoResponse,
  getOpenCodeGoChat,
  getOpenCodeGoChatStreaming,
  OPENCODE_GO_URL,
  getAskiiCloudResponse,
  getAskiiCloudChat,
  getAskiiCloudChatStreaming,
  ASKII_CLOUD_URL,
  type ChatMessage,
} from '@common/providers';
import { loadWikiIndex, searchWikiRaw } from '@common/wiki';

/**
 * Resolves the model id to use, honouring an optional per-feature model
 * override. When the override is unset, empty, or "default", the global
 * `askii.llmModel` setting is used.
 *
 * @returns The resolved model id (never "default").
 */
export function resolveModel(
  config: vscode.WorkspaceConfiguration,
  _platform: string,
  modelOverride?: string,
): string {
  if (modelOverride && modelOverride.trim() !== '' && modelOverride !== 'default') {
    return modelOverride;
  }
  return config.get<string>('llmModel') || 'askii-smart';
}

export async function getExtensionResponseWithImage(
  prompt: string,
  imageBase64: string,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmVisionPlatform') || 'askiicloud';
  const model = config.get<string>('llmVisionModel') || 'askii-smart';

  if (platform === 'lmstudio') {
    const url = config.get<string>('lmStudioUrl') || 'ws://localhost:1234';
    return getLMStudioResponse(prompt, url, model, undefined, imageBase64);
  } else if (platform === 'openai') {
    const apiKey = config.get<string>('openaiApiKey') || '';
    const baseURL = config.get<string>('openaiUrl') || undefined;
    return getOpenAIResponse(prompt, apiKey, model, baseURL, undefined, imageBase64);
  } else if (platform === 'anthropic') {
    const apiKey = config.get<string>('anthropicApiKey') || '';
    return getAnthropicResponse(prompt, apiKey, model, undefined, imageBase64);
  } else if (platform === 'opencodego') {
    const apiKey = config.get<string>('opencodegoApiKey') || '';
    return getOpenCodeGoResponse(prompt, apiKey, model, OPENCODE_GO_URL, undefined, imageBase64);
  } else if (platform === 'askiicloud') {
    const apiKey = config.get<string>('askiicloudApiKey') || '';
    return getAskiiCloudResponse(prompt, apiKey, model, ASKII_CLOUD_URL, undefined, imageBase64);
  } else {
    const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    return getOllamaResponse(prompt, url, model, undefined, [imageBase64]);
  }
}

export async function getExtensionResponseStreaming(
  prompt: string,
  onChunk: (chunk: string) => void,
  system?: string,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'askiicloud';
  const model = config.get<string>('llmModel') || 'askii-smart';

  if (platform === 'lmstudio') {
    const url = config.get<string>('lmStudioUrl') || 'ws://localhost:1234';
    // LMStudio SDK does not expose a simple streaming interface; deliver as one chunk
    const result = await getLMStudioResponse(prompt, url, model, system);
    onChunk(result);
  } else if (platform === 'openai') {
    const apiKey = config.get<string>('openaiApiKey') || '';
    const baseURL = config.get<string>('openaiUrl') || undefined;
    const result = await getOpenAIResponse(prompt, apiKey, model, baseURL, system);
    onChunk(result);
  } else if (platform === 'anthropic') {
    const apiKey = config.get<string>('anthropicApiKey') || '';
    const result = await getAnthropicResponse(prompt, apiKey, model, system);
    onChunk(result);
  } else if (platform === 'opencodego') {
    const apiKey = config.get<string>('opencodegoApiKey') || '';
    const result = await getOpenCodeGoResponse(prompt, apiKey, model, OPENCODE_GO_URL, system);
    onChunk(result);
  } else if (platform === 'askiicloud') {
    const apiKey = config.get<string>('askiicloudApiKey') || '';
    const result = await getAskiiCloudResponse(prompt, apiKey, model, ASKII_CLOUD_URL, system);
    onChunk(result);
  } else {
    const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    await getOllamaResponseStreaming(prompt, url, model, onChunk, system);
  }
}

export async function getExtensionResponse(
  prompt: string,
  system?: string,
  platformOverride?: string,
  modelOverride?: string,
  signal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform =
    platformOverride && platformOverride !== 'default'
      ? platformOverride
      : config.get<string>('llmPlatform') || 'askiicloud';
  const model = resolveModel(config, platform, modelOverride);

  if (platform === 'lmstudio') {
    const url = config.get<string>('lmStudioUrl') || 'ws://localhost:1234';
    return getLMStudioResponse(prompt, url, model, system, undefined, signal);
  } else if (platform === 'openai') {
    const apiKey = config.get<string>('openaiApiKey') || '';
    const baseURL = config.get<string>('openaiUrl') || undefined;
    return getOpenAIResponse(prompt, apiKey, model, baseURL, system, undefined, signal);
  } else if (platform === 'anthropic') {
    const apiKey = config.get<string>('anthropicApiKey') || '';
    return getAnthropicResponse(prompt, apiKey, model, system, undefined, undefined, signal);
  } else if (platform === 'opencodego') {
    const apiKey = config.get<string>('opencodegoApiKey') || '';
    return getOpenCodeGoResponse(prompt, apiKey, model, OPENCODE_GO_URL, system, undefined, signal);
  } else if (platform === 'askiicloud') {
    const apiKey = config.get<string>('askiicloudApiKey') || '';
    return getAskiiCloudResponse(prompt, apiKey, model, ASKII_CLOUD_URL, system, undefined, signal);
  } else {
    const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    return getOllamaResponse(prompt, url, model, system, undefined, signal);
  }
}

export async function getExtensionChat(messages: ChatMessage[]): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'askiicloud';
  const mdl = config.get<string>('llmModel') || 'askii-smart';

  if (platform === 'lmstudio') {
    const url = config.get<string>('lmStudioUrl') || 'ws://localhost:1234';
    return getLMStudioChat(messages, url, mdl);
  } else if (platform === 'openai') {
    const apiKey = config.get<string>('openaiApiKey') || '';
    const baseURL = config.get<string>('openaiUrl') || undefined;
    return getOpenAIChat(messages, apiKey, mdl, baseURL);
  } else if (platform === 'anthropic') {
    const apiKey = config.get<string>('anthropicApiKey') || '';
    return getAnthropicChat(messages, apiKey, mdl);
  } else if (platform === 'opencodego') {
    const apiKey = config.get<string>('opencodegoApiKey') || '';
    return getOpenCodeGoChat(messages, apiKey, mdl, OPENCODE_GO_URL);
  } else if (platform === 'askiicloud') {
    const apiKey = config.get<string>('askiicloudApiKey') || '';
    return getAskiiCloudChat(messages, apiKey, mdl, ASKII_CLOUD_URL);
  } else {
    const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    return getOllamaChat(messages, url, mdl);
  }
}

export async function getExtensionChatStreaming(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'askiicloud';
  const mdl = config.get<string>('llmModel') || 'askii-smart';

  if (platform === 'lmstudio') {
    const url = config.get<string>('lmStudioUrl') || 'ws://localhost:1234';
    return getLMStudioChatStreaming(messages, url, mdl, onChunk);
  } else if (platform === 'openai') {
    const apiKey = config.get<string>('openaiApiKey') || '';
    const baseURL = config.get<string>('openaiUrl') || undefined;
    return getOpenAIChatStreaming(messages, apiKey, mdl, onChunk, baseURL);
  } else if (platform === 'anthropic') {
    const apiKey = config.get<string>('anthropicApiKey') || '';
    return getAnthropicChatStreaming(messages, apiKey, mdl, onChunk);
  } else if (platform === 'opencodego') {
    const apiKey = config.get<string>('opencodegoApiKey') || '';
    return getOpenCodeGoChatStreaming(messages, apiKey, mdl, onChunk, OPENCODE_GO_URL);
  } else if (platform === 'askiicloud') {
    const apiKey = config.get<string>('askiicloudApiKey') || '';
    return getAskiiCloudChatStreaming(messages, apiKey, mdl, onChunk, ASKII_CLOUD_URL);
  } else {
    const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    return getOllamaChatStreaming(messages, url, mdl, onChunk);
  }
}

/**
 * Validates the currently configured LLM provider and returns an actionable
 * error message if something is wrong, or null if the config looks good.
 *
 * Checks performed per platform:
 *  - openai / anthropic : API key must be non-empty
 *  - ollama             : GET <url>/api/tags must succeed within 3 s
 *  - lmstudio           : GET <http-url>/v1/models must succeed within 3 s
 */
export async function validateProviderConfig(): Promise<string | null> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'askiicloud';

  if (platform === 'openai') {
    const apiKey = (config.get<string>('openaiApiKey') || '').trim();
    if (!apiKey) {
      return 'ASKII (openai): No API key configured. Set askii.openaiApiKey in Settings.';
    }
  } else if (platform === 'anthropic') {
    const apiKey = (config.get<string>('anthropicApiKey') || '').trim();
    if (!apiKey) {
      return 'ASKII (anthropic): No API key configured. Set askii.anthropicApiKey in Settings.';
    }
  } else if (platform === 'opencodego') {
    const apiKey = (config.get<string>('opencodegoApiKey') || '').trim();
    if (!apiKey) {
      return 'ASKII (opencodego): No API key configured. Set askii.opencodegoApiKey in Settings.';
    }
  } else if (platform === 'askiicloud') {
    const apiKey = (config.get<string>('askiicloudApiKey') || '').trim();
    if (!apiKey) {
      return 'ASKII (askiicloud): No API key configured. Set askii.askiicloudApiKey in Settings.';
    }
  } else if (platform === 'ollama') {
    const url = (config.get<string>('ollamaUrl') || '').trim();
    if (!url) {
      return 'ASKII (ollama): No server URL configured. Set askii.ollamaUrl in Settings.';
    }
  } else if (platform === 'lmstudio') {
    const url = (config.get<string>('lmStudioUrl') || '').trim();
    if (!url) {
      return 'ASKII (lmstudio): No server URL configured. Set askii.lmStudioUrl in Settings.';
    }
  }

  return null;
}

export async function getLLMExplanation(
  lineText: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmInlinePlatform') || 'askiicloud';
  const model = resolveModel(config, platform, config.get<string>('llmInlineModel'));
  const mode = config.get<string>('inlineHelperMode') || 'funny';

  if (mode === 'off') return '';

  // Wiki mode: search the index for context, then ask the LLM with that context
  let wikiContext = '';
  if (mode === 'wiki') {
    const wikiPath = config.get<string>('wikiPath') ?? '';
    if (!wikiPath) return 'Set askii.wikiPath to enable wiki mode';
    const data = loadWikiIndex(wikiPath);
    if (!data) return 'Run "ASKII: Reload Wiki" to build the index';
    const hits = searchWikiRaw(lineText, data, 2);
    if (hits.length > 0) {
      wikiContext = hits
        .map((h) => `[${h.source} — ${h.heading}]\n${h.content}`)
        .join('\n\n---\n\n');
    }
  }

  const isHelpful = mode === 'helpful' || mode === 'wiki';
  const systemPrompt = isHelpful
    ? 'You are ASKII, a helpful coding assistant. Provide clear, concise explanations.'
    : 'You are ASKII, a witty coding assistant. Provide humorous comments.';
  const wikiSection = wikiContext ? `Relevant documentation:\n${wikiContext}\n\n` : '';
  const userPrompt = isHelpful
    ? `${wikiSection}Explain this code in one sentence: ${lineText}`
    : `Make a funny comment about this code in one sentence: ${lineText}`;

  try {
    if (abortSignal?.aborted) throw new Error('Request cancelled');

    if (platform === 'lmstudio') {
      const url = config.get<string>('lmStudioUrl') || 'ws://localhost:1234';
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      const result = await getLMStudioResponse(userPrompt, url, model, systemPrompt);
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      return result || 'No explanation available.';
    } else if (platform === 'openai') {
      const apiKey = config.get<string>('openaiApiKey') || '';
      const baseURL = config.get<string>('openaiUrl') || undefined;
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      const result = await getOpenAIResponse(userPrompt, apiKey, model, baseURL, systemPrompt);
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      return result || 'No explanation available.';
    } else if (platform === 'anthropic') {
      const apiKey = config.get<string>('anthropicApiKey') || '';
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      const result = await getAnthropicResponse(userPrompt, apiKey, model, systemPrompt);
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      return result || 'No explanation available.';
    } else if (platform === 'opencodego') {
      const apiKey = config.get<string>('opencodegoApiKey') || '';
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      const result = await getOpenCodeGoResponse(
        userPrompt,
        apiKey,
        model,
        OPENCODE_GO_URL,
        systemPrompt,
      );
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      return result || 'No explanation available.';
    } else if (platform === 'askiicloud') {
      const apiKey = config.get<string>('askiicloudApiKey') || '';
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      const result = await getAskiiCloudResponse(
        userPrompt,
        apiKey,
        model,
        ASKII_CLOUD_URL,
        systemPrompt,
      );
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      return result || 'No explanation available.';
    } else {
      const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      const result = await getOllamaResponse(userPrompt, url, model, systemPrompt);
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      return result || 'No explanation available.';
    }
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return `Error: ${errorMessage}`;
  }
}
