'use strict';

const fs = require('fs');
const path = require('path');

const OUTPUT_ROOT = path.resolve('output');
const CATEGORY_ROOT = path.join(OUTPUT_ROOT, 'categories');
const REQUIRED_PURPOSE = 'Strictly for educational purposes only and not for commercial use';
const REQUIRED_SERVERS = ['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast'];
const FORBIDDEN_OUTPUT_KEYS = new Set(['kind', 'headers', 'tmdbScore', 'score']);

function fail(message) {
  throw new Error(message);
}

function walkKeys(value, location = 'root') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkKeys(item, `${location}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_OUTPUT_KEYS.has(key)) fail(`Forbidden key ${key} at ${location}`);
    if (key === 'type' && String(nested).toLowerCase() === 'hls') fail(`Forbidden HLS type at ${location}`);
    walkKeys(nested, `${location}.${key}`);
  }
}

function categoryFiles() {
  if (!fs.existsSync(CATEGORY_ROOT)) fail('output/categories does not exist');
  return fs.readdirSync(CATEGORY_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      folder: entry.name,
      json: path.join(CATEGORY_ROOT, entry.name, 'category.json'),
      txt: path.join(CATEGORY_ROOT, entry.name, 'streams.txt'),
      m3u: path.join(CATEGORY_ROOT, entry.name, 'playlist.m3u'),
    }))
    .filter((entry) => fs.existsSync(entry.json));
}

function flattenLinks(movies) {
  return movies.flatMap((movie) => (movie.servers || []).flatMap((server) =>
    (server.links || []).map((link) => ({ movie, server: server.server, ...link }))));
}

function flattenSeriesEpisodes(series) {
  return series.flatMap((item) => (item.seasons || []).flatMap((season) => season.episodes || []));
}

function verifyCategory(entry) {
  const data = JSON.parse(fs.readFileSync(entry.json, 'utf8'));
  const metadata = data.metadata || {};
  const movies = Array.isArray(data.movies) ? data.movies : [];
  const series = Array.isArray(data.series) ? data.series : [];
  const episodes = flattenSeriesEpisodes(series);
  const records = [...movies, ...episodes];
  const links = flattenLinks(records);
  const successful = records.filter((record) => record.success && flattenLinks([record]).length > 0);
  const uniqueUrls = new Set(links.map((link) => link.url));

  if (!fs.existsSync(entry.txt) || !fs.existsSync(entry.m3u)) fail(`${entry.folder}: TXT/M3U missing`);
  if (!metadata.category) fail(`${entry.folder}: category missing`);
  if (metadata.purpose !== REQUIRED_PURPOSE) fail(`${entry.folder}: purpose mismatch`);
  if (metadata.totalMovies !== movies.length) fail(`${entry.folder}: totalMovies mismatch`);
  const playableMovies = successful.filter((movie) => movie.contentType === 'movie').length;
  const newlyAddedMovies = Number(metadata.successfulNewAdded || 0);
  if (!Number.isInteger(newlyAddedMovies) || newlyAddedMovies < 0 || newlyAddedMovies > playableMovies) {
    fail(`${entry.folder}: successful new-added movie count is impossible`);
  }
  if (metadata.streamLinks !== links.length) fail(`${entry.folder}: streamLinks mismatch`);
  if (metadata.uniqueStreamUrls !== uniqueUrls.size) fail(`${entry.folder}: uniqueStreamUrls mismatch`);

  successful.forEach((record, index) => {
    const expected = record.contentType === 'episode' ? 'Episode-' : record.contentType === 'series' ? 'Series-' : 'Movie-';
    if (!String(record.serial || '').startsWith(expected)) fail(`${entry.folder}: invalid serial for ${record.title}`);
    if (!record.title || !record.year) fail(`${entry.folder}: title/year missing for successful item ${index + 1}`);
    if (!/^https?:\/\//.test(record.poster || '')) fail(`${entry.folder}: poster missing for successful item ${index + 1}`);
  });

  for (const link of links) {
    if (!['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast'].includes(link.server)) {
      fail(`${entry.folder}: unsupported server ${link.server}`);
    }
    const match = /^(\d+)x(\d+)$/.exec(String(link.resolution || ''));
    if (!match || (Number(match[1]) < 1920 && Number(match[2]) < 1080)) {
      fail(`${entry.folder}: resolution below 1080-class: ${link.resolution}`);
    }
    if (!/^https?:\/\//.test(link.url || '')) fail(`${entry.folder}: invalid direct URL`);
  }

  walkKeys(data, entry.folder);

  const txt = fs.readFileSync(entry.txt, 'utf8');
  const m3u = fs.readFileSync(entry.m3u, 'utf8');
  for (const token of [
    `CATEGORY: ${metadata.category}`,
    `TOTAL MOVIES: ${metadata.totalMovies}`,
    `SUCCESSFUL NEW ADDED: ${metadata.successfulNewAdded}`,
    `STREAM_LINKS: ${metadata.streamLinks}`,
    `UNIQUE_STREAM_URLS: ${metadata.uniqueStreamUrls}`,
    `PURPOSE: ${REQUIRED_PURPOSE}`,
  ]) {
    if (!txt.includes(token)) fail(`${entry.folder}: TXT header missing ${token}`);
    if (!m3u.includes(token)) fail(`${entry.folder}: M3U header missing ${token}`);
  }
  if (/Type:\s*hls|Headers:|TMDB\s*Score/i.test(`${txt}\n${m3u}`)) fail(`${entry.folder}: forbidden display field`);

  return { entry, metadata, movies, series, episodes, records, links };
}

async function probe(url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.text();
      if (!body.includes('#EXTM3U') && !/<MPD\b/i.test(body)) {
        throw new Error('response is not an HLS or DASH manifest');
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        process.stdout.write(`[LIVE RETRY ${attempt}/3] ${url}\n`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }
  fail(`Direct URL failed after 3 attempts (${lastError?.message || 'unknown error'}): ${url}`);
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const verified = categoryFiles().map(verifyCategory);

  const checkpointPath = path.join(OUTPUT_ROOT, 'state', 'scan-checkpoint.json');
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const selectedCategory = checkpoint.scheduler?.lastCategory;
  const selected = verified.find((item) => item.metadata.category === selectedCategory);
  if (!selected) fail(`Selected category output is missing: ${selectedCategory || 'unknown'}`);

  const latestBatch = checkpoint.scheduler?.lastBatchByCategory?.[selectedCategory] || {};
  const successfulItemUrls = new Set(latestBatch.successfulItemUrls || []);
  const latestRecords = selected.records.filter((record) => successfulItemUrls.has(record.sourceUrl));
  if (successfulItemUrls.size && latestRecords.length !== successfulItemUrls.size) {
    fail(`Latest successful item count mismatch: expected ${successfulItemUrls.size}, found ${latestRecords.length}`);
  }
  for (const sourceUrl of successfulItemUrls) {
    const result = (checkpoint.results || []).find((item) => item.url === sourceUrl);
    const attempts = new Set((result?.scan?.diagnostics?.serverAttempts || []).map((item) => item.server));
    const missing = REQUIRED_SERVERS.filter((server) => !attempts.has(server));
    if (missing.length) fail(`${result?.title || sourceUrl}: servers not attempted: ${missing.join(', ')}`);
  }
  const uniqueSelectedUrls = [...new Set(flattenLinks(latestRecords).map((link) => link.url))];
  await runPool(uniqueSelectedUrls, 8, async (url, index) => {
    await probe(url);
    process.stdout.write(`[LIVE ${index + 1}/${uniqueSelectedUrls.length}] OK\n`);
  });

  console.log(JSON.stringify({
    category: selected.metadata.category,
    totalMovies: selected.metadata.totalMovies,
    successfulNewAdded: selected.metadata.successfulNewAdded,
    streams: selected.links.length,
    uniqueUrls: uniqueSelectedUrls.length,
    liveNoHeaderHlsVerified: uniqueSelectedUrls.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(`[OUTPUT VERIFICATION FAILED] ${error.message}`);
  process.exitCode = 1;
});
