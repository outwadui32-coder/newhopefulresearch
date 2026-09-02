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
      else if (arg === '--category') options.category = value.trim();
      else throw new Error('Unknown option ' + arg);
      index += 1;
    }
  }
  if (!Number.isInteger(options.maxItems) || options.maxItems < 1 || options.maxItems > 20) throw new Error('--max-items must be 1-20');
  if (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 5) throw new Error('--workers must be 1-5');
  if (!Number.isFinite(options.titleTimeout) || options.titleTimeout < 20) throw new Error('--title-timeout must be at least 20 seconds');
  return options;
}

function categoryItemCounts(state) {
  const counts = Object.fromEntries((state.categoryOrder || []).map((entry) => [entry.id, 0]));
  for (const item of Object.values(state.catalog || {})) {
    for (const category of item.categories || []) {
      if (Object.prototype.hasOwnProperty.call(counts, category.id)) counts[category.id] += 1;
    }
  }
  return counts;
}

function countContentTypes(state, canonicalIds) {
  const counts = { movies: 0, series: 0, episodes: 0 };
  for (const id of canonicalIds || []) {
    const type = core.contentType(state.catalog[id] || { canonicalId: id });
    if (type === 'movie') counts.movies += 1;
    else if (type === 'series') counts.series += 1;
    else if (type === 'episode') counts.episodes += 1;
  }
  return counts;
}

function showCategoryIndex(state) {
  const counts = categoryItemCounts(state);
  console.log('\n================ AVAILABLE CATEGORIES ================');
  state.categoryOrder.forEach((category, index) => {
    const processed = (state.categoryHistory[category.id] || []).length;
    console.log(
      '[' + String(index + 1).padStart(2, '0') + '] ' + category.name +
      ' | ID=' + category.id + ' | DISCOVERED=' + (counts[category.id] || 0) +
      ' | PREVIOUSLY PROCESSED=' + processed
    );
  });
  console.log('======================================================\n');
}

function resolveCategorySelection(state, selector) {
  if (!selector) return core.selectedCategory(state);
  const value = String(selector).trim();
  if (/^\d+$/.test(value)) {
    const index = Number(value) - 1;
    if (index >= 0 && index < state.categoryOrder.length) return state.categoryOrder[index];
  }
  const lower = value.toLowerCase();
  const exact = state.categoryOrder.find((entry) =>
    entry.id.toLowerCase() === lower || entry.name.toLowerCase() === lower
  );
  if (exact) return exact;
  const partial = state.categoryOrder.filter((entry) =>
    entry.id.toLowerCase().includes(lower) || entry.name.toLowerCase().includes(lower)
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error('Manual category is ambiguous: ' + partial.map((entry) => entry.name).join(' | '));
  }
  throw new Error('Manual category not found: ' + value + '. Use the displayed name, ID, or 1-based index.');
}

function showBatchQueue(state, batch) {
  console.log('\n================ SELECTED BATCH ITEMS ================');
  if (!batch.items.length) console.log('[EMPTY] No new unprocessed item was found in this category.');
  batch.items.forEach((id, index) => {
    const item = state.catalog[id];
    const mode = core.canReuse(state, id) ? 'GLOBAL REUSE' : 'NEW BROWSER SCAN';
    console.log(
      '[' + String(index + 1).padStart(2, '0') + '/' + String(batch.items.length).padStart(2, '0') + '] ' +
      mode + ' | ' + String(core.contentType(item)).toUpperCase() + ' | ' + item.title + ' | ' + id
    );
  });
  console.log('======================================================\n');
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
    const plannedMode = core.canReuse(state, canonical) ? 'GLOBAL REUSE' : 'BROWSER SCAN';
    console.log(
      '[ITEM START] CATEGORY="' + batch.categoryName + '" | ' + plannedMode +
      ' | TYPE=' + String(core.contentType(item)).toUpperCase() +
      ' | TITLE="' + item.title + '" | ID=' + canonical
    );
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
    const itemResult = batch.itemResults[completed.canonical];
    core.saveState(paths.state, state);
    core.appendHistory(__dirname, {
      event: completed.mode === 'reuse' ? 'item-reused' : 'item-scanned',
      categoryId: batch.categoryId, canonicalId: completed.canonical,
      success: state.results[completed.canonical].verified
    });
    console.log(
      '[ITEM RESULT] CATEGORY="' + batch.categoryName + '" | TITLE="' + itemResult.title +
      '" | TYPE=' + itemResult.contentType.toUpperCase() +
      ' | MODE=' + itemResult.mode.toUpperCase() +
      ' | STATUS=' + (itemResult.success ? 'SUCCESS' : 'FAILED') +
      ' | APPROVED=' + itemResult.approvedStreams + ' | REJECTED=' + itemResult.rejectedStreams
    );
    console.log(
      '[CHECKPOINT] COMPLETED=' + batch.completedItems.length + '/' + batch.items.length +
      ' | PENDING=' + batch.pendingItems.length +
      ' | BROWSER=' + batch.browserScanned + ' | REUSED=' + batch.globallyReused +
      ' | SUCCESS=' + batch.successful + ' | FAILED=' + batch.failed
    );
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
    'Selection Mode': batch.selectionMode || 'automatic',
    'Selected Category': batch.categoryName, 'Category ID': batch.categoryId,
    'Previously Processed In Category': batch.categoryProcessedBefore || 0,
    'Previously Processed Movies': (batch.previousTypeCounts && batch.previousTypeCounts.movies) || 0,
    'Previously Processed Series': (batch.previousTypeCounts && batch.previousTypeCounts.series) || 0,
    'Previously Processed Episodes': (batch.previousTypeCounts && batch.previousTypeCounts.episodes) || 0,
    'Discovered': batch.discovered,
    'New Items Found': batch.newItemsFound, 'Batch Items': batch.items.length,
    'Movies': itemTypes.movie, 'Series': itemTypes.series, 'Episodes': itemTypes.episode,
    'Browser Scanned': batch.browserScanned, 'Globally Reused': batch.globallyReused,
    'Successful': batch.successful, 'Failed': batch.failed,
    'Approved Streams': batch.approvedStreams, 'Rejected Streams': batch.rejectedStreams,
    'Unique URLs': uniqueUrls.size,
    'Category Processed After Batch': batch.categoryProcessedAfter || 0,
    'New Successful Items Added To Master': batch.masterItemsAdded || 0,
    'Master Items Before': batch.masterItemsBefore || 0,
    'Master Items After': batch.masterItemsAfter || 0,
    'Master Streams Before': batch.masterStreamsBefore || 0,
    'Master Streams After': batch.masterStreamsAfter || 0,
    'Pushed Category Output': batch.categoryOutput || '',
    'Pointer Advanced': batch.pointerAdvanced,
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
    showCategoryIndex(state);
    let selected;
    let freshItems = [];
    let selectionMode = options.category ? 'manual' : 'automatic';
    const beforeOutputs = core.aggregateOutputs(state);
    if (!state.categoryOrder.length) {
      const index = await initializeCategoryIndex(source, options);
      if (!index.categories.length) throw new Error('No source categories discovered');
      core.mergeCategoryOrder(state, index.categories);
      core.mergeDiscoveredItems(state, index.items);
      showCategoryIndex(state);
    }
    if (state.activeBatch) {
      selected = state.categoryOrder.find((entry) => entry.id === state.activeBatch.categoryId);
      if (!selected) throw new Error('Active batch category is missing');
      if (options.category && resolveCategorySelection(state, options.category).id !== selected.id) {
        throw new Error('An unfinished batch exists for ' + selected.name + '; finish it before manually selecting another category.');
      }
      selectionMode = state.activeBatch.selectionMode || 'resume';
      freshItems = state.activeBatch.items.map((id) => state.catalog[id]).filter(Boolean);
      console.log('[RESUME BATCH] CATEGORY="' + state.activeBatch.categoryName + '" | COMPLETED=' +
        state.activeBatch.completedItems.length + ' | PENDING=' + state.activeBatch.pendingItems.length);
    } else {
      selected = resolveCategorySelection(state, options.category);
      console.log('\n================ SCAN SELECTION ======================');
      console.log('MODE: ' + selectionMode.toUpperCase());
      console.log('CATEGORY: ' + selected.name);
      console.log('CATEGORY ID: ' + selected.id);
      console.log('SOURCE PAGE: ' + selected.url);
      console.log('PREVIOUSLY PROCESSED: ' + (state.categoryHistory[selected.id] || []).length);
      console.log('======================================================');
      console.log('[FRESH DISCOVERY] Reading selected category from the top...');
      freshItems = await discoverSelectedCategory(selected, options);
      freshItems = await expandSeriesLazily(freshItems, selected, state.categoryHistory[selected.id], options.maxItems);
      console.log('[FRESH DISCOVERY COMPLETE] CATEGORY="' + selected.name + '" | ITEMS SEEN=' +
        freshItems.length + ' | PREVIOUSLY PROCESSED=' + (state.categoryHistory[selected.id] || []).length);
    }
    const batch = core.prepareActiveBatch(state, selected, freshItems, options.maxItems);
    if (!batch.selectionMode) batch.selectionMode = selectionMode;
    if (batch.categoryProcessedBefore === undefined) {
      batch.categoryProcessedBefore = (state.categoryHistory[selected.id] || []).length;
      batch.masterItemsBefore = beforeOutputs.items.length;
      batch.masterStreamsBefore = beforeOutputs.streams.length;
    }
    if (!batch.previousTypeCounts) {
      batch.previousTypeCounts = countContentTypes(state, state.categoryHistory[selected.id] || []);
    }
    batch.batchTypeCounts = countContentTypes(state, batch.items);
    showBatchQueue(state, batch);
    console.log('[BATCH SUMMARY BEFORE SCAN] CATEGORY="' + selected.name +
      '" | PREVIOUSLY PROCESSED=' + batch.categoryProcessedBefore +
      ' (MOVIES=' + batch.previousTypeCounts.movies + ', SERIES=' + batch.previousTypeCounts.series +
      ', EPISODES=' + batch.previousTypeCounts.episodes + ')' +
      ' | DISCOVERED NOW=' + batch.discovered + ' | NEW FOUND=' + batch.newItemsFound +
      ' | SELECTED=' + batch.items.length +
      ' (MOVIES=' + batch.batchTypeCounts.movies + ', SERIES=' + batch.batchTypeCounts.series +
      ', EPISODES=' + batch.batchTypeCounts.episodes + ')' +
      ' | PENDING=' + batch.pendingItems.length);
    core.saveState(paths.state, state);
    core.appendHistory(__dirname, {
      event: 'batch-start', selectionMode: batch.selectionMode, categoryId: selected.id,
      categoryName: selected.name, batchId: batch.id, itemCount: batch.items.length
    });
    if (batch.pendingItems.length) await processWithCoordinator(state, batch, source, options, paths);
    core.completeBatch(state, { advancePointer: batch.selectionMode !== 'manual' });
    state.updatedAt = new Date().toISOString();
    core.writeOutputs(__dirname, state);
    const afterOutputs = core.aggregateOutputs(state);
    state.lastBatch.masterItemsAfter = afterOutputs.items.length;
    state.lastBatch.masterStreamsAfter = afterOutputs.streams.length;
    state.lastBatch.masterItemsAdded = afterOutputs.items.length - state.lastBatch.masterItemsBefore;
    state.lastBatch.masterStreamsAdded = afterOutputs.streams.length - state.lastBatch.masterStreamsBefore;
    state.lastBatch.categoryOutput = 'output/categories/' + core.slugify(selected.type + '-' + selected.name) + '/';
    state.categoryLastBatch[selected.id] = state.lastBatch;
    core.saveState(paths.state, state);
    core.appendHistory(__dirname, { event: 'batch-complete', categoryId: selected.id, batch: state.lastBatch });
    const report = realReport(state);
    console.log('\n================ OUTPUT PUSH DATA ====================');
    console.log('CATEGORY OUTPUT: ' + state.lastBatch.categoryOutput);
    console.log('MASTER ITEMS: ' + state.lastBatch.masterItemsBefore + ' BEFORE -> ' +
      state.lastBatch.masterItemsAfter + ' AFTER | ADDED=' + state.lastBatch.masterItemsAdded);
    console.log('MASTER STREAMS: ' + state.lastBatch.masterStreamsBefore + ' BEFORE -> ' +
      state.lastBatch.masterStreamsAfter + ' AFTER | ADDED=' + state.lastBatch.masterStreamsAdded);
    console.log('CATEGORY HISTORY: ' + state.lastBatch.categoryProcessedBefore + ' BEFORE -> ' +
      state.lastBatch.categoryProcessedAfter + ' AFTER');
    console.log('======================================================');
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
  parseArgs, categoryItemCounts, countContentTypes, resolveCategorySelection, sourceConfig, surfaceSeeds, extractSurface,
  initializeCategoryIndex, discoverSelectedCategory, expandSeriesLazily, processWithCoordinator, realReport
};
