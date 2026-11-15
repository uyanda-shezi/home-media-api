import { describe, it } from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../src/config.js';

describe('Configuration Loader', () => {
  it('loads default values when env is empty', () => {
    const config = loadConfig({});
    assert.strictEqual(config.port, 3000);
    assert.strictEqual(config.databasePath, './data/home-media.db');
    assert.strictEqual(config.jellyfinUrl, undefined);
    assert.strictEqual(config.seerrUrl, undefined);
    assert.strictEqual(config.seerrApiKey, undefined);
  });

  it('parses valid environment variables', () => {
    const config = loadConfig({
      PORT: '8080',
      DATABASE_PATH: '/var/lib/home-media.db',
      JELLYFIN_URL: 'https://jellyfin.local',
      SEERR_URL: 'https://seerr.local',
      SEERR_API_KEY: 'test-key',
    });

    assert.strictEqual(config.port, 8080);
    assert.strictEqual(config.databasePath, '/var/lib/home-media.db');
    assert.strictEqual(config.jellyfinUrl, 'https://jellyfin.local');
    assert.strictEqual(config.seerrUrl, 'https://seerr.local');
    assert.strictEqual(config.seerrApiKey, 'test-key');
  });

  it('throws an error on invalid port numbers', () => {
    assert.throws(() => loadConfig({ PORT: 'not-a-number' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: '-1' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: '70000' }), /Invalid PORT/);
    assert.throws(() => loadConfig({ PORT: '0' }), /Invalid PORT/);
  });
});
