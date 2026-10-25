'use strict';

/**
 * Creates a simple concurrency limiter that also exposes its queue length.
 */
function createLimiter(max) {
  let active = 0;
  const queue = [];

  const next = () => {
    active -= 1;
    const job = queue.shift();
    if (job) {
      active += 1;
      job.resolve();
    }
  };

  const run = async (fn) => {
    if (active < max) {
      active += 1;
    } else {
      await new Promise((resolve) => queue.push({ resolve }));
    }
    try {
      return await fn();
    } finally {
      next();
    }
  };

  run.active = () => active;
  run.queued = () => queue.length;
  run.max = max;
  return run;
}

/**
 * Run an async mapper over items with at most `limit` in flight.
 */
async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

module.exports = { createLimiter, mapLimit };
