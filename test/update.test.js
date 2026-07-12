const assert = require('node:assert/strict');
const test = require('node:test');
const { compareVersions, latestRelease, updateNethub } = require('../src/update.js');

function response(tagName, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ tag_name: tagName }) };
}

test('compareVersions compares numeric release components', () => {
  assert.equal(compareVersions('0.0.2', '0.0.1'), 1);
  assert.equal(compareVersions('v0.0.1', '0.0.1'), 0);
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
});

test('latestRelease validates GitHub response and version tag', async () => {
  assert.equal((await latestRelease(async () => response('v0.0.2'))).tag_name, 'v0.0.2');
  await assert.rejects(() => latestRelease(async () => response('latest')), /invalid version tag/);
  await assert.rejects(() => latestRelease(async () => response('', 503)), /HTTP 503/);
});

test('update check reports a newer release without installing', async () => {
  let installed = false;
  const writes = [];
  const result = await updateNethub(
    { checkOnly: true, stdout: { write: (value) => writes.push(value) } },
    { fetchApi: async () => response('v0.0.9'), execFileApi: async () => { installed = true; } },
  );
  assert.equal(result.latestVersion, '0.0.9');
  assert.equal(installed, false);
  assert.match(writes.join(''), /latest release: 0\.0\.9/);
});

test('update installs the tagged GitHub archive globally', async () => {
  let invocation;
  await updateNethub(
    { stdout: { write: () => {} } },
    { fetchApi: async () => response('v0.0.9'), execFileApi: async (...args) => { invocation = args; } },
  );
  assert.deepEqual(invocation[1], [
    'install', '--global', 'https://github.com/iihciyekub/nethub/archive/refs/tags/v0.0.9.tar.gz',
  ]);
});
