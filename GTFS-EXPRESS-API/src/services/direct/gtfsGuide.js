/**
 * direct/gtfsGuide — the GTFS knowledge the direct mode's models work with (gtfsGuide.md): what the feed's tables
 * mean, the pitfalls a change falls into, how a change is written in this engine and how a demand is measured. Each
 * section of the file says who reads it (`<!-- agent reviewer -->` under its heading): the agent gets every section,
 * the reviewer the ones about reading and measuring a feed — what it needs to prove a demand, never how a change is
 * written, so that its reading stays its own.
 *
 *   guideFor(role)  → the guide's text for "agent" or "reviewer" (read once, then kept)
 *   sectionsOf(md)  → [{ title, roles, text }]
 *
 * The guide names only tables and columns of this database (a test holds every `table.column` it cites to the
 * schema) and only validator rules of the catalogue it runs.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROLES = ["agent", "reviewer"];

/** The file's sections: the text before the first heading is the preamble every role reads. */
const sectionsOf = (md) => {
  const out = [];
  let current = { title: null, roles: ROLES, lines: [] };
  for (const line of String(md).replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      out.push(current);
      current = { title: heading[1].trim(), roles: null, lines: [line] };
      continue;
    }
    const tag = /^<!--\s*([a-z ]+?)\s*-->$/.exec(line.trim());
    if (tag && current.roles === null) {
      current.roles = tag[1].split(/\s+/).filter((r) => ROLES.includes(r));
      continue;
    }
    current.lines.push(line);
  }
  out.push(current);
  return out.map((s) => ({ title: s.title, roles: s.roles || ROLES, text: s.lines.join("\n").trim() })).filter((s) => s.text);
};

const cache = new Map();
const guideFor = (role) => {
  if (!ROLES.includes(role)) throw new Error(`unknown role: ${role}`);
  if (!cache.has(role)) {
    const md = fs.readFileSync(path.join(__dirname, "gtfsGuide.md"), "utf8");
    cache.set(role, sectionsOf(md).filter((s) => s.roles.includes(role)).map((s) => s.text).join("\n\n"));
  }
  return cache.get(role);
};

module.exports = { guideFor, sectionsOf, ROLES };
