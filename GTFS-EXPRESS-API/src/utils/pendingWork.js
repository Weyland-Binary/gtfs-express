/**
 * Work the server goes on with after a request is answered (an event appended to the log, a refused upload's folder
 * removed): settled() resolves once none is left, so a caller that removes the folder this work writes in, a test
 * suite above all, waits for it first.
 */

"use strict";

const pending = new Set();
const ignore = () => {};

/** Counts `promise` as pending until it settles; never adds a rejection of its own. */
const track = (promise) => {
  const done = Promise.resolve(promise)
    .then(ignore, ignore)
    .then(() => pending.delete(done));
  pending.add(done);
  return promise;
};

/** Pending work with no promise of its own: the function returned ends it. */
const begin = () => {
  let end;
  track(new Promise((resolve) => (end = resolve)));
  return () => end();
};

/** Resolves when nothing is pending, the work that pending work starts included. */
const settled = async () => {
  while (pending.size > 0) await Promise.all([...pending]);
};

module.exports = { track, begin, settled };
