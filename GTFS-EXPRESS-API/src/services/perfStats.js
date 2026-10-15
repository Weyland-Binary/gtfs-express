/**
 * perfStats.js — In-memory ring buffer + percentile aggregator for the
 * request perfLogger middleware.
 *
 * Why in-memory, not persisted: telemetry is meant to spot regressions
 * in the live process, not for long-term archival. A 1000-sample ring
 * buffer per route gives us stable P50/P95/P99 over the most recent
 * traffic without unbounded RAM. The /admin/perf endpoints expose the
 * current snapshot, and the operator can reset between bench runs.
 */

"use strict";

// Per-route circular buffer of recent samples.
// Map<routeKey, { samples: number[][], idx: number, count: number }>
// samples is parallel arrays [duration, status, ts] kept compact.
const MAX_SAMPLES_PER_ROUTE = 1000;

const stats = new Map();

const startedAt = Date.now();

const getOrCreate = (key) => {
  let row = stats.get(key);
  if (!row) {
    row = {
      durations: new Float64Array(MAX_SAMPLES_PER_ROUTE),
      statuses: new Int16Array(MAX_SAMPLES_PER_ROUTE),
      timestamps: new Float64Array(MAX_SAMPLES_PER_ROUTE),
      idx: 0,
      count: 0,
      total: 0, // total observed since process start (not bounded)
      errors: 0, // count of status >= 500
    };
    stats.set(key, row);
  }
  return row;
};

const record = (routeKey, durationMs, status) => {
  const row = getOrCreate(routeKey);
  row.durations[row.idx] = durationMs;
  row.statuses[row.idx] = status;
  row.timestamps[row.idx] = Date.now();
  row.idx = (row.idx + 1) % MAX_SAMPLES_PER_ROUTE;
  row.count = Math.min(row.count + 1, MAX_SAMPLES_PER_ROUTE);
  row.total += 1;
  if (status >= 500) row.errors += 1;
};

/**
 * Returns the percentile of an array of numbers using linear
 * interpolation. The input is mutated (sorted in place).
 */
const percentile = (sortedDurations, p) => {
  const n = sortedDurations.length;
  if (n === 0) return null;
  if (n === 1) return sortedDurations[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedDurations[lo];
  const w = rank - lo;
  return sortedDurations[lo] * (1 - w) + sortedDurations[hi] * w;
};

const summarize = () => {
  const routes = [];
  for (const [key, row] of stats.entries()) {
    if (row.count === 0) continue;
    // Copy the active portion of the ring into a sorted Float64Array.
    const sample = new Float64Array(row.count);
    for (let i = 0; i < row.count; i++) {
      // The ring buffer wraps; row.idx points at the next slot to write.
      // The OLDEST slot is at row.idx (when full) or 0 (when partial).
      const src =
        row.count === MAX_SAMPLES_PER_ROUTE
          ? (row.idx + i) % MAX_SAMPLES_PER_ROUTE
          : i;
      sample[i] = row.durations[src];
    }
    sample.sort();
    let sum = 0;
    let max = 0;
    for (let i = 0; i < sample.length; i++) {
      sum += sample[i];
      if (sample[i] > max) max = sample[i];
    }
    routes.push({
      route: key,
      count: row.count,
      total: row.total,
      errors: row.errors,
      min: sample[0],
      avg: sum / sample.length,
      p50: percentile(sample, 50),
      p95: percentile(sample, 95),
      p99: percentile(sample, 99),
      max,
    });
  }
  routes.sort((a, b) => b.p95 - a.p95); // worst-p95 first
  return {
    startedAt,
    uptimeMs: Date.now() - startedAt,
    bufferSizePerRoute: MAX_SAMPLES_PER_ROUTE,
    routeCount: routes.length,
    routes,
  };
};

const reset = () => {
  stats.clear();
};

module.exports = { record, summarize, reset };
