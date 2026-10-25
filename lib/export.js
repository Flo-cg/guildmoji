'use strict';

const { createLimiter } = require('./limit');
const { toPng } = require('./convert');
const { CDN_BASE, MEDIA_BASE, USER_AGENT } = require('./discord');

const cdnLimiter = createLimiter(8);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const VALID_SIZES = new Set([64, 96, 128, 256, 512]);

function normalizeSize(value) {
  const size = Number(value);
  return VALID_SIZES.has(size) ? size : 256;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    output += char;
    bytes += size;
  }
  return output;
}

function sanitizeSegment(value, fallback) {
  let name = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .replace(/^[. ]+/g, '');

  name = truncateUtf8(name, 180).trim().replace(/[. ]+$/g, '');
  if (!name) name = String(fallback ?? 'file');
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  return name;
}

function candidateUrls(item, size) {
  const id = item.id;
  const urls = [];

  if (item.kind === 'emoji') {
    urls.push(`${CDN_BASE}/emojis/${id}.png?size=${size}`);
    if (item.animated) urls.push(`${CDN_BASE}/emojis/${id}.gif?size=${size}`);
    urls.push(`${CDN_BASE}/emojis/${id}.png`);
    if (item.animated) urls.push(`${CDN_BASE}/emojis/${id}.gif`);
    return urls;
  }

  urls.push(`${MEDIA_BASE}/stickers/${id}.png?size=${size}`);
  urls.push(`${CDN_BASE}/stickers/${id}.png?size=${size}`);
  urls.push(`${CDN_BASE}/stickers/${id}.png`);
  if (item.formatType === 4) urls.push(`${CDN_BASE}/stickers/${id}.gif`);
  if (item.formatType === 3) urls.push(`${CDN_BASE}/stickers/${id}.json`);
  return [...new Set(urls)];
}

async function fetchAsset(url) {
  return cdnLimiter(async () => {
    let lastError = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let res;
      try {
        res = await fetch(url, {
          headers: { 'User-Agent': USER_AGENT, Accept: 'image/*,*/*;q=0.8' },
          signal: AbortSignal.timeout(30000),
        });
      } catch (err) {
        lastError = new Error(`Network error: ${err.message}`);
        if (attempt < 2) await sleep(400 * 2 ** attempt + Math.random() * 200);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        let wait = Number(res.headers.get('retry-after')) * 1000;
        if (!Number.isFinite(wait) || wait <= 0) wait = 500 * 2 ** attempt;
        lastError = new Error(`Discord CDN responded with HTTP ${res.status}`);
        try {
          await res.arrayBuffer();
        } catch {
          /* ignore */
        }
        if (attempt < 2) await sleep(Math.min(wait, 10000) + Math.random() * 200);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error('Empty response from Discord CDN');
      return buf;
    }

    throw lastError || new Error('Could not download the asset');
  });
}

/**
 * Download one emoji/sticker and convert it to a single-frame PNG.
 * @returns {Promise<{data: Buffer, note: string|null, source: string}>}
 */
async function downloadItem(item, size) {
  const urls = candidateUrls(item, size);
  let lastError = null;

  for (const url of urls) {
    try {
      const raw = await fetchAsset(url);
      const png = await toPng(raw);
      return { data: png.data, note: png.note, source: url };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('Download failed');
}

function buildGuildFolders(items) {
  const folders = new Map();
  const used = new Map();
  const seen = new Set();

  for (const item of items) {
    if (seen.has(item.guildId)) continue;
    seen.add(item.guildId);
    const base = sanitizeSegment(item.guildName, `server-${item.guildId}`);
    let candidate = base;
    if (used.has(candidate.toLowerCase())) candidate = `${base} [${item.guildId}]`;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${base} [${item.guildId}-${suffix}]`;
      suffix += 1;
    }
    used.set(candidate.toLowerCase(), item.guildId);
    folders.set(item.guildId, candidate);
  }

  return folders;
}

function makeUniquePath(used, folder, item) {
  const base = sanitizeSegment(item.name, item.id);
  const sub = item.kind === 'sticker' ? 'stickers/' : '';
  let candidate = `${folder}/${sub}${base}.png`;
  let counter = 2;

  while (used.has(candidate.toLowerCase())) {
    candidate = `${folder}/${sub}${base} (${counter}).png`;
    counter += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

module.exports = {
  downloadItem,
  candidateUrls,
  normalizeSize,
  sanitizeSegment,
  buildGuildFolders,
  makeUniquePath,
  fetchAsset,
};
