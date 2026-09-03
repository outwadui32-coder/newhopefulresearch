const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scanner = require('./site-scanner');
const collector = require('./collector');

assert.equal(scanner.parseArgs([]).maxTitles, 20);
assert.equal(scanner.parseArgs([]).workers, 2);
assert.equal(scanner.parseArgs([]).serverWorkers, 5);
assert.equal(scanner.parseArgs(['--category', 'Drama']).category, 'Drama');
assert.equal(scanner.parseArgs(['--workers', '5']).workers, 5);
assert.equal(scanner.inferQuality('https://cdn/video_1080.m3u8', 'hls'), '1080p');
assert.equal(
  scanner.isMediaFragment('https://proxy/?url=https%3A%2F%2Fcdn%2Fpage-0.html'),
  true
);

const catalog = [];
for (let index = 1; index <= 45; index += 1) {
  catalog.push({ url: `https://test/a/${index}`, title: `A ${index}`, categories: ['A'] });
}
for (let index = 1; index <= 25; index += 1) {
  catalog.push({ url: `https://test/b/${index}`, title: `B ${index}`, categories: ['B'] });
}
const rotation = { catalog, scheduler: scanner.reconcileScheduler(catalog) };
const observed = [];
for (let turn = 0; turn < 5; turn += 1) {
  const batch = scanner.nextCategoryBatch(rotation, 20);
  observed.push(`${batch.category}:${batch.titles.length}`);
  rotation.scheduler.processedByCategory[batch.category].push(...batch.titles.map((item) => item.url));
}
assert.deepEqual(observed, ['A:20', 'B:20', 'A:20', 'B:5', 'A:5']);
assert.equal(rotation.scheduler.processedByCategory.A.length, 45);
assert.equal(rotation.scheduler.processedByCategory.B.length, 25);
const featuredRotation = scanner.reconcileScheduler([
  { url: 'https://test/hero', categories: ['Home: Hero', 'Home: Top 10 Movies Today'] },
]);
assert.deepEqual(featuredRotation.categoryOrder, ['Home: Top 10 Movies Today']);

const shared = { url: 'https://test/shared', categories: ['A', 'B'] };
scanner.markItemProcessed(rotation.scheduler, shared);
assert.ok(rotation.scheduler.processedByCategory.A.includes(shared.url));
assert.ok(rotation.scheduler.processedByCategory.B.includes(shared.url));
assert.deepEqual(scanner.categoryDescriptor('Home: Action & Adventure'), {
  raw: 'Home: Action & Adventure',
  name: 'Action & Adventure',
  type: 'genre',
  folder: 'action-and-adventure',
  categoryId: 'genre:action-and-adventure',
  surface: 'Home',
});
assert.equal(scanner.canonicalMovieId({ url: 'https://redflix.co/play?id=1083381&type=movie' }), 'movie:1083381');
assert.equal(
  scanner.canonicalMovieId({ url: 'https://redflix.co/play?id=95350&type=tv&season=1&episode=2' }),
  'tv:95350:s01:e02'
);
assert.equal(scanner.isEpisodeItem({ url: 'https://redflix.co/play?id=95350&type=tv&season=1&episode=2' }), true);
assert.equal(scanner.isEpisodeItem({ url: 'https://redflix.co/play?id=95350&type=tv&season=0&episode=1' }), true);
assert.equal(scanner.isUnscopedSeriesItem({ url: 'https://redflix.co/play?id=95350&type=tv' }), true);

const fakeProbe = {
  ok: true, variants: [], directPlaybackNoHeaders: true, resolution: '1920x1080',
};
const multiServerPayload = {
  results: [{
    title: 'Movie One', url: 'https://redflix.co/play?id=1&type=movie', categories: ['Action'],
    scan: { finishedAt: new Date().toISOString(), finalStreams: [
      { server: 'Alpha', kind: 'hls', url: 'https://cdn/720/index.m3u8', probe: fakeProbe, headers: {} },
      { server: 'Alpha', kind: 'hls', url: 'https://cdn/720/index.m3u8', probe: fakeProbe, headers: {} },
      { server: 'Premium', kind: 'hls', url: 'https://cdn/720/index.m3u8', probe: fakeProbe, headers: {} },
      { server: 'Premium', kind: 'hls', url: 'https://backup/1080/master.m3u8', probe: fakeProbe, headers: {} },
    ] },
  }],
};
const rows = scanner.outputRows(multiServerPayload);
assert.equal(rows.length, 3, 'duplicate within one server collapses, but each selected server remains represented');
assert.deepEqual(rows.map((row) => row.server), ['Alpha', 'Premium', 'Premium']);
assert.ok(rows.every((row) => Object.keys(row.headers).length === 0));
assert.equal(scanner.is1080ClassResolution('1920x1080'), true);
assert.equal(scanner.is1080ClassResolution('1920x800'), true);
assert.equal(scanner.is1080ClassResolution('1900x800'), false);
assert.equal(scanner.is1080ClassResolution('1280x720'), false);
assert.equal(collector.isActivatedSourceState({ found: true, selected: true, iframeUrl: null }), false);
assert.equal(collector.isActivatedSourceState({ found: true, selected: true, iframeUrl: 'https://provider/player' }), true);
assert.equal(
  collector.attributedServer('https://vidcore.net/movie/1', 'PlayFast', new Map([['vidcore.net', 'Orion']])),
  'Orion'
);
assert.equal(collector.attributedServer('about:blank', 'PlayFast', new Map()), 'PlayFast');
assert.deepEqual(
  collector.resolveSourcePlan(['Vid', 'PlayFast', 'Orion', 'Premium', 'Alpha']),
  [
    { server: 'Alpha', sourceLabel: 'Alpha' },
    { server: 'Premium', sourceLabel: 'Premium' },
    { server: 'Orion', sourceLabel: 'Orion' },
    { server: 'Ultra', sourceLabel: 'Vid' },
    { server: 'PlayFast', sourceLabel: 'PlayFast' },
  ]
);
assert.equal(
  collector.serverRoute('https://redflix.co/play?id=1&type=movie', 'Orion'),
  'https://redflix.co/play?id=1&type=movie&server=vidcore'
);
assert.equal(
  collector.serverRoute('https://redflix.co/play?id=1&type=movie', 'PlayFast'),
  'https://redflix.co/play?id=1&type=movie'
);
assert.deepEqual(
  collector.mediaUrlsFromText(
    '{"file":"https:\\/\\/cdn.example\\/api\\/master.m3u8?token=abc"}',
    'https://provider.example/player'
  ),
  ['https://cdn.example/api/master.m3u8?token=abc']
);

const resumeCatalog = Array.from({ length: 5 }, (_, index) => ({
  url: `https://test/resume/${index + 1}`, title: `Resume ${index + 1}`, categories: ['Resume Category'],
}));
const resumePayload = { catalog: resumeCatalog, scheduler: scanner.reconcileScheduler(resumeCatalog) };
const initialResumeBatch = scanner.nextCategoryBatch(resumePayload, 5);
scanner.markItemProcessed(resumePayload.scheduler, initialResumeBatch.titles[0]);
scanner.markItemProcessed(resumePayload.scheduler, initialResumeBatch.titles[1]);
const resumedBatch = scanner.nextCategoryBatch(resumePayload, 5);
assert.equal(resumedBatch.category, 'Resume Category');
assert.equal(resumedBatch.resumed, true);
assert.deepEqual(resumedBatch.titles.map((item) => item.url), resumeCatalog.slice(2).map((item) => item.url));

const cleanedMovie = scanner.normalizeTitleMetadata(
  {
    url: 'https://redflix.co/play?id=1368337&type=movie',
    title: '7.9 TOP 10 RECENTLY ADDED The Odyssey 2026',
    categories: ['Home: Top 10 Today'],
  },
  { title: 'The Odyssey', release_date: '2026-07-17' }
);
assert.equal(cleanedMovie.title, 'The Odyssey');
assert.equal(cleanedMovie.year, 2026);
const movieWithPoster = scanner.normalizeTitleMetadata(
  { url: cleanedMovie.url, title: cleanedMovie.title, categories: cleanedMovie.categories },
  { title: 'The Odyssey', release_date: '2026-07-17', poster_path: '/odyssey.jpg' }
);
assert.equal(movieWithPoster.poster, 'https://image.tmdb.org/t/p/original/odyssey.jpg');

const cleanedEpisode = scanner.normalizeTitleMetadata(
  {
    url: 'https://redflix.co/play?id=95350&type=tv&season=1&episode=2',
    title: 'Legacy Episode Label',
    seriesTitle: 'Example Series',
    episodeTitle: 'Second Episode',
    airDate: '2024-03-04',
  },
  null
);
assert.equal(cleanedEpisode.title, 'Example Series S01E02 - Second Episode');
assert.equal(cleanedEpisode.year, 2024);

const reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'redflix-report-test-'));
const reportTextPath = path.join(reportDirectory, 'streams.txt');
const reportM3uPath = path.join(reportDirectory, 'playlist.m3u');
const reportPayload = {
  catalog: [cleanedMovie],
  seriesMetadata: [],
  results: [{
    ...cleanedMovie,
    scan: {
      success: true,
      finishedAt: new Date().toISOString(),
      finalStreams: [
        { server: 'Alpha', kind: 'hls', url: 'https://alpha/master.m3u8', probe: fakeProbe, headers: {} },
        { server: 'Alpha', kind: 'hls', url: 'https://alpha/backup-master.m3u8', probe: fakeProbe, headers: {} },
        { server: 'Premium', kind: 'hls', url: 'https://premium/master.m3u8', probe: fakeProbe, headers: {} },
      ],
    },
  }],
};
assert.deepEqual(scanner.successfulBatchCounts(reportPayload, [cleanedMovie.url]), {
  successfulNewMovies: 1,
  successfulNewSeries: 0,
  successfulNewEpisodes: 0,
});

const episodeOne = scanner.normalizeTitleMetadata({
  url: 'https://redflix.co/play?id=95350&type=tv&season=1&episode=1',
  seriesId: '95350',
  seriesTitle: 'Lanterns',
  episodeTitle: 'Pilot',
  airDate: '2026-01-01',
  categories: ['Browse: TRENDING NOW'],
}, null);
const episodeTwo = scanner.normalizeTitleMetadata({
  url: 'https://redflix.co/play?id=95350&type=tv&season=1&episode=2',
  seriesId: '95350',
  seriesTitle: 'Lanterns',
  episodeTitle: 'Trust Fall',
  airDate: '2026-01-08',
  categories: ['Browse: TRENDING NOW'],
}, null);
const expandedScheduler = {
  activeBatch: {
    category: 'Browse: TRENDING NOW',
    urls: ['https://redflix.co/tv/95350'],
    startedAt: '2026-09-03T02:20:00.000Z',
  },
};
scanner.syncActiveBatchToQueue(
  expandedScheduler,
  'Browse: TRENDING NOW',
  [episodeOne, episodeTwo]
);
assert.deepEqual(expandedScheduler.activeBatch, {
  category: 'Browse: TRENDING NOW',
  urls: [episodeOne.url, episodeTwo.url],
  startedAt: '2026-09-03T02:20:00.000Z',
});

const repairedPayload = {
  results: [
    { ...cleanedMovie, scan: reportPayload.results[0].scan },
    { ...episodeOne, scan: reportPayload.results[0].scan },
    { ...episodeTwo, scan: { success: false, finalStreams: [] } },
  ],
  scheduler: {
    lastCategory: 'Browse: TRENDING NOW',
    lastBatchByCategory: {
      'Browse: TRENDING NOW': {
        category: 'Browse: TRENDING NOW',
        successfulNewMovies: 0,
        successfulNewSeries: 0,
        successfulNewEpisodes: 0,
        completedAt: '2026-09-03T02:33:09.974Z',
      },
    },
  },
};
const repairDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'redflix-batch-repair-test-'));
const repairHistory = path.join(repairDirectory, 'scan-history.jsonl');
fs.writeFileSync(repairHistory, [
  { timestamp: '2026-09-03T02:19:54.373Z', event: 'run-start' },
  { timestamp: '2026-09-03T02:21:50.643Z', event: 'title-scanned', selectedCategory: 'Browse: TRENDING NOW', url: cleanedMovie.url },
  { timestamp: '2026-09-03T02:24:16.839Z', event: 'title-scanned', selectedCategory: 'Browse: TRENDING NOW', url: episodeOne.url },
  { timestamp: '2026-09-03T02:25:00.000Z', event: 'title-failed', selectedCategory: 'Browse: TRENDING NOW', url: episodeTwo.url },
  { timestamp: '2026-09-03T02:33:09.974Z', event: 'category-batch-complete', selectedCategory: 'Browse: TRENDING NOW' },
  { timestamp: '2026-09-03T02:33:10.025Z', event: 'run-complete' },
].map((item) => JSON.stringify(item)).join('\n') + '\n');
assert.equal(scanner.repairLatestBatchCounts(repairedPayload, repairHistory), true);
assert.deepEqual(
  repairedPayload.scheduler.lastBatchByCategory['Browse: TRENDING NOW'],
  {
    category: 'Browse: TRENDING NOW',
    successfulNewMovies: 1,
    successfulNewSeries: 1,
    successfulNewEpisodes: 1,
    completedAt: '2026-09-03T02:33:09.974Z',
  }
);
fs.rmSync(repairDirectory, { recursive: true, force: true });
const reportMetadata = {
  categoryName: 'Home: Action & Adventure',
  totalMoviesAdded: 1,
  successfulNewMovies: 1,
  successfulNewSeries: 0,
  successfulNewEpisodes: 0,
  totalStreamLinks: 3,
  totalUniqueMediaUrls: 3,
  lastUpdated: '2026-09-02T12:31:22.138Z',
};
scanner.saveTextReport(reportPayload, reportTextPath, reportMetadata);
scanner.saveM3uReport(reportPayload, reportM3uPath, reportMetadata);
const reportText = fs.readFileSync(reportTextPath, 'utf8');
const reportM3u = fs.readFileSync(reportM3uPath, 'utf8');
assert.match(reportText, /^CATEGORY: Home: Action & Adventure$/m);
assert.match(reportText, /^TOTAL MOVIES: 1$/m);
assert.match(reportText, /^SUCCESSFUL NEW ADDED: 1$/m);
assert.match(reportText, /^SUCCESSFUL NEW ADDED SERIES: 0$/m);
assert.match(reportText, /^SUCCESSFUL NEW ADDED EPISODES: 0$/m);
assert.match(reportText, /^STREAM_LINKS: 3$/m);
assert.match(reportText, /^UNIQUE_STREAM_URLS: 3$/m);
assert.match(reportText, /^LAST_UPDATED: 2026-09-02T12:31:22.138Z$/m);
assert.doesNotMatch(reportText, /^PURPOSE:/m);
assert.match(reportText, /^Movie-1$/m);
assert.match(reportText, /^Title: The Odyssey$/m);
assert.match(reportText, /^Year: 2026$/m);
assert.match(reportText, /^Category: Top 10 Today$/m);
assert.equal((reportText.match(/^Server-1: Alpha$/gm) || []).length, 1);
assert.match(reportText, /^Resolution-1: 1920x1080$/m);
assert.match(reportText, /^Resolution-2: 1920x1080$/m);
assert.match(reportText, /^Server-2: Premium$/m);
assert.doesNotMatch(reportText, /^Type:/m);
assert.doesNotMatch(reportText, /^Headers:/m);
assert.match(reportM3u, /^# CATEGORY: Home: Action & Adventure$/m);
assert.match(reportM3u, /Movie-1 \| The Odyssey \(2026\) \| Alpha \| 1920x1080/);
assert.doesNotMatch(reportM3u, /http-referrer|http-user-agent|Type:/i);
fs.rmSync(reportDirectory, { recursive: true, force: true });

const nestedRecord = scanner.canonicalMovieRecord(cleanedMovie, scanner.outputRows(reportPayload), 'Movie-1');
assert.equal(nestedRecord.serial, 'Movie-1');
assert.deepEqual(nestedRecord.servers.map((item) => item.server), ['Alpha', 'Premium']);
assert.equal(nestedRecord.servers[0].links.length, 2);
assert.deepEqual(Object.keys(nestedRecord.servers[0].links[0]), ['resolution', 'url']);
assert.equal('streams' in nestedRecord, false);

const paths = scanner.outputPaths(process.cwd());
if (fs.existsSync(paths.checkpoint) && fs.existsSync(paths.masterJson)) {
  const json = JSON.parse(fs.readFileSync(paths.checkpoint, 'utf8'));
  const master = JSON.parse(fs.readFileSync(paths.masterJson, 'utf8'));
  const text = fs.readFileSync(paths.masterText, 'utf8');
  const m3u = fs.readFileSync(paths.masterM3u, 'utf8');
  const extInfCount = (m3u.match(/^#EXTINF:/gm) || []).length;
  const declaredMasterLinks = Number(text.match(/^STREAM_LINKS: (\d+)$/m)?.[1]);
  assert.equal(declaredMasterLinks, extInfCount);
  assert.match(text, /^CATEGORY: MASTER$/m);
  assert.doesNotMatch(text, /^PURPOSE:/m);
  assert.doesNotMatch(m3u, /^# PURPOSE:/m);
  assert.equal(Object.prototype.hasOwnProperty.call(master, 'purpose'), false);
  for (const [category, data] of Object.entries(json.categoryData)) {
    if (data.totalMoviesAdded === 0) continue;
    assert.ok(data.results.every((result) => Array.isArray(result.streams)));
    assert.equal(
      data.totalStreamLinks,
      data.results.reduce((total, result) => total + result.streams.length, 0)
    );
  }
  const masterSeries = master.series || [];
  const masterEpisodeCount = masterSeries.reduce(
    (total, series) => total + series.seasons.reduce(
      (seasonTotal, season) => seasonTotal + season.episodes.length,
      0
    ),
    0
  );
  const masterRecords = [
    ...(master.movies || []),
    ...masterSeries.flatMap((series) => series.seasons.flatMap((season) => season.episodes)),
  ];
  assert.equal(
    masterRecords.length,
    json.results.filter((item) => !item.excludedFromOutputs).length
  );
  assert.ok(masterRecords.every((item) => item.serial && item.canonicalId && item.taxonomy && Array.isArray(item.servers)));
  assert.equal(master.categories.length, scanner.categoryGroups(json).length);
  for (const category of master.categories) {
    const directory = `${paths.categoriesDirectory}/${category.folder}`;
    const categoryJson = JSON.parse(fs.readFileSync(`${directory}/category.json`, 'utf8'));
    const categoryText = fs.readFileSync(`${directory}/streams.txt`, 'utf8');
    const categoryM3u = fs.readFileSync(`${directory}/playlist.m3u`, 'utf8');
    assert.equal(categoryJson.metadata.category, category.categoryName);
    assert.equal(Object.prototype.hasOwnProperty.call(categoryJson.metadata, 'purpose'), false);
    const categoryRecords = [
      ...(categoryJson.movies || []),
      ...(categoryJson.series || []).flatMap((series) => series.seasons.flatMap((season) => season.episodes)),
    ];
    for (const item of categoryRecords) {
      const masterItem = masterRecords.find((candidate) => candidate.canonicalId === item.canonicalId);
      assert.ok(masterItem);
      assert.ok(item.serial);
      assert.ok(Array.isArray(item.servers));
      assert.equal(item.categoryMemberships.length, 1);
    }
    assert.match(categoryText, new RegExp(`^CATEGORY: ${category.categoryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    assert.equal((categoryM3u.match(/^#EXTINF:/gm) || []).length, category.totalStreamLinks);
  }
  const historyLines = fs.readFileSync(paths.history, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  assert.ok(historyLines.length >= 1);
  assert.ok(historyLines.every((line) => JSON.parse(line).timestamp));
}

async function testParallelWorkers() {
  const defaultSource = await scanner.getRootUrl(scanner.parseArgs([]));
  assert.equal(defaultSource.rootUrl, 'https://redflix.co/');
  let active = 0;
  let maximumActive = 0;
  const handled = [];
  await scanner.runWorkerPool([1, 2, 3, 4, 5, 6], 3, async (item, _index, workerId) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    handled.push({ item, workerId });
    active -= 1;
  });
  assert.equal(maximumActive, 3);
  assert.deepEqual(handled.map((entry) => entry.item).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  console.log('PASS: one command, one rotated category batch, 2 title workers, 5 server workers, cumulative JSON/TXT/M3U');
}

testParallelWorkers().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
