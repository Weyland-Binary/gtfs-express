/**
 * A comment line (`: keep-alive`) every 15 s on an event stream: some stretches of an assistant's turn send nothing
 * (a large tool call, thinking, a validation), and nginx closes an upstream silent for 300 s (proxy_read_timeout),
 * cutting the turn with no error. SSE readers ignore comments. Stops with the response.
 */

"use strict";

const INTERVAL_MS = 15_000;

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
  }
  res.once("close", stop);
  res.once("finish", stop);
  return stop;
};

module.exports = { keepAlive, INTERVAL_MS };
