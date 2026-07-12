const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  concurrency: 3,
  retries: 0,
  timeout: 3000,
  linkTimeout: 500,
  verificationTimeout: 180000,
  headless: true,
  skipExisting: true,
  windowX: 80,
  windowY: 80,
  windowWidth: 1200,
  windowHeight: 900,
});

const DEFAULT_SOURCE = Object.freeze({ name: 'doi.org', baseUrl: 'https://doi.org' });

async function loadConfig(configPath) {
  try {
    const value = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('root must be an object');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`cannot read config ${configPath}: ${error.message}`);
  }
}

async function findConfigPath(explicitPath, env = process.env, cwd = process.cwd(), home = require('node:os').homedir(), access = fs.access) {
  const selected = explicitPath || env.NETHUB_CONFIG;
  if (selected) return path.resolve(cwd, selected);
  const candidates = [
    path.join(cwd, 'nethub.config.json'),
    path.join(home, '.config', 'nethub', 'config.json'),
  ];
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try the next location */ }
  }
  return candidates[0];
}

function integer(value, name, minimum) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

function rangedInteger(value, name, minimum, maximum) {
  const parsed = integer(value, name, minimum);
  if (parsed > maximum) throw new Error(`${name} must be an integer <= ${maximum}`);
  return parsed;
}

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function boolean(value, name) {
  if (typeof value === 'boolean') return value;
  if (/^(1|true|yes)$/i.test(String(value))) return true;
  if (/^(0|false|no)$/i.test(String(value))) return false;
  throw new Error(`${name} must be true or false`);
}

function normalizeSources(cli, config, env) {
  const singleUrl = first(cli.baseUrl, env.NETHUB_BASE_URL);
  const hasConfiguredSources = !singleUrl && Array.isArray(config.sources) && config.sources.length;
  let values;
  if (singleUrl) values = [{ name: 'default', baseUrl: singleUrl }];
  else if (hasConfiguredSources) values = config.sources;
  else if (config.baseUrl) values = [{ name: 'default', baseUrl: config.baseUrl }];
  else values = [DEFAULT_SOURCE];

  const names = new Set();
  const sources = values.filter((source) => !(source && typeof source === 'object' && source.enabled === false)).map((source, index) => {
    const item = typeof source === 'string' ? { baseUrl: source } : source;
    if (!item || typeof item !== 'object' || !item.baseUrl) throw new Error(`source ${index + 1} must have a baseUrl`);
    const name = String(item.name || `source-${index + 1}`);
    if (names.has(name)) throw new Error(`duplicate source name: ${name}`);
    names.add(name);
    const baseUrl = String(item.baseUrl).replace(/\/+$/, '');
    try { new URL(baseUrl); } catch { throw new Error(`source ${name} baseUrl must be an absolute URL`); }
    return { name, baseUrl };
  });
  if (!sources.length) throw new Error('at least one download source must be enabled');

  const preferred = hasConfiguredSources ? first(cli.source, env.NETHUB_SOURCE, config.source) : undefined;
  if (preferred) {
    const index = sources.findIndex((source) => source.name === preferred);
    if (index < 0) throw new Error(`unknown source: ${preferred}`);
    sources.unshift(...sources.splice(index, 1));
  }
  return sources;
}

function resolveSettings(cli, config, env = process.env, cwd = process.cwd()) {
  const sources = normalizeSources(cli, config, env);

  const resolvePath = (value, fallback = '') => value ? path.resolve(cwd, value) : fallback;
  const force = cli.force === true;
  return {
    sources,
    baseUrl: sources[0].baseUrl,
    downloadDir: resolvePath(first(cli.downloadDir, env.NETHUB_DOWNLOAD_DIR, config.downloadDir, 'downloads')),
    concurrency: rangedInteger(first(cli.concurrency, env.NETHUB_CONCURRENCY, config.concurrency, DEFAULTS.concurrency), 'concurrency', 1, 4),
    retries: rangedInteger(first(cli.retries, env.NETHUB_RETRIES, config.retries, DEFAULTS.retries), 'retries', 0, 2),
    timeout: integer(first(cli.timeout, env.NETHUB_TIMEOUT, config.timeout, DEFAULTS.timeout), 'timeout', 1),
    linkTimeout: integer(first(cli.linkTimeout, env.NETHUB_LINK_TIMEOUT, config.linkTimeout, DEFAULTS.linkTimeout), 'link timeout', 1),
    verificationTimeout: integer(first(cli.verificationTimeout, env.NETHUB_VERIFICATION_TIMEOUT, config.verificationTimeout, DEFAULTS.verificationTimeout), 'verification timeout', 1),
    profileDir: resolvePath(first(cli.profileDir, env.NETHUB_PROFILE_DIR, config.profileDir, '')),
    headless: cli.show ? false : boolean(first(env.NETHUB_HEADLESS, config.headless, DEFAULTS.headless), 'headless'),
    skipExisting: force ? false : boolean(first(env.NETHUB_SKIP_EXISTING, config.skipExisting, DEFAULTS.skipExisting), 'skip existing'),
    windowX: integer(first(cli.windowX, env.NETHUB_WINDOW_X, config.windowX, DEFAULTS.windowX), 'window X', -100000),
    windowY: integer(first(cli.windowY, env.NETHUB_WINDOW_Y, config.windowY, DEFAULTS.windowY), 'window Y', -100000),
    windowWidth: integer(first(env.NETHUB_WINDOW_WIDTH, config.windowWidth, DEFAULTS.windowWidth), 'window width', 1),
    windowHeight: integer(first(env.NETHUB_WINDOW_HEIGHT, config.windowHeight, DEFAULTS.windowHeight), 'window height', 1),
    jsonOutput: cli.json === true,
  };
}

module.exports = { DEFAULTS, DEFAULT_SOURCE, findConfigPath, loadConfig, resolveSettings };
