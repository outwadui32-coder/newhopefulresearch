'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { categoryPaths, DEFAULT_BASE_DIRECTORY } = require('./paths');
const json = require('./writers/json');
const text = require('./writers/text');
const m3u = require('./writers/m3u');

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
  return filePath;
}

// All six files are projections of the same normalized model - no format
// re-derives the data with its own logic, so JSON, TXT and M3U cannot disagree.
// A movies/ or series/ folder is created only when that content type has
// records, so a movie-only category never gets an empty series/ folder.
function writeCategoryOutputs(model, { baseDirectory = DEFAULT_BASE_DIRECTORY } = {}) {
  const paths = categoryPaths(model.category.folder, baseDirectory);
  const written = [];

  if (model.movies.length > 0) {
    written.push(
      writeFile(paths.moviesJson, json.serialize(json.buildMoviesJson(model))),
      writeFile(paths.moviesText, text.buildMoviesText(model)),
      writeFile(paths.moviesM3u, m3u.buildMoviesM3u(model))
    );
  }
  if (model.series.length > 0) {
    written.push(
      writeFile(paths.seriesJson, json.serialize(json.buildSeriesJson(model))),
      writeFile(paths.seriesText, text.buildSeriesText(model)),
      writeFile(paths.seriesM3u, m3u.buildSeriesM3u(model))
    );
  }

  return { paths, written };
}

module.exports = { writeCategoryOutputs, writeFile };
