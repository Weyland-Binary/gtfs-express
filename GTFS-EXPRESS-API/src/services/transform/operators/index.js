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
 *     example: { … },                    // a valid params object
 *     resolve(model, params, ctx) → { value, ambiguities: [{ param, code, message, options? }], warnings: [] }
 *     apply(db, value, ctx) → { summary, warnings?, noop?, tables? }
 *   }
 *
 * resolve() turns words into entities of the feed and NEVER guesses: a
 * missing or ambiguous parameter is an ambiguity (the step is blocked and
 * the user answers). apply() is deterministic on the sandbox it receives.
 */

"use strict";

const fs = require("fs");
const path = require("path");

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
const names = () => [...byType.keys()].sort();
/** The catalogue as data (for the API, the UI and the model's tool schema). */
const catalogue = () => [...byType.values()].sort((a, b) => a.type.localeCompare(b.type)).map((o) => ({ type: o.type, title: o.title, category: o.category, params: o.params || [], example: o.example || null, description: o.description || null }));

module.exports = { get, names, catalogue };
