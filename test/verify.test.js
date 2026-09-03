'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildCategoryModel } = require('../lib/model');
const { writeCategoryOutputs } = require('../lib/output');
const { verifyDataTree } = require('../lib/verify');
const messy = require('./fixtures/items');
const plan = require('./fixtures/plan-example');

function withTree(run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'redflix-verify-'));
  try {
    const model = buildCategoryModel({
      category: messy.CATEGORY, lastUpdated: messy.LAST_UPDATED, purpose: messy.PURPOSE, items: messy.items,
    });
    const result = writeCategoryOutputs(model, { baseDirectory: temporary });
    return run(temporary, result);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function editJson(file, mutate) {
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(document);
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

// --- a correctly written tree passes ------------------------------------
withTree((base) => {
  const report = verifyDataTree(base);
  assert.deepEqual(report.errors, []);
  assert.equal(report.categories, 1);
});

// Two categories, one movie-only and one series-only, both valid.
{
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'redflix-verify-'));
  try {
    writeCategoryOutputs(buildCategoryModel({
      category: 'Top 10 Movies', lastUpdated: plan.LAST_UPDATED, purpose: plan.PURPOSE, items: plan.movies,
    }), { baseDirectory: temporary });
    writeCategoryOutputs(buildCategoryModel({
      category: 'Top 10 TV Shows', lastUpdated: plan.LAST_UPDATED, purpose: plan.PURPOSE, items: plan.series,
    }), { baseDirectory: temporary });
    const report = verifyDataTree(temporary);
    assert.deepEqual(report.errors, []);
    assert.equal(report.categories, 2);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// --- each guard actually fires ------------------------------------------
function expectError(mutateFile, pattern) {
  withTree((base, result) => {
    mutateFile(result.paths);
    const report = verifyDataTree(base);
    assert.ok(report.errors.some((message) => pattern.test(message)),
      `expected an error matching ${pattern}\ngot: ${JSON.stringify(report.errors, null, 2)}`);
  });
}

// A disallowed server.
expectError((paths) => editJson(paths.moviesJson, (document) => {
  document.movies[0].servers[0].name = 'Nova';
}), /not one of the five allowed servers/);

// A raw odd dimension republished as a resolution.
expectError((paths) => editJson(paths.moviesJson, (document) => {
  document.movies[0].servers[0].qualities[0].resolution = '1620x1080';
}), /not a standard published frame/);

// A raw dimension leaking into the TXT file.
expectError((paths) => {
  fs.writeFileSync(paths.moviesText,
    fs.readFileSync(paths.moviesText, 'utf8').replace('1920x1080', '1920x800'), 'utf8');
}, /raw dimension 1920x800/);

// The same server+quality published twice.
expectError((paths) => editJson(paths.moviesJson, (document) => {
  const server = document.movies[0].servers[0];
  server.qualities.push({ ...server.qualities[0] });
}), /published more than once/);

// A low quality tier.
expectError((paths) => editJson(paths.moviesJson, (document) => {
  document.movies[0].servers[0].qualities[0].quality = '720p';
}), /quality "720p" is not allowed/);

// Series records inside the movie document.
expectError((paths) => editJson(paths.moviesJson, (document) => {
  document.series = [{ id: 'tv:1' }];
}), /must not contain series records/);

// Seasons out of order.
expectError((paths) => editJson(paths.seriesJson, (document) => {
  document.series[0].seasons.reverse();
}), /seasons are not ascending/);

// Season 0 quietly merged into season 1.
expectError((paths) => editJson(paths.seriesJson, (document) => {
  document.series[0].seasons[0].seasonName = 'Season 1';
}), /must be named Specials/);

// An episode filed under the wrong season.
expectError((paths) => editJson(paths.seriesJson, (document) => {
  const season = document.series[0].seasons[1];
  season.episodes[0].episodeCode = 'S05E01';
}), /episode code should be S01E01/);

// The same episode duplicated across seasons.
expectError((paths) => editJson(paths.seriesJson, (document) => {
  const seasons = document.series[0].seasons;
  seasons[2].episodes.push({ ...seasons[1].episodes[0] });
}), /more than one season/);

// Episodes out of order inside a season.
expectError((paths) => editJson(paths.seriesJson, (document) => {
  document.series[0].seasons[1].episodes.reverse();
}), /episodes are not ascending/);

// TXT drifting away from JSON.
expectError((paths) => {
  fs.writeFileSync(paths.seriesText,
    fs.readFileSync(paths.seriesText, 'utf8').replace(/^URL(\s+): .*$/m, 'URL$1: https://drift.test/x.m3u8'),
    'utf8');
}, /series\.txt URLs differ/);

// M3U drifting away from JSON.
expectError((paths) => {
  fs.writeFileSync(paths.moviesM3u,
    fs.readFileSync(paths.moviesM3u, 'utf8').replace(/^https:\/\/.*$/m, 'https://drift.test/y.m3u8'), 'utf8');
}, /movies\.m3u URLs differ/);

// A metadata count that no longer matches the records.
expectError((paths) => editJson(paths.moviesJson, (document) => {
  document.metadata.totalMovies = 99;
}), /totalMovies 99 != 2 records/);

// A missing file.
expectError((paths) => fs.rmSync(paths.seriesM3u), /missing series\.m3u/);

// A category folder with neither content type.
withTree((base) => {
  fs.mkdirSync(path.join(base, 'empty-category'));
  const report = verifyDataTree(base);
  assert.ok(report.errors.some((message) => /neither movies\/ nor series\//.test(message)));
});

// A missing tree is reported, not thrown.
assert.equal(verifyDataTree(path.join(os.tmpdir(), 'redflix-does-not-exist')).errors.length, 1);

console.log('PASS: data tree verifier enforces servers, qualities, seasons and cross-format agreement');
