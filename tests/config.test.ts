import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../src/config.js';

describe('Configuration Loader', () => {
  it('loads default values when env is empty', () => {
    const config = loadConfig({});
    assert.strictEqual(config.port, 3000);
    assert.strictEqual(config.databasePath, './data/home-media.db');
    assert.strictEqual(config.jellyfinUrl, undefined);
    assert.strictEqual(config.jellyfinPublicUrl, undefined);
    assert.strictEqual(config.seerrUrl, undefined);
    assert.strictEqual(config.seerrApiKey, undefined);
    assert.strictEqual(typeof config.sessionSecret, 'string');
    assert.ok(config.sessionSecret.length >= 32);
    assert.strictEqual(config.sessionTtlDays, 7);
    assert.strictEqual(config.secureCookies, false);
  });

  it('parses valid environment variables', () => {
    const config = loadConfig({
      PORT: '8080',
      DATABASE_PATH: '/var/lib/home-media.db',
      JELLYFIN_URL: 'https://jellyfin.local',
      JELLYFIN_PUBLIC_URL: 'https://jellyfin.public.lan',
      SEERR_URL: 'https://seerr.local',
      SEERR_API_KEY: 'test-key',
      SESSION_SECRET: 'custom_secret_key_that_is_at_least_32_characters_long',
      SESSION_TTL_DAYS: '14',
    });

    assert.strictEqual(config.port, 8080);
    assert.strictEqual(config.databasePath, '/var/lib/home-media.db');
    assert.strictEqual(config.jellyfinUrl, 'https://jellyfin.local');
    assert.strictEqual(config.jellyfinPublicUrl, 'https://jellyfin.public.lan');
    assert.strictEqual(config.seerrUrl, 'https://seerr.local');
    assert.strictEqual(config.seerrApiKey, 'test-key');
    assert.strictEqual(config.sessionSecret, 'custom_secret_key_that_is_at_least_32_characters_long');
    assert.strictEqual(config.sessionTtlDays, 14);
  });

  it('throws an error on invalid port numbers', () => {
    assert.throws(() => loadConfig({ PORT: 'not-a-number' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: '-1' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: '70000' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: '0' }), /Invalid PORT/);
  });

  it('validates SESSION_SECRET in production mode', () => {
    // Missing or short secret in production must throw
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production' }),
      /SESSION_SECRET must be at least 32 characters long in production/
    );
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'too_short' }),
      /SESSION_SECRET must be at least 32 characters long in production/
    );

    // Valid secret in production passes
    const config = loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'production_secret_key_at_least_32_characters_long_12345',
    });
    assert.strictEqual(config.sessionSecret, 'production_secret_key_at_least_32_characters_long_12345');
    assert.strictEqual(config.secureCookies, true);

    const explicitCookieConfig = loadConfig({
      SECURE_COOKIES: 'true',
    });
    assert.strictEqual(explicitCookieConfig.secureCookies, true);
  });

  it('throws an error on invalid SESSION_TTL_DAYS', () => {
    assert.throws(() => loadConfig({ SESSION_TTL_DAYS: 'not-a-number' }), /Invalid SESSION_TTL_DAYS/);
    assert.throws(() => loadConfig({ SESSION_TTL_DAYS: '0' }), /Invalid SESSION_TTL_DAYS/);
    assert.throws(() => loadConfig({ SESSION_TTL_DAYS: '-5' }), /Invalid SESSION_TTL_DAYS/);
  });
});

it('requires exact sync opt-in and independently validates an optional webhook secret', () => {
  for (const value of [undefined, '', 'false', 'TRUE', ' true ', '1']) {
    assert.equal(loadConfig({ SYNC_ENABLED: value }).syncEnabled, false);
  }
  assert.equal(loadConfig({ SYNC_ENABLED: 'true' }).syncEnabled, true);
  assert.equal(loadConfig({ SYNC_WEBHOOK_SECRET: ' ' }).syncWebhookSecret, undefined);
  assert.equal(loadConfig({ SYNC_WEBHOOK_SECRET: 's'.repeat(32) }).syncWebhookSecret, 's'.repeat(32));
  assert.throws(() => loadConfig({ SYNC_WEBHOOK_SECRET: 'short' }), /32 characters/);
});
