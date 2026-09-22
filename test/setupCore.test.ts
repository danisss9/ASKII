import assert from 'assert';
import test from 'node:test';
import {
  PROVIDERS,
  buildModelSettingUpdates,
  chooseInitialModels,
  isAuthenticationError,
  isUnsupportedModelListError,
  normalizeModelIds,
} from '../src/setupCore';
import {
  ProviderConnectionError,
  getLegacyCredentialValue,
  migrateLegacyCredential,
  withDiscoveryTimeout,
} from '../src/providerSecrets';

test('provider registry uses the setup display order and describes every provider', () => {
  assert.deepStrictEqual(
    PROVIDERS.map((provider) => provider.id),
    ['askiicloud', 'openai', 'anthropic', 'opencodego', 'ollama', 'lmstudio'],
  );
  assert.ok(PROVIDERS.every((provider) => provider.label && provider.description));
});

test('model ids are trimmed, deduplicated, emptied, and sorted', () => {
  assert.deepStrictEqual(normalizeModelIds([' zeta ', '', 'Alpha', 'zeta', null]), [
    'Alpha',
    'zeta',
  ]);
});

test('ASKII Cloud defaults preserve matching configured selections first', () => {
  const selected = chooseInitialModels(
    'askiicloud',
    ['askii-fast', 'askii-smart', 'custom-vision'],
    { general: 'askiicloud', inline: 'openai', vision: 'askiicloud' },
    { general: 'custom-vision', inline: 'gpt', vision: 'custom-vision' },
  );
  assert.deepStrictEqual(selected, {
    general: 'custom-vision',
    inline: 'askii-fast',
    vision: 'custom-vision',
  });
});

test('model settings map one provider onto all three roles', () => {
  assert.deepStrictEqual(
    buildModelSettingUpdates('ollama', {
      general: 'large',
      inline: 'fast',
      vision: 'vision',
    }),
    {
      llmPlatform: 'ollama',
      llmModel: 'large',
      llmInlinePlatform: 'ollama',
      llmInlineModel: 'fast',
      llmVisionPlatform: 'ollama',
      llmVisionModel: 'vision',
    },
  );
});

test('discovery error classification distinguishes authentication and unsupported endpoints', () => {
  assert.strictEqual(isAuthenticationError({ status: 401 }), true);
  assert.strictEqual(isAuthenticationError({ response: { status: 403 } }), true);
  assert.strictEqual(isUnsupportedModelListError({ status: 404 }), true);
  assert.strictEqual(isUnsupportedModelListError({ status: 500 }), false);
});

test('legacy credential precedence is folder, workspace, then global', () => {
  assert.strictEqual(
    getLegacyCredentialValue({
      globalValue: 'global',
      workspaceValue: 'workspace',
      workspaceFolderValue: 'folder',
    }),
    'folder',
  );
});

test('legacy migration stores before clearing and preserves an existing secret', async () => {
  const events: string[] = [];
  const values = new Map<string, string>();
  await migrateLegacyCredential(
    'secret',
    'legacy',
    {
      get: async (key) => values.get(key),
      store: async (key, value) => {
        events.push('store');
        values.set(key, value);
      },
    },
    async () => {
      events.push('clear');
    },
  );
  assert.deepStrictEqual(events, ['store', 'clear']);
  assert.strictEqual(values.get('secret'), 'legacy');

  events.length = 0;
  values.set('secret', 'existing');
  await migrateLegacyCredential(
    'secret',
    'legacy',
    {
      get: async (key) => values.get(key),
      store: async () => {
        events.push('store');
      },
    },
    async () => {
      events.push('clear');
    },
  );
  assert.deepStrictEqual(events, ['clear']);
  assert.strictEqual(values.get('secret'), 'existing');
});

test('failed secret storage does not clear the legacy setting', async () => {
  let cleared = false;
  await assert.rejects(
    migrateLegacyCredential(
      'secret',
      'legacy',
      {
        get: async () => undefined,
        store: async () => {
          throw new Error('credential store unavailable');
        },
      },
      async () => {
        cleared = true;
      },
    ),
    /credential store unavailable/,
  );
  assert.strictEqual(cleared, false);
});

test('model discovery timeout returns an actionable timeout error', async () => {
  await assert.rejects(
    withDiscoveryTimeout(new Promise<never>(() => undefined), 5),
    (error: unknown) =>
      error instanceof ProviderConnectionError &&
      error.kind === 'timeout' &&
      /10 seconds/.test(error.message),
  );
});
