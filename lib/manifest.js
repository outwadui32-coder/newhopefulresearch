'use strict';

const { normalizeQuality, compareQuality } = require('./quality');

function resolveUrl(reference, baseUrl) {
  try {
    return baseUrl ? new URL(reference, baseUrl).href : new URL(reference).href;
  } catch (_) {
    return null;
  }
}

function isMasterPlaylist(text) {
  return /^\s*#EXTM3U/.test(String(text || '')) && /#EXT-X-STREAM-INF:/i.test(String(text || ''));
}

function isMediaPlaylist(text) {
  const body = String(text || '');
  return /^\s*#EXTM3U/.test(body) && !/#EXT-X-STREAM-INF:/i.test(body) && /#EXTINF:/i.test(body);
}

// Attributes are parsed once with a regex LITERAL. Building a RegExp from a
// string here is a trap: the name must be anchored or `width` matches inside
// `bandwidth` and `BANDWIDTH` inside `AVERAGE-BANDWIDTH`.
const ATTRIBUTE_PATTERN = /(?:^|[\s,;])([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s>]+))/g;

function attributeMap(attributes) {
  const map = new Map();
  for (const match of String(attributes || '').matchAll(ATTRIBUTE_PATTERN)) {
    const key = match[1].toLowerCase();
    if (!map.has(key)) map.set(key, match[2] !== undefined ? match[2] : match[3]);
  }
  return map;
}

function attribute(attributes, name) {
  const value = (attributes instanceof Map ? attributes : attributeMap(attributes)).get(name.toLowerCase());
  return value === undefined ? null : value;
}

// Parses every #EXT-X-STREAM-INF variant out of an HLS master playlist.
// I-frame trick-play streams and audio-only renditions are not playable
// variants and are skipped. No filtering happens here: the caller decides
// which tiers to keep.
function parseHlsMaster(text, baseUrl = null) {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];
  const seen = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.toUpperCase().startsWith('#EXT-X-STREAM-INF:')) continue;
    const attributes = attributeMap(line.slice(line.indexOf(':') + 1));
    let reference = '';
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].trim();
      if (!candidate || candidate.startsWith('#')) continue;
      reference = candidate;
      break;
    }
    if (!reference) continue;
    const url = resolveUrl(reference, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const resolution = attribute(attributes, 'RESOLUTION');
    const dimensions = resolution ? resolution.match(/^(\d+)x(\d+)$/i) : null;
    variants.push({
      url,
      resolution: resolution || null,
      width: dimensions ? Number(dimensions[1]) : null,
      height: dimensions ? Number(dimensions[2]) : null,
      bandwidth: Number(attribute(attributes, 'AVERAGE-BANDWIDTH')) ||
        Number(attribute(attributes, 'BANDWIDTH')) || 0,
      codecs: attribute(attributes, 'CODECS'),
      name: attribute(attributes, 'NAME'),
    });
  }
  return variants;
}

// Parses video Representation elements out of a DASH MPD. A representation
// carrying its own BaseURL yields an exact child URL; otherwise the caller
// falls back to the manifest URL itself.
function parseDashManifest(text, baseUrl = null) {
  const body = String(text || '');
  const variants = [];
  const seen = new Set();
  const pattern = /<Representation\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Representation>)/gi;
  for (const match of body.matchAll(pattern)) {
    const attributes = attributeMap(match[1] || '');
    const inner = match[2] || '';
    const width = Number(attribute(attributes, 'width')) || null;
    const height = Number(attribute(attributes, 'height')) || null;
    if (!width || !height) continue; // audio-only or malformed
    const relative = inner.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/i)?.[1]?.trim() || null;
    const url = relative ? resolveUrl(relative, baseUrl) : (baseUrl || null);
    const key = `${url}\n${width}x${height}`;
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push({
      url,
      resolution: `${width}x${height}`,
      width,
      height,
      bandwidth: Number(attribute(attributes, 'bandwidth')) || 0,
      codecs: attribute(attributes, 'codecs'),
      name: attribute(attributes, 'id'),
      exactVariant: Boolean(relative),
    });
  }
  return variants;
}

// Keeps the BEST variant for EVERY allowed tier present in the manifest -
// never only the highest. Each returned entry points at the exact child
// variant URL when the manifest provided one.
function selectVariantsByTier(variants, { fallbackUrl = null } = {}) {
  const byTier = new Map();
  for (const variant of variants || []) {
    const normalized = normalizeQuality(
      variant.width && variant.height
        ? { width: variant.width, height: variant.height }
        : variant.resolution
    );
    if (!normalized) continue;
    const url = variant.url || fallbackUrl;
    if (!url) continue;
    const candidate = {
      quality: normalized.quality,
      resolution: normalized.resolution,
      url,
      bandwidth: variant.bandwidth || 0,
      rawResolution: variant.resolution || null,
      exactVariant: variant.exactVariant !== undefined
        ? variant.exactVariant
        : Boolean(variant.url && variant.url !== fallbackUrl),
    };
    const existing = byTier.get(normalized.quality);
    const better = !existing ||
      candidate.bandwidth > existing.bandwidth ||
      (candidate.bandwidth === existing.bandwidth && candidate.exactVariant && !existing.exactVariant);
    if (better) byTier.set(normalized.quality, candidate);
  }
  return [...byTier.values()].sort((left, right) => compareQuality(left.quality, right.quality));
}

// Convenience: manifest text -> published quality entries for one server.
function qualitiesFromManifest(text, manifestUrl) {
  const body = String(text || '');
  if (isMasterPlaylist(body)) {
    return selectVariantsByTier(parseHlsMaster(body, manifestUrl), { fallbackUrl: manifestUrl });
  }
  if (/<MPD\b/i.test(body)) {
    return selectVariantsByTier(parseDashManifest(body, manifestUrl), { fallbackUrl: manifestUrl });
  }
  return [];
}

// The bridge from a parsed manifest to the model's input shape: one stream
// entry per allowed tier, tagged with the server it was served from, ready to
// drop straight into `item.streams`. Raw dimensions are carried through so the
// tier is derived from what the manifest actually declared.
function streamsFromManifest(server, text, manifestUrl, { verified = false } = {}) {
  return qualitiesFromManifest(text, manifestUrl).map((variant) => ({
    server,
    resolution: variant.rawResolution || variant.resolution,
    url: variant.url,
    bandwidth: variant.bandwidth,
    exactVariant: variant.exactVariant,
    verified,
  }));
}

module.exports = {
  isMasterPlaylist, isMediaPlaylist, parseHlsMaster, parseDashManifest,
  selectVariantsByTier, qualitiesFromManifest, streamsFromManifest,
};
