/**
 * The one search of a feed (the palette, the pickers): stops, lines, trips and shapes whose name, code, number or
 * id holds the text typed, compared folded (utils/searchText: case and accents dropped), an exact answer before one
 * that starts with the text and before one that only holds it.
 */

"use strict";

const { foldText } = require("../utils/searchText");

const LIMIT = 8;
const EMPTY = Object.freeze({ stops: [], routes: [], trips: [], shapes: [] });

// SQLite's LIKE and LOWER fold ASCII only, so a value holding anything else (more bytes than characters) is folded
// by search_fold; a value of plain ASCII, most ids and codes, never leaves SQLite.
const folded = (column) => `CASE WHEN LENGTH(CAST(${column} AS BLOB)) <> LENGTH(${column}) THEN search_fold(${column}) ELSE ${column} END`;
const holds = (column) => `${folded(column)} LIKE :contains ESCAPE '\\'`;
const rankOf = (column) =>
  `CASE WHEN ${folded(column)} LIKE :exact ESCAPE '\\' THEN 0 WHEN ${folded(column)} LIKE :prefix ESCAPE '\\' THEN 1 WHEN ${holds(column)} THEN 2 ELSE 3 END`;
const bestRank = (columns) => (columns.length === 1 ? rankOf(columns[0]) : `MIN(${columns.map(rankOf).join(", ")})`);

/** The rows of `table` one of whose `fields` holds the text, the best first, the shortest label first among equals. */
const ranked = ({ table, select, fields, label }) =>
  `SELECT ${select} FROM ${table} WHERE ${fields.map(holds).join(" OR ")} ORDER BY ${bestRank(fields)}, LENGTH(${label}), ${label} LIMIT ${LIMIT}`;

const STOPS = ranked({ table: "stops", select: "stop_id, stop_name, stop_code", fields: ["stop_name", "stop_code", "stop_id"], label: "COALESCE(stop_name, stop_id)" });
const ROUTES = ranked({
  table: "routes",
  select: "route_id, route_short_name, route_long_name, route_color",
  fields: ["route_short_name", "route_long_name", "route_id"],
  label: "COALESCE(route_short_name, route_long_name, route_id)",
});
const TRIPS = ranked({ table: "trips", select: "trip_id, route_id, trip_headsign, trip_short_name, direction_id", fields: ["trip_short_name", "trip_headsign", "trip_id"], label: "trip_id" });
// One character names a line by its number: the lines of that number, then those whose number starts with it.
const ROUTES_BY_NUMBER = `SELECT route_id, route_short_name, route_long_name, route_color FROM routes
  WHERE ${folded("route_short_name")} LIKE :prefix ESCAPE '\\'
  ORDER BY ${rankOf("route_short_name")}, LENGTH(route_short_name), route_short_name LIMIT ${LIMIT}`;
// Each shape id once, by one seek of the primary key per id: a DISTINCT reads every point of every shape.
const SHAPES = `WITH RECURSIVE ids(shape_id) AS (
    SELECT MIN(shape_id) FROM shapes
    UNION ALL
    SELECT (SELECT MIN(shape_id) FROM shapes WHERE shape_id > ids.shape_id) FROM ids WHERE ids.shape_id IS NOT NULL
  )
  SELECT shape_id FROM ids WHERE shape_id IS NOT NULL AND ${holds("shape_id")}
  ORDER BY ${rankOf("shape_id")}, LENGTH(shape_id), shape_id LIMIT ${LIMIT}`;

// Names repeat (a headsign on a thousand trips): each is folded once.
const MAX_KEPT = 20000;
const kept = new Map();
const searchFold = (value) => {
  if (value == null) return null;
  let text = kept.get(value);
  if (text === undefined) {
    if (kept.size >= MAX_KEPT) kept.clear();
    text = foldText(value);
    kept.set(value, text);
  }
  return text;
};

// A function belongs to its connection: the working copy's, a draft's, a lens's each learn it once.
const taught = new WeakSet();
const teach = (db) => {
  if (taught.has(db)) return;
  db.function("search_fold", { deterministic: true }, searchFold);
  taught.add(db);
};

const escapeLike = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** → { stops, routes, trips, shapes }, at most eight each; a single character answers lines alone. */
const searchFeed = (db, typed) => {
  const text = foldText(typed).trim();
  if (!text) return { ...EMPTY };
  teach(db);
  const pattern = escapeLike(text);
  const like = { exact: pattern, prefix: `${pattern}%`, contains: `%${pattern}%` };
  if ([...text].length < 2) return { ...EMPTY, routes: db.prepare(ROUTES_BY_NUMBER).all({ prefix: like.prefix, exact: like.exact, contains: like.contains }) };

  const stops = db.prepare(STOPS).all(like);
  const routes = db.prepare(ROUTES).all(like);
  const trips = db.prepare(TRIPS).all(like);

  // Each shape takes its line, agency and direction from the first trip that runs it.
  const tripOfShape = db.prepare("SELECT trip_id, route_id, direction_id FROM trips WHERE shape_id = ? LIMIT 1");
  const agencyOfRoute = db.prepare("SELECT agency_id FROM routes WHERE route_id = ?");
  const pointsOfShape = db.prepare("SELECT COUNT(*) AS n FROM shapes WHERE shape_id = ?");
  const shapes = db
    .prepare(SHAPES)
    .all(like)
    .map(({ shape_id }) => {
      const trip = tripOfShape.get(shape_id) || null;
      const routeId = trip?.route_id || null;
      return {
        shape_id,
        point_count: pointsOfShape.get(shape_id)?.n || 0,
        route_id: routeId,
        agency_id: routeId ? (agencyOfRoute.get(routeId)?.agency_id ?? null) : null,
        direction_id: trip ? (trip.direction_id ?? null) : null,
      };
    });

  return { stops, routes, trips, shapes };
};

module.exports = { searchFeed };
