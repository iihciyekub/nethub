const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const packageInfo = require('../package.json');

const execFileAsync = promisify(execFile);
const REPOSITORY = 'iihciyekub/nethub';

async function latestRelease(fetchApi = fetch) {
  const response = await fetchApi(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `nethub/${packageInfo.version}` },
  });
  if (!response.ok) throw new Error(`cannot check latest release (GitHub HTTP ${response.status})`);
  const release = await response.json();
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(release.tag_name || '')) {
    throw new Error('latest GitHub release has an invalid version tag');
  }
  return release;
}

function compareVersions(left, right) {
  const leftParts = left.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number);
  const rightParts = right.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] > rightParts[index] ? 1 : -1;
  }
  return 0;
}

async function updateNethub(options = {}, dependencies = {}) {
  const stdout = options.stdout || process.stdout;
  const release = await latestRelease(dependencies.fetchApi);
  const latestVersion = release.tag_name.replace(/^v/, '');
  if (compareVersions(latestVersion, packageInfo.version) <= 0) {
    stdout.write(`netHub ${packageInfo.version} is already up to date.\n`);
    return { updated: false, currentVersion: packageInfo.version, latestVersion };
  }
  if (options.checkOnly) {
    stdout.write(`netHub ${packageInfo.version}; latest release: ${latestVersion}.\n`);
    return { updated: false, currentVersion: packageInfo.version, latestVersion };
  }

  const archive = `https://github.com/${REPOSITORY}/archive/refs/tags/${encodeURIComponent(release.tag_name)}.tar.gz`;
  stdout.write(`Updating netHub ${packageInfo.version} -> ${latestVersion}...\n`);
  const run = dependencies.execFileApi || execFileAsync;
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--global', archive], { stdio: 'inherit' });
  stdout.write(`Updated netHub to ${latestVersion}.\n`);
  return { updated: true, currentVersion: packageInfo.version, latestVersion };
}

module.exports = { REPOSITORY, compareVersions, latestRelease, updateNethub };
