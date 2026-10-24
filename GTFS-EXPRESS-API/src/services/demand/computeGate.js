/**
 * At most DEMAND_MAX_CONCURRENT demand computations run at once (seconds of CPU and a copy of the feed each);
 * a short queue waits behind them, and beyond it, or after a minute queued, 429 BUSY with a Retry-After.
 */

"use strict";

const config = require("../../config");

const MAX_QUEUED = 6;
const QUEUE_WAIT_MS = 60000;
const RETRY_AFTER_SEC = 10;

let running = 0;
const queue = [];

const maxRunning = () => Math.max(1, Number(config.DEMAND_MAX_CONCURRENT) || 2);

const busy = () => Object.assign(new Error("The server is busy with other estimates: try again in a moment."), { status: 429, code: "BUSY", retryAfterSec: RETRY_AFTER_SEC });

const acquire = () =>
  new Promise((resolve, reject) => {
    if (running < maxRunning()) {
      running += 1;
      resolve();
      return;
    }
    if (queue.length >= MAX_QUEUED) {
      reject(busy());
      return;
    }
    const entry = { resolve, timer: null };
    entry.timer = setTimeout(() => {
      const i = queue.indexOf(entry);
      if (i >= 0) queue.splice(i, 1);
      reject(busy());
    }, QUEUE_WAIT_MS);
    entry.timer.unref?.();
    queue.push(entry);
  });

const release = () => {
  running = Math.max(0, running - 1);
  while (queue.length && running < maxRunning()) {
    const next = queue.shift();
    clearTimeout(next.timer);
    running += 1;
    next.resolve();
  }
};

const withGate = async (fn) => {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
};

const stats = () => ({ running, queued: queue.length, max: maxRunning() });

module.exports = { withGate, stats, _internals: { MAX_QUEUED, QUEUE_WAIT_MS, reset: () => { running = 0; queue.splice(0).forEach((e) => clearTimeout(e.timer)); } } };
