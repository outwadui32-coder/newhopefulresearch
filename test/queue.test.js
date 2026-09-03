'use strict';

const assert = require('node:assert/strict');
const queue = require('../lib/queue');

const TODAY = '2026-09-03';

function makeSeries(id, seasons, episodesPerSeason, airDate = '2022-02-04') {
  const episodes = [];
  for (let season = 1; season <= seasons; season += 1) {
    for (let number = 1; number <= episodesPerSeason; number += 1) {
      episodes.push({ seasonNumber: season, episodeNumber: number, airDate });
    }
  }
  return { id, type: 'series', title: id, episodes };
}

function makeMovie(id) {
  return { id, type: 'movie', title: id };
}

// --- the exact repository evidence: 7 series, 138 aired episodes ---------
// Seasons/episodes chosen to total 138 across 7 series.
const sevenSeries = [
  makeSeries('tv:1', 4, 8),   // 32
  makeSeries('tv:2', 3, 8),   // 24
  makeSeries('tv:3', 2, 10),  // 20
  makeSeries('tv:4', 2, 10),  // 20
  makeSeries('tv:5', 2, 8),   // 16
  makeSeries('tv:6', 1, 14),  // 14
  makeSeries('tv:7', 1, 12),  // 12
];
const discovered = queue.queueStats(sevenSeries, [], TODAY);
assert.equal(discovered.discoveredSeries, 7);
assert.equal(discovered.discoveredEpisodes, 138);

// The old behaviour capped the batch at maxTitles JOBS, yielding 7 processed
// episodes. A series now costs one title slot and brings all of its episodes.
const batch = queue.buildBatch({ titles: sevenSeries, maxTitles: 20, today: TODAY });
assert.equal(batch.titlesSelected, 7);
assert.equal(batch.jobs.length, 138, 'all 138 aired episodes must enter the queue');
assert.notEqual(batch.jobs.length, 7);

// Every season of every series is represented, in ascending order.
const bySeries = new Map();
for (const job of batch.jobs) {
  if (!bySeries.has(job.titleId)) bySeries.set(job.titleId, []);
  bySeries.get(job.titleId).push(job);
}
assert.equal(bySeries.size, 7);
assert.deepEqual([...new Set(bySeries.get('tv:1').map((job) => job.episode.seasonNumber))], [1, 2, 3, 4]);
assert.equal(bySeries.get('tv:1').length, 32);
assert.deepEqual(bySeries.get('tv:1').slice(0, 3).map((job) => job.episodeCode),
  ['S01E01', 'S01E02', 'S01E03']);
// No episode is queued twice.
assert.equal(new Set(batch.jobs.map((job) => job.jobId)).size, batch.jobs.length);

// --- mixed category: movies plus series ---------------------------------
const mixed = [
  makeMovie('movie:1'), makeMovie('movie:2'), makeSeries('tv:10', 2, 8), makeMovie('movie:3'),
];
const mixedBatch = queue.buildBatch({ titles: mixed, maxTitles: 20, today: TODAY });
assert.equal(mixedBatch.titlesSelected, 4);
assert.equal(mixedBatch.jobs.length, 3 + 16);
assert.equal(mixedBatch.jobs.filter((job) => job.type === 'movie').length, 3);
assert.equal(mixedBatch.jobs.filter((job) => job.type === 'episode').length, 16);

// --- the title budget still limits TITLES -------------------------------
const small = queue.buildBatch({ titles: sevenSeries, maxTitles: 2, today: TODAY });
assert.equal(small.titlesSelected, 2);
assert.equal(small.titlesRemaining, 5);
// The two selected series are complete, not truncated to 2 episodes.
assert.equal(small.jobs.length, 32 + 24);

// --- resume: a partly-scanned series finishes before new titles start ---
const firstTen = batch.jobs.filter((job) => job.titleId === 'tv:3').slice(0, 10).map((job) => job.jobId);
const resumed = queue.buildBatch({
  titles: sevenSeries, maxTitles: 1, processed: firstTen, today: TODAY,
});
assert.equal(resumed.resumedTitles, 1);
assert.equal(resumed.titles[0].id, 'tv:3', 'the partly-scanned series must resume first');
assert.equal(resumed.jobs.length, 10, 'only the outstanding episodes are re-queued');
assert.ok(!resumed.jobs.some((job) => firstTen.includes(job.jobId)));

// A fully processed title drops out of the queue entirely.
const allTv1 = batch.jobs.filter((job) => job.titleId === 'tv:1').map((job) => job.jobId);
const afterTv1 = queue.buildBatch({ titles: sevenSeries, maxTitles: 20, processed: allTv1, today: TODAY });
assert.equal(afterTv1.titlesSelected, 6);
assert.equal(afterTv1.jobs.length, 138 - 32);
assert.equal(queue.queueStats(sevenSeries, allTv1, TODAY).processedSeries, 1);
assert.equal(queue.queueStats(sevenSeries, allTv1, TODAY).processedEpisodes, 32);

// --- unaired episodes are held back, not queued -------------------------
const withFuture = [{
  id: 'tv:99', type: 'series', episodes: [
    { seasonNumber: 1, episodeNumber: 1, airDate: '2026-09-01' },
    { seasonNumber: 1, episodeNumber: 2, airDate: '2026-09-03' },
    { seasonNumber: 1, episodeNumber: 3, airDate: '2027-01-01' },
    { seasonNumber: 1, episodeNumber: 4, airDate: null },
  ],
}];
const aired = queue.buildBatch({ titles: withFuture, maxTitles: 20, today: TODAY });
assert.deepEqual(aired.jobs.map((job) => job.episodeCode), ['S01E01', 'S01E02']);
assert.equal(queue.queueStats(withFuture, [], TODAY).discoveredEpisodes, 2);

// --- season 0 keeps its own identity in job ids -------------------------
const specials = queue.buildBatch({
  titles: [{ id: 'tv:5', type: 'series', episodes: [{ seasonNumber: 0, episodeNumber: 1, airDate: '2022-01-01' }] }],
  maxTitles: 5, today: TODAY,
});
assert.equal(specials.jobs[0].jobId, 'tv:5:s00:e01');
assert.equal(specials.jobs[0].episodeCode, 'S00E01');

// Empty catalog is not an error.
assert.deepEqual(queue.buildBatch({ titles: [], maxTitles: 20, today: TODAY }).jobs, []);

console.log('PASS: queue processes all discovered seasons/episodes (138 of 138, not 7)');
