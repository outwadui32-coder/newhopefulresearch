'use strict';

const path = require('node:path');

const DEFAULT_BASE_DIRECTORY = 'data';

// data/<category>/movies/{movies.json,movies.m3u,movies.txt}
// data/<category>/series/{series.json,series.m3u,series.txt}
function categoryPaths(categoryFolder, baseDirectory = DEFAULT_BASE_DIRECTORY) {
  const root = path.resolve(baseDirectory);
  const categoryDirectory = path.join(root, categoryFolder);
  const moviesDirectory = path.join(categoryDirectory, 'movies');
  const seriesDirectory = path.join(categoryDirectory, 'series');
  return {
    root,
    categoryDirectory,
    moviesDirectory,
    seriesDirectory,
    moviesJson: path.join(moviesDirectory, 'movies.json'),
    moviesM3u: path.join(moviesDirectory, 'movies.m3u'),
    moviesText: path.join(moviesDirectory, 'movies.txt'),
    seriesJson: path.join(seriesDirectory, 'series.json'),
    seriesM3u: path.join(seriesDirectory, 'series.m3u'),
    seriesText: path.join(seriesDirectory, 'series.txt'),
  };
}

module.exports = { categoryPaths, DEFAULT_BASE_DIRECTORY };
