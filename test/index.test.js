const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { downloadBatch } = require('../src/index.js');

test('downloadBatch writes the complete summary and failed DOI list', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-batch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = { downloadDir: directory, concurrency: 2, retries: 1, timeout: 50, verificationTimeout: 100, baseUrl: 'https://example.test' };
  const payload = await downloadBatch(['10.1/ok', '10.1/fail'], ['bad'], settings, {
    launchContext: async () => ({ context: {}, close: async () => {} }),
    runBatch: async () => [{ doi: '10.1/ok', ok: true }, { doi: '10.1/fail', ok: false, reason: 'fixture' }],
  });
  assert.deepEqual(payload.invalidDois, ['bad']);
  assert.equal(JSON.parse(await fs.readFile(payload.summaryPath, 'utf8')).results.length, 2);
  assert.equal(await fs.readFile(payload.failedPath, 'utf8'), '10.1/fail\n');
});
