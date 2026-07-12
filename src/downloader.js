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
  const contentType = response.headers()['content-type'] || '';
  try {
    validatePdf(buffer, contentType);
  } catch (error) {
    if (/text\/|html|json|xml/i.test(contentType)) error.responseText = buffer.subarray(0, 65536).toString('utf8');
    throw error;
  }
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
  return viewerOpen === true && /^https?:/i.test(page.url()) ? page.url() : '';
}

function unavailableTextReason(text) {
  const unavailable = [
    /the\s+following\s+(?:paper|article)\s+is\s+not\s+yet\s+available\s+in\s+(?:my|our|the)\s+database/i,
    /(?:paper|article)\s+(?:is|was)\s+not\s+(?:yet\s+)?available\s+in\s+(?:my|our|the)\s+database/i,
    /(?:we\s+(?:do\s+not|don't)\s+have|could\s+not\s+find|couldn't\s+find)\s+(?:this|the)\s+(?:paper|article)/i,
    /no\s+(?:paper|article|pdf)\s+(?:was\s+)?found/i,
    /(?:数据库中|资料库中).{0,12}(?:尚无|没有|未找到).{0,8}(?:论文|文章)/,
    /(?:论文|文章).{0,8}(?:尚未收录|暂未收录|不可用|未找到)/,
  ].some((pattern) => pattern.test(text));
  return unavailable ? 'source reports that the paper is unavailable' : '';
}

async function unavailablePageReason(page) {
  const text = `${await page.title().catch(() => '')}\n${await page.locator('body').innerText().catch(() => '')}`;
  return unavailableTextReason(text);
}

function isHumanVerificationText(text) {
  return /DDoS-Guard|Checking your browser|Please wait a few seconds|Just a moment|not a robot|robot check|captcha|recaptcha|hcaptcha|verify (that )?you are human|are you (a )?human|human verification|security (check|verification)|是否.{0,6}机器人|确认.{0,6}(真人|人类)|真人验证|人机验证|安全验证|点击.{0,8}(验证|确认)|あなたはロボットですか|ロボットではありません|人間であることを確認/i.test(text);
}

async function isBlocked(page) {
  const source = `${await page.title().catch(() => '')}\n${await page.locator('body').innerText().catch(() => '')}\n${page.frames().map((frame) => frame.url()).join('\n')}`;
  const markerSelector = [
    'iframe[src*="captcha" i]', 'iframe[src*="challenge" i]', 'iframe[title*="challenge" i]',
    '.cf-turnstile', '.g-recaptcha', '[data-sitekey]', '[id*="captcha" i]', '[class*="captcha" i]',
    '#challenge-stage', '#challenge-running',
  ].join(', ');
  const hasMarker = await page.locator(markerSelector).count().then((count) => count > 0).catch(() => false);
  return hasMarker || isHumanVerificationText(source);
}

async function requiresHumanInteraction(page) {
  if (await isBlocked(page)) return true;
  const loginSelector = 'input[type="password"], form[action*="login" i], form[action*="signin" i]';
  const hasLoginForm = await page.locator(loginSelector).count().then((count) => count > 0).catch(() => false);
  if (hasLoginForm) return true;
  const text = `${await page.title().catch(() => '')}\n${await page.locator('body').innerText().catch(() => '')}`;
  return /(?:sign|log) in to continue|please (?:sign|log) in|请先?登录|登录后(?:继续|下载)/i.test(text);
}

function waitForUserConfirmation(input, timeout, signal) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (confirmed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      signal?.removeEventListener('abort', onAbort);
      input.pause?.();
      input.unref?.();
      resolve(confirmed);
    };
    const onData = () => finish(true);
    const onAbort = () => finish(false);
    if (signal?.aborted) return finish(false);
    timer = setTimeout(() => finish(false), timeout);
    input.once('data', onData);
    signal?.addEventListener('abort', onAbort, { once: true });
    input.ref?.();
    input.resume?.();
  });
}

function abortableDelay(timeout, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, timeout);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

async function waitForAutomaticVerification(page, timeout, signal, pollInterval = 500) {
  const deadline = Date.now() + timeout;
  let sawHumanCheck = false;
  let stablePasses = 0;
  while (Date.now() < deadline && !signal?.aborted) {
    if (await loadedPdfUrl(page, null)) return true;
    const needsHuman = await requiresHumanInteraction(page);
    if (needsHuman) {
      sawHumanCheck = true;
      stablePasses = 0;
    } else if (sawHumanCheck) {
      stablePasses += 1;
      if (stablePasses >= 2) return true;
    }
    await abortableDelay(pollInterval, signal);
  }
  return false;
}

async function waitForVerification(page, timeout, doi, io = process) {
  io.stderr.write(`[${doi}] verification window is open for up to ${Math.round(timeout / 1000)} seconds.\n`);
  if (io.stdin?.isTTY) {
    io.stderr.write(`[${doi}] complete verification in the browser; continuation is automatic, or press Enter to continue manually.\n`);
    const controller = new AbortController();
    const automatic = waitForAutomaticVerification(page, timeout, controller.signal, io.pollInterval || 500)
      .then((confirmed) => ({ mode: 'automatic', confirmed }));
    const manual = waitForUserConfirmation(io.stdin, timeout, controller.signal)
      .then((confirmed) => ({ mode: 'manual', confirmed }));
    const result = await Promise.race([automatic, manual]);
    controller.abort();
    if (result.confirmed && result.mode === 'automatic') {
      io.stderr.write(`[${doi}] verification passed; continuing automatically.\n`);
    }
    return result.confirmed;
  }
  return waitForAutomaticVerification(page, timeout);
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

async function findDownloadUrls(page, timeout) {
  await page.waitForFunction((selector) => Boolean(document.querySelector(selector)), DOWNLOAD_SELECTOR, { timeout }).catch(() => {});
  const candidates = await page.evaluate(() => (
    [...document.querySelectorAll('a[href], object[data], embed[src], iframe[src]')].map((element) => {
      const href = (element.getAttribute('href') || element.getAttribute('data') || element.getAttribute('src') || '').trim();
      const text = (element.textContent || '').toLowerCase();
      const lower = href.toLowerCase();
      const score = (element.hasAttribute('download') ? 100 : 0) + (text.includes('download') ? 40 : 0) +
        (lower.includes('download') ? 30 : 0) + (lower.endsWith('.pdf') ? 25 : 0) + (lower.includes('/pdf') ? 15 : 0);
      return { href, score };
    }).filter((item) => item.href && item.score > 0).sort((a, b) => b.score - a.score)
  ));
  const urls = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    try {
      const url = new URL(candidate.href, page.url()).href;
      if (/^https?:/i.test(url) && !urls.includes(url)) urls.push(url);
    } catch { /* ignore malformed link candidates */ }
  }
  return urls;
}

async function findDownloadUrl(page, timeout) {
  return (await findDownloadUrls(page, timeout))[0] || '';
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
    const candidateErrors = [];
    const tryDownloadCandidates = async () => {
      const urls = await findDownloadUrls(page, settings.linkTimeout ?? settings.timeout);
      for (const url of urls) {
        try {
          await savePdfFromContext(context, url, outputPath, page.url(), settings.downloadTimeout ?? settings.timeout);
          return true;
        } catch (error) {
          candidateErrors.push({
            url, code: error.code || 'DOWNLOAD_FAILED', reason: error.message,
            responseText: error.responseText || '',
          });
        }
      }
      return false;
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
    let unavailableReason = await unavailablePageReason(page);
    if (unavailableReason) throw downloadError('SOURCE_NOT_FOUND', unavailableReason);
    let verificationAttempted = false;
    const needsHuman = await requiresHumanInteraction(page);
    if (needsHuman) {
      verificationAttempted = true;
      if (settings.deferManualReview) {
        throw downloadError('MANUAL_REVIEW_REQUIRED', 'human verification or login required');
      }
      const verification = settings.headless && settings.verifyChallenge
        ? await settings.verifyChallenge(page, doi, 'human verification or login required')
        : await waitForVerification(page, settings.verificationTimeout, doi, settings.verificationIo || process);
      if (!verificationPassed(verification)) throw downloadError('VERIFICATION_TIMEOUT', 'manual verification timed out');
      if (await saveVerifiedPdf(verification)) return { doi, ok: true, path: outputPath, source: source.name };
      navigationError = null;
    }
    if (await saveLoadedPdf(navigation)) return { doi, ok: true, path: outputPath, source: source.name };
    unavailableReason = await unavailablePageReason(page);
    if (unavailableReason) throw downloadError('SOURCE_NOT_FOUND', unavailableReason);
    if (navigationError) throw navigationError;
    if (await tryDownloadCandidates()) return { doi, ok: true, path: outputPath, source: source.name };
    if (await saveLoadedPdf(navigation)) return { doi, ok: true, path: outputPath, source: source.name };
    const candidateText = candidateErrors.map((error) => error.responseText).filter(Boolean).join('\n');
    unavailableReason = unavailableTextReason(candidateText);
    if (unavailableReason) throw downloadError('SOURCE_NOT_FOUND', unavailableReason);
    const lateHumanCheck = await requiresHumanInteraction(page) || isHumanVerificationText(candidateText);
    if (!verificationAttempted) {
      if (lateHumanCheck) {
        verificationAttempted = true;
        if (settings.deferManualReview) throw downloadError('MANUAL_REVIEW_REQUIRED', 'human verification or login required');
        const verification = settings.headless && settings.verifyChallenge
          ? await settings.verifyChallenge(page, doi, 'human verification or login required')
          : await waitForVerification(page, settings.verificationTimeout, doi, settings.verificationIo || process);
        if (verificationPassed(verification)) {
          if (await saveVerifiedPdf(verification)) return { doi, ok: true, path: outputPath, source: source.name };
          if (await saveLoadedPdf(navigation)) return { doi, ok: true, path: outputPath, source: source.name };
          if (await tryDownloadCandidates()) return { doi, ok: true, path: outputPath, source: source.name };
        }
      }
    }
    if (candidateErrors.length) {
      const error = downloadError('PDF_CANDIDATES_INVALID', 'all PDF link candidates returned non-PDF content');
      error.candidates = candidateErrors;
      throw error;
    }
    throw downloadError('PDF_LINK_NOT_FOUND', 'PDF download link not found');
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
        const message = error.code === 'MANUAL_REVIEW_REQUIRED'
          ? `[${doi}] queued for manual review on source ${source.name}: ${error.message}`
          : `[${doi}] source ${source.name}, attempt ${round + 1} failed: ${error.message}`;
        const logFailure = settings.logFailure || ((value) => process.stderr.write(`${value}\n`));
        logFailure(message);
      }
    }
    if (!retryableSources.length) break;
    roundSources = retryableSources;
    if (round < settings.retries) await sleep(250 * (round + 1));
  }
  const manualSources = [...new Set(errors.filter((error) => error.code === 'MANUAL_REVIEW_REQUIRED').map((error) => error.source))];
  if (manualSources.length) {
    return {
      doi, ok: false, status: 'manual_required', reason: 'Manual review required',
      manualSources, attempts, elapsedMs: Date.now() - startedAt, errors,
    };
  }
  return {
    doi, ok: false, status: 'source_not_found', reason: 'PDF source not found',
    attempts, elapsedMs: Date.now() - startedAt, errors,
  };
}

async function runBatch(context, dois, settings, operation = downloadOne) {
  const results = new Array(dois.length);
  const configuredSources = settings.sources?.length
    ? settings.sources
    : [{ name: 'default', baseUrl: settings.baseUrl }];
  let cursor = 0;
  let active = 0;
  let processed = 0;
  let targetConcurrency = Math.min(3, settings.concurrency, dois.length);
  const minimumConcurrency = Math.min(2, targetConcurrency);
  let successStreak = 0;
  const progressStream = settings.progressStream || process.stderr;
  const logFailure = (message) => {
    progressStream.write(progressStream.isTTY ? `\r\x1b[2K${message}\n` : `${message}\n`);
  };
  const reportProgress = (finish = false) => {
    if (!progressStream.isTTY) return;
    const downloaded = results.filter((item) => item?.ok).length;
    const missing = results.filter((item) => item?.status === 'source_not_found').length;
    const manual = results.filter((item) => item?.status === 'manual_required').length;
    const waiting = Math.max(0, dois.length - processed - active);
    progressStream.write(`\r\x1b[2KProgress ${processed}/${dois.length} | Active ${active} | Limit ${targetConcurrency} | Waiting ${waiting} | Manual ${manual} | Downloaded ${downloaded} | Missing ${missing}${finish ? '\n' : ''}`);
  };
  const adjustConcurrency = (result) => {
    const pressure = result.errors?.some((error) => (
      error.code === 'HTTP_429' || error.code === 'NAVIGATION_TIMEOUT' ||
      error.code === 'VERIFICATION_TIMEOUT' || error.code === 'MANUAL_REVIEW_REQUIRED'
    ));
    if (pressure) {
      targetConcurrency = Math.max(minimumConcurrency, targetConcurrency - 1);
      successStreak = 0;
    } else if (result.ok) {
      successStreak += 1;
      if (successStreak >= 4 && targetConcurrency < settings.concurrency) {
        targetConcurrency += 1;
        successStreak = 0;
      }
    }
  };
  async function worker(workerIndex) {
    while (cursor < dois.length) {
      while (workerIndex >= targetConcurrency && cursor < dois.length) await sleep(25);
      if (cursor >= dois.length) return;
      const index = cursor++;
      active += 1;
      reportProgress();
      results[index] = await downloadWithRetry(context, dois[index], {
        ...settings, deferManualReview: true, logFailure,
      }, operation);
      active -= 1;
      processed += 1;
      adjustConcurrency(results[index]);
      reportProgress();
    }
  }
  reportProgress();
  await Promise.all(Array.from({ length: Math.min(settings.concurrency, dois.length) }, (_, index) => worker(index)));

  const manualIndices = results.map((result, index) => result?.status === 'manual_required' ? index : -1).filter((index) => index >= 0);
  for (const index of manualIndices) {
    const deferred = results[index];
    const manualSources = configuredSources.filter((source) => deferred.manualSources.includes(source.name));
    active = 1;
    reportProgress();
    const reviewed = await downloadWithRetry(context, dois[index], {
      ...settings, deferManualReview: false,
      logFailure,
      sources: manualSources.length ? manualSources : configuredSources,
    }, operation);
    results[index] = {
      ...reviewed,
      attempts: deferred.attempts + reviewed.attempts,
      elapsedMs: deferred.elapsedMs + reviewed.elapsedMs,
      errors: [...deferred.errors, ...(reviewed.errors || [])],
    };
    active = 0;
    reportProgress();
  }
  reportProgress(true);
  return results;
}

module.exports = { articleUrl, atomicWrite, createVerificationHandler, downloadError, downloadOne, downloadWithRetry, findDownloadUrl, findDownloadUrls, isBlocked, isHumanVerificationText, launchContext, loadedPdfUrl, pdfUrlFromResponse, requiresHumanInteraction, runBatch, safeFileName, savePdfFromContext, unavailablePageReason, unavailableTextReason, validatePdf, waitForAutomaticVerification, waitForUserConfirmation, waitForVerification };
