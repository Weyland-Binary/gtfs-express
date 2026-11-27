/**
 * A line's mode as the engine names it, from its GTFS route_type: the specification's types (0 to 12) and the
 * extended types by their family, as the web's utils/routeType.js routeKindOf reads them.
 */

"use strict";

const BASIC = { 0: "tram", 1: "metro", 2: "rail", 3: "bus", 4: "ferry", 5: "cable", 6: "gondola", 7: "funicular", 11: "trolleybus", 12: "monorail" };
// The urban rail range holds the metro and the monorail under their own numbers; the rest of it runs as a metro.
const EXTENDED_EXACT = { 401: "metro", 402: "metro", 405: "monorail" };
// By hundred. A coach and a taxi run on the road as a bus; water and ferry services are ferries; an aerial lift is a
// gondola. Air services and miscellaneous ones have no mode of their own in the engine and stay buses.
const EXTENDED = { 1: "rail", 2: "bus", 3: "rail", 4: "metro", 5: "metro", 6: "metro", 7: "bus", 8: "trolleybus", 9: "tram", 10: "ferry", 11: "bus", 12: "ferry", 13: "gondola", 14: "funicular", 15: "bus", 17: "bus" };

/** The mode of a route_type, "bus" for a number nobody defines; null for an empty or unreadable type. */
const modeOfRouteType = (routeType) => {
  const type = parseInt(String(routeType ?? ""), 10);
  if (!Number.isFinite(type)) return null;
  const mode = type < 100 ? BASIC[type] : EXTENDED_EXACT[type] || EXTENDED[Math.floor(type / 100)];
  return mode || "bus";
};

const TYPE_OF_MODE = Object.fromEntries(Object.entries(BASIC).map(([type, mode]) => [mode, Number(type)]));
// The families whose mode is a type of the specification. Air, taxi and miscellaneous services have none: read as
// buses by the engine for want of a mode, they are no bus to write.
const STANDARD_FAMILIES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 14]);

/** The specification's type for an extended one (102 → 2, 712 → 3), null for any other number or a family without one. */
const standardRouteTypeOf = (routeType) => {
  const type = parseInt(String(routeType ?? ""), 10);
  if (!Number.isFinite(type) || type < 100 || !STANDARD_FAMILIES.has(Math.floor(type / 100))) return null;
  return TYPE_OF_MODE[modeOfRouteType(type)] ?? null;
};

module.exports = { modeOfRouteType, standardRouteTypeOf, BASIC_MODE_OF_TYPE: BASIC };
