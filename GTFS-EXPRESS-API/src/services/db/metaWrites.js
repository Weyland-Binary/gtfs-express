/**
 * A write that changes no row of the network (a line of its meta: the edit mode's flag, the schema's version) moves
 * the connection's count of changes all the same. Who keeps something by that count listens here and holds it through
 * the write.
 */

"use strict";

const listeners = [];

/** `fn(db)` is called before such a write and may answer what to run once it is done. */
const onMetaWrite = (fn) => listeners.push(fn);

/** Runs `write` on `db` and tells the listeners around it: what they kept of the network stays theirs. */
const metaWrite = (db, write) => {
  const after = listeners.map((listen) => listen(db));
  try {
    return write();
  } finally {
    for (const resume of after) if (typeof resume === "function") resume();
  }
};

module.exports = { onMetaWrite, metaWrite };
