const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { findConfigPath, resolveSettings } = require('../src/config.js');

test('config lookup supports explicit, environment, local, and global paths', async () => {
  const existing = new Set(['/work/nethub.config.json', '/home/user/.config/nethub/config.json']);
  const access = async (candidate) => { if (!existing.has(candidate)) throw new Error('missing'); };
  assert.equal(await findConfigPath('/chosen.json', {}, '/work', '/home/user', access), '/chosen.json');
  assert.equal(await findConfigPath(undefined, { NETHUB_CONFIG: 'shared.json' }, '/work', '/home/user', access), '/work/shared.json');
  assert.equal(await findConfigPath(undefined, {}, '/work', '/home/user', access), '/work/nethub.config.json');
  existing.delete('/work/nethub.config.json');
  assert.equal(await findConfigPath(undefined, {}, '/work', '/home/user', access), '/home/user/.config/nethub/config.json');
});

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

test('settings use doi.org by default and reject invalid integers', () => {
  const defaults = resolveSettings({}, {}, {}, '/tmp');
  assert.deepEqual(defaults.sources, [{ name: 'doi.org', baseUrl: 'https://doi.org' }]);
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
