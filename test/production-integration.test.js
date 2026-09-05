'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const collector = require('../collector');
const scanner = require('../site-scanner');
const { verifyDataTree } = require('../lib');

async function main() {
  const server = http.createServer((request, response) => {
    if (request.url === '/master.m3u8') {
      response.end([
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080',
        '1080/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=7000000,RESOLUTION=3840x1600',
        '4k/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
        '720/index.m3u8',
      ].join('\n'));
      return;
    }
    if (/\/(?:1080|4k)\/index\.m3u8/.test(request.url)) {
      response.end('#EXTM3U\n#EXTINF:10,\nsegment.ts\n');
      return;
    }
    if (/\/(?:1080|4k)\/segment\.ts/.test(request.url)) {
      response.setHeader('content-type', 'video/mp2t');
      response.end('verified-media-bytes');
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const probe = await collector.probeCandidate({
      url: `${base}/master.m3u8`, kind: 'hls', server: 'Alpha',
    });
    assert.equal(probe.ok, true);
    assert.deepEqual(probe.verifiedVariants.map((item) => item.quality), ['4K', '1080p']);
    assert.deepEqual(probe.verifiedVariants.map((item) => item.url), [
      `${base}/4k/index.m3u8`, `${base}/1080/index.m3u8`,
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const series = { url: 'https://redflix.co/play?id=50&type=tv', categories: ['Browse: Demo'] };
  const movie = { url: 'https://redflix.co/play?id=1&type=movie', categories: ['Browse: Demo'] };
  const episodes = Array.from({ length: 32 }, (_, index) => ({
    url: `https://redflix.co/play?id=50&type=tv&season=${index < 16 ? 1 : 2}&episode=${(index % 16) + 1}`,
    seriesId: 'tv:50', seasonNumber: index < 16 ? 1 : 2, episodeNumber: (index % 16) + 1,
  }));
  const queue = scanner.expandSelectedSeriesQueue([series, movie], [...episodes, movie]);
  assert.equal(queue.length, 33);
  assert.deepEqual(queue.slice(0, 32), episodes);
  assert.equal(queue[32], movie);
  assert.deepEqual(scanner.expandSelectedSeriesQueue([episodes[7]], episodes), episodes,
    'a resumed episode representative expands every remaining episode in its series');
  assert.equal(scanner.takeLogicalTitles([movie, ...episodes], 2).length, 33,
    'one series consumes one title slot while every episode is queued');
  assert.equal(collector.isExplicitLowQualityUrl('https://cdn.test/hls/720/index.m3u8'), true);
  assert.equal(scanner.isExplicitLowQualityUrl('https://cdn.test/hls_mps/x/480/index.m3u8'), true);
  assert.equal(scanner.isExplicitLowQualityUrl('https://cdn.test/hls/1080/index.m3u8'), false);
  assert.deepEqual(collector.resolveSourcePlan([]), [
    { server: 'Alpha', sourceLabel: 'Alpha' },
    { server: 'Premium', sourceLabel: 'Premium' },
    { server: 'Orion', sourceLabel: 'Orion' },
    { server: 'Ultra', sourceLabel: 'Vid' },
    { server: 'PlayFast', sourceLabel: 'PlayFast' },
  ], 'all canonical routes are attempted even when source discovery is temporarily empty');
  assert.equal(
    collector.ultraFallbackUrl('https://redflix.co/play?id=50&type=tv&season=0&episode=2'),
    'https://media.vidrift.in/tv_50/Season%200/S00E02/vod.m3u8'
  );

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-production-'));
  try {
    const fakeProbe = { ok: true, directPlaybackNoHeaders: true, resolution: '1920x800', exactVariant: true };
    const payload = {
      updatedAt: '2026-09-04T10:00:00.000Z',
      catalog: [movie], seriesMetadata: [],
      results: [{ ...movie, title: 'Production Movie', year: 2026, poster: 'https://img.test/p.jpg',
        scan: { finalStreams: [
          { server: 'Alpha', url: 'https://cdn.test/master.m3u8', probe: fakeProbe },
          { server: 'Alpha', url: 'https://cdn.test/backup.m3u8', probe: fakeProbe },
          { server: 'Nova', url: 'https://cdn.test/nova.m3u8', probe: fakeProbe },
        ] } }],
    };
    const result = scanner.publishNormalizedDataTree(payload, { dataDirectory: path.join(temporary, 'data') });
    assert.deepEqual(result.verification.errors, []);
    assert.deepEqual(verifyDataTree(path.join(temporary, 'data')).errors, []);
    const document = JSON.parse(fs.readFileSync(
      path.join(temporary, 'data', 'demo', 'movies', 'movies.json'), 'utf8'
    ));
    assert.deepEqual(document.movies[0].servers[0].qualities, [{
      quality: '1080p', resolution: '1920x1080', url: 'https://cdn.test/master.m3u8',
    }]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }

  console.log('PASS: production collector, full-series queue, normalized writer, and verifier are integrated');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
