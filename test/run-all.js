'use strict';

// Runs every source-neutral lib test in dependency order. Each file is a plain
// node:assert script, so a failure exits non-zero with its own stack.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const SUITES = [
  'quality.test.js',
  'streams.test.js',
  'manifest.test.js',
  'model.test.js',
  'queue.test.js',
  'output-json.test.js',
  'text.test.js',
  'm3u.test.js',
  'verify.test.js',
  'integration.test.js',
  'production-integration.test.js',
  'end-to-end.js',
];

let failed = 0;
for (const suite of SUITES) {
  try {
    execFileSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  } catch (_) {
    failed += 1;
    console.error(`FAIL: ${suite}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${SUITES.length} suites failed`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${SUITES.length} suites passed`);
}
