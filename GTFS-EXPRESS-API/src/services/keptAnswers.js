/**
 * A read's answer kept while the session's data version stands (the read cache's version: the file's date and the
 * edit log), so that a question asked again on the same data is not computed again. One answer per session and
 * question; beyond `max` the one asked longest ago is dropped.
 */

"use strict";

const { getDataVersion } = require("../middleware/readCache");

const keptAnswers = (max) => {
  const kept = new Map();
  /** `compute()`'s answer for `question` on the session's working copy `db`, computed when its version moved. */
  const answerOf = (sessionId, db, question, compute) => {
    const key = `${sessionId}|${question}`;
    const version = getDataVersion(db);
    const entry = kept.get(key);
    kept.delete(key);
    if (entry && entry.version === version) {
      kept.set(key, entry);
      return entry.value;
    }
    const value = compute();
    kept.set(key, { version, value });
    while (kept.size > max) kept.delete(kept.keys().next().value);
    return value;
  };
  /** Whether `question`'s answer is kept for the session's working copy as it stands. */
  const holds = (sessionId, db, question) => kept.get(`${sessionId}|${question}`)?.version === getDataVersion(db);
  return { answerOf, holds, _kept: kept };
};

module.exports = { keptAnswers };
