const fs = require('node:fs/promises');

const DOI_PATTERN = /10\.\d{4,9}\/[\-._;()/:A-Z0-9]+/gi;

function trimDoi(value) {
  let doi = value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  doi = doi.replace(/[.,;:!?"'`\]}]+$/g, '');
  while (doi.endsWith(')') && (doi.match(/\(/g) || []).length < (doi.match(/\)/g) || []).length) {
    doi = doi.slice(0, -1);
  }
  return doi;
}

function extractDois(text) {
  const decoded = String(text).replace(/%2F/gi, '/');
  return (decoded.match(DOI_PATTERN) || []).map(trimDoi).filter(Boolean);
}

function uniqueDois(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      output.push(value);
    }
  }
  return output;
}

async function collectDois(positional, inputPaths) {
  const requested = [];
  const invalidDois = [];

  for (const value of positional) {
    const matches = extractDois(value);
    if (matches.length === 0) invalidDois.push(value);
    else requested.push(...matches);
  }

  for (const inputPath of inputPaths) {
    const content = await fs.readFile(inputPath, 'utf8');
    requested.push(...extractDois(content));
  }

  return { requestedDois: uniqueDois(requested), invalidDois };
}

module.exports = { DOI_PATTERN, collectDois, extractDois, trimDoi, uniqueDois };
