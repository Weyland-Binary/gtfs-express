#!/usr/bin/env node
/**
 * Writes bus.lua from OSRM's car.lua: the changes DEPLOYMENT.md § 8 lists (bus-only streets and gates, busways,
 * contraflow bus lanes, a bus's size and weight, no U-turn in the street), each applied to a line the script expects
 * to find, so a car.lua of another version fails here rather than producing a silent car profile.
 *
 *   node derive-bus-profile.js car.lua bus.lua
 */

"use strict";

const fs = require("fs");

const [, , from, to] = process.argv;
if (!from || !to) {
  console.error("usage: derive-bus-profile.js <car.lua> <bus.lua>");
  process.exit(2);
}
let lua = fs.readFileSync(from, "utf8");

const change = (what, pattern, replacement) => {
  const next = lua.replace(pattern, replacement);
  if (next === lua) {
    console.error(`derive-bus-profile: ${what}: pattern not found in ${from}`);
    process.exit(1);
  }
  lua = next;
};

// Buses may use what is open to them: bus=yes, psv=yes, and a bus tag outranks a motor_vehicle ban.
change("access_tag_whitelist", /(access_tag_whitelist\s*=\s*Set\s*\{\s*'yes',)/, "$1 'bus', 'psv',");
change("access_tags_hierarchy", /access_tags_hierarchy\s*=\s*Sequence\s*\{\s*'motorcar',/, "access_tags_hierarchy = Sequence { 'bus', 'psv', 'motorcar',");
change("restrictions", /restrictions\s*=\s*Sequence\s*\{\s*'motorcar',/, "restrictions = Sequence { 'bus', 'psv', 'motorcar',");

// A dedicated bus road is a road.
change("busway speed", /(speeds\s*=\s*Sequence\s*\{\s*highway\s*=\s*\{)/, "$1\n        busway          = 40,");

// A bus is tall, wide, long and heavy: the limits apply.
change("vehicle_height", /vehicle_height\s*=\s*[\d.]+/, "vehicle_height = 3.5");
change("vehicle_width", /vehicle_width\s*=\s*[\d.]+/, "vehicle_width = 2.55");
change("vehicle_length", /vehicle_length\s*=\s*[\d.]+/, "vehicle_length = 12");
change("vehicle_weight", /vehicle_weight\s*=\s*[\d.]+/, "vehicle_weight = 19000");

// A twelve-metre bus rarely turns round in the street.
change("u_turn_penalty", /u_turn_penalty\s*=\s*\d+/, "u_turn_penalty = 60");

// Contraflow bus lanes need no change of their own: the library reads oneway:<restriction> before oneway
// (lib/way_handlers.lua, WayHandlers.oneway), so `restrictions` starting with bus and psv covers oneway:bus=no.

fs.writeFileSync(to, lua);
console.log(`bus.lua written: ${to}`);
