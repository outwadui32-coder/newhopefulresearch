'use strict';

// Single entry point for the source-neutral output library.
//
// The full chain, in order:
//
//   manifest text        -> streamsFromManifest(server, text, url)
//   stream entries       -> buildCategoryModel({ category, items })
//   normalized model     -> writeCategoryOutputs(model, { baseDirectory })
//   written data/ tree   -> verifyDataTree(baseDirectory)
//
// Batch scheduling is independent: buildBatch({ titles, maxTitles }) decides
// which titles a run should process, a series counting as one title slot.

const quality = require('./quality');
const servers = require('./servers');
const streams = require('./streams');
const manifest = require('./manifest');
const category = require('./category');
const model = require('./model');
const queue = require('./queue');
const paths = require('./paths');
const output = require('./output');
const verify = require('./verify');

module.exports = {
  // quality tiers
  QUALITY_TIERS: quality.QUALITY_TIERS,
  QUALITY_ORDER: quality.QUALITY_ORDER,
  STANDARD_RESOLUTIONS: quality.STANDARD_RESOLUTIONS,
  normalizeQuality: quality.normalizeQuality,
  compareQuality: quality.compareQuality,

  // servers
  CANONICAL_SERVERS: servers.CANONICAL_SERVERS,
  canonicalServer: servers.canonicalServer,
  isAllowedServer: servers.isAllowedServer,

  // captures -> published server groups
  normalizeStreamEntry: streams.normalizeStreamEntry,
  dedupeStreamEntries: streams.dedupeStreamEntries,
  groupByServer: streams.groupByServer,

  // manifests
  parseHlsMaster: manifest.parseHlsMaster,
  parseDashManifest: manifest.parseDashManifest,
  selectVariantsByTier: manifest.selectVariantsByTier,
  qualitiesFromManifest: manifest.qualitiesFromManifest,
  streamsFromManifest: manifest.streamsFromManifest,

  // model
  describeCategory: category.describeCategory,
  buildCategoryModel: model.buildCategoryModel,
  episodeCode: model.episodeCode,

  // scheduling
  buildBatch: queue.buildBatch,
  queueStats: queue.queueStats,

  // writing and checking
  categoryPaths: paths.categoryPaths,
  writeCategoryOutputs: output.writeCategoryOutputs,
  verifyDataTree: verify.verifyDataTree,
};
