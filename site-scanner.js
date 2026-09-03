const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const OUTPUT_JSON = 'catalog-stream-results.json';
const DEFAULT_SOURCE_URL = 'https://redflix.co/';
const PREFERRED_SERVERS = ['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast'];
const STREAM_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const EDUCATIONAL_PURPOSE = 'Strictly for educational purposes only and not for commercial use';

function parseArgs(argv) {
  const options = {
    maxTitles: 20,
    titleTimeout: 90,
    maxSurfaces: 30,
    retries: 2,
    workers: 2,
    serverWorkers: 5,
    discoverOnly: false,
    fresh: false,
    retryFailed: false,
    refreshCatalog: false,
    refreshCategoryList: false,
    category: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--discover-only') options.discoverOnly = true;
    else if (arg === '--fresh') options.fresh = true;
    else if (arg === '--retry-failed') options.retryFailed = true;
    else if (arg === '--refresh-catalog') options.refreshCatalog = true;
    else if (arg === '--refresh-category-list') options.refreshCategoryList = true;
    else if (arg.startsWith('--')) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      if (arg === '--url') options.url = value;
      else if (arg === '--max-titles') options.maxTitles = Number(value);
      else if (arg === '--title-timeout') options.titleTimeout = Number(value);
      else if (arg === '--max-surfaces') options.maxSurfaces = Number(value);
      else if (arg === '--retries') options.retries = Number(value);
      else if (arg === '--workers') options.workers = Number(value);
      else if (arg === '--server-workers') options.serverWorkers = Number(value);
      else if (arg === '--category') options.category = value;
      else throw new Error(`Unknown option: ${arg}`);
      index += 1;
    } else if (!options.url) options.url = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.maxTitles) && options.maxTitles !== Infinity) {
    throw new Error('--max-titles must be a number');
  }
  if (!Number.isFinite(options.titleTimeout) || options.titleTimeout < 20) {
    throw new Error('--title-timeout must be at least 20 seconds');
  }
  if (!Number.isFinite(options.maxSurfaces) || options.maxSurfaces < 1) {
    throw new Error('--max-surfaces must be at least 1');
  }
  if (!Number.isFinite(options.retries) || options.retries < 1) {
    throw new Error('--retries must be at least 1');
  }
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 5) {
    throw new Error('--workers must be an integer from 1 to 5');
  }
  if (!Number.isInteger(options.serverWorkers) || options.serverWorkers < 1 || options.serverWorkers > 5) {
    throw new Error('--server-workers must be an integer from 1 to 5');
  }
  return options;
}

async function getRootUrl(options) {
  options.url = options.url || DEFAULT_SOURCE_URL;
  const parsed = new URL(options.url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP/HTTPS URLs are supported');
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  options.rootUrl = parsed.href;
  options.origin = parsed.origin;
  return options;
}

async function scrollWholePage(page) {
  let stableRounds = 0;
  let lastHeight = 0;
  for (let round = 0; round < 16 && stableRounds < 3; round += 1) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (height === lastHeight) stableRounds += 1;
    else stableRounds = 0;
    lastHeight = height;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

function normalizeSurfaceUrl(href, origin) {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin) return null;
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    if (pathname === '/') return `${origin}/`;
    if (['/movies', '/tv-shows', '/anime', '/browse'].includes(pathname)) {
      return `${origin}${pathname}`;
    }
    if (pathname === '/asian-dramas') {
      const region = ['KR', 'CN', 'JP'].includes(url.searchParams.get('region'))
        ? url.searchParams.get('region')
        : 'KR';
      return `${origin}/asian-dramas?region=${region}&sort=popular`;
    }
    if (/^\/platforms\/\d+\/(?:movie|tv)$/i.test(pathname)) {
      return `${origin}${pathname}`;
    }
  } catch (_) {}
  return null;
}

function surfaceName(urlString) {
  const url = new URL(urlString);
  if (url.pathname === '/') return 'Home';
  if (url.pathname === '/asian-dramas') return `Asian Dramas ${url.searchParams.get('region') || 'KR'}`;
  if (url.pathname.startsWith('/platforms/')) return `Platform ${url.pathname.split('/').slice(2).join(' ')}`;
  return url.pathname.slice(1).replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

async function discoverSite(rootUrl, origin, maxSurfaces, requestedSeedUrls = null) {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--no-sandbox', '--start-maximized'],
  });
  try {
    const [page] = await browser.pages();
    const seedUrls = requestedSeedUrls || [
      rootUrl,
      `${origin}/movies`,
      `${origin}/tv-shows`,
      `${origin}/anime`,
      `${origin}/asian-dramas?region=KR&sort=popular`,
      `${origin}/asian-dramas?region=CN&sort=popular`,
      `${origin}/asian-dramas?region=JP&sort=popular`,
      `${origin}/browse`,
    ];
    const queue = [...new Set(seedUrls)];
    const visited = new Set();
    const uniqueTitles = new Map();
    const headings = new Set();
    const surfaces = [];

    while (queue.length > 0 && visited.size < maxSurfaces) {
      const surfaceUrl = queue.shift();
      if (visited.has(surfaceUrl)) continue;
      visited.add(surfaceUrl);
      const name = surfaceName(surfaceUrl);
      console.log(`[SURFACE ${visited.size}] ${name}: ${surfaceUrl}`);

      let loaded = false;
      let error = null;
      for (let attempt = 1; attempt <= 3 && !loaded; attempt += 1) {
        try {
          const response = await page.goto(surfaceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          if (response && [403, 429].includes(response.status())) throw new Error(`HTTP ${response.status()}`);
          await page.waitForFunction(
            () => document.querySelectorAll('a[href*="/play"],a[href*="/movie/"],a[href*="/tv/"]').length > 0,
            { timeout: 20000 }
          ).catch(() => null);
          await scrollWholePage(page);
          loaded = true;
        } catch (attemptError) {
          error = attemptError.message;
          if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
        }
      }
      if (!loaded) {
        surfaces.push({ name, url: surfaceUrl, loaded: false, error, titleCount: 0 });
        continue;
      }

      const data = await page.evaluate(() => {
        const titlePattern = /\/(?:play2?\?|(?:movie|tv)\/[^/?#]*\d+\/watch)/i;
        const ignoredHeadings = /^(watch free|studios?\s*&|did you know|redflix$)/i;
        const items = [];
        let category = 'Featured';
        for (const element of document.querySelectorAll('h1,h2,h3,a[href]')) {
          if (/^H[1-3]$/.test(element.tagName)) {
            const heading = element.innerText?.trim().replace(/\s+/g, ' ');
            if (heading && !ignoredHeadings.test(heading)) category = heading;
            continue;
          }
          if (!titlePattern.test(element.href)) continue;
          const rawText = element.innerText?.trim().replace(/\s+/g, ' ') || '';
          const imageTitle = element.querySelector('img[alt]')?.alt?.trim() || '';
          const isHero = /watch now/i.test(rawText);
          items.push({
            url: element.href,
            title: isHero ? category : (imageTitle || rawText || 'Untitled'),
            localCategory: isHero ? 'Hero' : category,
          });
        }
        return {
          pageTitle: document.title,
          headings: [...new Set([...document.querySelectorAll('h1,h2,h3')]
            .map((heading) => heading.innerText?.trim().replace(/\s+/g, ' ')).filter(Boolean))],
          items,
          links: [...document.querySelectorAll('a[href]')].map((anchor) => anchor.href),
        };
      });

      data.headings.forEach((heading) => headings.add(`${name}: ${heading}`));
      for (const item of data.items) {
        const category = `${name}: ${item.localCategory}`;
        const existing = uniqueTitles.get(item.url);
        if (!existing) uniqueTitles.set(item.url, { url: item.url, title: item.title, categories: [category] });
        else if (!existing.categories.includes(category)) existing.categories.push(category);
      }
      for (const href of data.links) {
        const normalized = normalizeSurfaceUrl(href, origin);
        if (normalized && !visited.has(normalized) && !queue.includes(normalized)) queue.push(normalized);
      }
      surfaces.push({ name, url: surfaceUrl, loaded: true, error: null, titleCount: data.items.length });
    }

    return { headings: [...headings], titles: [...uniqueTitles.values()], surfaces };
  } finally {
    await browser.close();
  }
}

function runTitleScanner(title, options, resultPath) {
  return new Promise((resolve) => {
    const args = [
      path.join(__dirname, 'collector.js'),
      '--url', title.url,
      '--timeout', String(options.titleTimeout),
      '--output', resultPath,
      '--server-workers', String(options.serverWorkers),
    ];
    const child = spawn(process.execPath, args, { cwd: __dirname, stdio: 'inherit' });
    let settled = false;
    let forcedResult = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(forcedResult || result);
    };
    const hardTimeoutMs = (options.titleTimeout * 1000) + 30000;
    const timer = setTimeout(() => {
      forcedResult = { exitCode: -1, error: `hard timeout after ${Math.round(hardTimeoutMs / 1000)} seconds` };
      console.log(`[HARD TIMEOUT] ${title.title}; terminating collector process tree.`);
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        });
        killer.on('error', () => child.kill('SIGKILL'));
      } else {
        child.kill('SIGKILL');
      }
      setTimeout(() => finish(forcedResult), 5000);
    }, hardTimeoutMs);
    child.on('error', (error) => finish({ exitCode: -1, error: error.message }));
    child.on('exit', (exitCode) => finish({ exitCode }));
  });
}

async function scanTitleWithRetries(title, options, resultPath, position, total) {
  if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
  let processResult = null;
  let scan = null;
  for (let attempt = 1; attempt <= options.retries; attempt += 1) {
    console.log(`[WORK ITEM ${position}/${total}] ${title.title} - attempt ${attempt}/${options.retries}`);
    processResult = await runTitleScanner(title, options, resultPath);
    if (fs.existsSync(resultPath)) {
      try { scan = sanitizeScan(JSON.parse(fs.readFileSync(resultPath, 'utf8'))); } catch (_) { scan = null; }
    }
    if (scan?.success) break;
    if (attempt < options.retries) await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
  if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
  return { processResult: processResult || { exitCode: -1, error: 'Scanner did not start' }, scan };
}

async function runWorkerPool(items, workerCount, handler) {
  let cursor = 0;
  async function worker(workerId) {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await handler(items[index], index, workerId);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(workerCount, Math.max(1, items.length)) },
    (_, index) => worker(index + 1)
  ));
}

function inferQuality(url, kind) {
  let decodedUrl = url || '';
  try { decodedUrl = decodeURIComponent(decodedUrl); } catch (_) {}
  const height = decodedUrl.match(/(?:^|[/_.=-])(2160|1440|1080|720|576|540|480|360|240)(?:p|[/_.?&=-]|$)/i)?.[1];
  if (height) return `${height}p`;
  if (kind === 'hls') return 'adaptive/single playlist';
  if (kind === 'dash') return 'adaptive DASH';
  return 'direct video (source quality)';
}

function is1080ClassResolution(value) {
  const dimensions = String(value || '').match(/^(\d+)x(\d+)$/i);
  if (dimensions) return Number(dimensions[1]) >= 1920 || Number(dimensions[2]) >= 1080;
  const progressive = String(value || '').match(/^(\d+)p$/i);
  return Boolean(progressive && Number(progressive[1]) >= 1080);
}

function isFreshScan(scan) {
  const finishedAt = Date.parse(scan?.finishedAt || '');
  return Number.isFinite(finishedAt) && Date.now() - finishedAt <= STREAM_MAX_AGE_MS;
}

function isPublishableStream(stream) {
  return Boolean(
    PREFERRED_SERVERS.some((server) => server.toLowerCase() === String(stream.server || '').toLowerCase()) &&
    stream.probe?.ok &&
    stream.probe?.directPlaybackNoHeaders &&
    is1080ClassResolution(stream.probe?.resolution) &&
    !isMediaFragment(stream.url)
  );
}

function isPublishableScan(scan) {
  return Boolean((scan?.finalStreams || []).some(isPublishableStream));
}

function resolveCategorySelection(scheduler, selector = null) {
  const order = scheduler?.categoryOrder || [];
  if (order.length === 0) return null;
  if (!selector) return order[scheduler.nextCategoryIndex % order.length];
  const wanted = String(selector).trim();
  if (/^\d+$/.test(wanted)) {
    const index = Number(wanted) - 1;
    if (order[index]) return order[index];
  }
  const match = order.find((category) => {
    const descriptor = categoryDescriptor(category);
    return [category, descriptor.name, descriptor.categoryId, descriptor.folder]
      .some((value) => String(value).toLowerCase() === wanted.toLowerCase());
  });
  if (!match) throw new Error(`Unknown category: ${selector}. Available: ${order.join(' | ')}`);
  return match;
}

function surfaceUrlForCategory(category, surfaces, rootUrl, origin) {
  const surface = String(category || '').split(':', 1)[0].trim();
  const saved = (surfaces || []).find((entry) => entry.name === surface && entry.url);
  if (saved) return saved.url;
  const known = {
    Home: rootUrl,
    Movies: `${origin}/movies`,
    'Tv Shows': `${origin}/tv-shows`,
    Anime: `${origin}/anime`,
    Browse: `${origin}/browse`,
    'Asian Dramas KR': `${origin}/asian-dramas?region=KR&sort=popular`,
    'Asian Dramas CN': `${origin}/asian-dramas?region=CN&sort=popular`,
    'Asian Dramas JP': `${origin}/asian-dramas?region=JP&sort=popular`,
  };
  if (known[surface]) return known[surface];
  if (/^Platform \d+ (movie|tv)$/i.test(surface)) {
    const [, id, type] = surface.match(/^Platform (\d+) (movie|tv)$/i);
    return `${origin}/platforms/${id}/${type.toLowerCase()}`;
  }
  throw new Error(`No source surface URL is known for category ${category}`);
}

function mergeRefreshedCategory(savedCatalog, refreshedItems, category) {
  if (!refreshedItems.length) throw new Error(`Selected category returned zero items: ${category}`);
  const savedByUrl = new Map((savedCatalog || []).map((item) => [item.url, item]));
  const merged = [];
  const seen = new Set();
  for (const item of refreshedItems) {
    const previous = savedByUrl.get(item.url);
    const categories = [...new Set([...(previous?.categories || []), ...(item.categories || []), category])];
    merged.push({ ...previous, ...item, categories });
    seen.add(item.url);
  }
  for (const item of savedCatalog || []) {
    if (!seen.has(item.url)) merged.push(item);
  }
  return merged;
}

function restoreExpandedEpisodes(baseCatalog, previous) {
  if (!previous) return baseCatalog;
  const cachedMetadata = new Map((previous.seriesMetadata || [])
    .filter((item) => item.status === 'expanded')
    .map((item) => [item.seriesId, item]));
  const cachedEpisodes = new Map();
  for (const item of previous.catalog || []) {
    if (!isEpisodeItem(item)) continue;
    if (!cachedEpisodes.has(item.seriesId)) cachedEpisodes.set(item.seriesId, []);
    cachedEpisodes.get(item.seriesId).push(item);
  }
  const restored = [];
  for (const item of baseCatalog) {
    if (!isUnscopedSeriesItem(item)) {
      restored.push(item);
      continue;
    }
    const identity = urlContentIdentity(item.url);
    const seriesId = `tv:${identity.id}`;
    const episodes = cachedMetadata.has(seriesId) ? (cachedEpisodes.get(seriesId) || []) : [];
    if (episodes.length > 0) restored.push(...episodes.map((episode) => ({
      ...episode,
      categories: [...new Set([...(episode.categories || []), ...(item.categories || [])])],
    })));
    else restored.push(item);
  }
  return restored;
}

function isReusableScan(scan) {
  return Boolean(isFreshScan(scan) && isPublishableScan(scan));
}

function pruneExpiredProcessedItems(payload) {
  const resultsByUrl = new Map((payload.results || []).map((item) => [item.url, item]));
  for (const category of payload.scheduler?.categoryOrder || []) {
    payload.scheduler.processedByCategory[category] = (
      payload.scheduler.processedByCategory[category] || []
    ).filter((url) => {
      const result = resultsByUrl.get(url);
      const hadCompliantStream = (result?.scan?.finalStreams || []).some(isPublishableStream);
      return !(hadCompliantStream && !isFreshScan(result.scan));
    });
  }
}

function isMediaFragment(url) {
  let decodedUrl = url || '';
  try { decodedUrl = decodeURIComponent(decodedUrl); } catch (_) {}
  return /(?:\.ts|\.m4s|\.cmfv|\.cmfa|\.aac)(?:$|[?#])/i.test(decodedUrl) ||
    /(?:^|[/?&])(segment|chunk)[-_=/]?\d/i.test(decodedUrl) ||
    /(?:^|[/=&])(page|segment|chunk)[-_]?\d+\.html(?:$|[?&#])/i.test(decodedUrl);
}

function sanitizeScan(scan) {
  if (!scan || !Array.isArray(scan.finalStreams)) return scan;
  scan.finalStreams = scan.finalStreams.filter((stream) => !isMediaFragment(stream.url));
  scan.success = isPublishableScan(scan);
  return scan;
}

function mergeScanResults(previousScan, attemptedScan) {
  const prior = sanitizeScan(previousScan ? { ...previousScan, finalStreams: [...(previousScan.finalStreams || [])] } : null);
  const attempted = sanitizeScan(attemptedScan ? { ...attemptedScan, finalStreams: [...(attemptedScan.finalStreams || [])] } : null);
  if (!prior) return attempted;
  if (!attempted) return { ...prior, lastAttemptAt: new Date().toISOString(), lastAttemptSucceeded: false };
  const mergedStreams = [];
  const seen = new Set();
  for (const stream of [...(attempted.finalStreams || []), ...(prior.finalStreams || [])]) {
    if (!isPublishableStream(stream)) continue;
    const key = [String(stream.server || '').toLowerCase(), stream.probe?.resolution, stream.url].join('\n');
    if (seen.has(key)) continue;
    seen.add(key);
    mergedStreams.push(stream);
  }
  return sanitizeScan({
    ...prior,
    ...attempted,
    finalStreams: mergedStreams,
    finishedAt: attempted.success ? attempted.finishedAt : prior.finishedAt,
    lastAttemptAt: attempted.finishedAt || new Date().toISOString(),
    lastAttemptSucceeded: Boolean(attempted.success),
  });
}

function outputRows(payload) {
  const rows = [];
  const seen = new Set();
  for (const item of payload.results) {
    if (item.excludedFromOutputs) continue;
    const streams = [...(item.scan?.finalStreams || [])].sort((left, right) =>
      PREFERRED_SERVERS.findIndex((server) => server.toLowerCase() === String(left.server || '').toLowerCase()) -
      PREFERRED_SERVERS.findIndex((server) => server.toLowerCase() === String(right.server || '').toLowerCase())
    );
    for (const stream of streams) {
      if (!isPublishableStream(stream)) continue;
      const source = { url: stream.url, quality: stream.probe.resolution };
      for (const category of item.categories || ['Uncategorized']) {
        const row = {
          category, title: item.title, pageUrl: item.url,
          year: item.year || (item.airDate ? Number(String(item.airDate).slice(0, 4)) : null),
          canonicalId: canonicalMovieId(item),
          contentType: isEpisodeItem(item) ? 'episode' : 'movie',
          seriesId: item.seriesId || null,
          seriesTitle: item.seriesTitle || null,
          seasonNumber: item.seasonNumber ?? null,
          episodeNumber: item.episodeNumber ?? null,
          episodeTitle: item.episodeTitle || null,
          airDate: item.airDate || null,
          server: stream.server || 'unknown', kind: stream.kind,
          quality: source.quality, url: source.url,
          headers: {},
        };
        const key = [row.category, row.pageUrl, row.server, row.quality, row.url].join('\n');
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
      }
    }
  }
  return rows;
}

function contentCounts(rows) {
  return {
    playableItems: new Set(rows.map((row) => row.canonicalId)).size,
    movies: new Set(rows.filter((row) => row.contentType !== 'episode').map((row) => row.canonicalId)).size,
    series: new Set(rows.filter((row) => row.contentType === 'episode').map((row) => row.seriesId)).size,
    episodes: new Set(rows.filter((row) => row.contentType === 'episode').map((row) => row.canonicalId)).size,
  };
}

function successfulBatchCounts(payload, urls) {
  const wanted = new Set(urls || []);
  const items = (payload.results || []).filter(
    (item) => wanted.has(item.url) && isPublishableScan(item.scan) && item.scan?.lastAttemptSucceeded !== false
  );
  return {
    successfulNewMovies: new Set(items.filter((item) => !isEpisodeItem(item)).map(canonicalMovieId)).size,
    successfulNewSeries: new Set(items.filter(isEpisodeItem).map((item) => item.seriesId).filter(Boolean)).size,
    successfulNewEpisodes: new Set(items.filter(isEpisodeItem).map(canonicalMovieId)).size,
  };
}

function syncActiveBatchToQueue(scheduler, category, queue) {
  if (!scheduler || !category || !Array.isArray(queue)) return;
  const previous = scheduler.activeBatch;
  scheduler.activeBatch = {
    category,
    urls: queue.map((item) => item.url),
    startedAt: previous?.category === category && previous.startedAt
      ? previous.startedAt
      : new Date().toISOString(),
  };
}

function repairLatestBatchCounts(payload, historyPath) {
  if (!payload?.scheduler?.lastBatchByCategory || !fs.existsSync(historyPath)) return false;
  let events;
  try {
    events = fs.readFileSync(historyPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (_) {
    return false;
  }
  const completionIndex = events.findLastIndex((item) => item.event === 'category-batch-complete');
  if (completionIndex < 0) return false;
  const completion = events[completionIndex];
  const category = completion.selectedCategory || completion.category;
  if (!category || !payload.scheduler.lastBatchByCategory[category]) return false;
  let runStartIndex = -1;
  for (let index = completionIndex - 1; index >= 0; index -= 1) {
    if (events[index].event === 'run-start') {
      runStartIndex = index;
      break;
    }
  }
  const urls = events.slice(runStartIndex + 1, completionIndex)
    .filter((item) => ['title-scanned', 'title-failed', 'title-reused'].includes(item.event))
    .filter((item) => (item.selectedCategory || item.category) === category)
    .map((item) => item.url)
    .filter(Boolean);
  if (urls.length === 0) return false;
  const counts = successfulBatchCounts(payload, urls);
  const previous = payload.scheduler.lastBatchByCategory[category];
  const changed = previous.successfulNewMovies !== counts.successfulNewMovies ||
    previous.successfulNewSeries !== counts.successfulNewSeries ||
    previous.successfulNewEpisodes !== counts.successfulNewEpisodes;
  if (!changed) return false;
  payload.scheduler.lastBatchByCategory[category] = {
    category,
    ...counts,
    completedAt: previous.completedAt || completion.timestamp || new Date().toISOString(),
  };
  return true;
}

function groupStreamRowsByServer(rows) {
  const groups = new Map();
  for (const row of rows) {
    const server = row.server || 'unknown';
    if (!groups.has(server)) groups.set(server, []);
    const links = groups.get(server);
    if (!links.some((link) => link.resolution === row.quality && link.url === row.url)) {
      links.push({ resolution: row.quality, url: row.url });
    }
  }
  return [...groups.entries()].map(([server, links]) => ({ server, links }));
}

function catalogCounts(payload) {
  const catalog = payload.catalog || [];
  const results = (payload.results || []).filter((item) => !item.excludedFromOutputs);
  return {
    discoveredMovies: new Set(catalog.filter((item) => !isEpisodeItem(item)).map((item) => canonicalMovieId(item))).size,
    discoveredSeries: new Set((payload.seriesMetadata || []).map((item) => item.seriesId)).size,
    discoveredEpisodes: new Set(catalog.filter(isEpisodeItem).map((item) => canonicalMovieId(item))).size,
    processedMovies: new Set(results.filter((item) => !isEpisodeItem(item)).map((item) => canonicalMovieId(item))).size,
    processedSeries: new Set(results.filter(isEpisodeItem).map((item) => item.seriesId)).size,
    processedEpisodes: new Set(results.filter(isEpisodeItem).map((item) => canonicalMovieId(item))).size,
  };
}

function saveTextReport(payload, outputPath, metadata = null) {
  const rows = outputRows(payload);
  const counts = contentCounts(rows);
  const catalogStats = catalogCounts(payload);
  const lines = metadata ? [
    `CATEGORY: ${metadata.categoryName}`,
    `TOTAL MOVIES: ${metadata.totalMoviesAdded}`,
    `SUCCESSFUL NEW ADDED: ${metadata.successfulNewMovies || 0}`,
    `SUCCESSFUL NEW ADDED SERIES: ${metadata.successfulNewSeries || 0}`,
    `SUCCESSFUL NEW ADDED EPISODES: ${metadata.successfulNewEpisodes || 0}`,
    `STREAM_LINKS: ${rows.length}`,
    `UNIQUE_STREAM_URLS: ${new Set(rows.map((row) => row.url)).size}`,
    `LAST_UPDATED: ${metadata.lastUpdated}`,
    `PURPOSE: ${EDUCATIONAL_PURPOSE}`,
    '',
  ] : [
    'REDFLIX MASTER STREAM EXPORT',
    `TOTAL MOVIES DISCOVERED: ${catalogStats.discoveredMovies}`,
    `TOTAL SERIES DISCOVERED: ${catalogStats.discoveredSeries}`,
    `TOTAL EPISODES DISCOVERED: ${catalogStats.discoveredEpisodes}`,
    `TOTAL MOVIES PROCESSED: ${catalogStats.processedMovies}`,
    `TOTAL SERIES PROCESSED: ${catalogStats.processedSeries}`,
    `TOTAL EPISODES PROCESSED: ${catalogStats.processedEpisodes}`,
    `TOTAL MOVIES ADDED: ${counts.movies}`,
    `TOTAL SERIES ADDED: ${counts.series}`,
    `TOTAL EPISODES ADDED: ${counts.episodes}`,
    `TOTAL PLAYABLE ITEMS: ${counts.playableItems}`,
    `TOTAL CATEGORIES: ${new Set(rows.map((row) => row.category)).size}`,
    `TOTAL STREAM LINKS: ${rows.length}`,
    `TOTAL UNIQUE MEDIA URLS: ${new Set(rows.map((row) => row.url)).size}`,
    '',
  ];
  const itemGroups = new Map();
  for (const row of rows) {
    if (!itemGroups.has(row.pageUrl)) itemGroups.set(row.pageUrl, []);
    itemGroups.get(row.pageUrl).push(row);
  }
  let movieSerial = 0;
  let episodeSerial = 0;
  for (const itemRows of itemGroups.values()) {
    const first = itemRows[0];
    const isEpisode = first.contentType === 'episode';
    const serial = isEpisode ? `Episode-${++episodeSerial}` : `Movie-${++movieSerial}`;
    const identityLines = isEpisode ? [
      `Series: ${first.seriesTitle}`,
      `Season: ${first.seasonNumber}`,
      `Episode: ${first.episodeNumber}`,
      `Episode Title: ${first.episodeTitle}`,
      `Air Date: ${first.airDate}`,
    ] : [];
    lines.push(
      serial,
      `Title: ${first.title}`,
      `Year: ${first.year || 'Unknown'}`,
      `Category: ${categoryDescriptor(first.category).name}`,
      ...identityLines
    );
    groupStreamRowsByServer(itemRows).forEach((serverGroup, serverIndex) => {
      lines.push(`Server-${serverIndex + 1}: ${serverGroup.server}`);
      serverGroup.links.forEach((link, linkIndex) => lines.push(
        `Resolution-${linkIndex + 1}: ${link.resolution}`,
        `URL: ${link.url}`
      ));
    });
    lines.push('');
  }
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function m3uValue(value) {
  return String(value || '').replace(/["\r\n]/g, ' ').trim();
}

function saveM3uReport(payload, outputPath, metadata = null) {
  const rows = outputRows(payload);
  const counts = contentCounts(rows);
  const catalogStats = catalogCounts(payload);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.category)) grouped.set(row.category, []);
    grouped.get(row.category).push(row);
  }
  const lines = metadata ? [
    '#EXTM3U',
    `# CATEGORY: ${m3uValue(metadata.categoryName)}`,
    `# TOTAL MOVIES: ${metadata.totalMoviesAdded}`,
    `# SUCCESSFUL NEW ADDED: ${metadata.successfulNewMovies || 0}`,
    `# SUCCESSFUL NEW ADDED SERIES: ${metadata.successfulNewSeries || 0}`,
    `# SUCCESSFUL NEW ADDED EPISODES: ${metadata.successfulNewEpisodes || 0}`,
    `# STREAM_LINKS: ${rows.length}`,
    `# UNIQUE_STREAM_URLS: ${new Set(rows.map((row) => row.url)).size}`,
    `# LAST_UPDATED: ${metadata.lastUpdated}`,
    `# PURPOSE: ${EDUCATIONAL_PURPOSE}`,
  ] : [
    '#EXTM3U',
    `# TOTAL-MOVIES-DISCOVERED: ${catalogStats.discoveredMovies}`,
    `# TOTAL-SERIES-DISCOVERED: ${catalogStats.discoveredSeries}`,
    `# TOTAL-EPISODES-DISCOVERED: ${catalogStats.discoveredEpisodes}`,
    `# TOTAL-MOVIES-PROCESSED: ${catalogStats.processedMovies}`,
    `# TOTAL-SERIES-PROCESSED: ${catalogStats.processedSeries}`,
    `# TOTAL-EPISODES-PROCESSED: ${catalogStats.processedEpisodes}`,
    `# TOTAL-MOVIES-ADDED: ${counts.movies}`,
    `# TOTAL-SERIES-ADDED: ${counts.series}`,
    `# TOTAL-EPISODES-ADDED: ${counts.episodes}`,
    `# TOTAL-PLAYABLE-ITEMS: ${counts.playableItems}`,
    `# TOTAL-CATEGORIES: ${grouped.size}`,
    `# TOTAL-STREAM-LINKS: ${rows.length}`,
    `# TOTAL-UNIQUE-MEDIA-URLS: ${new Set(rows.map((row) => row.url)).size}`,
  ];
  const serialByPage = new Map();
  let movieSerial = 0;
  let episodeSerial = 0;
  for (const [category, categoryRows] of grouped) {
    if (!metadata) {
      lines.push(
        `# CATEGORY: ${m3uValue(category)}`,
        `# CATEGORY-TOTAL-MOVIES-ADDED: ${contentCounts(categoryRows).movies}`,
        `# CATEGORY-TOTAL-SERIES-ADDED: ${contentCounts(categoryRows).series}`,
        `# CATEGORY-TOTAL-EPISODES-ADDED: ${contentCounts(categoryRows).episodes}`,
        `# CATEGORY-TOTAL-STREAM-LINKS: ${categoryRows.length}`,
        `# CATEGORY-TOTAL-UNIQUE-MEDIA-URLS: ${new Set(categoryRows.map((row) => row.url)).size}`
      );
    }
    for (const row of categoryRows) {
      if (!serialByPage.has(row.pageUrl)) {
        serialByPage.set(row.pageUrl, row.contentType === 'episode'
          ? `Episode-${++episodeSerial}`
          : `Movie-${++movieSerial}`);
      }
      const year = row.year ? ` (${row.year})` : '';
      const label = `${serialByPage.get(row.pageUrl)} | ${row.title}${year} | ${row.server} | ${row.quality}`;
      const groupTitle = row.contentType === 'episode'
        ? `${row.category} | ${row.seriesTitle} | Season ${String(row.seasonNumber).padStart(2, '0')}`
        : row.category;
      lines.push(`#EXTINF:-1 group-title="${m3uValue(groupTitle)}" tvg-name="${m3uValue(label)}",${label}`);
      lines.push(row.url);
    }
  }
  fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function categoryOrder(catalog) {
  return [...new Set(catalog.flatMap((item) => item.categories || ['Uncategorized']))]
    .filter((category) => categoryDescriptor(category).type !== 'featured');
}

function slugify(value) {
  return String(value || 'uncategorized')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'uncategorized';
}

function categoryDescriptor(rawCategory) {
  const raw = String(rawCategory || 'Uncategorized').trim();
  const separator = raw.indexOf(':');
  const surface = separator >= 0 ? raw.slice(0, separator).trim() : '';
  const label = separator >= 0 ? raw.slice(separator + 1).trim() : raw;
  const lower = `${surface} ${label}`.toLowerCase();
  let type = 'collection';
  let name = label || raw;
  let folder = slugify(name);

  if (/\bhero\b/.test(lower)) {
    type = 'featured';
    name = surface ? `${surface} Hero` : 'Featured Hero';
    folder = `featured-${slugify(name)}`;
  } else if (/\b(top\s*10|popular|trending|latest|new releases?|featured)\b/.test(lower)) {
    type = 'editorial';
  } else if (/\b(action|adventure|horror|sci-fi|fantasy|animation|crime|drama|comedy|thriller|romance|mystery|documentary|family|music|war|western)\b/.test(label.toLowerCase())) {
    type = 'genre';
  } else if (/\b(tv shows?|movies?|anime|k-dramas?)\b/.test(label.toLowerCase())) {
    type = 'content-type';
  }

  if (/^asian dramas?\b/i.test(surface)) {
    type = 'region';
    const region = surface.match(/\b(KR|CN|JP)\b/i)?.[1]?.toUpperCase();
    if (region && !new RegExp(`\\b${region}\\b`, 'i').test(name)) name = `${region} ${name}`;
    folder = slugify(name);
  }
  if (/^platform\b/i.test(surface)) {
    type = 'platform';
    name = `${surface} ${label}`.trim();
    folder = slugify(name);
  }

  return { raw, name, type, folder, categoryId: `${type}:${folder}`, surface };
}

function categoryGroups(payload) {
  const rawCategories = [...new Set([
    ...categoryOrder(payload.catalog || []),
    ...(payload.results || []).flatMap((item) => item.categories || ['Uncategorized']),
  ])];
  const groups = new Map();
  for (const rawCategory of rawCategories) {
    const descriptor = categoryDescriptor(rawCategory);
    if (descriptor.type === 'featured') continue;
    const existing = groups.get(descriptor.categoryId) || { ...descriptor, rawCategories: [] };
    if (!existing.rawCategories.includes(rawCategory)) existing.rawCategories.push(rawCategory);
    groups.set(descriptor.categoryId, existing);
  }
  return [...groups.values()];
}

function canonicalMovieId(item) {
  try {
    const url = new URL(item.url);
    const id = url.searchParams.get('id') || url.pathname.match(/(\d+)(?=\/watch\/?$)/i)?.[1];
    const type = url.searchParams.get('type') || url.pathname.match(/^\/(movie|tv)\//i)?.[1] || 'movie';
    const season = url.searchParams.get('season');
    const episode = url.searchParams.get('episode');
    if (id && type === 'tv' && season !== null && episode !== null) {
      return `tv:${id}:s${String(season).padStart(2, '0')}:e${String(episode).padStart(2, '0')}`;
    }
    if (id) return `${type}:${id}`;
  } catch (_) {}
  return `url:${item.url}`;
}

function urlContentIdentity(urlString) {
  try {
    const url = new URL(urlString);
    const id = url.searchParams.get('id') || url.pathname.match(/(\d+)(?=\/watch\/?$)/i)?.[1];
    const type = url.searchParams.get('type') || url.pathname.match(/^\/(movie|tv)\//i)?.[1] || 'movie';
    const seasonValue = url.searchParams.get('season');
    const episodeValue = url.searchParams.get('episode');
    return {
      id,
      type,
      season: seasonValue !== null && /^\d+$/.test(seasonValue) ? Number(seasonValue) : null,
      episode: episodeValue !== null && /^\d+$/.test(episodeValue) ? Number(episodeValue) : null,
    };
  } catch (_) {
    return { id: null, type: 'unknown', season: null, episode: null };
  }
}

function isEpisodeItem(item) {
  const identity = urlContentIdentity(item.url);
  return identity.type === 'tv' && Number.isInteger(identity.season) && identity.episode > 0;
}

function isUnscopedSeriesItem(item) {
  const identity = urlContentIdentity(item.url);
  return identity.type === 'tv' && identity.season === null && identity.episode === null;
}

function normalizeTitleMetadata(item, details = null) {
  const identity = urlContentIdentity(item.url);
  const date = item.airDate || details?.release_date || details?.first_air_date || '';
  const detectedYear = Number(String(date).slice(0, 4)) ||
    Number(String(item.title || '').match(/\b(19|20)\d{2}\b(?=\s*$)/)?.[0]) || null;

  if (isEpisodeItem(item)) {
    const seriesTitle = details?.name || item.seriesTitle || item.title || `Series ${identity.id}`;
    const episodeTitle = item.episodeTitle || `Episode ${identity.episode}`;
    return {
      ...item,
      title: `${seriesTitle} S${String(identity.season).padStart(2, '0')}E${String(identity.episode).padStart(2, '0')} - ${episodeTitle}`,
      seriesTitle,
      year: detectedYear,
    };
  }

  const apiTitle = details?.title || details?.name;
  const fallback = String(item.title || 'Untitled')
    .replace(/^\s*\d+(?:\.\d+)?\s+/, '')
    .replace(/^(?:TOP\s*10|RECENTLY\s+ADDED|NEW|TRENDING)\s+/i, '')
    .replace(/^(?:TOP\s*10|RECENTLY\s+ADDED|NEW|TRENDING)\s+/i, '')
    .replace(/\s+\b(?:19|20)\d{2}\b\s*$/, '')
    .trim() || 'Untitled';
  return { ...item, title: String(apiTitle || fallback).trim(), year: detectedYear };
}

async function enrichTitleMetadata(item, origin) {
  if (item.year && item.title && !/^\d+(?:\.\d+)?\s/.test(item.title)) return item;
  const identity = urlContentIdentity(item.url);
  if (!identity.id) return normalizeTitleMetadata(item);
  try {
    const details = await fetchJsonWithRetry(
      `${origin}/api/tmdb/${identity.type === 'tv' ? 'tv' : 'movie'}/${identity.id}?api_key=&language=en-US`,
      3
    );
    return normalizeTitleMetadata(item, details);
  } catch (error) {
    console.log(`[METADATA FALLBACK] ${item.title}: ${error.message}`);
    return normalizeTitleMetadata(item);
  }
}

let nextMetadataRequestAt = 0;

async function fetchJsonWithRetry(url, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const waitMs = Math.max(0, nextMetadataRequestAt - Date.now());
      nextMetadataRequestAt = Math.max(Date.now(), nextMetadataRequestAt) + 750;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const response = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36' },
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfter = Number(response.headers.get('retry-after')) || 0;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = error.status === 429
          ? Math.max(error.retryAfter * 1000, 5000 * attempt)
          : 1200 * attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

async function expandEpisodicCatalog(baseCatalog, origin, previous = null) {
  const movieJobs = baseCatalog
    .filter((item) => !isUnscopedSeriesItem(item))
    .map((item) => ({ ...item, contentType: isEpisodeItem(item) ? 'episode' : 'movie' }));
  const seriesItems = baseCatalog.filter(isUnscopedSeriesItem);
  const episodeJobs = [];
  const seriesMetadata = [];
  const today = new Date().toISOString().slice(0, 10);
  const canReuse = previous?.expandedAt?.slice(0, 10) === today;
  const cachedMetadata = new Map(
    canReuse ? (previous.seriesMetadata || []).filter((item) => item.status === 'expanded').map((item) => [item.seriesId, item]) : []
  );
  const cachedEpisodes = new Map();
  if (canReuse) {
    for (const item of previous.catalog || []) {
      if (!isEpisodeItem(item)) continue;
      if (!cachedEpisodes.has(item.seriesId)) cachedEpisodes.set(item.seriesId, []);
      cachedEpisodes.get(item.seriesId).push(item);
    }
  }
  const pendingSeriesItems = [];
  for (const seriesItem of seriesItems) {
    const identity = urlContentIdentity(seriesItem.url);
    const seriesId = `tv:${identity.id}`;
    if (cachedMetadata.has(seriesId)) {
      seriesMetadata.push(cachedMetadata.get(seriesId));
      episodeJobs.push(...(cachedEpisodes.get(seriesId) || []));
    } else {
      pendingSeriesItems.push(seriesItem);
    }
  }

  console.log(`[EPISODES] ${cachedMetadata.size} series cached; expanding ${pendingSeriesItems.length} series into aired episode jobs...`);
  await runWorkerPool(pendingSeriesItems, 2, async (seriesItem, index) => {
    const identity = urlContentIdentity(seriesItem.url);
    const seriesId = `tv:${identity.id}`;
    try {
      const detailsUrl = `${origin}/api/tmdb/tv/${identity.id}?api_key=&language=en-US`;
      const details = await fetchJsonWithRetry(detailsUrl);
      const seasons = (details.seasons || []).filter((season) => Number.isInteger(season.season_number));
      const airedEpisodes = [];
      for (const season of seasons) {
        const seasonUrl = `${origin}/api/tmdb/tv/${identity.id}/season/${season.season_number}?api_key=&language=en-US`;
        const seasonData = await fetchJsonWithRetry(seasonUrl);
        for (const episode of seasonData.episodes || []) {
          if (!episode.air_date || episode.air_date > today) continue;
          const target = new URL(seriesItem.url);
          target.searchParams.set('id', identity.id);
          target.searchParams.set('type', 'tv');
          target.searchParams.set('season', String(episode.season_number));
          target.searchParams.set('episode', String(episode.episode_number));
          const episodeId = `tv:${identity.id}:s${String(episode.season_number).padStart(2, '0')}:e${String(episode.episode_number).padStart(2, '0')}`;
          airedEpisodes.push({
            ...seriesItem,
            url: target.href,
            title: `${details.name || seriesItem.title} S${String(episode.season_number).padStart(2, '0')}E${String(episode.episode_number).padStart(2, '0')} - ${episode.name || `Episode ${episode.episode_number}`}`,
            contentType: 'episode',
            canonicalId: episodeId,
            seriesId,
            seriesTitle: details.name || seriesItem.title,
            seasonNumber: episode.season_number,
            episodeNumber: episode.episode_number,
            episodeTitle: episode.name || `Episode ${episode.episode_number}`,
            airDate: episode.air_date,
            stillPath: episode.still_path || null,
          });
        }
      }
      episodeJobs.push(...airedEpisodes);
      seriesMetadata.push({
        seriesId,
        tmdbId: identity.id,
        title: details.name || seriesItem.title,
        sourceUrl: seriesItem.url,
        categories: seriesItem.categories,
        totalSeasons: details.number_of_seasons || seasons.length,
        totalEpisodes: details.number_of_episodes || 0,
        airedEpisodes: airedEpisodes.length,
        status: 'expanded',
      });
      console.log(`[EPISODES ${index + 1}/${pendingSeriesItems.length}] ${details.name || seriesItem.title}: ${airedEpisodes.length} aired`);
    } catch (error) {
      seriesMetadata.push({
        seriesId,
        tmdbId: identity.id,
        title: seriesItem.title,
        sourceUrl: seriesItem.url,
        categories: seriesItem.categories,
        totalSeasons: null,
        totalEpisodes: null,
        airedEpisodes: 0,
        status: 'metadata-failed',
        error: error.message,
      });
      console.log(`[EPISODES FAILED] ${seriesItem.title}: ${error.message}`);
    }
  });

  return {
    catalog: [
      ...movieJobs,
      ...episodeJobs.sort((left, right) => canonicalMovieId(left).localeCompare(canonicalMovieId(right), undefined, { numeric: true })),
    ],
    seriesMetadata: seriesMetadata.sort((left, right) => left.seriesId.localeCompare(right.seriesId, undefined, { numeric: true })),
    expandedAt: new Date().toISOString(),
  };
}

function taxonomyFor(item) {
  const taxonomy = {
    contentType: [], genres: [], editorial: [], regions: [], platforms: [], featured: [], collections: [],
  };
  const bucketByType = {
    'content-type': 'contentType', genre: 'genres', editorial: 'editorial',
    region: 'regions', platform: 'platforms', featured: 'featured', collection: 'collections',
  };
  for (const rawCategory of item.categories || ['Uncategorized']) {
    const descriptor = categoryDescriptor(rawCategory);
    const bucket = bucketByType[descriptor.type] || 'collections';
    if (!taxonomy[bucket].includes(descriptor.name)) taxonomy[bucket].push(descriptor.name);
  }
  return taxonomy;
}

function reconcileScheduler(catalog, previous = {}) {
  const currentOrder = categoryOrder(catalog);
  const oldOrder = Array.isArray(previous.categoryOrder) ? previous.categoryOrder : [];
  const order = [...oldOrder.filter((category) => currentOrder.includes(category))];
  for (const category of currentOrder) if (!order.includes(category)) order.push(category);
  const processedByCategory = {};
  for (const category of order) {
    const previousUrls = previous.processedByCategory?.[category];
    processedByCategory[category] = Array.isArray(previousUrls) ? [...new Set(previousUrls)] : [];
  }
  return {
    categoryOrder: order,
    nextCategoryIndex: order.length > 0 ? (Number(previous.nextCategoryIndex) || 0) % order.length : 0,
    processedByCategory,
    lastBatchByCategory: previous.lastBatchByCategory || {},
    activeBatch: previous.activeBatch || null,
    lastCategory: previous.lastCategory || null,
  };
}

function markItemProcessed(scheduler, item, selectedCategory = null) {
  const categories = selectedCategory ? [selectedCategory] : (item.categories || ['Uncategorized']);
  for (const category of categories) {
    if (!scheduler.processedByCategory[category]) scheduler.processedByCategory[category] = [];
    if (!scheduler.processedByCategory[category].includes(item.url)) {
      scheduler.processedByCategory[category].push(item.url);
    }
  }
}

function markExistingResultsProcessed(payload) {
  for (const item of payload.results || []) markItemProcessed(payload.scheduler, item);
}

function nextCategoryBatch(payload, batchSize, categoryOverride = null) {
  const scheduler = payload.scheduler;
  if (scheduler.activeBatch?.category && Array.isArray(scheduler.activeBatch.urls)) {
    const category = scheduler.activeBatch.category;
    if (categoryOverride && category !== categoryOverride) {
      throw new Error(`An unfinished batch for ${category} must resume before ${categoryOverride}`);
    }
    const processed = new Set(scheduler.processedByCategory[category] || []);
    const activeUrls = new Set(scheduler.activeBatch.urls);
    const remaining = payload.catalog.filter(
      (item) => activeUrls.has(item.url) && item.categories?.includes(category) && !processed.has(item.url)
    );
    if (remaining.length > 0) {
      scheduler.lastCategory = category;
      return { category, titles: remaining.slice(0, batchSize), remainingBeforeBatch: remaining.length, resumed: true };
    }
    scheduler.activeBatch = null;
  }
  if (categoryOverride) {
    const processed = new Set(scheduler.processedByCategory[categoryOverride] || []);
    const remaining = payload.catalog.filter(
      (item) => item.categories?.includes(categoryOverride) && !processed.has(item.url)
    );
    if (remaining.length === 0) return { category: null, titles: [], remainingBeforeBatch: 0, manual: true };
    scheduler.lastCategory = categoryOverride;
    const titles = remaining.slice(0, batchSize);
    scheduler.activeBatch = {
      category: categoryOverride,
      urls: titles.map((item) => item.url),
      startedAt: new Date().toISOString(),
      manual: true,
    };
    return { category: categoryOverride, titles, remainingBeforeBatch: remaining.length, manual: true };
  }
  const count = scheduler.categoryOrder.length;
  for (let checked = 0; checked < count; checked += 1) {
    const index = scheduler.nextCategoryIndex % count;
    const category = scheduler.categoryOrder[index];
    scheduler.nextCategoryIndex = (index + 1) % count;
    const processed = new Set(scheduler.processedByCategory[category] || []);
    const remaining = payload.catalog.filter(
      (item) => item.categories?.includes(category) && !processed.has(item.url)
    );
    if (remaining.length > 0) {
      scheduler.lastCategory = category;
      const titles = remaining.slice(0, batchSize);
      scheduler.activeBatch = {
        category,
        urls: titles.map((item) => item.url),
        startedAt: new Date().toISOString(),
      };
      return { category, titles, remainingBeforeBatch: remaining.length, resumed: false };
    }
  }
  return { category: null, titles: [], remainingBeforeBatch: 0 };
}

function buildCategoryData(payload) {
  const data = {};
  const rows = outputRows(payload);
  const allCategories = [...new Set([
    ...categoryOrder(payload.catalog),
    ...payload.results.flatMap((item) => item.categories || ['Uncategorized']),
  ])];
  for (const category of allCategories) {
    const catalogTitles = payload.catalog.filter((item) => item.categories?.includes(category));
    const results = payload.results.filter(
      (item) => item.categories?.includes(category) && !item.excludedFromOutputs
    );
    const categoryRows = rows.filter((row) => row.category === category);
    const counts = contentCounts(categoryRows);
    data[category] = {
      discoveredTitles: catalogTitles.length,
      discoveredMovies: new Set(catalogTitles.filter((item) => !isEpisodeItem(item)).map((item) => canonicalMovieId(item))).size,
      discoveredSeries: new Set(catalogTitles.filter(isEpisodeItem).map((item) => item.seriesId)).size,
      discoveredEpisodes: new Set(catalogTitles.filter(isEpisodeItem).map((item) => canonicalMovieId(item))).size,
      processedTitles: results.length,
      processedMovies: new Set(results.filter((item) => !isEpisodeItem(item)).map((item) => canonicalMovieId(item))).size,
      processedSeries: new Set(results.filter(isEpisodeItem).map((item) => item.seriesId)).size,
      processedEpisodes: new Set(results.filter(isEpisodeItem).map((item) => canonicalMovieId(item))).size,
      successfulTitles: results.filter((item) => item.scan?.success).length,
      totalMoviesAdded: counts.movies,
      totalSeriesAdded: counts.series,
      totalEpisodesAdded: counts.episodes,
      totalPlayableItems: counts.playableItems,
      totalStreamLinks: categoryRows.length,
      totalUniqueMediaUrls: new Set(categoryRows.map((row) => row.url)).size,
      results: results.map((item) => ({
        title: item.title,
        pageUrl: item.url,
        success: Boolean(item.scan?.success),
        streams: rows
          .filter((row) => row.category === category && row.pageUrl === item.url)
          .map(({ category: _category, title: _title, pageUrl: _pageUrl, ...stream }) => stream),
      })),
    };
  }
  return data;
}

function saveCheckpoint(payload, jsonPath, textPath, m3uPath) {
  payload.updatedAt = new Date().toISOString();
  payload.categoryData = buildCategoryData(payload);
  const rows = outputRows(payload);
  const counts = contentCounts(rows);
  const catalogStats = catalogCounts(payload);
  const usableResults = payload.results.filter((item) => !item.excludedFromOutputs);
  payload.summary = {
    discovered: payload.catalog.length,
    discoveredMovies: catalogStats.discoveredMovies,
    discoveredSeries: catalogStats.discoveredSeries,
    discoveredEpisodes: catalogStats.discoveredEpisodes,
    processed: usableResults.length,
    processedMovies: catalogStats.processedMovies,
    processedSeries: catalogStats.processedSeries,
    processedEpisodes: catalogStats.processedEpisodes,
    successfulTitles: usableResults.filter((item) => item.scan?.success).length,
    failedTitles: usableResults.filter((item) => !item.scan?.success).length,
    totalMoviesAdded: counts.movies,
    totalSeriesAdded: counts.series,
    totalEpisodesAdded: counts.episodes,
    totalPlayableItems: counts.playableItems,
    totalCategoriesWithStreams: new Set(rows.map((row) => row.category)).size,
    totalStreamLinks: rows.length,
    totalUniqueMediaUrls: new Set(rows.map((row) => row.url)).size,
    verifiedStreams: usableResults.reduce(
      (total, item) => total + (item.scan?.finalStreams || []).filter(isPublishableStream).length,
      0
    ),
    legacySeriesResultsExcluded: payload.results.filter((item) => item.excludedFromOutputs).length,
  };
  const filePayload = {
    summary: payload.summary,
    categoryData: payload.categoryData,
    ...payload,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(filePayload, null, 2)}\n`, 'utf8');
  const lastBatch = payload.scheduler?.lastBatchByCategory?.[payload.scheduler?.lastCategory] || {};
  const masterReportPayload = {
    ...payload,
    catalog: (payload.catalog || []).map((item) => ({
      ...item, categories: [item.categories?.[0] || 'Uncategorized'],
    })),
    results: (payload.results || []).map((item) => ({
      ...item, categories: [item.categories?.[0] || 'Uncategorized'],
    })),
  };
  const masterRows = outputRows(masterReportPayload);
  const masterMetadata = {
    categoryName: 'MASTER',
    totalMoviesAdded: catalogStats.processedMovies,
    successfulNewMovies: lastBatch.successfulNewMovies || 0,
    successfulNewSeries: lastBatch.successfulNewSeries || 0,
    successfulNewEpisodes: lastBatch.successfulNewEpisodes || 0,
    totalStreamLinks: masterRows.length,
    totalUniqueMediaUrls: new Set(masterRows.map((row) => row.url)).size,
    lastUpdated: payload.updatedAt,
    purpose: EDUCATIONAL_PURPOSE,
  };
  saveTextReport(masterReportPayload, textPath, masterMetadata);
  if (m3uPath) saveM3uReport(masterReportPayload, m3uPath, masterMetadata);
}

function outputPaths(baseDirectory = __dirname) {
  const root = path.join(baseDirectory, 'output');
  return {
    root,
    masterDirectory: path.join(root, 'master'),
    categoriesDirectory: path.join(root, 'categories'),
    stateDirectory: path.join(root, 'state'),
    historyDirectory: path.join(root, 'history'),
    masterJson: path.join(root, 'master', 'catalog-summary.json'),
    masterText: path.join(root, 'master', 'all-streams.txt'),
    masterM3u: path.join(root, 'master', 'all-streams.m3u'),
    checkpoint: path.join(root, 'state', 'scan-checkpoint.json'),
    currentTitle: path.join(root, 'state', '.current-title-result.json'),
    scannerLock: path.join(root, 'state', '.scanner.lock'),
    history: path.join(root, 'history', 'scan-history.jsonl'),
  };
}

function acquireScannerLock(paths) {
  ensureOutputDirectories(paths);
  const createLock = () => {
    const handle = fs.openSync(paths.scannerLock, 'wx');
    fs.writeFileSync(handle, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    fs.closeSync(handle);
  };
  try {
    createLock();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let lockPid = null;
    try { lockPid = Number(JSON.parse(fs.readFileSync(paths.scannerLock, 'utf8')).pid); } catch (_) {}
    let running = false;
    if (Number.isInteger(lockPid) && lockPid > 0) {
      try { process.kill(lockPid, 0); running = true; } catch (_) {}
    }
    if (running) throw new Error(`Scanner is already running (PID ${lockPid}). Use only one npm.cmd start terminal.`);
    fs.unlinkSync(paths.scannerLock);
    createLock();
  }
  return () => {
    try {
      const lock = JSON.parse(fs.readFileSync(paths.scannerLock, 'utf8'));
      if (Number(lock.pid) === process.pid) fs.unlinkSync(paths.scannerLock);
    } catch (_) {}
  };
}

function ensureOutputDirectories(paths) {
  for (const directory of [
    paths.root, paths.masterDirectory, paths.categoriesDirectory,
    paths.stateDirectory, paths.historyDirectory,
  ]) fs.mkdirSync(directory, { recursive: true });
}

function itemBelongsToGroup(item, group) {
  return (item.categories || []).some((category) => group.rawCategories.includes(category));
}

function subsetForCategory(payload, group) {
  const batches = group.rawCategories
    .map((raw) => payload.scheduler?.lastBatchByCategory?.[raw])
    .filter(Boolean)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
  const categoryName = batches[0]?.category || group.rawCategories[0] || group.raw;
  const catalog = payload.catalog
    .filter((item) => itemBelongsToGroup(item, group))
    .map((item) => ({ ...item, categories: [categoryName] }));
  const catalogIndex = new Map(catalog.map((item, index) => [item.url, index]));
  return {
    ...payload,
    catalog,
    results: payload.results
      .filter((item) => itemBelongsToGroup(item, group))
      .map((item) => ({ ...item, categories: [categoryName] }))
      .sort((left, right) => (catalogIndex.get(left.url) ?? Number.MAX_SAFE_INTEGER) -
        (catalogIndex.get(right.url) ?? Number.MAX_SAFE_INTEGER)),
    outputCategoryName: categoryName,
  };
}

function uniqueStreams(rows) {
  const streams = [];
  const seen = new Set();
  for (const row of rows) {
    const key = [row.server, row.quality, row.url].join('\n');
    if (seen.has(key)) continue;
    seen.add(key);
    streams.push({
      server: row.server, resolution: row.quality, url: row.url,
    });
  }
  return streams;
}

function categoryMetadata(payload, group, subset, batchSize = 20) {
  const rows = outputRows(subset);
  const discoveredUrls = new Set(subset.catalog.map((item) => item.url));
  const processedUrls = new Set();
  for (const rawCategory of group.rawCategories) {
    for (const url of payload.scheduler?.processedByCategory?.[rawCategory] || []) {
      if (discoveredUrls.has(url)) processedUrls.add(url);
    }
  }
  for (const item of subset.results) {
    if (!item.excludedFromOutputs && discoveredUrls.has(item.url)) processedUrls.add(item.url);
  }
  const results = subset.results.filter((item) => !item.excludedFromOutputs);
  const discoveredMovies = subset.catalog.filter((item) => !isEpisodeItem(item));
  const discoveredEpisodes = subset.catalog.filter(isEpisodeItem);
  const processedMovies = results.filter((item) => !isEpisodeItem(item));
  const processedEpisodes = results.filter(isEpisodeItem);
  const series = (payload.seriesMetadata || []).filter(
    (item) => (item.categories || []).some((category) => group.rawCategories.includes(category))
  );
  const counts = contentCounts(rows);
  const batchCandidates = group.rawCategories
    .map((rawCategory) => payload.scheduler?.lastBatchByCategory?.[rawCategory])
    .filter(Boolean)
    .sort((left, right) => String(right.completedAt).localeCompare(String(left.completedAt)));
  const lastBatch = batchCandidates[0] || {};
  const remainingPlayableItems = [...discoveredUrls].filter((url) => !processedUrls.has(url)).length;
  return {
    categoryName: subset.outputCategoryName || group.rawCategories[0] || group.raw,
    totalMoviesAdded: new Set(processedMovies.map((item) => canonicalMovieId(item))).size,
    successfulNewMovies: lastBatch.successfulNewMovies || 0,
    successfulNewSeries: lastBatch.successfulNewSeries || 0,
    successfulNewEpisodes: lastBatch.successfulNewEpisodes || 0,
    totalStreamLinks: rows.length,
    totalUniqueMediaUrls: new Set(rows.map((row) => row.url)).size,
    lastUpdated: payload.updatedAt,
    purpose: EDUCATIONAL_PURPOSE,
  };
}

function canonicalMovieRecord(item, rows, serial = null) {
  const memberships = [...new Map((item.categories || ['Uncategorized']).map((rawCategory) => {
    const descriptor = categoryDescriptor(rawCategory);
    return [descriptor.categoryId, {
      categoryId: descriptor.categoryId,
      name: descriptor.name,
      type: descriptor.type,
      folder: descriptor.folder,
    }];
  })).values()];
  return {
    serial: serial || null,
    canonicalId: canonicalMovieId(item),
    title: item.title,
    year: item.year || (item.airDate ? Number(String(item.airDate).slice(0, 4)) : null),
    sourceUrl: item.url,
    contentType: isEpisodeItem(item) ? 'episode' : 'movie',
    seriesId: item.seriesId || null,
    seriesTitle: item.seriesTitle || null,
    seasonNumber: item.seasonNumber ?? null,
    episodeNumber: item.episodeNumber ?? null,
    episodeTitle: item.episodeTitle || null,
    airDate: item.airDate || null,
    categoryMemberships: memberships,
    taxonomy: taxonomyFor(item),
    success: Boolean(item.scan?.success),
    servers: groupStreamRowsByServer(rows.filter((row) => row.pageUrl === item.url)),
  };
}

function splitContentRecords(records) {
  const movies = records.filter((record) => record.contentType !== 'episode');
  const seriesMap = new Map();
  for (const episode of records.filter((record) => record.contentType === 'episode')) {
    const series = seriesMap.get(episode.seriesId) || {
      seriesId: episode.seriesId,
      title: episode.seriesTitle,
      categoryMemberships: episode.categoryMemberships,
      taxonomy: episode.taxonomy,
      totalEpisodesAdded: 0,
      seasons: [],
    };
    let season = series.seasons.find((item) => item.seasonNumber === episode.seasonNumber);
    if (!season) {
      season = { seasonNumber: episode.seasonNumber, episodes: [] };
      series.seasons.push(season);
    }
    season.episodes.push(episode);
    series.totalEpisodesAdded += 1;
    seriesMap.set(episode.seriesId, series);
  }
  const series = [...seriesMap.values()];
  for (const item of series) {
    item.seasons.sort((left, right) => left.seasonNumber - right.seasonNumber);
    for (const season of item.seasons) {
      season.episodes.sort((left, right) => left.episodeNumber - right.episodeNumber);
    }
  }
  return { movies, series };
}

function writeCategoryOutputs(payload, paths, batchSize = 20) {
  const categorySummaries = [];
  for (const group of categoryGroups(payload)) {
    const directory = path.join(paths.categoriesDirectory, group.folder);
    fs.mkdirSync(directory, { recursive: true });
    const subset = subsetForCategory(payload, group);
    const metadata = categoryMetadata(payload, group, subset, batchSize);
    const rows = outputRows(subset);
    let movieSerial = 0;
    let episodeSerial = 0;
    const records = subset.results
      .filter((item) => !item.excludedFromOutputs)
      .map((item) => canonicalMovieRecord(
        item,
        rows,
        isEpisodeItem(item) ? `Episode-${++episodeSerial}` : `Movie-${++movieSerial}`
      ));
    const splitRecords = splitContentRecords(records);
    const categoryJson = {
      metadata: {
        category: metadata.categoryName,
        totalMovies: metadata.totalMoviesAdded,
        successfulNewAdded: metadata.successfulNewMovies,
        successfulNewAddedSeries: metadata.successfulNewSeries,
        successfulNewAddedEpisodes: metadata.successfulNewEpisodes,
        streamLinks: metadata.totalStreamLinks,
        uniqueStreamUrls: metadata.totalUniqueMediaUrls,
        lastUpdated: metadata.lastUpdated,
        purpose: EDUCATIONAL_PURPOSE,
      },
      movies: splitRecords.movies,
      series: splitRecords.series,
    };
    fs.writeFileSync(path.join(directory, 'category.json'), `${JSON.stringify(categoryJson, null, 2)}\n`, 'utf8');
    saveTextReport(subset, path.join(directory, 'streams.txt'), metadata);
    saveM3uReport(subset, path.join(directory, 'playlist.m3u'), metadata);
    categorySummaries.push({
      categoryName: metadata.categoryName,
      categoryId: group.categoryId,
      categoryType: group.type,
      folder: group.folder,
      totalMovies: metadata.totalMoviesAdded,
      successfulNewAdded: metadata.successfulNewMovies,
      successfulNewAddedSeries: metadata.successfulNewSeries,
      successfulNewAddedEpisodes: metadata.successfulNewEpisodes,
      totalStreamLinks: metadata.totalStreamLinks,
      totalUniqueMediaUrls: metadata.totalUniqueMediaUrls,
      lastUpdated: metadata.lastUpdated,
      purpose: EDUCATIONAL_PURPOSE,
      files: {
        json: `categories/${group.folder}/category.json`,
        text: `categories/${group.folder}/streams.txt`,
        m3u: `categories/${group.folder}/playlist.m3u`,
      },
    });
  }
  return categorySummaries;
}

function appendHistory(payload, paths, eventType, details = {}) {
  const event = {
    timestamp: new Date().toISOString(),
    event: eventType,
    sourceUrl: payload.sourceUrl,
    category: payload.scheduler?.lastCategory || null,
    summary: payload.summary,
    ...details,
  };
  fs.appendFileSync(paths.history, `${JSON.stringify(event)}\n`, 'utf8');
}

function saveOutputTree(payload, paths, options = {}) {
  ensureOutputDirectories(paths);
  saveCheckpoint(payload, paths.checkpoint, paths.masterText, paths.masterM3u);
  const categories = writeCategoryOutputs(payload, paths, options.batchSize || 20);
  const allRows = outputRows(payload);
  let masterMovieSerial = 0;
  let masterEpisodeSerial = 0;
  const records = payload.results
    .filter((item) => !item.excludedFromOutputs)
    .map((item) => canonicalMovieRecord(
      item,
      allRows,
      isEpisodeItem(item) ? `Episode-${++masterEpisodeSerial}` : `Movie-${++masterMovieSerial}`
    ));
  const splitRecords = splitContentRecords(records);
  const masterJson = {
    summary: payload.summary,
    purpose: EDUCATIONAL_PURPOSE,
    nextRotationCategory: payload.scheduler?.categoryOrder?.[payload.scheduler.nextCategoryIndex] || null,
    lastUpdated: payload.updatedAt,
    categories,
    seriesDiscovery: payload.seriesMetadata || [],
    movies: splitRecords.movies,
    series: splitRecords.series,
    excludedLegacySeriesResults: payload.results
      .filter((item) => item.excludedFromOutputs)
      .map((item) => ({
        canonicalId: canonicalMovieId(item),
        title: item.title,
        sourceUrl: item.url,
        reason: item.exclusionReason,
      })),
  };
  fs.writeFileSync(paths.masterJson, `${JSON.stringify(masterJson, null, 2)}\n`, 'utf8');
  if (options.historyEvent) appendHistory(payload, paths, options.historyEvent, options.historyDetails);
  return { categories, masterJson };
}

async function main() {
  const options = await getRootUrl(parseArgs(process.argv.slice(2)));
  console.log(`[SOURCE] ${options.rootUrl} (built into scanner)`);
  const paths = outputPaths(__dirname);
  ensureOutputDirectories(paths);
  const legacyJsonPath = path.resolve(OUTPUT_JSON);
  const resumePath = fs.existsSync(paths.checkpoint) ? paths.checkpoint : legacyJsonPath;
  let previous = null;
  if (!options.fresh && fs.existsSync(resumePath)) {
    try {
      const candidate = JSON.parse(fs.readFileSync(resumePath, 'utf8'));
      if (candidate.sourceUrl === options.rootUrl && Array.isArray(candidate.catalog)) previous = candidate;
    } catch (_) {
      console.log('[RESUME] Existing checkpoint is invalid; refreshing the catalog.');
    }
  }

  let baseDiscovery;
  const savedBaseCatalog = previous?.baseCatalog || previous?.catalog?.filter((item) => !isEpisodeItem(item));
  if (savedBaseCatalog?.length > 0 && !options.refreshCatalog && !options.refreshCategoryList) {
    baseDiscovery = {
      headings: previous.headings || [],
      surfaces: previous.surfaces || [],
      titles: savedBaseCatalog,
    };
    console.log(`\n[CATALOG] Reusing ${baseDiscovery.titles.length} saved titles; full rediscovery skipped.`);
  } else {
    console.log('\n[DISCOVERY] Crawling Home, Movies, TV, Asian Drama, Anime, Browse, and platform catalogs...');
    baseDiscovery = await discoverSite(options.rootUrl, options.origin, options.maxSurfaces);
    console.log(`[DISCOVERY] ${baseDiscovery.titles.length} unique titles found across ${baseDiscovery.surfaces.length} surfaces.`);
  }

  if (previous && !options.retryFailed && !options.refreshCatalog && !options.refreshCategoryList) {
    const previewCatalog = restoreExpandedEpisodes(baseDiscovery.titles, previous);
    const previewScheduler = reconcileScheduler(previewCatalog, previous.scheduler);
    const selectedForRefresh = resolveCategorySelection(previewScheduler, options.category);
    if (selectedForRefresh) {
      const selectedSurfaceUrl = surfaceUrlForCategory(
        selectedForRefresh, baseDiscovery.surfaces, options.rootUrl, options.origin
      );
      console.log(`[CATEGORY REFRESH] ${selectedForRefresh}: ${selectedSurfaceUrl}`);
      const refreshed = await discoverSite(
        selectedSurfaceUrl, options.origin, 1, [selectedSurfaceUrl]
      );
      const selectedItems = refreshed.titles.filter(
        (item) => item.categories?.includes(selectedForRefresh)
      );
      baseDiscovery.titles = mergeRefreshedCategory(
        baseDiscovery.titles, selectedItems, selectedForRefresh
      );
      baseDiscovery.headings = [...new Set([...(baseDiscovery.headings || []), ...refreshed.headings])];
      const refreshedSurfaceNames = new Set(refreshed.surfaces.map((entry) => entry.name));
      baseDiscovery.surfaces = [
        ...(baseDiscovery.surfaces || []).filter((entry) => !refreshedSurfaceNames.has(entry.name)),
        ...refreshed.surfaces,
      ];
      console.log(`[CATEGORY REFRESH] ${selectedItems.length} current items merged ahead of saved backlog.`);
    }
  }

  const canReuseEpisodeCatalog = previous?.episodeCatalogVersion === 1 &&
    Array.isArray(previous.catalog) && Array.isArray(previous.seriesMetadata) &&
    !options.refreshCatalog && !options.refreshCategoryList;
  const episodic = canReuseEpisodeCatalog ? {
    catalog: restoreExpandedEpisodes(baseDiscovery.titles, previous),
    seriesMetadata: previous.seriesMetadata,
    expandedAt: previous.episodeCatalogExpandedAt,
  } : {
    catalog: baseDiscovery.titles.map((item) => ({
      ...item,
      contentType: isUnscopedSeriesItem(item) ? 'series' : (isEpisodeItem(item) ? 'episode' : 'movie'),
    })),
    seriesMetadata: [],
    expandedAt: null,
  };
  console.log(
    `[EPISODE CATALOG] ${episodic.catalog.filter(isEpisodeItem).length} cached episodes; ` +
    'new series will expand only when their category batch is selected.'
  );

  const discovery = { ...baseDiscovery, titles: episodic.catalog };

  let payload = {
    scanner: 'root-site-multi-server-stream-scanner',
    sourceUrl: options.rootUrl,
    startedAt: new Date().toISOString(),
    updatedAt: null,
    headings: discovery.headings,
    surfaces: discovery.surfaces,
    baseCatalog: baseDiscovery.titles,
    catalog: discovery.titles,
    episodeCatalogVersion: 1,
    playbackPolicyVersion: 2,
    episodeCatalogExpandedAt: episodic.expandedAt,
    seriesMetadata: episodic.seriesMetadata,
    results: [],
    scheduler: reconcileScheduler(discovery.titles),
    summary: {},
  };

  if (previous && Array.isArray(previous.results)) {
    try {
        payload.results = previous.results
          .map((item) => {
            const current = discovery.titles.find((title) => title.url === item.url);
            return {
              ...item,
              categories: [...new Set([...(item.categories || []), ...(current?.categories || [])])],
              scan: sanitizeScan(item.scan),
              excludedFromOutputs: isUnscopedSeriesItem(item) ? true : Boolean(item.excludedFromOutputs),
              exclusionReason: isUnscopedSeriesItem(item)
                ? 'legacy TV title-level stream has no season/episode identity'
                : item.exclusionReason,
            };
          });
        const policyMigration = previous.playbackPolicyVersion !== 2;
        payload.scheduler = reconcileScheduler(
          discovery.titles,
          policyMigration ? {} : previous.scheduler
        );
        if (policyMigration) {
          for (const item of payload.results.filter((result) => isPublishableScan(result.scan))) {
            markItemProcessed(payload.scheduler, item);
          }
          console.log('[PLAYBACK POLICY] Old header-dependent/low-resolution links will be rescanned.');
        } else {
          pruneExpiredProcessedItems(payload);
        }
        payload.startedAt = previous.startedAt || payload.startedAt;
        const priorSuccesses = payload.results.filter((item) => item.scan?.success).length;
        console.log(`[RESUME] Keeping ${payload.results.length} attempted titles (${priorSuccesses} successful).`);
        if (resumePath === legacyJsonPath) console.log('[MIGRATION] Importing the legacy checkpoint into output/state/.');
    } catch (_) {
      console.log('[RESUME] Existing checkpoint is invalid; starting a new scan.');
    }
  }

  if (previous && repairLatestBatchCounts(payload, paths.history)) {
    console.log('[STATE REPAIR] Recovered movie, series, and episode counts for the latest completed batch.');
  }
  saveOutputTree(payload, paths, { batchSize: options.maxTitles, historyEvent: 'run-start' });
  if (options.discoverOnly) {
    console.log(`[DONE] Discovery saved to ${paths.checkpoint}`);
    return;
  }

  let batchesCompleted = 0;
  while (batchesCompleted < 1) {
    let selectedCategory = null;
    let queue = [];
    let remainingBeforeBatch = 0;
    if (options.retryFailed) {
      if (batchesCompleted > 0) break;
      selectedCategory = 'FAILED RETRY';
      queue = payload.results
        .filter((item) => !item.scan?.success)
        .slice(0, options.maxTitles)
        .map((item) => discovery.titles.find((title) => title.url === item.url) || item);
      remainingBeforeBatch = queue.length;
    } else {
      const selectedOverride = options.category
        ? resolveCategorySelection(payload.scheduler, options.category)
        : null;
      const batch = nextCategoryBatch(payload, options.maxTitles, selectedOverride);
      selectedCategory = batch.category;
      queue = batch.titles;
      remainingBeforeBatch = batch.remainingBeforeBatch;
    }

    const selectedSeries = queue.filter(isUnscopedSeriesItem);
    if (!options.retryFailed && selectedCategory && selectedSeries.length > 0) {
      const originalQueue = [...queue];
      console.log(`[CATEGORY EPISODES] Expanding ${selectedSeries.length} series only for ${selectedCategory}.`);
      const expanded = await expandEpisodicCatalog(selectedSeries, options.origin);
      const selectedSeriesUrls = new Set(selectedSeries.map((item) => item.url));
      payload.catalog = payload.catalog
        .filter((item) => !selectedSeriesUrls.has(item.url))
        .concat(expanded.catalog);
      const expandedSeriesIds = new Set(expanded.seriesMetadata.map((item) => item.seriesId));
      payload.seriesMetadata = (payload.seriesMetadata || [])
        .filter((item) => !expandedSeriesIds.has(item.seriesId))
        .concat(expanded.seriesMetadata);
      payload.episodeCatalogExpandedAt = expanded.expandedAt;
      payload.scheduler = reconcileScheduler(payload.catalog, payload.scheduler);
      const processed = new Set(payload.scheduler.processedByCategory[selectedCategory] || []);
      const remaining = payload.catalog.filter(
        (item) => item.categories?.includes(selectedCategory) && !processed.has(item.url)
      );
      const remainingByUrl = new Map(remaining.map((item) => [item.url, item]));
      const episodesBySeries = new Map();
      for (const item of remaining.filter(isEpisodeItem)) {
        if (!episodesBySeries.has(item.seriesId)) episodesBySeries.set(item.seriesId, []);
        episodesBySeries.get(item.seriesId).push(item);
      }
      const fairQueue = [];
      for (const original of originalQueue) {
        if (isUnscopedSeriesItem(original)) {
          const identity = urlContentIdentity(original.url);
          const episode = episodesBySeries.get(`tv:${identity.id}`)?.shift();
          if (episode) fairQueue.push(episode);
        } else if (remainingByUrl.has(original.url)) {
          fairQueue.push(remainingByUrl.get(original.url));
        }
      }
      const selectedUrls = new Set(fairQueue.map((item) => item.url));
      const seriesQueues = [...episodesBySeries.values()];
      while (fairQueue.length < options.maxTitles && seriesQueues.some((items) => items.length > 0)) {
        for (const items of seriesQueues) {
          const episode = items.shift();
          if (episode && !selectedUrls.has(episode.url)) {
            selectedUrls.add(episode.url);
            fairQueue.push(episode);
            if (fairQueue.length === options.maxTitles) break;
          }
        }
      }
      for (const item of remaining) {
        if (fairQueue.length === options.maxTitles) break;
        if (!selectedUrls.has(item.url)) {
          selectedUrls.add(item.url);
          fairQueue.push(item);
        }
      }
      queue = fairQueue;
      remainingBeforeBatch = remaining.length;
      syncActiveBatchToQueue(payload.scheduler, selectedCategory, queue);
      saveOutputTree(payload, paths, {
        batchSize: options.maxTitles,
        historyEvent: 'category-series-expanded',
        historyDetails: { selectedCategory, expandedSeries: selectedSeries.length },
      });
    }

    if (!selectedCategory || queue.length === 0) {
      console.log('[ROTATION] Every discovered category batch is complete.');
      break;
    }

    batchesCompleted += 1;
    console.log('\n==================================================');
    console.log(`[ROTATION BATCH ${batchesCompleted}] ${selectedCategory}`);
    console.log(`[CATEGORY REMAINING] ${remainingBeforeBatch} before this batch.`);
    console.log(`[BATCH SIZE] ${queue.length}/${options.maxTitles}`);
    console.log(`[PARALLEL WORKERS] ${Math.min(options.workers, queue.length)}`);
    console.log('==================================================');

    await runWorkerPool(queue, options.workers, async (title, index, workerId) => {
      const enriched = await enrichTitleMetadata(title, options.origin);
      Object.assign(title, enriched);
      console.log(`\n[WORKER ${workerId}] [TITLE ${index + 1}/${queue.length}] ${title.title}`);
      console.log(`[CATEGORIES] ${title.categories.join(', ')}`);
      const existing = payload.results.find((item) => item.url === title.url);
      if (!options.retryFailed && existing && isReusableScan(existing.scan)) {
        existing.title = title.title;
        existing.year = title.year;
        existing.categories = [...new Set([...(existing.categories || []), ...(title.categories || [])])];
        markItemProcessed(payload.scheduler, existing, selectedCategory);
        saveOutputTree(payload, paths, {
          batchSize: options.maxTitles,
          historyEvent: 'title-reused',
          historyDetails: { title: title.title, url: title.url, selectedCategory },
        });
        console.log('[REUSED] This title was already verified in another category.');
        return;
      }
      const resultPath = path.join(
        paths.stateDirectory,
        `.worker-${process.pid}-${batchesCompleted}-${workerId}-${index}.json`
      );
      const { processResult, scan } = await scanTitleWithRetries(
        title, options, resultPath, index + 1, queue.length
      );
      const mergedScan = mergeScanResults(existing?.scan, scan);
      payload.results = payload.results.filter((item) => item.url !== title.url);
      payload.results.push({
        ...existing,
        ...title,
        processExitCode: processResult.exitCode,
        processError: processResult.error,
        scan: mergedScan,
      });
      if (!options.retryFailed) markItemProcessed(payload.scheduler, title, selectedCategory);
      saveOutputTree(payload, paths, {
        batchSize: options.maxTitles,
        historyEvent: mergedScan?.lastAttemptSucceeded === false ? 'title-refresh-failed-preserved' :
          (scan?.success ? 'title-scanned' : 'title-failed'),
        historyDetails: { title: title.title, url: title.url, selectedCategory, workerId },
      });
      console.log(
        `[CHECKPOINT] ${payload.summary.processed}/${payload.summary.discovered} processed; ` +
        `${payload.summary.verifiedStreams} verified streams.`
      );
    });

    const logicalBatchUrls = payload.scheduler.activeBatch?.urls || queue.map((item) => item.url);
    const batchCounts = successfulBatchCounts(payload, logicalBatchUrls);
    payload.scheduler.lastBatchByCategory[selectedCategory] = {
      category: selectedCategory,
      ...batchCounts,
      itemUrls: logicalBatchUrls,
      successfulItemUrls: payload.results
        .filter((item) => logicalBatchUrls.includes(item.url) && item.scan?.lastAttemptSucceeded !== false && isPublishableScan(item.scan))
        .map((item) => item.url),
      completedAt: new Date().toISOString(),
    };
    payload.scheduler.activeBatch = null;

    saveOutputTree(payload, paths, {
      batchSize: options.maxTitles,
      historyEvent: 'category-batch-complete',
      historyDetails: { selectedCategory, batchTitles: queue.length, batchesCompleted },
    });
  }

  payload.finishedAt = new Date().toISOString();
  saveOutputTree(payload, paths, { batchSize: options.maxTitles, historyEvent: 'run-complete' });
  console.log('\n==================================================');
  console.log('ONE CATEGORY BATCH COMPLETE - SCANNER STOPPED');
  console.log(`Titles discovered: ${payload.summary.discovered}`);
  console.log(`Titles processed: ${payload.summary.processed}`);
  console.log(`Verified streams: ${payload.summary.verifiedStreams}`);
  console.log(`Master JSON: ${paths.masterJson}`);
  console.log(`Master links: ${paths.masterText}`);
  console.log(`Master M3U: ${paths.masterM3u}`);
  console.log(`Category folders: ${paths.categoriesDirectory}`);
  console.log(`Checkpoint: ${paths.checkpoint}`);
  console.log(`History: ${paths.history}`);
  console.log('==================================================\n');
}

if (require.main === module) {
  let releaseLock = () => {};
  try {
    releaseLock = acquireScannerLock(outputPaths(__dirname));
    main().catch((error) => {
      console.error(`Fatal error: ${error.message}`);
      process.exitCode = 1;
    }).finally(releaseLock);
  } catch (error) {
    console.error(`Fatal error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs, getRootUrl, inferQuality, isMediaFragment, sanitizeScan,
  is1080ClassResolution, isPublishableStream, isPublishableScan, isReusableScan,
  pruneExpiredProcessedItems,
  categoryDescriptor, categoryGroups, canonicalMovieId, urlContentIdentity,
  isEpisodeItem, isUnscopedSeriesItem, expandEpisodicCatalog, taxonomyFor,
  normalizeTitleMetadata, enrichTitleMetadata,
  reconcileScheduler, markItemProcessed, markExistingResultsProcessed,
  nextCategoryBatch, resolveCategorySelection, mergeRefreshedCategory,
  runWorkerPool, outputRows, contentCounts, catalogCounts, saveCheckpoint,
  successfulBatchCounts,
  syncActiveBatchToQueue, repairLatestBatchCounts,
  outputPaths, saveOutputTree, saveTextReport, saveM3uReport, canonicalMovieRecord,
};
