/**
 * What a GTFS route_type is: the specification's types (0 to 12) and the extended types, read by their hundred.
 */

const BASIC = { 0: "tram", 1: "metro", 2: "rail", 3: "bus", 4: "ferry", 5: "cableTram", 6: "aerialLift", 7: "funicular", 11: "trolleybus", 12: "monorail" };
const EXTENDED = { 1: "rail", 2: "coach", 3: "rail", 4: "urbanRail", 5: "metro", 6: "metro", 7: "bus", 8: "trolleybus", 9: "tram", 10: "water", 11: "air", 12: "ferry", 13: "aerialLift", 14: "funicular", 15: "taxi", 17: "other" };
// The urban rail range holds the metro and the monorail under their own numbers.
const EXTENDED_EXACT = { 401: "metro", 402: "metro", 405: "monorail" };

const NAME_KEYS = {
  tram: "routeType.tram",
  metro: "routeType.metro",
  rail: "routeType.rail",
  urbanRail: "routeType.urbanRail",
  bus: "routeType.bus",
  coach: "routeType.coach",
  trolleybus: "routeType.trolleybus",
  ferry: "routeType.ferry",
  water: "routeType.water",
  air: "routeType.air",
  cableTram: "routeType.cableTram",
  aerialLift: "routeType.aerialLift",
  funicular: "routeType.funicular",
  monorail: "routeType.monorail",
  taxi: "routeType.taxi",
  other: "routeType.other",
};

export const ROUTE_KINDS = Object.keys(NAME_KEYS);

/** The kind of a route_type ("bus", "metro"…); null for an empty type or a number nobody defines. */
export const routeKindOf = (routeType) => {
  const written = String(routeType ?? "").trim();
  if (!/^\d+$/.test(written)) return null;
  const type = Number(written);
  if (type < 100) return BASIC[type] ?? null;
  return EXTENDED_EXACT[type] ?? EXTENDED[Math.floor(type / 100)] ?? null;
};

/** The type's name in the interface's language: the number itself for a type nobody defines, "" for an empty one. */
export const routeTypeName = (t, routeType) => {
  const written = String(routeType ?? "").trim();
  if (!written) return "";
  const kind = routeKindOf(written);
  return kind ? t(NAME_KEYS[kind]) : t("routeType.number", { type: written });
};
