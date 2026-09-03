'use strict';

// Both JSON files are projections of the one normalized model. Movies and
// series are physically separate documents; neither file ever contains the
// other's records.

function buildMoviesJson(model) {
  return {
    metadata: {
      category: model.category.name,
      totalMovies: model.movies.length,
      lastUpdated: model.lastUpdated,
      purpose: model.purpose,
    },
    movies: model.movies.map((movie) => ({
      serial: movie.serial,
      id: movie.id,
      title: movie.title,
      year: movie.year,
      poster: movie.poster,
      servers: movie.servers.map((server) => ({
        name: server.name,
        qualities: server.qualities.map((entry) => ({
          quality: entry.quality,
          resolution: entry.resolution,
          url: entry.url,
        })),
      })),
    })),
  };
}

function buildSeriesJson(model) {
  return {
    metadata: {
      category: model.category.name,
      totalSeries: model.series.length,
      lastUpdated: model.lastUpdated,
      purpose: model.purpose,
    },
    series: model.series.map((series) => ({
      serial: series.serial,
      id: series.id,
      title: series.title,
      year: series.year,
      poster: series.poster,
      totalSeasons: series.totalSeasons,
      totalEpisodes: series.totalEpisodes,
      seasons: series.seasons.map((season) => ({
        seasonNumber: season.seasonNumber,
        seasonName: season.seasonName,
        totalEpisodes: season.totalEpisodes,
        episodes: season.episodes.map((episode) => ({
          episodeNumber: episode.episodeNumber,
          episodeCode: episode.episodeCode,
          episodeName: episode.episodeName,
          airDate: episode.airDate,
          poster: episode.poster,
          servers: episode.servers.map((server) => ({
            name: server.name,
            qualities: server.qualities.map((entry) => ({
              quality: entry.quality,
              resolution: entry.resolution,
              url: entry.url,
            })),
          })),
        })),
      })),
    })),
  };
}

function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

module.exports = { buildMoviesJson, buildSeriesJson, serialize };
