'use strict';

// The Movie and Series TXT layouts are fixed by the plan. Column widths, blank
// lines and the separator rule below are reproduced exactly; no hash rules,
// tree glyphs or other decoration may be added.

const SEPARATOR = '-'.repeat(36);

// Label column widths, one per block, chosen so every colon in a block lines up.
const WIDTH_MOVIE_ITEM = 11;    // "MOVIE Name"
const WIDTH_SERIES_TOTALS = 15; // "TOTAL EPISODES"
const WIDTH_SERIES_ITEM = 12;   // "SERIES Name"
const WIDTH_SEASON = 15;        // "Season Number" / "TOTAL EPISODES"
const WIDTH_EPISODE = 13;       // "Episode Code" / "Episode Name"
const WIDTH_QUALITY = 14;       // "Resolution-1"

function field(label, width, value) {
  return `${label.padEnd(width)}: ${value == null ? '' : value}`.replace(/\s+$/, '');
}

function serial(value) {
  return String(value).padStart(2, '0');
}

function finalText(lines) {
  while (lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

// SERVER-n blocks with per-server Resolution numbering that restarts at 1.
function serverLines(servers, blankLinesBetweenServers) {
  const lines = [];
  servers.forEach((server, serverIndex) => {
    if (serverIndex > 0) for (let i = 0; i < blankLinesBetweenServers; i += 1) lines.push('');
    lines.push(`SERVER-${serverIndex + 1}: ${server.name}`);
    server.qualities.forEach((entry, qualityIndex) => {
      lines.push('');
      lines.push(field('Quality', WIDTH_QUALITY, entry.quality));
      lines.push(field(`Resolution-${qualityIndex + 1}`, WIDTH_QUALITY, entry.resolution));
      lines.push(field('URL', WIDTH_QUALITY, entry.url));
    });
  });
  return lines;
}

function buildMoviesText(model) {
  const lines = [
    `CATEGORY: ${model.category.name}`,
    'New Movies:',
    `TOTAL MOVIES: ${model.movies.length}`,
    `LAST_UPDATED: ${model.lastUpdated == null ? '' : model.lastUpdated}`,
    `PURPOSE: ${model.purpose}`,
  ];

  model.movies.forEach((movie) => {
    lines.push('', '', `Movie: ${serial(movie.serial)}`, SEPARATOR, '');
    lines.push(
      field('ID', WIDTH_MOVIE_ITEM, movie.id),
      field('MOVIE Name', WIDTH_MOVIE_ITEM, movie.title),
      field('Year', WIDTH_MOVIE_ITEM, movie.year),
      field('Poster', WIDTH_MOVIE_ITEM, movie.poster)
    );
    lines.push('');
    lines.push(...serverLines(movie.servers, 1));
  });

  return finalText(lines);
}

function buildSeriesText(model) {
  const lines = [
    `CATEGORY: ${model.category.name}`,
    'New Series:',
    `TOTAL SERIES: ${model.series.length}`,
    `LAST_UPDATED: ${model.lastUpdated == null ? '' : model.lastUpdated}`,
    `PURPOSE: ${model.purpose}`,
  ];

  model.series.forEach((series) => {
    lines.push('', '', `Series: ${serial(series.serial)}`, SEPARATOR, '');
    lines.push(
      field('TOTAL SEASONS', WIDTH_SERIES_TOTALS, series.totalSeasons),
      field('TOTAL EPISODES', WIDTH_SERIES_TOTALS, series.totalEpisodes),
      ''
    );
    lines.push(
      field('ID', WIDTH_SERIES_ITEM, series.id),
      field('SERIES Name', WIDTH_SERIES_ITEM, series.title),
      field('Year', WIDTH_SERIES_ITEM, series.year),
      field('Poster', WIDTH_SERIES_ITEM, series.poster)
    );

    series.seasons.forEach((season) => {
      lines.push('', '', `Season: ${serial(season.seasonNumber)}`, SEPARATOR, '');
      lines.push(
        field('Season Name', WIDTH_SEASON, season.seasonName),
        field('Season Number', WIDTH_SEASON, season.seasonNumber),
        field('TOTAL EPISODES', WIDTH_SEASON, season.totalEpisodes)
      );

      season.episodes.forEach((episode) => {
        lines.push('', '', `Episode: ${serial(episode.episodeNumber)}`, SEPARATOR, '');
        lines.push(
          field('Episode Code', WIDTH_EPISODE, episode.episodeCode),
          field('Episode Name', WIDTH_EPISODE, episode.episodeName),
          field('Air Date', WIDTH_EPISODE, episode.airDate),
          field('Poster', WIDTH_EPISODE, episode.poster)
        );
        lines.push('');
        lines.push(...serverLines(episode.servers, 2));
      });
    });
  });

  return finalText(lines);
}

module.exports = { buildMoviesText, buildSeriesText, SEPARATOR };
