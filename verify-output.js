'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { verifyDataTree, CANONICAL_SERVERS, QUALITY_ORDER } = require('./lib');

const DATA_ROOT = path.resolve('data');
const CHECKPOINT = path.resolve('output', 'state', 'scan-checkpoint.json');

function fail(message) { throw new Error(message); }

function publishedDocuments(root = DATA_ROOT) {
  const documents = [];
  if (!fs.existsSync(root)) return documents;
  for (const category of fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    for (const [type, file] of [['movies', 'movies.json'], ['series', 'series.json']]) {
      const target = path.join(root, category.name, type, file);
      if (fs.existsSync(target)) documents.push({ category: category.name, type, target,
        document: JSON.parse(fs.readFileSync(target, 'utf8')) });
    }
  }
  return documents;
}

function outputStats(documents) {
  const stats = {
    outputMovies: 0, outputSeries: 0, outputSeasons: 0, outputEpisodes: 0,
    perServer: Object.fromEntries(CANONICAL_SERVERS.map((server) => [server, 0])),
    perQuality: Object.fromEntries(QUALITY_ORDER.map((quality) => [quality, 0])),
    urls: [],
  };
  const countServers = (servers) => {
    for (const server of servers || []) {
      for (const quality of server.qualities || []) {
        stats.perServer[server.name] += 1;
        stats.perQuality[quality.quality] += 1;
        stats.urls.push(quality.url);
      }
    }
  };
  for (const { type, document } of documents) {
    if (type === 'movies') {
      stats.outputMovies += document.movies.length;
      document.movies.forEach((movie) => countServers(movie.servers));
    } else {
      stats.outputSeries += document.series.length;
      for (const series of document.series) {
        stats.outputSeasons += series.seasons.length;
        for (const season of series.seasons) {
          stats.outputEpisodes += season.episodes.length;
          season.episodes.forEach((episode) => countServers(episode.servers));
        }
      }
    }
  }
  stats.uniqueUrls = new Set(stats.urls).size;
  stats.streams = stats.urls.length;
  delete stats.urls;
  return stats;
}

function seriesCompletenessErrors(documents) {
  const errors = [];
  for (const { category, type, document } of documents) {
    if (type !== 'series') continue;
    for (const series of document.series) {
      const seasons = series.seasons || [];
      const episodes = seasons.reduce((total, season) => total + (season.episodes || []).length, 0);
      if (series.totalSeasons !== seasons.length) {
        errors.push(`${category}/${series.id}: ${seasons.length}/${series.totalSeasons} aired seasons present`);
      }
      if (series.totalEpisodes !== episodes) {
        errors.push(`${category}/${series.id}: ${episodes}/${series.totalEpisodes} aired episodes present`);
      }
      for (const season of seasons) {
        if (season.totalEpisodes !== (season.episodes || []).length) {
          errors.push(`${category}/${series.id}/season-${season.seasonNumber}: ` +
            `${(season.episodes || []).length}/${season.totalEpisodes} aired episodes present`);
        }
      }
    }
  }
  return errors;
}

async function probe(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { range: 'bytes=0-65535', accept: '*/*' },
        signal: AbortSignal.timeout(10000), redirect: 'follow',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      const reader = response.body?.getReader();
      let body = Buffer.alloc(0);
      while (reader && body.length < 128 * 1024) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) body = Buffer.concat([body, Buffer.from(value)]);
      }
      await reader?.cancel().catch(() => {});
      const prefix = body.toString('utf8');
      if (!prefix.includes('#EXTM3U') && !/<MPD\b/i.test(prefix) && !/^video\//i.test(contentType)) {
        throw new Error(`not a playable manifest/video (${contentType || 'unknown type'})`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  fail(`Direct URL failed after 3 attempts (${lastError?.message || 'unknown error'}): ${url}`);
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }));
}

async function main({ live = true } = {}) {
  const report = verifyDataTree(DATA_ROOT);
  if (report.errors.length > 0) fail(report.errors.join('\n'));
  const documents = publishedDocuments();
  const stats = outputStats(documents);
  const completenessErrors = seriesCompletenessErrors(documents);
  if (completenessErrors.length > 0) fail(completenessErrors.join('\n'));
  const checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));
  const selectedCategory = checkpoint.scheduler?.lastCategory;
  const latest = checkpoint.scheduler?.lastBatchByCategory?.[selectedCategory] || {};
  const successful = new Set(latest.successfulItemUrls || []);
  const latestResults = (checkpoint.results || []).filter((item) => successful.has(item.url));
  if (successful.size !== latestResults.length) {
    fail(`Latest successful item count mismatch: expected ${successful.size}, found ${latestResults.length}`);
  }
  for (const item of latestResults) {
    const attempts = new Set((item.scan?.diagnostics?.serverAttempts || []).map((entry) => entry.server));
    const missing = CANONICAL_SERVERS.filter((server) => !attempts.has(server));
    if (missing.length > 0) fail(`${item.title}: servers not attempted: ${missing.join(', ')}`);
  }
  const latestUrls = [...new Set(latestResults.flatMap((item) => (item.scan?.finalStreams || [])
    .filter((stream) => stream.probe?.ok && stream.probe?.directPlaybackNoHeaders)
    .map((stream) => stream.url)))];
  if (live) await runPool(latestUrls, 24, async (url, index) => {
    await probe(url);
    process.stdout.write(`[LIVE ${index + 1}/${latestUrls.length}] OK\n`);
  });
  const result = {
    categories: report.categories,
    discoveredMovies: checkpoint.summary?.discoveredMovies || 0,
    processedMovies: checkpoint.summary?.processedMovies || 0,
    outputMovies: stats.outputMovies,
    discoveredSeries: checkpoint.summary?.discoveredSeries || 0,
    processedSeries: checkpoint.summary?.processedSeries || 0,
    outputSeries: stats.outputSeries,
    discoveredSeasons: new Set((checkpoint.catalog || [])
      .filter((item) => item.seriesId && Number.isInteger(item.seasonNumber))
      .map((item) => `${item.seriesId}:${item.seasonNumber}`)).size,
    processedSeasons: new Set((checkpoint.results || [])
      .filter((item) => !item.excludedFromOutputs && item.seriesId && Number.isInteger(item.seasonNumber))
      .map((item) => `${item.seriesId}:${item.seasonNumber}`)).size,
    discoveredEpisodes: checkpoint.summary?.discoveredEpisodes || 0,
    processedEpisodes: checkpoint.summary?.processedEpisodes || 0,
    outputSeasons: stats.outputSeasons,
    outputEpisodes: stats.outputEpisodes,
    latestBatchItems: (latest.itemUrls || []).length,
    latestBatchSuccessful: successful.size,
    latestBatchFailed: Math.max(0, (latest.itemUrls || []).length - successful.size),
    streams: stats.streams, uniqueUrls: stats.uniqueUrls,
    perServer: stats.perServer, perQuality: stats.perQuality,
    liveVerified: live ? latestUrls.length : 0,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error(`[OUTPUT VERIFICATION FAILED] ${error.message}`);
  process.exitCode = 1;
});

module.exports = { publishedDocuments, outputStats, seriesCompletenessErrors, probe, main };
