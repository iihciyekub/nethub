const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { resolveSettings } = require('../src/config.js');

test('settings priority is CLI, environment, config, then defaults', () => {
  const settings = resolveSettings(
    { baseUrl: 'https://cli.invalid/', concurrency: '4', force: true, show: true },
    { baseUrl: 'https://config.invalid', concurrency: 2, retries: 4, skipExisting: true },
    { NETHUB_BASE_URL: 'https://env.invalid', NETHUB_RETRIES: '3', NETHUB_DOWNLOAD_DIR: 'out' },
    '/workspace',
  );
  assert.equal(settings.baseUrl, 'https://cli.invalid');
  assert.equal(settings.concurrency, 4);
  assert.equal(settings.retries, 3);
  assert.equal(settings.downloadDir, path.join('/workspace', 'out'));
  assert.equal(settings.skipExisting, false);
  assert.equal(settings.headless, false);
});

test('settings reject a missing endpoint and invalid integers', () => {
  assert.throws(() => resolveSettings({}, {}, {}, '/tmp'), /missing download source/);
  assert.throws(() => resolveSettings({ baseUrl: 'https://example.test', retries: '-1' }, {}, {}, '/tmp'), /retries/);
  assert.throws(() => resolveSettings({ baseUrl: 'https://example.test', concurrency: '5' }, {}, {}, '/tmp'), /concurrency/);
});

test('configured sources are validated and preferred source moves first', () => {
  const settings = resolveSettings(
    { source: 'backup' },
    { sources: [
      { name: 'primary', baseUrl: 'https://one.test/' },
      { name: 'backup', baseUrl: 'https://two.test' },
      { name: 'off', baseUrl: 'https://off.test', enabled: false },
    ] },
    {},
    '/tmp',
  );
  assert.deepEqual(settings.sources, [
    { name: 'backup', baseUrl: 'https://two.test' },
    { name: 'primary', baseUrl: 'https://one.test' },
  ]);
  assert.equal(settings.baseUrl, 'https://two.test');
});

test('one-off base URL override ignores the configured preferred source', () => {
  const settings = resolveSettings(
    { baseUrl: 'https://override.test' },
    { source: 'primary', sources: [{ name: 'primary', baseUrl: 'https://one.test' }] },
    {},
    '/tmp',
  );
  assert.deepEqual(settings.sources, [{ name: 'default', baseUrl: 'https://override.test' }]);
});
