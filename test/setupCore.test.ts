import assert from 'assert';
import { suite, test } from 'mocha';
import {
  PROVIDERS,
  buildModelSettingUpdates,
  chooseInitialModels,
  isAuthenticationError,
  isCommitMessageStyle,
  isUnsupportedModelListError,
  normalizeModelIds,
  parseBoundedInt,
  parseGlobList,
} from '../src/setupCore';
import {
  ProviderConnectionError,
  withDiscoveryTimeout,
} from '../src/setupCore';
suite('src/setupCore', () => {
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

  test('bounded integer parsing accepts whole values and rejects blank, fractional, and small ones', () => {
    assert.strictEqual(parseBoundedInt('Max rounds', ' 25 ', 1), 25);
    assert.strictEqual(parseBoundedInt('Timeout', '0', 0), 0);
    assert.throws(() => parseBoundedInt('Max rounds', '', 1), /Max rounds/);
    assert.throws(() => parseBoundedInt('Max rounds', '12.5', 1), /Max rounds/);
    assert.throws(() => parseBoundedInt('Max rounds', 'abc', 1), /Max rounds/);
    assert.throws(() => parseBoundedInt('Snooze', '0', 1), /at least 1/);
  });

  test('glob lists split on lines and commas, then trim and dedupe', () => {
    assert.deepStrictEqual(parseGlobList('**/.env\n **/*.pem ,\n**/.env\n\n'), [
      '**/.env',
      '**/*.pem',
    ]);
    assert.deepStrictEqual(parseGlobList(''), []);
  });

  test('commit message style accepts only the known values', () => {
    assert.strictEqual(isCommitMessageStyle('brief'), true);
    assert.strictEqual(isCommitMessageStyle('descriptive'), true);
    assert.strictEqual(isCommitMessageStyle('concise'), false);
    assert.strictEqual(isCommitMessageStyle(undefined), false);
  });

  test('discovery error classification distinguishes authentication and unsupported endpoints', () => {
    assert.strictEqual(isAuthenticationError({ status: 401 }), true);
    assert.strictEqual(isAuthenticationError({ response: { status: 403 } }), true);
    assert.strictEqual(isUnsupportedModelListError({ status: 404 }), true);
    assert.strictEqual(isUnsupportedModelListError({ status: 500 }), false);
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
});
