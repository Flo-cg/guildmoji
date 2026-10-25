'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.GUILDMOJI_DATA_DIR
  ? path.resolve(process.env.GUILDMOJI_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const CACHE_TTL_MS = 15 * 60 * 1000;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function cachePath(userId) {
  const safe = String(userId).replace(/[^0-9]/g, '');
  if (!safe) throw new Error('Invalid user id');
  return path.join(CACHE_DIR, `${safe}.json`);
}

async function read(userId) {
  try {
    const file = cachePath(userId);
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items) || !Array.isArray(parsed.guilds)) return null;
    return {
      payload: parsed,
      age: Date.now() - Number(parsed.fetchedAt || 0),
    };
  } catch {
    return null;
  }
}

async function write(userId, payload) {
  ensureDir(CACHE_DIR);
  const file = cachePath(userId);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(payload), 'utf8');
  await fs.promises.rename(tmp, file);
}

async function clear(userId) {
  if (userId) {
    await fs.promises.rm(cachePath(userId), { force: true }).catch(() => {});
    return;
  }
  await fs.promises.rm(CACHE_DIR, { recursive: true, force: true }).catch(() => {});
}

module.exports = { read, write, clear, ensureDir, CACHE_TTL_MS, DATA_DIR, CACHE_DIR };
