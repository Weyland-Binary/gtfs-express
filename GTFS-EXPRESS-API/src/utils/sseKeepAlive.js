/**
 * sseKeepAlive — a comment on a quiet event stream, so that no proxy takes it for a dead one.
 *
 * The assistant's turns stream server-sent events, but some stretches say
 * nothing: the model writing a large tool call (its input is not streamed to
 * the page), its thinking, a preview validated twice by the JAR, roads routed.
 * nginx closes an upstream that sends nothing for proxy_read_timeout (300 s,
 * GTFS-EXPRESS-WEB/nginx.conf), and the person would see a turn cut with no
 * error. Every 15 s of the stream's life a comment line
 * (`: keep-alive`) goes out; SSE readers ignore comments (the web's parsers
 * skip a block without event nor data). It stops with the response.
 *
 *   keepAlive(res, { intervalMs }) → stop()   (also stopped on the response's close or finish)
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
