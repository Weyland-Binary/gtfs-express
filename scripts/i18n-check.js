#!/usr/bin/env node
/**
 * i18n-check.js — Permanent guard-rail for translations.js consistency.
 *
 * Verifies four invariants on the 7 language blocks of
 * GTFS-EXPRESS-WEB/src/i18n/translations.js :
 *
 *   1. Same key count in every language (no drift).
 *   2. Same key SET (no language-specific orphan).
 *   3. No duplicate key within a language.
 *   4. No `t("key")` call in source code references a key absent from
 *      every language (= UX bug : raw key shown to the user).
 *   5. Every key is read by a source (unusedKeys below): spelled whole, or
 *      composed at run time in a way COMPOSED declares. Run on the lab's
 *      tree only: the community edition lacks the hosted files that read
 *      some keys.
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
// The community edition's stand-ins replace hosted files in the public tree: their keys must stay too.
const STAND_IN_DIR = path.join(ROOT, "edition", "community", "GTFS-EXPRESS-WEB", "src");

const LANGS = ["en", "fr", "es", "de", "pt", "zh", "hi"];

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
      `✓ i18n check OK — ${payload.langCount} languages × ${payload.keyCount} keys (= ${payload.totalEntries} entries), 0 duplicate, 0 missing in code, 0 unread\n`,
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

// ── Invariant 5: the keys some source reads ─────────────────────────────

// How a key is composed at run time, besides being spelled whole. Each rule names the module that composes it.
//   template   `prefix.${x}.suffix` or "prefix." + x in any source: a key that fits is read when what fills each
//              ${x} is spelled somewhere too (a literal, a word of the code, or a literal for each of its dotted
//              parts), so that t(`sqlConsole.${key}`) does not keep every sqlConsole key alive
//   plural     countWords(t, "<key>", n) reads <key>.one and <key>.many (utils/countWords.js)
//   member     t(`${base}.title`) where base is a key prefix spelled whole: home/LearnMore.jsx,
//              home/MobileHome.jsx and vite.seo.js read "<base>.title" and "<base>.text"
//   server     the API's sources are read too: the quick fixes' titleKey and descKey (utils/quickFixes.js) and
//              the catalogue's keys come from the server
const COMPOSED = {
  plural: { suffixes: [".one", ".many"], by: "GTFS-EXPRESS-WEB/src/utils/countWords.js" },
  member: { suffixes: [".title", ".text"], by: "GTFS-EXPRESS-WEB/src/components/home/LearnMore.jsx, vite.seo.js" },
};

// The sources that may read a key: the web (its build scripts and SEO pages included, its tests not), the
// community edition's stand-ins and the API (keys it sends to the web).
const READER_DIRS = [
  { dir: path.join(ROOT, "GTFS-EXPRESS-WEB"), skip: /[/\\](node_modules|dist|__tests__|i18n|\.[^/\\]+)$/ },
  { dir: path.join(ROOT, "edition", "community"), skip: /[/\\](node_modules|\.[^/\\]+)$/ },
  { dir: path.join(ROOT, "GTFS-EXPRESS-API", "src"), skip: /[/\\](node_modules|__tests__)$/ },
];

const readerText = () => {
  const chunks = [];
  const walk = (d, skip) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, entry.name);
      if (skip.test(fp)) continue;
      if (entry.isDirectory()) walk(fp, skip);
      else if (/\.(js|jsx|mjs|cjs|json)$/.test(entry.name)) chunks.push(fs.readFileSync(fp, "utf8"));
    }
  };
  for (const { dir, skip } of READER_DIRS) walk(dir, skip);
  return chunks.join("\n");
};

const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The keys of `keys` no reader source reads, by COMPOSED's rules. */
const unusedKeys = (keys, text) => {
  const KEY = "[A-Za-z0-9_.\\-]";
  const spelled = new Set([...text.matchAll(new RegExp(`["'\`](${KEY}+)["'\`]`, "g"))].map((m) => m[1]));
  const words = new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []);
  const filled = (part) => spelled.has(part) || (!part.includes(".") && words.has(part)) || part.split(".").every((piece) => spelled.has(piece));
  const composed = [];
  const memberSuffixes = new Set();
  for (const m of text.matchAll(new RegExp(`\`(${KEY}*(?:\\$\\{[^{}\`]*\\}${KEY}*)+)\``, "g"))) {
    const parts = m[1].split(/\$\{[^{}`]*\}/);
    if (parts[0].includes(".")) composed.push(new RegExp(`^${parts.map(escapeRe).join("(.+)")}$`));
    else if (parts[0] === "" && parts.length === 2 && COMPOSED.member.suffixes.includes(parts[1])) memberSuffixes.add(parts[1]);
  }
  for (const m of text.matchAll(/["']([A-Za-z0-9_-]+\.[A-Za-z0-9_.-]*\.)["']\s*\+/g)) composed.push(new RegExp(`^${escapeRe(m[1])}(.+)$`));
  const read = (key) => {
    if (spelled.has(key)) return true;
    if (composed.some((re) => { const m = re.exec(key); return m && m.slice(1).every(filled); })) return true;
    const cut = key.lastIndexOf(".");
    return cut > 0 && memberSuffixes.has(key.slice(cut)) && spelled.has(key.slice(0, cut));
  };
  return keys.filter((key) => {
    if (read(key)) return false;
    const plural = COMPOSED.plural.suffixes.find((suffix) => key.endsWith(suffix));
    return !(plural && read(key.slice(0, -plural.length)));
  });
};

/** Whether the hosted edition's files are here: the community edition's tree has some keys' readers left out. */
const hostedFilesPresent = () => {
  const list = path.join(ROOT, "edition", "hosted-only.json");
  if (!fs.existsSync(list)) return false;
  const { hosted = [] } = JSON.parse(fs.readFileSync(list, "utf8"));
  return hosted.length > 0 && hosted.every((p) => fs.existsSync(path.join(ROOT, p)));
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

// Invariant 1+2: key set must be identical across all the languages
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
if (fs.existsSync(STAND_IN_DIR)) for (const key of findCodeReferences(STAND_IN_DIR)) codeRefs.add(key);
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

// Invariant 5: no key that no source reads
if (hostedFilesPresent()) {
  const unused = unusedKeys([...referenceSet], readerText());
  if (unused.length > 0) {
    violations.push({ type: "unused_keys", sample: unused.slice(0, 20), total: unused.length, keys: unused });
  }
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
            `  [code] ${v.total} t() call(s) reference keys absent from all ${LANGS.length} languages — sample: ${v.sample.slice(0, 5).join(", ")}${v.total > 5 ? "…" : ""}\n`,
          );
          break;
        case "unused_keys":
          process.stderr.write(
            `  [code] ${v.total} key(s) no source reads (remove them, or declare how they are composed in COMPOSED) — ${v.sample.join(", ")}${v.total > 20 ? "…" : ""}\n`,
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
