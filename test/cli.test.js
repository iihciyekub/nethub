const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { parseArgs } = require('../src/cli.js');

test('download parser accepts repeated input and mixed positional DOIs', () => {
  const parsed = parseArgs(['download', '--input', 'a.txt', '10.1234/one', '--input', 'b.csv', '--json']);
  assert.deepEqual(parsed.inputs, [path.resolve('a.txt'), path.resolve('b.csv')]);
  assert.deepEqual(parsed.positional, ['10.1234/one']);
  assert.equal(parsed.json, true);
});

test('only download is a valid command', () => {
  assert.throws(() => parseArgs(['fetch']), /unknown command/);
  assert.throws(() => parseArgs(['download', '--input']), /requires a file/);
});

test('source selects the preferred configured source', () => {
  assert.equal(parseArgs(['download', '--source', 'backup', '10.1/x']).source, 'backup');
});

test('fast mode is accepted for quick source probing', () => {
  assert.equal(parseArgs(['download', '--fast', '10.1/x']).fast, true);
});

test('update command supports check-only mode', () => {
  assert.deepEqual(parseArgs(['update']), { command: 'update', check: false });
  assert.deepEqual(parseArgs(['update', '--check']), { command: 'update', check: true });
  assert.throws(() => parseArgs(['update', '--force']), /unknown update option/);
});
