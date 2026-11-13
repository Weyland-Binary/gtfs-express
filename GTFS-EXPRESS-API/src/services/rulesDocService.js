/**
 * The public validation-rules HTML page, rendered in memory from rules.json and the locales so it cannot drift
 * from them; re-rendered when any source file's mtime changes.
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

const _resetCacheForTests = () => {
  cachedHtml = null;
  cachedMtimeMs = 0;
};

module.exports = { getRulesDocHtml, _resetCacheForTests };
