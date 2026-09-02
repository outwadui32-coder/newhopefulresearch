'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_VERSION = 2;
const MAX_BATCH_SIZE = 20;
const APPROVED_SERVERS = Object.freeze(['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast']);
const APPROVED_SERVER_KEYS = new Set(APPROVED_SERVERS.map((value) => value.toLowerCase()));

function slugify(value) {
  return String(value || 'uncategorized').normalize('NFKD').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'uncategorized';
}

function canonicalId(item) {
  if (item && item.canonicalId) return String(item.canonicalId);
  try {
    const target = new URL(item.url);
    const pathMatch = target.pathname.match(/(?:movie|tv)[^/]*\/(?:[^/]*-)?(\d+)(?:\/watch)?\/?$/i) ||
      target.pathname.match(/(\d+)(?=\/watch\/?$)/i);
    const id = target.searchParams.get('id') || (pathMatch && pathMatch[1]);
    const routeType = (target.pathname.match(/^\/(movie|tv)\//i) || [])[1];
    const type = target.searchParams.get('type') || routeType || item.contentType || 'movie';
    const season = target.searchParams.get('season') !== null ? target.searchParams.get('season') : item.seasonNumber;
    const episode = target.searchParams.get('episode') !== null ? target.searchParams.get('episode') : item.episodeNumber;
    if (id && type === 'tv' && season !== null && season !== undefined && episode !== null && episode !== undefined) {
      return 'tv:' + id + ':s' + String(season).padStart(2, '0') + ':e' + String(episode).padStart(2, '0');
    }
    if (id) return (type === 'tv' || type === 'series' ? 'tv:' : 'movie:') + id;
  } catch (_) {}
  return 'url:' + crypto.createHash('sha256').update(String((item && item.url) || '')).digest('hex').slice(0, 24);
}

function contentType(item) {
  if (item && item.contentType) return item.contentType;
  const id = canonicalId(item);
  if (/^tv:.+:s\d+:e\d+$/i.test(id)) return 'episode';
  if (/^tv:/i.test(id)) return 'series';
  return 'movie';
}

function categoryId(name, type) {
  return String(type || 'collection') + ':' + slugify(name);
}

function normalizeCategory(raw) {
  if (typeof raw === 'string') {
    const separator = raw.indexOf(':');
    const surface = separator > 0 ? raw.slice(0, separator).trim() : '';
    const name = separator > 0 ? raw.slice(separator + 1).trim() : raw.trim();
    return { id: categoryId(name), name: name || 'Uncategorized', type: 'collection', surface: surface };
  }
  raw = raw || {};
  const name = String(raw.name || raw.label || 'Uncategorized').trim();
  const type = String(raw.type || 'collection').trim();
  return { id: raw.id || categoryId(name, type), name: name, type: type, surface: raw.surface || '', url: raw.url || null };
}

function itemCategories(item) {
  const values = Array.isArray(item && item.categories) && item.categories.length ? item.categories : ['Uncategorized'];
  return [...new Map(values.map((value) => {
    const normalized = normalizeCategory(value);
    return [normalized.id, normalized];
  })).values()];
}

function emptyState(sourceUrl) {
  return {
    schemaVersion: STATE_VERSION,
    scanner: 'github-category-direct-stream-scanner',
    sourceUrl: sourceUrl,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    categoryOrder: [],
    nextCategoryIndex: 0,
    categoryHistory: {},
    globalCanonicalHistory: {},
    catalog: {},
    results: {},
    activeBatch: null,
    lastBatch: null,
    categoryLastBatch: {},
    migrations: { legacyV1Complete: false, completedAt: null },
    outputFloor: { itemCount: 0, streamCount: 0 }
  };
}

function mergeCategoryOrder(state, discovered) {
  const incoming = [...new Map(discovered.map((entry) => {
    const normalized = normalizeCategory(entry);
    return [normalized.id, normalized];
  })).values()];
  const incomingById = new Map(incoming.map((entry) => [entry.id, entry]));
  const stable = [];
  for (const old of state.categoryOrder || []) {
    if (incomingById.has(old.id)) {
      stable.push(Object.assign({}, old, incomingById.get(old.id)));
      incomingById.delete(old.id);
    } else stable.push(old);
  }
  stable.push(...incomingById.values());
  state.categoryOrder = stable;
  state.nextCategoryIndex = stable.length ? Math.max(0, Number(state.nextCategoryIndex) || 0) % stable.length : 0;
  for (const category of stable) {
    if (!Array.isArray(state.categoryHistory[category.id])) state.categoryHistory[category.id] = [];
  }
  return stable;
}

function selectedCategory(state) {
  if (!state.categoryOrder.length) return null;
  return state.categoryOrder[state.nextCategoryIndex % state.categoryOrder.length];
}

function mergeDiscoveredItems(state, items) {
  for (const raw of items) {
    const id = canonicalId(raw);
    const existing = state.catalog[id] || {};
    const priorMemberships = state.catalog[id] ? itemCategories(existing) : [];
    const memberships = [...new Map([...priorMemberships, ...itemCategories(raw)].map((entry) => [entry.id, entry])).values()];
    state.catalog[id] = Object.assign({}, existing, raw, {
      canonicalId: id,
      contentType: contentType(raw),
      categories: memberships,
      lastDiscoveredAt: new Date().toISOString()
    });
  }
}

function prepareActiveBatch(state, category, freshItems, maxItems) {
  maxItems = maxItems || MAX_BATCH_SIZE;
  if (maxItems < 1 || maxItems > MAX_BATCH_SIZE) throw new Error('Batch max must be 1-' + MAX_BATCH_SIZE);
  mergeDiscoveredItems(state, freshItems);
  if (state.activeBatch) {
    if (state.activeBatch.categoryId !== category.id) {
      throw new Error('Active batch belongs to ' + state.activeBatch.categoryId + '; refusing to jump to ' + category.id);
    }
    return state.activeBatch;
  }
  const processed = new Set(state.categoryHistory[category.id] || []);
  const seen = new Set();
  const candidateIds = [];
  for (const item of freshItems) {
    const id = canonicalId(item);
    if (seen.has(id) || processed.has(id)) continue;
    seen.add(id);
    candidateIds.push(id);
    if (candidateIds.length === maxItems) break;
  }
  state.activeBatch = {
    id: crypto.randomUUID(),
    categoryId: category.id,
    categoryName: category.name,
    items: candidateIds,
    completedItems: [],
    pendingItems: candidateIds.slice(),
    startedAt: new Date().toISOString(),
    discovered: freshItems.length,
    newItemsFound: freshItems.filter((item) => !processed.has(canonicalId(item))).length,
    browserScanned: 0,
    globallyReused: 0,
    successful: 0,
    failed: 0,
    approvedStreams: 0,
    rejectedStreams: 0
  };
  return state.activeBatch;
}

function is1080Class(value) {
  const dimensions = String(value || '').match(/^(\d+)x(\d+)$/i);
  if (dimensions) return Number(dimensions[1]) >= 1900 || Number(dimensions[2]) >= 1080;
  const height = String(value || '').match(/^(\d+)p$/i);
  return Boolean(height && Number(height[1]) >= 1080);
}

function isFragment(url) {
  let decoded = String(url || '');
  try { decoded = decodeURIComponent(decoded); } catch (_) {}
  return /(?:\.ts|\.m4s|\.cmfv|\.cmfa|\.aac)(?:$|[?#])/i.test(decoded) ||
    /(?:^|[/?&])(segment|chunk)[-_=/]?\d/i.test(decoded);
}

function streamIsPublishable(stream) {
  return Boolean(stream && APPROVED_SERVER_KEYS.has(String(stream.server || '').toLowerCase()) &&
    stream.probe && stream.probe.ok === true && stream.probe.directPlaybackNoHeaders === true &&
    is1080Class(stream.probe.resolution) && /^https?:\/\//i.test(stream.url || '') && !isFragment(stream.url));
}

function normalizeScan(scan) {
  scan = scan || {};
  const finalStreams = (scan.finalStreams || []).map((stream) => {
    const clean = Object.assign({}, stream);
    delete clean.headers;
    return clean;
  });
  const approved = finalStreams.filter(streamIsPublishable);
  return Object.assign({}, scan, {
    finalStreams: finalStreams,
    success: approved.length > 0,
    verifiedAt: scan.finishedAt || new Date().toISOString(),
    streamValid: approved.length > 0,
    needsRefresh: approved.length === 0
  });
}

function checkpointBatchItem(state, canonical, scan, mode) {
  const batch = state.activeBatch;
  if (!batch || !batch.items.includes(canonical)) throw new Error('Item ' + canonical + ' is not in active batch');
  if (batch.completedItems.includes(canonical)) return;
  const normalized = normalizeScan(scan);
  const previous = state.results[canonical] || {};
  state.results[canonical] = Object.assign({}, previous, state.catalog[canonical] || {}, {
    canonicalId: canonical,
    processed: true,
    verified: normalized.success,
    verifiedAt: normalized.verifiedAt,
    streamValid: normalized.streamValid,
    needsRefresh: normalized.needsRefresh,
    scan: normalized
  });
  state.globalCanonicalHistory[canonical] = {
    processed: true,
    verified: normalized.success,
    verifiedAt: normalized.verifiedAt,
    streamValid: normalized.streamValid,
    needsRefresh: normalized.needsRefresh
  };
  batch.completedItems.push(canonical);
  batch.pendingItems = batch.items.filter((id) => !batch.completedItems.includes(id));
  if (mode === 'reuse') batch.globallyReused += 1;
  else batch.browserScanned += 1;
  if (normalized.success) batch.successful += 1;
  else batch.failed += 1;
  batch.approvedStreams += normalized.finalStreams.filter(streamIsPublishable).length;
  batch.rejectedStreams += normalized.finalStreams.filter((stream) => !streamIsPublishable(stream)).length;
}

function canReuse(state, canonical) {
  const result = state.results[canonical];
  return Boolean(state.globalCanonicalHistory[canonical] && state.globalCanonicalHistory[canonical].verified &&
    result && result.scan && result.scan.success && (result.scan.finalStreams || []).some(streamIsPublishable));
}

function completeBatch(state) {
  const batch = state.activeBatch;
  if (!batch) throw new Error('No active batch');
  if (batch.pendingItems.length || batch.completedItems.length !== batch.items.length) {
    throw new Error('Batch incomplete: ' + batch.pendingItems.length + ' pending');
  }
  const history = new Set(state.categoryHistory[batch.categoryId] || []);
  for (const id of batch.completedItems) history.add(id);
  state.categoryHistory[batch.categoryId] = [...history];
  const currentIndex = state.categoryOrder.findIndex((entry) => entry.id === batch.categoryId);
  if (currentIndex < 0) throw new Error('Batch category missing from category order');
  state.nextCategoryIndex = (currentIndex + 1) % state.categoryOrder.length;
  state.lastBatch = Object.assign({}, batch, {
    completedAt: new Date().toISOString(),
    nextCategoryId: state.categoryOrder[state.nextCategoryIndex] && state.categoryOrder[state.nextCategoryIndex].id
  });
  state.categoryLastBatch[batch.categoryId] = state.lastBatch;
  state.activeBatch = null;
  return state.lastBatch;
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, filePath);
}

function loadState(filePath, sourceUrl) {
  if (!fs.existsSync(filePath)) return emptyState(sourceUrl);
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (state.schemaVersion !== STATE_VERSION) throw new Error('Unsupported state schema ' + state.schemaVersion);
  if (state.sourceUrl !== sourceUrl) throw new Error('MAIN_SOURCE_URL does not match persisted scanner state');
  return state;
}

function saveState(filePath, state) {
  state.updatedAt = new Date().toISOString();
  atomicWriteJson(filePath, state);
}

function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(handle, String(process.pid) + '\n' + new Date().toISOString() + '\n');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Scanner lock already exists: ' + lockPath);
    throw error;
  }
  return function release() {
    try { fs.closeSync(handle); } catch (_) {}
    try { fs.unlinkSync(lockPath); } catch (_) {}
  };
}

function posterUrl(item) {
  if (typeof (item && item.poster) === 'string') return item.poster;
  const poster = (item && item.poster) || {};
  return poster.original || poster.medium || poster.thumbnail || (item && (item.posterUrl || item.image || item.stillUrl)) || '';
}

function aggregateOutputs(state) {
  const itemMap = new Map();
  const streamMap = new Map();
  for (const [id, result] of Object.entries(state.results || {})) {
    const approved = (result.scan && result.scan.finalStreams || []).filter(streamIsPublishable);
    if (!approved.length) continue;
    const memberships = itemCategories(result);
    const record = {
      canonicalId: id, contentType: contentType(result), title: result.title, sourceUrl: result.url,
      poster: posterUrl(result), seriesId: result.seriesId || null, seriesTitle: result.seriesTitle || null,
      seasonNumber: result.seasonNumber === undefined ? null : result.seasonNumber,
      episodeNumber: result.episodeNumber === undefined ? null : result.episodeNumber,
      episodeTitle: result.episodeTitle || null, airDate: result.airDate || null,
      categories: memberships, verifiedAt: result.verifiedAt, streamUrls: []
    };
    for (const stream of approved) {
      if (!streamMap.has(stream.url)) {
        streamMap.set(stream.url, {
          url: stream.url,
          server: APPROVED_SERVERS.find((name) => name.toLowerCase() === String(stream.server).toLowerCase()),
          kind: stream.kind || (stream.probe && stream.probe.verifiedKind),
          resolution: stream.probe.resolution,
          directPlaybackNoHeaders: true,
          canonicalIds: [],
          categories: []
        });
      }
      const globalStream = streamMap.get(stream.url);
      if (!globalStream.canonicalIds.includes(id)) globalStream.canonicalIds.push(id);
      for (const category of memberships) {
        if (!globalStream.categories.some((entry) => entry.id === category.id)) globalStream.categories.push(category);
      }
      record.streamUrls.push(stream.url);
    }
    itemMap.set(id, record);
  }
  return { items: [...itemMap.values()], streams: [...streamMap.values()] };
}

function countTypes(items) {
  return {
    movies: items.filter((item) => item.contentType === 'movie').length,
    series: items.filter((item) => item.contentType === 'series').length,
    episodes: items.filter((item) => item.contentType === 'episode').length
  };
}

function reportSummary(state, category) {
  const aggregate = aggregateOutputs(state);
  const selectedItems = category
    ? aggregate.items.filter((item) => item.categories.some((entry) => entry.id === category.id))
    : aggregate.items;
  const urls = new Set(selectedItems.flatMap((item) => item.streamUrls));
  const batch = category
    ? ((state.categoryLastBatch && state.categoryLastBatch[category.id]) ||
      (state.activeBatch && state.activeBatch.categoryId === category.id ? state.activeBatch : null))
    : (state.lastBatch || state.activeBatch);
  const batchTypes = countTypes(((batch && batch.items) || []).map((id) => state.catalog[id]).filter(Boolean));
  const allTypes = countTypes(aggregate.items);
  return {
    CATEGORY: category ? category.name : 'MASTER',
    DISCOVERED: category ? ((batch && batch.discovered) || 0) : Object.keys(state.catalog).length,
    PROCESSED: category ? ((state.categoryHistory[category.id] || []).length) : Object.keys(state.globalCanonicalHistory).length,
    SUCCESSFUL: category ? ((batch && batch.successful) || 0) : aggregate.items.length,
    FAILED: category ? ((batch && batch.failed) || 0) : Object.values(state.results).filter((item) => !item.verified).length,
    MOVIES: category ? batchTypes.movies : allTypes.movies,
    SERIES: category ? batchTypes.series : allTypes.series,
    EPISODES: category ? batchTypes.episodes : allTypes.episodes,
    BATCH_SIZE: (batch && batch.items && batch.items.length) || 0,
    BROWSER_SCANNED: (batch && batch.browserScanned) || 0,
    REUSED: (batch && batch.globallyReused) || 0,
    STREAM_LINKS: urls.size,
    UNIQUE_STREAM_URLS: urls.size,
    REMAINING_NEW_ITEMS: Math.max(0, ((batch && batch.newItemsFound) || 0) - ((batch && batch.items && batch.items.length) || 0)),
    NEXT_CATEGORY: (state.categoryOrder[state.nextCategoryIndex] && state.categoryOrder[state.nextCategoryIndex].name) || null,
    LAST_UPDATED: state.updatedAt || new Date().toISOString()
  };
}

function summaryLines(summary, prefix) {
  prefix = prefix || '';
  return Object.entries(summary).map(([key, value]) => prefix + key + ': ' + (value === null || value === undefined ? '' : value));
}

function writeText(filePath, summary, items, streams) {
  const byCanonical = new Map(items.map((item) => [item.canonicalId, item]));
  const lines = summaryLines(summary).concat(['']);
  for (const stream of streams) {
    const item = stream.canonicalIds.map((id) => byCanonical.get(id)).find(Boolean);
    if (!item) continue;
    lines.push('Title: ' + item.title, 'Canonical ID: ' + stream.canonicalIds.join(', '),
      'Content Type: ' + item.contentType, 'Poster: ' + item.poster,
      'Categories: ' + stream.categories.map((entry) => entry.name).join(', '),
      'Server: ' + stream.server, 'Resolution: ' + stream.resolution,
      'Type: ' + stream.kind, 'URL: ' + stream.url, '');
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function m3uSafe(value) {
  return String(value || '').replace(/["\r\n]/g, ' ').trim();
}

function writeM3u(filePath, summary, items, streams) {
  const byCanonical = new Map(items.map((item) => [item.canonicalId, item]));
  const lines = ['#EXTM3U'].concat(summaryLines(summary, '# '));
  for (const stream of streams) {
    const item = stream.canonicalIds.map((id) => byCanonical.get(id)).find(Boolean);
    if (!item) continue;
    lines.push('#EXTINF:-1 tvg-id="' + m3uSafe(stream.canonicalIds.join(' | ')) + '" tvg-logo="' + m3uSafe(item.poster) +
      '" group-title="' + m3uSafe(stream.categories.map((entry) => entry.name).join(' | ')) + '",' +
      m3uSafe(item.title) + ' [' + m3uSafe(stream.server) + ' ' + m3uSafe(stream.resolution) + ']', stream.url);
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function outputPaths(root) {
  const output = path.join(root, 'output');
  return {
    output: output, stateDir: path.join(output, 'state'), state: path.join(output, 'state', 'scanner-state.json'),
    lock: path.join(output, 'state', 'scanner.lock'), master: path.join(output, 'master'),
    masterJson: path.join(output, 'master', 'catalog.json'), masterText: path.join(output, 'master', 'streams.txt'),
    masterM3u: path.join(output, 'master', 'playlist.m3u'), categories: path.join(output, 'categories'),
    history: path.join(output, 'history')
  };
}

function ensureOutputTree(paths) {
  for (const key of ['stateDir', 'master', 'categories', 'history']) fs.mkdirSync(paths[key], { recursive: true });
}

function categoryAggregate(aggregate, category) {
  const items = aggregate.items.filter((item) => item.categories.some((entry) => entry.id === category.id));
  const urls = new Set(items.flatMap((item) => item.streamUrls));
  return { items: items, streams: aggregate.streams.filter((stream) => urls.has(stream.url)) };
}

function writeOutputs(root, state) {
  const paths = outputPaths(root);
  ensureOutputTree(paths);
  const aggregate = aggregateOutputs(state);
  const masterSummary = reportSummary(state);
  const masterPayload = { summary: masterSummary, categories: state.categoryOrder, items: aggregate.items, streams: aggregate.streams };
  atomicWriteJson(paths.masterJson, masterPayload);
  writeText(paths.masterText, masterSummary, aggregate.items, aggregate.streams);
  writeM3u(paths.masterM3u, masterSummary, aggregate.items, aggregate.streams);
  for (const category of state.categoryOrder) {
    const subset = categoryAggregate(aggregate, category);
    const summary = reportSummary(state, category);
    const directory = path.join(paths.categories, slugify(category.type + '-' + category.name));
    fs.mkdirSync(directory, { recursive: true });
    atomicWriteJson(path.join(directory, 'category.json'), { category: category, summary: summary, items: subset.items, streams: subset.streams });
    writeText(path.join(directory, 'streams.txt'), summary, subset.items, subset.streams);
    writeM3u(path.join(directory, 'playlist.m3u'), summary, subset.items, subset.streams);
  }
  state.outputFloor = {
    itemCount: Math.max((state.outputFloor && state.outputFloor.itemCount) || 0, aggregate.items.length),
    streamCount: Math.max((state.outputFloor && state.outputFloor.streamCount) || 0, aggregate.streams.length)
  };
  return { paths: paths, masterPayload: masterPayload };
}

function appendHistory(root, event) {
  const paths = outputPaths(root);
  ensureOutputTree(paths);
  const filePath = path.join(paths.history, new Date().toISOString().slice(0, 10) + '.jsonl');
  fs.appendFileSync(filePath, JSON.stringify(Object.assign({ timestamp: new Date().toISOString() }, event)) + '\n', 'utf8');
}

function migrateLegacyOnce(root, state) {
  if (state.migrations && state.migrations.legacyV1Complete) return { imported: 0, skipped: true };
  const candidates = [path.join(root, 'catalog-stream-results.json'), path.join(root, 'data', 'movies.json')];
  let imported = 0;
  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const values = Array.isArray(parsed) ? parsed : parsed.movies || parsed.results || [];
      for (const value of values) {
        const url = value.pageUrl || value.source_url || value.watch_url;
        if (!url) continue;
        const item = { title: value.title || value.name, url: url, poster: value.poster };
        const id = canonicalId(item);
        if (!state.catalog[id]) {
          state.catalog[id] = Object.assign({}, item, { canonicalId: id, contentType: contentType(item), categories: [normalizeCategory('Legacy Import')] });
          imported += 1;
        }
      }
    } catch (_) {}
  }
  state.migrations = { legacyV1Complete: true, completedAt: new Date().toISOString(), imported: imported };
  return { imported: imported, skipped: false };
}

module.exports = {
  STATE_VERSION, MAX_BATCH_SIZE, APPROVED_SERVERS, slugify, canonicalId, contentType, categoryId,
  normalizeCategory, itemCategories, emptyState, mergeCategoryOrder, selectedCategory, mergeDiscoveredItems,
  prepareActiveBatch, streamIsPublishable, is1080Class, isFragment, normalizeScan, checkpointBatchItem,
  canReuse, completeBatch, atomicWriteJson, loadState, saveState, acquireLock, posterUrl, aggregateOutputs,
  reportSummary, outputPaths, ensureOutputTree, writeOutputs, appendHistory, migrateLegacyOnce
};
