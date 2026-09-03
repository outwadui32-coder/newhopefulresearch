'use strict';

// Full end-to-end check: build every category shape, write the data/ tree, then
// assert the published-output checklist directly against the files on disk.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildCategoryModel } = require('../lib/model');
const { writeCategoryOutputs } = require('../lib/output');
const { verifyDataTree } = require('../lib/verify');
const plan = require('./fixtures/plan-example');
const messy = require('./fixtures/items');

const CANONICAL = ['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast'];
const QUALITIES = ['8K', '4K', '2K', '1080p'];
const STANDARD = ['7680x4320', '3840x2160', '2560x1440', '1920x1080'];
const FORBIDDEN_RAW = ['1620x1080', '1920x800', '1920x804', '1920x960', '1920x1000', '1280x720', '854x480'];

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redflix-e2e-'));
const checks = [];
function check(name, run) {
  try {
    run();
    checks.push([true, name]);
  } catch (error) {
    checks.push([false, `${name}  ->  ${error.message}`]);
  }
}

const build = (category, items) => writeCategoryOutputs(
  buildCategoryModel({ category, lastUpdated: plan.LAST_UPDATED, purpose: plan.PURPOSE, items }),
  { baseDirectory: base }
);

// Mixed, movie-only and series-only categories.
build('Browse: TRENDING NOW', messy.items);
build('Top 10 Movies', plan.movies);
build('Top 10 TV Shows', plan.series);
build('Latest', plan.items);

const read = (file) => fs.readFileSync(file, 'utf8');
// A Windows checkout may rewrite the golden fixtures to CRLF; the writers
// always emit LF, so goldens are compared with normalized line endings.
const readLf = (file) => read(file).split('\r\n').join('\n');
const categories = fs.readdirSync(base).sort();

check('verifier reports zero problems across every category', () => {
  const report = verifyDataTree(base);
  assert.deepEqual(report.errors, []);
  assert.equal(report.categories, 4);
});

check('folder layout: mixed / movie-only / series-only', () => {
  assert.deepEqual(categories, ['latest', 'top-10-movies', 'top-10-tv-shows', 'trending-now']);
  const has = (folder, kind) => fs.existsSync(path.join(base, folder, kind));
  assert.ok(has('trending-now', 'movies') && has('trending-now', 'series'), 'mixed needs both');
  assert.ok(has('top-10-movies', 'movies') && !has('top-10-movies', 'series'), 'movie-only');
  assert.ok(!has('top-10-tv-shows', 'movies') && has('top-10-tv-shows', 'series'), 'series-only');
});

check('each present folder holds exactly its JSON + M3U + TXT', () => {
  for (const folder of categories) {
    for (const [kind, files] of [
      ['movies', ['movies.json', 'movies.m3u', 'movies.txt']],
      ['series', ['series.json', 'series.m3u', 'series.txt']],
    ]) {
      const directory = path.join(base, folder, kind);
      if (!fs.existsSync(directory)) continue;
      assert.deepEqual(fs.readdirSync(directory).sort(), [...files].sort(), `${folder}/${kind}`);
    }
  }
});

// Walk every published server group in every movies.json / series.json.
function serverGroups() {
  const groups = [];
  for (const folder of categories) {
    const moviesFile = path.join(base, folder, 'movies', 'movies.json');
    if (fs.existsSync(moviesFile)) {
      for (const movie of JSON.parse(read(moviesFile)).movies) {
        groups.push({ where: `${folder}/${movie.id}`, servers: movie.servers });
      }
    }
    const seriesFile = path.join(base, folder, 'series', 'series.json');
    if (fs.existsSync(seriesFile)) {
      for (const series of JSON.parse(read(seriesFile)).series) {
        for (const season of series.seasons) {
          for (const episode of season.episodes) {
            groups.push({ where: `${folder}/${series.id}/${episode.episodeCode}`, servers: episode.servers });
          }
        }
      }
    }
  }
  return groups;
}

check('only the five allowed servers appear', () => {
  for (const { where, servers } of serverGroups()) {
    for (const server of servers) assert.ok(CANONICAL.includes(server.name), `${where}: ${server.name}`);
  }
});

check('server order is canonical Alpha -> Premium -> Orion -> Ultra -> PlayFast', () => {
  for (const { where, servers } of serverGroups()) {
    const ranks = servers.map((server) => CANONICAL.indexOf(server.name));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${where}: ${servers.map((s) => s.name)}`);
  }
});

check('only 1080p/2K/4K/8K at standard frames, ordered 8K -> 1080p', () => {
  for (const { where, servers } of serverGroups()) {
    for (const server of servers) {
      const order = server.qualities.map((entry) => QUALITIES.indexOf(entry.quality));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), `${where}/${server.name} order`);
      for (const entry of server.qualities) {
        assert.ok(QUALITIES.includes(entry.quality), `${where}: ${entry.quality}`);
        assert.ok(STANDARD.includes(entry.resolution), `${where}: ${entry.resolution}`);
      }
    }
  }
});

check('no duplicate server + quality on any item', () => {
  for (const { where, servers } of serverGroups()) {
    for (const server of servers) {
      const keys = server.qualities.map((entry) => entry.quality);
      assert.equal(new Set(keys).size, keys.length, `${where}/${server.name}`);
    }
    const names = servers.map((server) => server.name);
    assert.equal(new Set(names).size, names.length, `${where}: repeated server`);
  }
});

check('no raw odd dimension anywhere in any published file', () => {
  for (const folder of categories) {
    for (const kind of ['movies', 'series']) {
      const directory = path.join(base, folder, kind);
      if (!fs.existsSync(directory)) continue;
      for (const file of fs.readdirSync(directory)) {
        const contents = read(path.join(directory, file));
        for (const raw of FORBIDDEN_RAW) {
          assert.ok(!contents.includes(raw), `${folder}/${kind}/${file} contains ${raw}`);
        }
      }
    }
  }
});

check('season/episode grouping is correct and Specials stay separate', () => {
  const document = JSON.parse(read(path.join(base, 'trending-now', 'series', 'series.json')));
  const series = document.series[0];
  assert.deepEqual(series.seasons.map((season) => season.seasonNumber), [0, 1, 2]);
  assert.equal(series.seasons[0].seasonName, 'Specials');
  const codes = series.seasons.flatMap((season) => season.episodes.map((episode) => episode.episodeCode));
  assert.deepEqual(codes, ['S00E01', 'S01E01', 'S01E02', 'S01E03', 'S02E01']);
  assert.equal(new Set(codes).size, codes.length, 'an episode appears under two seasons');
  // Series metadata survives even though one episode had no playable stream.
  assert.equal(series.totalSeasons, 3);
  assert.equal(series.totalEpisodes, 20);
});

check('JSON, TXT and M3U carry an identical URL set in every category', () => {
  for (const folder of categories) {
    for (const [kind, name] of [['movies', 'movies'], ['series', 'series']]) {
      const directory = path.join(base, folder, kind);
      if (!fs.existsSync(directory)) continue;
      const document = JSON.parse(read(path.join(directory, `${name}.json`)));
      const fromJson = kind === 'movies'
        ? document.movies.flatMap((movie) =>
          movie.servers.flatMap((server) => server.qualities.map((entry) => entry.url)))
        : document.series.flatMap((series) => series.seasons.flatMap((season) =>
          season.episodes.flatMap((episode) =>
            episode.servers.flatMap((server) => server.qualities.map((entry) => entry.url)))));
      const textContents = read(path.join(directory, `${name}.txt`));
      const fromText = (textContents.match(/^URL\s+: (.+)$/gm) || [])
        .map((line) => line.replace(/^URL\s+: /, ''));
      const m3uLines = read(path.join(directory, `${name}.m3u`)).split('\n');
      const fromM3u = m3uLines.filter((line, index) => index > 0 && m3uLines[index - 1].startsWith('#EXTINF:'));
      const sorted = (list) => [...list].sort();
      assert.deepEqual(sorted(fromText), sorted(fromJson), `${folder}/${kind} TXT vs JSON`);
      assert.deepEqual(sorted(fromM3u), sorted(fromJson), `${folder}/${kind} M3U vs JSON`);
    }
  }
});

check('movies and series never share a file or a URL', () => {
  for (const folder of categories) {
    const moviesFile = path.join(base, folder, 'movies', 'movies.json');
    const seriesFile = path.join(base, folder, 'series', 'series.json');
    if (fs.existsSync(moviesFile)) {
      const contents = read(moviesFile);
      assert.ok(!contents.includes('"seasons"'), `${folder}: seasons inside movies.json`);
    }
    if (fs.existsSync(seriesFile)) {
      assert.ok(!read(seriesFile).includes('"movies"'), `${folder}: movies inside series.json`);
    }
    if (!fs.existsSync(moviesFile) || !fs.existsSync(seriesFile)) continue;
    const movieUrls = JSON.parse(read(moviesFile)).movies
      .flatMap((movie) => movie.servers.flatMap((server) => server.qualities.map((entry) => entry.url)));
    const episodeUrls = JSON.parse(read(seriesFile)).series.flatMap((series) =>
      series.seasons.flatMap((season) => season.episodes.flatMap((episode) =>
        episode.servers.flatMap((server) => server.qualities.map((entry) => entry.url)))));
    assert.equal(movieUrls.filter((url) => episodeUrls.includes(url)).length, 0, folder);
  }
});

check('TXT layout on disk stays byte-identical to the approved goldens', () => {
  // The goldens were written for the plan's worked example under its own
  // category name, so they are compared against a tree built from exactly that.
  const goldenBase = fs.mkdtempSync(path.join(os.tmpdir(), 'redflix-golden-'));
  try {
    const result = writeCategoryOutputs(
      buildCategoryModel({
        category: plan.CATEGORY, lastUpdated: plan.LAST_UPDATED, purpose: plan.PURPOSE, items: plan.items,
      }),
      { baseDirectory: goldenBase }
    );
    assert.equal(read(result.paths.moviesText), readLf(path.join(__dirname, 'fixtures', 'golden-movies.txt')));
    assert.equal(read(result.paths.seriesText), readLf(path.join(__dirname, 'fixtures', 'golden-series.txt')));
  } finally {
    fs.rmSync(goldenBase, { recursive: true, force: true });
  }
});

check('metadata counts match the records in every file', () => {
  for (const folder of categories) {
    const moviesFile = path.join(base, folder, 'movies', 'movies.json');
    if (fs.existsSync(moviesFile)) {
      const document = JSON.parse(read(moviesFile));
      assert.equal(document.metadata.totalMovies, document.movies.length, folder);
      assert.equal(document.metadata.purpose, plan.PURPOSE, folder);
      document.movies.forEach((movie, index) => assert.equal(movie.serial, index + 1));
    }
    const seriesFile = path.join(base, folder, 'series', 'series.json');
    if (fs.existsSync(seriesFile)) {
      const document = JSON.parse(read(seriesFile));
      assert.equal(document.metadata.totalSeries, document.series.length, folder);
      document.series.forEach((series, index) => assert.equal(series.serial, index + 1));
    }
  }
});

const failures = checks.filter(([ok]) => !ok);
for (const [ok, name] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`\n${checks.length - failures.length}/${checks.length} end-to-end checks passed`);

if (process.argv[2] === '--keep') console.log(`tree kept at ${base}`);
else fs.rmSync(base, { recursive: true, force: true });

if (failures.length > 0) process.exitCode = 1;
