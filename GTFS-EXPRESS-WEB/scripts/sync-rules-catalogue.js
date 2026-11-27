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

/**
 * What the correction workshop does with each validator rule: its gesture (safe, choice, question, proposal) when one
 * settles it, else the way out its catalogue gives. Read from the API's own modules; the community edition, which has
 * no workshop, gets none and its pages say nothing of one.
 */
const workshopOf = (apiDir) => {
  try {
    const repair = path.join(apiDir, "..", "services", "edit", "repair");
    const { WAYS } = require(path.join(repair, "catalogue.js"));
    const { CHOICES } = require(path.join(repair, "choices.js"));
    const { ASKED } = require(path.join(repair, "bundle.js"));
    const { RULES: STOP_RULES } = require(path.join(repair, "stopPosition.js"));
    const { RULE: TIME_RULE } = require(path.join(repair, "stopTimeOrder.js"));
    const { SAFE_REPAIRS } = require(path.join(apiDir, "quickFixes.js"));
    const gesture = {};
    for (const rule of [...STOP_RULES, TIME_RULE]) gesture[rule] = "proposal";
    for (const choice of Object.values(CHOICES)) for (const rule of choice.rules) gesture[rule] = ASKED.has(choice.id) ? "question" : "choice";
    if (ASKED.has("duplicates")) gesture.duplicate_key = "question";
    for (const rule of SAFE_REPAIRS) gesture[rule] = "safe";
    return { gesture, way: WAYS };
  } catch {
    return null;
  }
};

/**
 * The catalogue as the pages read it: each rule's severity, GTFS section, MobilityData code and text in each language,
 * and what the workshop does of it where its modules can be read (`workshop` says whether they were).
 */
const catalogueOf = (apiDir = API) => {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(apiDir, f), "utf8"));
  const { rules } = read("rules.json");
  const fr = read("locales/fr.json");
  const en = read("locales/en.json");
  const workshop = workshopOf(apiDir);
  const out = {};
  for (const code of Object.keys(rules).sort()) {
    const r = rules[code];
    const notice = r.mobilitydata_match || code;
    const treated = workshop ? { gesture: workshop.gesture[notice] || null, way: workshop.way[notice] || null } : {};
    out[code] = { severity: r.default_severity, section: r.gtfs_section || null, mobilitydata: r.mobilitydata_match || null, fr: fr[code] || null, en: en[code] || r.description || null, ...treated };
  }
  return { rules: out, workshop: Boolean(workshop) };
};

if (require.main === module) {
  const { rules, workshop } = catalogueOf();
  // Written without the workshop's modules, the copy would lose what the pages say the product does of each rule.
  if (!workshop) {
    console.error("the API's modules could not be read (its dependencies are not installed?): nothing written");
    process.exit(1);
  }
  const before = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
  const updated = before.updated && JSON.stringify(before.rules) === JSON.stringify(rules) ? before.updated : new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify({ updated, rules }, null, 2)}\n`);
  console.log(`wrote ${path.relative(WEB, OUT)} (${Object.keys(rules).length} rules, updated ${updated})`);
}

module.exports = { catalogueOf };
