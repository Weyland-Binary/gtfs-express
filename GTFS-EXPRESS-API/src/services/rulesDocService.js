/**
 * rulesDocService.js — serve the public validation-rules HTML page
 * computed on the fly from rules.json + locales/{en,fr}.json.
 *
 * Replaces the previous static `rules.generated.html` artefact, which
 * required a manual `npm run docs:rules` step and could drift silently
 * from rules.json. By generating in-memory we eliminate the duplication
 * entirely — same source of truth as the React ValidationRulesPage.
 *
 * Cache: keyed on the max mtime of the three input files (rules.json
 * and the two locale dictionaries). A change to any one invalidates
 * the cache; a steady-state hit is a Map lookup + 3 fs.statSync calls.
 * Pattern mirrors `services/betaGate.js:46-67`.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { renderRulesDoc } = require("../utils/rulesDocRenderer");

const SOURCES = [
  path.join(__dirname, "..", "utils", "rules.json"),
  path.join(__dirname, "..", "utils", "locales", "en.json"),
  path.join(__dirname, "..", "utils", "locales", "fr.json"),
];

let cachedHtml = null;
let cachedMtimeMs = 0;

const sourceMaxMtime = () =>
  SOURCES.reduce((max, p) => Math.max(max, fs.statSync(p).mtimeMs), 0);

/**
 * Returns the rendered HTML for the validation-rules page.
 * Re-renders only when one of the source files has been touched since
 * the last call.
 */
const getRulesDocHtml = () => {
  const currentMtime = sourceMaxMtime();
  if (cachedHtml && currentMtime === cachedMtimeMs) {
    return cachedHtml;
  }
  cachedHtml = renderRulesDoc({
    rulesJson: JSON.parse(fs.readFileSync(SOURCES[0], "utf8")),
    enLocale: JSON.parse(fs.readFileSync(SOURCES[1], "utf8")),
    frLocale: JSON.parse(fs.readFileSync(SOURCES[2], "utf8")),
  });
  cachedMtimeMs = currentMtime;
  return cachedHtml;
};

// Test-only: drop the cache so a test that touches the source files
// can observe a re-render on the next call.
const _resetCacheForTests = () => {
  cachedHtml = null;
  cachedMtimeMs = 0;
};

module.exports = { getRulesDocHtml, _resetCacheForTests };
