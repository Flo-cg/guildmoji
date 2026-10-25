'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { ZipFile } = require('./zip');
const { downloadItem, buildGuildFolders, makeUniquePath } = require('./export');
const { DATA_DIR, ensureDir } = require('./cache');

const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const JOB_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_ITEMS = 25000;
const CONCURRENCY = 6;

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

class JobManager {
  constructor() {
    ensureDir(JOBS_DIR);
    for (const name of fs.readdirSync(JOBS_DIR)) {
      if (name.endsWith('.zip')) {
        fs.rmSync(path.join(JOBS_DIR, name), { force: true });
      }
    }
    this.jobs = new Map();
    this.activeJobId = null;

    setInterval(() => this.cleanup(), 10 * 60 * 1000).unref();
  }

  create({ items, size, user }) {
    if (!Array.isArray(items) || items.length === 0) {
      throw Object.assign(new Error('No items were selected.'), { status: 400 });
    }
    if (items.length > MAX_ITEMS) {
      throw Object.assign(new Error(`Too many items (max ${MAX_ITEMS}).`), { status: 400 });
    }
    if (this.activeJobId) {
      throw Object.assign(new Error('An export is already running. Please wait for it to finish.'), {
        status: 409,
      });
    }

    const id = crypto.randomUUID();
    const zipName = `guildmoji-${stamp()}.zip`;
    const job = {
      id,
      status: 'running',
      items,
      size,
      user,
      total: items.length,
      done: 0,
      failures: [],
      current: null,
      bytes: 0,
      startedAt: Date.now(),
      finishedAt: null,
      zipPath: path.join(JOBS_DIR, `${id}.zip`),
      zipName,
      error: null,
      cancelled: false,
    };

    this.jobs.set(id, job);
    this.activeJobId = id;
    this.run(job).catch((err) => {
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = Date.now();
      this.activeJobId = null;
    });

    return this.publicJob(job);
  }

  async run(job) {
    const zip = new ZipFile(job.zipPath);
    const folders = buildGuildFolders(job.items);
    const used = new Set();
    const manifestItems = [];
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        if (job.cancelled) return;
        const index = cursor;
        cursor += 1;
        if (index >= job.items.length) return;
        const item = job.items[index];
        job.current = `${item.guildName} / ${item.name}`;

        try {
          const result = await downloadItem(item, job.size);
          const file = makeUniquePath(used, folders.get(item.guildId), item);
          await zip.add(file, result.data);
          job.bytes += result.data.length;
          manifestItems.push({
            file,
            id: item.id,
            name: item.name,
            kind: item.kind,
            guild: item.guildName,
            guildId: item.guildId,
            animated: Boolean(item.animated),
            sourceFormat: item.format,
            source: result.source,
            note: result.note || undefined,
          });
        } catch (err) {
          job.failures.push({
            id: item.id,
            name: item.name,
            kind: item.kind,
            guild: item.guildName,
            reason: err.message,
          });
        } finally {
          job.done += 1;
        }
      }
    };

    try {
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, job.items.length) }, () => worker()),
      );

      if (job.cancelled) {
        await zip.abort();
        job.status = 'cancelled';
        job.finishedAt = Date.now();
        job.current = null;
        this.activeJobId = null;
        return;
      }

      manifestItems.sort((a, b) => a.file.localeCompare(b.file));
      const manifest = {
        exportedAt: new Date().toISOString(),
        account: job.user ? job.user.username : null,
        resolution: job.size,
        counts: {
          requested: job.total,
          exported: manifestItems.length,
          failed: job.failures.length,
          emoji: manifestItems.filter((i) => i.kind === 'emoji').length,
          stickers: manifestItems.filter((i) => i.kind === 'sticker').length,
        },
        note:
          'Animated emoji and stickers are saved as a still PNG of their first frame. ' +
          'The "source" field links to the original asset served by Discord.',
        items: manifestItems,
        failed: job.failures,
      };
      await zip.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
      await zip.finalize();

      job.status = 'done';
      job.finishedAt = Date.now();
      job.current = null;
      this.activeJobId = null;
    } catch (err) {
      await zip.abort();
      job.status = 'error';
      job.error = err.message;
      job.finishedAt = Date.now();
      job.current = null;
      this.activeJobId = null;
      throw err;
    }
  }

  get(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    return this.publicJob(job);
  }

  file(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'done') return null;
    try {
      const stat = fs.statSync(job.zipPath);
      if (!stat.isFile()) return null;
    } catch {
      return null;
    }
    return { path: job.zipPath, name: job.zipName, size: fs.statSync(job.zipPath).size };
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === 'running') {
      job.cancelled = true;
      job.status = 'cancelling';
    }
    return this.publicJob(job);
  }

  publicJob(job) {
    return {
      id: job.id,
      status: job.status,
      total: job.total,
      done: job.done,
      failed: job.failures.length,
      current: job.current,
      bytes: job.bytes,
      size: job.size,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      error: job.error,
      zipName: job.zipName,
      downloadUrl: job.status === 'done' ? `/api/jobs/${job.id}/file` : null,
      failures: job.failures.slice(0, 100),
    };
  }

  cleanup() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      const finished = job.finishedAt || job.startedAt;
      if (now - finished > JOB_MAX_AGE_MS && job.status !== 'running' && job.status !== 'cancelling') {
        fs.rmSync(job.zipPath, { force: true });
        this.jobs.delete(id);
      }
    }
  }
}

module.exports = { JobManager, JOBS_DIR };
