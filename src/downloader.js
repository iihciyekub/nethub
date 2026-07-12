const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const DOWNLOAD_SELECTOR = [
  'a[download]', 'a[href*="download"]', 'a[href$=".pdf"]',
  'a[href*="/pdf"]', 'object[data]', 'embed[src]', 'iframe[src*=".pdf"]',
].join(', ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function downloadError(code, message, retryable = false) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

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
    throw downloadError('NOT_PDF', 'download candidate is not a PDF (missing PDF signature)');
  }
  if (contentType && !/application\/pdf|application\/octet-stream/i.test(contentType)) {
    throw downloadError('NOT_PDF', `download candidate is not a PDF (${contentType})`);
  }
}

async function savePdfFromContext(context, url, outputPath, referer, timeout) {
  let response;
  try {
    response = await context.request.get(url, {
      timeout,
      maxRedirects: 5,
      headers: { accept: 'application/pdf,*/*;q=0.8', referer },
    });
  } catch (error) {
    error.code = /timeout/i.test(error.message) ? 'PDF_DOWNLOAD_TIMEOUT' : 'PDF_DOWNLOAD_FAILED';
    error.retryable = true;
    throw error;
  }
  if (!response.ok()) {
    const status = response.status();
    throw downloadError(`HTTP_${status}`, `HTTP ${status} ${response.statusText()}`, status === 429 || status >= 500);
  }
  const buffer = await response.body();
  validatePdf(buffer, response.headers()['content-type'] || '');
  await atomicWrite(outputPath, buffer);
}

function pdfUrlFromResponse(response) {
  if (!response) return '';
  const headers = response.headers?.() || {};
  const contentType = headers['content-type'] || '';
  const disposition = headers['content-disposition'] || '';
  const url = response.url?.() || '';
  if (!/^https?:/i.test(url)) return '';
  return /application\/pdf/i.test(contentType) || /filename\*?=.*\.pdf/i.test(disposition) ? url : '';
}

async function loadedPdfUrl(page, navigation, observedPdfUrl = '') {
  const responseUrl = observedPdfUrl || pdfUrlFromResponse(navigation);
  if (responseUrl) return responseUrl;
  const viewerOpen = await page.evaluate(() => (
    document.contentType === 'application/pdf' ||
    Boolean(document.querySelector('embed[type="application/pdf"], pdf-viewer'))
  )).catch(() => false);
  return viewerOpen && /^https?:/i.test(page.url()) ? page.url() : '';
}

async function isBlocked(page) {
  const source = `${await page.title().catch(() => '')}\n${await page.locator('body').innerText().catch(() => '')}\n${page.frames().map((frame) => frame.url()).join('\n')}`;
  const markerSelector = [
    'iframe[src*="captcha" i]', 'iframe[src*="challenge" i]', 'iframe[title*="challenge" i]',
    '.cf-turnstile', '.g-recaptcha', '[data-sitekey]', '[id*="captcha" i]', '[class*="captcha" i]',
    '#challenge-stage', '#challenge-running',
  ].join(', ');
  const hasMarker = await page.locator(markerSelector).count().then((count) => count > 0).catch(() => false);
  return hasMarker || /DDoS-Guard|Checking your browser|Please wait a few seconds|Just a moment|not a robot|robot check|captcha|recaptcha|hcaptcha|verify (that )?you are human|are you (a )?human|human verification|security (check|verification)|是否.{0,6}机器人|确认.{0,6}(真人|人类)|真人验证|人机验证|安全验证|点击.{0,8}(验证|确认)/i.test(source);
}

function waitForUserConfirmation(input, timeout) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const wasPaused = input.isPaused?.() ?? true;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      if (wasPaused) input.pause?.();
      resolve(confirmed);
    };
    const onData = () => finish(true);
    timer = setTimeout(() => finish(false), timeout);
    input.once('data', onData);
    input.resume?.();
  });
}

async function waitForVerification(page, timeout, doi, io = process) {
  io.stderr.write(`[${doi}] verification window is open for up to ${Math.round(timeout / 1000)} seconds.\n`);
  if (io.stdin?.isTTY) {
    io.stderr.write(`[${doi}] finish the browser verification, then return here and press Enter.\n`);
    return waitForUserConfirmation(io.stdin, timeout);
  }
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!await isBlocked(page)) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function copyBrowserState(fromContext, toContext) {
  const { cookies, origins = [] } = await fromContext.storageState();
  if (cookies.length) await toContext.addCookies(cookies);
  if (origins.length) {
    await toContext.addInitScript((storedOrigins) => {
      const current = storedOrigins.find((item) => item.origin === location.origin);
      for (const item of current?.localStorage || []) localStorage.setItem(item.name, item.value);
    }, origins);
  }
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
  return (blockedPage, doi, reason = 'verification required') => {
    const verify = async () => {
      process.stderr.write(`[${doi}] ${reason}; opening a visible browser window.\n`);
      const launch = {
        headless: false,
        args: [`--window-position=${settings.windowX},${settings.windowY}`, `--window-size=${settings.windowWidth},${settings.windowHeight}`],
        viewport: null,
      };
      let verificationContext;
      let close;
      let verifiedPdfUrl = '';
      if (settings.profileDir) {
        verificationContext = await chromiumApi.launchPersistentContext(`${settings.profileDir}-verification`, launch);
        close = () => verificationContext.close();
      } else {
        const browser = await chromiumApi.launch({ headless: false, args: launch.args });
        verificationContext = await browser.newContext({ viewport: null });
        close = () => browser.close();
      }

      try {
        await copyBrowserState(primaryContext, verificationContext);
        const page = await verificationContext.newPage();
        let observedPdfUrl = '';
        page.on?.('response', (response) => {
          const url = pdfUrlFromResponse(response);
          if (url) observedPdfUrl = url;
        });
        await positionWindow(verificationContext, page, { ...settings, headless: false });
        const navigation = await page.goto(blockedPage.url(), { waitUntil: 'domcontentloaded', timeout: settings.timeout }).catch(() => null);
        if (!await waitForVerification(page, settings.verificationTimeout, doi)) return false;
        verifiedPdfUrl = await loadedPdfUrl(page, navigation, observedPdfUrl);
        await copyBrowserState(verificationContext, primaryContext);
      } finally {
        await close().catch(() => {});
      }

      if (!verifiedPdfUrl) await blockedPage.reload({ waitUntil: 'domcontentloaded', timeout: settings.timeout }).catch(() => {});
      return { verified: true, pdfUrl: verifiedPdfUrl };
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
    const outputPath = path.join(settings.downloadDir, safeFileName(doi));
    let observedPdfUrl = '';
    page.on?.('response', (response) => {
      const url = pdfUrlFromResponse(response);
      if (url) observedPdfUrl = url;
    });
    const saveLoadedPdf = async (navigationResponse) => {
      const url = await loadedPdfUrl(page, navigationResponse, observedPdfUrl);
      if (!url) return false;
      await savePdfFromContext(context, url, outputPath, page.url(), settings.downloadTimeout ?? settings.timeout);
      return true;
    };
    const saveVerifiedPdf = async (verification) => {
      const url = typeof verification === 'object' ? verification.pdfUrl : '';
      if (!url) return false;
      await savePdfFromContext(context, url, outputPath, page.url(), settings.downloadTimeout ?? settings.timeout);
      return true;
    };
    const verificationPassed = (verification) => verification === true || verification?.verified === true;
    let navigation;
    let navigationError;
    try {
      navigation = await page.goto(articleUrl(source.baseUrl, doi), { waitUntil: 'domcontentloaded', timeout: settings.timeout });
    } catch (error) {
      error.code = /timeout/i.test(error.message) ? 'NAVIGATION_TIMEOUT' : 'NAVIGATION_FAILED';
      error.retryable = true;
      navigationError = error;
    }
    const navigationStatus = navigation?.status();
    if (navigationStatus === 404 || navigationStatus === 410) {
      throw downloadError('PAGE_NOT_FOUND', `source page returned HTTP ${navigationStatus}`);
    }
    if (await saveLoadedPdf(navigation)) return { doi, ok: true, path: outputPath, source: source.name };
    let verificationAttempted = false;
    const blocked = await isBlocked(page);
    const protectedStatus = [401, 403, 429].includes(navigationStatus);
    if (blocked || protectedStatus) {
      verificationAttempted = true;
      const verification = settings.headless && settings.verifyChallenge
        ? await settings.verifyChallenge(page, doi, protectedStatus ? `source returned HTTP ${navigationStatus}` : 'human verification required')
        : await waitForVerification(page, settings.verificationTimeout, doi, settings.verificationIo || process);
      if (!verificationPassed(verification)) throw downloadError('VERIFICATION_TIMEOUT', 'manual verification timed out');
      if (await saveVerifiedPdf(verification)) return { doi, ok: true, path: outputPath, source: source.name };
      navigationError = null;
    }
    if (await saveLoadedPdf(navigation)) return { doi, ok: true, path: outputPath, source: source.name };
    if (navigationError) throw navigationError;
    let downloadUrl = await findDownloadUrl(page, settings.linkTimeout ?? settings.timeout);
    if (!downloadUrl && await saveLoadedPdf(navigation)) return { doi, ok: true, path: outputPath, source: source.name };
    if (!downloadUrl && !verificationAttempted) {
      verificationAttempted = true;
      const verification = settings.headless && settings.verifyChallenge
        ? await settings.verifyChallenge(page, doi, 'PDF link not found; manual review required')
        : await waitForVerification(page, settings.verificationTimeout, doi, settings.verificationIo || process);
      if (verificationPassed(verification)) {
        if (await saveVerifiedPdf(verification)) return { doi, ok: true, path: outputPath, source: source.name };
        if (await saveLoadedPdf(navigation)) return { doi, ok: true, path: outputPath, source: source.name };
        downloadUrl = await findDownloadUrl(page, settings.linkTimeout ?? settings.timeout);
      }
    }
    if (!downloadUrl) throw downloadError('PDF_LINK_NOT_FOUND', 'PDF download link not found');
    await savePdfFromContext(context, downloadUrl, outputPath, page.url(), settings.downloadTimeout ?? settings.timeout);
    return { doi, ok: true, path: outputPath, source: source.name };
  } finally { await page.close().catch(() => {}); }
}

async function downloadWithRetry(context, doi, settings, operation = downloadOne) {
  const startedAt = Date.now();
  const outputPath = path.join(settings.downloadDir, safeFileName(doi));
  if (settings.skipExisting && await exists(outputPath)) {
    return { doi, ok: true, status: 'downloaded', skipped: true, path: outputPath, attempts: 0, elapsedMs: Date.now() - startedAt };
  }
  const sources = settings.sources?.length ? settings.sources : [{ name: 'default', baseUrl: settings.baseUrl }];
  const errors = [];
  let attempts = 0;
  let roundSources = sources;
  for (let round = 0; round <= settings.retries; round += 1) {
    const retryableSources = [];
    for (const source of roundSources) {
      attempts += 1;
      try {
        return {
          ...await operation(context, doi, { ...settings, baseUrl: source.baseUrl }, source),
          status: 'downloaded', attempts, elapsedMs: Date.now() - startedAt,
        };
      } catch (error) {
        if (error.retryable !== false) retryableSources.push(source);
        errors.push({ source: source.name, code: error.code || 'DOWNLOAD_FAILED', reason: error.message });
        process.stderr.write(`[${doi}] source ${source.name}, attempt ${round + 1} failed: ${error.message}\n`);
      }
    }
    if (!retryableSources.length) break;
    roundSources = retryableSources;
    if (round < settings.retries) await sleep(250 * (round + 1));
  }
  return {
    doi, ok: false, status: 'source_not_found', reason: 'PDF source not found',
    attempts, elapsedMs: Date.now() - startedAt, errors,
  };
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

module.exports = { articleUrl, atomicWrite, createVerificationHandler, downloadError, downloadOne, downloadWithRetry, findDownloadUrl, isBlocked, launchContext, loadedPdfUrl, pdfUrlFromResponse, runBatch, safeFileName, savePdfFromContext, validatePdf, waitForUserConfirmation, waitForVerification };
