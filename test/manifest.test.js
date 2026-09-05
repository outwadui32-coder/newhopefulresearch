'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../lib/manifest');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const BASE = 'https://cdn.example.test/assets/demo/master.m3u8';

// --- HLS master ---------------------------------------------------------
const master = fixture('master.m3u8');
assert.equal(manifest.isMasterPlaylist(master), true);
assert.equal(manifest.isMediaPlaylist(master), false);
assert.equal(manifest.isMediaPlaylist(fixture('media.m3u8')), true);
assert.equal(manifest.isMasterPlaylist(fixture('media.m3u8')), false);

const variants = manifest.parseHlsMaster(master, BASE);
// Five #EXT-X-STREAM-INF entries; the I-frame and audio renditions are skipped.
assert.equal(variants.length, 5);
assert.deepEqual(variants.map((item) => item.resolution),
  ['3840x2160', '2560x1440', '1920x800', '1280x720', '854x480']);
assert.equal(variants[0].url, 'https://cdn.example.test/assets/demo/2160/index.m3u8');
assert.equal(variants[0].bandwidth, 15200000); // AVERAGE-BANDWIDTH preferred
assert.equal(variants[1].bandwidth, 9200000);
assert.equal(variants[0].codecs, 'avc1.640033,mp4a.40.2');
assert.ok(!variants.some((item) => /iframe/.test(item.url)));

// Every allowed tier is retained - not only the highest.
const selected = manifest.selectVariantsByTier(variants, { fallbackUrl: BASE });
assert.deepEqual(selected.map((item) => item.quality), ['4K', '2K', '1080p']);
assert.deepEqual(selected.map((item) => item.resolution), ['3840x2160', '2560x1440', '1920x1080']);

// Each tier points at its own exact child variant URL, never the master.
assert.deepEqual(selected.map((item) => item.url), [
  'https://cdn.example.test/assets/demo/2160/index.m3u8',
  'https://cdn.example.test/assets/demo/1440/index.m3u8',
  'https://cdn.example.test/assets/demo/1080/index.m3u8',
]);
assert.ok(selected.every((item) => item.exactVariant === true));
assert.ok(selected.every((item) => item.url !== BASE));

// The 1080p entry came from a 1920x800 scope variant but publishes standard.
const hd = selected.find((item) => item.quality === '1080p');
assert.equal(hd.rawResolution, '1920x800');
assert.equal(hd.resolution, '1920x1080');

// 720p and 480p never reach the output.
assert.ok(!selected.some((item) => /720|480/.test(item.resolution)));

// --- one tier reached by several variants: exact standard frame wins -----
const duplicates = manifest.selectVariantsByTier(
  manifest.parseHlsMaster(fixture('master-duplicate-tiers.m3u8'), BASE), { fallbackUrl: BASE }
);
assert.equal(duplicates.length, 1);
assert.equal(duplicates[0].quality, '1080p');
assert.equal(duplicates[0].url, 'https://cdn.example.test/assets/demo/cdn-a/1080.m3u8');

// --- DASH ---------------------------------------------------------------
const MPD = 'https://cdn.example.test/assets/demo/manifest.mpd';
const dash = manifest.parseDashManifest(fixture('manifest.mpd'), MPD);
assert.equal(dash.length, 4); // audio-only representation skipped
assert.deepEqual(dash.map((item) => item.resolution),
  ['3840x2160', '2560x1440', '1920x960', '1280x720']);
assert.equal(dash[0].url, 'https://cdn.example.test/assets/demo/video/2160/');
assert.equal(dash[0].exactVariant, true);
// No BaseURL of its own -> falls back to the manifest URL.
assert.equal(dash[2].url, MPD);
assert.equal(dash[2].exactVariant, false);

const dashSelected = manifest.selectVariantsByTier(dash, { fallbackUrl: MPD });
assert.deepEqual(dashSelected.map((item) => item.quality), ['4K', '2K', '1080p']);
assert.deepEqual(dashSelected.map((item) => item.resolution), ['3840x2160', '2560x1440', '1920x1080']);

// --- dispatcher ---------------------------------------------------------
assert.deepEqual(
  manifest.qualitiesFromManifest(master, BASE).map((item) => item.quality), ['4K', '2K', '1080p']);
assert.deepEqual(
  manifest.qualitiesFromManifest(fixture('manifest.mpd'), MPD).map((item) => item.quality),
  ['4K', '2K', '1080p']);
assert.deepEqual(manifest.qualitiesFromManifest(fixture('media.m3u8'), BASE), []);
assert.deepEqual(manifest.qualitiesFromManifest('', BASE), []);
assert.deepEqual(manifest.qualitiesFromManifest('not a manifest', BASE), []);

// A master with only low variants yields nothing publishable.
assert.deepEqual(manifest.qualitiesFromManifest(
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720\n720.m3u8\n', BASE), []);

console.log('PASS: HLS/DASH master parsing keeps every allowed tier with exact variant URLs');
