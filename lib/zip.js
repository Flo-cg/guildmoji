'use strict';

/**
 * A tiny, dependency-free ZIP writer.
 *
 * Assets (PNG files) are already compressed, so entries are STORED instead of
 * deflated. The writer streams to disk so large exports never sit fully in RAM.
 */

const fs = require('node:fs');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01
const MAX_32 = 0xfffffff0;

class ZipFile {
  constructor(filePath) {
    this.filePath = filePath;
    this.stream = fs.createWriteStream(filePath);
    this.streamError = null;
    this.stream.on('error', (err) => {
      this.streamError = err;
    });
    this.offset = 0;
    this.entries = [];
    this.finished = false;
    this.chain = Promise.resolve();
  }

  async write(buf) {
    if (this.streamError) throw this.streamError;
    if (this.offset + buf.length > MAX_32) {
      throw new Error('Export is too large for a standard ZIP file (4 GB)');
    }
    this.offset += buf.length;
    if (this.stream.write(buf)) return;

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.stream.off('drain', onDrain);
        this.stream.off('error', onError);
        this.stream.off('close', onClose);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(this.streamError || new Error('ZIP stream closed unexpectedly'));
      };
      this.stream.on('drain', onDrain);
      this.stream.on('error', onError);
      this.stream.on('close', onClose);
    });
  }

  add(name, data) {
    // Serialize writes: several download workers may add entries concurrently.
    const task = this.chain.then(() => this.addNow(name, data));
    this.chain = task.catch(() => {});
    return task;
  }

  async addNow(name, data) {
    if (this.finished) throw new Error('ZIP file is already finalized');
    const safeName = String(name)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/{2,}/g, '/');
    if (!safeName || safeName.split('/').some((part) => part === '..')) {
      throw new Error(`Invalid ZIP entry name: ${name}`);
    }
    const nameBuf = Buffer.from(safeName, 'utf8');
    if (nameBuf.length > 0xffff) throw new Error('ZIP entry name is too long');
    if (this.entries.length >= 0xffff) throw new Error('Too many files for a standard ZIP file');

    const crc = crc32(data);
    const size = data.length;
    const localOffset = this.offset;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 file names
    header.writeUInt16LE(0, 8); // method: store
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28); // extra length

    await this.write(Buffer.concat([header, nameBuf]));
    await this.write(data);

    this.entries.push({ nameBuf, crc, size, offset: localOffset });
    return { name: safeName, size };
  }

  async finalize() {
    if (this.finished) return;
    await this.chain;

    const cdStart = this.offset;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4); // version made by
      header.writeUInt16LE(20, 6); // version needed
      header.writeUInt16LE(0x0800, 8); // UTF-8
      header.writeUInt16LE(0, 10); // store
      header.writeUInt16LE(DOS_TIME, 12);
      header.writeUInt16LE(DOS_DATE, 14);
      header.writeUInt32LE(entry.crc, 16);
      header.writeUInt32LE(entry.size, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.nameBuf.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk
      header.writeUInt16LE(0, 36); // internal attrs
      header.writeUInt32LE(0, 38); // external attrs
      header.writeUInt32LE(entry.offset, 42);
      await this.write(Buffer.concat([header, entry.nameBuf]));
    }

    const cdSize = this.offset - cdStart;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4); // disk number
    end.writeUInt16LE(0, 6); // central dir disk
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(cdSize, 12);
    end.writeUInt32LE(cdStart, 16);
    end.writeUInt16LE(0, 20); // comment length
    await this.write(end);

    this.finished = true;
    await new Promise((resolve, reject) => {
      this.stream.end((err) => (err ? reject(err) : resolve()));
    });
  }

  async abort() {
    this.finished = true;
    try {
      this.stream.destroy();
    } catch {
      /* ignore */
    }
    await fs.promises.rm(this.filePath, { force: true }).catch(() => {});
  }
}

module.exports = { ZipFile, crc32 };
