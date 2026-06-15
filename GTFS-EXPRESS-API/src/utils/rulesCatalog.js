/**
 * rulesCatalog.js — Programmatic access to rules.json.
 *
 * The catalogue is the source of truth for:
 *   - UI labels and i18n message keys (front-end ValidationErrorsPage)
 *   - documentation generation
 *   - alignment tracking with the MobilityData Canonical Validator
 *   - default severity used when a finding has no severity attached
 *
 * Runtime severity comes from the MobilityData canonical validator
 * itself (the `severity` field of each notice in `report.json`). The
 * `default_severity` in this catalogue is only used as a fallback when
 * a finding has no severity attached — never to override an explicit
 * severity from the validator.
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

// Asserts that every wire-format code referenced by the validator's RULE
// constant map has a catalogue entry. Throws with the missing codes so
// CI / module load surfaces drift loudly instead of silently emitting
// findings that the UI can't translate.
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

// ── Validation profiles ───────────────────────────────────────────────────
//
// A profile selectively re-classifies the severity of findings emitted by
// the validator. Profiles do NOT add or remove rules; they only adjust
// severity. See validatorProfiles/README.md for the schema.

const PROFILES_DIR = path.join(__dirname, "validatorProfiles");
const VALID_SEVERITIES = new Set(["error", "warning", "info"]);

const loadProfilesFrom = (dir) => {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Recurse into countries/ etc.
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
    // Validate override targets: every code must exist in rules.json,
    // every severity must be valid.
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

// ── i18n / locales ────────────────────────────────────────────────────────
//
// Each locale is a flat JSON map keyed by rule code → localized message
// template. en.json is the baseline (every rule has an entry); other
// locales fall back to en when a translation is missing. The drift guard
// ensures every rule code has at least an en.json entry at module load.

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

// Returns the localized message template for a rule code in the requested
// locale, or falls back to the English template, or finally to the rule
// code itself if no translation exists at all.
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

// Drift guard: every rule code in the catalogue must have an entry in en.json.
// Throws at module load if a rule lacks a baseline translation.
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

// Walks a grouped-errors map and adds `messageLocalized` to every entry.
// Use this AFTER applyProfileToReport. No-op when locale is "en" or absent
// (the original `message` field is already English).
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

// Parse the first acceptable locale out of an Accept-Language header.
// Simple parser: ignores quality scores, picks the first segment whose
// language tag (or its language-only prefix) maps to a loaded locale.
// Returns DEFAULT_LOCALE when nothing matches.
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

// Apply a profile's severity transforms to a single finding.
// Returns the new severity (may equal originalSeverity).
//
// Bulk promotions (`promote_info_to_warning`, `promote_warning_to_error`)
// are evaluated against the ORIGINAL severity, not the post-promotion one.
// This means an INFO finding under a profile with both flags set ends up
// as WARNING, NOT ERROR — promotions do not chain. Callers who want
// "everything becomes ERROR" must use explicit per-rule overrides.
const applyProfile = (profileName, ruleCode, originalSeverity) => {
  const profile = getProfile(profileName);
  if (!profile) return originalSeverity;
  // Per-rule overrides win over bulk promotions.
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

// Apply a profile to an entire grouped-errors map in-place. Returns a
// summary { errors, warnings, infos } of post-profile counts so callers
// can recompute the `valid` flag without re-iterating.
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

// Strip every finding whose ruleCode is not mapped to a MobilityData
// Canonical notice. Used by the upload / validate / export pipelines when
// strict MD-canonical output is requested, so users only see findings that
// MD itself would emit (modulo trigger / threshold differences — the
// definitive parity comes from the canonicalValidatorService sidecar).
// Mutates `groupedErrors` in place; empty file lists are removed.
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
  // Profiles
  getProfile,
  getAvailableProfiles,
  applyProfile,
  applyProfileToReport,
  applyMdCanonicalFilter,
  // i18n
  t,
  DEFAULT_LOCALE,
  getAvailableLocales,
  applyLocaleToReport,
  pickLocaleFromAcceptLanguage,
};
