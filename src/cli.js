const path = require('node:path');
const { findConfigPath, loadConfig, resolveSettings } = require('./config.js');
const { collectDois } = require('./doi.js');
const { downloadBatch } = require('./index.js');
const { updateNethub } = require('./update.js');
const { version: PACKAGE_VERSION } = require('../package.json');

const HELP = `netHub DOI PDF downloader

Usage:
  nethub download [options] <doi> [doi ...]
  nethub download --input <file> [--input <file> ...]
  nethub update [--check]

Options:
  --config FILE                Use this configuration file
  --base-url URL               Use one target URL (default: https://doi.org)
  --source NAME                Try this configured source first
  --download-dir DIR           Output directory (default: ./downloads)
  --input FILE                 Extract DOIs from all file text; repeatable
  --concurrency N              Maximum pages (default: 4; starts at 3)
  --retries N                  Extra retry rounds (default: 0)
  --timeout MS                 Page navigation timeout (default: 8000)
  --link-timeout MS            PDF link detection wait (default: 2500)
  --download-timeout MS        Confirmed PDF transfer timeout (default: 60000)
  --verification-timeout MS    Manual verification wait (default: 180000)
  --profile-dir DIR            Persistent Chromium profile
  --force                      Replace an existing DOI PDF
  --json                       Print the result as JSON
  --show                       Show Chromium for the entire run
  --window-x N                 Visible browser X position
  --window-y N                 Visible browser Y position
  --help                       Show this help
  --version                    Show the installed netHub version

Update options:
  --check                      Check the latest release without installing

Config lookup: --config, NETHUB_CONFIG, ./nethub.config.json, then
~/.config/nethub/config.json. Environment variables use the NETHUB_ prefix,
for example NETHUB_BASE_URL,
NETHUB_SOURCE, NETHUB_DOWNLOAD_DIR, NETHUB_CONCURRENCY, and NETHUB_PROFILE_DIR.`;

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { help: true };
  if (argv[0] === '--version' || argv[0] === '-v') return { version: true };
  if (argv[0] === 'update') {
    const unknown = argv.slice(1).find((arg) => arg !== '--check');
    if (unknown) throw new Error(`unknown update option: ${unknown}`);
    return { command: 'update', check: argv.includes('--check') };
  }
  if (argv[0] !== 'download') throw new Error(`unknown command: ${argv[0]}`);
  const output = { positional: [], inputs: [] };
  const valueOptions = new Map([
    ['--config', 'configPath'], ['--base-url', 'baseUrl'], ['--download-dir', 'downloadDir'],
    ['--source', 'source'],
    ['--concurrency', 'concurrency'], ['--retries', 'retries'], ['--timeout', 'timeout'], ['--link-timeout', 'linkTimeout'],
    ['--download-timeout', 'downloadTimeout'],
    ['--verification-timeout', 'verificationTimeout'], ['--profile-dir', 'profileDir'],
    ['--window-x', 'windowX'], ['--window-y', 'windowY'],
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { output.help = true; continue; }
    if (arg === '--force') { output.force = true; continue; }
    if (arg === '--json') { output.json = true; continue; }
    if (arg === '--show') { output.show = true; continue; }
    if (arg === '--input') {
      if (!argv[index + 1]) throw new Error('--input requires a file');
      output.inputs.push(path.resolve(argv[++index]));
      continue;
    }
    if (valueOptions.has(arg)) {
      if (!argv[index + 1]) throw new Error(`${arg} requires a value`);
      const key = valueOptions.get(arg);
      output[key] = key === 'configPath' ? path.resolve(argv[++index]) : argv[++index];
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`);
    output.positional.push(arg);
  }
  return output;
}

async function main(argv, io = process) {
  const cli = parseArgs(argv);
  if (cli.help) { io.stdout.write(`${HELP}\n`); return null; }
  if (cli.version) { io.stdout.write(`netHub ${PACKAGE_VERSION}\n`); return { version: PACKAGE_VERSION }; }
  if (cli.command === 'update') return updateNethub({ checkOnly: cli.check, stdout: io.stdout });
  const configPath = await findConfigPath(cli.configPath);
  const config = await loadConfig(configPath);
  const settings = resolveSettings(cli, config);
  const { requestedDois, invalidDois } = await collectDois(cli.positional, cli.inputs);
  if (requestedDois.length === 0) throw new Error('no valid DOI found in arguments or input files');
  const payload = await downloadBatch(requestedDois, invalidDois, settings);
  if (settings.jsonOutput) io.stdout.write(`${JSON.stringify(payload)}\n`);
  else io.stdout.write(`Completed ${payload.results.length} request(s): ${payload.results.filter((item) => item.ok).length} successful, ${payload.results.filter((item) => item.status === 'source_not_found').length} source not found.\nResults: ${payload.summaryPath}\n`);
  return payload;
}

module.exports = { HELP, main, parseArgs };
