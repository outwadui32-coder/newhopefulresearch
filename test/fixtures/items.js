'use strict';

// One authorized-sample category: two movies, one multi-season series, plus the
// messy cases the writers must survive (odd raw dimensions, duplicate captures,
// a disallowed provider, a failed episode, a Specials season).
const CATEGORY = 'Browse: TRENDING NOW';
const LAST_UPDATED = '2026-09-03 07:00 PM';
const PURPOSE = 'Strictly for educational purposes only and not for commercial use';

const items = [
  {
    id: 'movie:10001', type: 'movie', title: 'Demo Movie', year: 2026,
    poster: 'https://image.example.test/demo-movie-poster.jpg',
    streams: [
      { server: 'Ultra', resolution: '3840x2160', url: 'https://stream.example.test/demo-movie/ultra/4k.m3u8', verified: true, exactVariant: true },
      { server: 'Ultra', resolution: '1920x800', url: 'https://stream.example.test/demo-movie/ultra/1080p.m3u8', verified: true, exactVariant: true },
      { server: 'Ultra', resolution: '1620x1080', url: 'https://stream.example.test/demo-movie/ultra/dup.m3u8' },
      { server: 'Premium', resolution: '2560x1440', url: 'https://stream.example.test/demo-movie/premium/2k.m3u8', verified: true, exactVariant: true },
      { server: 'Premium', resolution: '1920x1080', url: 'https://stream.example.test/demo-movie/premium/1080p.m3u8', verified: true, exactVariant: true },
      { server: 'PlayFast', resolution: '1920x960', url: 'https://stream.example.test/demo-movie/playfast/1080p.m3u8', verified: true },
      { server: 'Nova', resolution: '3840x2160', url: 'https://stream.example.test/demo-movie/nova/4k.m3u8' },
      { server: 'Alpha', resolution: '1280x720', url: 'https://stream.example.test/demo-movie/alpha/720p.m3u8' },
    ],
  },
  {
    id: 'movie:10002', type: 'movie', title: 'Demo Movie Two', year: 2026,
    poster: 'https://image.example.test/demo-movie-two-poster.jpg',
    streams: [
      { server: 'Alpha', resolution: '3840x2160', url: 'https://stream.example.test/demo-movie-two/alpha/4k.m3u8', verified: true, exactVariant: true },
      { server: 'Vid', resolution: '1920x1080', url: 'https://stream.example.test/demo-movie-two/ultra/1080p.m3u8', verified: true },
    ],
  },
  { id: 'movie:10003', type: 'movie', title: 'Unplayable Movie', year: 2025, poster: null, streams: [] },
];

const SERIES = {
  seriesId: 'tv:108978', seriesTitle: 'Demo Series', seriesYear: 2022,
  seriesPoster: 'https://image.example.test/demo-series.jpg',
  totalSeasons: 3, totalEpisodes: 20,
};

function episode(seasonNumber, episodeNumber, extra = {}) {
  return {
    ...SERIES, type: 'episode', seasonNumber, episodeNumber,
    episodeName: `Episode ${episodeNumber}`,
    airDate: '2022-02-04',
    poster: `https://image.example.test/${seasonNumber}-${episodeNumber}.jpg`,
    seasonTotalEpisodes: 8,
    streams: [
      { server: 'Alpha', resolution: '1920x804', url: `https://stream.example.test/s${seasonNumber}e${episodeNumber}-alpha-1080p.m3u8`, verified: true, exactVariant: true },
    ],
    ...extra,
  };
}

// Deliberately out of order: season 2 before season 1, episode 3 before 1.
items.push(
  episode(2, 1),
  episode(1, 3),
  episode(1, 1, {
    streams: [
      { server: 'Alpha', resolution: '3840x2160', url: 'https://stream.example.test/s01e01-alpha-4k.m3u8', verified: true, exactVariant: true },
      { server: 'Alpha', resolution: '1920x800', url: 'https://stream.example.test/s01e01-alpha-1080p.m3u8', verified: true, exactVariant: true },
      { server: 'Ultra', resolution: '1620x1080', url: 'https://stream.example.test/s01e01-ultra-1080p.m3u8', verified: true },
      { server: 'Ultra', resolution: '1920x1000', url: 'https://stream.example.test/s01e01-ultra-dup.m3u8' },
    ],
    episodeName: 'Welcome to Margrave',
  }),
  episode(1, 2, { episodeName: 'First Dance' }),
  // Specials must stay in their own season, not merge into season 1.
  episode(0, 1, { episodeName: 'Behind the Scenes', seasonTotalEpisodes: 1 }),
  // A failed episode must not discard the rest of the series.
  episode(2, 2, { streams: [] }),
);

module.exports = { CATEGORY, LAST_UPDATED, PURPOSE, items, SERIES };
