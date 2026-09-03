'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildCategoryModel } = require('../lib/model');
const { buildMoviesM3u, buildSeriesM3u } = require('../lib/writers/m3u');
const { writeCategoryOutputs } = require('../lib/output');
const plan = require('./fixtures/plan-example');
const messy = require('./fixtures/items');

const planModel = buildCategoryModel({
  category: plan.CATEGORY, lastUpdated: plan.LAST_UPDATED, purpose: plan.PURPOSE, items: plan.items,
});

const moviesM3u = buildMoviesM3u(planModel);
const seriesM3u = buildSeriesM3u(planModel);

// --- headers ------------------------------------------------------------
assert.deepEqual(moviesM3u.split('\n').slice(0, 3), [
  '#EXTM3U', '# CATEGORY: Browse: TRENDING NOW', '# TYPE: MOVIES',
]);
assert.deepEqual(seriesM3u.split('\n').slice(0, 3), [
  '#EXTM3U', '# CATEGORY: Browse: TRENDING NOW', '# TYPE: SERIES',
]);

// --- one entry per quality tier -----------------------------------------
const movieQualityCount = planModel.movies
  .reduce((total, movie) => total + movie.servers.reduce((sum, s) => sum + s.qualities.length, 0), 0);
assert.equal((moviesM3u.match(/^#EXTINF:/gm) || []).length, movieQualityCount);
assert.equal(movieQualityCount, 7);

const episodeQualityCount = planModel.series.reduce((total, series) =>
  total + series.seasons.reduce((seasonTotal, season) =>
    seasonTotal + season.episodes.reduce((episodeTotal, episode) =>
      episodeTotal + episode.servers.reduce((sum, s) => sum + s.qualities.length, 0), 0), 0), 0);
assert.equal((seriesM3u.match(/^#EXTINF:/gm) || []).length, episodeQualityCount);
assert.equal(episodeQualityCount, 9);

// Every #EXTINF is followed immediately by its URL.
for (const text of [moviesM3u, seriesM3u]) {
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (!line.startsWith('#EXTINF:')) return;
    assert.match(lines[index + 1], /^https:\/\//, `missing URL after ${line.slice(0, 40)}`);
  });
}

// --- movie entry shape --------------------------------------------------
const firstMovieEntry = moviesM3u.split('\n').find((line) => line.startsWith('#EXTINF:'));
assert.equal(firstMovieEntry,
  '#EXTINF:-1 tvg-id="movie:10001" tvg-name="Demo Movie" ' +
  'tvg-logo="https://image.example.com/demo-movie-poster.jpg" ' +
  'group-title="TRENDING NOW | Movies" server="Premium" quality="2K" resolution="2560x1440",' +
  'Demo Movie [Premium] [2K]');

// --- series entry shape: series + season preserved in group-title -------
const firstSeriesEntry = seriesM3u.split('\n').find((line) => line.startsWith('#EXTINF:'));
assert.equal(firstSeriesEntry,
  '#EXTINF:-1 tvg-id="tv:108978-s01e01" ' +
  'tvg-name="Demo Series S01E01 - Welcome to Margrave" ' +
  'tvg-logo="https://image.example.com/demo-series-still.jpg" ' +
  'group-title="Demo Series | Season 1" series="Demo Series" season="1" episode="1" ' +
  'server="Alpha" quality="4K" resolution="3840x2160",Demo Series S01E01 [Alpha] [4K]');

assert.deepEqual([...new Set(seriesM3u.match(/group-title="[^"]*"/g))],
  ['group-title="Demo Series | Season 1"', 'group-title="Demo Series | Season 2"']);

// --- no duplicate episode/server/quality --------------------------------
function identities(text) {
  return (text.match(/^#EXTINF:.*$/gm) || []).map((line) => [
    line.match(/tvg-id="([^"]*)"/)[1],
    line.match(/server="([^"]*)"/)[1],
    line.match(/quality="([^"]*)"/)[1],
  ].join('|'));
}
for (const text of [moviesM3u, seriesM3u]) {
  const keys = identities(text);
  assert.equal(new Set(keys).size, keys.length, 'duplicate content/server/quality entry');
}

// --- only allowed servers, qualities and standard resolutions -----------
const messyModel = buildCategoryModel({
  category: messy.CATEGORY, lastUpdated: messy.LAST_UPDATED, purpose: messy.PURPOSE, items: messy.items,
});
for (const text of [buildMoviesM3u(messyModel), buildSeriesM3u(messyModel), moviesM3u, seriesM3u]) {
  for (const value of text.match(/resolution="([^"]*)"/g) || []) {
    assert.ok(['7680x4320', '3840x2160', '2560x1440', '1920x1080']
      .includes(value.split('"')[1]), `non-standard ${value}`);
  }
  for (const value of text.match(/quality="([^"]*)"/g) || []) {
    assert.ok(['8K', '4K', '2K', '1080p'].includes(value.split('"')[1]), `non-allowed ${value}`);
  }
  for (const value of text.match(/ server="([^"]*)"/g) || []) {
    assert.ok(['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast']
      .includes(value.split('"')[1]), `non-allowed ${value}`);
  }
  for (const raw of ['1620x1080', '1920x800', '1920x804', '1920x960', '1920x1000', '720p', '480p']) {
    assert.ok(!text.includes(raw), `${raw} leaked into M3U`);
  }
  assert.ok(text.endsWith('\n'));
}

// Movies and series never share a playlist.
assert.ok(!moviesM3u.includes('tv:108978'));
assert.ok(!seriesM3u.includes('movie:10001'));

// --- all six files agree on the same data -------------------------------
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'redflix-m3u-'));
try {
  const result = writeCategoryOutputs(messyModel, { baseDirectory: temporary });
  assert.equal(result.written.length, 6);
  for (const file of ['moviesJson', 'moviesText', 'moviesM3u', 'seriesJson', 'seriesText', 'seriesM3u']) {
    assert.ok(fs.existsSync(result.paths[file]), `${file} not written`);
  }

  // Same URL set across JSON, TXT and M3U, for movies and for series.
  const moviesJson = JSON.parse(fs.readFileSync(result.paths.moviesJson, 'utf8'));
  const jsonMovieUrls = moviesJson.movies
    .flatMap((movie) => movie.servers.flatMap((s) => s.qualities.map((q) => q.url))).sort();
  const textMovieUrls = (fs.readFileSync(result.paths.moviesText, 'utf8')
    .match(/^URL\s+: (.+)$/gm) || []).map((line) => line.split(': ')[1]).sort();
  const m3uMovieUrls = fs.readFileSync(result.paths.moviesM3u, 'utf8')
    .split('\n').filter((line) => line.startsWith('https://')).sort();
  assert.deepEqual(textMovieUrls, jsonMovieUrls);
  assert.deepEqual(m3uMovieUrls, jsonMovieUrls);

  const seriesJson = JSON.parse(fs.readFileSync(result.paths.seriesJson, 'utf8'));
  const jsonEpisodeUrls = seriesJson.series.flatMap((series) =>
    series.seasons.flatMap((season) => season.episodes.flatMap((episode) =>
      episode.servers.flatMap((s) => s.qualities.map((q) => q.url))))).sort();
  const textEpisodeUrls = (fs.readFileSync(result.paths.seriesText, 'utf8')
    .match(/^URL\s+: (.+)$/gm) || []).map((line) => line.split(': ')[1]).sort();
  const m3uEpisodeUrls = fs.readFileSync(result.paths.seriesM3u, 'utf8')
    .split('\n').filter((line) => line.startsWith('https://')).sort();
  assert.deepEqual(textEpisodeUrls, jsonEpisodeUrls);
  assert.deepEqual(m3uEpisodeUrls, jsonEpisodeUrls);

  // A movie URL never appears in a series file and vice versa.
  assert.equal(jsonMovieUrls.filter((url) => jsonEpisodeUrls.includes(url)).length, 0);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

console.log('PASS: separate movie/series M3U playlists agree with JSON and TXT');
