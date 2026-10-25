'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const { resolveAuth, collectEverything, publicUser, DiscordError } = require('./lib/discord');
const { detectTokens } = require('./lib/token');
const cache = require('./lib/cache');
const { JobManager } = require('./lib/jobs');
const { normalizeSize } = require('./lib/export');

const PUBLIC_DIR = path.join(__dirname, 'public');
const REQUESTED_PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const ALLOW_REMOTE = process.env.ALLOW_REMOTE === '1';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com https://media.discordapp.net; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
]);

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const state = {
  auth: null,
  user: null,
  data: null,
  inFlight: null,
  envTried: false,
};

let listenPort = REQUESTED_PORT;
const jobs = new JobManager();

function clearSession() {
  state.auth = null;
  state.user = null;
  state.data = null;
  state.inFlight = null;
}

function hostAllowed(hostHeader) {
  if (ALLOW_REMOTE) return true;
  if (!hostHeader) return false;
  try {
    const url = new URL(`http://${hostHeader}`);
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function originAllowed(req) {
  if (ALLOW_REMOTE) return true;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client
  try {
    const url = new URL(origin);
    const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname);
    if (!loopback) return false;
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return Number(port) === Number(listenPort);
  } catch {
    return false;
  }
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Length': buf.length,
    ...headers,
  });
  res.end(buf);
}

function sendJson(req, res, status, payload) {
  let body = Buffer.from(JSON.stringify(payload));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  send(res, status, body, headers);
}

function sendError(req, res, status, message, extra = {}) {
  sendJson(req, res, status, { error: message, ...extra });
}

async function readJson(req, limit = 8 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function setSession(auth, user) {
  state.auth = auth;
  state.user = user;
  state.data = null;
  state.inFlight = null;
}

function loginResponse(user) {
  return { user: publicUser(user) };
}

async function getEverything(force) {
  if (!state.auth) throw new HttpError(401, 'Not signed in', { code: 'unauthorized' });
  const auth = state.auth;
  const user = state.user;

  if (!force) {
    const cached = await cache.read(user.id);
    if (cached && cached.age < cache.CACHE_TTL_MS) {
      return { ...cached.payload, source: 'cache', cacheAge: cached.age };
    }
  }

  if (state.inFlight) return state.inFlight;

  const promise = (async () => {
    let result;
    try {
      result = await collectEverything(auth);
    } catch (err) {
      if (err instanceof DiscordError && err.status === 401) {
        clearSession();
        throw new HttpError(401, 'Discord rejected the session. Please connect again.', {
          code: 'unauthorized',
        });
      }
      throw err;
    }

    if (state.auth !== auth) {
      throw new HttpError(401, 'Session changed while loading. Please try again.', {
        code: 'unauthorized',
      });
    }

    const payload = {
      items: result.items,
      guilds: result.guilds,
      errors: result.errors,
      fetchedAt: result.fetchedAt,
    };
    state.data = payload;
    await cache.write(user.id, payload).catch(() => {});
    return { ...payload, source: 'live', cacheAge: 0 };
  })();

  state.inFlight = promise;
  try {
    return await promise;
  } finally {
    if (state.inFlight === promise) state.inFlight = null;
  }
}

async function tryEnvToken() {
  if (state.envTried || !process.env.DISCORD_TOKEN) return;
  state.envTried = true;
  try {
    const { auth, user } = await resolveAuth(process.env.DISCORD_TOKEN);
    setSession(auth, user);
    console.log(`Using DISCORD_TOKEN for ${user.username}`);
  } catch (err) {
    console.warn(`DISCORD_TOKEN could not be used: ${err.message}`);
  }
}

function sanitizeJobItems(rawItems) {
  if (!Array.isArray(rawItems)) throw new HttpError(400, 'items must be an array');
  const seen = new Set();
  const items = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '');
    if (!/^\d{5,25}$/.test(id)) continue;
    const kind = raw.kind === 'sticker' ? 'sticker' : raw.kind === 'emoji' ? 'emoji' : null;
    if (!kind) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const formatType = Number(raw.formatType);
    items.push({
      id,
      kind,
      name: String(raw.name || '').slice(0, 200),
      guildId: /^\d{5,25}$/.test(String(raw.guildId || '')) ? String(raw.guildId) : '0',
      guildName: String(raw.guildName || '').slice(0, 200),
      animated: Boolean(raw.animated),
      format: String(raw.format || '').slice(0, 16),
      formatType: Number.isInteger(formatType) ? formatType : undefined,
    });
  }

  return items;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method || 'GET';

  if (!hostAllowed(req.headers.host)) {
    sendError(req, res, 403, 'This server only accepts requests addressed to localhost.');
    return;
  }
  if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req)) {
    sendError(req, res, 403, 'Cross-origin requests are not allowed.');
    return;
  }

  if (method === 'GET' || method === 'HEAD') {
    if (pathname === '/favicon.ico') {
      res.writeHead(204, SECURITY_HEADERS);
      res.end();
      return;
    }
    const staticFile = STATIC_FILES.get(pathname);
    if (staticFile) {
      const [name, type] = staticFile;
      const file = path.join(PUBLIC_DIR, name);
      let data;
      try {
        data = fs.readFileSync(file);
      } catch {
        sendError(req, res, 500, 'The web interface files are missing. Re-download the project.');
        return;
      }
      send(res, 200, data, {
        'Content-Type': type,
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': SECURITY_HEADERS['Content-Security-Policy'],
      });
      return;
    }
  }

  if (pathname === '/api/health' && method === 'GET') {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/state' && method === 'GET') {
    await tryEnvToken();
    sendJson(req, res, 200, {
      authenticated: Boolean(state.auth),
      user: state.user ? publicUser(state.user) : null,
      envToken: Boolean(process.env.DISCORD_TOKEN),
      cacheTtlMinutes: Math.round(cache.CACHE_TTL_MS / 60000),
    });
    return;
  }

  if (pathname === '/api/login' && method === 'POST') {
    const body = await readJson(req, 16 * 1024);
    const token = typeof body.token === 'string' ? body.token : '';
    if (!token.trim()) throw new HttpError(400, 'Please paste a Discord token.');
    const { auth, user } = await resolveAuth(token);
    setSession(auth, user);
    console.log(`Signed in as ${user.username}`);
    sendJson(req, res, 200, loginResponse(user));
    return;
  }

  if (pathname === '/api/login/detect' && method === 'POST') {
    const scan = await detectTokens();
    const checked = scan.scannedDirs.slice(0, 12);
    let tried = 0;

    for (const { token } of scan.tokens) {
      if (tried >= 25) break;
      tried += 1;
      try {
        const { auth, user } = await resolveAuth(token);
        setSession(auth, user);
        console.log(`Signed in as ${user.username} using a token found on disk`);
        sendJson(req, res, 200, { ...loginResponse(user), source: 'desktop' });
        return;
      } catch (err) {
        if (err instanceof DiscordError && (err.status === 401 || err.status === 400)) continue;
        throw err;
      }
    }

    const candidateCount = scan.tokens.length;
    let message;
    if (candidateCount > 0) {
      message = `Found ${candidateCount} saved token${candidateCount === 1 ? '' : 's'}, but Discord rejected ${candidateCount === 1 ? 'it' : 'them'}. ${candidateCount === 1 ? 'It may be' : 'They may be'} stale — open the Discord desktop app and log in again, or paste a token manually using the instructions.`;
    } else if (scan.scannedDirs.length === 0) {
      message =
        'No Discord desktop profile was found on this computer. Open the Discord desktop app once, or paste a token manually.';
    } else {
      message =
        'No usable token was found on disk. Discord may store it encrypted with your system keyring — paste one manually using the instructions.';
    }

    sendError(req, res, 404, message, { checked, candidates: candidateCount });
    return;
  }

  if (pathname === '/api/logout' && method === 'POST') {
    clearSession();
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/data' && method === 'GET') {
    if (!state.auth) throw new HttpError(401, 'Not signed in', { code: 'unauthorized' });
    const force = url.searchParams.get('refresh') === '1';
    const data = await getEverything(force);
    sendJson(req, res, 200, {
      ...data,
      user: publicUser(state.user),
      cacheTtlMinutes: Math.round(cache.CACHE_TTL_MS / 60000),
    });
    return;
  }

  if (pathname === '/api/jobs' && method === 'POST') {
    if (!state.auth) throw new HttpError(401, 'Not signed in', { code: 'unauthorized' });
    const body = await readJson(req, 24 * 1024 * 1024);
    const items = sanitizeJobItems(body.items);
    if (items.length === 0) throw new HttpError(400, 'No valid emojis or stickers were selected.');
    const size = normalizeSize(body.size);
    const job = jobs.create({ items, size, user: state.user });
    sendJson(req, res, 201, job);
    return;
  }

  const jobMatch = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(file|cancel))?$/.exec(pathname);
  if (jobMatch) {
    if (!state.auth) throw new HttpError(401, 'Not signed in', { code: 'unauthorized' });
    const [, id, action] = jobMatch;

    if (action === 'file' && method === 'GET') {
      const file = jobs.file(id);
      if (!file) throw new HttpError(404, 'This export is no longer available.');
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'application/zip',
        'Content-Length': file.size,
        'Content-Disposition': `attachment; filename="${file.name}"`,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(file.path);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    if (action === 'cancel' && method === 'POST') {
      const job = jobs.cancel(id);
      if (!job) throw new HttpError(404, 'Unknown export.');
      sendJson(req, res, 200, job);
      return;
    }

    if (!action && method === 'GET') {
      const job = jobs.get(id);
      if (!job) throw new HttpError(404, 'Unknown export.');
      sendJson(req, res, 200, job);
      return;
    }
  }

  throw new HttpError(404, 'Not found');
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const declared = Number(err.status);
    const status = Number.isInteger(declared) && declared >= 400 && declared <= 599 ? declared : 500;
    if (status >= 500) console.error(err);
    sendError(req, res, status, err.message || 'Something went wrong', err.extra || {});
  });
});

function openBrowser(url) {
  if (process.env.OPEN !== '1') return;
  try {
    const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* ignore */
  }
}

function listen(port, attempts = 12) {
  const onError = (err) => {
    server.removeListener('listening', onListening);
    if (err.code === 'EADDRINUSE' && attempts > 0) {
      server.removeListener('error', onError);
      listen(port + 1, attempts - 1);
      return;
    }
    console.error(`Could not start the server: ${err.message}`);
    process.exit(1);
  };

  const onListening = () => {
    server.removeListener('error', onError);
    listenPort = port;
    const shownHost = HOST === '0.0.0.0' || HOST === '::' ? '127.0.0.1' : HOST;
    const url = `http://${shownHost}:${port}`;
    console.log('');
    console.log('  Guildmoji');
    console.log(`  → ${url}`);
    console.log('');
    console.log('  Your token is kept in memory only. Press Ctrl+C to stop.');
    console.log('');
    if (ALLOW_REMOTE) {
      console.log('  WARNING: ALLOW_REMOTE=1 — the server is reachable outside this computer.');
      console.log('');
    }
    openBrowser(url);
  };

  server.once('error', onError);
  server.once('listening', onListening);
  server.listen(port, HOST);
}

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});

listen(REQUESTED_PORT);
