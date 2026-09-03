'use strict';

// The only server names that may appear in final output, in publication order.
const CANONICAL_SERVERS = Object.freeze(['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast']);

// Source-label compatibility only. A source may label a slot differently; the
// canonical name on the left is what every writer prints. Discovered labels
// that are not listed here are not publishable and get dropped.
const SERVER_ALIASES = Object.freeze({
  Alpha: Object.freeze(['Alpha']),
  Premium: Object.freeze(['Premium']),
  Orion: Object.freeze(['Orion']),
  Ultra: Object.freeze(['Ultra', 'Vid']),
  PlayFast: Object.freeze(['PlayFast', 'Play Fast']),
});

const ALIAS_LOOKUP = new Map();
for (const [server, aliases] of Object.entries(SERVER_ALIASES)) {
  for (const alias of aliases) ALIAS_LOOKUP.set(alias.toLowerCase().replace(/\s+/g, ''), server);
}

// Maps any known source label onto its canonical server name; null when the
// label is not one of the five allowed servers.
function canonicalServer(label) {
  const key = String(label == null ? '' : label).trim().toLowerCase().replace(/\s+/g, '');
  return key ? (ALIAS_LOOKUP.get(key) || null) : null;
}

function isAllowedServer(label) {
  return canonicalServer(label) !== null;
}

function serverRank(label) {
  const index = CANONICAL_SERVERS.indexOf(canonicalServer(label));
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

// Sort comparator: canonical order, unknown servers last.
function compareServer(left, right) {
  return serverRank(left) - serverRank(right);
}

module.exports = {
  CANONICAL_SERVERS, SERVER_ALIASES,
  canonicalServer, isAllowedServer, serverRank, compareServer,
};
