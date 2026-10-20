/**
 * http — how the demand providers call public APIs: JSON over the injected
 * fetch, a per-request timeout combined with the caller's abort signal, a
 * pacer that spaces the requests to one host (its published rate limit),
 * and a bounded retry on 429 / 503 honouring Retry-After.
 */

"use strict";

const USER_AGENT = "gtfs-express/1.0 (network studio demand inputs; contact via app)";
const TIMEOUT_MS = 20000;
const RETRY_STATUS = new Set([429, 503]);

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });

/** A signal that fires on the caller's abort or after `ms`. */
const withDeadline = (signal, ms) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms);
  const onAbort = () => ctl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  };
  return { signal: ctl.signal, done };
};

const httpError = (url, status) => Object.assign(new Error(`${hostOf(url)}: HTTP ${status}`), { status });
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

/**
 * GET a JSON document. Retries a 429/503 up to `retries` times after
 * Retry-After (≤ 10 s) or a growing pause; throws on any other failure.
 * A 404 resolves to `notFound` when given (an absent record, not an outage).
 */
const getJson = async (ctx, url, { timeoutMs = TIMEOUT_MS, retries = 2, notFound, pace = null } = {}) => {
  const fetchImpl = ctx.fetchImpl;
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation");
  for (let attempt = 0; ; attempt++) {
    if (pace) await pace();
    const dl = withDeadline(ctx.signal, timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { signal: dl.signal, headers: { Accept: "application/json", "User-Agent": USER_AGENT } });
    } catch (err) {
      if (ctx.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORTED" });
      throw err;
    } finally {
      dl.done();
    }
    if (res && res.ok) return res.json();
    const status = res ? res.status : 0;
    if (status === 404 && notFound !== undefined) return notFound;
    if (!RETRY_STATUS.has(status) || attempt >= retries) throw httpError(url, status || "no response");
    const after = Number(res?.headers?.get?.("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(10000, after * 1000) : 800 * (attempt + 1), ctx.signal);
  }
};

/** A pacer: each call waits so that consecutive calls start ≥ `minIntervalMs` apart. */
const createPacer = (minIntervalMs, signal) => {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minIntervalMs;
    if (wait > 0) await sleep(wait, signal);
  };
};

/** Run `fn` over `items` with at most `limit` in flight; results in order. */
const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

module.exports = { getJson, createPacer, mapLimit, sleep, withDeadline, hostOf, USER_AGENT };
