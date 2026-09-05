'use strict';

const assert = require('node:assert/strict');
const { buildCategoryModel } = require('../lib/model');
const { describeCategory } = require('../lib/category');
const { CATEGORY, LAST_UPDATED, PURPOSE, items } = require('./fixtures/items');

const model = buildCategoryModel({ category: CATEGORY, lastUpdated: LAST_UPDATED, purpose: PURPOSE, items });

// --- category descriptor ------------------------------------------------
assert.deepEqual(describeCategory('Browse: TRENDING NOW'), {
  raw: 'Browse: TRENDING NOW', name: 'Browse: TRENDING NOW',
  displayName: 'TRENDING NOW', folder: 'trending-now',
});
assert.equal(describeCategory('Top 10 Movies').folder, 'top-10-movies');
assert.equal(describeCategory('Home: Action & Adventure').folder, 'action-and-adventure');

// --- movies and series are separate collections -------------------------
assert.deepEqual(model.movies.map((item) => item.id), ['movie:10001', 'movie:10002']);
assert.equal(model.series.length, 1);
assert.ok(!model.movies.some((item) => item.seasons));
assert.ok(!model.series.some((item) => item.servers));

// A movie with no publishable stream is dropped, not published empty.
assert.ok(!model.movies.some((item) => item.id === 'movie:10003'));
assert.ok(model.dropped.some((item) => item.id === 'movie:10003'));

// --- movie servers: whitelist, order, dedupe, standard resolutions -------
const demo = model.movies[0];
assert.equal(demo.serial, 1);
assert.deepEqual(demo.servers.map((item) => item.name), ['Premium', 'Ultra', 'PlayFast']);
assert.deepEqual(demo.servers.find((item) => item.name === 'Ultra').qualities, [
  { quality: '4K', resolution: '3840x2160', url: 'https://stream.example.test/demo-movie/ultra/4k.m3u8' },
  { quality: '1080p', resolution: '1920x1080', url: 'https://stream.example.test/demo-movie/ultra/1080p.m3u8' },
]);
// Nova is not an allowed server; the 720p Alpha variant is below the floor.
assert.ok(!demo.servers.some((item) => item.name === 'Nova' || item.name === 'Alpha'));
// "Vid" published as Ultra.
assert.deepEqual(model.movies[1].servers.map((item) => item.name), ['Alpha', 'Ultra']);

// --- series -> season -> episode ----------------------------------------
const series = model.series[0];
assert.equal(series.serial, 1);
assert.equal(series.id, 'tv:108978');
assert.equal(series.totalSeasons, 3);   // source metadata, not the 3 built
assert.equal(series.totalEpisodes, 20); // source metadata, not the 5 published

// Seasons ascending, Specials kept as season 0 and NOT merged into season 1.
assert.deepEqual(series.seasons.map((item) => item.seasonNumber), [0, 1, 2]);
assert.equal(series.seasons[0].seasonName, 'Specials');
assert.equal(series.seasons[1].seasonName, 'Season 1');

// Episodes ascending within their own season; no cross-season leakage.
assert.deepEqual(series.seasons[1].episodes.map((item) => item.episodeNumber), [1, 2, 3]);
assert.deepEqual(series.seasons[1].episodes.map((item) => item.episodeCode), ['S01E01', 'S01E02', 'S01E03']);
assert.deepEqual(series.seasons[2].episodes.map((item) => item.episodeCode), ['S02E01', 'S02E02']);
assert.deepEqual(series.seasons[0].episodes.map((item) => item.episodeCode), ['S00E01']);

// A failed provider lookup keeps the aired episode metadata but publishes no
// unverified server URL.
assert.ok(!model.dropped.some((item) => item.id === 'tv:108978:s02:e02'));
assert.equal(series.seasons[2].episodes.length, 2);
assert.deepEqual(series.seasons[2].episodes[1].servers, []);

// Season-level totals come from season metadata.
assert.equal(series.seasons[1].totalEpisodes, 8);
assert.equal(series.seasons[0].totalEpisodes, 1);

// Per-episode servers are independent and deduped per episode.
const s01e01 = series.seasons[1].episodes[0];
assert.equal(s01e01.episodeName, 'Welcome to Margrave');
assert.deepEqual(s01e01.servers.map((item) => item.name), ['Alpha', 'Ultra']);
assert.deepEqual(s01e01.servers[0].qualities.map((item) => item.quality), ['4K', '1080p']);
assert.equal(s01e01.servers[1].qualities.length, 1); // 1620x1080 + 1920x1000 collapse
assert.equal(series.seasons[1].episodes[1].servers[0].qualities.length, 1);

// One episode's URL is never reused by another episode.
const allEpisodeUrls = series.seasons.flatMap((season) =>
  season.episodes.flatMap((item) => item.servers.flatMap((group) => group.qualities.map((entry) => entry.url))));
assert.equal(new Set(allEpisodeUrls).size, allEpisodeUrls.length);

// --- global invariants --------------------------------------------------
const ALLOWED_QUALITIES = ['8K', '4K', '2K', '1080p'];
const STANDARD = ['7680x4320', '3840x2160', '2560x1440', '1920x1080'];
const ALLOWED_SERVERS = ['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast'];

function everyServerGroup(built) {
  return [
    ...built.movies.flatMap((item) => item.servers),
    ...built.series.flatMap((item) =>
      item.seasons.flatMap((season) => season.episodes.flatMap((episode) => episode.servers))),
  ];
}
for (const group of everyServerGroup(model)) {
  assert.ok(ALLOWED_SERVERS.includes(group.name), `unexpected server ${group.name}`);
  const seen = new Set();
  for (const entry of group.qualities) {
    assert.ok(ALLOWED_QUALITIES.includes(entry.quality), `unexpected quality ${entry.quality}`);
    assert.ok(STANDARD.includes(entry.resolution), `unexpected resolution ${entry.resolution}`);
    assert.ok(!seen.has(entry.quality), `duplicate ${group.name} ${entry.quality}`);
    seen.add(entry.quality);
  }
}

console.log('PASS: normalized model separates movies/series and groups season -> episode');
