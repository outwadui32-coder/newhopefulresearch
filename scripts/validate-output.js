'use strict';

const fs = require('node:fs');
const path = require('node:path');
const core = require('../lib/scanner-core');

const REQUIRED_SUMMARY = [
  'CATEGORY', 'DISCOVERED', 'PROCESSED', 'SUCCESSFUL', 'FAILED', 'MOVIES', 'SERIES',
  'EPISODES', 'BATCH_SIZE', 'BROWSER_SCANNED', 'REUSED', 'STREAM_LINKS',
  'UNIQUE_STREAM_URLS', 'REMAINING_NEW_ITEMS', 'NEXT_CATEGORY', 'LAST_UPDATED'
];

function filesRecursively(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const value = path.join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(value) : [value];
  });
}

function countTextUrls(text) {
  return (text.match(/^URL: https?:\/\/.+$/gm) || []).length;
}

function countM3uUrls(text) {
  return text.split(/\r?\n/).filter((line) => /^https?:\/\//i.test(line.trim())).length;
}

function validateSummary(summary, label, errors) {
  for (const key of REQUIRED_SUMMARY) {
    if (!Object.prototype.hasOwnProperty.call(summary || {}, key)) errors.push(label + ': missing summary ' + key);
  }
  if ((summary && summary.BATCH_SIZE) > 20) errors.push(label + ': batch exceeds 20');
}

function validateTriplet(jsonPath, textPath, m3uPath, errors) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); }
  catch (error) {
    errors.push(jsonPath + ': JSON parse failed: ' + error.message);
    return;
  }
  validateSummary(parsed.summary, jsonPath, errors);
  const text = fs.readFileSync(textPath, 'utf8');
  const m3u = fs.readFileSync(m3uPath, 'utf8');
  const streamCount = (parsed.streams || []).length;
  const textCount = countTextUrls(text);
  const m3uCount = countM3uUrls(m3u);
  if (streamCount !== textCount || streamCount !== m3uCount) {
    errors.push(jsonPath + ': JSON/TXT/M3U mismatch ' + streamCount + '/' + textCount + '/' + m3uCount);
  }
  if (/#EXTVLCOPT|#EXTHTTP|Referer:|Origin:|Cookie:|Authorization:/i.test(m3u + '\n' + text)) {
    errors.push(jsonPath + ': header-dependent directive found');
  }
  for (const item of parsed.items || []) {
    if (!item.poster || !/^https?:\/\//i.test(item.poster)) errors.push(jsonPath + ': missing poster for ' + item.canonicalId);
  }
  const canonicalIds = (parsed.items || []).map((item) => item.canonicalId);
  if (new Set(canonicalIds).size !== canonicalIds.length) errors.push(jsonPath + ': duplicate canonical ID');
  const urls = (parsed.streams || []).map((stream) => stream.url);
  if (new Set(urls).size !== urls.length) errors.push(jsonPath + ': duplicate stream URL');
  for (const stream of parsed.streams || []) {
    if (!core.APPROVED_SERVERS.includes(stream.server)) errors.push(jsonPath + ': non-approved server ' + stream.server);
    if (!core.is1080Class(stream.resolution)) errors.push(jsonPath + ': sub-1080 stream ' + stream.resolution);
    if (stream.directPlaybackNoHeaders !== true) errors.push(jsonPath + ': stream was not no-header verified');
    if (core.isFragment(stream.url)) errors.push(jsonPath + ': fragment URL published');
    if (!['hls', 'dash'].includes(stream.kind)) errors.push(jsonPath + ': unsupported published kind ' + stream.kind);
  }
  return parsed;
}

function validate(root) {
  const errors = [];
  const paths = core.outputPaths(root);
  const stateFiles = fs.existsSync(paths.stateDir)
    ? fs.readdirSync(paths.stateDir).filter((name) => name.endsWith('.json'))
    : [];
  if (stateFiles.length !== 1 || stateFiles[0] !== 'scanner-state.json') {
    errors.push('Exactly one authoritative state JSON is required');
  }
  if (fs.existsSync(path.join(root, 'catalog-stream-results.json'))) errors.push('Legacy state remains active');
  let state;
  try { state = JSON.parse(fs.readFileSync(paths.state, 'utf8')); }
  catch (error) { errors.push('scanner-state.json parse failed: ' + error.message); }
  if (state) {
    if (state.schemaVersion !== core.STATE_VERSION) errors.push('Wrong state schema');
    if (state.activeBatch) errors.push('Incomplete activeBatch cannot be published');
    if (!Array.isArray(state.categoryOrder) || !state.categoryOrder.length) errors.push('Category order is empty');
    if (state.categoryOrder.length && (state.nextCategoryIndex < 0 || state.nextCategoryIndex >= state.categoryOrder.length)) {
      errors.push('Category pointer is out of range');
    }
    if (!state.migrations || !state.migrations.legacyV1Complete) errors.push('Legacy migration not completed');
    if (state.lastBatch && state.lastBatch.items.length > 20) errors.push('Last batch exceeds 20');
    for (const [category, values] of Object.entries(state.categoryHistory || {})) {
      if (new Set(values).size !== values.length) errors.push('Duplicate category history: ' + category);
    }
  }
  const master = validateTriplet(paths.masterJson, paths.masterText, paths.masterM3u, errors);
  if (master && state) {
    if (master.items.length < (state.outputFloor && state.outputFloor.itemCount || 0)) errors.push('Old items were deleted');
    if (master.streams.length < (state.outputFloor && state.outputFloor.streamCount || 0)) errors.push('Old streams were deleted');
    const masterUrls = new Set(master.streams.map((stream) => stream.url));
    for (const item of master.items) {
      for (const url of item.streamUrls || []) if (!masterUrls.has(url)) errors.push('Item references missing stream URL');
      for (const category of item.categories || []) {
        if (!state.categoryOrder.some((entry) => entry.id === category.id)) errors.push('Unknown category membership ' + category.id);
      }
    }
  }
  for (const directory of fs.existsSync(paths.categories)
    ? fs.readdirSync(paths.categories, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : []) {
    const base = path.join(paths.categories, directory.name);
    for (const name of ['category.json', 'streams.txt', 'playlist.m3u']) {
      if (!fs.existsSync(path.join(base, name))) errors.push(base + ': missing ' + name);
    }
    if (['category.json', 'streams.txt', 'playlist.m3u'].every((name) => fs.existsSync(path.join(base, name)))) {
      validateTriplet(path.join(base, 'category.json'), path.join(base, 'streams.txt'), path.join(base, 'playlist.m3u'), errors);
    }
  }
  for (const filePath of filesRecursively(paths.history)) {
    for (const [index, line] of fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).entries()) {
      try { JSON.parse(line); } catch (error) { errors.push(filePath + ':' + (index + 1) + ' invalid JSONL'); }
    }
  }
  const allJson = filesRecursively(paths.output).filter((file) => file.endsWith('.json'));
  for (const filePath of allJson) {
    try { JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (error) { errors.push(filePath + ': JSON parse failed'); }
  }
  return { ok: errors.length === 0, errors: errors, checkedJson: allJson.length };
}

if (require.main === module) {
  const result = validate(path.resolve(__dirname, '..'));
  if (!result.ok) {
    console.error('VALIDATION FAIL');
    for (const error of result.errors) console.error('- ' + error);
    process.exitCode = 1;
  } else {
    console.log('VALIDATION PASS');
    console.log('JSON files checked: ' + result.checkedJson);
  }
}

module.exports = { REQUIRED_SUMMARY, countTextUrls, countM3uUrls, validateTriplet, validate };
