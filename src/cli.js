const path = require('node:path');
const { loadConfig, resolveSettings } = require('./config.js');
const { collectDois } = require('./doi.js');
const { downloadBatch } = require('./index.js');
const { updateNethub } = require('./update.js');

const HELP = `netHub DOI PDF downloader

Usage:
  nethub download [options] <doi> [doi ...]
  nethub download --input <file> [--input <file> ...]
  nethub update [--check]

Options:
  --config FILE                Config file (default: ./nethub.config.json)
  --base-url URL               Use one target URL (overrides configured sources)
  --source NAME                Try this configured source first
  --download-dir DIR           Output directory (default: ./downloads)
  --input FILE                 Extract DOIs from all file text; repeatable
  --concurrency N              Concurrent workers (default: 3)
  --retries N                  Retries after the first attempt (default: 1)
  --timeout MS                 Navigation and download timeout (default: 10000)
  --verification-timeout MS    Manual verification wait (default: 180000)
  --profile-dir DIR            Persistent Chromium profile
  --force                      Replace an existing DOI PDF
  --json                       Print the result as JSON
  --show                       Show Chromium for the entire run
  --window-x N                 Visible browser X position
  --window-y N                 Visible browser Y position
  --help                       Show this help

Update options:
  --check                      Check the latest release without installing

Environment variables use the NETHUB_ prefix, for example NETHUB_BASE_URL,
NETHUB_SOURCE, NETHUB_DOWNLOAD_DIR, NETHUB_CONCURRENCY, and NETHUB_PROFILE_DIR.`;

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { help: true };
  if (argv[0] === 'update') {
    const unknown = argv.slice(1).find((arg) => arg !== '--check');
    if (unknown) throw new Error(`unknown update option: ${unknown}`);
    return { command: 'update', check: argv.includes('--check') };
  }
  if (argv[0] !== 'download') throw new Error(`unknown command: ${argv[0]}`);
  const output = { positional: [], inputs: [], configPath: path.resolve('nethub.config.json') };
  const valueOptions = new Map([
    ['--config', 'configPath'], ['--base-url', 'baseUrl'], ['--download-dir', 'downloadDir'],
    ['--source', 'source'],
    ['--concurrency', 'concurrency'], ['--retries', 'retries'], ['--timeout', 'timeout'],
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
  if (cli.command === 'update') return updateNethub({ checkOnly: cli.check, stdout: io.stdout });
  const config = await loadConfig(cli.configPath);
  const settings = resolveSettings(cli, config);
  const { requestedDois, invalidDois } = await collectDois(cli.positional, cli.inputs);
  if (requestedDois.length === 0) throw new Error('no valid DOI found in arguments or input files');
  const payload = await downloadBatch(requestedDois, invalidDois, settings);
  if (settings.jsonOutput) io.stdout.write(`${JSON.stringify(payload)}\n`);
  else io.stdout.write(`Completed ${payload.results.length} request(s): ${payload.results.filter((item) => item.ok).length} successful, ${payload.results.filter((item) => !item.ok).length} failed.\nResults: ${payload.summaryPath}\n`);
  return payload;
}

module.exports = { HELP, main, parseArgs };
