"use strict";

/** A signal that aborts once the request's client is gone before its answer. */
const leftSignal = (res) => {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return controller.signal;
};

module.exports = { leftSignal };
