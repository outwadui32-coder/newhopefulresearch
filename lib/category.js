'use strict';

function slugify(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'uncategorized';
}

// "Browse: TRENDING NOW" -> printed as-is on the CATEGORY line, grouped under
// "TRENDING NOW" in M3U, written to data/trending-now/.
function describeCategory(rawCategory) {
  const raw = String(rawCategory == null ? '' : rawCategory).trim() || 'Uncategorized';
  const separator = raw.lastIndexOf(':');
  const displayName = (separator >= 0 ? raw.slice(separator + 1) : raw).trim() || raw;
  return { raw, name: raw, displayName, folder: slugify(displayName) };
}

module.exports = { slugify, describeCategory };
