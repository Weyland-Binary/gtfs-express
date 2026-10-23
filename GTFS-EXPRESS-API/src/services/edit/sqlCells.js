/**
 * Bounds what a SQL read hands back, whatever the row cap lets through: a few rows can still carry a cell of hundreds
 * of megabytes (zeroblob, printf padding) that the API would hold, then serialise. A text cell is cut past
 * CELL_MAX_CHARS, a blob is described and never sent as bytes, and the result stops once its cells reach
 * RESULT_MAX_BYTES.
 */

"use strict";

const CELL_MAX_CHARS = 64 * 1024;
const RESULT_MAX_BYTES = 8 * 1024 * 1024;

const blobLabel = (bytes) => `[BLOB ${bytes} B]`;

const boundCell = (value) => {
  if (value === null || value === undefined) return { value: null, size: 4 };
  if (typeof value === "string") {
    if (value.length <= CELL_MAX_CHARS) return { value, size: value.length };
    return { value: `${value.slice(0, CELL_MAX_CHARS)}…`, size: CELL_MAX_CHARS, cut: true };
  }
  if (value instanceof Uint8Array) return { value: blobLabel(value.byteLength), size: 24, cut: true };
  if (typeof value === "bigint") return { value: value.toString(), size: 20 };
  return { value, size: 8 };
};

/** One result's budget: `take(row)` returns the bounded row, `full` once the budget is spent. */
const resultBudget = ({ resultMaxBytes = RESULT_MAX_BYTES } = {}) => {
  let bytes = 0;
  let cellsCut = false;
  return {
    take(row) {
      const out = {};
      for (const key of Object.keys(row)) {
        const cell = boundCell(row[key]);
        out[key] = cell.value;
        bytes += cell.size + key.length;
        if (cell.cut) cellsCut = true;
      }
      return out;
    },
    get full() {
      return bytes >= resultMaxBytes;
    },
    get cellsCut() {
      return cellsCut;
    },
  };
};

module.exports = { CELL_MAX_CHARS, RESULT_MAX_BYTES, blobLabel, boundCell, resultBudget };
