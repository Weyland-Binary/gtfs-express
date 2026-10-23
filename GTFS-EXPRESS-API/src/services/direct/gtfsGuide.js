/**
 * The GTFS guide the direct mode's models work with (gtfsGuide.md). Each section says who reads it
 * (`<!-- agent reviewer -->` under its heading): the reviewer gets only the sections on reading and measuring a feed,
 * never how a change is written, so that its reading stays its own.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const ROLES = ["agent", "reviewer"];

/** The text before the first heading is the preamble every role reads. */
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
