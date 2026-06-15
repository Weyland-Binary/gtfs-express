/**
 * i18nLanguageDrift.test.js — guard against silent drift between the
 * three places that list the supported UI languages:
 *
 *   1. GTFS-EXPRESS-WEB/src/i18n/translations.js  → the language blocks
 *      themselves (`en: { … }`, `fr: { … }`, …)
 *   2. scripts/i18n-check.js                      → the LANGS array used
 *      to drive the 4 i18n invariants checked by the CI gate
 *   3. GTFS-EXPRESS-WEB/src/contexts/LanguageContext.js → the
 *      SUPPORTED_LANGUAGES list rendered in the language selector UI
 *
 * If a contributor adds a 9th language (e.g. ja) to translations.js
 * but forgets one of the other two, the symptoms are silent and
 * confusing:
 *   - missing in i18n-check.js → `npm run i18n:check` validates only 8
 *     of 9 languages, never alerts on missing keys for the new one
 *   - missing in LanguageContext.js → the language exists in the
 *     bundle but the user can't pick it from the UI
 *
 * This test asserts the three sets are exactly equal. Adding a
 * language requires updating all three together — the test fails
 * loudly with a precise diff if any one is missed.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const TRANSLATIONS_PATH = path.join(
  REPO_ROOT,
  "GTFS-EXPRESS-WEB",
  "src",
  "i18n",
  "translations.js",
);
const I18N_CHECK_PATH = path.join(REPO_ROOT, "scripts", "i18n-check.js");
const LANGUAGE_CONTEXT_PATH = path.join(
  REPO_ROOT,
  "GTFS-EXPRESS-WEB",
  "src",
  "contexts",
  "LanguageContext.js",
);

// Extract two-letter language codes from `^  XX: {` block headers
// inside translations.js. Same regex as `i18n-check.js` and
// `refresh-facts.sh`, kept identical on purpose — if it ever needs
// updating, all three places must move together.
const extractTranslationsLangs = (src) =>
  [...src.matchAll(/^ {2}([a-z]{2}): \{/gm)].map((m) => m[1]);

// Parse the LANGS = [...] literal from i18n-check.js. The array is
// declared with double-quoted entries on a single line, e.g.
// `const LANGS = ["en", "fr", "es", ...];`.
const extractI18nCheckLangs = (src) => {
  const m = src.match(/const\s+LANGS\s*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error("Could not find LANGS array in i18n-check.js");
  return [...m[1].matchAll(/"([a-z]{2})"/g)].map((mm) => mm[1]);
};

// Parse the SUPPORTED_LANGUAGES list from LanguageContext.js. The list
// is an array of { code, label, flag } objects; we only need the
// `code` field. Match `code: "xx"` patterns inside the array literal.
const extractContextLangs = (src) => {
  const block = src.match(
    /const\s+SUPPORTED_LANGUAGES\s*=\s*\[([\s\S]*?)\];/,
  );
  if (!block)
    throw new Error("Could not find SUPPORTED_LANGUAGES in LanguageContext.js");
  return [...block[1].matchAll(/code:\s*"([a-z]{2})"/g)].map((m) => m[1]);
};

describe("i18n language drift guard", () => {
  test("translations.js / i18n-check.js / LanguageContext.js list the same languages", () => {
    const translations = extractTranslationsLangs(
      fs.readFileSync(TRANSLATIONS_PATH, "utf8"),
    ).sort();
    const i18nCheck = extractI18nCheckLangs(
      fs.readFileSync(I18N_CHECK_PATH, "utf8"),
    ).sort();
    const context = extractContextLangs(
      fs.readFileSync(LANGUAGE_CONTEXT_PATH, "utf8"),
    ).sort();

    // Sanity: each source must have at least 2 languages so we don't
    // mask a parser failure that returned []
    expect(translations.length).toBeGreaterThan(1);
    expect(i18nCheck.length).toBeGreaterThan(1);
    expect(context.length).toBeGreaterThan(1);

    // The three lists must be identical. A failed expectation surfaces
    // a precise diff so the contributor knows which file they missed.
    expect(i18nCheck).toEqual(translations);
    expect(context).toEqual(translations);
  });
});
