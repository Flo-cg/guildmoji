'use strict';

/**
 * Converts downloaded assets to a single-frame PNG.
 *
 * - Emoji CDN serves PNG directly (also for animated emoji, where the PNG is
 *   the first frame).
 * - Animated stickers are APNG. They are turned into a static PNG by removing
 *   the animation chunks; the default image (IDAT) is the first frame.
 * - GIF / WebP fallbacks (rare, and only for animated emoji if the CDN refuses
 *   to serve a PNG) are converted with ffmpeg when it is installed.
 */

const { spawn, spawnSync } = require('node:child_process');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let ffmpegChecked = false;
let ffmpegPath = null;

function getFfmpeg() {
  if (!ffmpegChecked) {
    ffmpegChecked = true;
    try {
      const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
      ffmpegPath = res.status === 0 ? 'ffmpeg' : null;
    } catch {
      ffmpegPath = null;
    }
  }
  return ffmpegPath;
}

function sniff(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  const head = buf.subarray(0, 40).toString('utf8').trimStart();
  if (head.startsWith('{')) return 'json';
  return 'unknown';
}

function parsePngChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  const chunks = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    if (offset + 12 + length > buf.length) return null;
    const type = buf.toString('latin1', offset + 4, offset + 8);
    chunks.push({ type, start: offset, end: offset + 12 + length });
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  if (chunks.length === 0 || chunks[0].type !== 'IHDR') return null;
  return chunks;
}

/**
 * Turn an APNG into a still PNG by dropping acTL/fcTL/fdAT chunks.
 * Returns null when the input is not a well-formed PNG.
 */
function pngToStill(buf) {
  const chunks = parsePngChunks(buf);
  if (!chunks) return null;

  const isAnimated = chunks.some((c) => c.type === 'acTL' || c.type === 'fcTL' || c.type === 'fdAT');
  const hasImageData = chunks.some((c) => c.type === 'IDAT');
  if (!isAnimated) return { data: buf, changed: false };
  if (!hasImageData) return null;

  const keep = new Set([
    'IHDR',
    'PLTE',
    'tRNS',
    'gAMA',
    'cHRM',
    'sRGB',
    'iCCP',
    'pHYs',
    'bKGD',
    'IDAT',
    'IEND',
  ]);

  const parts = [PNG_SIG];
  let sawIend = false;
  for (const chunk of chunks) {
    if (keep.has(chunk.type)) {
      parts.push(buf.subarray(chunk.start, chunk.end));
      if (chunk.type === 'IEND') sawIend = true;
    }
  }
  if (!sawIend) {
    parts.push(Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]));
  }
  return { data: Buffer.concat(parts), changed: true };
}

function ffmpegFirstFrame(buf) {
  const bin = getFfmpeg();
  if (!bin) return Promise.reject(new Error('ffmpeg is not installed'));

  return new Promise((resolve, reject) => {
    const args = [
      '-v',
      'error',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ];
    const proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let settled = false;

    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(data);
    };

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(new Error('ffmpeg timed out'));
    }, 20000);

    proc.on('error', (err) => finish(err));
    proc.stdout.on('data', (chunk) => stdout.push(chunk));
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < 32) stderr.push(chunk);
    });
    proc.on('close', (code) => {
      const data = Buffer.concat(stdout);
      if (code === 0 && data.length > 8 && data.subarray(0, 8).equals(PNG_SIG)) {
        finish(null, data);
      } else {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 200);
        finish(new Error(`ffmpeg could not convert the image${detail ? `: ${detail}` : ''}`));
      }
    });

    proc.stdin.on('error', () => {});
    proc.stdin.end(buf);
  });
}

/**
 * @param {Buffer} buf raw downloaded bytes
 * @returns {Promise<{data: Buffer, note: string|null}>} PNG bytes
 */
async function toPng(buf) {
  const kind = sniff(buf);

  if (kind === 'png') {
    const still = pngToStill(buf);
    if (still) {
      return {
        data: still.data,
        note: still.changed ? 'first frame of animated sticker (APNG)' : null,
      };
    }
    // Malformed/edge-case APNG: let ffmpeg try.
    const converted = await ffmpegFirstFrame(buf);
    return { data: converted, note: 'first frame (converted with ffmpeg)' };
  }

  if (kind === 'gif' || kind === 'webp') {
    const converted = await ffmpegFirstFrame(buf);
    return { data: converted, note: `first frame of ${kind.toUpperCase()} (converted with ffmpeg)` };
  }

  if (kind === 'json') {
    throw new Error('Lottie sticker: Discord does not provide a PNG version');
  }

  throw new Error(`Unexpected image format (${kind})`);
}

module.exports = { toPng, sniff, getFfmpeg, PNG_SIG };
