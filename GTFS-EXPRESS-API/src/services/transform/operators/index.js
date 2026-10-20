/**
 * operators — the catalogue of deterministic transformations.
 *
 * Every file of this folder (but this one) exports one operator or a list:
 *
 *   {
 *     type: "set_headway",               // the name a change plan uses
 *     title: "Change the frequency",     // for people
 *     category: "service" | "calendar" | "stops" | "routes" | "network" | "fares" | "metadata",
 *     tables: ["trips", "stop_times", …],// the tables it may change (diffed at commit)
 *     params: [{ name, type, required, description, enum? }],  // what an instruction must say
 *     requires_one_of: [["route", "routes"]],  // optional: parameters that stand in for each other, one of each group needed
 *     example: { … },                    // a valid params object
 *     internal: true,                    // optional: executable, never in the catalogue (a model, the form)
 *     resolve(model, params, ctx) → { value, ambiguities: [{ param, code, message, options? }], warnings: [] }
 *                                        (may be async; ctx = { db, router, weekend, lang })
 *     apply(db, value, ctx) → { summary, warnings?, noop?, tables? }   (synchronous; ctx = { model, weekend, lang })
 *   }
 *
 * resolve() turns words into entities of the feed and NEVER guesses: a
 * missing or ambiguous parameter is an ambiguity (the step is blocked and
 * the user answers). It also gathers the facts from outside the feed the
 * change needs (road geometry through ctx.router). apply() is
 * deterministic on the sandbox it receives, inside one transaction.
 *
 * The building blocks: resolve.js (words → entities), gtfsOps.js (services,
 * trips, stop_times, stops), patternOps.js (a new stop sequence with true
 * times and shapes), runtime.js (running times from the feed), geometry.js
 * (shapes), feedModel.js (the feed as read).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { langOf, catalogueWords } = require("../i18n");

const byType = new Map();
for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith(".js") && f !== "index.js").sort()) {
  const mod = require(path.join(__dirname, file));
  for (const op of Array.isArray(mod) ? mod : [mod]) {
    if (!op || !op.type || typeof op.resolve !== "function" || typeof op.apply !== "function") continue;
    if (byType.has(op.type)) throw new Error(`operator ${op.type} is defined twice (${file})`);
    byType.set(op.type, op);
  }
}

const get = (type) => byType.get(String(type || "")) || null;
/**
 * The groups of parameters that stand in for each other, as the catalogue
 * states them (`requires_one_of: [["route", "routes"]]`): one parameter of
 * each group is needed, none of them is marked required on its own (the
 * form would ask for both, a model would think both mandatory). An
 * operation whose group is left empty asks its existing question (« which
 * line? », « until when? », « which direction? », « which days? ») in
 * resolve(), like any missing parameter. Always an array (empty for most).
 */
const oneOf = (o) => (Array.isArray(o.requires_one_of) ? o.requires_one_of.map((g) => [...g]) : []);
/** The catalogue's words for a group, as a model reads it: "route|routes". */
const oneOfText = (o) => oneOf(o).map((g) => g.join("|"));
const names = () => [...byType.keys()].sort();
/**
 * The catalogue as data (for the API, the UI and the model's tool schema).
 * Without `lang`: as the operators state it (a model reads this). With
 * `lang` ("fr", "en"…): title and description in that language, and each
 * parameter with a `label` and its `description` in that language — the
 * Change Studio's words (i18n.catalogueWords), English where a language has
 * none, the parameter's name as the last resort.
 */
// An internal operation (row_changes: a hand retouche, captured by the editors) is executable but never offered.
const catalogue = (lang = null) =>
  [...byType.values()]
    .filter((o) => !o.internal)
    .sort((a, b) => a.type.localeCompare(b.type))
    .map((o) => {
      const base = { type: o.type, title: o.title, category: o.category, params: o.params || [], requires_one_of: oneOf(o), example: o.example || null, description: o.description || null };
      if (lang == null || lang === "") return base;
      const words = langOf(lang) === "en" ? null : catalogueWords(lang, o.type);
      const params = base.params.map((p) => {
        const w = catalogueWords(lang, o.type, p.name);
        return { ...p, label: w?.label || catalogueWords("en", o.type, p.name)?.label || p.name, description: (langOf(lang) !== "en" && w?.description) || p.description };
      });
      return { ...base, title: words?.title || base.title, description: words?.description || base.description, params };
    });

module.exports = { get, names, catalogue, oneOf, oneOfText };
