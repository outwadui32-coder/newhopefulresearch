'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const core = require('./lib/scanner-core');
const DESKTOP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

puppeteer.use(StealthPlugin());

function parseArgs(argv) {
  const options = { maxItems: 20, workers: 3, titleTimeout: 90, maxSurfaces: 30, headless: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--headed') options.headless = false;
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
      if (arg === '--max-items') options.maxItems = Number(value);
      else if (arg === '--workers') options.workers = Number(value);
      else if (arg === '--title-timeout') options.titleTimeout = Number(value);
      else if (arg === '--max-surfaces') options.maxSurfaces = Number(value);
      else throw new Error('Unknown option ' + arg);
      index += 1;
    }
  }
  if (!Number.isInteger(options.maxItems) || options.maxItems < 1 || options.maxItems > 20) throw new Error('--max-items must be 1-20');
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 5) throw new Error('--workers must be 1-5');
  if (!Number.isFinite(options.titleTimeout) || options.titleTimeout < 20) throw new Error('--title-timeout must be at least 20 seconds');
  return options;
}

function sourceConfig() {
  const raw = process.env.MAIN_SOURCE_URL;
  if (!raw) throw new Error('MAIN_SOURCE_URL GitHub Secret is required');
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('MAIN_SOURCE_URL must use HTTP/HTTPS');
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return { rootUrl: parsed.href, origin: parsed.origin };
}

function surfaceSeeds(source) {
  return [
    { name: 'Home', url: source.rootUrl },
    { name: 'Movies', url: source.origin + '/movies' },
    { name: 'TV Shows', url: source.origin + '/tv-shows' },
    { name: 'Anime', url: source.origin + '/anime' },
    { name: 'Korean Drama', url: source.origin + '/asian-dramas?region=KR&sort=popular' },
    { name: 'Chinese Drama', url: source.origin + '/asian-dramas?region=CN&sort=popular' },
    { name: 'Japanese Drama', url: source.origin + '/asian-dramas?region=JP&sort=popular' },
    { name: 'Browse', url: source.origin + '/browse' }
  ];
}

async function scrollPage(page) {
  let lastHeight = 0;
  let stable = 0;
  for (let count = 0; count < 35 && stable < 3; count += 1) {
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await new Promise((resolve) => setTimeout(resolve, 600));
    stable = height === lastHeight ? stable + 1 : 0;
    lastHeight = height;
  }
  await page.evaluate(() => window.scrollTo(0, 0));
}

async function extractSurface(page, surface) {
  const response = await page.goto(surface.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (response && [403, 429].includes(response.status())) throw new Error('HTTP ' + response.status());
  await scrollPage(page);
  const extracted = await page.evaluate((surfaceName) => {
    const titlePattern = /\/(?:play2?\?|(?:movie|tv)\/[^/?#]*\d+\/watch)/i;
    const ignored = /^(watch free|studios?\s*&|did you know|redflix$)/i;
    const categories = [];
    const items = [];
    let heading = surfaceName;
    const rememberCategory = (name) => { if (name && !categories.includes(name)) categories.push(name); };
    rememberCategory(heading);
    for (const element of document.querySelectorAll('h1,h2,h3,a[href]')) {
      if (/^H[1-3]$/.test(element.tagName)) {
        const candidate = (element.innerText || '').trim().replace(/\s+/g, ' ');
        if (candidate && !ignored.test(candidate)) {
          heading = candidate;
          rememberCategory(heading);
        }
        continue;
      }
      if (!titlePattern.test(element.href || '')) continue;
      const image = element.querySelector('img') || (element.parentElement && element.parentElement.querySelector('img'));
      const title = (element.getAttribute('aria-label') || element.getAttribute('title') ||
        (image && (image.alt || image.title)) || element.innerText || '').trim().replace(/\s+/g, ' ');
      if (!title) continue;
      items.push({ title: title, url: element.href, poster: image && (image.currentSrc || image.src) || '', heading: heading });
    }
    return { categories: categories, items: items };
  }, surface.name);
  const categories = extracted.categories.map((name) => ({
    id: core.categoryId(surface.name + ': ' + name), name: surface.name + ': ' + name,
    type: 'collection', surface: surface.name, heading: name, url: surface.url
  }));
  const byKey = new Map();
  for (const item of extracted.items) {
    const category = categories.find((entry) => entry.heading === item.heading) || categories[0];
    if (!category) continue;
    const normalized = Object.assign({}, item, { categories: [category] });
    const id = core.canonicalId(normalized);
    const previous = byKey.get(id);
    if (previous) {
      previous.categories = [...new Map(previous.categories.concat(normalized.categories).map((entry) => [entry.id, entry])).values()];
      if (!previous.poster) previous.poster = normalized.poster;
    } else {
      normalized.canonicalId = id;
      normalized.contentType = core.contentType(normalized);
      byKey.set(id, normalized);
    }
  }
  return { categories: categories, items: [...byKey.values()] };
}

async function withBrowser(options, callback) {
  const browser = await puppeteer.launch({
    headless: options.headless, defaultViewport: { width: 1365, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--window-size=1365,900']
  });
  try {
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.setUserAgent(DESKTOP_USER_AGENT);
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-US,en;q=0.9' });
    return await callback(page);
  } finally {
    await browser.close();
  }
}

async function initializeCategoryIndex(source, options) {
  return withBrowser(options, async (page) => {
    const categories = [];
    const initialItems = [];
    for (const surface of surfaceSeeds(source).slice(0, options.maxSurfaces)) {
      try {
        const data = await extractSurface(page, surface);
        categories.push(...data.categories);
        initialItems.push(...data.items);
        console.log('[INDEX] ' + surface.name + ': ' + data.categories.length + ' categories, ' + data.items.length + ' items');
      } catch (error) {
        console.error('[INDEX FAILED] ' + surface.name + ': ' + error.message);
      }
    }
    return { categories: [...new Map(categories.map((entry) => [entry.id, entry])).values()], items: initialItems };
  });
}

async function discoverSelectedCategory(category, options) {
  return withBrowser(options, async (page) => {
    const data = await extractSurface(page, { name: category.surface || category.name, url: category.url });
    const current = data.categories.find((entry) => entry.heading === category.heading || entry.id === category.id);
    const selectedId = current ? current.id : category.id;
    return data.items.filter((item) => item.categories.some((entry) => entry.id === selectedId || entry.heading === category.heading))
      .map((item) => Object.assign({}, item, { categories: [category] }));
  });
}

async function fetchTmdb(endpoint) {
  const token = process.env.TMDB_READ_TOKEN;
  const apiKey = process.env.TMDB_API_KEY;
  if (!token && !apiKey) return null;
  const separator = endpoint.includes('?') ? '&' : '?';
  const url = 'https://api.themoviedb.org/3' + endpoint + (apiKey ? separator + 'api_key=' + encodeURIComponent(apiKey) : '');
  const response = await fetch(url, { headers: token ? { authorization: 'Bearer ' + token, accept: 'application/json' } : { accept: 'application/json' } });
  if (!response.ok) throw new Error('TMDB HTTP ' + response.status);
  return response.json();
}

function tmdbId(item) {
  const match = core.canonicalId(item).match(/^tv:(\d+)$/);
  return match ? match[1] : null;
}

async function expandSeriesLazily(items, category, processedHistory, maxNew) {
  const processed = new Set(processedHistory || []);
  const output = [];
  let newCount = 0;
  const today = new Date().toISOString().slice(0, 10);
  for (const item of items) {
    output.push(item);
    if (!processed.has(core.canonicalId(item))) newCount += 1;
    if (item.contentType !== 'series' || newCount >= maxNew) continue;
    const id = tmdbId(item);
    if (!id) continue;
    try {
      const details = await fetchTmdb('/tv/' + id + '?language=en-US');
      if (!details) continue;
      const seasons = (details.seasons || []).filter((season) => Number.isInteger(season.season_number));
      for (const season of seasons) {
        if (newCount >= maxNew) break;
        const seasonData = await fetchTmdb('/tv/' + id + '/season/' + season.season_number + '?language=en-US');
        for (const episode of seasonData.episodes || []) {
          if (newCount >= maxNew) break;
          if (!episode.air_date || episode.air_date > today) continue;
          const target = new URL(item.url);
          target.searchParams.set('id', id);
          target.searchParams.set('type', 'tv');
          target.searchParams.set('season', String(episode.season_number));
          target.searchParams.set('episode', String(episode.episode_number));
          const canonical = 'tv:' + id + ':s' + String(episode.season_number).padStart(2, '0') + ':e' + String(episode.episode_number).padStart(2, '0');
          const episodeItem = Object.assign({}, item, {
            canonicalId: canonical, contentType: 'episode', url: target.href,
            title: (details.name || item.title) + ' S' + String(episode.season_number).padStart(2, '0') +
              'E' + String(episode.episode_number).padStart(2, '0') + ' - ' + (episode.name || 'Episode ' + episode.episode_number),
            seriesId: 'tv:' + id, seriesTitle: details.name || item.title,
            seasonNumber: episode.season_number, episodeNumber: episode.episode_number,
            episodeTitle: episode.name || null, airDate: episode.air_date,
            poster: episode.still_path ? 'https://image.tmdb.org/t/p/original' + episode.still_path : item.poster,
            categories: [category]
          });
          output.push(episodeItem);
          if (!processed.has(canonical)) newCount += 1;
        }
      }
    } catch (error) {
      console.error('[EPISODE DISCOVERY] ' + item.title + ': ' + error.message);
    }
  }
  return output;
}

async function enrichPoster(item) {
  if (item.poster) return item;
  const match = core.canonicalId(item).match(/^(movie|tv):(\d+)/);
  if (!match) return item;
  try {
    const details = await fetchTmdb('/' + match[1] + '/' + match[2] + '?language=en-US');
    if (details && details.poster_path) item.poster = 'https://image.tmdb.org/t/p/original' + details.poster_path;
  } catch (error) {
    console.error('[POSTER] ' + item.title + ': ' + error.message);
  }
  return item;
}

function runCollector(item, source, options, resultPath) {
  return new Promise((resolve) => {
    const args = [path.join(__dirname, 'collector.js'), '--url', item.url, '--source-origin', source.origin,
      '--timeout', String(options.titleTimeout), '--output', resultPath];
    if (options.headless) args.push('--headless');
    const child = spawn(process.execPath, args, { cwd: __dirname, stdio: 'inherit' });
    child.on('error', (error) => resolve({ exitCode: -1, error: error.message, scan: null }));
    child.on('exit', (exitCode) => {
      let scan = null;
      try { scan = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch (_) {}
      try { fs.unlinkSync(resultPath); } catch (_) {}
      resolve({ exitCode: exitCode, scan: scan });
    });
  });
}

async function processWithCoordinator(state, batch, source, options, paths) {
  const pending = batch.pendingItems.slice();
  const active = new Map();
  let serial = 0;
  function startOne(canonical) {
    const item = state.catalog[canonical];
    const resultPath = path.join(paths.stateDir, '.worker-' + process.pid + '-' + serial++ + '.json');
    const promise = (async () => {
      await enrichPoster(item);
      if (core.canReuse(state, canonical)) return { canonical: canonical, mode: 'reuse', scan: state.results[canonical].scan };
      const result = await runCollector(item, source, options, resultPath);
      return {
        canonical: canonical, mode: 'browser',
        scan: result.scan || { success: false, finalStreams: [], finishedAt: new Date().toISOString(), error: 'collector exit ' + result.exitCode }
      };
    })();
    active.set(canonical, promise);
  }
  while (pending.length && active.size < options.workers) startOne(pending.shift());
  while (active.size) {
    const completed = await Promise.race([...active.values()]);
    active.delete(completed.canonical);
    core.checkpointBatchItem(state, completed.canonical, completed.scan, completed.mode);
    core.saveState(paths.state, state);
    core.appendHistory(__dirname, {
      event: completed.mode === 'reuse' ? 'item-reused' : 'item-scanned',
      categoryId: batch.categoryId, canonicalId: completed.canonical,
      success: state.results[completed.canonical].verified
    });
    console.log('[CHECKPOINT] ' + batch.completedItems.length + '/' + batch.items.length + ' ' + completed.canonical);
    if (pending.length) startOne(pending.shift());
  }
}

function realReport(state) {
  const batch = state.lastBatch;
  const itemTypes = { movie: 0, series: 0, episode: 0 };
  for (const id of batch.items) {
    const type = core.contentType(state.catalog[id]);
    itemTypes[type] = (itemTypes[type] || 0) + 1;
  }
  const uniqueUrls = new Set();
  for (const id of batch.items) {
    const result = state.results[id];
    for (const stream of (result && result.scan && result.scan.finalStreams || []).filter(core.streamIsPublishable)) uniqueUrls.add(stream.url);
  }
  return {
    'Selected Category': batch.categoryName, 'Discovered': batch.discovered,
    'New Items Found': batch.newItemsFound, 'Batch Items': batch.items.length,
    'Movies': itemTypes.movie, 'Series': itemTypes.series, 'Episodes': itemTypes.episode,
    'Browser Scanned': batch.browserScanned, 'Globally Reused': batch.globallyReused,
    'Successful': batch.successful, 'Failed': batch.failed,
    'Approved Streams': batch.approvedStreams, 'Rejected Streams': batch.rejectedStreams,
    'Unique URLs': uniqueUrls.size,
    'Next Category': state.categoryOrder[state.nextCategoryIndex] && state.categoryOrder[state.nextCategoryIndex].name
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = sourceConfig();
  const paths = core.outputPaths(__dirname);
  core.ensureOutputTree(paths);
  const release = core.acquireLock(paths.lock);
  try {
    const state = core.loadState(paths.state, source.rootUrl);
    core.migrateLegacyOnce(__dirname, state);
    let selected;
    let freshItems = [];
    if (!state.categoryOrder.length) {
      const index = await initializeCategoryIndex(source, options);
      if (!index.categories.length) throw new Error('No source categories discovered');
      core.mergeCategoryOrder(state, index.categories);
      core.mergeDiscoveredItems(state, index.items);
    }
    if (state.activeBatch) {
      selected = state.categoryOrder.find((entry) => entry.id === state.activeBatch.categoryId);
      if (!selected) throw new Error('Active batch category is missing');
      freshItems = state.activeBatch.items.map((id) => state.catalog[id]).filter(Boolean);
      console.log('[RESUME] ' + state.activeBatch.categoryName + ': ' + state.activeBatch.pendingItems.length + ' remaining');
    } else {
      selected = core.selectedCategory(state);
      console.log('[FRESH CATEGORY] ' + selected.name + ' from top: ' + selected.url);
      freshItems = await discoverSelectedCategory(selected, options);
      freshItems = await expandSeriesLazily(freshItems, selected, state.categoryHistory[selected.id], options.maxItems);
    }
    const batch = core.prepareActiveBatch(state, selected, freshItems, options.maxItems);
    core.saveState(paths.state, state);
    core.appendHistory(__dirname, { event: 'batch-start', categoryId: selected.id, batchId: batch.id, itemCount: batch.items.length });
    if (batch.pendingItems.length) await processWithCoordinator(state, batch, source, options, paths);
    core.completeBatch(state);
    state.updatedAt = new Date().toISOString();
    core.writeOutputs(__dirname, state);
    core.saveState(paths.state, state);
    core.appendHistory(__dirname, { event: 'batch-complete', categoryId: selected.id, batch: state.lastBatch });
    const report = realReport(state);
    console.log('\nREAL VERIFICATION REPORT');
    for (const [key, value] of Object.entries(report)) console.log(key + ': ' + (value === undefined ? '' : value));
    console.log('Git Commit: pending workflow validation');
    console.log('Push Status: pending workflow validation');
  } finally {
    release();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[FATAL] ' + error.stack);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs, sourceConfig, surfaceSeeds, extractSurface, initializeCategoryIndex, discoverSelectedCategory,
  expandSeriesLazily, processWithCoordinator, realReport
};
