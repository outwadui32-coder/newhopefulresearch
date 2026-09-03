'use strict';

const { episodeCode } = require('./model');

// A catalog title is one slot: a movie, or a whole series. Episodes are child
// jobs of their series, never top-level slots. That distinction is the fix for
// the first-episode-only bug: expanding a series used to push its episodes into
// the same budget that limits titles, so a mixed category spent its slots on
// one episode each and the rest of every series was never queued.

function isSeries(title) {
  return title?.type === 'series' || Array.isArray(title?.episodes);
}

function movieJobId(title) {
  return title.id;
}

function episodeJobId(title, episode) {
  return `${title.id}:s${String(episode.seasonNumber).padStart(2, '0')}:e${String(episode.episodeNumber).padStart(2, '0')}`;
}

// Every job a title still owes, in season/episode order. Aired episodes only:
// an episode without an air date, or dated in the future, is not queued.
function pendingJobsFor(title, processed, today) {
  if (!isSeries(title)) {
    const id = movieJobId(title);
    return processed.has(id) ? [] : [{
      jobId: id, type: 'movie', titleId: title.id, title, url: title.url || null,
    }];
  }
  return (title.episodes || [])
    .filter((episode) => Number.isInteger(episode.seasonNumber) && Number.isInteger(episode.episodeNumber))
    .filter((episode) => {
      if (!episode.airDate) return false;
      return String(episode.airDate) <= today;
    })
    .slice()
    .sort((left, right) =>
      left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber)
    .map((episode) => ({
      jobId: episodeJobId(title, episode),
      type: 'episode',
      titleId: title.id,
      title,
      episode,
      episodeCode: episodeCode(episode.seasonNumber, episode.episodeNumber),
      url: episode.url || null,
    }))
    .filter((job) => !processed.has(job.jobId));
}

// Builds one batch. `maxTitles` limits TITLES, not jobs, and a selected series
// contributes all of its remaining aired episodes - a series is never left
// half-scanned just because the title budget ran out.
function buildBatch({ titles = [], maxTitles = 20, processed = [], today = null } = {}) {
  const processedSet = new Set(processed);
  const asOf = today || new Date().toISOString().slice(0, 10);
  const limit = Number.isFinite(maxTitles) ? Math.max(0, maxTitles) : Infinity;

  const pending = [];
  for (const title of titles) {
    const jobs = pendingJobsFor(title, processedSet, asOf);
    if (jobs.length === 0) continue;
    const totalJobs = isSeries(title)
      ? pendingJobsFor(title, new Set(), asOf).length
      : 1;
    pending.push({ title, jobs, resumed: isSeries(title) && jobs.length < totalJobs });
  }

  // A partly-scanned series finishes before any new title starts, so resuming a
  // checkpoint never strands episodes behind a fresh batch.
  const ordered = [
    ...pending.filter((entry) => entry.resumed),
    ...pending.filter((entry) => !entry.resumed),
  ];

  const selected = ordered.slice(0, limit);
  return {
    jobs: selected.flatMap((entry) => entry.jobs),
    titles: selected.map((entry) => entry.title),
    titlesSelected: selected.length,
    titlesRemaining: Math.max(0, ordered.length - selected.length),
    resumedTitles: selected.filter((entry) => entry.resumed).length,
  };
}

// Discovered vs processed, the counters that exposed 138 discovered / 7 processed.
function queueStats(titles = [], processed = [], today = null) {
  const processedSet = new Set(processed);
  const asOf = today || new Date().toISOString().slice(0, 10);
  const movies = titles.filter((title) => !isSeries(title));
  const series = titles.filter(isSeries);
  const allEpisodeJobs = series.flatMap((title) => pendingJobsFor(title, new Set(), asOf));
  return {
    discoveredMovies: movies.length,
    discoveredSeries: series.length,
    discoveredEpisodes: allEpisodeJobs.length,
    processedMovies: movies.filter((title) => processedSet.has(movieJobId(title))).length,
    processedSeries: series.filter((title) =>
      pendingJobsFor(title, processedSet, asOf).length === 0).length,
    processedEpisodes: allEpisodeJobs.filter((job) => processedSet.has(job.jobId)).length,
  };
}

module.exports = { buildBatch, queueStats, pendingJobsFor, isSeries, episodeJobId, movieJobId };
