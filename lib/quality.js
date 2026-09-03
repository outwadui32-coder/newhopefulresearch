'use strict';

// Final user-facing quality tiers. Nothing outside this list may be published.
// Raw encoder dimensions (1920x800, 1620x1080, 1920x960, ...) are internal only:
// they classify into one of these tiers and the tier's standard resolution is
// what every writer prints.
const QUALITY_TIERS = Object.freeze([
  Object.freeze({ quality: '8K', width: 7680, height: 4320, resolution: '7680x4320', rank: 4 }),
  Object.freeze({ quality: '4K', width: 3840, height: 2160, resolution: '3840x2160', rank: 3 }),
  Object.freeze({ quality: '2K', width: 2560, height: 1440, resolution: '2560x1440', rank: 2 }),
  Object.freeze({ quality: '1080p', width: 1920, height: 1080, resolution: '1920x1080', rank: 1 }),
]);

// Publication order: 8K -> 4K -> 2K -> 1080p.
const QUALITY_ORDER = Object.freeze(QUALITY_TIERS.map((tier) => tier.quality));

const STANDARD_RESOLUTIONS = Object.freeze(QUALITY_TIERS.map((tier) => tier.resolution));

// Scope and pillarboxed encodes fall a little short of the nominal frame
// (1912x796 is a 1080p master). A 2% margin keeps them in their real tier
// without letting a 720p variant reach 1080p.
const TIER_TOLERANCE = 0.98;

function parseDimensions(value) {
  const match = String(value == null ? '' : value).trim().match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!width || !height) return null;
  return { width, height };
}

function tierByLabel(value) {
  const label = String(value == null ? '' : value).trim();
  if (!label) return null;
  const direct = QUALITY_TIERS.find((tier) => tier.quality.toLowerCase() === label.toLowerCase());
  if (direct) return direct;
  // Player menus expose progressive labels (2160p, 1440p, 1080p, 720p).
  const progressive = label.match(/^(\d{3,4})p$/i);
  return progressive ? tierForDimensions(0, Number(progressive[1])) : null;
}

// A variant belongs to the highest tier it reaches on EITHER axis. Width
// carries scope framings (1920x800 is 1080p, 3840x1600 is 4K); height carries
// pillarboxed ones (1620x1080 is 1080p).
function tierForDimensions(width, height) {
  const safeWidth = Number(width) || 0;
  const safeHeight = Number(height) || 0;
  return QUALITY_TIERS.find((tier) =>
    safeWidth >= tier.width * TIER_TOLERANCE || safeHeight >= tier.height * TIER_TOLERANCE
  ) || null;
}

// Accepts "1920x800", "2160p", "4K", or {width,height}. Returns null for
// anything below the 1080p floor, which is how low variants get dropped.
function normalizeQuality(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const tier = tierForDimensions(value.width, value.height);
    return tier ? toQuality(tier, value.width, value.height) : null;
  }
  const dimensions = parseDimensions(value);
  if (dimensions) {
    const tier = tierForDimensions(dimensions.width, dimensions.height);
    return tier ? toQuality(tier, dimensions.width, dimensions.height) : null;
  }
  const labelled = tierByLabel(value);
  return labelled ? toQuality(labelled, null, null) : null;
}

function toQuality(tier, rawWidth, rawHeight) {
  return {
    quality: tier.quality,
    resolution: tier.resolution,
    rank: tier.rank,
    rawWidth: Number(rawWidth) || null,
    rawHeight: Number(rawHeight) || null,
  };
}

function isAllowedQuality(value) {
  return QUALITY_ORDER.includes(String(value == null ? '' : value).trim());
}

function isStandardResolution(value) {
  return STANDARD_RESOLUTIONS.includes(String(value == null ? '' : value).trim());
}

function qualityRank(value) {
  const tier = QUALITY_TIERS.find((item) => item.quality === value);
  return tier ? tier.rank : 0;
}

// Sort comparator: highest tier first.
function compareQuality(left, right) {
  return qualityRank(right) - qualityRank(left);
}

module.exports = {
  QUALITY_TIERS, QUALITY_ORDER, STANDARD_RESOLUTIONS, TIER_TOLERANCE,
  parseDimensions, tierForDimensions, normalizeQuality,
  isAllowedQuality, isStandardResolution, qualityRank, compareQuality,
};
