#!/usr/bin/env node
'use strict';

// Verifies a written data/ tree against the published-output rules:
// only the five allowed servers, only 1080p/2K/4K/8K at standard frames,
// no duplicate server+quality, correct season/episode grouping, and identical
// URL sets across JSON, TXT and M3U.
//
// Usage: node bin/verify-data.js [directory]   (default: data)

const { verifyDataTree } = require('../lib/verify');

const target = process.argv[2] || 'data';
const report = verifyDataTree(target);

console.log(`Checked ${report.categories} categor${report.categories === 1 ? 'y' : 'ies'} in ${target}`);
if (report.errors.length === 0) {
  console.log('OK: every category passed');
} else {
  for (const message of report.errors) console.error(`  - ${message}`);
  console.error(`\n${report.errors.length} problem(s) found`);
  process.exitCode = 1;
}
