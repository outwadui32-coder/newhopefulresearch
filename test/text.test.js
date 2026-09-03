'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildCategoryModel } = require('../lib/model');
const { buildMoviesText, buildSeriesText, SEPARATOR } = require('../lib/writers/text');
const plan = require('./fixtures/plan-example');
const messy = require('./fixtures/items');

// Golden files are compared with normalized line endings, because a Windows
// checkout may rewrite them to CRLF. That the writers themselves emit LF only
// is asserted separately below.
const toLf = (value) => value.split('\r\n').join('\n');
const golden = (name) => toLf(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));

const planModel = buildCategoryModel({
  category: plan.CATEGORY, lastUpdated: plan.LAST_UPDATED, purpose: plan.PURPOSE, items: plan.items,
});

// --- byte-for-byte against the hand-written golden layouts ---------------
assert.equal(buildMoviesText(planModel), golden('golden-movies.txt'));
assert.equal(buildSeriesText(planModel), golden('golden-series.txt'));

// The writers emit LF only, on every platform.
assert.ok(!buildMoviesText(planModel).includes('\r'), 'movies TXT must not contain CR');
assert.ok(!buildSeriesText(planModel).includes('\r'), 'series TXT must not contain CR');

// --- structural guarantees ----------------------------------------------
const moviesText = buildMoviesText(planModel);
const seriesText = buildSeriesText(planModel);

assert.equal(SEPARATOR, '-'.repeat(36));

// Header block, in order, exactly five lines before the first blank.
assert.deepEqual(moviesText.split('\n').slice(0, 5), [
  'CATEGORY: Browse: TRENDING NOW',
  'New Movies:',
  'TOTAL MOVIES: 2',
  'LAST_UPDATED: 2026-09-03 07:00 PM',
  `PURPOSE: ${plan.PURPOSE}`,
]);
assert.deepEqual(seriesText.split('\n').slice(0, 5), [
  'CATEGORY: Browse: TRENDING NOW',
  'New Series:',
  'TOTAL SERIES: 1',
  'LAST_UPDATED: 2026-09-03 07:00 PM',
  `PURPOSE: ${plan.PURPOSE}`,
]);

// Serials are zero padded and sequential.
assert.deepEqual(moviesText.match(/^Movie: \d+$/gm), ['Movie: 01', 'Movie: 02']);
assert.deepEqual(seriesText.match(/^Series: \d+$/gm), ['Series: 01']);
assert.deepEqual(seriesText.match(/^Season: \d+$/gm), ['Season: 01', 'Season: 02']);
assert.deepEqual(seriesText.match(/^Episode: \d+$/gm),
  ['Episode: 01', 'Episode: 02', 'Episode: 03', 'Episode: 01', 'Episode: 02']);

// Resolution numbering restarts inside every server block.
assert.deepEqual(moviesText.match(/^Resolution-\d+ /gm).map((line) => line.trim()),
  ['Resolution-1', 'Resolution-2', 'Resolution-1', 'Resolution-2', 'Resolution-1',
    'Resolution-1', 'Resolution-1']);

// Server numbering restarts per item and follows canonical order.
assert.deepEqual(moviesText.match(/^SERVER-\d+: .+$/gm), [
  'SERVER-1: Premium', 'SERVER-2: Ultra', 'SERVER-3: PlayFast',
  'SERVER-1: Alpha', 'SERVER-2: Ultra',
]);

// No decoration beyond the fixed separator rule.
for (const text of [moviesText, seriesText]) {
  assert.ok(!/#/.test(text), 'TXT must contain no hash decoration');
  assert.ok(!/[|`+*=]|--- /.test(text), 'TXT must contain no tree or box glyphs');
  for (const line of text.split('\n')) {
    if (/^-+$/.test(line)) assert.equal(line, SEPARATOR);
    assert.equal(line, line.replace(/\s+$/, ''), `trailing whitespace: ${JSON.stringify(line)}`);
  }
  assert.ok(text.endsWith('\n'));
  assert.ok(!text.endsWith('\n\n'));
}

// Every colon in a block lines up.
function columnOf(text, label) {
  const line = text.split('\n').find((entry) => entry.startsWith(`${label} `) || entry.startsWith(`${label}:`));
  return line.indexOf(':');
}
assert.equal(columnOf(moviesText, 'ID'), columnOf(moviesText, 'MOVIE Name'));
assert.equal(columnOf(moviesText, 'Year'), columnOf(moviesText, 'Poster'));
assert.equal(columnOf(moviesText, 'Quality'), columnOf(moviesText, 'Resolution-1'));
assert.equal(columnOf(moviesText, 'URL'), columnOf(moviesText, 'Quality'));
assert.equal(columnOf(seriesText, 'TOTAL SEASONS'), columnOf(seriesText, 'TOTAL EPISODES'));
assert.equal(columnOf(seriesText, 'Season Name'), columnOf(seriesText, 'Season Number'));
assert.equal(columnOf(seriesText, 'Episode Code'), columnOf(seriesText, 'Air Date'));

// --- the messy category still obeys the format --------------------------
const messyModel = buildCategoryModel({
  category: messy.CATEGORY, lastUpdated: messy.LAST_UPDATED, purpose: messy.PURPOSE, items: messy.items,
});
const messyMovies = buildMoviesText(messyModel);
const messySeries = buildSeriesText(messyModel);

// Specials keep their own season block and sort first.
assert.deepEqual(messySeries.match(/^Season: \d+$/gm), ['Season: 00', 'Season: 01', 'Season: 02']);
assert.ok(messySeries.includes('Season Name    : Specials'));
assert.ok(messySeries.includes('Season Number  : 0'));

// Only standard resolutions and allowed qualities are ever printed.
for (const text of [messyMovies, messySeries]) {
  for (const line of text.split('\n')) {
    if (line.startsWith('Resolution-')) {
      assert.ok(['1920x1080', '2560x1440', '3840x2160', '7680x4320'].includes(line.split(': ')[1]),
        `non-standard resolution printed: ${line}`);
    }
    if (line.startsWith('Quality')) {
      assert.ok(['1080p', '2K', '4K', '8K'].includes(line.split(': ')[1]),
        `non-allowed quality printed: ${line}`);
    }
    if (line.startsWith('SERVER-')) {
      assert.ok(['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast'].includes(line.split(': ')[1]),
        `non-allowed server printed: ${line}`);
    }
  }
  // The raw dimensions from the source must appear nowhere.
  for (const raw of ['1620x1080', '1920x800', '1920x804', '1920x960', '1920x1000', '1280x720']) {
    assert.ok(!text.includes(raw), `raw dimension ${raw} leaked into TXT`);
  }
}

// The same server never repeats a quality inside one block.
for (const block of messySeries.split(/^SERVER-\d+: /m).slice(1)) {
  const qualities = (block.split(/\n(?=SERVER-|Episode: |Season: |Series: )/)[0]
    .match(/^Quality\s+: (.+)$/gm) || []);
  assert.equal(new Set(qualities).size, qualities.length);
}

console.log('PASS: Movie TXT and Series TXT match the approved layout byte for byte');
