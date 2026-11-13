/**
 * A comment line (`: keep-alive`) every 15 s on an event stream: some stretches of an assistant's turn send nothing
 * (a large tool call, thinking, a validation), and nginx closes an upstream silent for 300 s (proxy_read_timeout),
 * cutting the turn with no error. SSE readers ignore comments. Stops with the response.
 */

"use strict";

const INTERVAL_MS = 15_000;
// The streams open now, ended together when the server drains: an open stream would hold the drain to its timeout.
const open = new Set();

const keepAlive = (res, { intervalMs = INTERVAL_MS } = {}) => {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return stop();
    try {
      res.write(": keep-alive\n\n");
    } catch {
      stop();
    }
  }, intervalMs);
  // Never what keeps the process alive (tests, a shutdown draining requests).
  if (typeof timer.unref === "function") timer.unref();
  function stop() {
    clearInterval(timer);
    open.delete(res);
  }
  open.add(res);
  res.once("close", stop);
  res.once("finish", stop);
  return stop;
};

/** Ends every open stream (the server is stopping): each turn sees its client gone and stops as it does on a page left. */
const endAll = () => {
  const streams = [...open];
  for (const res of streams) {
    try {
      if (!res.writableEnded && !res.destroyed) res.end();
    } catch {
      /* already gone */
    }
  }
  return streams.length;
};

module.exports = { keepAlive, endAll, INTERVAL_MS };
