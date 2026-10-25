'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MOCK_FETCH = path.join(__dirname, 'mock-fetch.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function request(base, route, options = {}) {
  const response = await fetch(base + route, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString('utf8');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, buffer, headers: response.headers };
}

/** Minimal reader for the STORED entries produced by lib/zip.js. */
function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'ZIP should contain an end-of-central-directory record');
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const files = new Map();

  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, 'central directory signature');
    const method = buffer.readUInt16LE(cursor + 10);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    assert.equal(method, 0, `${name} should use the STORED method`);

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, 'local header signature');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    files.set(name, buffer.subarray(dataStart, dataStart + size));

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

test('Guildmoji end-to-end flow with a mocked Discord API', { timeout: 45000 }, async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'guildmoji-test-'));
  const home = path.join(temp, 'home');
  const dataDir = path.join(temp, 'data');
  fs.mkdirSync(home, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = '';

  const child = spawn(process.execPath, ['--require', MOCK_FETCH, 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      GUILDMOJI_DATA_DIR: dataDir,
      DISCORD_TOKEN: 'mock.token.here',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => (logs += chunk));
  child.stderr.on('data', (chunk) => (logs += chunk));

  t.after(async () => {
    child.kill('SIGTERM');
    await sleep(200);
    child.kill('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  });

  let state;
  for (let i = 0; i < 80; i += 1) {
    try {
      const health = await request(base, '/api/health');
      if (health.status === 200) {
        state = await request(base, '/api/state');
        if (state.body.authenticated) break;
      }
    } catch {
      /* server is still starting */
    }
    await sleep(100);
  }

  assert.ok(state && state.body.authenticated, `server did not start:\n${logs}`);
  assert.equal(JSON.stringify(state.body).includes('mock.token.here'), false, 'token must not leak');

  const page = await request(base, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /Guildmoji/);

  const crossOrigin = await request(base, '/api/logout', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
  });
  assert.equal(crossOrigin.status, 403);

  const detect = await request(base, '/api/login/detect', { method: 'POST' });
  assert.equal(detect.status, 404);
  assert.equal(detect.body.candidates, 0);

  const first = await request(base, '/api/data');
  assert.equal(first.status, 200);
  assert.equal(first.body.source, 'live');
  assert.equal(first.body.items.length, 3);
  assert.equal(first.body.guilds.length, 2);
  assert.equal(first.body.errors.length, 1);
  assert.equal(first.body.items.filter((item) => item.kind === 'emoji').length, 2);
  assert.equal(first.body.items.filter((item) => item.kind === 'sticker').length, 1);
  assert.ok(
    first.body.items
      .filter((item) => item.kind === 'emoji' && item.animated)
      .every((item) => item.preview.endsWith('.webp?size=96')),
  );
  assert.ok(
    first.body.items
      .filter((item) => item.kind === 'sticker')
      .every((item) => item.preview.includes('/stickers/') && item.preview.endsWith('.webp?size=160')),
  );

  const cached = await request(base, '/api/data');
  assert.equal(cached.body.source, 'cache');
  const refreshed = await request(base, '/api/data?refresh=1');
  assert.equal(refreshed.body.source, 'live');

  const items = first.body.items.map((item) => ({
    id: item.id,
    kind: item.kind,
    name: item.name,
    guildId: item.guildId,
    guildName: item.guildName,
    animated: item.animated,
    format: item.format,
    formatType: item.formatType,
  }));
  items.push({
    id: '333333333333333333',
    kind: 'sticker',
    name: 'missing_one',
    guildId: '100000000000000001',
    guildName: 'Mock Guild',
    animated: false,
    format: 'png',
    formatType: 1,
  });

  const created = await request(base, '/api/jobs', { method: 'POST', body: { size: 256, items } });
  assert.equal(created.status, 201);
  const jobId = created.body.id;

  const concurrent = await request(base, '/api/jobs', { method: 'POST', body: { size: 256, items } });
  assert.equal(concurrent.status, 409);

  let job = created.body;
  for (let i = 0; i < 150; i += 1) {
    const poll = await request(base, `/api/jobs/${jobId}`);
    job = poll.body;
    if (job.status !== 'running' && job.status !== 'cancelling') break;
    await sleep(100);
  }
  assert.equal(job.status, 'done', JSON.stringify(job));
  assert.equal(job.total, 4);
  assert.equal(job.failed, 1);
  assert.equal(job.done, 4);

  const download = await request(base, job.downloadUrl);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.match(download.headers.get('content-disposition') || '', /guildmoji-\d{4}.*\.zip/);

  const files = readZip(download.buffer);
  assert.ok(files.has('Mock Guild/blob_happy.png'));
  assert.ok(files.has('Mock Guild/blob_sad.png'));
  assert.ok(files.has('Mock Guild/stickers/Wave.png'));
  assert.ok(files.has('manifest.json'));
  assert.equal(files.has('Mock Guild/missing_one.png'), false);

  const sticker = files.get('Mock Guild/stickers/Wave.png');
  assert.equal(sticker.includes(Buffer.from('acTL')), false);
  assert.ok(sticker.includes(Buffer.from('IDAT')));

  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'));
  assert.equal(manifest.counts.requested, 4);
  assert.equal(manifest.counts.exported, 3);
  assert.equal(manifest.counts.failed, 1);
  assert.match(manifest.failed[0].reason, /404/);

  const logout = await request(base, '/api/logout', { method: 'POST' });
  assert.equal(logout.status, 200);
  const afterLogout = await request(base, '/api/state');
  assert.equal(afterLogout.body.authenticated, false);
  const denied = await request(base, '/api/data');
  assert.equal(denied.status, 401);
});
