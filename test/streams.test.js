'use strict';

const assert = require('node:assert/strict');
const servers = require('../lib/servers');
const streams = require('../lib/streams');

// --- server whitelist ---------------------------------------------------
assert.deepEqual(servers.CANONICAL_SERVERS, ['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast']);
for (const name of servers.CANONICAL_SERVERS) assert.equal(servers.canonicalServer(name), name);

// The source label "Vid" is internal compatibility; it publishes as Ultra.
assert.equal(servers.canonicalServer('Vid'), 'Ultra');
assert.equal(servers.canonicalServer('vid'), 'Ultra');
assert.equal(servers.canonicalServer('playfast'), 'PlayFast');
assert.equal(servers.canonicalServer('Play Fast'), 'PlayFast');

// Any other discovered provider is not publishable.
for (const other of ['Redflix', 'Cinezo', 'Nova', 'Mega', 'Bolt', 'Hindi', 'Hindi 2', 'Hindi Mirror', '', null]) {
  assert.equal(servers.canonicalServer(other), null, `${other} must not be publishable`);
  assert.equal(servers.isAllowedServer(other), false);
}

assert.deepEqual(
  ['PlayFast', 'Alpha', 'Ultra', 'Premium', 'Orion'].sort(servers.compareServer),
  ['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast']
);

// --- normalization ------------------------------------------------------
assert.equal(streams.normalizeStreamEntry({ server: 'Vid', resolution: '1920x800', url: 'u' }).server, 'Ultra');
assert.equal(streams.normalizeStreamEntry({ server: 'Vid', resolution: '1920x800', url: 'u' }).resolution, '1920x1080');
assert.equal(streams.normalizeStreamEntry({ server: 'Nova', resolution: '3840x2160', url: 'u' }), null);
assert.equal(streams.normalizeStreamEntry({ server: 'Alpha', resolution: '1280x720', url: 'u' }), null);
assert.equal(streams.normalizeStreamEntry({ server: 'Alpha', resolution: '1920x1080' }), null);

// --- dedupe: 20 captured PlayFast URLs that all land in 1080p -> one entry ---
const manyPlayFast = Array.from({ length: 20 }, (_, index) => ({
  server: 'PlayFast', resolution: '1620x1080', url: `https://cdn.test/pf/${index}.m3u8`,
}));
const collapsed = streams.dedupeStreamEntries(manyPlayFast, 'movie:1');
assert.equal(collapsed.length, 1);
assert.equal(collapsed[0].quality, '1080p');
assert.equal(collapsed[0].resolution, '1920x1080');
assert.equal(collapsed[0].backups.length, 19);

// Verified + exact-variant URL wins over a bare master capture.
const mixed = streams.dedupeStreamEntries([
  { server: 'Ultra', resolution: '3840x2160', url: 'https://cdn.test/master.m3u8' },
  { server: 'Ultra', resolution: '3840x2160', url: 'https://cdn.test/2160/index.m3u8', verified: true, exactVariant: true },
  { server: 'Ultra', resolution: '3840x2160', url: 'https://cdn.test/other.m3u8', bandwidth: 99999999 },
], 'movie:1');
assert.equal(mixed.length, 1);
assert.equal(mixed[0].url, 'https://cdn.test/2160/index.m3u8');

// Different tiers on one server are all kept; only duplicates collapse.
const tiers = streams.dedupeStreamEntries([
  { server: 'Ultra', resolution: '1920x1080', url: 'a' },
  { server: 'Ultra', resolution: '3840x2160', url: 'b' },
  { server: 'Ultra', resolution: '2560x1440', url: 'c' },
  { server: 'Ultra', resolution: '1920x804', url: 'a-dup' },
], 'movie:1');
assert.deepEqual(tiers.map((item) => item.quality), ['4K', '2K', '1080p']);

// The same server+quality under a DIFFERENT content id stays separate.
const perContent = [
  ...streams.dedupeStreamEntries([{ server: 'Alpha', resolution: '1920x1080', url: 'e1' }], 'tv:1:s01:e01'),
  ...streams.dedupeStreamEntries([{ server: 'Alpha', resolution: '1920x1080', url: 'e2' }], 'tv:1:s01:e02'),
];
assert.equal(perContent.length, 2);

// --- grouping -----------------------------------------------------------
const grouped = streams.groupByServer([
  { server: 'PlayFast', resolution: '1920x1000', url: 'pf-1080' },
  { server: 'Alpha', resolution: '3840x2160', url: 'a-4k' },
  { server: 'Alpha', resolution: '1920x800', url: 'a-1080' },
  { server: 'Nova', resolution: '3840x2160', url: 'dropped' },
  { server: 'PlayFast', resolution: '1620x1080', url: 'pf-1080-dup' },
], 'movie:1');
assert.deepEqual(grouped.map((item) => item.name), ['Alpha', 'PlayFast']);
assert.deepEqual(grouped[0].qualities, [
  { quality: '4K', resolution: '3840x2160', url: 'a-4k' },
  { quality: '1080p', resolution: '1920x1080', url: 'a-1080' },
]);
assert.equal(grouped[1].qualities.length, 1);

// No published quality object ever leaks a raw dimension or a backup list.
for (const server of grouped) {
  for (const entry of server.qualities) {
    assert.deepEqual(Object.keys(entry), ['quality', 'resolution', 'url']);
  }
}

console.log('PASS: five-server whitelist and content+server+quality dedupe');
