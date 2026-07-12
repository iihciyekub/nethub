const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { request } = require('playwright');
const {
  downloadError, downloadOne, downloadWithRetry, isBlocked, safeFileName,
  pdfUrlFromResponse, savePdfFromContext, validatePdf, waitForVerification,
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

test('verification detection recognizes human-check wording', async () => {
  const page = {
    title: async () => 'Please verify you are human',
    locator: (selector) => selector === 'body'
      ? { innerText: async () => 'Complete the security check' }
      : { count: async () => 0 },
    frames: () => [],
  };
  assert.equal(await isBlocked(page), true);
});

test('interactive verification waits for explicit terminal confirmation', async () => {
  class Input extends EventEmitter { constructor() { super(); this.isTTY = true; } resume() {} }
  const stdin = new Input();
  const output = [];
  const waiting = waitForVerification({}, 1000, '10.1000/check', {
    stdin, stderr: { write: (value) => output.push(value) },
  });
  let settled = false;
  waiting.finally(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, false);
  stdin.emit('data', Buffer.from('\n'));
  assert.equal(await waiting, true);
  assert.match(output.join(''), /press Enter/);
});

test('missing PDF link escalates to one visible manual review', async () => {
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
  assert.equal(reviews, 1);
});

test('--show mode also waits for Enter when no PDF link is detected', async () => {
  class Input extends EventEmitter { constructor() { super(); this.isTTY = true; } resume() {} }
  const stdin = new Input();
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
  setTimeout(() => stdin.emit('data', Buffer.from('\n')), 40);
  await assert.rejects(() => downloadOne(context, '10.1000/manual', {
    baseUrl: 'https://example.test', headless: false, timeout: 10, linkTimeout: 1,
    verificationTimeout: 1000, downloadDir: '/tmp', windowX: 0, windowY: 0,
    windowWidth: 800, windowHeight: 600,
    verificationIo: { stdin, stderr: { write: () => {} } },
  }), (error) => error.code === 'PDF_LINK_NOT_FOUND');
  assert.ok(Date.now() - startedAt >= 30);
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
