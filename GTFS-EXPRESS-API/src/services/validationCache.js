/**
 * The canonical validator's reports kept by what they validated: the folder's content (feedFingerprint
 * validationKey: every file the validator sees), the scope it was opened in, the country, the JAR and the UTC day
 * (the expiry rules read today's date). In memory, the least recently
 * used out first, bounded in characters; every caller gets its own copy, since the report is amended after.
 */

"use strict";

const crypto = require("crypto");

const MAX_ENTRIES = 64;
const MAX_CHARS = 32 * 1024 * 1024;
const MAX_ENTRY_CHARS = 8 * 1024 * 1024;

const entries = new Map(); // key → the report as JSON
const inFlight = new Map(); // key → the run's promise, so two openings of one feed at once run the validator once
let chars = 0;

const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/**
 * A report's key. `scope` keeps a report to whoever opened the feed (an account, an address) or to a published
 * feed's url: a private feed's report never answers another person, whose timing would tell it was opened before.
 */
const keyOf = ({ content, scope, countryCode = null, jar, now = Date.now() }) =>
  content && scope && jar ? crypto.createHash("sha256").update(JSON.stringify([content, scope, countryCode || null, jar, dayOf(now)])).digest("hex") : null;

const read = (key) => {
  const text = entries.get(key);
  if (text == null) return null;
  entries.delete(key);
  entries.set(key, text);
  return JSON.parse(text);
};

const keep = (key, report) => {
  const text = JSON.stringify(report);
  if (text.length > MAX_ENTRY_CHARS) return;
  if (entries.has(key)) chars -= entries.get(key).length;
  entries.delete(key);
  entries.set(key, text);
  chars += text.length;
  while (entries.size > MAX_ENTRIES || chars > MAX_CHARS) {
    const [oldest, value] = entries.entries().next().value;
    entries.delete(oldest);
    chars -= value.length;
  }
};

/** The report under `key`, else `run()`'s, kept when `keepIf(report)`; a null key always runs. */
const cached = async (key, run, { keepIf = () => true } = {}) => {
  if (!key) return run();
  const hit = read(key);
  if (hit) return hit;
  if (!inFlight.has(key)) {
    inFlight.set(
      key,
      run()
        .then((report) => {
          if (report && keepIf(report)) keep(key, report);
          return JSON.stringify(report);
        })
        .finally(() => inFlight.delete(key)),
    );
  }
  return JSON.parse(await inFlight.get(key));
};

const reset = () => {
  entries.clear();
  inFlight.clear();
  chars = 0;
};

module.exports = { keyOf, cached, _internals: { reset, size: () => entries.size, chars: () => chars, MAX_ENTRIES, MAX_CHARS, MAX_ENTRY_CHARS, dayOf } };
