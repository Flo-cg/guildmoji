'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { toPng, sniff } = require('../lib/convert');
const { sanitizeSegment, normalizeSize, buildGuildFolders, makeUniquePath } = require('../lib/export');
const { crc32 } = require('../lib/zip');

const PNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'emoji.png'));
const APNG = fs.readFileSync(path.join(__dirname, 'fixtures', 'sticker.png'));

test('APNG is converted to a still PNG without animation chunks', async () => {
  assert.equal(sniff(APNG), 'png');
  assert.ok(APNG.includes(Buffer.from('acTL')), 'fixture should be animated');

  const result = await toPng(APNG);
  assert.match(result.note, /first frame/i);
  assert.equal(sniff(result.data), 'png');
  assert.equal(result.data.includes(Buffer.from('acTL')), false);
  assert.equal(result.data.includes(Buffer.from('fcTL')), false);
  assert.equal(result.data.includes(Buffer.from('fdAT')), false);
  assert.ok(result.data.includes(Buffer.from('IDAT')));
});

test('static PNG passes through unchanged', async () => {
  const result = await toPng(PNG);
  assert.equal(result.note, null);
  assert.deepEqual(result.data, PNG);
});

test('file name sanitising blocks traversal and Windows reserved names', () => {
  assert.equal(sanitizeSegment('../../etc/passwd'), '_.._etc_passwd');
  assert.equal(sanitizeSegment('CON'), '_CON');
  assert.equal(sanitizeSegment('  héllo / world  '), 'héllo _ world');
  assert.equal(sanitizeSegment(''), 'file');
  assert.ok(Buffer.byteLength(sanitizeSegment('🦊'.repeat(100)), 'utf8') <= 180);
});

test('guild folders remain unique and asset names are de-duplicated', () => {
  const folders = buildGuildFolders([
    { guildId: '1', guildName: 'Same Name' },
    { guildId: '2', guildName: 'Same Name' },
  ]);
  assert.equal(folders.get('1'), 'Same Name');
  assert.equal(folders.get('2'), 'Same Name [2]');

  const used = new Set();
  const first = makeUniquePath(used, 'Server', { id: '1', name: 'wave', kind: 'emoji' });
  const second = makeUniquePath(used, 'Server', { id: '2', name: 'wave', kind: 'emoji' });
  const sticker = makeUniquePath(used, 'Server', { id: '3', name: 'wave', kind: 'sticker' });
  assert.equal(first, 'Server/wave.png');
  assert.equal(second, 'Server/wave (2).png');
  assert.equal(sticker, 'Server/stickers/wave.png');
});

test('PNG sizes are restricted to supported values', () => {
  assert.equal(normalizeSize(128), 128);
  assert.equal(normalizeSize('512'), 512);
  assert.equal(normalizeSize(1000), 256);
  assert.equal(normalizeSize('nope'), 256);
});

test('ZIP CRC32 matches the standard test vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});
