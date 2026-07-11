const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWrite, launchContext, runBatch } = require('./downloader.js');

async function downloadBatch(requestedDois, invalidDois, settings, dependencies = {}) {
  await fs.mkdir(settings.downloadDir, { recursive: true });
  const launched = await (dependencies.launchContext || launchContext)(settings);
  let results;
  try {
    const runtimeSettings = launched.verifyChallenge ? { ...settings, verifyChallenge: launched.verifyChallenge } : settings;
    results = await (dependencies.runBatch || runBatch)(launched.context, requestedDois, runtimeSettings);
  } finally {
    await launched.close();
  }
  const failedDois = results.filter((item) => !item.ok).map((item) => item.doi);
  const summaryPath = path.join(settings.downloadDir, 'download-results.json');
  const failedPath = path.join(settings.downloadDir, 'failed-dois.txt');
  const payload = {
    requestedDois, invalidDois, results, downloadDir: settings.downloadDir,
    concurrency: settings.concurrency, retries: settings.retries, timeout: settings.timeout,
    verificationTimeout: settings.verificationTimeout, baseUrl: settings.baseUrl, sources: settings.sources,
    summaryPath, failedPath,
  };
  await atomicWrite(summaryPath, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`));
  await atomicWrite(failedPath, Buffer.from(failedDois.join('\n') + (failedDois.length ? '\n' : '')));
  return payload;
}

module.exports = { downloadBatch };
