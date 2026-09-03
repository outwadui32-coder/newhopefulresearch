'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildCategoryModel } = require('../lib/model');
const { categoryPaths } = require('../lib/paths');
const { writeCategoryOutputs } = require('../lib/output');
const { buildMoviesJson, buildSeriesJson } = require('../lib/writers/json');
const { CATEGORY, LAST_UPDATED, PURPOSE, items } = require('./fixtures/items');

const model = buildCategoryModel({ category: CATEGORY, lastUpdated: LAST_UPDATED, purpose: PURPOSE, items });

// --- path layout --------------------------------------------------------
const layout = categoryPaths('trending-now', 'data');
assert.equal(path.basename(layout.moviesJson), 'movies.json');
assert.equal(path.basename(layout.seriesM3u), 'series.m3u');
assert.equal(path.basename(layout.seriesText), 'series.txt');
assert.ok(layout.moviesJson.endsWith(path.join('data', 'trending-now', 'movies', 'movies.json')));
assert.ok(layout.seriesText.endsWith(path.join('data', 'trending-now', 'series', 'series.txt')));

// --- movies.json --------------------------------------------------------
const moviesDocument = buildMoviesJson(model);
assert.deepEqual(Object.keys(moviesDocument), ['metadata', 'movies']);
assert.deepEqual(moviesDocument.metadata, {
  category: 'Browse: TRENDING NOW',
  totalMovies: 2,
  lastUpdated: LAST_UPDATED,
  purpose: PURPOSE,
});
assert.equal(moviesDocument.movies[0].serial, 1);
assert.deepEqual(Object.keys(moviesDocument.movies[0]),
  ['serial', 'id', 'title', 'year', 'poster', 'servers']);
assert.deepEqual(Object.keys(moviesDocument.movies[0].servers[0]), ['name', 'qualities']);
assert.deepEqual(Object.keys(moviesDocument.movies[0].servers[0].qualities[0]),
  ['quality', 'resolution', 'url']);
// No series records leak into the movie document.
assert.ok(!JSON.stringify(moviesDocument).includes('seasons'));
assert.ok(!JSON.stringify(moviesDocument).includes('tv:108978'));

// --- series.json --------------------------------------------------------
const seriesDocument = buildSeriesJson(model);
assert.deepEqual(Object.keys(seriesDocument), ['metadata', 'series']);
assert.equal(seriesDocument.metadata.totalSeries, 1);
assert.deepEqual(Object.keys(seriesDocument.series[0]),
  ['serial', 'id', 'title', 'year', 'poster', 'totalSeasons', 'totalEpisodes', 'seasons']);
assert.deepEqual(Object.keys(seriesDocument.series[0].seasons[0]),
  ['seasonNumber', 'seasonName', 'totalEpisodes', 'episodes']);
assert.deepEqual(Object.keys(seriesDocument.series[0].seasons[0].episodes[0]),
  ['episodeNumber', 'episodeCode', 'episodeName', 'airDate', 'poster', 'servers']);
// No movie records leak into the series document.
assert.ok(!JSON.stringify(seriesDocument).includes('movie:10001'));

// --- on-disk layout -----------------------------------------------------
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'redflix-out-'));
try {
  const mixed = writeCategoryOutputs(model, { baseDirectory: temporary });
  assert.ok(fs.existsSync(mixed.paths.moviesJson));
  assert.ok(fs.existsSync(mixed.paths.seriesJson));
  assert.ok(fs.existsSync(mixed.paths.moviesDirectory));
  assert.ok(fs.existsSync(mixed.paths.seriesDirectory));
  assert.equal(
    JSON.parse(fs.readFileSync(mixed.paths.moviesJson, 'utf8')).movies.length, 2);
  assert.equal(
    JSON.parse(fs.readFileSync(mixed.paths.seriesJson, 'utf8')).series[0].seasons.length, 3);

  // Movie-only category: no empty series/ folder.
  const movieOnly = buildCategoryModel({
    category: 'Top 10 Movies', lastUpdated: LAST_UPDATED, purpose: PURPOSE,
    items: items.filter((item) => item.type === 'movie'),
  });
  const movieOnlyResult = writeCategoryOutputs(movieOnly, { baseDirectory: temporary });
  assert.ok(fs.existsSync(movieOnlyResult.paths.moviesDirectory));
  assert.equal(fs.existsSync(movieOnlyResult.paths.seriesDirectory), false);

  // Series-only category: no empty movies/ folder.
  const seriesOnly = buildCategoryModel({
    category: 'Top 10 TV Shows', lastUpdated: LAST_UPDATED, purpose: PURPOSE,
    items: items.filter((item) => item.type === 'episode'),
  });
  const seriesOnlyResult = writeCategoryOutputs(seriesOnly, { baseDirectory: temporary });
  assert.ok(fs.existsSync(seriesOnlyResult.paths.seriesDirectory));
  assert.equal(fs.existsSync(seriesOnlyResult.paths.moviesDirectory), false);

  assert.deepEqual(fs.readdirSync(temporary).sort(), ['top-10-movies', 'top-10-tv-shows', 'trending-now']);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('PASS: category/movies + category/series folder split and JSON writers');
