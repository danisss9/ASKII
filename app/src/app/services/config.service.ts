import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  PLATFORMS,
  PLATFORM_DEFAULT_MODELS,
  PROVIDER_LABELS,
  PROVIDER_NEEDS_KEY,
  type ProviderId,
} from '@shared/providers';

/** Persisted app configuration (provider/model/keys + broker pairing). */
export interface AppConfig {
  brokerUrl: string;
  /** ASKII Cloud (broker) API key — also used as the askiicloud provider key. */
  apiKey: string;
  provider: ProviderId;
  model: string;
  /** Per-provider API keys (openai / anthropic / opencodego). */
  keys: Partial<Record<ProviderId, string>>;
  ollamaUrl: string;
  lmStudioUrl: string;
  openaiUrl: string;
  /** Remote-session pairing (filled by the Settings QR view). */
  pairingDeviceId?: string;
  pairingToken?: string;
}

const STORE_KEY = 'askii.config';

const DEFAULT_CONFIG: AppConfig = {
  brokerUrl: 'https://api.askii.dev/v1',
  apiKey: '',
  provider: 'askiicloud',
  model: 'askii-smart',
  keys: {},
  ollamaUrl: 'http://localhost:11434',
  lmStudioUrl: 'ws://localhost:1234',
  openaiUrl: '',
};

@Injectable({ providedIn: 'root' })
export class ConfigService {
  readonly PLATFORMS = PLATFORMS;
  readonly PROVIDER_LABELS = PROVIDER_LABELS;
  readonly PROVIDER_NEEDS_KEY = PROVIDER_NEEDS_KEY;
  readonly PLATFORM_DEFAULT_MODELS = PLATFORM_DEFAULT_MODELS;

  private config: AppConfig = { ...DEFAULT_CONFIG };

  async load(): Promise<AppConfig> {
    const { value } = await Preferences.get({ key: STORE_KEY });
    if (value) {
      try {
        this.config = { ...DEFAULT_CONFIG, ...JSON.parse(value) };
      } catch {
        this.config = { ...DEFAULT_CONFIG };
      }
    }
    return this.config;
  }

  get current(): AppConfig {
    return this.config;
  }

  async save(patch: Partial<AppConfig>): Promise<AppConfig> {
    this.config = { ...this.config, ...patch };
    await Preferences.set({ key: STORE_KEY, value: JSON.stringify(this.config) });
    return this.config;
  }

  async setProvider(provider: ProviderId): Promise<void> {
    await this.save({ provider, model: PLATFORM_DEFAULT_MODELS[provider] });
  }

  /**
   * Temporarily apply a config override (used by RemoteSessionService when a
   * controller specifies a different provider/model). Does NOT persist to
   * Preferences — call again with the saved config to restore.
   */
  applyRuntimeConfig(cfg: AppConfig): void {
    this.config = { ...cfg };
  }

  /** Resolve the API key for a provider from the persisted keys map. */
  apiKeyFor(provider: ProviderId): string {
    if (provider === 'askiicloud') return this.config.apiKey;
    return this.config.keys[provider] ?? '';
  }
}