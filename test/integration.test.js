'use strict';

// Proves the whole chain joins up: a real manifest becomes stream entries,
// those become a normalized model, the model becomes the data/ tree, and the
// tree passes the verifier. This is the path the parser was missing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../lib');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
// Each item is served its own manifest, exactly as a real source would, so no
// two items can resolve to the same child variant URL.
const HLS = 'https://cdn.example.test/assets/demo/master.m3u8';
const MPD = 'https://cdn.example.test/assets/demo/manifest.mpd';
const EPISODE_1_HLS = 'https://cdn.example.test/assets/tv-20002-s01e01/master.m3u8';
const EPISODE_2_MPD = 'https://cdn.example.test/assets/tv-20002-s01e02/manifest.mpd';

// --- manifest -> stream entries -----------------------------------------
const alphaStreams = lib.streamsFromManifest('Alpha', fixture('master.m3u8'), HLS, { verified: true });
assert.equal(alphaStreams.length, 3);
assert.deepEqual(alphaStreams.map((entry) => entry.server), ['Alpha', 'Alpha', 'Alpha']);
// Raw dimensions are carried through, so the tier comes from what was declared.
assert.deepEqual(alphaStreams.map((entry) => entry.resolution),
  ['3840x2160', '2560x1440', '1920x800']);
assert.ok(alphaStreams.every((entry) => entry.exactVariant && entry.verified));

// A source label maps onto its canonical server on the way in.
const ultraStreams = lib.streamsFromManifest('Vid', fixture('manifest.mpd'), MPD, { verified: true });
assert.equal(ultraStreams.length, 3);

// --- stream entries -> model --------------------------------------------
const model = lib.buildCategoryModel({
  category: 'Browse: TRENDING NOW',
  lastUpdated: '2026-09-04 09:00 AM',
  purpose: 'Strictly for educational purposes only and not for commercial use',
  items: [
    {
      id: 'movie:20001', type: 'movie', title: 'Manifest Movie', year: 2026,
      poster: 'https://image.example.test/manifest-movie.jpg',
      streams: [...alphaStreams, ...ultraStreams],
    },
    {
      seriesId: 'tv:20002', seriesTitle: 'Manifest Series', seriesYear: 2026,
      seriesPoster: 'https://image.example.test/manifest-series.jpg',
      totalSeasons: 1, totalEpisodes: 2, seasonTotalEpisodes: 2,
      type: 'episode', seasonNumber: 1, episodeNumber: 1,
      episodeName: 'Pilot', airDate: '2026-01-05',
      poster: 'https://image.example.test/e1.jpg',
      streams: lib.streamsFromManifest('PlayFast', fixture('master.m3u8'), EPISODE_1_HLS, { verified: true }),
    },
    {
      seriesId: 'tv:20002', seriesTitle: 'Manifest Series', seriesYear: 2026,
      seriesPoster: 'https://image.example.test/manifest-series.jpg',
      totalSeasons: 1, totalEpisodes: 2, seasonTotalEpisodes: 2,
      type: 'episode', seasonNumber: 1, episodeNumber: 2,
      episodeName: 'Follow Up', airDate: '2026-01-12',
      poster: 'https://image.example.test/e2.jpg',
      streams: lib.streamsFromManifest('Premium', fixture('manifest.mpd'), EPISODE_2_MPD, { verified: true }),
    },
  ],
});

// Two servers on the movie, in canonical order, each carrying all three tiers.
const movie = model.movies[0];
assert.deepEqual(movie.servers.map((server) => server.name), ['Alpha', 'Ultra']);
for (const server of movie.servers) {
  assert.deepEqual(server.qualities.map((entry) => entry.quality), ['4K', '2K', '1080p']);
  assert.deepEqual(server.qualities.map((entry) => entry.resolution),
    ['3840x2160', '2560x1440', '1920x1080']);
}
// The 1080p entry came from a 1920x800 variant but points at that variant's URL.
const hd = movie.servers[0].qualities.find((entry) => entry.quality === '1080p');
assert.equal(hd.url, 'https://cdn.example.test/assets/demo/1080/index.m3u8');
assert.notEqual(hd.url, HLS, 'a tier must not fall back to the master URL');

// The series grouped correctly from manifest-derived streams.
assert.equal(model.series.length, 1);
assert.deepEqual(model.series[0].seasons[0].episodes.map((episode) => episode.episodeCode),
  ['S01E01', 'S01E02']);

// No URL is reused between episodes, or between the movie and the series.
const urlsOf = (servers) => servers.flatMap((server) => server.qualities.map((entry) => entry.url));
const episodeUrls = model.series[0].seasons[0].episodes.flatMap((episode) => urlsOf(episode.servers));
const movieUrls = model.movies.flatMap((item) => urlsOf(item.servers));
assert.equal(new Set(episodeUrls).size, episodeUrls.length);
assert.equal(movieUrls.filter((url) => episodeUrls.includes(url)).length, 0);

// --- model -> data tree -> verifier -------------------------------------
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'redflix-integration-'));
try {
  const result = lib.writeCategoryOutputs(model, { baseDirectory: base });
  assert.equal(result.written.length, 6);

  const report = lib.verifyDataTree(base);
  assert.deepEqual(report.errors, []);
  assert.equal(report.categories, 1);

  // Every tier from the manifest survived all the way to the playlist.
  const moviesM3u = fs.readFileSync(result.paths.moviesM3u, 'utf8');
  assert.equal((moviesM3u.match(/^#EXTINF:/gm) || []).length, 6);
  for (const tier of ['4K', '2K', '1080p']) {
    assert.ok(moviesM3u.includes(`quality="${tier}"`), `${tier} missing from the playlist`);
  }
  // No 720p/480p variant from the manifest reached the output.
  for (const dropped of ['1280x720', '854x480', '720p', '480p', '1920x800']) {
    assert.ok(!moviesM3u.includes(dropped), `${dropped} leaked into the playlist`);
  }
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}

// --- scheduling joins up too --------------------------------------------
const batch = lib.buildBatch({
  titles: [
    { id: 'movie:20001', type: 'movie' },
    {
      id: 'tv:20002',
      type: 'series',
      episodes: [
        { seasonNumber: 1, episodeNumber: 1, airDate: '2026-01-05' },
        { seasonNumber: 1, episodeNumber: 2, airDate: '2026-01-12' },
      ],
    },
  ],
  maxTitles: 20,
  today: '2026-09-04',
});
assert.equal(batch.titlesSelected, 2);
assert.deepEqual(batch.jobs.map((job) => job.jobId),
  ['movie:20001', 'tv:20002:s01:e01', 'tv:20002:s01:e02']);

console.log('PASS: manifest -> streams -> model -> data tree -> verifier chain is connected');
