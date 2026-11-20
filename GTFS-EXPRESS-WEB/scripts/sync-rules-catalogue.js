#!/usr/bin/env node
/**
 * sync-rules-catalogue.js — the validation rules the public pages list (seo/rules-catalogue.json), copied from the
 * API's catalogue (GTFS-EXPRESS-API/src/utils/rules.json, its French and English texts in utils/locales). The web's
 * image is built from its own folder, so the build cannot read the API's files: run this after a change of the
 * catalogue (seoContent.test.js fails while the copy is stale). `updated`, the date of the rule pages built from the
 * catalogue, moves only when a rule changes.
 *
 *   node scripts/sync-rules-catalogue.js           (from GTFS-EXPRESS-WEB)
 */

"use strict";

const fs = require("fs");
const path = require("path");

const WEB = path.resolve(__dirname, "..");
const API = path.join(WEB, "..", "GTFS-EXPRESS-API", "src", "utils");
const OUT = path.join(WEB, "seo", "rules-catalogue.json");

/** The catalogue as the pages read it: each rule's severity, GTFS section, MobilityData code and text in each language. */
const catalogueOf = (apiDir = API) => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(apiDir, f), "utf8"));
  const { rules } = read("rules.json");
  const fr = read("locales/fr.json");
  const en = read("locales/en.json");
  const out = {};
  for (const code of Object.keys(rules).sort()) {
    const r = rules[code];
    out[code] = { severity: r.default_severity, section: r.gtfs_section || null, mobilitydata: r.mobilitydata_match || null, fr: fr[code] || null, en: en[code] || r.description || null };
  }
  return { rules: out };
};

if (require.main === module) {
  const { rules } = catalogueOf();
  const before = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  const updated = before.updated && JSON.stringify(before.rules) === JSON.stringify(rules) ? before.updated : new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({ updated, rules }, null, 2)}\n`);
  console.log(`wrote ${path.relative(WEB, OUT)} (${Object.keys(rules).length} rules, updated ${updated})`);
}

module.exports = { catalogueOf };
