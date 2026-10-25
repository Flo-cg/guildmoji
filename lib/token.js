'use strict';

/**
 * Best-effort discovery of a saved Discord token from the desktop client.
 *
 * Discord (Chromium/Electron) stores its session in a LevelDB database under
 * "Local Storage/leveldb". The database uses prefix-compressed keys and Snappy
 * compressed blocks, so simply searching the raw files for a token misses the
 * token whenever it happens to live in a compressed block.
 *
 * This module therefore contains a small, dependency-free reader for the
 * LevelDB table ("*.ldb"/"*.sst") and write-ahead-log ("*.log") formats:
 *
 *   - LevelDB tables: footer -> index block -> data blocks -> prefix-coded
 *     entries, with optional Snappy decompression.
 *   - LevelDB logs: 32 KiB block records, reassembled, then write batches.
 *
 * Only files under the user's config directory are read. Nothing is sent
 * anywhere from here; validation is done by lib/discord.js.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const TOKEN_PATTERN = /[\w-]{24,28}\.[\w-]{6}\.[\w-]{25,45}/g;
const TOKEN_ANCHORED = /^[\w-]{24,28}\.[\w-]{6}\.[\w-]{25,45}$/;
const TABLE_MAGIC = Buffer.from('57fb808b247547db', 'hex');
const LOG_BLOCK_SIZE = 32768;
const MAX_BLOCK_BYTES = 256 * 1024 * 1024;

const SKIP_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
  'GraphiteDawnCache',
  'blob_storage',
  'Service Worker',
  'Crashpad',
  'IndexedDB',
  'File System',
  'WebStorage',
  'Sync Data',
  'Analytics',
  'Network Persistent State',
  'node_modules',
]);

const APP_DIR_PATTERN = /discord|vesktop|vencord|equicord|legcord|armcord|dorion|abaddon/i;
const MAX_FILE_BYTES = 96 * 1024 * 1024;
const MAX_TOTAL_BYTES = 320 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * Snappy
 * ------------------------------------------------------------------ */

function snappyDecompress(input) {
  let pos = 0;
  let expected = 0;
  let shift = 0;
  for (;;) {
    if (pos >= input.length || shift > 28) throw new Error('Invalid Snappy header');
    const byte = input[pos++];
    expected += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  if (expected > MAX_BLOCK_BYTES) throw new Error('Snappy block is too large');

  const out = Buffer.alloc(expected);
  let op = 0;

  while (pos < input.length && op < expected) {
    const tag = input[pos++];
    const type = tag & 3;

    if (type === 0) {
      let length = tag >> 2;
      if (length < 60) {
        length += 1;
      } else {
        const bytes = length - 59;
        if (pos + bytes > input.length) throw new Error('Truncated Snappy literal');
        length = 0;
        for (let i = 0; i < bytes; i += 1) length += input[pos++] * 2 ** (8 * i);
        length += 1;
      }
      if (pos + length > input.length || op + length > expected) {
        throw new Error('Snappy literal overflow');
      }
      input.copy(out, op, pos, pos + length);
      pos += length;
      op += length;
      continue;
    }

    let length;
    let offset;
    if (type === 1) {
      length = ((tag >> 2) & 7) + 4;
      offset = ((tag >> 5) << 8) | input[pos++];
    } else if (type === 2) {
      length = (tag >> 2) + 1;
      offset = input[pos] | (input[pos + 1] << 8);
      pos += 2;
    } else {
      length = (tag >> 2) + 1;
      offset = input[pos] | (input[pos + 1] << 8) | (input[pos + 2] << 16) | (input[pos + 3] << 24);
      pos += 4;
    }

    if (offset <= 0 || offset > op) throw new Error('Invalid Snappy back-reference');
    if (op + length > expected) throw new Error('Snappy output overflow');
    for (let i = 0; i < length; i += 1, op += 1) out[op] = out[op - offset];
  }

  if (op !== expected) throw new Error('Snappy length mismatch');
  return out;
}

/* ------------------------------------------------------------------ *
 * LevelDB tables
 * ------------------------------------------------------------------ */

function readVarint(buf, state, limit = buf.length) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (state.pos >= limit) throw new Error('Truncated varint');
    const byte = buf[state.pos++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
    if (shift > 56) throw new Error('Varint is too long');
  }
}

function readBlockHandle(buf, state, limit = buf.length) {
  const offset = readVarint(buf, state, limit);
  const size = readVarint(buf, state, limit);
  return { offset, size };
}

function readBlock(file, offset, size) {
  if (!Number.isInteger(offset) || !Number.isInteger(size) || size <= 0) return null;
  if (offset < 0 || offset + size + 5 > file.length) return null;
  const payload = file.subarray(offset, offset + size);
  const compression = file[offset + size];

  if (compression === 0) return payload;
  if (compression === 1) {
    try {
      return snappyDecompress(payload);
    } catch {
      return null;
    }
  }
  if (compression === 2 && typeof zlib.zstdDecompressSync === 'function') {
    try {
      return zlib.zstdDecompressSync(payload);
    } catch {
      return null;
    }
  }
  return null;
}

function parseBlockEntries(block) {
  if (!block || block.length < 4) return [];
  const restartCount = block.readUInt32LE(block.length - 4);
  const restartBytes = 4 + restartCount * 4;
  if (restartCount > 1000000 || restartBytes > block.length) return [];

  const limit = block.length - restartBytes;
  const entries = [];
  let pos = 0;
  let previousKey = Buffer.alloc(0);

  while (pos < limit) {
    try {
      const state = { pos };
      const shared = readVarint(block, state, limit);
      const nonShared = readVarint(block, state, limit);
      const valueLength = readVarint(block, state, limit);
      pos = state.pos;

      if (shared > previousKey.length || pos + nonShared + valueLength > limit) break;
      const key = Buffer.alloc(shared + nonShared);
      previousKey.copy(key, 0, 0, shared);
      block.copy(key, shared, pos, pos + nonShared);
      pos += nonShared;

      const value = block.subarray(pos, pos + valueLength);
      pos += valueLength;
      previousKey = key;
      entries.push({ key, value });
    } catch {
      break;
    }
  }

  return entries;
}

function readTableEntries(file) {
  if (file.length < 48) return [];
  const footer = file.subarray(file.length - 48);
  if (!footer.subarray(40, 48).equals(TABLE_MAGIC)) return [];

  const state = { pos: 0 };
  try {
    readBlockHandle(footer, state, 40); // metaindex, unused
    const indexHandle = readBlockHandle(footer, state, 40);
    const indexBlock = readBlock(file, indexHandle.offset, indexHandle.size);
    if (!indexBlock) return [];
    const indexEntries = parseBlockEntries(indexBlock);

    const entries = [];
    for (const indexEntry of indexEntries) {
      const handleState = { pos: 0 };
      const handle = readBlockHandle(indexEntry.value, handleState);
      const block = readBlock(file, handle.offset, handle.size);
      if (!block) continue;
      entries.push(...parseBlockEntries(block));
    }
    return entries;
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * LevelDB logs (write-ahead log)
 * ------------------------------------------------------------------ */

function parseLogRecords(file) {
  const records = [];
  let pending = null;

  for (let blockStart = 0; blockStart < file.length; blockStart += LOG_BLOCK_SIZE) {
    const blockEnd = Math.min(blockStart + LOG_BLOCK_SIZE, file.length);
    let pos = blockStart;

    while (pos + 7 <= blockEnd) {
      const length = file.readUInt16LE(pos + 4);
      const type = file[pos + 6];
      if (length === 0 && type === 0) break; // zero padding at the end of a block
      if (pos + 7 + length > blockEnd) break;
      const fragment = file.subarray(pos + 7, pos + 7 + length);
      pos += 7 + length;

      if (type === 1) {
        records.push(fragment);
      } else if (type === 2) {
        pending = [fragment];
      } else if (type === 3 && pending) {
        pending.push(fragment);
      } else if (type === 4 && pending) {
        pending.push(fragment);
        records.push(Buffer.concat(pending));
        pending = null;
      }
    }
  }

  return records;
}

function parseWriteBatch(record) {
  if (!record || record.length < 12) return [];
  let count;
  try {
    count = record.readUInt32LE(8);
  } catch {
    return [];
  }
  if (count > 1000000) return [];

  const entries = [];
  const state = { pos: 12 };
  for (let i = 0; i < count; i += 1) {
    if (state.pos >= record.length) break;
    const tag = record[state.pos++];
    if (tag !== 0 && tag !== 1) break;

    try {
      const keyLength = readVarint(record, state);
      if (state.pos + keyLength > record.length) break;
      const key = record.subarray(state.pos, state.pos + keyLength);
      state.pos += keyLength;

      let value = null;
      if (tag === 1) {
        const valueLength = readVarint(record, state);
        if (state.pos + valueLength > record.length) break;
        value = record.subarray(state.pos, state.pos + valueLength);
        state.pos += valueLength;
      }
      entries.push({ key, value });
    } catch {
      break;
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ *
 * Chromium Local Storage decoding
 * ------------------------------------------------------------------ */

function decodeLocalStorageKey(key) {
  const text = key.toString('latin1');
  if (!text.startsWith('_')) return null;
  const separator = text.indexOf('\x00');
  if (separator < 1) return null;
  const origin = text.slice(1, separator);
  if (!/^https?:\/\/([a-z0-9-]+\.)*discord(app)?\.(com|net)(:\d+)?\/?$/i.test(origin)) return null;

  const rest = text.slice(separator + 1);
  // Chromium prefixes the actual key with one or two non-printable bytes.
  const match = /^[\x00-\x02]*([\x20-\x7e]+)/.exec(rest);
  const logicalKey = match ? match[1] : '';
  return { origin, key: logicalKey };
}

function decodeLocalStorageValue(value) {
  if (!value || value.length === 0) return null;
  const variants = [];
  if (value[0] === 0 || value[0] === 1) variants.push(value.subarray(1));
  variants.push(value);

  for (const raw of variants) {
    const texts = [raw.toString('utf8')];
    if (raw.includes(0)) {
      texts.push(raw.toString('utf16le'));
    }
    for (const text of texts) {
      const trimmed = text.trim();
      if (!trimmed) continue;
      if (trimmed[0] === '"' || trimmed[0] === '{' || trimmed[0] === '[') {
        try {
          return { parsed: JSON.parse(trimmed), text: trimmed };
        } catch {
          /* try the next variant */
        }
      }
      return { parsed: trimmed, text: trimmed };
    }
  }
  return null;
}

function addCandidate(candidates, token, source, priority, mtime) {
  const value = String(token || '').trim();
  if (!TOKEN_ANCHORED.test(value) || value.length > 120) return;
  const existing = candidates.get(value);
  if (!existing || existing.priority < priority) {
    candidates.set(value, { token: value, source, priority, mtime });
  }
}

/* ------------------------------------------------------------------ *
 * Encrypted ("v10") values
 * ------------------------------------------------------------------ */

function decryptV10(text) {
  const key = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
  const ivs = [Buffer.alloc(16, 0x20), Buffer.alloc(16, 0)];
  const results = [];

  const cleaned = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  let raw;
  try {
    raw = Buffer.from(padded, 'base64');
  } catch {
    return results;
  }
  if (raw.length < 16 || raw.length % 16 !== 0) return results;

  for (const iv of ivs) {
    try {
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      const plain = Buffer.concat([decipher.update(raw), decipher.final()]).toString('utf8');
      for (const match of plain.matchAll(TOKEN_PATTERN)) results.push(match[0]);
    } catch {
      /* wrong key or not an encrypted token */
    }
  }
  return results;
}

function scanText(text, source, priority, mtime, candidates) {
  if (!text) return;
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    addCandidate(candidates, match[0], source, priority, mtime);
  }

  for (const match of text.matchAll(/v1[0-9]([A-Za-z0-9+/=_-]{20,})/g)) {
    for (const token of decryptV10(match[1])) {
      addCandidate(candidates, token, source, Math.max(15, priority - 20), mtime);
    }
  }
}

function addParsedValue(parsed, source, priority, mtime, candidates, depth = 0) {
  if (depth > 4) return;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (TOKEN_ANCHORED.test(trimmed)) {
      addCandidate(candidates, trimmed, source, priority, mtime);
    }
    scanText(trimmed, source, Math.max(15, priority - 5), mtime, candidates);
    return;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) addParsedValue(item, source, priority, mtime, candidates, depth + 1);
    return;
  }
  if (parsed && typeof parsed === 'object') {
    for (const value of Object.values(parsed)) {
      addParsedValue(value, source, priority, mtime, candidates, depth + 1);
    }
  }
}

function extractLocalStorageEntries(entries, file, mtime, candidates) {
  for (const { key, value } of entries) {
    if (!value) continue;
    const decodedKey = decodeLocalStorageKey(key);
    if (!decodedKey) continue;

    const source = `${file}#${decodedKey.key || 'unknown'}`;
    const logical = decodedKey.key;

    if (logical === 'token' || logical === 'tokens') {
      const decoded = decodeLocalStorageValue(value);
      if (decoded) {
        addParsedValue(decoded.parsed, source, logical === 'token' ? 100 : 90, mtime, candidates);
        scanText(decoded.text, source, 60, mtime, candidates);
      }
      // Also scan the raw value in case this value has an unexpected wrapper.
      scanText(value.toString('latin1'), source, 30, mtime, candidates);
      continue;
    }

    if (/token/i.test(logical)) {
      const decoded = decodeLocalStorageValue(value);
      if (decoded) {
        addParsedValue(decoded.parsed, source, 70, mtime, candidates);
        scanText(decoded.text, source, 60, mtime, candidates);
      }
      continue;
    }

    // Generic fallback: some Discord builds have stored the token under an
    // unusual key. Only plaintext-looking values are scanned; encrypted
    // values still go through the "v10" attempt above when applicable.
    const decoded = decodeLocalStorageValue(value);
    if (decoded) {
      scanText(decoded.text.slice(0, 512 * 1024), source, 25, mtime, candidates);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function findLevelDbDirs(root, depth = 0, found = []) {
  if (depth > 7) return found;
  for (const entry of safeReadDir(root)) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.name === 'leveldb' && path.basename(root) === 'Local Storage') {
      found.push(full);
      continue;
    }
    findLevelDbDirs(full, depth + 1, found);
  }
  return found;
}

function appRoots() {
  const home = os.homedir();
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const roots = new Set();

  for (const entry of safeReadDir(configHome)) {
    if (entry.isDirectory() && APP_DIR_PATTERN.test(entry.name)) {
      roots.add(path.join(configHome, entry.name));
    }
  }

  // Flatpak and Snap installs.
  const flatpak = path.join(home, '.var', 'app');
  for (const entry of safeReadDir(flatpak)) {
    if (/discord/i.test(entry.name)) {
      roots.add(path.join(flatpak, entry.name, 'config'));
    }
  }
  roots.add(path.join(home, 'snap', 'discord', 'current', '.config'));

  return [...roots].filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Scan the Discord desktop clients for token-like strings.
 * @param {{extraRoots?: string[]}} [options]
 * @returns {Promise<{tokens: Array<{token: string, source: string}>, scannedDirs: string[]}>}
 */
async function detectTokens(options = {}) {
  const roots = [...appRoots(), ...(options.extraRoots || [])];
  const levelDbs = new Set();
  for (const root of roots) {
    for (const dir of findLevelDbDirs(root)) levelDbs.add(dir);
  }

  const candidates = new Map();
  const scannedDirs = [];
  let totalBytes = 0;

  for (const dir of levelDbs) {
    scannedDirs.push(dir);
    const files = safeReadDir(dir)
      .filter((entry) => entry.isFile() && /\.(ldb|sst|log)$/i.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort()
      .reverse(); // newer SSTables usually have higher sequence numbers

    for (const file of files) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) continue;
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) break;
      totalBytes += stat.size;

      let buf;
      try {
        buf = await fs.promises.readFile(file);
      } catch {
        continue;
      }

      const mtime = stat.mtimeMs;
      if (/\.(ldb|sst)$/i.test(file)) {
        const entries = readTableEntries(buf);
        if (entries.length > 0) {
          extractLocalStorageEntries(entries, file, mtime, candidates);
        } else {
          // Unexpected/compressed format: keep a low-priority raw fallback.
          scanText(buf.toString('latin1'), file, 10, mtime, candidates);
          scanText(buf.toString('utf16le'), file, 5, mtime, candidates);
        }
      } else {
        const records = parseLogRecords(buf);
        let parsedAny = false;
        for (const record of records) {
          const entries = parseWriteBatch(record);
          if (entries.length > 0) {
            parsedAny = true;
            extractLocalStorageEntries(entries, file, mtime, candidates);
          }
        }
        if (!parsedAny) {
          scanText(buf.toString('latin1'), file, 10, mtime, candidates);
        }
      }
      await sleep(0); // keep the event loop responsive while scanning large profiles
    }
  }

  const tokens = [...candidates.values()]
    .sort((a, b) => b.priority - a.priority || b.mtime - a.mtime)
    .map(({ token, source }) => ({ token, source }));

  return { tokens, scannedDirs };
}

module.exports = { detectTokens, TOKEN_PATTERN };
