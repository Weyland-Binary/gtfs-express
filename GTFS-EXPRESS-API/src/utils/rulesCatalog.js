/**
 * The rule catalogue (rules.json), its validation profiles and its message locales.
 * The validator's own severity always wins; `default_severity` only fills a finding without one.
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

const isKnownRule = (code) =>
  Object.prototype.hasOwnProperty.call(RULES_CATALOG, code);

// Throws on a validator code without a catalogue entry, which the web could not translate.
const assertCatalogCovers = (ruleCodes) => {
  const missing = [];
  for (const code of ruleCodes) {
    if (!isKnownRule(code)) missing.push(code);
  }
  if (missing.length > 0) {
    throw new Error(
      `rules.json is missing entries for: ${missing.join(", ")}. ` +
        `Add them to src/utils/rules.json so the catalogue stays the source of truth.`,
    );
  }
};

// ── Validation profiles: they change findings' severities, never the set of rules.

const PROFILES_DIR = path.join(__dirname, "validatorProfiles");
const VALID_SEVERITIES = new Set(["error", "warning", "info"]);

const loadProfilesFrom = (dir) => {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [k, v] of loadProfilesFrom(path.join(dir, entry.name))) {
        out.set(k, v);
      }
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    const profile = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!profile.name || typeof profile.name !== "string") {
      throw new Error(`Profile ${filePath} is missing the 'name' field.`);
    }
    if (out.has(profile.name)) {
      throw new Error(
        `Duplicate profile name '${profile.name}' (in ${filePath}).`,
      );
    }
    for (const [code, sev] of Object.entries(profile.overrides || {})) {
      if (!isKnownRule(code)) {
        throw new Error(
          `Profile '${profile.name}' (${filePath}) overrides unknown rule '${code}'. Add it to rules.json or fix the typo.`,
        );
      }
      if (!VALID_SEVERITIES.has(sev)) {
        throw new Error(
          `Profile '${profile.name}' (${filePath}) sets rule '${code}' to invalid severity '${sev}'. Expected error|warning|info.`,
        );
      }
    }
    out.set(profile.name, Object.freeze(profile));
  }
  return out;
};

const PROFILES = loadProfilesFrom(PROFILES_DIR);

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

// Adds `messageLocalized` to every finding, after applyProfileToReport; English needs none.
const applyLocaleToReport = (locale, groupedErrors) => {
  if (!locale || locale === DEFAULT_LOCALE) return;
  if (!LOCALES.has(locale)) return;
  if (!groupedErrors) return;
  for (const list of Object.values(groupedErrors)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const code = entry.ruleCode || entry.rule || entry.code;
      if (code) entry.messageLocalized = t(code, locale);
    }
  }
};

// The first Accept-Language tag (or its language part) with a loaded locale; quality scores ignored.
const pickLocaleFromAcceptLanguage = (header) => {
  if (!header || typeof header !== "string") return DEFAULT_LOCALE;
  const tags = header
    .split(",")
    .map((s) => s.split(";")[0].trim().toLowerCase())
    .filter(Boolean);
  for (const tag of tags) {
    if (LOCALES.has(tag)) return tag;
    const lang = tag.split("-")[0];
    if (LOCALES.has(lang)) return lang;
  }
  return DEFAULT_LOCALE;
};

const getProfile = (name) => {
  if (!name) return PROFILES.get("canonical") || null;
  return PROFILES.get(name) || null;
};

const getAvailableProfiles = () =>
  [...PROFILES.values()].map((p) => ({
    name: p.name,
    title: p.title || p.name,
    description: p.description || "",
  }));

// Per-rule overrides win; the bulk promotions read the original severity, so they do not chain
// (INFO with both flags ends WARNING).
const applyProfile = (profileName, ruleCode, originalSeverity) => {
  const profile = getProfile(profileName);
  if (!profile) return originalSeverity;
  if (profile.overrides && profile.overrides[ruleCode]) {
    return profile.overrides[ruleCode];
  }
  if (originalSeverity === "warning" && profile.promote_warning_to_error) {
    return "error";
  }
  if (originalSeverity === "info" && profile.promote_info_to_warning) {
    return "warning";
  }
  return originalSeverity;
};

// Rewrites the severities in place and returns the counts after the profile.
const applyProfileToReport = (profileName, groupedErrors) => {
  const counts = { errors: 0, warnings: 0, infos: 0 };
  if (!groupedErrors) return counts;
  for (const list of Object.values(groupedErrors)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const ruleCode = entry.ruleCode || entry.rule || entry.code;
      const original = entry.severity || "error";
      const final = applyProfile(profileName, ruleCode, original);
      entry.severity = final;
      if (final === "error") counts.errors++;
      else if (final === "warning") counts.warnings++;
      else counts.infos++;
    }
  }
  return counts;
};

// Keeps only the findings mapped to a MobilityData notice; mutates in place, drops emptied files.
const applyMdCanonicalFilter = (groupedErrors) => {
  const dropped = { byRule: {}, total: 0 };
  if (!groupedErrors) return dropped;
  for (const file of Object.keys(groupedErrors)) {
    const list = groupedErrors[file];
    if (!Array.isArray(list)) continue;
    const kept = [];
    for (const entry of list) {
      const ruleCode = entry.ruleCode || entry.rule || entry.code;
      const meta = ruleCode ? RULES_CATALOG[ruleCode] : null;
      if (meta && meta.mobilitydata_match) {
        kept.push(entry);
      } else {
        dropped.byRule[ruleCode] = (dropped.byRule[ruleCode] || 0) + 1;
        dropped.total++;
      }
    }
    if (kept.length === 0) {
      delete groupedErrors[file];
    } else {
      groupedErrors[file] = kept;
    }
  }
  return dropped;
};

module.exports = {
  RULES_CATALOG,
  SCHEMA_VERSION,
  getRule,
  isKnownRule,
  assertCatalogCovers,
  getProfile,
  getAvailableProfiles,
  applyProfile,
  applyProfileToReport,
  applyMdCanonicalFilter,
  t,
  DEFAULT_LOCALE,
  getAvailableLocales,
  applyLocaleToReport,
  pickLocaleFromAcceptLanguage,
};
