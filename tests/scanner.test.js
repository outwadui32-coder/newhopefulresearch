'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('../lib/scanner-core');
const collector = require('../collector');
const validator = require('../scripts/validate-output');

const passed = [];

function test(name, callback) {
  try {
    callback();
    passed.push(name);
    console.log('PASS ' + name);
  } catch (error) {
    console.error('FAIL ' + name);
    throw error;
  }
}

function category(name) {
  return { id: core.categoryId(name), name: name, type: 'collection', url: 'https://source.example/' + name.toLowerCase() };
}

function item(id, categories, type) {
  return {
    canonicalId: id,
    title: id,
    url: 'https://source.example/play?id=' + id.replace(/\D/g, '') + '&type=' + (type === 'movie' ? 'movie' : 'tv'),
    contentType: type || 'movie',
    poster: 'https://image.example/' + id.replace(/[^a-z0-9]/gi, '-') + '.jpg',
    categories: categories
  };
}

function stream(url, server, resolution) {
  return {
    url: url,
    server: server || 'Alpha',
    kind: 'hls',
    probe: { ok: true, directPlaybackNoHeaders: true, resolution: resolution || '1920x800', verifiedKind: 'hls' }
  };
}

function scan(url, server, resolution) {
  return { success: true, finishedAt: new Date().toISOString(), finalStreams: [stream(url, server, resolution)] };
}

function finish(state, categoryValue, items, scans) {
  core.prepareActiveBatch(state, categoryValue, items, 20);
  for (const candidate of state.activeBatch.items) {
    core.checkpointBatchItem(state, candidate, scans[candidate] || scan('https://media.example/' + candidate + '.m3u8'), 'browser');
  }
  return core.completeBatch(state);
}

test('stable category rotation and last-to-first wrap', () => {
  const state = core.emptyState('https://source.example/');
  const a = category('Action');
  const b = category('Horror');
  core.mergeCategoryOrder(state, [a, b]);
  finish(state, a, [item('movie:1', [a], 'movie')], {});
  assert.equal(state.nextCategoryIndex, 1);
  finish(state, b, [item('movie:2', [b], 'movie')], {});
  assert.equal(state.nextCategoryIndex, 0);
  core.mergeCategoryOrder(state, [b, a, category('Comedy')]);
  assert.deepEqual(state.categoryOrder.map((entry) => entry.name), ['Action', 'Horror', 'Comedy']);
});

test('fresh top-middle-bottom insertion uses history instead of offset', () => {
  const state = core.emptyState('https://source.example/');
  const a = category('Action');
  core.mergeCategoryOrder(state, [a]);
  const old = Array.from({ length: 20 }, (_, index) => item('movie:' + (index + 1), [a], 'movie'));
  finish(state, a, old, {});
  const fresh = [item('movie:100', [a], 'movie'), ...old.slice(0, 10), item('movie:101', [a], 'movie'),
    ...old.slice(10), item('movie:102', [a], 'movie')];
  const batch = core.prepareActiveBatch(state, a, fresh, 20);
  assert.deepEqual(batch.items, ['movie:100', 'movie:101', 'movie:102']);
});

test('category histories are independent', () => {
  const state = core.emptyState('https://source.example/');
  const a = category('Action');
  const b = category('SciFi');
  core.mergeCategoryOrder(state, [a, b]);
  const shared = item('movie:9', [a, b], 'movie');
  finish(state, a, [shared], {});
  assert.deepEqual(state.categoryHistory[a.id], ['movie:9']);
  assert.deepEqual(state.categoryHistory[b.id], []);
});

test('duplicate canonical result is globally reused and membership is preserved', () => {
  const state = core.emptyState('https://source.example/');
  const a = category('Action');
  const b = category('Popular');
  core.mergeCategoryOrder(state, [a, b]);
  const first = item('movie:7', [a], 'movie');
  finish(state, a, [first], {});
  const second = item('movie:7', [b], 'movie');
  core.prepareActiveBatch(state, b, [second], 20);
  assert.equal(core.canReuse(state, 'movie:7'), true);
  core.checkpointBatchItem(state, 'movie:7', state.results['movie:7'].scan, 'reuse');
  core.completeBatch(state);
  assert.equal(state.lastBatch.globallyReused, 1);
  assert.deepEqual(state.results['movie:7'].categories.map((entry) => entry.name).sort(), ['Action', 'Popular']);
});

test('Movie Series Episode retain one mixed discovery order', () => {
  const state = core.emptyState('https://source.example/');
  const a = category('Mixed');
  core.mergeCategoryOrder(state, [a]);
  const values = [item('movie:1', [a], 'movie'), item('tv:2', [a], 'series'),
    item('tv:2:s01:e01', [a], 'episode'), item('movie:3', [a], 'movie')];
  const batch = core.prepareActiveBatch(state, a, values, 20);
  assert.deepEqual(batch.items, values.map((value) => value.canonicalId));
});

test('crash resume keeps active category pointer and pending items', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-resume-'));
  const statePath = path.join(directory, 'scanner-state.json');
  const state = core.emptyState('https://source.example/');
  const a = category('Action');
  const b = category('Drama');
  core.mergeCategoryOrder(state, [a, b]);
  const values = [item('movie:1', [a], 'movie'), item('movie:2', [a], 'movie')];
  core.prepareActiveBatch(state, a, values, 20);
  core.checkpointBatchItem(state, 'movie:1', scan('https://media.example/1.m3u8'), 'browser');
  core.saveState(statePath, state);
  const resumed = core.loadState(statePath, 'https://source.example/');
  assert.equal(resumed.nextCategoryIndex, 0);
  assert.deepEqual(resumed.activeBatch.pendingItems, ['movie:2']);
  core.prepareActiveBatch(resumed, a, values, 20);
  core.checkpointBatchItem(resumed, 'movie:2', scan('https://media.example/2.m3u8'), 'browser');
  core.completeBatch(resumed);
  assert.equal(resumed.nextCategoryIndex, 1);
});

test('1080-class cinematic widths pass and 720p fails', () => {
  for (const value of ['1920x1080', '1920x960', '1920x800', '2048x858', '2560x1080', '3840x2160']) {
    assert.equal(core.is1080Class(value), true, value);
  }
  for (const value of ['1280x720', '854x480', '640x360', '720p']) assert.equal(core.is1080Class(value), false, value);
});

test('server whitelist no-header and fragment publication rules', () => {
  assert.equal(core.streamIsPublishable(stream('https://media.example/master.m3u8')), true);
  assert.equal(core.streamIsPublishable(stream('https://media.example/master.m3u8', 'Other')), false);
  const headerDependent = stream('https://media.example/master.m3u8');
  headerDependent.probe.directPlaybackNoHeaders = false;
  assert.equal(core.streamIsPublishable(headerDependent), false);
  assert.equal(core.streamIsPublishable(stream('https://media.example/segment1.ts')), false);
});

test('HLS and DASH parser helpers support required verification paths', () => {
  const hls = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x800\nvideo.m3u8\n';
  assert.equal(collector.highest1080ClassVariant(collector.parseHlsVariants(hls, 'https://cdn.example/master.m3u8')).resolution, '1920x800');
  assert.deepEqual(collector.hlsAudioPlaylists(hls, 'https://cdn.example/master.m3u8'), ['https://cdn.example/audio.m3u8']);
  const mpd = '<MPD><Representation id="v1" width="1920" height="800" bandwidth="10">' +
    '<SegmentTemplate initialization="init-$RepresentationID$.m4s" media="seg-$Number$.m4s"/></Representation></MPD>';
  const representation = collector.dashRepresentations(mpd)[0];
  assert.equal(representation.width, 1920);
  assert.equal(collector.fillDashTemplate('init-$RepresentationID$-$Bandwidth$-$Number$.m4s', representation), 'init-v1-10-1.m4s');
});

test('cumulative output dedupes exact master URL and cross-checks JSON TXT M3U posters', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-output-'));
  const state = core.emptyState('https://source.example/');
  core.migrateLegacyOnce(directory, state);
  const a = category('Action');
  const b = category('Popular');
  core.mergeCategoryOrder(state, [a, b]);
  const sharedUrl = 'https://media.example/shared.m3u8';
  finish(state, a, [item('movie:1', [a], 'movie')], { 'movie:1': scan(sharedUrl) });
  finish(state, b, [item('movie:2', [b], 'movie')], { 'movie:2': scan(sharedUrl) });
  state.updatedAt = new Date().toISOString();
  core.writeOutputs(directory, state);
  core.saveState(core.outputPaths(directory).state, state);
  const master = JSON.parse(fs.readFileSync(core.outputPaths(directory).masterJson, 'utf8'));
  assert.equal(master.items.length, 2);
  assert.equal(master.streams.length, 1);
  assert.equal(validator.countTextUrls(fs.readFileSync(core.outputPaths(directory).masterText, 'utf8')), 1);
  assert.equal(validator.countM3uUrls(fs.readFileSync(core.outputPaths(directory).masterM3u, 'utf8')), 1);
  const validation = validator.validate(directory);
  assert.equal(validation.ok, true, validation.errors.join('\n'));
});

test('legacy migration runs once and never imports fabricated stream data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-legacy-'));
  fs.mkdirSync(path.join(directory, 'data'));
  fs.writeFileSync(path.join(directory, 'data', 'movies.json'), JSON.stringify([
    { title: 'Legacy', source_url: 'https://source.example/play?id=44&type=movie',
      direct_stream_url: 'https://fabricated.invalid/720p.m3u8', poster: 'https://image.example/44.jpg' }
  ]));
  const state = core.emptyState('https://source.example/');
  assert.equal(core.migrateLegacyOnce(directory, state).imported, 1);
  assert.equal(core.migrateLegacyOnce(directory, state).skipped, true);
  assert.equal(Object.keys(state.results).length, 0);
});

console.log('\n' + passed.length + ' integration checks passed.');
