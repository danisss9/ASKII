export const PROVIDER_IDS = [
  'askiicloud',
  'openai',
  'anthropic',
  'opencodego',
  'ollama',
  'lmstudio',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  description: string;
  connection: 'apiKey' | 'serverUrl';
  secretSetting?: string;
  urlSetting?: 'ollamaUrl' | 'lmStudioUrl';
  supportsCustomBaseUrl?: boolean;
}

export const PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'askiicloud',
    label: 'ASKII Cloud',
    description: 'ASKII-hosted models with sensible defaults for every ASKII feature.',
    connection: 'apiKey',
    secretSetting: 'askiicloudApiKey',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'OpenAI models or another OpenAI-compatible service using an optional base URL.',
    connection: 'apiKey',
    secretSetting: 'openaiApiKey',
    supportsCustomBaseUrl: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models served by the Anthropic API.',
    connection: 'apiKey',
    secretSetting: 'anthropicApiKey',
  },
  {
    id: 'opencodego',
    label: 'opencode Go',
    description: 'Hosted coding models from the opencode Go inference service.',
    connection: 'apiKey',
    secretSetting: 'opencodegoApiKey',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Run downloaded models locally through an Ollama server.',
    connection: 'serverUrl',
    urlSetting: 'ollamaUrl',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    description: 'Use LLMs downloaded in a locally running LM Studio instance.',
    connection: 'serverUrl',
    urlSetting: 'lmStudioUrl',
  },
];

export interface ModelSelections {
  general: string;
  inline: string;
  vision: string;
}

export function buildModelSettingUpdates(
  provider: ProviderId,
  selections: ModelSelections,
): Record<string, string> {
  return {
    llmPlatform: provider,
    llmModel: selections.general,
    llmInlinePlatform: provider,
    llmInlineModel: selections.inline,
    llmVisionPlatform: provider,
    llmVisionModel: selections.vision,
  };
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function getProviderDefinition(provider: ProviderId): ProviderDefinition {
  const definition = PROVIDERS.find((candidate) => candidate.id === provider);
  if (!definition) {
    throw new Error(`Unknown provider: ${provider}`);
  }
  return definition;
}

export function normalizeModelIds(ids: readonly unknown[]): string[] {
  return Array.from(
    new Set(
      ids
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

export function chooseInitialModels(
  provider: ProviderId,
  availableModels: readonly string[],
  configuredPlatforms: { general: string; inline: string; vision: string },
  configuredModels: ModelSelections,
): ModelSelections {
  const available = new Set(availableModels);
  const matching = (role: keyof ModelSelections): string =>
    configuredPlatforms[role] === provider && available.has(configuredModels[role])
      ? configuredModels[role]
      : '';

  const selected: ModelSelections = {
    general: matching('general'),
    inline: matching('inline'),
    vision: matching('vision'),
  };

  if (provider === 'askiicloud') {
    if (!selected.general && available.has('askii-smart')) {
      selected.general = 'askii-smart';
    }
    if (!selected.inline && available.has('askii-fast')) {
      selected.inline = 'askii-fast';
    }
    if (!selected.vision && available.has('askii-smart')) {
      selected.vision = 'askii-smart';
    }
  }

  return selected;
}

export function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number') {
    return status;
  }
  const responseStatus = (error as { response?: { status?: unknown } }).response?.status;
  return typeof responseStatus === 'number' ? responseStatus : undefined;
}

export function isAuthenticationError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 401 || status === 403;
}

export function isUnsupportedModelListError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 404 || status === 405 || status === 501;
}

const DISCOVERY_TIMEOUT_MS = 10_000;

export class ProviderConnectionError extends Error {
  constructor(
    message: string,
    readonly kind: 'missing' | 'authentication' | 'connection' | 'timeout',
  ) {
    super(message);
    this.name = 'ProviderConnectionError';
  }
}

export interface InspectedStringSetting {
  globalValue?: string;
  workspaceValue?: string;
  workspaceFolderValue?: string;
}

export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

export function getLegacyCredentialValue(inspected: InspectedStringSetting | undefined): string {
  if (!inspected) {
    return '';
  }
  const values = [inspected.workspaceFolderValue, inspected.workspaceValue, inspected.globalValue];
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? '';
}

export async function migrateLegacyCredential(
  secretKey: string,
  legacyValue: string,
  secrets: SecretStore,
  clearLegacyValue: () => Promise<void>,
): Promise<void> {
  const existing = await secrets.get(secretKey);
  if (!existing?.trim()) {
    await secrets.store(secretKey, legacyValue);
  }
  await clearLegacyValue();
}

export function withDiscoveryTimeout<T>(
  promise: Promise<T>,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ProviderConnectionError('The provider did not respond within 10 seconds.', 'timeout'),
        ),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}
