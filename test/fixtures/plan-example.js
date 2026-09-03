'use strict';

// Mirrors the worked example in the plan (PART-9 / PART-10) so the TXT writers
// can be compared against a hand-written golden file byte for byte.
const CATEGORY = 'Browse: TRENDING NOW';
const LAST_UPDATED = '2026-09-03 07:00 PM';
const PURPOSE = 'Strictly for educational purposes only and not for commercial use';

const movies = [
  {
    id: 'movie:10001', type: 'movie', title: 'Demo Movie', year: 2026,
    poster: 'https://image.example.com/demo-movie-poster.jpg',
    streams: [
      { server: 'Ultra', resolution: '3840x2160', url: 'https://stream.example.com/demo-movie/ultra/4k.m3u8' },
      { server: 'Ultra', resolution: '1920x1080', url: 'https://stream.example.com/demo-movie/ultra/1080p.m3u8' },
      { server: 'Premium', resolution: '2560x1440', url: 'https://stream.example.com/demo-movie/premium/2k.m3u8' },
      { server: 'Premium', resolution: '1920x1080', url: 'https://stream.example.com/demo-movie/premium/1080p.m3u8' },
      { server: 'PlayFast', resolution: '1920x1080', url: 'https://stream.example.com/demo-movie/playfast/1080p.m3u8' },
    ],
  },
  {
    id: 'movie:10002', type: 'movie', title: 'Demo Movie Two', year: 2026,
    poster: 'https://image.example.com/demo-movie-two-poster.jpg',
    streams: [
      { server: 'Alpha', resolution: '3840x2160', url: 'https://stream.example.com/demo-movie-two/alpha/4k.m3u8' },
      { server: 'Ultra', resolution: '1920x1080', url: 'https://stream.example.com/demo-movie-two/ultra/1080p.m3u8' },
    ],
  },
];

const SERIES = {
  seriesId: 'tv:108978', seriesTitle: 'Demo Series', seriesYear: 2022,
  seriesPoster: 'https://image.example.com/demo-series.jpg',
  totalSeasons: 4, totalEpisodes: 32,
};

function episode(seasonNumber, episodeNumber, episodeName, airDate, streams) {
  return {
    ...SERIES, type: 'episode', seasonNumber, episodeNumber, episodeName, airDate,
    seasonTotalEpisodes: 8,
    poster: 'https://image.example.com/demo-series-still.jpg',
    streams,
  };
}

const series = [
  episode(1, 1, 'Welcome to Margrave', '2022-02-04', [
    { server: 'Alpha', resolution: '3840x2160', url: 'https://stream.example.com/s01e01-alpha-4k.m3u8' },
    { server: 'Alpha', resolution: '1920x1080', url: 'https://stream.example.com/s01e01-alpha-1080p.m3u8' },
    { server: 'Ultra', resolution: '1920x1080', url: 'https://stream.example.com/s01e01-ultra-1080p.m3u8' },
  ]),
  episode(1, 2, 'First Dance', '2022-02-04', [
    { server: 'Premium', resolution: '2560x1440', url: 'https://stream.example.com/s01e02-premium-2k.m3u8' },
    { server: 'Premium', resolution: '1920x1080', url: 'https://stream.example.com/s01e02-premium-1080p.m3u8' },
  ]),
  episode(1, 3, 'Spoonful', '2022-02-04', [
    { server: 'PlayFast', resolution: '1920x1080', url: 'https://stream.example.com/s01e03-playfast-1080p.m3u8' },
  ]),
  episode(2, 1, 'ATM', '2023-12-15', [
    { server: 'Ultra', resolution: '3840x2160', url: 'https://stream.example.com/s02e01-ultra-4k.m3u8' },
    { server: 'Ultra', resolution: '1920x1080', url: 'https://stream.example.com/s02e01-ultra-1080p.m3u8' },
  ]),
  episode(2, 2, 'What Happens in Atlantic City', '2023-12-15', [
    { server: 'Alpha', resolution: '1920x1080', url: 'https://stream.example.com/s02e02-alpha-1080p.m3u8' },
  ]),
];

module.exports = { CATEGORY, LAST_UPDATED, PURPOSE, movies, series, items: [...movies, ...series] };
