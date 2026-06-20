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
  type ChatMessage,
} from '@common/providers';
import { loadWikiIndex, searchWikiRaw } from '@common/wiki';

/**
 * Resolves the effective LLM platform for a feature.
 *
 * Each feature (inline completion, helper mode, etc.) can override the global
 * `askii.llmPlatform` via its own `askii.<feature>Platform` setting. When the
 * override is unset or set to "default", the global `askii.llmPlatform` is used.
 *
 * @param config     The workspace configuration for "askii".
 * @param overrideKey  The setting key that holds the per-feature override
 *                     (e.g. "inlinePlatform").
 * @returns The resolved platform id (ollama, copilot, lmstudio, openai,
 *          anthropic, or opencodego).
 */
export function resolvePlatform(
  config: vscode.WorkspaceConfiguration,
  overrideKey?: string,
): string {
  const globalPlatform = config.get<string>('llmPlatform') || 'ollama';
  if (!overrideKey) return globalPlatform;
  const override = config.get<string>(overrideKey);
  if (override && override !== 'default') return override;
  return globalPlatform;
}

/**
 * Resolves the model id to use for a given platform, honouring an optional
 * per-feature model override.
 *
 * When `modelOverride` is unset, empty, or "default", the platform's default
 * model setting (askii.ollamaModel, askii.copilotModel, askii.openaiModel,
 * askii.anthropicModel, askii.lmStudioModel, askii.opencodegoModel) is used.
 *
 * @returns The resolved model id (never "default").
 */
export function resolveModel(
  config: vscode.WorkspaceConfiguration,
  platform: string,
  modelOverride?: string,
): string {
  if (modelOverride && modelOverride.trim() !== '' && modelOverride !== 'default') {
    return modelOverride;
  }
  switch (platform) {
    case 'copilot':
      return config.get<string>('copilotModel') || 'gpt-4o';
    case 'lmstudio':
      return config.get<string>('lmStudioModel') || 'qwen/qwen3-coder-30b';
    case 'openai':
      return config.get<string>('openaiModel') || 'gpt-4o';
    case 'anthropic':
      return config.get<string>('anthropicModel') || 'claude-opus-4-6';
    case 'opencodego':
      return config.get<string>('opencodegoModel') || 'glm-5.2';
    default:
      return config.get<string>('ollamaModel') || 'gemma3:270m';
  }
}

export async function getExtensionResponseWithImage(
  prompt: string,
  imageBase64: string,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'ollama';

  if (platform === 'copilot') {
    return getCopilotResponse(prompt, imageBase64);
  } else if (platform === 'lmstudio') {
    const url = config.get<string>('lmStudioUrl') || 'ws://localhost:1234';
    const model = config.get<string>('lmStudioModel') || 'qwen/qwen3-coder-30b';
    return getLMStudioResponse(prompt, url, model, undefined, imageBase64);
  } else if (platform === 'openai') {
    const apiKey = config.get<string>('openaiApiKey') || '';
    const model = config.get<string>('openaiModel') || 'gpt-4o';
    const baseURL = config.get<string>('openaiUrl') || undefined;
    return getOpenAIResponse(prompt, apiKey, model, baseURL, undefined, imageBase64);
  } else if (platform === 'anthropic') {
    const apiKey = config.get<string>('anthropicApiKey') || '';
    const model = config.get<string>('anthropicModel') || 'claude-opus-4-6';
    return getAnthropicResponse(prompt, apiKey, model, undefined, imageBase64);
  } else if (platform === 'opencodego') {
    const apiKey = config.get<string>('opencodegoApiKey') || '';
    const model = config.get<string>('opencodegoModel') || 'glm-5.2';
    const baseURL = config.get<string>('opencodegoUrl') || OPENCODE_GO_URL;
    return getOpenCodeGoResponse(prompt, apiKey, model, baseURL, undefined, imageBase64);
  } else {
    const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    const model = config.get<string>('ollamaModel') || 'gemma3:270m';
    return getOllamaResponse(prompt, url, model, undefined, [imageBase64]);
  }
}

export async function getCopilotResponse(prompt: string, imageBase64?: string): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const copilotModel = config.get<string>('copilotModel') || 'gpt-4o';

  const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: copilotModel });
  if (models.length === 0) throw new Error('GitHub Copilot not available');

  const model = models[0];

  let userMessage: vscode.LanguageModelChatMessage;
  if (imageBase64) {
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    userMessage = vscode.LanguageModelChatMessage.User([
      new vscode.LanguageModelDataPart(imageBuffer, 'image/png'),
      new vscode.LanguageModelTextPart(prompt),
    ]);
  } else {
    userMessage = vscode.LanguageModelChatMessage.User(prompt);
  }

  const chatResponse = await model.sendRequest(
    [userMessage],
    {},
    new vscode.CancellationTokenSource().token,
  );

  let responseText = '';
  for await (const fragment of chatResponse.text) {
    responseText += fragment;
  }
  return responseText;
}

export async function getExtensionResponseStreaming(
  prompt: string,
  onChunk: (chunk: string) => void,
  system?: string,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'ollama';

  if (platform === 'copilot') {
    const copilotModel = config.get<string>('copilotModel') || 'gpt-4o';
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: copilotModel });
    if (models.length === 0) throw new Error('GitHub Copilot not available');
    const model = models[0];
    const messages: vscode.LanguageModelChatMessage[] = [];
    if (system) messages.push(vscode.LanguageModelChatMessage.User(system));
    messages.push(vscode.LanguageModelChatMessage.User(prompt));
    const chatResponse = await model.sendRequest(
      messages,
      {},
      new vscode.CancellationTokenSource().token,
    );
    for await (const fragment of chatResponse.text) {
      if (fragment) onChunk(fragment);
    }
  } else if (platform === 'lmstudio') {
    const url = config.get<string>('lmStudioUrl') || 'ws://localhost:1234';
    const model = config.get<string>('lmStudioModel') || 'qwen/qwen3-coder-30b';
    // LMStudio SDK does not expose a simple streaming interface; deliver as one chunk
    const result = await getLMStudioResponse(prompt, url, model, system);
    onChunk(result);
  } else if (platform === 'openai') {
    const apiKey = config.get<string>('openaiApiKey') || '';
    const model = config.get<string>('openaiModel') || 'gpt-4o';
    const baseURL = config.get<string>('openaiUrl') || undefined;
    const result = await getOpenAIResponse(prompt, apiKey, model, baseURL, system);
    onChunk(result);
  } else if (platform === 'anthropic') {
    const apiKey = config.get<string>('anthropicApiKey') || '';
    const model = config.get<string>('anthropicModel') || 'claude-opus-4-6';
    const result = await getAnthropicResponse(prompt, apiKey, model, system);
    onChunk(result);
  } else if (platform === 'opencodego') {
    const apiKey = config.get<string>('opencodegoApiKey') || '';
    const model = config.get<string>('opencodegoModel') || 'glm-5.2';
    const baseURL = config.get<string>('opencodegoUrl') || OPENCODE_GO_URL;
    const result = await getOpenCodeGoResponse(prompt, apiKey, model, baseURL, system);
    onChunk(result);
  } else {
    const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    const model = config.get<string>('ollamaModel') || 'gemma3:270m';
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
      : config.get<string>('llmPlatform') || 'ollama';
  const model = resolveModel(config, platform, modelOverride);

  if (platform === 'copilot') {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: model });
    if (models.length === 0) throw new Error('GitHub Copilot not available');
    const copilotModel = models[0];
    const messages: vscode.LanguageModelChatMessage[] = [];
    if (system) messages.push(vscode.LanguageModelChatMessage.User(system));
    messages.push(vscode.LanguageModelChatMessage.User(prompt));
    // Bridge the AbortSignal to a VSCode cancellation token so a superseded request stops streaming.
    const cts = new vscode.CancellationTokenSource();
    if (signal) {
      if (signal.aborted) cts.cancel();
      else signal.addEventListener('abort', () => cts.cancel(), { once: true });
    }
    try {
      const chatResponse = await copilotModel.sendRequest(messages, {}, cts.token);
      let responseText = '';
      for await (const fragment of chatResponse.text) {
        responseText += fragment;
      }
      return responseText;
    } finally {
      cts.dispose();
    }
  } else if (platform === 'lmstudio') {
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
    const baseURL = config.get<string>('opencodegoUrl') || OPENCODE_GO_URL;
    return getOpenCodeGoResponse(prompt, apiKey, model, baseURL, system, undefined, signal);
  } else {
    const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    return getOllamaResponse(prompt, url, model, system, undefined, signal);
  }
}

export async function getExtensionChat(messages: ChatMessage[]): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'ollama';

  if (platform === 'copilot') {
    const copilotModel = config.get<string>('copilotModel') || 'gpt-4o';
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: copilotModel });
    if (models.length === 0) throw new Error('GitHub Copilot not available');
    const model = models[0];

    const vsMessages: vscode.LanguageModelChatMessage[] = messages.map((m) => {
      if (m.role === 'assistant') return vscode.LanguageModelChatMessage.Assistant(m.content);
      return vscode.LanguageModelChatMessage.User(m.content);
    });

    const chatResponse = await model.sendRequest(
      vsMessages,
      {},
      new vscode.CancellationTokenSource().token,
    );
    let responseText = '';
    for await (const fragment of chatResponse.text) {
      responseText += fragment;
    }
    return responseText;
  } else if (platform === 'lmstudio') {
    const url = config.get<string>('lmStudioUrl') || 'ws://localhost:1234';
    const mdl = config.get<string>('lmStudioModel') || 'qwen/qwen3-coder-30b';
    return getLMStudioChat(messages, url, mdl);
  } else if (platform === 'openai') {
    const apiKey = config.get<string>('openaiApiKey') || '';
    const mdl = config.get<string>('openaiModel') || 'gpt-4o';
    const baseURL = config.get<string>('openaiUrl') || undefined;
    return getOpenAIChat(messages, apiKey, mdl, baseURL);
  } else if (platform === 'anthropic') {
    const apiKey = config.get<string>('anthropicApiKey') || '';
    const mdl = config.get<string>('anthropicModel') || 'claude-opus-4-6';
    return getAnthropicChat(messages, apiKey, mdl);
  } else if (platform === 'opencodego') {
    const apiKey = config.get<string>('opencodegoApiKey') || '';
    const mdl = config.get<string>('opencodegoModel') || 'glm-5.2';
    const baseURL = config.get<string>('opencodegoUrl') || OPENCODE_GO_URL;
    return getOpenCodeGoChat(messages, apiKey, mdl, baseURL);
  } else {
    const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    const mdl = config.get<string>('ollamaModel') || 'gemma3:270m';
    return getOllamaChat(messages, url, mdl);
  }
}

export async function getExtensionChatStreaming(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'ollama';

  if (platform === 'copilot') {
    const copilotModel = config.get<string>('copilotModel') || 'gpt-4o';
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: copilotModel });
    if (models.length === 0) throw new Error('GitHub Copilot not available');
    const model = models[0];
    const vsMessages: vscode.LanguageModelChatMessage[] = messages.map((m) => {
      if (m.role === 'assistant') return vscode.LanguageModelChatMessage.Assistant(m.content);
      return vscode.LanguageModelChatMessage.User(m.content);
    });
    const chatResponse = await model.sendRequest(
      vsMessages,
      {},
      new vscode.CancellationTokenSource().token,
    );
    let full = '';
    for await (const fragment of chatResponse.text) {
      if (fragment) {
        onChunk(fragment);
        full += fragment;
      }
    }
    return full;
  } else if (platform === 'lmstudio') {
    const url = config.get<string>('lmStudioUrl') || 'ws://localhost:1234';
    const mdl = config.get<string>('lmStudioModel') || 'qwen/qwen3-coder-30b';
    return getLMStudioChatStreaming(messages, url, mdl, onChunk);
  } else if (platform === 'openai') {
    const apiKey = config.get<string>('openaiApiKey') || '';
    const mdl = config.get<string>('openaiModel') || 'gpt-4o';
    const baseURL = config.get<string>('openaiUrl') || undefined;
    return getOpenAIChatStreaming(messages, apiKey, mdl, onChunk, baseURL);
  } else if (platform === 'anthropic') {
    const apiKey = config.get<string>('anthropicApiKey') || '';
    const mdl = config.get<string>('anthropicModel') || 'claude-opus-4-6';
    return getAnthropicChatStreaming(messages, apiKey, mdl, onChunk);
  } else if (platform === 'opencodego') {
    const apiKey = config.get<string>('opencodegoApiKey') || '';
    const mdl = config.get<string>('opencodegoModel') || 'glm-5.2';
    const baseURL = config.get<string>('opencodegoUrl') || OPENCODE_GO_URL;
    return getOpenCodeGoChatStreaming(messages, apiKey, mdl, onChunk, baseURL);
  } else {
    const url = config.get<string>('ollamaUrl') || 'http://localhost:11434';
    const mdl = config.get<string>('ollamaModel') || 'gemma3:270m';
    return getOllamaChatStreaming(messages, url, mdl, onChunk);
  }
}

/**
 * Validates the currently configured LLM provider and returns an actionable
 * error message if something is wrong, or null if the config looks good.
 *
 * Checks performed per platform:
 *  - openai / anthropic : API key must be non-empty
 *  - copilot            : selectChatModels must return at least one model
 *  - ollama             : GET <url>/api/tags must succeed within 3 s
 *  - lmstudio           : GET <http-url>/v1/models must succeed within 3 s
 */
export async function validateProviderConfig(): Promise<string | null> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>('llmPlatform') || 'ollama';

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
  } else if (platform === 'copilot') {
    const family = config.get<string>('copilotModel') || 'gpt-4o';
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
    if (models.length === 0) {
      return `ASKII (copilot): No Copilot model available for "${family}". Ensure the GitHub Copilot extension is installed and you are signed in.`;
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
  const platform = resolvePlatform(config, 'inlinePlatform');
  const model = resolveModel(config, platform, config.get<string>('inlineModel'));
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

    if (platform === 'copilot') {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: model });
      if (models.length === 0) return 'Error: GitHub Copilot not available';

      const copilotModel = models[0];
      const messages = [
        vscode.LanguageModelChatMessage.User(systemPrompt),
        vscode.LanguageModelChatMessage.User(userPrompt),
      ];
      const chatResponse = await copilotModel.sendRequest(
        messages,
        {},
        new vscode.CancellationTokenSource().token,
      );

      if (abortSignal?.aborted) throw new Error('Request cancelled');

      let responseText = '';
      for await (const fragment of chatResponse.text) {
        responseText += fragment;
      }
      return responseText || 'No explanation available.';
    } else if (platform === 'lmstudio') {
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
      const baseURL = config.get<string>('opencodegoUrl') || OPENCODE_GO_URL;
      if (abortSignal?.aborted) throw new Error('Request cancelled');
      const result = await getOpenCodeGoResponse(userPrompt, apiKey, model, baseURL, systemPrompt);
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
