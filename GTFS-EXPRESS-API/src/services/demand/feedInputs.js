/**
 * The demand inputs of a loaded feed: a minimal territory drawn from its served stops, so the official
 * providers (France) still apply; without residents from them, the stop-based proxy, keeping whatever jobs
 * and students they found.
 */

"use strict";

const MARGIN_M = 800; // walking distance around the outermost stops

const defaultDeps = {
  buildDemandInputs: (opts) => require("./inputs").buildDemandInputs(opts),
};

/** The network's name: its (first) agency, else feed_info's publisher (which may be an aggregator). */
const feedNameOf = (model, db = null) => {
  try {
    const a = db && db.prepare("SELECT agency_name FROM agency WHERE agency_name IS NOT NULL AND agency_name <> '' LIMIT 1").get();
    if (a?.agency_name) return String(a.agency_name);
  } catch {
    /* no agency table */
  }
  const fromInfo = model?.feedInfo?.feed_publisher_name;
  return fromInfo ? String(fromInfo) : "network";
};

/**
 * The country of a feed whose session does not know it, from its agency's time zone when that zone belongs to
 * one country only; any other answers null, never a guess.
 */
const TZ_COUNTRY = {
  "Europe/Paris": "fr",
  "America/Guadeloupe": "fr",
  "America/Martinique": "fr",
  "America/Cayenne": "fr",
  "Indian/Reunion": "fr",
  "Indian/Mayotte": "fr",
  "Europe/Brussels": "be",
  "Europe/Luxembourg": "lu",
  "Europe/Zurich": "ch",
  "Europe/Monaco": "mc",
  "Europe/Andorra": "ad",
};
const countryOfFeed = (db) => {
  try {
    const rows = db.prepare("SELECT DISTINCT agency_timezone AS tz FROM agency WHERE agency_timezone IS NOT NULL AND agency_timezone <> ''").all();
    const found = [...new Set(rows.map((r) => TZ_COUNTRY[String(r.tz).trim()]).filter(Boolean))];
    return found.length === 1 ? found[0] : null;
  } catch {
    return null; // no agency table
  }
};

/** A dossier standing for the area the feed serves (no public data of its own). */
const territoryFromFeed = (model, { countryCode = null, name = "network" } = {}) => {
  const served = new Set([...model.patterns.values()].flatMap((p) => p.stops));
  const pts = [...model.stops.values()].filter((s) => served.has(s.id) && Number.isFinite(s.lat) && Number.isFinite(s.lon));
  if (!pts.length) return null;
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  const dLat = MARGIN_M / 111320;
  const dLon = MARGIN_M / (111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const bbox = [Math.min(...pts.map((p) => p.lat)) - dLat, Math.min(...pts.map((p) => p.lon)) - dLon, Math.max(...pts.map((p) => p.lat)) + dLat, Math.max(...pts.map((p) => p.lon)) + dLon].map((v) => Number(v.toFixed(5)));
  const cc = countryCode ? String(countryCode).toUpperCase() : null;
  return {
    place: { query: `feed:${name}:${bbox.join(",")}`, name, display_name: name, country_code: cc, lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), bbox },
    timezone: null,
    population: null,
    population_grid: null,
    existing_stops: [],
    existing_lines: [],
    pois: { categories: {}, items: [] },
    works: { counts: {}, items: [] },
    holidays: [],
    school_holidays: [],
    sources: [],
    warnings: [],
    partial: false,
    from_feed: true,
  };
};

const hasResidents = (inputs) => (inputs?.cells || []).some((c) => c.pop > 0);

/** The inputs of a feed: its own territory upgraded by the providers, else the stop-based proxy. */
const inputsForFeed = async (model, { countryCode = null, name = "network", deps = {} } = {}) => {
  const d = { ...defaultDeps, ...deps };
  const { stopProxyInputs } = require("./assignment");
  const territory = territoryFromFeed(model, { countryCode, name });
  let base = null;
  if (territory) {
    try {
      base = await d.buildDemandInputs({ territory, countryCode: territory.place.country_code });
    } catch (err) {
      if (err?.status === 499) throw err; // aborted by the caller
      base = { cells: [], generators: [], od: [], observed: null, totals: { pop: 0, jobs: 0, students: 0 }, sources: [], quality: {}, warnings: [`official data: unavailable for the feed's area (${String(err?.message || err).slice(0, 160)})`] };
    }
  }
  if (hasResidents(base)) return { inputs: base, territory, source: "feed_territory" };
  return { inputs: stopProxyInputs(model, base), territory, source: "stop_proxy" };
};

module.exports = { inputsForFeed, territoryFromFeed, feedNameOf, countryOfFeed, _internals: { MARGIN_M, defaultDeps, TZ_COUNTRY } };
