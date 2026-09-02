const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const PREFERRED_SERVERS = ['Alpha', 'Premium', 'Orion', 'Ultra', 'PlayFast'];

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
Direct final-stream collector (normally invoked by GitHub Actions)

Usage:
  node collector.js --url "SOURCE_PLAY_URL" --source-origin "https://source.example"

Options:
  --url URL          Source play/watch URL
  --source-origin    MAIN_SOURCE_URL origin
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
      'Paste the source play URL, then press Enter: '
    )).trim();
    if (!answer) throw new Error('A source play URL is required');
    if (/^https?:\/\//i.test(answer)) return ['--url', answer];
    throw new Error('Input must be an HTTP/HTTPS play URL');
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
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--headless') options.headless = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
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
  if (!Number.isFinite(options.timeout) || options.timeout < 10) {
    throw new Error('--timeout must be at least 10 seconds');
  }
  if (!['movie', 'tv', 'anime'].includes(options.type)) {
    throw new Error('--type must be movie, tv, or anime');
  }
  if (!options.url) throw new Error('Provide --url');
  if (!options.sourceOrigin) throw new Error('Provide --source-origin from MAIN_SOURCE_URL');

  if (options.url) {
    const parsed = new URL(options.url);
    const source = new URL(options.sourceOrigin);
    if (parsed.origin !== source.origin) throw new Error('--url must match --source-origin');
    const idRoute = /^\/play2?$/i.test(parsed.pathname);
    const seoWatchRoute = /^\/(?:movie|tv)\/[^/]*\d+\/watch\/?$/i.test(parsed.pathname);
    if (!idRoute && !seoWatchRoute) {
      throw new Error('--url must be a source play URL or SEO watch URL');
    }
    options.targetUrl = parsed.href;
  }
  options.sourceOrigin = new URL(options.sourceOrigin).origin;
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return Boolean(dimensions && (dimensions.width >= 1900 || dimensions.height >= 1080));
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

function manifestUri(manifest, pattern, baseUrl) {
  const uri = (manifest.match(pattern) || [])[1];
  if (!uri) return null;
  try { return new URL(uri, baseUrl).href; } catch (_) { return null; }
}

function hlsAudioPlaylists(manifest, baseUrl) {
  return [...manifest.matchAll(/#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO[^\r\n]*URI="([^"]+)"/gi)]
    .map((match) => {
      try { return new URL(match[1], baseUrl).href; } catch (_) { return null; }
    })
    .filter(Boolean);
}

async function verifyHlsChild(childUrl) {
  const child = await fetchPrefix(childUrl);
  const manifest = child.body.toString('utf8');
  if (!child.ok || !manifest.trimStart().startsWith('#EXTM3U')) {
    return { ok: false, childStatus: child.status };
  }
  const mediaUrl = firstHlsMediaUrl(manifest, child.url);
  const keyUrl = manifestUri(manifest, /#EXT-X-KEY:[^\r\n]*URI="([^"]+)"/i, child.url);
  const mapUrl = manifestUri(manifest, /#EXT-X-MAP:[^\r\n]*URI="([^"]+)"/i, child.url);
  const media = mediaUrl ? await fetchPrefix(mediaUrl, { range: true, limit: 4096 }) : null;
  const key = keyUrl ? await fetchPrefix(keyUrl, { range: true, limit: 4096 }) : null;
  const map = mapUrl ? await fetchPrefix(mapUrl, { range: true, limit: 4096 }) : null;
  return {
    ok: Boolean(media && media.ok && media.body.length && (!key || key.ok) && (!map || map.ok)),
    childStatus: child.status,
    mediaStatus: media && media.status,
    keyStatus: key && key.status,
    mapStatus: map && map.status,
    mediaUrl: mediaUrl,
    keyUrl: keyUrl,
    mapUrl: mapUrl
  };
}

function xmlAttribute(text, name) {
  return ((text || '').match(new RegExp('\\b' + name + '="([^"]+)"', 'i')) || [])[1] || null;
}

function dashRepresentations(mpd) {
  const records = [];
  const pattern = /<Representation\b([^>]*)>([\s\S]*?)<\/Representation>|<Representation\b([^>]*)\s*\/>/gi;
  for (const match of mpd.matchAll(pattern)) {
    const attributes = match[1] || match[3] || '';
    const width = Number(xmlAttribute(attributes, 'width'));
    const height = Number(xmlAttribute(attributes, 'height'));
    if (!width || !height) continue;
    records.push({
      id: xmlAttribute(attributes, 'id'),
      bandwidth: xmlAttribute(attributes, 'bandwidth'),
      width: width,
      height: height,
      body: match[2] || ''
    });
  }
  return records.sort((left, right) => (right.width * right.height) - (left.width * left.height));
}

function fillDashTemplate(value, representation) {
  return String(value || '')
    .replace(/\$RepresentationID\$/g, representation.id || '')
    .replace(/\$Bandwidth\$/g, representation.bandwidth || '')
    .replace(/\$Number(?:%0\dd)?\$/g, '1')
    .replace(/\$Time\$/g, '0')
    .replace(/\$\$/g, '$');
}

async function verifyDash(mpd, mpdUrl, representation) {
  const scope = representation.body || '';
  const representationTag = '<Representation id="' + (representation.id || '') + '">';
  const baseUri = (scope.match(/<BaseURL>([^<]+)<\/BaseURL>/i) || mpd.match(/<BaseURL>([^<]+)<\/BaseURL>/i) || [])[1];
  const templateTag = (scope.match(/<SegmentTemplate\b([^>]*)>/i) || mpd.match(/<SegmentTemplate\b([^>]*)>/i) || [])[1];
  const initList = (scope.match(/<Initialization\b[^>]*sourceURL="([^"]+)"/i) || mpd.match(/<Initialization\b[^>]*sourceURL="([^"]+)"/i) || [])[1];
  const mediaList = (scope.match(/<SegmentURL\b[^>]*media="([^"]+)"/i) || mpd.match(/<SegmentURL\b[^>]*media="([^"]+)"/i) || [])[1];
  const initialization = templateTag ? xmlAttribute(templateTag, 'initialization') : initList;
  const media = templateTag ? xmlAttribute(templateTag, 'media') : mediaList;
  if (!initialization || !media) return { ok: false, reason: 'DASH segment URLs not resolvable', representationTag: representationTag };
  let base = mpdUrl;
  try { if (baseUri) base = new URL(baseUri.trim(), mpdUrl).href; } catch (_) {}
  let initUrl;
  let mediaUrl;
  try {
    initUrl = new URL(fillDashTemplate(initialization, representation), base).href;
    mediaUrl = new URL(fillDashTemplate(media, representation), base).href;
  } catch (_) {
    return { ok: false, reason: 'DASH segment URL invalid' };
  }
  const initProbe = await fetchPrefix(initUrl, { range: true, limit: 4096 });
  const mediaProbe = await fetchPrefix(mediaUrl, { range: true, limit: 4096 });
  return {
    ok: Boolean(initProbe.ok && initProbe.body.length && mediaProbe.ok && mediaProbe.body.length),
    initializationStatus: initProbe.status,
    mediaStatus: mediaProbe.status,
    initializationUrl: initUrl,
    mediaUrl: mediaUrl
  };
}

async function fetchPrefix(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);
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
    const variants = verifiedKind === 'hls' ? parseHlsVariants(prefix, response.url) : [];
    const selectedVariant = highest1080ClassVariant(variants);
    let resolution = selectedVariant && selectedVariant.resolution;
    let mediaVerification = null;
    let audioVerification = [];

    if (verifiedKind === 'hls' && selectedVariant) {
      mediaVerification = await verifyHlsChild(selectedVariant.url);
      for (const audioUrl of hlsAudioPlaylists(prefix, response.url)) {
        audioVerification.push(await verifyHlsChild(audioUrl));
      }
    } else if (verifiedKind === 'dash') {
      const best = dashRepresentations(prefix).find((item) => item.width >= 1900 || item.height >= 1080);
      if (best) {
        resolution = best.width + 'x' + best.height;
        mediaVerification = await verifyDash(prefix, response.url, best);
      }
    }

    const qualityVerified = Boolean(response.ok && is1080ClassResolution(resolution) &&
      mediaVerification && mediaVerification.ok && audioVerification.every((item) => item.ok));
    return {
      ok: response.ok && Boolean(verifiedKind) && qualityVerified,
      status: response.status,
      finalUrl: response.url,
      contentType: response.contentType,
      verifiedKind,
      manifestSignature: prefix.trimStart().startsWith('#EXTM3U'),
      variants,
      resolution,
      directPlaybackNoHeaders: qualityVerified,
      mediaVerification,
      audioVerification,
      rejectionReason: qualityVerified ? null : 'no directly playable 1080-class-or-higher stream without headers',
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function triggerPlayback(page, sourceOrigin) {
  for (const frame of page.frames()) {
    try {
      const frameUrl = new URL(frame.url());
      if (frameUrl.origin === sourceOrigin) continue;
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

async function selectSource(page, label) {
  return page.evaluate((wanted) => {
    let container = document.querySelector('#watch-streaming-sources');
    if (!container) {
      const heading = [...document.querySelectorAll('h1,h2,h3,h4,div,span')]
        .find((element) => /^streaming servers?$/i.test(element.textContent?.trim() || ''));
      container = heading?.parentElement || document;
    }
    const buttons = [...container.querySelectorAll('button')];
    const button = buttons.find((item) => item.textContent?.trim() === wanted);
    if (!button) return false;
    const alreadySelected = button.getAttribute('aria-pressed') === 'true';
    button.click();
    if (alreadySelected) {
      const iframe = document.querySelector('iframe[src]');
      if (iframe) iframe.src = iframe.src;
    }
    return true;
  }, label).catch((error) => {
    console.error(`[SOURCE ERROR] ${label}: ${error.message}`);
    return false;
  });
}

async function startScanner(options) {
  console.log('\n==================================================');
  console.log('DIRECT FINAL-STREAM COLLECTOR');
  console.log(`Target: ${options.targetUrl}`);
  console.log('==================================================\n');

  const browser = await puppeteer.launch({
    headless: options.headless,
    defaultViewport: options.headless ? { width: 1365, height: 768 } : null,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--start-maximized',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const candidates = new Map();
  const embeds = new Set();
  const pages = new Set();
  const pendingInspections = new Set();
  let activeServer = null;
  let allowProviderNavigation = false;

  function saveCandidate(data) {
    if (!activeServer || !data.kind || isSegment(data.url)) return;
    const key = `${activeServer}\n${data.url}`;
    const existing = candidates.get(key);
    const normalized = { ...existing, ...data, server: activeServer };
    delete normalized.headers;
    candidates.set(key, normalized);
    if (!existing) console.log(`[MEDIA ${data.kind.toUpperCase()}] ${data.url}`);
  }

  function inspectPage(page) {
    if (pages.has(page)) return;
    pages.add(page);
    page.setUserAgent(USER_AGENT).catch(() => {});
    page.setRequestInterception(true).catch(() => {});

    page.on('request', (request) => {
      const url = request.url();
      const type = request.resourceType();
      const headers = cleanHeaders(request.headers());
      const kind = mediaKind(url);
      if (kind) saveCandidate({ url, kind, resourceType: type, headers, detectedBy: 'request-url' });
      if (request.isNavigationRequest() && request.frame() !== page.mainFrame()) embeds.add(url);
      if (request.isInterceptResolutionHandled()) return;
      let blockProvider = false;
      try {
        const hostname = new URL(url).hostname;
        blockProvider = request.isNavigationRequest() &&
          request.frame() !== page.mainFrame() &&
           new URL(url).origin !== options.sourceOrigin &&
          !allowProviderNavigation;
      } catch (_) {}
      (blockProvider ? request.abort() : request.continue()).catch(() => {});
    });

    page.on('response', (response) => {
      const request = response.request();
      const url = response.url();
      const type = request.resourceType();
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      const kind = mediaKind(url, contentType);

      if (kind && !isSegment(url)) {
        saveCandidate({
          url, kind, status: response.status(), contentType, resourceType: type,
          headers: cleanHeaders(request.headers()), detectedBy: 'response-mime-or-url',
        });
      }

      if (!kind && looksLikeManifestCandidate(url, type, contentType)) {
        const inspection = response.buffer()
          .then((body) => {
            const prefix = body.subarray(0, 8192).toString('utf8');
            const bodyKind = mediaKind(url, contentType, prefix);
            if (bodyKind) {
              saveCandidate({
                url, kind: bodyKind, status: response.status(), contentType,
                resourceType: type, headers: cleanHeaders(request.headers()),
                detectedBy: 'response-body',
              });
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
    if (targetPage) inspectPage(targetPage);
  });

  const [page] = await browser.pages();
  inspectPage(page);
  const startedAt = new Date().toISOString();
  let navigationError = null;
  let discoveredServers = [];

  try {
    console.log('[1/4] Opening the exact source play route...');
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
    const sourcePlan = PREFERRED_SERVERS.filter((preferred) =>
      discoveredServers.some((server) => server.toLowerCase() === preferred.toLowerCase())
    );
    console.log(`[PREFERRED SOURCES] ${sourcePlan.join(', ') || 'none available'}`);
    const sourceWindow = Math.max(5000, Math.min(12000, Math.floor((options.timeout * 1000) / sourcePlan.length)));

    for (const label of sourcePlan) {
      activeServer = null;
      allowProviderNavigation = false;
      await page.goto(options.targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('#watch-streaming-sources button, iframe', { timeout: 20000 }).catch(() => null);
      allowProviderNavigation = true;
      activeServer = label;
      const selected = await selectSource(page, label);
      if (!selected) {
        activeServer = null;
        const state = await page.evaluate(() => ({
          url: location.href,
          sourceButtons: document.querySelectorAll('#watch-streaming-sources button').length,
        })).catch((error) => ({ error: error.message }));
        console.log(`[SOURCE MISSING] ${label} ${JSON.stringify(state)}`);
        continue;
      }
      console.log(`[SOURCE] ${label}`);
      await sleep(1500);

      const sourceDeadline = Date.now() + sourceWindow;
      while (Date.now() < sourceDeadline) {
        for (const openPage of await browser.pages()) {
          inspectPage(openPage);
          await triggerPlayback(openPage, options.sourceOrigin);
        }
        await sleep(1500);
      }
      activeServer = null;
    }
    if (candidates.size > 0) await sleep(5000);
    await Promise.race([
      Promise.allSettled([...pendingInspections]),
      sleep(3000),
    ]);
  } catch (error) {
    navigationError = error.message;
    console.error(`[ERROR] ${navigationError}`);
  }

  console.log('[4/4] Probing captured final-media candidates...');
  const results = [];
  for (const candidate of candidates.values()) {
    const probe = await probeCandidate(candidate);
    results.push({ ...candidate, probe });
    console.log(`[${probe.ok ? 'VERIFIED' : 'UNVERIFIED'}] ${candidate.url}`);
  }

  const payload = {
    scanner: 'direct-final-stream-collector', startedAt,
    finishedAt: new Date().toISOString(), targetUrl: options.targetUrl,
    navigationError, success: results.some((item) => item.probe.ok), finalStreams: results,
    diagnostics: {
      serversDiscovered: discoveredServers,
      providerFrames: [...embeds].filter(Boolean),
      note: 'providerFrames are diagnostics only; success requires a verified final media URL',
    },
  };

  const outputPath = path.resolve(options.output);
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await browser.close();

  console.log('\n==================================================');
  console.log(payload.success ? 'SUCCESS: FINAL STREAM VERIFIED' : 'NO VERIFIED FINAL STREAM FOUND');
  console.log(`Final candidates: ${results.length}`);
  if (payload.success) {
    console.log('\nMAIN STREAM LINK(S):');
    results.filter((item) => item.probe.ok).forEach((item) => console.log(item.url));
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
  parseArgs,
  mediaKind,
  isSegment,
  parseHlsVariants,
  is1080ClassResolution,
  highest1080ClassVariant,
  hlsAudioPlaylists,
  dashRepresentations,
  fillDashTemplate,
  probeCandidate
};
