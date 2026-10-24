/**
 * The catalogue of deterministic operations. Every other file of this folder exports one operator or a list:
 *
 *   {
 *     type, title, category,
 *     tables: [...],                     // the tables it may change (diffed at commit)
 *     params: [{ name, type, required, description, enum? }],
 *     requires_one_of: [["route", "routes"]],  // optional: interchangeable parameters, one of each group needed
 *     example: { … },                    // a valid params object
 *     internal: true,                    // optional: executable, never in the catalogue
 *     resolve(model, params, ctx) → { value, ambiguities: [{ param, code, message, options? }], warnings: [] }
 *                                        (may be async; ctx = { db, router, weekend, lang })
 *     apply(db, value, ctx) → { summary, warnings?, noop?, tables? }   (synchronous; ctx = { model, weekend, lang })
 *   }
 *
 * resolve() turns words into feed entities and never guesses: a missing or ambiguous parameter is an
 * ambiguity the person answers. It also fetches outside facts (road geometry through ctx.router).
 * apply() is deterministic on the sandbox it receives, inside one transaction.
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
 * Interchangeable parameter groups: none is marked required on its own (the form would ask for both,
 * a model would think both mandatory); an empty group is asked in resolve() like any missing parameter.
 */
const oneOf = (o) => (Array.isArray(o.requires_one_of) ? o.requires_one_of.map((g) => [...g]) : []);
/** A group as a model reads it: "route|routes". */
const oneOfText = (o) => oneOf(o).map((g) => g.join("|"));
const names = () => [...byType.keys()].sort();
/**
 * The catalogue as data. Without `lang` as the operators state it (what a model reads); with `lang`,
 * titles, descriptions and parameter labels in that language, falling back to English, then the name.
 * Internal operations (row_changes) are executable but never offered.
 */
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
