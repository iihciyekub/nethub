const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectDois, extractDois } = require('../src/doi.js');

test('extractDois handles URLs, punctuation, parentheses, and case-insensitive duplicates', () => {
  assert.deepEqual(extractDois('See https://doi.org/10.1000/ABC.1, then 10.5555/foo(bar).'), [
    '10.1000/ABC.1', '10.5555/foo(bar)',
  ]);
});

test('collectDois combines arguments and arbitrary TXT/CSV contents', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nethub-dois-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const txt = path.join(directory, 'input.txt');
  const csv = path.join(directory, 'records.csv');
  await fs.writeFile(txt, 'citation 10.1234/one\nhttps://doi.org/10.1234/TWO');
  await fs.writeFile(csv, 'title,metadata\nA,"DOI: 10.9999/csv.value"');

  const result = await collectDois(['10.1234/ONE', 'not-a-doi'], [txt, csv]);
  assert.deepEqual(result.requestedDois, ['10.1234/ONE', '10.1234/TWO', '10.9999/csv.value']);
  assert.deepEqual(result.invalidDois, ['not-a-doi']);
});
