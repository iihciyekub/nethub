const assert = require('node:assert/strict');
const test = require('node:test');
const { compareVersions, installationPrefix, latestRelease, updateNethub } = require('../src/update.js');

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

test('installation prefix follows the currently running global package', () => {
  assert.equal(installationPrefix('/opt/homebrew/lib/node_modules/nethub/src'), '/opt/homebrew');
  assert.equal(installationPrefix('/home/user/.npm/node_modules/nethub/src'), '/home/user/.npm');
  assert.equal(installationPrefix('/work/nethub/src'), '');
});

test('update check reports a newer release without installing', async () => {
  let installed = false;
  const writes = [];
  const result = await updateNethub(
    { checkOnly: true, stdout: { write: (value) => writes.push(value) } },
    { fetchApi: async () => response('v0.0.18'), execFileApi: async () => { installed = true; } },
  );
  assert.equal(result.latestVersion, '0.0.18');
  assert.equal(installed, false);
  assert.match(writes.join(''), /latest release: 0\.0\.18/);
});

test('update installs the tagged GitHub archive globally', async () => {
  let invocation;
  await updateNethub(
    { stdout: { write: () => {} } },
    {
      fetchApi: async () => response('v0.0.18'),
      execFileApi: async (...args) => { invocation = args; },
      installationPrefix: '/opt/homebrew',
    },
  );
  assert.deepEqual(invocation[1], [
    'install', '--global', '--prefix', '/opt/homebrew',
    'https://github.com/iihciyekub/nethub/archive/refs/tags/v0.0.18.tar.gz',
  ]);
});
