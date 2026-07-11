#!/usr/bin/env node

const { main } = require('../src/cli.js');

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`nethub: ${error.message}\n`);
  process.exitCode = 1;
});
