const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { execFile } = require('node:child_process');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const {
  CANONICAL_SERVERS,
  normalizeQuality,
  qualitiesFromManifest,
} = require('./lib');

puppeteer.use(StealthPlugin());

const PREFERRED_SERVERS = CANONICAL_SERVERS;
const SERVER_ALIASES = Object.freeze({
  Alpha: ['Alpha'],
  Premium: ['Premium'],
  Orion: ['Orion'],
  // Redflix currently exposes the former Ultra slot as "Vid".
  Ultra: ['Ultra', 'Vid'],
  PlayFast: ['PlayFast'],
});
const SERVER_ROUTE_KEYS = Object.freeze({
  Alpha: 'vidfast',
  Premium: 'vidup',
  Orion: 'vidcore',
  Ultra: 'vid',
  PlayFast: null,
});

// Some ad popups close before puppeteer-extra finishes applying its page hooks.
// That race is harmless and must not terminate an otherwise successful scan.
process.on('unhandledRejection', (error) => {
  const message = error?.message || String(error);
  if (/TargetCloseError|Session closed|Target closed/i.test(message)) return;
  console.error('[UNHANDLED]', message);
});

const DEFAULT_TIMEOUT_SECONDS = 75;
const DEFAULT_OUTPUT = 'stream-results.json';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function usage() {
  console.log(`
Redflix final-stream scanner

Usage:
  npm start
  node collector.js --url "https://redflix.co/play?id=1480574&type=movie"
  node collector.js --id 1480574 --type movie
  node collector.js --id 95350 --type tv --season 1 --episode 1

Options:
  --url URL          A redflix.co play/play2 URL
  --id ID            TMDB movie or TV id
  --type movie|tv|anime
  --season NUMBER    TV season
  --episode NUMBER   TV episode
  --timeout SECONDS  Capture time (default: ${DEFAULT_TIMEOUT_SECONDS})
  --headless         Run Chrome without a visible window
  --output FILE      JSON result path (default: ${DEFAULT_OUTPUT})
  --help             Show this help
`);
}

async function getCommandLineArgs(argv) {
  if (argv.length > 0) return argv;

  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(
      'Paste Redflix play URL (or only the TMDB ID), then press Enter: '
    )).trim();
    if (!answer) throw new Error('A Redflix play URL or TMDB ID is required');
    if (/^https?:\/\//i.test(answer)) return ['--url', answer];
    if (/^\d+$/.test(answer)) return ['--id', answer, '--type', 'movie'];
    throw new Error('Input must be a Redflix play URL or a numeric TMDB ID');
  } finally {
    terminal.close();
  }
}

function parseArgs(argv) {
  const options = {
    type: 'movie',
    timeout: DEFAULT_TIMEOUT_SECONDS,
    headless: false,
    output: DEFAULT_OUTPUT,
    serverWorkers: 5,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--headless') options.headless = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[key] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.help) return options;

  options.timeout = Number(options.timeout);
  options.serverWorkers = Number(options['server-workers'] || options.serverWorkers);
  if (!Number.isFinite(options.timeout) || options.timeout < 10) {
    throw new Error('--timeout must be at least 10 seconds');
  }
  if (!['movie', 'tv', 'anime'].includes(options.type)) {
    throw new Error('--type must be movie, tv, or anime');
  }
  if (!Number.isInteger(options.serverWorkers) || options.serverWorkers < 1 || options.serverWorkers > 5) {
    throw new Error('--server-workers must be an integer from 1 to 5');
  }
  if (!options.url && !options.id) throw new Error('Provide either --url or --id');

  if (options.url) {
    const parsed = new URL(options.url);
    if (!/(^|\.)redflix\.co$/i.test(parsed.hostname)) {
      throw new Error('--url must point to redflix.co');
    }
    const idRoute = /^\/play2?$/i.test(parsed.pathname);
    const seoWatchRoute = /^\/(?:movie|tv)\/[^/]*\d+\/watch\/?$/i.test(parsed.pathname);
    if (!idRoute && !seoWatchRoute) {
      throw new Error('--url must be a Redflix play URL or SEO watch URL');
    }
    options.targetUrl = parsed.href;
  } else {
    const target = new URL('https://redflix.co/play');
    target.searchParams.set('id', options.id);
    target.searchParams.set('type', options.type);
    if (options.type === 'tv') {
      if (options.season) target.searchParams.set('season', options.season);
      if (options.episode) target.searchParams.set('episode', options.episode);
    }
    options.targetUrl = target.href;
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname.length > 90 ? `${url.pathname.slice(0, 87)}...` : url.pathname}`;
  } catch (_) {
    return String(value || '').slice(0, 120);
  }
}

function resolveSourcePlan(discoveredServers) {
  return PREFERRED_SERVERS.map((server) => {
    const aliases = SERVER_ALIASES[server] || [server];
    const sourceLabel = discoveredServers.find((label) =>
      aliases.some((alias) => alias.toLowerCase() === label.toLowerCase())
    );
    // The source-button surface can load late or be temporarily absent while
    // the deterministic ?server= routes still work. Keep every canonical
    // server in the plan so a missing discovery result never becomes a
    // silently skipped provider attempt. Ultra's current UI label is "Vid".
    return { server, sourceLabel: sourceLabel || aliases[aliases.length - 1] };
  });
}

function serverRoute(targetUrl, server) {
  const routeKey = SERVER_ROUTE_KEYS[server];
  if (!routeKey) return targetUrl;
  const target = new URL(targetUrl);
  target.searchParams.set('server', routeKey);
  return target.href;
}

function cleanHeaders(headers = {}) {
  const wanted = ['referer', 'origin', 'user-agent', 'authorization', 'cookie'];
  return Object.fromEntries(wanted.filter((name) => headers[name]).map((name) => [name, headers[name]]));
}

function mediaKind(url, contentType = '', bodyPrefix = '') {
  const lowerUrl = url.toLowerCase();
  const mime = contentType.toLowerCase().split(';', 1)[0].trim();
  const prefix = bodyPrefix.trimStart();

  if (
    prefix.startsWith('#EXTM3U') ||
    ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl'].includes(mime) ||
    /(?:\.m3u8)(?:$|[?#])/i.test(lowerUrl)
  ) return 'hls';

  if (
    (prefix.startsWith('<?xml') && prefix.includes('<MPD')) ||
    mime === 'application/dash+xml' ||
    /(?:\.mpd)(?:$|[?#])/i.test(lowerUrl)
  ) return 'dash';

  if (mime.startsWith('video/') || /(?:\.mp4|\.webm|\.mkv)(?:$|[?#])/i.test(lowerUrl)) {
    return 'video';
  }
  return null;
}

function looksLikeManifestCandidate(url, resourceType, contentType = '') {
  if (mediaKind(url, contentType)) return true;
  if (!['xhr', 'fetch', 'media'].includes(resourceType)) return false;
  return /(manifest|master|playlist|stream|source|hls|dash|video)/i.test(url) ||
    /mpegurl|dash\+xml|video\//i.test(contentType);
}

function isSegment(url) {
  let decodedUrl = url;
  try { decodedUrl = decodeURIComponent(url); } catch (_) {}
  return /(?:\.ts|\.m4s|\.cmfv|\.cmfa|\.aac)(?:$|[?#])/i.test(decodedUrl) ||
    /(?:^|[/?&])(segment|chunk)[-_=/]?\d/i.test(decodedUrl) ||
    /(?:^|[/=&])(page|segment|chunk)[-_]?\d+\.html(?:$|[?&#])/i.test(decodedUrl);
}

function isExplicitLowQualityUrl(url) {
  let decodedUrl = String(url || '');
  try { decodedUrl = decodeURIComponent(decodedUrl); } catch (_) {}
  return /(?:^|[/_.=-])(240|360|480|540|576|720)(?:p|[/_.?&=-]|$)/i.test(decodedUrl);
}

function parseHlsVariants(manifest, baseUrl) {
  const lines = manifest.split(/\r?\n/);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const attributes = line.slice('#EXT-X-STREAM-INF:'.length);
    let uri = '';
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next].trim();
      if (!candidate || candidate.startsWith('#')) continue;
      uri = candidate;
      break;
    }
    if (!uri) continue;
    const resolution = attributes.match(/RESOLUTION=(\d+x\d+)/i)?.[1] || null;
    const bandwidth = Number(attributes.match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i)?.[1]) || null;
    const name = attributes.match(/NAME="([^"]+)"/i)?.[1] || null;
    const codecs = attributes.match(/CODECS="([^"]+)"/i)?.[1] || null;
    let url;
    try { url = new URL(uri, baseUrl).href; } catch (_) { continue; }
    variants.push({ resolution, name, bandwidth, codecs, url });
  }
  return variants.filter((item, index, all) => all.findIndex((other) => other.url === item.url) === index);
}

function resolutionDimensions(value) {
  const match = String(value || '').match(/^(\d+)x(\d+)$/i);
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function is1080ClassResolution(value) {
  const dimensions = resolutionDimensions(value);
  return Boolean(dimensions && (dimensions.width >= 1920 || dimensions.height >= 1080));
}

function mediaUrlsFromText(text, baseUrl) {
  if (!text || (!/m3u8|\.mpd/i.test(text))) return [];
  const normalized = text.replace(/\\u002f/gi, '/').replace(/\\\//g, '/');
  const matches = normalized.match(/(?:https?:\/\/[^\s"'<>]+|(?:\.\.\/|\.\/|\/)[^\s"'<>]+)\.(?:m3u8|mpd)(?:\?[^\s"'<>]*)?/gi) || [];
  const urls = [];
  for (const match of matches) {
    try {
      const url = new URL(match, baseUrl).href;
      if (!urls.includes(url)) urls.push(url);
    } catch (_) {}
  }
  return urls;
}

async function runPool(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function highest1080ClassVariant(variants) {
  return variants
    .filter((variant) => is1080ClassResolution(variant.resolution))
    .sort((left, right) => {
      const a = resolutionDimensions(left.resolution);
      const b = resolutionDimensions(right.resolution);
      return (b.width * b.height) - (a.width * a.height) || (b.bandwidth || 0) - (a.bandwidth || 0);
    })[0] || null;
}

function firstHlsMediaUrl(manifest, baseUrl) {
  const mapUri = manifest.match(/#EXT-X-MAP:[^\r\n]*URI="([^"]+)"/i)?.[1];
  if (mapUri) {
    try { return new URL(mapUri, baseUrl).href; } catch (_) {}
  }
  for (const rawLine of manifest.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    try { return new URL(line, baseUrl).href; } catch (_) {}
  }
  return null;
}

function ffprobeResolution(url) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0', url,
    ], { timeout: 10000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(String(stdout || '').match(/\b\d{2,5}x\d{2,5}\b/)?.[0] || null);
    });
  });
}

function ultraFallbackUrl(targetUrl) {
  try {
    const target = new URL(targetUrl);
    const id = target.searchParams.get('id');
    const type = target.searchParams.get('type');
    if (!id) return null;
    if (type === 'tv') {
      const season = Number(target.searchParams.get('season'));
      const episode = Number(target.searchParams.get('episode'));
      if (!Number.isInteger(season) || !Number.isInteger(episode)) return null;
      const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      return `https://media.vidrift.in/tv_${id}/Season%20${season}/${code}/vod.m3u8`;
    }
    return `https://media.vidrift.in/movie_${id}/vod.m3u8`;
  } catch (_) {
    return null;
  }
}

async function fetchPrefix(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 8000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: options.range ? { range: 'bytes=0-4095', accept: '*/*' } : { accept: '*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    let body = Buffer.alloc(0);
    if (reader) {
      while (body.length < (options.limit || 512 * 1024)) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) body = Buffer.concat([body, Buffer.from(value)]);
        if (options.range && body.length > 0) break;
      }
      await reader.cancel().catch(() => {});
    }
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      contentType: response.headers.get('content-type') || '',
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeCandidate(candidate) {
  try {
    const response = await fetchPrefix(candidate.url, { range: candidate.kind === 'video' });
    const prefix = response.body.toString('utf8');
    const verifiedKind = mediaKind(response.url, response.contentType, prefix);
    const declared = qualitiesFromManifest(prefix, response.url);
    const verifiedVariants = [];

    if (verifiedKind === 'hls' && declared.length > 0) {
      for (const variant of declared) {
        const child = await fetchPrefix(variant.url);
        const childManifest = child.body.toString('utf8');
        const mediaUrl = child.ok ? firstHlsMediaUrl(childManifest, child.url) : null;
        const mediaProbe = mediaUrl ? await fetchPrefix(mediaUrl, { range: true, limit: 4096 }) : null;
        if (child.ok && /^\s*#EXTM3U/.test(childManifest) && mediaProbe?.ok && mediaProbe.body.length > 0) {
          verifiedVariants.push({ ...variant, url: child.url, mediaSegmentStatus: mediaProbe.status });
        }
      }
    } else if (verifiedKind === 'hls') {
      const measuredResolution = candidate.observedResolution || await ffprobeResolution(response.url);
      const normalized = normalizeQuality(measuredResolution);
      const mediaUrl = firstHlsMediaUrl(prefix, response.url);
      const mediaProbe = mediaUrl ? await fetchPrefix(mediaUrl, { range: true, limit: 4096 }) : null;
      if (normalized && mediaProbe?.ok && mediaProbe.body.length > 0) {
        verifiedVariants.push({
          ...normalized,
          rawResolution: measuredResolution,
          url: response.url,
          exactVariant: true,
          exactStandard: measuredResolution === normalized.resolution,
          mediaSegmentStatus: mediaProbe.status,
        });
      }
    } else if (verifiedKind === 'dash' && response.ok) {
      verifiedVariants.push(...declared);
    }

    const best = verifiedVariants[0] || null;
    const qualityVerified = verifiedVariants.length > 0;
    return {
      ok: response.ok && Boolean(verifiedKind) && qualityVerified,
      status: response.status,
      finalUrl: response.url,
      contentType: response.contentType,
      verifiedKind,
      manifestSignature: prefix.trimStart().startsWith('#EXTM3U'),
      variants: declared,
      verifiedVariants,
      quality: best?.quality || null,
      resolution: best?.rawResolution || best?.resolution || candidate.observedResolution || null,
      directPlaybackNoHeaders: qualityVerified,
      mediaSegmentStatus: best?.mediaSegmentStatus || null,
      rejectionReason: qualityVerified ? null : 'no directly playable 1080-class-or-higher stream without headers',
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function triggerPlayback(page) {
  for (const frame of page.frames()) {
    try {
      const frameUrl = new URL(frame.url());
      if (/(^|\.)redflix\.co$/i.test(frameUrl.hostname)) continue;
      await frame.evaluate(() => {
        document.querySelectorAll('video').forEach((video) => {
          video.muted = true;
          const result = video.play();
          if (result?.catch) result.catch(() => {});
        });
        const selectors = [
          '.jw-display-icon-container', '.jw-icon-playback', '.vjs-big-play-button',
          '[aria-label*="play" i]', '[title*="play" i]', '#play-button', '.play-button',
        ];
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (element instanceof HTMLElement) {
            element.click();
            break;
          }
        }
      });
    } catch (_) {
      // A provider frame can be blank or detach while it redirects.
    }
  }
}

async function pageVideoResolution(page) {
  const dimensions = [];
  for (const frame of page.frames()) {
    try {
      dimensions.push(...await frame.evaluate(() => [...document.querySelectorAll('video')]
        .map((video) => ({ width: video.videoWidth, height: video.videoHeight }))
        .filter((item) => item.width > 0 && item.height > 0)));
    } catch (_) {}
  }
  const best = dimensions.sort((left, right) =>
    (right.width * right.height) - (left.width * left.height)
  )[0];
  return best ? `${best.width}x${best.height}` : null;
}

async function performanceMediaUrls(page) {
  const urls = [];
  for (const frame of page.frames()) {
    try {
      for (const value of await frame.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name))) {
        if (mediaKind(value) && !urls.includes(value)) urls.push(value);
      }
    } catch (_) {}
  }
  return urls;
}

async function sourceLabels(page) {
  return page.evaluate(() => {
    let container = document.querySelector('#watch-streaming-sources');
    if (!container) {
      const heading = [...document.querySelectorAll('h1,h2,h3,h4,div,span')]
        .find((element) => /^streaming servers?$/i.test(element.textContent?.trim() || ''));
      container = heading?.parentElement || null;
    }
    if (!container) return [];
    return [...container.querySelectorAll('button')]
      .map((button) => button.textContent?.trim())
      .filter((label) => label && label.length <= 40);
  }).catch(() => []);
}

async function sourceState(page, label) {
  return page.evaluate((wanted) => {
    let container = document.querySelector('#watch-streaming-sources');
    if (!container) {
      const heading = [...document.querySelectorAll('h1,h2,h3,h4,div,span')]
        .find((element) => /^streaming servers?$/i.test(element.textContent?.trim() || ''));
      container = heading?.parentElement || document;
    }
    const button = [...container.querySelectorAll('button')]
      .find((item) => item.textContent?.trim().toLowerCase() === wanted.toLowerCase());
    return {
      found: Boolean(button),
      selected: button?.getAttribute('aria-pressed') === 'true',
      pageUrl: location.href,
      iframeUrl: document.querySelector('iframe[src]')?.src || null,
    };
  }, label).catch((error) => ({ found: false, selected: false, error: error.message }));
}

function isActivatedSourceState(state) {
  return Boolean(state?.found && state?.selected && state?.iframeUrl);
}

function attributedServer(frameUrl, fallbackServer, providerHosts) {
  try {
    const hostname = new URL(frameUrl).hostname.toLowerCase();
    for (const [providerHost, server] of providerHosts.entries()) {
      const normalized = String(providerHost).toLowerCase();
      if (hostname === normalized || hostname.endsWith(`.${normalized}`)) return server;
    }
  } catch (_) {}
  return fallbackServer || null;
}

async function selectSource(page, label) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const before = await sourceState(page, label);
    if (!before.found) return { selected: false, attempt, ...before };
    const handles = await page.$$('#watch-streaming-sources button');
    let clicked = false;
    for (const handle of handles) {
      const text = await handle.evaluate((button) => button.textContent?.trim() || '').catch(() => '');
      if (text.toLowerCase() !== label.toLowerCase()) continue;
      await handle.evaluate((button) => button.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
      await handle.click({ delay: 80 }).catch(() => {});
      clicked = true;
      break;
    }
    if (!clicked) return { selected: false, attempt, ...before };
    await sleep(1200 * attempt);
    const after = await sourceState(page, label);
    if (isActivatedSourceState(after)) return { attempt, before, ...after, selected: true };
  }
  return { ...(await sourceState(page, label)), selected: false, attempts: 3 };
}

async function startScanner(options) {
  console.log('\n==================================================');
  console.log('REDFLIX FINAL-STREAM SCANNER');
  console.log(`Target: ${options.targetUrl}`);
  console.log('==================================================\n');

  const browser = await puppeteer.launch({
    headless: options.headless,
    ignoreDefaultArgs: ['--disable-popup-blocking'],
    defaultViewport: options.headless ? { width: 1365, height: 768 } : null,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--start-maximized',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=IsolateOrigins,site-per-process',
      '--renderer-process-limit=2', '--disable-gpu', '--disable-extensions',
      '--disable-background-networking',
    ],
  });

  const candidates = new Map();
  const embeds = new Set();
  const pages = new Set();
  const pendingInspections = new Set();
  const providerHosts = new Map();
  const frameServers = new WeakMap();
  const pageServers = new WeakMap();

  function requestServer(request) {
    const frame = request.frame();
    const ownerPage = typeof frame?.page === 'function' ? frame.page() : null;
    const fallback = pageServers.get(ownerPage) || null;
    return frameServers.get(frame) || attributedServer(frame?.url(), fallback, providerHosts);
  }

  function saveCandidate(data, server = null) {
    if (!server || !data.kind || isSegment(data.url) || isExplicitLowQualityUrl(data.url)) return;
    const key = `${server}\n${data.url}`;
    const existing = candidates.get(key);
    candidates.set(key, { ...existing, ...data, server });
    if (!existing) console.log(`[MEDIA ${server} ${data.kind.toUpperCase()}] ${shortUrl(data.url)}`);
  }

  function inspectPage(page) {
    if (pages.has(page)) return;
    pages.add(page);
    page.setUserAgent(USER_AGENT).catch(() => {});

    page.on('request', (request) => {
      const url = request.url();
      const type = request.resourceType();
      const headers = cleanHeaders(request.headers());
      const kind = mediaKind(url);
      const server = requestServer(request);
      if (kind) saveCandidate({ url, kind, resourceType: type, headers, detectedBy: 'request-url' }, server);
      if (request.isNavigationRequest() && request.frame() !== page.mainFrame()) embeds.add(url);
    });

    page.on('response', (response) => {
      const request = response.request();
      const url = response.url();
      const type = request.resourceType();
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const kind = mediaKind(url, contentType);
      const server = requestServer(request);

      if (kind && !isSegment(url)) {
        saveCandidate({
          url, kind, status: response.status(), contentType, resourceType: type,
          headers: cleanHeaders(request.headers()), detectedBy: 'response-mime-or-url',
        }, server);
      }

      if (!kind && (looksLikeManifestCandidate(url, type, contentType) || ['xhr', 'fetch'].includes(type))) {
        const contentLength = Number(headers['content-length']) || 0;
        if (contentLength > 2 * 1024 * 1024) return;
        const inspection = response.buffer()
          .then((body) => {
            const prefix = body.subarray(0, 8192).toString('utf8');
            const bodyKind = mediaKind(url, contentType, prefix);
            if (bodyKind) {
              saveCandidate({
                url, kind: bodyKind, status: response.status(), contentType,
                resourceType: type, headers: cleanHeaders(request.headers()),
                detectedBy: 'response-body',
              }, server);
            }
            for (const mediaUrl of mediaUrlsFromText(body.subarray(0, 2 * 1024 * 1024).toString('utf8'), url)) {
              saveCandidate({
                url: mediaUrl, kind: mediaKind(mediaUrl), status: response.status(), contentType,
                resourceType: type, headers: cleanHeaders(request.headers()), detectedBy: 'response-payload-url',
              }, server);
            }
          })
          .catch(() => {})
          .finally(() => pendingInspections.delete(inspection));
        pendingInspections.add(inspection);
      }
    });
  }

  browser.on('targetcreated', async (target) => {
    const targetPage = await target.page().catch(() => null);
    if (targetPage) {
      const opener = target.opener();
      const openerPage = opener ? await opener.page().catch(() => null) : null;
      const openerServer = openerPage ? pageServers.get(openerPage) : null;
      if (openerServer) pageServers.set(targetPage, openerServer);
      inspectPage(targetPage);
    }
  });

  const [page] = await browser.pages();
  inspectPage(page);
  const startedAt = new Date().toISOString();
  let navigationError = null;
  let discoveredServers = [];
  let serverResults = [];

  try {
    console.log('[1/4] Opening the exact Redflix play route...');
    await page.goto(options.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('[2/4] Waiting for the provider iframe...');
    await page.waitForSelector('iframe', { timeout: 30000 }).catch(() => null);
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) embeds.add(frame.url());
    }

    console.log('[3/4] Cycling streaming sources and monitoring every frame/tab...');
    await page.waitForSelector('#watch-streaming-sources button', { timeout: 20000 }).catch(() => null);
    discoveredServers = await sourceLabels(page);
    console.log(`[SOURCES FOUND] ${discoveredServers.length}`);
    const sourcePlan = resolveSourcePlan(discoveredServers);
    console.log(`[PREFERRED SOURCES] ${sourcePlan.map(({ server, sourceLabel }) =>
      server === sourceLabel ? server : `${server}<-${sourceLabel}`
    ).join(', ') || 'none available'}`);
    const sourceWindow = Math.max(5000, Math.min(8000, options.timeout * 1000));
    serverResults = [];
    await runPool(sourcePlan, options.serverWorkers, async ({ server: label, sourceLabel }) => {
      const sourcePage = await browser.newPage();
      pageServers.set(sourcePage, label);
      inspectPage(sourcePage);
      const status = { server: label, sourceLabel, selected: false, iframeUrl: null, error: null };
      try {
        const exactSourceRoute = serverRoute(options.targetUrl, label);
        await sourcePage.goto(exactSourceRoute, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await sourcePage.waitForSelector('#watch-streaming-sources button, iframe', { timeout: 8000 }).catch(() => null);
        const routedState = await sourceState(sourcePage, sourceLabel);
        const selection = isActivatedSourceState(routedState)
          ? { ...routedState, selected: true, routeActivated: true }
          : await selectSource(sourcePage, sourceLabel);
        status.selected = Boolean(selection.selected);
        status.iframeUrl = selection.iframeUrl || null;
        if (!selection.selected) {
          const state = await sourcePage.evaluate(() => ({
            url: location.href,
            sourceButtons: document.querySelectorAll('#watch-streaming-sources button').length,
          })).catch((error) => ({ error: error.message }));
          status.error = 'source-not-activated';
          console.log(`[SOURCE NOT ACTIVATED] ${label} ${JSON.stringify({ selection, state })}`);
          return;
        }
        console.log(`[SOURCE PARALLEL] ${label} (${sourceLabel}) -> ${shortUrl(selection.iframeUrl)}`);
        try {
          const providerHost = new URL(selection.iframeUrl).hostname;
          providerHosts.set(providerHost, label);
          for (const frame of sourcePage.frames()) {
            const frameHost = new URL(frame.url()).hostname;
            if (frameHost === providerHost || frameHost.endsWith(`.${providerHost}`)) frameServers.set(frame, label);
          }
        } catch (_) {}
        await sleep(1500);
        const sourceDeadline = Date.now() + sourceWindow;
        while (Date.now() < sourceDeadline) {
          await triggerPlayback(sourcePage);
          status.observedVideoResolution = await pageVideoResolution(sourcePage) || status.observedVideoResolution || null;
          await sleep(1500);
        }
        for (const mediaUrl of await performanceMediaUrls(sourcePage)) {
          saveCandidate({ url: mediaUrl, kind: mediaKind(mediaUrl), detectedBy: 'performance-resource' }, label);
        }
        if (![...candidates.values()].some((item) => item.server === label)) {
          console.log(`[PROVIDER TOP-LEVEL FALLBACK] ${label} -> ${shortUrl(selection.iframeUrl)}`);
          const providerPage = await browser.newPage();
          pageServers.set(providerPage, label);
          inspectPage(providerPage);
          try {
            await providerPage.setExtraHTTPHeaders({ referer: exactSourceRoute });
            await providerPage.goto(selection.iframeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const directDeadline = Date.now() + 5000;
            while (Date.now() < directDeadline) {
              await triggerPlayback(providerPage);
              status.observedVideoResolution = await pageVideoResolution(providerPage) || status.observedVideoResolution || null;
              await sleep(1250);
            }
            for (const mediaUrl of await performanceMediaUrls(providerPage)) {
              saveCandidate({ url: mediaUrl, kind: mediaKind(mediaUrl), detectedBy: 'top-level-performance-resource' }, label);
            }
          } catch (error) {
            status.topLevelFallbackError = error.message;
          } finally {
            await providerPage.close().catch(() => {});
          }
        }
        if (status.observedVideoResolution) {
          for (const candidate of candidates.values()) {
            if (candidate.server === label && !candidate.observedResolution) {
              candidate.observedResolution = status.observedVideoResolution;
            }
          }
        }
      } catch (error) {
        status.error = error.message;
        console.log(`[SOURCE FAILED] ${label}: ${error.message}`);
      } finally {
        serverResults.push(status);
        await sourcePage.close().catch(() => {});
      }
    });
    if (candidates.size > 0) await sleep(2000);
    await Promise.race([
      Promise.allSettled([...pendingInspections]),
      sleep(3000),
    ]);
  } catch (error) {
    navigationError = error.message;
    console.error(`[ERROR] ${navigationError}`);
  }

  console.log('[4/4] Probing captured final-media candidates...');
  const ultraFallback = ultraFallbackUrl(options.targetUrl);
  if (ultraFallback) {
    saveCandidate({ url: ultraFallback, kind: 'hls', detectedBy: 'verified-ultra-route-fallback' }, 'Ultra');
  }
  const results = [];
  await runPool([...candidates.values()], 12, async (candidate) => {
    const probe = await probeCandidate(candidate);
    if (probe.ok) {
      for (const variant of probe.verifiedVariants) {
        results.push({
          ...candidate,
          url: variant.url,
          probe: {
            ...probe,
            variants: undefined,
            verifiedVariants: undefined,
            quality: variant.quality,
            resolution: variant.rawResolution || variant.resolution,
            standardResolution: variant.resolution,
            bandwidth: variant.bandwidth || 0,
            exactVariant: variant.exactVariant === true,
            exactStandard: variant.exactStandard === true,
            mediaSegmentStatus: variant.mediaSegmentStatus || probe.mediaSegmentStatus,
          },
        });
      }
    } else {
      results.push({ ...candidate, probe });
    }
    console.log(`[${probe.ok ? 'VERIFIED' : 'UNVERIFIED'}] ${candidate.server} ` +
      `${probe.resolution || 'unknown'} ${shortUrl(candidate.url)}${probe.rejectionReason ? ` | ${probe.rejectionReason}` : ''}`);
  });

  for (const status of serverResults) {
    const captured = results.filter((item) => item.server === status.server);
    const verified = captured.filter((item) => item.probe.ok);
    status.capturedCandidates = captured.length;
    status.verifiedCandidates = verified.length;
    status.verifiedResolutions = [...new Set(verified.map((item) => item.probe.resolution).filter(Boolean))];
    console.log(`[SERVER RESULT] ${status.server} | SOURCE=${status.sourceLabel} | ` +
      `SELECTED=${status.selected ? 'YES' : 'NO'} | CAPTURED=${captured.length} | ` +
      `VERIFIED=${verified.length} | RESOLUTIONS=${status.verifiedResolutions.join(',') || 'none'} | ` +
      `VIDEO=${status.observedVideoResolution || 'unknown'} | ` +
      `ERROR=${status.error || status.topLevelFallbackError || 'none'}`);
  }

  const payload = {
    scanner: 'redflix-final-stream-scanner', startedAt,
    finishedAt: new Date().toISOString(), targetUrl: options.targetUrl,
    navigationError, success: results.some((item) => item.probe.ok), finalStreams: results,
    diagnostics: {
      serversDiscovered: discoveredServers,
      serverAttempts: serverResults,
      verifiedServers: [...new Set(results.filter((item) => item.probe.ok).map((item) => item.server))],
      providerFrames: [...embeds].filter(Boolean),
      note: 'providerFrames are diagnostics only; success requires a verified final media URL',
    },
  };

  const outputPath = path.resolve(options.output);
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const closed = await Promise.race([
    browser.close().then(() => true).catch(() => false),
    sleep(5000).then(() => false),
  ]);
  if (!closed) browser.process()?.kill('SIGKILL');

  console.log('\n==================================================');
  console.log(payload.success ? 'SUCCESS: FINAL STREAM VERIFIED' : 'NO VERIFIED FINAL STREAM FOUND');
  console.log(`Final candidates: ${results.length}`);
  if (payload.success) {
    console.log('\nMAIN STREAM LINK(S):');
    results.filter((item) => item.probe.ok).forEach((item) =>
      console.log(`${item.server} | ${item.probe.resolution} | ${shortUrl(item.url)}`)
    );
  }
  console.log(`Result saved: ${outputPath}`);
  console.log('==================================================\n');
  return payload.success ? 0 : 2;
}

async function main() {
  try {
    const args = await getCommandLineArgs(process.argv.slice(2));
    const options = parseArgs(args);
    if (options.help) {
      usage();
      return;
    }
    process.exitCode = await startScanner(options);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    usage();
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs, mediaKind, isSegment, parseHlsVariants, is1080ClassResolution,
  isExplicitLowQualityUrl,
  ffprobeResolution, ultraFallbackUrl,
  highest1080ClassVariant, probeCandidate, sourceLabels, sourceState, selectSource,
  isActivatedSourceState, attributedServer, resolveSourcePlan, serverRoute, mediaUrlsFromText,
};
