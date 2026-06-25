#!/usr/bin/env node

/**
 * i18n-check — Detect missing, orphan, and incomplete translation keys.
 *
 * Usage: node scripts/i18n-check.js
 *
 * What it does:
 * 1. Reads translations.js and extracts all keys per language
 * 2. Scans all .js files in src/ for t("key") calls
 * 3. Reports:
 *    - Keys used in code but missing from translations (per language)
 *    - Keys defined in translations but never used in code (orphans)
 *    - Keys present in some languages but not all (incomplete)
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TRANSLATIONS_PATH = path.join(ROOT, "src", "i18n", "translations.js");
const SRC_DIR = path.join(ROOT, "src");

// ── 1. Parse translations ──────────────────────────────────────────────────

function parseTranslations() {
  const content = fs.readFileSync(TRANSLATIONS_PATH, "utf-8");

  // Extract all language blocks by finding top-level keys
  const langRegex = /^\s{2}(\w{2}):\s*\{/gm;
  const languages = [];
  const langPositions = [];
  let match;
  while ((match = langRegex.exec(content)) !== null) {
    languages.push(match[1]);
    langPositions.push(match.index);
  }

  // Extract keys per language: use the region between lang markers
  const keysByLang = {};
  for (let i = 0; i < languages.length; i++) {
    const lang = languages[i];
    const start = langPositions[i];
    const end = i + 1 < langPositions.length ? langPositions[i + 1] : content.length;
    const block = content.substring(start, end);

    const keyRegex = /^\s+"([^"]+)"\s*:/gm;
    const keys = new Set();
    let keyMatch;
    while ((keyMatch = keyRegex.exec(block)) !== null) {
      keys.add(keyMatch[1]);
    }
    keysByLang[lang] = keys;
  }

  return { languages, keysByLang };
}

// ── 2. Scan source for t("key") calls ─────────────────────────────────────

function findUsedKeys() {
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

  scanDir(SRC_DIR);
  return usedKeys;
}

// ── 3. Analysis ────────────────────────────────────────────────────────────

function analyze() {
  const { languages, keysByLang } = parseTranslations();
  const usedKeys = findUsedKeys();

  // Reference language (English)
  const refLang = "en";
  const refKeys = keysByLang[refLang] || new Set();

  let hasErrors = false;

  // 3a. Keys used in code but missing from reference language
  console.log("\n═══ i18n Check Report ═══\n");
  console.log(`Languages: ${languages.join(", ")} (${languages.length})`);
  console.log(`Reference keys (${refLang}): ${refKeys.size}`);
  console.log(`Keys used in code: ${usedKeys.size}\n`);

  const missingFromRef = [...usedKeys]
    .filter((k) => !refKeys.has(k))
    // Filter out template literal patterns (${...}) — these are dynamic keys
    .filter((k) => !k.includes("${"))
    .sort();
  if (missingFromRef.length > 0) {
    hasErrors = true;
    console.log(`❌ ${missingFromRef.length} keys used in code but MISSING from ${refLang}:`);
    missingFromRef.forEach((k) => console.log(`   - "${k}"`));
    console.log();
  } else {
    console.log(`✅ All keys used in code exist in ${refLang}\n`);
  }

  // 3b. Orphan keys (in translations but never used in code)
  const orphans = [...refKeys].filter((k) => !usedKeys.has(k)).sort();
  if (orphans.length > 0) {
    console.log(`⚠️  ${orphans.length} keys defined in ${refLang} but NEVER used in code (potential orphans):`);
    if (orphans.length <= 20) {
      orphans.forEach((k) => console.log(`   - "${k}"`));
    } else {
      orphans.slice(0, 20).forEach((k) => console.log(`   - "${k}"`));
      console.log(`   ... and ${orphans.length - 20} more`);
    }
    console.log();
  } else {
    console.log(`✅ No orphan keys\n`);
  }

  // 3c. Incomplete translations (keys in ref but missing in other languages)
  console.log("── Per-language completeness ──\n");
  for (const lang of languages) {
    if (lang === refLang) continue;
    const langKeys = keysByLang[lang] || new Set();
    const missing = [...refKeys].filter((k) => !langKeys.has(k));
    const extra = [...langKeys].filter((k) => !refKeys.has(k));

    if (missing.length === 0 && extra.length === 0) {
      console.log(`  ✅ ${lang}: ${langKeys.size} keys — complete`);
    } else {
      if (missing.length > 0) {
        hasErrors = true;
        console.log(`  ❌ ${lang}: ${langKeys.size} keys — ${missing.length} MISSING vs ${refLang}`);
        missing.slice(0, 5).forEach((k) => console.log(`      missing: "${k}"`));
        if (missing.length > 5) console.log(`      ... and ${missing.length - 5} more`);
      }
      if (extra.length > 0) {
        console.log(`  ⚠️  ${lang}: ${extra.length} EXTRA keys not in ${refLang}`);
      }
    }
  }

  console.log("\n═══════════════════════\n");

  if (hasErrors) {
    console.log("❌ i18n check found issues. Fix them before merging.\n");
    process.exit(1);
  } else {
    console.log("✅ i18n check passed.\n");
    process.exit(0);
  }
}

analyze();
