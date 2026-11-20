/**
 * The rule catalogue (rules.json: the validator's notices, held to utils/validatorNotices.json), its titles and its
 * message locales. The validator's own severity always wins; `default_severity` only fills a finding
 * without one.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const catalogJson = require("./rules.json");

const RULES_CATALOG = Object.freeze(
  Object.fromEntries(
    Object.entries(catalogJson.rules).map(([code, meta]) => [
      code,
      Object.freeze({ code, ...meta }),
    ]),
  ),
);

const SCHEMA_VERSION = catalogJson.$schema_version;

const getRule = (code) => RULES_CATALOG[code] || null;

// The validator's own page of a notice, as its HTML report links it.
const ruleDocUrl = (code) => `https://gtfs-validator.mobilitydata.org/rules.html#${code}-rule`;

const isKnownRule = (code) =>
  Object.prototype.hasOwnProperty.call(RULES_CATALOG, code);

// ── Locales: rule code → message template; en.json covers every rule, the others fall back to it.

const LOCALES_DIR = path.join(__dirname, "locales");
const LOCALES = new Map(); // locale name -> { code: message }

const loadLocales = () => {
  if (!fs.existsSync(LOCALES_DIR)) return;
  for (const entry of fs.readdirSync(LOCALES_DIR)) {
    if (!entry.endsWith(".json")) continue;
    const localeName = entry.slice(0, -".json".length);
    const data = JSON.parse(
      fs.readFileSync(path.join(LOCALES_DIR, entry), "utf8"),
    );
    LOCALES.set(localeName, data);
  }
};
loadLocales();

const DEFAULT_LOCALE = "en";

const getAvailableLocales = () => [...LOCALES.keys()].sort();

const t = (ruleCode, locale = DEFAULT_LOCALE) => {
  const dict = LOCALES.get(locale) || LOCALES.get(DEFAULT_LOCALE);
  if (dict && Object.prototype.hasOwnProperty.call(dict, ruleCode)) {
    return dict[ruleCode];
  }
  const fallback = LOCALES.get(DEFAULT_LOCALE);
  if (fallback && Object.prototype.hasOwnProperty.call(fallback, ruleCode)) {
    return fallback[ruleCode];
  }
  return ruleCode;
};

// Keyed by the validator's notice codes as well as the catalogue's: a report names its rules by the former.
const RULE_TITLES = require("./ruleTitles.json").titles;

const titleOf = (ruleCode, locale = DEFAULT_LOCALE) => {
  const entry = Object.prototype.hasOwnProperty.call(RULE_TITLES, ruleCode) ? RULE_TITLES[ruleCode] : null;
  return entry ? entry[locale] || entry[DEFAULT_LOCALE] || null : null;
};

const titlesIn = (locale = DEFAULT_LOCALE) => Object.fromEntries(Object.keys(RULE_TITLES).map((code) => [code, titleOf(code, locale)]));

const assertLocalesCoverCatalogue = () => {
  const en = LOCALES.get(DEFAULT_LOCALE) || {};
  const missing = [];
  for (const code of Object.keys(RULES_CATALOG)) {
    if (!Object.prototype.hasOwnProperty.call(en, code)) missing.push(code);
  }
  if (missing.length > 0) {
    throw new Error(
      `locales/en.json is missing entries for: ${missing.join(", ")}. ` +
        `Add them so every rule in rules.json has at least an English message template.`,
    );
  }
};
assertLocalesCoverCatalogue();

module.exports = {
  RULES_CATALOG,
  SCHEMA_VERSION,
  getRule,
  ruleDocUrl,
  isKnownRule,
  t,
  titleOf,
  titlesIn,
  DEFAULT_LOCALE,
  getAvailableLocales,
};
