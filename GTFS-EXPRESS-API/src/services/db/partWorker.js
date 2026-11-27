/**
 * A thread that loads one part of a large file into a database of its own (feedImport loadPart): the rows of a byte
 * range, placed, folded or kept aside exactly as the writer of the whole file would, for that writer to take in.
 */

"use strict";

const { workerData, parentPort } = require("worker_threads");
const { _internals } = require("./feedImport");

_internals
  .loadPart(workerData, (n) => parentPort.postMessage({ type: "bytes", n }))
  .then(
    (out) => parentPort.postMessage({ type: "done", out }),
    (err) => parentPort.postMessage({ type: "failed", message: String((err && err.message) || err) }),
  );
