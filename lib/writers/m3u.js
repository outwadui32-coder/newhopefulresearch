'use strict';

// Movies and series get separate playlists. One quality tier is one entry, so a
// player shows the real ladder instead of a single guessed link.

function attributeValue(value) {
  return String(value == null ? '' : value).replace(/["\r\n]/g, ' ').trim();
}

function label(value) {
  return String(value == null ? '' : value).replace(/[\r\n]/g, ' ').trim();
}

function entry(attributes, displayName, url) {
  const rendered = attributes
    .map(([name, value]) => `${name}="${attributeValue(value)}"`)
    .join(' ');
  return [`#EXTINF:-1 ${rendered},${label(displayName)}`, url];
}

function header(model, type) {
  return [
    '#EXTM3U',
    `# CATEGORY: ${attributeValue(model.category.name)}`,
    `# TYPE: ${type}`,
  ];
}

function buildMoviesM3u(model) {
  const lines = header(model, 'MOVIES');
  const groupTitle = `${model.category.displayName} | Movies`;
  for (const movie of model.movies) {
    for (const server of movie.servers) {
      for (const quality of server.qualities) {
        lines.push('');
        lines.push(...entry([
          ['tvg-id', movie.id],
          ['tvg-name', movie.title],
          ['tvg-logo', movie.poster],
          ['group-title', groupTitle],
          ['server', server.name],
          ['quality', quality.quality],
          ['resolution', quality.resolution],
        ], `${movie.title} [${server.name}] [${quality.quality}]`, quality.url));
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function buildSeriesM3u(model) {
  const lines = header(model, 'SERIES');
  for (const series of model.series) {
    for (const season of series.seasons) {
      // group-title keeps both the series and the season, so seasons stay apart
      // in the player's group list.
      const groupTitle = `${series.title} | ${season.seasonName}`;
      for (const episode of season.episodes) {
        const code = episode.episodeCode;
        for (const server of episode.servers) {
          for (const quality of server.qualities) {
            lines.push('');
            lines.push(...entry([
              ['tvg-id', `${series.id}-${code.toLowerCase()}`],
              ['tvg-name', `${series.title} ${code} - ${episode.episodeName}`],
              ['tvg-logo', episode.poster || series.poster],
              ['group-title', groupTitle],
              ['series', series.title],
              ['season', season.seasonNumber],
              ['episode', episode.episodeNumber],
              ['server', server.name],
              ['quality', quality.quality],
              ['resolution', quality.resolution],
            ], `${series.title} ${code} [${server.name}] [${quality.quality}]`, quality.url));
          }
        }
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { buildMoviesM3u, buildSeriesM3u };
