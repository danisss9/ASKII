import * as vscode from 'vscode';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { Ollama } from 'ollama';
import { LMStudioClient } from '@lmstudio/sdk';
// Relative (not the `@common` alias) so the tsc-compiled test output can resolve it at
// runtime — tsc does not rewrite path aliases, and only esbuild bundles understand `@common`.
import { ASKII_CLOUD_URL, OPENCODE_GO_URL, getOpenCodeGoHeaders } from '../common/providers';
import {
  PROVIDERS,
  ProviderConnectionError,
  type InspectedStringSetting,
  type ProviderId,
  getLegacyCredentialValue,
  getProviderDefinition,
  isAuthenticationError,
  isUnsupportedModelListError,
  migrateLegacyCredential,
  normalizeModelIds,
  withDiscoveryTimeout,
} from './setupCore';

// Re-exported so existing imports of these helpers keep working; they live in
// setupCore.ts so plain-Node unit tests can load them without `vscode`.
export {
  ProviderConnectionError,
  getLegacyCredentialValue,
  migrateLegacyCredential,
  withDiscoveryTimeout,
} from './setupCore';

const SECRET_KEYS: Readonly<Partial<Record<ProviderId, string>>> = {
  askiicloud: 'askii.credentials.askiicloud.apiKey',
  openai: 'askii.credentials.openai.apiKey',
  anthropic: 'askii.credentials.anthropic.apiKey',
  opencodego: 'askii.credentials.opencodego.apiKey',
};

let providerSecrets: vscode.SecretStorage | undefined;

export interface ProviderConnection {
  apiKey?: string;
  serverUrl?: string;
  openaiBaseUrl?: string;
}

export type ModelDiscoveryResult =
  | { mode: 'models'; models: string[] }
  | { mode: 'manual'; models: []; warning: string };

export function initializeProviderSecrets(secrets: vscode.SecretStorage): void {
  providerSecrets = secrets;
}

export function getSecretKey(provider: ProviderId): string | undefined {
  return SECRET_KEYS[provider];
}

export async function getProviderApiKey(provider: ProviderId): Promise<string> {
  const key = SECRET_KEYS[provider];
  if (!key || !providerSecrets) {
    return '';
  }
  return (await providerSecrets.get(key))?.trim() ?? '';
}

export async function storeProviderApiKey(provider: ProviderId, apiKey: string): Promise<void> {
  const key = SECRET_KEYS[provider];
  if (!key || !providerSecrets) {
    throw new Error(`Secret storage is not available for ${provider}.`);
  }
  await providerSecrets.store(key, apiKey.trim());
}

export async function deleteProviderApiKey(provider: ProviderId): Promise<void> {
  const key = SECRET_KEYS[provider];
  if (!key || !providerSecrets) {
    return;
  }
  await providerSecrets.delete(key);
}

/** Lets the user pick a provider with a stored key and removes it from secret storage. */
export async function clearApiKeyCommand(): Promise<void> {
  const status = await getSavedCredentialStatus();
  const items = PROVIDERS.filter((p) => status[p.id]).map((p) => ({
    label: p.label,
    description: 'API key stored in VS Code secret storage',
    id: p.id,
  }));
  if (items.length === 0) {
    vscode.window.showInformationMessage('ASKII: No API keys are stored.');
    return;
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Remove which stored API key?',
  });
  if (!pick) {
    return;
  }
  await deleteProviderApiKey(pick.id);
  vscode.window.showInformationMessage(`ASKII: ${pick.label} API key removed.`);
}

export async function getSavedCredentialStatus(): Promise<Record<ProviderId, boolean>> {
  const entries = await Promise.all(
    PROVIDERS.map(async ({ id }) => [id, Boolean(await getProviderApiKey(id))] as const),
  );
  return Object.fromEntries(entries) as Record<ProviderId, boolean>;
}

async function clearLegacySetting(
  config: vscode.WorkspaceConfiguration,
  setting: string,
  inspected: InspectedStringSetting | undefined,
): Promise<void> {
  if (!inspected) {
    return;
  }
  if (inspected.globalValue !== undefined) {
    await config.update(setting, undefined, vscode.ConfigurationTarget.Global);
  }
  if (inspected.workspaceValue !== undefined) {
    await config.update(setting, undefined, vscode.ConfigurationTarget.Workspace);
  }
  if (inspected.workspaceFolderValue !== undefined) {
    await config.update(setting, undefined, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

export async function migrateLegacyApiKeys(context: vscode.ExtensionContext): Promise<string[]> {
  const config = vscode.workspace.getConfiguration('askii');
  const problems: string[] = [];

  for (const provider of PROVIDERS) {
    if (!provider.secretSetting) {
      continue;
    }
    const secretKey = SECRET_KEYS[provider.id];
    if (!secretKey) {
      continue;
    }
    const inspected = config.inspect<string>(provider.secretSetting);
    const legacyValue = getLegacyCredentialValue(inspected);
    if (!legacyValue) {
      continue;
    }

    try {
      await migrateLegacyCredential(secretKey, legacyValue, context.secrets, () =>
        clearLegacySetting(config, provider.secretSetting!, inspected),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push(`${provider.label}: ${message}`);
    }
  }

  return problems;
}

export async function isProviderStructurallyConfigured(provider: ProviderId): Promise<boolean> {
  const definition = getProviderDefinition(provider);
  const config = vscode.workspace.getConfiguration('askii');
  if (definition.connection === 'apiKey') {
    return Boolean(await getProviderApiKey(provider));
  }
  const url = definition.urlSetting ? config.get<string>(definition.urlSetting) : '';
  return Boolean(url?.trim());
}

export async function isCurrentConfigurationComplete(): Promise<boolean> {
  const config = vscode.workspace.getConfiguration('askii');
  const platformKeys = ['llmPlatform', 'llmInlinePlatform', 'llmVisionPlatform'] as const;
  const modelKeys = ['llmModel', 'llmInlineModel', 'llmVisionModel'] as const;
  const platforms = platformKeys.map((key) => config.get<string>(key));
  if (platforms.some((platform) => !PROVIDERS.some(({ id }) => id === platform))) {
    return false;
  }
  if (modelKeys.some((key) => !config.get<string>(key)?.trim())) {
    return false;
  }
  const uniqueProviders = Array.from(new Set(platforms)) as ProviderId[];
  const configured = await Promise.all(uniqueProviders.map(isProviderStructurallyConfigured));
  return configured.every(Boolean);
}

async function listOpenAIModels(
  apiKey: string,
  baseURL?: string,
  extraHeaders?: Record<string, string>,
): Promise<string[]> {
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(extraHeaders ? { defaultHeaders: extraHeaders } : {}),
  });
  const page = await client.models.list();
  return page.data.map((model) => model.id);
}

async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey });
  const ids: string[] = [];
  for await (const model of client.models.list()) {
    ids.push(model.id);
  }
  return ids;
}

async function listOllamaModels(serverUrl: string): Promise<string[]> {
  const response = await new Ollama({ host: serverUrl }).list();
  return response.models.map((model) => model.model || model.name);
}

async function listLMStudioModels(serverUrl: string): Promise<string[]> {
  const client = new LMStudioClient({ baseUrl: serverUrl });
  const models = await client.system.listDownloadedModels('llm');
  return models.map((model) => model.path);
}

function manualDiscovery(provider: ProviderId, detail: string): ModelDiscoveryResult {
  const label = getProviderDefinition(provider).label;
  return {
    mode: 'manual',
    models: [],
    warning: `${label} is reachable, but its model list is unavailable (${detail}). Enter model IDs manually.`,
  };
}

export async function discoverProviderModels(
  provider: ProviderId,
  connection: ProviderConnection,
): Promise<ModelDiscoveryResult> {
  const definition = getProviderDefinition(provider);
  const apiKey = connection.apiKey?.trim() ?? '';
  const serverUrl = connection.serverUrl?.trim() ?? '';
  if (definition.connection === 'apiKey' && !apiKey) {
    throw new ProviderConnectionError(`${definition.label} requires an API key.`, 'missing');
  }
  if (definition.connection === 'serverUrl' && !serverUrl) {
    throw new ProviderConnectionError(`${definition.label} requires a server URL.`, 'missing');
  }

  try {
    let ids: string[];
    if (provider === 'askiicloud') {
      ids = await withDiscoveryTimeout(listOpenAIModels(apiKey, ASKII_CLOUD_URL));
    } else if (provider === 'openai') {
      ids = await withDiscoveryTimeout(
        listOpenAIModels(apiKey, connection.openaiBaseUrl?.trim() || undefined),
      );
    } else if (provider === 'anthropic') {
      ids = await withDiscoveryTimeout(listAnthropicModels(apiKey));
    } else if (provider === 'opencodego') {
      ids = await withDiscoveryTimeout(
        listOpenAIModels(apiKey, OPENCODE_GO_URL, getOpenCodeGoHeaders()),
      );
    } else if (provider === 'ollama') {
      ids = await withDiscoveryTimeout(listOllamaModels(serverUrl));
    } else {
      ids = await withDiscoveryTimeout(listLMStudioModels(serverUrl));
    }

    const models = normalizeModelIds(ids);
    return models.length > 0
      ? { mode: 'models', models }
      : manualDiscovery(provider, 'the provider returned no models');
  } catch (error) {
    if (error instanceof ProviderConnectionError) {
      throw error;
    }
    if (isAuthenticationError(error)) {
      throw new ProviderConnectionError(
        `${definition.label} rejected the API key. Check the credential and try again.`,
        'authentication',
      );
    }
    if (isUnsupportedModelListError(error)) {
      return manualDiscovery(provider, 'the model-list endpoint is not supported');
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProviderConnectionError(
      `Could not connect to ${definition.label}: ${detail}`,
      'connection',
    );
  }
}
