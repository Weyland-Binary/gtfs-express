#!/usr/bin/env node
/**
 * i18n-check.js — Permanent guard-rail for translations.js consistency.
 *
 * Verifies four invariants on the 8 language blocks of
 * GTFS-EXPRESS-WEB/src/i18n/translations.js :
 *
 *   1. Same key count in every language (no drift).
 *   2. Same key SET (no language-specific orphan).
 *   3. No duplicate key within a language.
 *   4. No `t("key")` call in source code references a key absent from
 *      every language (= UX bug : raw key shown to the user).
 *
 * Exit codes:
 *   0 — all invariants hold
 *   1 — at least one invariant violated (details printed to stderr)
 *
 * Usage:
 *   node scripts/i18n-check.js                          # default paths
 *   node scripts/i18n-check.js --json                   # machine-readable
 *   node scripts/i18n-check.js --root ./custom/path     # alt repo root
 *
 * Wired into:
 *   - `npm run i18n:check` (frontend package.json)
 *   - `scripts/refresh-facts.sh --check` (CI sanity)
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const rootIdx = args.indexOf("--root");
const ROOT =
  rootIdx >= 0
    ? path.resolve(args[rootIdx + 1])
    : path.resolve(__dirname, "..");

const TRANS_PATH = path.join(
  ROOT,
  "GTFS-EXPRESS-WEB",
  "src",
  "i18n",
  "translations.js",
);
const SRC_DIR = path.join(ROOT, "GTFS-EXPRESS-WEB", "src");

const LANGS = ["en", "fr", "es", "de", "pt", "zh", "ar", "hi"];

// ── Helpers ───────────────────────────────────────────────────────────────

const fail = (msg) => {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: false, error: msg }) + "\n");
  } else {
    process.stderr.write(`✗ ${msg}\n`);
  }
  process.exit(1);
};

const success = (payload) => {
  if (jsonMode) {
    process.stdout.write(JSON.stringify({ ok: true, ...payload }) + "\n");
  } else {
    process.stdout.write(
      `✓ i18n check OK — ${payload.langCount} languages × ${payload.keyCount} keys (= ${payload.totalEntries} entries), 0 duplicate, 0 missing in code\n`,
    );
  }
  process.exit(0);
};

const extractBlock = (src, lang) => {
  const startRe = new RegExp(`^  ${lang}: \\{`, "m");
  const m = startRe.exec(src);
  if (!m) throw new Error(`Language block "${lang}" not found in translations.js`);
  const closeRe = /\r?\n  \},\r?\n/;
  const tail = src.slice(m.index);
  const close = closeRe.exec(tail);
  if (!close) throw new Error(`Language block "${lang}" not properly closed`);
  return src.slice(m.index, m.index + close.index + close[0].length);
};

const extractKeys = (block) => {
  const re = /^\s+"([^"]+)"\s*:/gm;
  const keys = [];
  let m;
  while ((m = re.exec(block)) !== null) keys.push(m[1]);
  return keys;
};

const findCodeReferences = (dir) => {
  const refs = new Set();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      if (entry.name === "i18n") continue; // skip translations.js
      const fp = path.join(d, entry.name);
      if (entry.isDirectory()) walk(fp);
      else if (/\.(js|jsx|ts|tsx)$/.test(entry.name)) {
        const content = fs.readFileSync(fp, "utf8");
        const re = /\bt\(\s*["'`]([^"'`]+)["'`]/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          // Skip dynamic template-literal keys (contain ${}) — they resolve at
          // runtime from a static set already captured in the literal calls.
          if (m[1].includes("${")) continue;
          refs.add(m[1]);
        }
      }
    }
  };
  walk(dir);
  return refs;
};

// ── Main ──────────────────────────────────────────────────────────────────

if (!fs.existsSync(TRANS_PATH)) {
  fail(`translations.js not found at ${TRANS_PATH}`);
}

const raw = fs.readFileSync(TRANS_PATH, "utf8");
const blocks = {};
const keysByLang = {};

try {
  for (const lang of LANGS) {
    blocks[lang] = extractBlock(raw, lang);
    keysByLang[lang] = extractKeys(blocks[lang]);
  }
} catch (err) {
  fail(`Parse error: ${err.message}`);
}

// Invariant 1+2: key set must be identical across all 8 langs
const referenceSet = new Set(keysByLang[LANGS[0]]);
const referenceCount = referenceSet.size;
const violations = [];

for (const lang of LANGS) {
  const set = new Set(keysByLang[lang]);
  if (set.size !== referenceCount) {
    violations.push({
      type: "count_mismatch",
      lang,
      expected: referenceCount,
      actual: set.size,
    });
  }
  // Per-language: missing vs reference, extra vs reference
  const missing = [...referenceSet].filter((k) => !set.has(k));
  const extra = [...set].filter((k) => !referenceSet.has(k));
  if (missing.length > 0) {
    violations.push({
      type: "missing_keys",
      lang,
      sample: missing.slice(0, 10),
      total: missing.length,
    });
  }
  if (extra.length > 0) {
    violations.push({
      type: "extra_keys",
      lang,
      sample: extra.slice(0, 10),
      total: extra.length,
    });
  }
}

// Invariant 3: no duplicates within a language block
for (const lang of LANGS) {
  const seen = new Map();
  for (const k of keysByLang[lang]) seen.set(k, (seen.get(k) || 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  if (dupes.length > 0) {
    violations.push({
      type: "duplicate_keys",
      lang,
      duplicates: dupes.map(([k, n]) => ({ key: k, count: n })),
    });
  }
}

// Invariant 4: no t("key") in source code without a translation
const codeRefs = findCodeReferences(SRC_DIR);
const missingFromTranslations = [...codeRefs].filter(
  (k) => !referenceSet.has(k),
);
if (missingFromTranslations.length > 0) {
  violations.push({
    type: "code_references_without_translation",
    sample: missingFromTranslations.slice(0, 20),
    total: missingFromTranslations.length,
  });
}

// ── Report ────────────────────────────────────────────────────────────────

if (violations.length > 0) {
  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({ ok: false, violations }, null, 2) + "\n",
    );
  } else {
    process.stderr.write("✗ i18n check FAILED\n\n");
    for (const v of violations) {
      switch (v.type) {
        case "count_mismatch":
          process.stderr.write(
            `  [${v.lang}] count mismatch: expected ${v.expected}, got ${v.actual}\n`,
          );
          break;
        case "missing_keys":
          process.stderr.write(
            `  [${v.lang}] ${v.total} key(s) missing — sample: ${v.sample.join(", ")}${v.total > 10 ? "…" : ""}\n`,
          );
          break;
        case "extra_keys":
          process.stderr.write(
            `  [${v.lang}] ${v.total} extra key(s) (not in reference) — sample: ${v.sample.join(", ")}${v.total > 10 ? "…" : ""}\n`,
          );
          break;
        case "duplicate_keys":
          process.stderr.write(
            `  [${v.lang}] ${v.duplicates.length} duplicate(s): ${v.duplicates
              .map((d) => `${d.key} (×${d.count})`)
              .join(", ")}\n`,
          );
          break;
        case "code_references_without_translation":
          process.stderr.write(
            `  [code] ${v.total} t() call(s) reference keys absent from all 8 languages — sample: ${v.sample.slice(0, 5).join(", ")}${v.total > 5 ? "…" : ""}\n`,
          );
          break;
      }
    }
    process.stderr.write(
      "\nFix : run scripts/i18n-audit.js for the full diff matrix, or " +
        "delegate to the i18n-translator agent.\n",
    );
  }
  process.exit(1);
}

success({
  langCount: LANGS.length,
  keyCount: referenceCount,
  totalEntries: LANGS.length * referenceCount,
  codeReferences: codeRefs.size,
});
