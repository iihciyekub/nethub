const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chromium, request } = require('playwright');
const {
  downloadError, downloadOne, downloadWithRetry, isBlocked, isHumanVerificationText, safeFileName,
  pdfUrlFromResponse, runBatch, savePdfFromContext, unavailablePageReason, validatePdf,
  waitForAutomaticVerification, waitForVerification,
} = require('../src/downloader.js');

test('safeFileName is portable and PDF validation rejects HTML', () => {
  assert.equal(safeFileName('10.1234/a:b*c?d'), '10.1234_a_b_c_d.pdf');
  assert.throws(() => validatePdf(Buffer.from('<html>'), 'text/html'), /not a PDF/);
  assert.doesNotThrow(() => validatePdf(Buffer.from('%PDF-1.7\nfixture'), 'application/pdf'));
});

test('PDF response detection does not require a .pdf URL suffix', () => {
  const response = {
    headers: () => ({ 'content-type': 'application/pdf' }),
    url: () => 'https://example.test/10.1000/direct',
  };
  assert.equal(pdfUrlFromResponse(response), 'https://example.test/10.1000/direct');
});

test('a PDF opened as the main page downloads without manual confirmation', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-direct-pdf-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let reviews = 0;
  const page = {
    goto: async () => ({
      status: () => 200,
      headers: () => ({ 'content-type': 'application/pdf' }),
      url: () => 'https://example.test/10.1000/direct',
    }),
    url: () => 'https://example.test/10.1000/direct',
    close: async () => {},
  };
  const apiResponse = {
    ok: () => true, body: async () => Buffer.from('%PDF-1.7\ndirect fixture'),
    headers: () => ({ 'content-type': 'application/pdf' }),
  };
  const result = await downloadOne({
    newPage: async () => page,
    request: { get: async () => apiResponse },
  }, '10.1000/direct', {
    baseUrl: 'https://example.test', headless: true, timeout: 100,
    downloadTimeout: 100, downloadDir: directory,
    verifyChallenge: async () => { reviews += 1; return true; },
  });
  assert.equal(result.ok, true);
  assert.equal(reviews, 0);
  assert.match((await fs.readFile(result.path)).toString('latin1'), /^%PDF-/);
});

test('PDF link candidates are validated in score order until one succeeds', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-candidates-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let evaluateCalls = 0;
  const requested = [];
  const page = {
    goto: async () => ({ status: () => 200 }), title: async () => 'Article',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'Article page' }
      : { count: async () => 0 },
    frames: () => [], waitForFunction: async () => {},
    evaluate: async () => {
      evaluateCalls += 1;
      if (evaluateCalls <= 2) return false;
      return [
        { href: '/download-page', score: 70 },
        { href: '/paper.pdf', score: 25 },
      ];
    },
    url: () => 'https://example.test/article', close: async () => {},
  };
  const result = await downloadOne({
    newPage: async () => page,
    request: { get: async (url) => {
      requested.push(url);
      const pdf = url.endsWith('/paper.pdf');
      return {
        ok: () => true,
        body: async () => Buffer.from(pdf ? '%PDF-1.7\nvalid' : '<html>not pdf</html>'),
        headers: () => ({ 'content-type': pdf ? 'application/pdf' : 'text/html' }),
      };
    } },
  }, '10.1000/candidates', {
    baseUrl: 'https://example.test', headless: true, timeout: 10, linkTimeout: 1,
    downloadTimeout: 100, downloadDir: directory,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(requested, ['https://example.test/download-page', 'https://example.test/paper.pdf']);
});

test('verification detection recognizes human-check wording', async () => {
  const page = {
    title: async () => 'Please verify you are human',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'Complete the security check' }
      : { count: async () => 0 },
    frames: () => [],
  };
  assert.equal(await isBlocked(page), true);
  assert.equal(isHumanVerificationText('あなたはロボットですか？ いいえ'), true);
});

test('Japanese robot-check page is deferred for genuine manual verification', async () => {
  const page = {
    goto: async () => ({ status: () => 200 }), title: async () => 'あなたはロボットですか？',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'あなたはロボットですか？ いいえ' }
      : { count: async () => 0 },
    frames: () => [], evaluate: async () => false,
    url: () => 'https://example.test/check', close: async () => {},
  };
  await assert.rejects(() => downloadOne({ newPage: async () => page }, '10.1000/check', {
    baseUrl: 'https://example.test', headless: true, timeout: 10,
    downloadTimeout: 100, downloadDir: '/tmp', deferManualReview: true,
  }), (error) => error.code === 'MANUAL_REVIEW_REQUIRED');
});

test('an explicit database-unavailable page is recognized as source not found', async () => {
  const page = {
    title: async () => 'Paper unavailable',
    locator: () => ({ innerText: async () => 'Alas, the following paper is not yet available in\nmy database:' }),
  };
  assert.equal(await unavailablePageReason(page), 'source reports that the paper is unavailable');
});

test('an unavailable page fails without opening manual review', async () => {
  let reviews = 0;
  const page = {
    goto: async () => ({ status: () => 200 }), title: async () => 'Paper unavailable',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'Alas, the following paper is not yet available in my database:' }
      : { count: async () => 0 },
    evaluate: async () => false, url: () => 'https://example.test/missing', close: async () => {},
  };
  await assert.rejects(() => downloadOne({ newPage: async () => page }, '10.1000/unavailable', {
    baseUrl: 'https://example.test', headless: true, timeout: 10,
    downloadTimeout: 100, downloadDir: '/tmp',
    verifyChallenge: async () => { reviews += 1; return true; },
  }), (error) => error.code === 'SOURCE_NOT_FOUND');
  assert.equal(reviews, 0);
});

function verificationPage(state) {
  return {
    title: async () => state.blocked ? 'Verify you are human' : 'Article',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => state.blocked ? 'Complete the security check' : 'Article ready' }
      : { count: async () => 0 },
    frames: () => [], evaluate: async () => false,
    url: () => 'https://example.test/article',
  };
}

test('interactive verification still accepts Enter as a manual fallback', async () => {
  class Input extends EventEmitter {
    constructor() { super(); this.isTTY = true; this.paused = true; this.referenced = false; }
    isPaused() { return this.paused; }
    resume() { this.paused = false; }
    pause() { this.paused = true; }
    ref() { this.referenced = true; }
    unref() { this.referenced = false; }
  }
  const stdin = new Input();
  const output = [];
  const waiting = waitForVerification(verificationPage({ blocked: true }), 1000, '10.1000/check', {
    stdin, stderr: { write: (value) => output.push(value) }, pollInterval: 10,
  });
  let settled = false;
  waiting.finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, false);
  stdin.emit('data', Buffer.from('\n'));
  assert.equal(await waiting, true);
  assert.equal(stdin.paused, true);
  assert.equal(stdin.referenced, false);
  assert.match(output.join(''), /press Enter/);
});

test('verification continues automatically after the challenge disappears', async () => {
  class Input extends EventEmitter {
    constructor() { super(); this.isTTY = true; this.paused = true; this.referenced = false; }
    resume() { this.paused = false; }
    pause() { this.paused = true; }
    ref() { this.referenced = true; }
    unref() { this.referenced = false; }
  }
  const state = { blocked: true };
  const stdin = new Input();
  const output = [];
  setTimeout(() => { state.blocked = false; }, 30);
  assert.equal(await waitForVerification(verificationPage(state), 1000, '10.1000/auto', {
    stdin, stderr: { write: (value) => output.push(value) }, pollInterval: 10,
  }), true);
  assert.equal(stdin.paused, true);
  assert.equal(stdin.referenced, false);
  assert.match(output.join(''), /continuing automatically/);
});

test('automatic verification recognizes a PDF opened in the browser', async () => {
  const page = verificationPage({ blocked: true });
  page.evaluate = async () => true;
  page.url = () => 'https://example.test/paper';
  assert.equal(await waitForAutomaticVerification(page, 100), true);
});

test('automatic verification scans PDF viewers opened in another tab', async () => {
  const challenge = verificationPage({ blocked: true });
  const pdf = verificationPage({ blocked: false });
  pdf.evaluate = async () => true;
  pdf.url = () => 'https://example.test/paper.pdf';
  const context = { pages: () => [challenge, pdf] };
  challenge.context = () => context;
  pdf.context = () => context;
  assert.equal(await waitForAutomaticVerification(challenge, 100), true);
});

test('automatic verification accepts a PDF response while the challenge tab remains open', async () => {
  const page = verificationPage({ blocked: true });
  let observedPdfUrl = '';
  setTimeout(() => { observedPdfUrl = 'https://example.test/paper'; }, 20);
  assert.equal(await waitForAutomaticVerification(page, 500, null, 10, () => observedPdfUrl), true);
});

test('a real browser continues after a verification page navigates away', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/paper.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end('%PDF-1.7\nverification popup fixture');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/challenge') {
      return res.end('<title>Verify you are human</title><body>あなたはロボットですか？<script>setTimeout(() => location.href = "/article", 100)</script></body>');
    }
    if (req.url === '/popup') {
      return res.end('<title>Verify you are human</title><body>あなたはロボットですか？<script>setTimeout(() => window.open("/paper.pdf", "_blank"), 100)</script></body>');
    }
    res.end('<title>Article</title><body>Article ready</body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/challenge`);
  assert.equal(await waitForAutomaticVerification(page, 2000, null, 50), true);
  assert.match(page.url(), /\/article$/);

  let observedPdfUrl = '';
  page.context().on('response', (response) => {
    observedPdfUrl ||= pdfUrlFromResponse(response);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/popup`);
  assert.equal(await waitForAutomaticVerification(page, 2000, null, 50, () => observedPdfUrl), true);
  assert.match(observedPdfUrl, /\/paper\.pdf$/);
});

test('ordinary missing PDF link fails without manual review', async () => {
  let reviews = 0;
  const page = {
    goto: async () => ({ status: () => 200 }),
    title: async () => 'Article',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'Article page' }
      : { count: async () => 0 },
    frames: () => [],
    waitForFunction: async () => { throw new Error('not found'); },
    evaluate: async () => '',
    url: () => 'https://example.test/article',
    close: async () => {},
  };
  await assert.rejects(() => downloadOne({ newPage: async () => page }, '10.1000/missing', {
    baseUrl: 'https://example.test', headless: true, timeout: 10, linkTimeout: 1,
    verificationTimeout: 100, downloadDir: '/tmp',
    verifyChallenge: async () => { reviews += 1; return true; },
  }), (error) => error.code === 'PDF_LINK_NOT_FOUND');
  assert.equal(reviews, 0);
});

test('unavailable text returned by a candidate is classified without manual review', async () => {
  let evaluateCalls = 0;
  let reviews = 0;
  const page = {
    goto: async () => ({ status: () => 200 }), title: async () => 'Article',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'Article page' }
      : { count: async () => 0 },
    frames: () => [], waitForFunction: async () => {},
    evaluate: async () => (++evaluateCalls <= 2 ? false : [{ href: '/download', score: 70 }]),
    url: () => 'https://example.test/article', close: async () => {},
  };
  await assert.rejects(() => downloadOne({
    newPage: async () => page,
    request: { get: async () => ({
      ok: () => true,
      body: async () => Buffer.from('the following paper is not yet available in my database'),
      headers: () => ({ 'content-type': 'text/html' }),
    }) },
  }, '10.1000/candidate-missing', {
    baseUrl: 'https://example.test', headless: true, timeout: 10, linkTimeout: 1,
    downloadTimeout: 100, downloadDir: '/tmp',
    verifyChallenge: async () => { reviews += 1; return true; },
  }), (error) => error.code === 'SOURCE_NOT_FOUND');
  assert.equal(reviews, 0);
});

test('robot-check text returned by a candidate is the only kind escalated', async () => {
  let evaluateCalls = 0;
  const page = {
    goto: async () => ({ status: () => 200 }), title: async () => 'Article',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'Article page' }
      : { count: async () => 0 },
    frames: () => [], waitForFunction: async () => {},
    evaluate: async () => (++evaluateCalls <= 2 ? false : [{ href: '/download', score: 70 }]),
    url: () => 'https://example.test/article', close: async () => {},
  };
  await assert.rejects(() => downloadOne({
    newPage: async () => page,
    request: { get: async () => ({
      ok: () => true,
      body: async () => Buffer.from('あなたはロボットですか？ いいえ'),
      headers: () => ({ 'content-type': 'text/html' }),
    }) },
  }, '10.1000/candidate-check', {
    baseUrl: 'https://example.test', headless: true, timeout: 10, linkTimeout: 1,
    downloadTimeout: 100, downloadDir: '/tmp', deferManualReview: true,
  }), (error) => error.code === 'MANUAL_REVIEW_REQUIRED');
});

test('a PDF found in the verification window is returned to the background downloader', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-verified-pdf-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const page = {
    goto: async () => ({ status: () => 200 }), title: async () => 'Verify you are human',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'Complete the security check' }
      : { count: async () => 0 },
    frames: () => [], waitForFunction: async () => {}, evaluate: async () => false,
    url: () => 'https://example.test/article', close: async () => {},
  };
  const apiResponse = {
    ok: () => true, body: async () => Buffer.from('%PDF-1.7\nverified fixture'),
    headers: () => ({ 'content-type': 'application/pdf' }),
  };
  const result = await downloadOne({
    newPage: async () => page, request: { get: async () => apiResponse },
  }, '10.1000/verified', {
    baseUrl: 'https://example.test', headless: true, timeout: 10, linkTimeout: 1,
    verificationTimeout: 100, downloadTimeout: 100, downloadDir: directory,
    verifyChallenge: async () => ({ verified: true, pdfUrl: 'https://example.test/article' }),
  });
  assert.equal(result.ok, true);
  assert.match((await fs.readFile(result.path)).toString('latin1'), /^%PDF-/);
});

test('--show mode does not wait for Enter on an ordinary no-PDF page', async () => {
  const page = {
    goto: async () => ({ status: () => 200 }),
    title: async () => 'Manual check',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'Continue in browser' }
      : { count: async () => 0 },
    frames: () => [], waitForFunction: async () => {}, evaluate: async () => '',
    url: () => 'https://example.test/article', close: async () => {},
  };
  const context = {
    newPage: async () => page,
    newCDPSession: async () => ({
      send: async (method) => method === 'Browser.getWindowForTarget' ? { windowId: 1 } : {},
      detach: async () => {},
    }),
  };
  const startedAt = Date.now();
  await assert.rejects(() => downloadOne(context, '10.1000/manual', {
    baseUrl: 'https://example.test', headless: false, timeout: 10, linkTimeout: 1,
    verificationTimeout: 1000, downloadDir: '/tmp', windowX: 0, windowY: 0,
    windowWidth: 800, windowHeight: 600,
  }), (error) => error.code === 'PDF_LINK_NOT_FOUND');
  assert.ok(Date.now() - startedAt < 100);
});

test('context request follows redirects, reuses cookies, and atomically saves a PDF', async (t) => {
  const pdf = Buffer.from('%PDF-1.7\nlocal fixture');
  const server = http.createServer((req, res) => {
    if (req.url === '/session') {
      res.writeHead(204, { 'set-cookie': 'access=granted; Path=/' });
      return res.end();
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/paper.pdf' });
      return res.end();
    }
    if (req.url === '/paper.pdf' && /access=granted/.test(req.headers.cookie || '')) {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      return res.end(pdf);
    }
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end('forbidden');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const api = await request.newContext({ baseURL });
  t.after(() => api.dispose());
  await api.get('/session');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-pdf-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'paper.pdf');

  await savePdfFromContext({ request: api }, `${baseURL}/redirect`, output, `${baseURL}/article`, 2000);
  assert.deepEqual(await fs.readFile(output), pdf);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['paper.pdf']);
});

test('PDF transfer timeout is classified as transient', async () => {
  const context = { request: { get: async () => { throw new Error('Timeout 50ms exceeded'); } } };
  await assert.rejects(
    () => savePdfFromContext(context, 'https://example.test/paper.pdf', '/tmp/unused.pdf', 'https://example.test', 50),
    (error) => error.code === 'PDF_DOWNLOAD_TIMEOUT' && error.retryable === true,
  );
});

test('retry reports attempts and force/skip behavior', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-retry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const settings = { downloadDir: directory, retries: 2, skipExisting: false };
  let calls = 0;
  const result = await downloadWithRetry({}, '10.1000/retry', settings, async (_context, doi) => {
    calls += 1;
    if (calls < 3) throw new Error('temporary');
    return { doi, ok: true, path: 'done' };
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
});

test('failed source automatically falls through to the next source', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-sources-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const seen = [];
  const settings = {
    downloadDir: directory, retries: 0, skipExisting: false,
    sources: [
      { name: 'primary', baseUrl: 'https://one.test' },
      { name: 'backup', baseUrl: 'https://two.test' },
    ],
  };
  const result = await downloadWithRetry({}, '10.1000/fallback', settings, async (_context, doi, _settings, source) => {
    seen.push(source.name);
    if (source.name === 'primary') throw new Error('source unavailable');
    return { doi, ok: true, source: source.name, path: 'done' };
  });
  assert.deepEqual(seen, ['primary', 'backup']);
  assert.equal(result.source, 'backup');
  assert.equal(result.attempts, 2);
});

test('terminal failures try every source once and finish as source_not_found', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-not-found-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const result = await downloadWithRetry({}, '10.1000/missing', {
    downloadDir: directory, retries: 2, skipExisting: false,
    sources: [{ name: 'one', baseUrl: 'https://one.test' }, { name: 'two', baseUrl: 'https://two.test' }],
  }, async () => {
    calls += 1;
    throw downloadError('PDF_LINK_NOT_FOUND', 'PDF download link not found');
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'source_not_found');
  assert.equal(result.reason, 'PDF source not found');
  assert.equal(result.attempts, 2);
  assert.ok(result.elapsedMs >= 0);
});

test('manual reviews are deferred until background workers finish', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-manual-queue-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const events = [];
  const result = await runBatch({}, ['10.1/manual', '10.1/one', '10.1/two'], {
    downloadDir: directory, retries: 0, skipExisting: false, concurrency: 3,
    baseUrl: 'https://one.test', sources: [{ name: 'one', baseUrl: 'https://one.test' }],
    progressStream: { isTTY: false, write: () => {} },
  }, async (_context, doi, settings) => {
    events.push(`${doi}:${settings.deferManualReview}`);
    if (doi.endsWith('/manual') && settings.deferManualReview) {
      throw downloadError('MANUAL_REVIEW_REQUIRED', 'human verification required');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { doi, ok: true, path: 'done' };
  });
  assert.ok(result.every((item) => item.ok));
  assert.equal(events.at(-1), '10.1/manual:false');
  assert.ok(events.indexOf('10.1/manual:false') > events.indexOf('10.1/two:true'));
});

test('stable batches adapt from three to four concurrent workers', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-adaptive-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let active = 0;
  let maximumActive = 0;
  const dois = Array.from({ length: 12 }, (_, index) => `10.1/${index}`);
  const results = await runBatch({}, dois, {
    downloadDir: directory, retries: 0, skipExisting: false, concurrency: 4,
    baseUrl: 'https://one.test', sources: [{ name: 'one', baseUrl: 'https://one.test' }],
    progressStream: { isTTY: false, write: () => {} },
  }, async (_context, doi) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { doi, ok: true, path: 'done' };
  });
  assert.ok(results.every((item) => item.ok));
  assert.equal(maximumActive, 4);
});

test('TTY failure logs clear the progress row and print on their own line', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-progress-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const writes = [];
  await runBatch({}, ['10.1/fail'], {
    downloadDir: directory, retries: 0, skipExisting: false, concurrency: 4,
    baseUrl: 'https://one.test', sources: [{ name: 'one', baseUrl: 'https://one.test' }],
    progressStream: { isTTY: true, write: (value) => writes.push(value) },
  }, async () => { throw downloadError('SOURCE_NOT_FOUND', 'missing'); });
  const log = writes.find((value) => value.includes('attempt 1 failed'));
  assert.match(log, /^\r\x1b\[2K/);
  assert.match(log, /missing\n$/);
  assert.ok(writes.some((value) => value.includes('Active 1 | Limit 1')));
});
