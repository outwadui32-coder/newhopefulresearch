'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { QUALITY_ORDER, STANDARD_RESOLUTIONS, qualityRank } = require('./quality');
const { CANONICAL_SERVERS, serverRank } = require('./servers');

// Raw encoder dimensions that must never reach a published file.
const FORBIDDEN_RESOLUTION = /\b\d{3,5}x\d{3,5}\b/g;

function checkServerGroups(groups, where, errors, { allowEmpty = false } = {}) {
  const seenServers = new Set();
  let previousRank = -1;
  for (const group of groups || []) {
    if (!CANONICAL_SERVERS.includes(group.name)) {
      errors.push(`${where}: server "${group.name}" is not one of the five allowed servers`);
    }
    if (seenServers.has(group.name)) errors.push(`${where}: server ${group.name} repeated`);
    seenServers.add(group.name);
    if (serverRank(group.name) < previousRank) {
      errors.push(`${where}: server ${group.name} is out of canonical order`);
    }
    previousRank = serverRank(group.name);

    const seenQualities = new Set();
    let previousQuality = Infinity;
    for (const entry of group.qualities || []) {
      const at = `${where} > ${group.name}`;
      if (!QUALITY_ORDER.includes(entry.quality)) {
        errors.push(`${at}: quality "${entry.quality}" is not allowed`);
      }
      if (!STANDARD_RESOLUTIONS.includes(entry.resolution)) {
        errors.push(`${at}: resolution "${entry.resolution}" is not a standard published frame`);
      }
      if (seenQualities.has(entry.quality)) {
        errors.push(`${at}: quality ${entry.quality} published more than once`);
      }
      seenQualities.add(entry.quality);
      if (qualityRank(entry.quality) > previousQuality) {
        errors.push(`${at}: quality ${entry.quality} is out of 8K->1080p order`);
      }
      previousQuality = qualityRank(entry.quality);
      if (!entry.url) errors.push(`${at}: ${entry.quality} has no URL`);
    }
    if ((group.qualities || []).length === 0) errors.push(`${where}: ${group.name} has no qualities`);
  }
  if (!allowEmpty && (groups || []).length === 0) errors.push(`${where}: no servers`);
}

function urlsFromMoviesJson(document) {
  return document.movies.flatMap((movie) =>
    movie.servers.flatMap((server) => server.qualities.map((entry) => entry.url)));
}

function urlsFromSeriesJson(document) {
  return document.series.flatMap((series) =>
    series.seasons.flatMap((season) => season.episodes.flatMap((episode) =>
      episode.servers.flatMap((server) => server.qualities.map((entry) => entry.url)))));
}

function urlsFromText(contents) {
  return (contents.match(/^URL\s+: (.+)$/gm) || []).map((line) => line.replace(/^URL\s+: /, ''));
}

function urlsFromM3u(contents) {
  const lines = contents.split('\n');
  return lines.filter((line, index) => index > 0 && lines[index - 1].startsWith('#EXTINF:'));
}

function checkNoRawDimensions(contents, where, errors) {
  for (const found of contents.match(FORBIDDEN_RESOLUTION) || []) {
    if (!STANDARD_RESOLUTIONS.includes(found)) {
      errors.push(`${where}: raw dimension ${found} published as a resolution`);
    }
  }
}

function sameSet(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function verifyMovies(directory, errors) {
  const where = path.basename(path.dirname(directory)) + '/movies';
  const document = JSON.parse(fs.readFileSync(path.join(directory, 'movies.json'), 'utf8'));
  const textContents = fs.readFileSync(path.join(directory, 'movies.txt'), 'utf8');
  const m3uContents = fs.readFileSync(path.join(directory, 'movies.m3u'), 'utf8');

  if (document.metadata.totalMovies !== document.movies.length) {
    errors.push(`${where}: totalMovies ${document.metadata.totalMovies} != ${document.movies.length} records`);
  }
  document.movies.forEach((movie, index) => {
    if (movie.serial !== index + 1) errors.push(`${where}: movie serial ${movie.serial} out of sequence`);
    if (!movie.id) errors.push(`${where}: movie at ${index} has no id`);
    if (!movie.title) errors.push(`${where}: ${movie.id} has no title`);
    checkServerGroups(movie.servers, `${where} > ${movie.id}`, errors);
  });
  if (document.series) errors.push(`${where}: movies.json must not contain series records`);

  for (const [name, contents] of [['movies.txt', textContents], ['movies.m3u', m3uContents]]) {
    checkNoRawDimensions(contents, `${where}/${name}`, errors);
  }
  const jsonUrls = urlsFromMoviesJson(document);
  if (!sameSet(jsonUrls, urlsFromText(textContents))) errors.push(`${where}: movies.txt URLs differ from movies.json`);
  if (!sameSet(jsonUrls, urlsFromM3u(m3uContents))) errors.push(`${where}: movies.m3u URLs differ from movies.json`);
  return jsonUrls;
}

function verifySeries(directory, errors) {
  const where = path.basename(path.dirname(directory)) + '/series';
  const document = JSON.parse(fs.readFileSync(path.join(directory, 'series.json'), 'utf8'));
  const textContents = fs.readFileSync(path.join(directory, 'series.txt'), 'utf8');
  const m3uContents = fs.readFileSync(path.join(directory, 'series.m3u'), 'utf8');

  if (document.metadata.totalSeries !== document.series.length) {
    errors.push(`${where}: totalSeries ${document.metadata.totalSeries} != ${document.series.length} records`);
  }
  if (document.movies) errors.push(`${where}: series.json must not contain movie records`);

  document.series.forEach((series, seriesIndex) => {
    const at = `${where} > ${series.id}`;
    if (series.serial !== seriesIndex + 1) errors.push(`${at}: series serial out of sequence`);
    if (!series.title) errors.push(`${at}: no title`);
    if (!Number.isInteger(series.totalSeasons)) errors.push(`${at}: totalSeasons is not a number`);
    if (!Number.isInteger(series.totalEpisodes)) errors.push(`${at}: totalEpisodes is not a number`);

    let previousSeason = -Infinity;
    const seenSeasons = new Set();
    const seenEpisodeCodes = new Set();
    for (const season of series.seasons || []) {
      const seasonAt = `${at} > season ${season.seasonNumber}`;
      if (season.seasonNumber <= previousSeason) errors.push(`${seasonAt}: seasons are not ascending`);
      previousSeason = season.seasonNumber;
      if (seenSeasons.has(season.seasonNumber)) errors.push(`${seasonAt}: season repeated`);
      seenSeasons.add(season.seasonNumber);
      if (season.seasonNumber === 0 && !/special/i.test(season.seasonName || '')) {
        errors.push(`${seasonAt}: season 0 must be named Specials, not merged into season 1`);
      }

      let previousEpisode = -Infinity;
      for (const episode of season.episodes || []) {
        const episodeAt = `${seasonAt} > ${episode.episodeCode}`;
        if (episode.episodeNumber <= previousEpisode) errors.push(`${episodeAt}: episodes are not ascending`);
        previousEpisode = episode.episodeNumber;
        const expected = `S${String(season.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
        if (episode.episodeCode !== expected) {
          errors.push(`${episodeAt}: episode code should be ${expected}`);
        }
        if (seenEpisodeCodes.has(episode.episodeCode)) {
          errors.push(`${episodeAt}: the same episode appears under more than one season`);
        }
        seenEpisodeCodes.add(episode.episodeCode);
        checkServerGroups(episode.servers, episodeAt, errors, { allowEmpty: true });
      }
      if ((season.episodes || []).length === 0) errors.push(`${seasonAt}: no episodes`);
    }
    if ((series.seasons || []).length === 0) errors.push(`${at}: no seasons`);
  });

  for (const [name, contents] of [['series.txt', textContents], ['series.m3u', m3uContents]]) {
    checkNoRawDimensions(contents, `${where}/${name}`, errors);
  }
  const jsonUrls = urlsFromSeriesJson(document);
  if (!sameSet(jsonUrls, urlsFromText(textContents))) errors.push(`${where}: series.txt URLs differ from series.json`);
  if (!sameSet(jsonUrls, urlsFromM3u(m3uContents))) errors.push(`${where}: series.m3u URLs differ from series.json`);
  return jsonUrls;
}

// Walks a written data/ tree and applies the whole published-output checklist.
function verifyDataTree(baseDirectory) {
  const errors = [];
  const root = path.resolve(baseDirectory);
  if (!fs.existsSync(root)) return { categories: 0, errors: [`${baseDirectory} does not exist`] };

  const categories = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const folder of categories) {
    const categoryDirectory = path.join(root, folder);
    const moviesDirectory = path.join(categoryDirectory, 'movies');
    const seriesDirectory = path.join(categoryDirectory, 'series');
    const hasMovies = fs.existsSync(moviesDirectory);
    const hasSeries = fs.existsSync(seriesDirectory);

    if (!hasMovies && !hasSeries) {
      errors.push(`${folder}: category has neither movies/ nor series/`);
      continue;
    }
    // A content type is only inspected once its three files are all present;
    // a missing file is reported rather than crashing the whole run.
    const complete = new Map();
    for (const [present, key, directory, files] of [
      [hasMovies, 'movies', moviesDirectory, ['movies.json', 'movies.m3u', 'movies.txt']],
      [hasSeries, 'series', seriesDirectory, ['series.json', 'series.m3u', 'series.txt']],
    ]) {
      if (!present) continue;
      const missing = files.filter((file) => !fs.existsSync(path.join(directory, file)));
      for (const file of missing) errors.push(`${folder}: missing ${file}`);
      complete.set(key, missing.length === 0);
    }

    let movieUrls = [];
    let episodeUrls = [];
    if (complete.get('movies')) movieUrls = verifyMovies(moviesDirectory, errors);
    if (complete.get('series')) episodeUrls = verifySeries(seriesDirectory, errors);
    const shared = movieUrls.filter((url) => episodeUrls.includes(url));
    if (shared.length > 0) errors.push(`${folder}: ${shared.length} URL(s) appear in both movies and series`);
  }

  return { categories: categories.length, errors };
}

module.exports = { verifyDataTree, checkServerGroups };
