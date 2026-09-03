'use strict';

const assert = require('node:assert/strict');
const quality = require('../lib/quality');

// Standard frames map to their own tier.
assert.equal(quality.normalizeQuality('1920x1080').quality, '1080p');
assert.equal(quality.normalizeQuality('2560x1440').quality, '2K');
assert.equal(quality.normalizeQuality('3840x2160').quality, '4K');
assert.equal(quality.normalizeQuality('7680x4320').quality, '8K');

// The raw odd dimensions the plan calls out must never surface as a resolution;
// they classify into a tier and publish that tier's standard frame.
for (const raw of ['1620x1080', '1920x800', '1920x804', '1920x960', '1920x1000']) {
  const normalized = quality.normalizeQuality(raw);
  assert.equal(normalized.quality, '1080p', `${raw} should be 1080p`);
  assert.equal(normalized.resolution, '1920x1080', `${raw} should publish 1920x1080`);
  assert.notEqual(normalized.resolution, raw);
}

// Scope framings follow the width axis.
assert.equal(quality.normalizeQuality('3840x1600').quality, '4K');
assert.equal(quality.normalizeQuality('7680x3200').quality, '8K');
assert.equal(quality.normalizeQuality('2560x1080').quality, '2K');

// Slightly short masters stay in their real tier.
assert.equal(quality.normalizeQuality('1912x796').quality, '1080p');

// Everything under the 1080p floor is rejected outright.
for (const low of ['1280x720', '854x480', '640x360', '720p', '480p', '360p']) {
  assert.equal(quality.normalizeQuality(low), null, `${low} must be rejected`);
}

// Player-style progressive labels normalize too.
assert.equal(quality.normalizeQuality('2160p').quality, '4K');
assert.equal(quality.normalizeQuality('1440p').quality, '2K');
assert.equal(quality.normalizeQuality('1080p').quality, '1080p');
assert.equal(quality.normalizeQuality('4320p').quality, '8K');

// Tier labels round-trip.
assert.equal(quality.normalizeQuality('4K').resolution, '3840x2160');
assert.equal(quality.normalizeQuality({ width: 1920, height: 804 }).quality, '1080p');

// Garbage in, null out.
for (const bad of [null, undefined, '', 'adaptive/single playlist', 'hls', {}, '12x9']) {
  assert.equal(quality.normalizeQuality(bad), null);
}

// Raw dimensions are retained internally for diagnostics only.
const scope = quality.normalizeQuality('1920x800');
assert.equal(scope.rawWidth, 1920);
assert.equal(scope.rawHeight, 800);

// Ordering is 8K -> 4K -> 2K -> 1080p.
assert.deepEqual(quality.QUALITY_ORDER, ['8K', '4K', '2K', '1080p']);
assert.deepEqual(
  ['1080p', '4K', '1080p', '8K', '2K'].sort(quality.compareQuality),
  ['8K', '4K', '2K', '1080p', '1080p']
);

assert.deepEqual(quality.STANDARD_RESOLUTIONS, ['7680x4320', '3840x2160', '2560x1440', '1920x1080']);
assert.equal(quality.isAllowedQuality('720p'), false);
assert.equal(quality.isAllowedQuality('2K'), true);
assert.equal(quality.isStandardResolution('1620x1080'), false);
assert.equal(quality.isStandardResolution('1920x1080'), true);

console.log('PASS: quality normalization (1080p/2K/4K/8K, no raw odd dimensions)');
