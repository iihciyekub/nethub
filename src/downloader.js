const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const DOWNLOAD_SELECTOR = [
  'a[download]', 'a[href*="download"]', 'a[href$=".pdf"]',
  'a[href*="/pdf"]', 'object[data]', 'embed[src]', 'iframe[src*=".pdf"]',
].join(', ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeFileName(doi) {
  const normalized = doi.normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/[. ]+$/g, '');
  return `${normalized || 'document'}.pdf`;
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

async function atomicWrite(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, data);
    await fs.rename(temporary, filePath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validatePdf(buffer, contentType = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5 || buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error('download candidate is not a PDF (missing PDF signature)');
  }
  if (contentType && !/application\/pdf|application\/octet-stream/i.test(contentType)) {
    throw new Error(`download candidate is not a PDF (${contentType})`);
  }
}

async function savePdfFromContext(context, url, outputPath, referer, timeout) {
  const response = await context.request.get(url, {
    timeout,
    maxRedirects: 5,
    headers: { accept: 'application/pdf,*/*;q=0.8', referer },
  });
  if (!response.ok()) throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
  const buffer = await response.body();
  validatePdf(buffer, response.headers()['content-type'] || '');
  await atomicWrite(outputPath, buffer);
}

async function isBlocked(page) {
  const source = `${await page.title().catch(() => '')}\n${await page.locator('body').innerText().catch(() => '')}\n${page.frames().map((frame) => frame.url()).join('\n')}`;
  return /DDoS-Guard|Checking your browser|Please wait a few seconds|not a robot|robot check|captcha|recaptcha|hcaptcha/i.test(source);
}

async function waitForVerification(page, timeout, doi) {
  process.stderr.write(`[${doi}] verification detected; complete it in the browser within ${Math.round(timeout / 1000)} seconds.\n`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await isBlocked(page)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function copyCookies(fromContext, toContext) {
  const { cookies } = await fromContext.storageState();
  if (cookies.length) await toContext.addCookies(cookies);
}

async function findDownloadUrl(page, timeout) {
  await page.waitForFunction((selector) => Boolean(document.querySelector(selector)), DOWNLOAD_SELECTOR, { timeout }).catch(() => {});
  const candidate = await page.evaluate(() => {
    const candidates = [...document.querySelectorAll('a[href], object[data], embed[src], iframe[src]')].map((element) => {
      const href = (element.getAttribute('href') || element.getAttribute('data') || element.getAttribute('src') || '').trim();
      const text = (element.textContent || '').toLowerCase();
      const lower = href.toLowerCase();
      const score = (element.hasAttribute('download') ? 100 : 0) + (text.includes('download') ? 40 : 0) +
        (lower.includes('download') ? 30 : 0) + (lower.endsWith('.pdf') ? 25 : 0) + (lower.includes('/pdf') ? 15 : 0);
      return { href, score };
    }).filter((item) => item.href).sort((a, b) => b.score - a.score);
    return candidates[0]?.href || '';
  });
  return candidate ? new URL(candidate, page.url()).href : '';
}

async function positionWindow(context, page, settings) {
  if (settings.headless) return;
  const session = await context.newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: {
      left: settings.windowX, top: settings.windowY, width: settings.windowWidth,
      height: settings.windowHeight, windowState: 'normal',
    } });
  } finally { await session.detach().catch(() => {}); }
}

async function launchContext(settings, chromiumApi = chromium) {
  const launch = { headless: settings.headless };
  if (!settings.headless) launch.args = [`--window-position=${settings.windowX},${settings.windowY}`, `--window-size=${settings.windowWidth},${settings.windowHeight}`];
  if (settings.profileDir) {
    await fs.mkdir(settings.profileDir, { recursive: true });
    const context = await chromiumApi.launchPersistentContext(settings.profileDir, { ...launch, ...(settings.headless ? {} : { viewport: null }) });
    return { context, verifyChallenge: createVerificationHandler(context, settings, chromiumApi), close: () => context.close() };
  }
  const browser = await chromiumApi.launch(launch);
  const context = await browser.newContext(settings.headless ? {} : { viewport: null });
  return { context, verifyChallenge: createVerificationHandler(context, settings, chromiumApi), close: () => browser.close() };
}

function createVerificationHandler(primaryContext, settings, chromiumApi = chromium) {
  let queue = Promise.resolve();
  return (blockedPage, doi) => {
    const verify = async () => {
      await blockedPage.reload({ waitUntil: 'domcontentloaded', timeout: settings.timeout }).catch(() => {});
      if (!await isBlocked(blockedPage)) return true;

      process.stderr.write(`[${doi}] verification detected; opening a visible browser window.\n`);
      const launch = {
        headless: false,
        args: [`--window-position=${settings.windowX},${settings.windowY}`, `--window-size=${settings.windowWidth},${settings.windowHeight}`],
        viewport: null,
      };
      let verificationContext;
      let close;
      if (settings.profileDir) {
        verificationContext = await chromiumApi.launchPersistentContext(`${settings.profileDir}-verification`, launch);
        close = () => verificationContext.close();
      } else {
        const browser = await chromiumApi.launch({ headless: false, args: launch.args });
        verificationContext = await browser.newContext({ viewport: null });
        close = () => browser.close();
      }

      try {
        await copyCookies(primaryContext, verificationContext);
        const page = await verificationContext.newPage();
        await positionWindow(verificationContext, page, { ...settings, headless: false });
        await page.goto(blockedPage.url(), { waitUntil: 'domcontentloaded', timeout: settings.timeout });
        if (!await waitForVerification(page, settings.verificationTimeout, doi)) return false;
        await copyCookies(verificationContext, primaryContext);
      } finally {
        await close().catch(() => {});
      }

      await blockedPage.reload({ waitUntil: 'domcontentloaded', timeout: settings.timeout }).catch(() => {});
      return !await isBlocked(blockedPage);
    };
    queue = queue.then(verify, verify);
    return queue;
  };
}

function articleUrl(baseUrl, doi) {
  return `${baseUrl}/${doi.split('/').map(encodeURIComponent).join('/')}`;
}

async function downloadOne(context, doi, settings, source = { name: 'default', baseUrl: settings.baseUrl }) {
  const page = await context.newPage();
  try {
    await positionWindow(context, page, settings);
    await page.goto(articleUrl(source.baseUrl, doi), { waitUntil: 'domcontentloaded', timeout: settings.timeout });
    if (await isBlocked(page)) {
      const verified = settings.headless && settings.verifyChallenge
        ? await settings.verifyChallenge(page, doi)
        : await waitForVerification(page, settings.verificationTimeout, doi);
      if (!verified) throw new Error('blocked by protection page');
    }
    const downloadUrl = await findDownloadUrl(page, settings.timeout);
    if (!downloadUrl) throw new Error('PDF download link not found');
    const outputPath = path.join(settings.downloadDir, safeFileName(doi));
    await savePdfFromContext(context, downloadUrl, outputPath, page.url(), settings.timeout);
    return { doi, ok: true, path: outputPath, source: source.name };
  } finally { await page.close().catch(() => {}); }
}

async function downloadWithRetry(context, doi, settings, operation = downloadOne) {
  const outputPath = path.join(settings.downloadDir, safeFileName(doi));
  if (settings.skipExisting && await exists(outputPath)) return { doi, ok: true, skipped: true, path: outputPath, attempts: 0 };
  const sources = settings.sources?.length ? settings.sources : [{ name: 'default', baseUrl: settings.baseUrl }];
  const errors = [];
  let attempts = 0;
  for (let round = 0; round <= settings.retries; round += 1) {
    for (const source of sources) {
      attempts += 1;
      try {
        return { ...await operation(context, doi, { ...settings, baseUrl: source.baseUrl }, source), attempts };
      } catch (error) {
        errors.push({ source: source.name, reason: error.message });
        process.stderr.write(`[${doi}] source ${source.name}, attempt ${round + 1} failed: ${error.message}\n`);
      }
    }
    if (round < settings.retries) await sleep(250 * (round + 1));
  }
  return { doi, ok: false, reason: errors.at(-1)?.reason || 'unknown error', attempts, errors };
}

async function runBatch(context, dois, settings, operation = downloadOne) {
  const results = new Array(dois.length);
  let cursor = 0;
  async function worker() {
    while (cursor < dois.length) {
      const index = cursor++;
      results[index] = await downloadWithRetry(context, dois[index], settings, operation);
    }
  }
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, dois.length) }, worker));
  return results;
}

module.exports = { articleUrl, atomicWrite, createVerificationHandler, downloadOne, downloadWithRetry, findDownloadUrl, launchContext, runBatch, safeFileName, savePdfFromContext, validatePdf };
