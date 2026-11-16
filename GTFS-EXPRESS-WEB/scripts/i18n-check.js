#!/usr/bin/env node

/**
 * i18n-check — the translations are complete, used and written in the
 * glossary's words.
 *
 * Usage: node scripts/i18n-check.js [--translations <file>] [--src <dir>] [--json]
 *
 * What it does:
 * 1. Reads translations.js and extracts the keys (and the French texts) of
 *    every language block — only translations.js, never the rest of src/i18n.
 * 2. Scans all .js files in src/ for t("key") calls.
 * 3. Reports:
 *    - Keys used in code but missing from translations (error). There is no
 *      alias any more: the target design's renames went through a table
 *      (src/i18n/aliases.js) until the last lot (WP11) moved the code and the
 *      eight blocks to the new keys and emptied it; this check never reads it.
 *    - Keys defined in translations but never used in code (warning)
 *    - Keys present in some languages but not all — parity on `en` (error)
 *    - Forbidden words (error): the glossary gives one meaning per word, so
 *      the French block must not say session, feed, flux, spec, projection,
 *      gate, preview, sandbox, Shape Studio, Studio Projet, the retired offer's
 *      words (code bêta, code d'accès, offres Pro, Pro et Équipe), nor "plan"
 *      outside "plan de changement", "plan de ligne" and "plan du réseau" (or the word "arrière-plan"), nor the verb "valider" (which belongs
 *      to the canonical validator: its own keys only) — as whole words, on
 *      the whole block since the last lot (the lots before opened it
 *      namespace by namespace, D41).
 *
 * The functions are exported so a unit test can run them on a fixture.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_PATHS = {
  translations: path.join(ROOT, "src", "i18n", "translations.js"),
  src: path.join(ROOT, "src"),
};

// ── Forbidden words (glossary §1, D34, D41) ────────────────────────────────

// The retired beta codes (2026-10-08) and the plans before the licence: words a screen said long after they were gone.
const RETIRED_OFFER_WORDS = ["code bêta", "code d'accès", "code d’accès", "offres Pro", "Pro et Équipe"];
const FORBIDDEN_WORDS = ["session", "feed", "flux", "spec", "projection", "gate", "preview", "sandbox", "Shape Studio", "Studio Projet", ...RETIRED_OFFER_WORDS];
// "plan" only in "plan de changement", the passenger's "plan de ligne" and "plan du réseau" (printed maps, the trade's
// own words) — and "arrière-plan" (background), another word.
const PLAN_ALLOWED_RE = /\bplans? de changement\b|\bplans? de (la )?lignes?\b|\bplans? du (réseau|quartier)\b|fiches horaires (et|&) plans\b|arrière-plans?\b/gi;
// "valider" is the canonical validator's: a person keeps a clause, uses a code, approves a version.
const VALIDATE_WORDS = ["valider", "validé", "validée", "validés", "validées"];
const VALIDATE_EXEMPT = (key) => key.startsWith("gtfsCheck.") || key.startsWith("status.validation.") || key === "network.reference.validation" || key === "access.validatorOff";
// The whole fr block (D41: the lots opened it namespace by namespace, WP0 to WP10; WP11 the rest).
const FORBIDDEN_NAMESPACES = [""];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A whole-word, accent-aware, case-insensitive test for one word or phrase. */
const wholeWord = (word) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(word)}(?![\\p{L}\\p{N}_])`, "iu");

/**
 * The forbidden words found in `values` ({ key: frenchText }) for the keys of
 * the given namespaces: [{ key, word, text }]. Placeholders ({name}) are not
 * text and are ignored.
 */
function forbiddenWords(values, namespaces = FORBIDDEN_NAMESPACES) {
  const found = [];
  for (const [key, raw] of Object.entries(values || {})) {
    if (!namespaces.some((ns) => key.startsWith(ns))) continue;
    const text = String(raw).replace(/\{[^}]*\}/g, " ");
    for (const word of FORBIDDEN_WORDS) if (wholeWord(word).test(text)) found.push({ key, word, text: raw });
    if (wholeWord("plan").test(text.replace(PLAN_ALLOWED_RE, " "))) found.push({ key, word: "plan", text: raw });
    if (!VALIDATE_EXEMPT(key)) for (const word of VALIDATE_WORDS) if (wholeWord(word).test(text)) found.push({ key, word, text: raw });
  }
  return found;
}

// ── 1. Parse translations ──────────────────────────────────────────────────

/** A JS string literal's characters, unescaped enough for word matching. */
const unquote = (s) => s.replace(/\\(["\\/])/g, "$1").replace(/\\n/g, "\n");

function parseTranslations(content) {
  // Extract all language blocks by finding top-level keys
  const langRegex = /^\s{2}(\w{2}):\s*\{/gm;
  const languages = [];
  const langPositions = [];
  let match;
  while ((match = langRegex.exec(content)) !== null) {
    languages.push(match[1]);
    langPositions.push(match.index);
  }

  // Extract keys (and texts) per language: use the region between lang markers
  const keysByLang = {};
  const valuesByLang = {};
  for (let i = 0; i < languages.length; i++) {
    const lang = languages[i];
    const start = langPositions[i];
    const end = i + 1 < langPositions.length ? langPositions[i + 1] : content.length;
    const block = content.substring(start, end);

    const keys = new Set();
    const values = {};
    const keyRegex = /^\s+"([^"]+)"\s*:/gm;
    let keyMatch;
    while ((keyMatch = keyRegex.exec(block)) !== null) keys.add(keyMatch[1]);
    // The text may sit on the next line (`"key":\n      "text",`) and be single-quoted (`'Stop "{name}" saved'`).
    const valueRegex = /^\s+"([^"]+)"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gm;
    let valueMatch;
    while ((valueMatch = valueRegex.exec(block)) !== null) values[valueMatch[1]] = unquote(valueMatch[2] ?? valueMatch[3].replace(/\\'/g, "'"));
    keysByLang[lang] = keys;
    valuesByLang[lang] = values;
  }

  return { languages, keysByLang, valuesByLang };
}

// ── 2. Scan source for t("key") calls ─────────────────────────────────────

function findUsedKeys(srcDir) {
  const usedKeys = new Set();

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "i18n") continue;
        scanDir(fullPath);
      } else if (entry.name.endsWith(".js") || entry.name.endsWith(".jsx")) {
        const content = fs.readFileSync(fullPath, "utf-8");
        // Match t("key"), t('key'), t(`key`)
        const regex = /\bt\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
        let match;
        while ((match = regex.exec(content)) !== null) {
          usedKeys.add(match[1]);
        }
      }
    }
  }

  scanDir(srcDir);
  return usedKeys;
}

// ── 3. Analysis ────────────────────────────────────────────────────────────

/**
 * The verdict on parsed inputs: { errors, warnings, stats }. Pure, so the
 * unit test runs it on a fixture; the CLI prints it.
 */
function analyze({ languages, keysByLang, valuesByLang }, usedKeys, { namespaces = FORBIDDEN_NAMESPACES } = {}) {
  const refLang = "en";
  const refKeys = keysByLang[refLang] || new Set();
  const errors = [];
  const warnings = [];

  // 3a. Keys used in code but missing from the reference language
  const missingFromRef = [...usedKeys]
    .filter((k) => !refKeys.has(k))
    // Filter out template literal patterns (${...}) — these are dynamic keys
    .filter((k) => !k.includes("${"))
    .sort();
  if (missingFromRef.length) errors.push({ type: "missing_in_code", keys: missingFromRef, message: `${missingFromRef.length} keys used in code but MISSING from ${refLang}` });

  // 3b. Orphan keys (in translations but never used in code: dynamic keys, t(`a.${b}`), are not seen)
  const orphans = [...refKeys].filter((k) => !usedKeys.has(k)).sort();
  if (orphans.length) warnings.push({ type: "orphans", keys: orphans, message: `${orphans.length} keys defined in ${refLang} but never called as t("key") (dynamic keys included)` });

  // 3d. Incomplete translations (keys in ref but missing in other languages)
  const completeness = [];
  for (const lang of languages) {
    if (lang === refLang) continue;
    const langKeys = keysByLang[lang] || new Set();
    const missing = [...refKeys].filter((k) => !langKeys.has(k));
    const extra = [...langKeys].filter((k) => !refKeys.has(k));
    completeness.push({ lang, count: langKeys.size, missing, extra });
    if (missing.length) errors.push({ type: "incomplete", lang, keys: missing, message: `${lang}: ${langKeys.size} keys — ${missing.length} MISSING vs ${refLang}` });
    if (extra.length) warnings.push({ type: "extra", lang, keys: extra, message: `${lang}: ${extra.length} EXTRA keys not in ${refLang}` });
  }

  // 3e. Forbidden words in the French block, in the rewritten namespaces.
  const forbidden = forbiddenWords(valuesByLang.fr || {}, namespaces);
  if (forbidden.length) errors.push({ type: "forbidden_words", keys: forbidden.map((f) => `${f.key}: "${f.word}" in "${f.text}"`), message: `${forbidden.length} forbidden word(s) in the fr block (one word, one sense)` });

  return { errors, warnings, completeness, stats: { languages, refLang, refKeys: refKeys.size, usedKeys: usedKeys.size } };
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { ...DEFAULT_PATHS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--translations" || a === "--src") out[a.slice(2)] = path.resolve(argv[++i]);
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const parsed = parseTranslations(fs.readFileSync(opts.translations, "utf-8"));
  const usedKeys = findUsedKeys(opts.src);
  const result = analyze(parsed, usedKeys);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: result.errors.length === 0, ...result }, null, 2)}\n`);
    process.exit(result.errors.length ? 1 : 0);
  }

  const list = (keys, max = 20) => {
    keys.slice(0, max).forEach((k) => console.log(`   - ${k}`));
    if (keys.length > max) console.log(`   ... and ${keys.length - max} more`);
  };
  console.log("\n═══ i18n Check Report ═══\n");
  console.log(`Languages: ${result.stats.languages.join(", ")} (${result.stats.languages.length})`);
  console.log(`Reference keys (${result.stats.refLang}): ${result.stats.refKeys}`);
  console.log(`Keys used in code: ${result.stats.usedKeys}\n`);
  for (const e of result.errors) {
    console.log(`❌ ${e.message}:`);
    list(e.keys);
    console.log();
  }
  for (const w of result.warnings) {
    console.log(`⚠️  ${w.message}:`);
    list(w.keys);
    console.log();
  }
  if (!result.errors.some((e) => e.type === "missing_in_code")) console.log(`✅ All keys used in code exist in ${result.stats.refLang}\n`);
  if (!result.errors.some((e) => e.type === "forbidden_words")) console.log("✅ No forbidden word in the fr block (the whole block)\n");
  console.log("── Per-language completeness ──\n");
  for (const c of result.completeness) {
    console.log(c.missing.length === 0 && c.extra.length === 0 ? `  ✅ ${c.lang}: ${c.count} keys — complete` : `  ${c.missing.length ? "❌" : "⚠️ "} ${c.lang}: ${c.count} keys — ${c.missing.length} missing, ${c.extra.length} extra`);
  }
  console.log("\n═══════════════════════\n");
  if (result.errors.length) {
    console.log("❌ i18n check found issues. Fix them before merging.\n");
    process.exit(1);
  }
  console.log("✅ i18n check passed.\n");
  process.exit(0);
}

module.exports = { parseTranslations, findUsedKeys, forbiddenWords, analyze, FORBIDDEN_WORDS, FORBIDDEN_NAMESPACES, VALIDATE_WORDS };

if (require.main === module) main();
