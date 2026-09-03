'use strict';

const { describeCategory } = require('./category');
const { groupByServer } = require('./streams');

function episodeCode(seasonNumber, episodeNumber) {
  return `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`;
}

function episodeContentId(item) {
  const base = item.seriesId || 'tv:unknown';
  return `${base}:s${String(item.seasonNumber).padStart(2, '0')}:e${String(item.episodeNumber).padStart(2, '0')}`;
}

function isEpisode(item) {
  return item?.type === 'episode' ||
    (Number.isInteger(item?.seasonNumber) && Number.isInteger(item?.episodeNumber));
}

// TMDB season 0 is Specials. It keeps its own season and is never folded into
// season 1.
function seasonNameFor(item) {
  if (item.seasonName) return String(item.seasonName);
  return item.seasonNumber === 0 ? 'Specials' : `Season ${item.seasonNumber}`;
}

function toMovie(item) {
  return {
    id: item.id,
    title: item.title || 'Untitled',
    year: item.year ?? null,
    poster: item.poster || null,
    servers: groupByServer(item.streams, item.id),
  };
}

function toEpisode(item) {
  return {
    episodeNumber: item.episodeNumber,
    episodeCode: episodeCode(item.seasonNumber, item.episodeNumber),
    episodeName: item.episodeName || `Episode ${item.episodeNumber}`,
    airDate: item.airDate || null,
    poster: item.poster || null,
    servers: groupByServer(item.streams, episodeContentId(item)),
  };
}

// Flat item list -> the one normalized model every writer consumes. Movies and
// series are separated here; nothing downstream re-derives this shape.
function buildCategoryModel({ category, lastUpdated = null, purpose = '', items = [] } = {}) {
  const descriptor = describeCategory(category);
  const movies = [];
  const seriesById = new Map();
  const dropped = [];

  for (const item of items) {
    if (!item) continue;
    if (!isEpisode(item)) {
      const movie = toMovie(item);
      if (movie.servers.length === 0) {
        dropped.push({ id: item.id, reason: 'no verified stream on any allowed server' });
        continue;
      }
      movies.push(movie);
      continue;
    }

    const seriesId = item.seriesId || 'tv:unknown';
    const episode = toEpisode(item);
    if (episode.servers.length === 0) {
      // One failed episode must never discard the rest of the series.
      dropped.push({ id: episodeContentId(item), reason: 'no verified stream on any allowed server' });
      continue;
    }
    let series = seriesById.get(seriesId);
    if (!series) {
      series = {
        id: seriesId,
        title: item.seriesTitle || 'Untitled',
        year: item.seriesYear ?? null,
        poster: item.seriesPoster || null,
        // Source metadata totals when known; otherwise filled from what was built.
        metadataSeasons: Number.isInteger(item.totalSeasons) ? item.totalSeasons : null,
        metadataEpisodes: Number.isInteger(item.totalEpisodes) ? item.totalEpisodes : null,
        seasonMap: new Map(),
      };
      seriesById.set(seriesId, series);
    }
    if (series.metadataSeasons === null && Number.isInteger(item.totalSeasons)) {
      series.metadataSeasons = item.totalSeasons;
    }
    if (series.metadataEpisodes === null && Number.isInteger(item.totalEpisodes)) {
      series.metadataEpisodes = item.totalEpisodes;
    }

    let season = series.seasonMap.get(item.seasonNumber);
    if (!season) {
      season = {
        seasonNumber: item.seasonNumber,
        seasonName: seasonNameFor(item),
        metadataEpisodes: Number.isInteger(item.seasonTotalEpisodes) ? item.seasonTotalEpisodes : null,
        episodes: new Map(),
      };
      series.seasonMap.set(item.seasonNumber, season);
    }
    if (season.metadataEpisodes === null && Number.isInteger(item.seasonTotalEpisodes)) {
      season.metadataEpisodes = item.seasonTotalEpisodes;
    }
    // An episode number appears once per season, even if discovered twice.
    if (!season.episodes.has(item.episodeNumber)) season.episodes.set(item.episodeNumber, episode);
  }

  const series = [...seriesById.values()].map((entry) => {
    const seasons = [...entry.seasonMap.values()]
      .sort((left, right) => left.seasonNumber - right.seasonNumber)
      .map((season) => {
        const episodes = [...season.episodes.values()]
          .sort((left, right) => left.episodeNumber - right.episodeNumber);
        return {
          seasonNumber: season.seasonNumber,
          seasonName: season.seasonName,
          totalEpisodes: season.metadataEpisodes ?? episodes.length,
          episodes,
        };
      });
    const publishedEpisodes = seasons.reduce((total, season) => total + season.episodes.length, 0);
    return {
      id: entry.id,
      title: entry.title,
      year: entry.year,
      poster: entry.poster,
      totalSeasons: entry.metadataSeasons ?? seasons.length,
      totalEpisodes: entry.metadataEpisodes ?? publishedEpisodes,
      seasons,
    };
  });

  movies.forEach((movie, index) => { movie.serial = index + 1; });
  series.forEach((entry, index) => { entry.serial = index + 1; });

  return {
    category: descriptor,
    lastUpdated,
    purpose,
    movies: movies.map((movie) => ({
      serial: movie.serial, id: movie.id, title: movie.title, year: movie.year,
      poster: movie.poster, servers: movie.servers,
    })),
    series: series.map((entry) => ({
      serial: entry.serial, id: entry.id, title: entry.title, year: entry.year,
      poster: entry.poster, totalSeasons: entry.totalSeasons, totalEpisodes: entry.totalEpisodes,
      seasons: entry.seasons,
    })),
    dropped,
  };
}

module.exports = { buildCategoryModel, episodeCode, episodeContentId, isEpisode, seasonNameFor };
