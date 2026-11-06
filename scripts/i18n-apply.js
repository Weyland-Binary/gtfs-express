#!/usr/bin/env node
/**
 * i18n-apply.js — merge translation patches into translations.js.
 *
 * A patch is a JSON file mapping each key to its text in the 7 languages:
 *
 *   { "network.example": { "en": "…", "fr": "…", "es": "…", "de": "…",
 *                          "pt": "…", "zh": "…", "hi": "…" } }
 *
 * Every key of every patch is upserted into the 7 language blocks of
 * GTFS-EXPRESS-WEB/src/i18n/translations.js: an existing key gets the new
 * text (in place, whether its value sits on the key's line or the next
 * one), a new key is appended at the end of its language block. The run is
 * idempotent; a patch missing a language is refused, so the blocks never
 * drift (scripts/i18n-check.js stays green).
 *
 * Usage:
 *   node scripts/i18n-apply.js patch.json [more.json …]
 *   node scripts/i18n-apply.js --dir GTFS-EXPRESS-WEB/i18n-pending
 *   node scripts/i18n-apply.js --check patch.json   # validate, write nothing
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TRANS_PATH = path.join(ROOT, "GTFS-EXPRESS-WEB", "src", "i18n", "translations.js");
const LANGS = ["en", "fr", "es", "de", "pt", "zh", "hi"];

const die = (msg) => {
  process.stderr.write(`✗ ${msg}\n`);
  process.exit(1);
};

// ── Patches ────────────────────────────────────────────────────────────────

const readPatches = (files) => {
  const merged = new Map();
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (err) {
      die(`${file}: ${err.message}`);
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) die(`${file}: a patch is an object { key: { en, fr, … } }`);
    for (const [key, texts] of Object.entries(data)) {
      if (!/^[A-Za-z0-9_.\-]+$/.test(key)) die(`${file}: invalid key "${key}"`);
      if (!texts || typeof texts !== "object") die(`${file}: "${key}" must map languages to texts`);
      const missing = LANGS.filter((l) => typeof texts[l] !== "string" || !texts[l].length);
      if (missing.length) die(`${file}: "${key}" has no text for ${missing.join(", ")}`);
      const extra = Object.keys(texts).filter((l) => !LANGS.includes(l));
      if (extra.length) die(`${file}: "${key}" has unknown languages ${extra.join(", ")}`);
      merged.set(key, texts);
    }
  }
  return merged;
};

// ── translations.js surgery ────────────────────────────────────────────────

/** [start, end) of a language block's body (after "  xx: {\n", before "  },\n"). */
const blockBounds = (src, lang) => {
  const start = new RegExp(`^  ${lang}: \\{\\r?\\n`, "m").exec(src);
  if (!start) die(`language block "${lang}" not found`);
  const bodyStart = start.index + start[0].length;
  const close = /^  \},\r?$/m;
  close.lastIndex = 0;
  const rest = src.slice(bodyStart);
  const m = close.exec(rest);
  if (!m) die(`language block "${lang}" is not closed`);
  return [bodyStart, bodyStart + m.index];
};

/** End index (exclusive) of the JS string literal starting at `i` (a quote). */
const stringEnd = (src, i) => {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "`") return -1;
  for (let k = i + 1; k < src.length; k++) {
    if (src[k] === "\\") {
      k += 1;
      continue;
    }
    if (src[k] === q) return k + 1;
  }
  return -1;
};

const literal = (text) => JSON.stringify(text);

const upsertInBlock = (body, key, text) => {
  const keyRe = new RegExp(`^(\\s+)"${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`, "m");
  const m = keyRe.exec(body);
  if (!m) {
    const sep = body.length && !body.endsWith("\n") ? "\n" : "";
    return { body: `${body}${sep}    "${key}": ${literal(text)},\n`, action: "added" };
  }
  let i = m.index + m[0].length;
  while (i < body.length && /\s/.test(body[i])) i += 1;
  const end = stringEnd(body, i);
  if (end < 0) die(`cannot read the value of "${key}"`);
  // A value built by concatenation ("a" + "b") is replaced whole, up to the comma.
  let stop = end;
  const tail = /^\s*\+\s*/;
  while (tail.test(body.slice(stop))) {
    const t = tail.exec(body.slice(stop));
    const next = stop + t[0].length;
    const e = stringEnd(body, next);
    if (e < 0) break;
    stop = e;
  }
  const current = body.slice(i, stop);
  if (current === literal(text)) return { body, action: "same" };
  return { body: `${body.slice(0, m.index)}${m[1]}"${key}": ${literal(text)}${body.slice(stop)}`, action: "updated" };
};

// ── Main ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
let files = args.filter((a) => a !== "--check" && a !== "--dir");
const dirIdx = args.indexOf("--dir");
if (dirIdx >= 0) {
  const dir = path.resolve(args[dirIdx + 1] || "");
  files = files.filter((f) => path.resolve(f) !== dir);
  if (!fs.existsSync(dir)) die(`${dir} does not exist`);
  files.push(...fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f)));
}
if (!files.length) die("no patch given (files, or --dir <folder>)");

const patches = readPatches(files);
if (checkOnly) {
  process.stdout.write(`✓ ${patches.size} key(s) in ${files.length} patch(es), all ${LANGS.length} languages present\n`);
  process.exit(0);
}

let src = fs.readFileSync(TRANS_PATH, "utf8");
const counts = { added: 0, updated: 0, same: 0 };
for (const lang of LANGS) {
  const [a, b] = blockBounds(src, lang);
  let body = src.slice(a, b);
  for (const [key, texts] of patches) {
    const r = upsertInBlock(body, key, texts[lang]);
    body = r.body;
    counts[r.action] += 1;
  }
  src = `${src.slice(0, a)}${body}${src.slice(b)}`;
}
fs.writeFileSync(TRANS_PATH, src, "utf8");
process.stdout.write(`✓ ${patches.size} key(s) × ${LANGS.length} languages: ${counts.added} added, ${counts.updated} updated, ${counts.same} unchanged\n`);
