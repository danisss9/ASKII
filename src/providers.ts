import * as vscode from 'vscode';
import {
  DEFAULT_LMSTUDIO_URL,
  DEFAULT_OLLAMA_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  complete,
  isPlatformId,
  type ChatMessage,
  type ChatReply,
  type CompletionRequest,
  type ProviderConnection,
} from '@common/providers';
import { hasWikiIndex, searchWikiRaw } from '@common/wiki';
import { hasCodeWikiIndex, searchCodeWikiRaw } from '@common/codewiki';
import { getProviderApiKey, isProviderStructurallyConfigured } from './providerSecrets';
import { getProviderDefinition, isProviderId } from './setupCore';
import { log } from './log';

/** Which settings pair (platform + model) a feature uses. */
export type FeatureRole = 'general' | 'inline' | 'vision';

const ROLE_SETTINGS: Record<FeatureRole, { platform: string; model: string; fallback: string }> = {
  general: { platform: 'llmPlatform', model: 'llmModel', fallback: 'askii-smart' },
  inline: { platform: 'llmInlinePlatform', model: 'llmInlineModel', fallback: 'askii-fast' },
  vision: { platform: 'llmVisionPlatform', model: 'llmVisionModel', fallback: 'askii-smart' },
};

/**
 * Resolves the model id for a feature role. An empty per-role model falls
 * back to the general `askii.llmModel` only when both roles use the same
 * platform — a model id from another provider would just fail.
 */
export function resolveModel(config: vscode.WorkspaceConfiguration, role: FeatureRole): string {
  const settings = ROLE_SETTINGS[role];
  const model = config.get<string>(settings.model)?.trim();
  if (model && model !== 'default') {
    return model;
  }
  const platform = config.get<string>(settings.platform) || 'askiicloud';
  const generalPlatform = config.get<string>(ROLE_SETTINGS.general.platform) || 'askiicloud';
  const generalModel = config.get<string>(ROLE_SETTINGS.general.model)?.trim();
  if (role !== 'general' && platform === generalPlatform && generalModel) {
    return generalModel;
  }
  return settings.fallback;
}

/** Builds the provider connection (platform, model, key, URL) for a feature role. */
export async function getConnection(role: FeatureRole): Promise<ProviderConnection> {
  const config = vscode.workspace.getConfiguration('askii');
  const platform = config.get<string>(ROLE_SETTINGS[role].platform) || 'askiicloud';
  if (!isPlatformId(platform)) {
    throw new Error(`Unknown LLM platform "${platform}" — run ASKII: Open Setup.`);
  }
  const model = resolveModel(config, role);
  switch (platform) {
    case 'ollama':
      return { platform, model, baseURL: config.get<string>('ollamaUrl') || DEFAULT_OLLAMA_URL };
    case 'lmstudio':
      return { platform, model, baseURL: config.get<string>('lmStudioUrl') || DEFAULT_LMSTUDIO_URL };
    case 'openai':
      return {
        platform,
        model,
        apiKey: await getProviderApiKey('openai'),
        baseURL: config.get<string>('openaiUrl') || undefined,
      };
    default:
      return { platform, model, apiKey: await getProviderApiKey(platform) };
  }
}

function requestDefaults(): Pick<CompletionRequest, 'timeoutMs' | 'maxTokens'> {
  const config = vscode.workspace.getConfiguration('askii');
  const timeoutSeconds = config.get<number>('requestTimeoutSeconds');
  const maxTokens = config.get<number>('maxOutputTokens') ?? 0;
  return {
    timeoutMs:
      typeof timeoutSeconds === 'number' && timeoutSeconds >= 0
        ? timeoutSeconds * 1000
        : DEFAULT_REQUEST_TIMEOUT_MS,
    maxTokens: maxTokens > 0 ? maxTokens : undefined,
  };
}

/**
 * Sends a request with the platform/model configured for `role`. Abort,
 * timeout and retries are handled by @common/providers complete().
 */
export async function extensionComplete(
  role: FeatureRole,
  request: CompletionRequest,
): Promise<ChatReply> {
  const connection = await getConnection(role);
  return complete(connection, {
    ...requestDefaults(),
    onRetry: (attempt, error, delayMs) =>
      log.warn(
        `${connection.platform} request failed (${error.message}) — retry ${attempt} in ${delayMs / 1000}s`,
      ),
    ...request,
  });
}

/** One prompt → reply text, with the given role's platform and model. */
export async function getExtensionResponse(
  prompt: string,
  system?: string,
  role: FeatureRole = 'general',
  signal?: AbortSignal,
): Promise<string> {
  const messages: ChatMessage[] = system
    ? [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ]
    : [{ role: 'user', content: prompt }];
  return (await extensionComplete(role, { messages, signal })).text;
}

/** Streams a reply to one prompt (general role). */
export async function getExtensionResponseStreaming(
  prompt: string,
  onChunk: (chunk: string) => void,
  system?: string,
  signal?: AbortSignal,
): Promise<string> {
  const messages: ChatMessage[] = system
    ? [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ]
    : [{ role: 'user', content: prompt }];
  return (await extensionComplete('general', { messages, onChunk, signal })).text;
}

/** Streams a chat reply (general role), reporting whether it was cut off. */
export async function getExtensionChatStreaming(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<ChatReply> {
  return extensionComplete('general', { messages, onChunk, signal });
}

/** Vision request: a prompt plus a base64 PNG screenshot (vision role). */
export async function getExtensionResponseWithImage(
  prompt: string,
  imageBase64: string,
  signal?: AbortSignal,
): Promise<string> {
  return (
    await extensionComplete('vision', {
      messages: [{ role: 'user', content: prompt }],
      image: imageBase64,
      signal,
    })
  ).text;
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
  const roles = [
    ['llmPlatform', 'general features'],
    ['llmInlinePlatform', 'inline features'],
    ['llmVisionPlatform', 'vision features'],
  ] as const;

  for (const [setting, role] of roles) {
    const platform = config.get<string>(setting) || 'askiicloud';
    if (!isProviderId(platform)) {
      return `ASKII has an unknown provider configured for ${role}.`;
    }
    if (!(await isProviderStructurallyConfigured(platform))) {
      const provider = getProviderDefinition(platform);
      const requirement = provider.connection === 'apiKey' ? 'API key' : 'server URL';
      return `ASKII ${provider.label} needs a ${requirement} for ${role}. Run ASKII: Open Setup.`;
    }
  }
  return null;
}

/**
 * Gathers retrieval context from every wiki enabled in settings — the docs
 * wiki (askii.wikiEnabled) and the code wiki (askii.codeWikiEnabled) — and
 * returns the hits as labeled sections. Returns an empty string when no wiki
 * is enabled/indexed or nothing matches; retrieval errors degrade silently.
 */
export async function getEnabledWikiContext(query: string, topK = 2): Promise<string> {
  const q = query.trim();
  if (!q) {return '';}
  const config = vscode.workspace.getConfiguration('askii');
  const sections: string[] = [];

  if (config.get<boolean>('wikiEnabled') ?? false) {
    const wikiPath = config.get<string>('wikiPath') ?? '';
    if (wikiPath && hasWikiIndex(wikiPath)) {
      try {
        const hits = await searchWikiRaw(wikiPath, q, topK);
        if (hits.length > 0) {
          sections.push(
            'Documentation:\n' +
              hits.map((h) => `[${h.source} — ${h.heading}]\n${h.content}`).join('\n\n---\n\n'),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Search failed';
        log.warn(`[wiki] ${message}`);
      }
    }
  }

  if (config.get<boolean>('codeWikiEnabled') ?? false) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root && hasCodeWikiIndex(root)) {
      try {
        const hits = await searchCodeWikiRaw(root, q, topK);
        if (hits.length > 0) {
          sections.push(
            'Code:\n' + hits.map((h) => `[${h.heading}]\n${h.content}`).join('\n\n---\n\n'),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Search failed';
        log.warn(`[code wiki] ${message}`);
      }
    }
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Inline explanation for one line of code. Returns '' when the helper is off.
 * Throws on provider errors (and on abort) so callers don't cache a failure.
 */
export async function getLLMExplanation(
  lineText: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const config = vscode.workspace.getConfiguration('askii');
  const mode = config.get<string>('inlineHelperMode') || 'off';

  if (mode === 'off') {return '';}

  // Wiki mode: search every enabled wiki (docs + code) for context, then ask
  // the LLM with that context
  let wikiContext = '';
  if (mode === 'wiki') {
    wikiContext = await getEnabledWikiContext(lineText, 2);
    if (!wikiContext) {
      const wikiPath = config.get<string>('wikiPath') ?? '';
      const wikiSetUp =
        ((config.get<boolean>('wikiEnabled') ?? false) && !!wikiPath) ||
        (config.get<boolean>('codeWikiEnabled') ?? false);
      return wikiSetUp
        ? 'Run "ASKII: Reload Wikis" to build the wiki index'
        : 'Enable wiki RAG (set askii.wikiPath) or Code Wiki (askii.codeWikiEnabled), then run "ASKII: Reload Wikis"';
    }
  }

  const isHelpful = mode === 'helpful' || mode === 'wiki';
  const systemPrompt = isHelpful
    ? 'You are ASKII, a helpful coding assistant. Provide clear, concise explanations.'
    : 'You are ASKII, a witty coding assistant. Provide humorous comments.';
  const wikiSection = wikiContext ? `Relevant context:\n${wikiContext}\n\n` : '';
  const userPrompt = isHelpful
    ? `${wikiSection}Explain this code in one sentence: ${lineText}`
    : `Make a funny comment about this code in one sentence: ${lineText}`;

  const result = await getExtensionResponse(userPrompt, systemPrompt, 'inline', abortSignal);
  return result.trim() || 'No explanation available.';
}
