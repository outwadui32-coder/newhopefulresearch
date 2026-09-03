'use strict';

const { normalizeQuality, compareQuality } = require('./quality');
const { canonicalServer, compareServer } = require('./servers');

// One raw capture -> one normalized stream entry, or null when the server is
// not one of the five allowed ones or the variant is below the 1080p floor.
function normalizeStreamEntry(entry) {
  if (!entry || !entry.url) return null;
  const server = canonicalServer(entry.server);
  if (!server) return null;
  const normalized = normalizeQuality(entry.resolution || entry.quality);
  if (!normalized) return null;
  return {
    server,
    quality: normalized.quality,
    resolution: normalized.resolution,
    url: String(entry.url),
    // Internal only. Writers never print these.
    rawResolution: normalized.rawWidth && normalized.rawHeight
      ? `${normalized.rawWidth}x${normalized.rawHeight}`
      : null,
    bandwidth: Number(entry.bandwidth) || 0,
    verified: entry.verified === true,
    exactVariant: entry.exactVariant === true,
  };
}

// Higher is better. Decides which URL wins when one server exposes the same
// quality tier through several captured URLs.
function preferenceOf(entry) {
  return (entry.verified ? 4 : 0) + (entry.exactVariant ? 2 : 0);
}

function comparePreference(left, right) {
  return preferenceOf(right) - preferenceOf(left) ||
    right.bandwidth - left.bandwidth ||
    left.order - right.order;
}

// Collapses to exactly one entry per content + server + quality. Losing URLs
// are kept on `backups` for internal use and are never published.
function dedupeStreamEntries(entries, contentId = '') {
  const groups = new Map();
  let order = 0;
  for (const raw of entries || []) {
    const normalized = normalizeStreamEntry(raw);
    if (!normalized) continue;
    const key = [contentId, normalized.server, normalized.quality].join('\n');
    const candidate = { ...normalized, order: order++ };
    const existing = groups.get(key);
    if (!existing) groups.set(key, [candidate]);
    else existing.push(candidate);
  }
  const streams = [];
  for (const candidates of groups.values()) {
    const sorted = [...candidates].sort(comparePreference);
    const [winner, ...rest] = sorted;
    streams.push({
      ...winner,
      backups: rest.filter((item) => item.url !== winner.url).map((item) => item.url),
    });
  }
  return streams.sort((left, right) =>
    compareServer(left.server, right.server) ||
    compareQuality(left.quality, right.quality) ||
    left.order - right.order
  );
}

// Groups deduped entries into the published `servers -> qualities` shape.
function groupByServer(entries, contentId = '') {
  const deduped = dedupeStreamEntries(entries, contentId);
  const servers = new Map();
  for (const entry of deduped) {
    if (!servers.has(entry.server)) servers.set(entry.server, []);
    servers.get(entry.server).push({
      quality: entry.quality,
      resolution: entry.resolution,
      url: entry.url,
    });
  }
  return [...servers.entries()]
    .sort(([left], [right]) => compareServer(left, right))
    .map(([name, qualities]) => ({ name, qualities }));
}

module.exports = { normalizeStreamEntry, dedupeStreamEntries, groupByServer };
