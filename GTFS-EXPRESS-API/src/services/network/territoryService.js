/**
 * territoryService — the territory dossier: what public, worldwide data
 * says about the area a network is designed for.
 *
 *   buildTerritory(query, { fetchImpl }) → {
 *     place, timezone, elevation_m, population,
 *     existing_stops, existing_lines, pois, holidays, school_holidays,
 *     sources, warnings, generatedAt
 *   }
 *
 * Connectors (all public, keyless):
 *   • Nominatim (OpenStreetMap)  — the place: centre, bounding box, country,
 *     wikidata id, population when OSM carries it.
 *   • Overpass (OpenStreetMap)   — existing stops and stations, existing
 *     transit lines (route relations), trip generators (schools, hospitals,
 *     malls, stadiums, universities, town halls, stations, airports…).
 *   • Wikidata SPARQL            — population (P1082) when OSM has none.
 *   • Nager.Date                 — public holidays of the country.
 *   • OpenHolidays API           — school holidays (where covered).
 *   • Open-Meteo                 — timezone and elevation from coordinates.
 *
 * Each connector fails soft: the dossier carries a warning and the rest
 * stands. Results are cached per place for an hour. Every source is listed
 * with its licence so the UI can attribute it (ODbL for OpenStreetMap).
 */

"use strict";

const config = require("../../config");
const { haversineMeters } = require("../../utils/geoUtils");

const TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_STOPS = 800;
const MAX_LINES = 150;
const MAX_POIS = 400;
const MAX_BBOX_SIDE_KM = 30;
const COVERAGE_RADIUS_M = 400;
const REUSE_RADIUS_M = 40;
const USER_AGENT = "gtfs-express/1.0 (network studio; contact via app)";

const _cache = new Map();

const SOURCES = {
  osm: { id: "osm", name: "OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright", license: "ODbL" },
  nominatim: { id: "nominatim", name: "Nominatim (OpenStreetMap)", url: "https://nominatim.org", license: "ODbL" },
  overpass: { id: "overpass", name: "Overpass API (OpenStreetMap)", url: "https://overpass-api.de", license: "ODbL" },
  wikidata: { id: "wikidata", name: "Wikidata", url: "https://www.wikidata.org", license: "CC0" },
  nager: { id: "nager", name: "Nager.Date public holidays", url: "https://date.nager.at", license: "MIT" },
  openholidays: { id: "openholidays", name: "OpenHolidays API", url: "https://www.openholidaysapi.org", license: "CC BY 4.0" },
  openmeteo: { id: "openmeteo", name: "Open-Meteo", url: "https://open-meteo.com", license: "CC BY 4.0" },
};

const POI_CATEGORIES = {
  school: { keys: [["amenity", "school"], ["amenity", "kindergarten"]], weight: 3 },
  college: { keys: [["amenity", "college"], ["amenity", "university"]], weight: 4 },
  hospital: { keys: [["amenity", "hospital"], ["amenity", "clinic"]], weight: 4 },
  civic: { keys: [["amenity", "townhall"], ["amenity", "courthouse"], ["amenity", "library"]], weight: 2 },
  market: { keys: [["amenity", "marketplace"], ["shop", "mall"], ["shop", "supermarket"], ["shop", "department_store"]], weight: 3 },
  station: { keys: [["railway", "station"], ["amenity", "bus_station"], ["amenity", "ferry_terminal"], ["aeroway", "aerodrome"]], weight: 5 },
  leisure: { keys: [["leisure", "stadium"], ["leisure", "sports_centre"], ["tourism", "attraction"], ["tourism", "museum"], ["tourism", "theme_park"], ["tourism", "zoo"]], weight: 2 },
  work: { keys: [["landuse", "industrial"], ["landuse", "commercial"], ["landuse", "retail"], ["office", "*"]], weight: 2 },
};

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const ymd = (iso) => String(iso || "").slice(0, 10).replace(/-/g, "");

const withTimeout = async (fetchImpl, url, init = {}, ms = TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
};

const getJson = async (fetchImpl, url, init) => {
  const res = await withTimeout(fetchImpl, url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// ── Connectors ─────────────────────────────────────────────────────────────

const resolvePlace = async (query, fetchImpl) => {
  const u = new URL(config.NOMINATIM_URL);
  u.pathname = `${u.pathname.replace(/\/$/, "")}/search`;
  u.searchParams.set("q", query);
  u.searchParams.set("format", "jsonv2");
  u.searchParams.set("limit", "1");
  u.searchParams.set("addressdetails", "1");
  u.searchParams.set("extratags", "1");
  const rows = await getJson(fetchImpl, u.toString());
  const r = Array.isArray(rows) ? rows[0] : null;
  if (!r) return null;
  const bb = (r.boundingbox || []).map(Number);
  const lat = num(r.lat);
  const lon = num(r.lon);
  if (lat == null || lon == null) return null;
  let bbox = bb.length === 4 && bb.every(Number.isFinite) ? [bb[0], bb[2], bb[1], bb[3]] : null; // [S, W, N, E]
  // Cap the box: Overpass and the map need a town, not a region.
  const half = MAX_BBOX_SIDE_KM / 2;
  const dLat = half / 111;
  const dLon = half / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  if (!bbox || bbox[2] - bbox[0] > 2 * dLat || bbox[3] - bbox[1] > 2 * dLon) {
    bbox = [Math.max(bbox ? bbox[0] : -90, lat - dLat), Math.max(bbox ? bbox[1] : -180, lon - dLon), Math.min(bbox ? bbox[2] : 90, lat + dLat), Math.min(bbox ? bbox[3] : 180, lon + dLon)];
  }
  return {
    query,
    name: r.name || r.display_name?.split(",")[0] || query,
    display_name: r.display_name || query,
    country_code: (r.address?.country_code || "").toUpperCase() || null,
    country: r.address?.country || null,
    lat,
    lon,
    bbox,
    osm_type: r.osm_type || null,
    osm_id: r.osm_id || null,
    type: r.type || null,
    wikidata: r.extratags?.wikidata || null,
    population_osm: num(r.extratags?.population),
  };
};

const overpass = async (ql, fetchImpl) => {
  const res = await withTimeout(fetchImpl, config.OVERPASS_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `data=${encodeURIComponent(ql)}` }, TIMEOUT_MS + 10000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data?.elements) ? data.elements : [];
};

const bboxStr = (b) => `${b[0]},${b[1]},${b[2]},${b[3]}`;

const STOP_KIND = (tags) => {
  if (tags.railway === "station" || tags.railway === "halt") return "station";
  if (tags.railway === "tram_stop") return "tram_stop";
  if (tags.amenity === "bus_station") return "bus_station";
  if (tags.amenity === "ferry_terminal") return "ferry";
  if (tags.highway === "bus_stop") return "bus_stop";
  if (tags.public_transport === "platform") return tags.bus === "yes" ? "bus_stop" : "platform";
  return "stop";
};

const fetchStops = async (bbox, fetchImpl) => {
  const b = bboxStr(bbox);
  const ql = `[out:json][timeout:25];(node["highway"="bus_stop"](${b});node["public_transport"="platform"](${b});node["railway"~"^(station|halt|tram_stop)$"](${b});node["amenity"~"^(bus_station|ferry_terminal)$"](${b}););out body ${MAX_STOPS};`;
  const elements = await overpass(ql, fetchImpl);
  const seen = new Set();
  const stops = [];
  for (const e of elements) {
    if (e.type !== "node" || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
    const tags = e.tags || {};
    const id = `osm:${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    stops.push({ id, name: tags.name || tags.ref || null, lat: e.lat, lon: e.lon, kind: STOP_KIND(tags), operator: tags.operator || tags.network || null, ref: tags.ref || null, shelter: tags.shelter === "yes" ? true : undefined, wheelchair: tags.wheelchair || undefined });
  }
  return stops;
};

const fetchLines = async (bbox, fetchImpl) => {
  const ql = `[out:json][timeout:25];relation["type"="route"]["route"~"^(bus|tram|subway|light_rail|train|ferry|trolleybus|monorail)$"](${bboxStr(bbox)});out tags ${MAX_LINES};`;
  const elements = await overpass(ql, fetchImpl);
  const lines = [];
  const seen = new Set();
  for (const e of elements) {
    const t = e.tags || {};
    const key = `${t.ref || ""}|${t.name || ""}|${t.route}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push({ id: `osm:${e.id}`, ref: t.ref || null, name: t.name || null, mode: t.route, operator: t.operator || t.network || null, from: t.from || null, to: t.to || null });
  }
  return lines;
};

const fetchPois = async (bbox, fetchImpl) => {
  const b = bboxStr(bbox);
  const parts = [];
  for (const cat of Object.values(POI_CATEGORIES)) {
    for (const [k, v] of cat.keys) parts.push(v === "*" ? `nwr["${k}"](${b});` : `nwr["${k}"="${v}"](${b});`);
  }
  const ql = `[out:json][timeout:25];(${parts.join("")});out center tags ${MAX_POIS * 2};`;
  const elements = await overpass(ql, fetchImpl);
  const counts = {};
  const items = [];
  for (const e of elements) {
    const tags = e.tags || {};
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    let category = null;
    for (const [name, cat] of Object.entries(POI_CATEGORIES)) {
      if (cat.keys.some(([k, v]) => (v === "*" ? Boolean(tags[k]) : tags[k] === v))) {
        category = name;
        break;
      }
    }
    if (!category) continue;
    counts[category] = (counts[category] || 0) + 1;
    if (items.length < MAX_POIS && (tags.name || category === "station")) items.push({ id: `osm:${e.type}/${e.id}`, name: tags.name || category, category, lat, lon, weight: POI_CATEGORIES[category].weight });
  }
  items.sort((a, b) => b.weight - a.weight);
  return { categories: counts, items };
};

// ── Population grid (dasymetric: residents over the residential land) ─────
//
// OpenStreetMap's landuse=residential polygons say where people live; the
// known population of the place (OSM/Wikidata) says how many. Spreading the
// total over the residential area at uniform density gives a 250 m grid
// that is wrong in detail and right in shape — enough to measure "residents
// within 400 m of a stop" and to weigh the demand hubs, worldwide, without
// a raster download. Without a known population, a default density gives an
// estimate flagged as such.

const GRID_CELL_M = 250;
const MAX_GRID_CELLS = 2500;
const MAX_RESIDENTIAL_WAYS = 600;
const DEFAULT_RESIDENTIAL_DENSITY_PER_KM2 = 4000;

const fetchResidential = async (bbox, fetchImpl) => {
  const ql = `[out:json][timeout:25];way["landuse"="residential"](${bboxStr(bbox)});out geom ${MAX_RESIDENTIAL_WAYS};`;
  const elements = await overpass(ql, fetchImpl);
  const polygons = [];
  for (const e of elements) {
    if (e.type !== "way" || !Array.isArray(e.geometry) || e.geometry.length < 4) continue;
    const pts = e.geometry.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (pts.length >= 4) polygons.push(pts);
  }
  return polygons;
};

const polygonAreaM2 = (pts) => {
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 111320;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.lon * kx * (q.lat * ky) - q.lon * kx * (p.lat * ky);
  }
  return Math.abs(a) / 2;
};

const pointInPolygon = (lat, lon, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const yi = pts[i].lat;
    const xi = pts[i].lon;
    const yj = pts[j].lat;
    const xj = pts[j].lon;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Residential polygons + a total → { cell_m, total, estimated, residential_km2, cells: [{lat, lon, pop}] }. */
const populationGrid = (polygons, total, { cellM = GRID_CELL_M } = {}) => {
  if (!polygons.length) return null;
  const areaByCell = new Map();
  const centreOf = new Map();
  let totalArea = 0;
  for (const pts of polygons) {
    const area = polygonAreaM2(pts);
    if (!(area > 0)) continue;
    totalArea += area;
    const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const dLat = cellM / 111320;
    const dLon = cellM / (111320 * Math.cos((lat0 * Math.PI) / 180));
    const minLat = Math.min(...pts.map((p) => p.lat));
    const maxLat = Math.max(...pts.map((p) => p.lat));
    const minLon = Math.min(...pts.map((p) => p.lon));
    const maxLon = Math.max(...pts.map((p) => p.lon));
    const covered = [];
    for (let i = Math.floor(minLat / dLat); i <= Math.ceil(maxLat / dLat); i++) {
      for (let j = Math.floor(minLon / dLon); j <= Math.ceil(maxLon / dLon); j++) {
        const lat = (i + 0.5) * dLat;
        const lon = (j + 0.5) * dLon;
        if (pointInPolygon(lat, lon, pts)) covered.push({ key: `${i}:${j}`, lat, lon });
      }
    }
    if (!covered.length) {
      // Smaller than a cell: all of it goes to the cell of its centroid.
      const lat = lat0;
      const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
      covered.push({ key: `${Math.floor(lat / dLat)}:${Math.floor(lon / dLon)}`, lat: (Math.floor(lat / dLat) + 0.5) * dLat, lon: (Math.floor(lon / dLon) + 0.5) * dLon });
    }
    const share = area / covered.length;
    for (const c of covered) {
      areaByCell.set(c.key, (areaByCell.get(c.key) || 0) + share);
      if (!centreOf.has(c.key)) centreOf.set(c.key, c);
    }
  }
  if (!(totalArea > 0)) return null;
  const estimated = !(total > 0);
  const pop = estimated ? (totalArea / 1e6) * DEFAULT_RESIDENTIAL_DENSITY_PER_KM2 : total;
  const cells = [...areaByCell.entries()].map(([key, area]) => ({ lat: Number(centreOf.get(key).lat.toFixed(5)), lon: Number(centreOf.get(key).lon.toFixed(5)), pop: Math.round((pop * area) / totalArea) })).filter((c) => c.pop >= 1);
  cells.sort((a, b) => b.pop - a.pop);
  return { cell_m: cellM, total: Math.round(pop), estimated, residential_km2: Math.round((totalArea / 1e6) * 100) / 100, cells: cells.slice(0, MAX_GRID_CELLS) };
};

const fetchPopulationWikidata = async (qid, fetchImpl) => {
  if (!qid || !/^Q\d+$/.test(qid)) return null;
  const query = `SELECT ?pop WHERE { wd:${qid} wdt:P1082 ?pop } LIMIT 1`;
  const data = await getJson(fetchImpl, `${config.WIKIDATA_SPARQL_URL}?format=json&query=${encodeURIComponent(query)}`);
  const v = num(data?.results?.bindings?.[0]?.pop?.value);
  return v != null ? Math.round(v) : null;
};

const fetchHolidays = async (countryCode, years, fetchImpl) => {
  const out = [];
  for (const y of years) {
    const rows = await getJson(fetchImpl, `${config.NAGER_URL}/api/v3/PublicHolidays/${y}/${countryCode}`);
    for (const h of Array.isArray(rows) ? rows : []) {
      if (h.global === false) continue; // regional holidays are not for a whole-country calendar
      out.push({ date: ymd(h.date), name: h.localName || h.name, en: h.name });
    }
  }
  return out;
};

const fetchSchoolHolidays = async (countryCode, from, to, fetchImpl) => {
  const u = new URL(`${config.OPENHOLIDAYS_URL}/SchoolHolidays`);
  u.searchParams.set("countryIsoCode", countryCode);
  u.searchParams.set("validFrom", from);
  u.searchParams.set("validTo", to);
  const rows = await getJson(fetchImpl, u.toString());
  const out = [];
  for (const h of Array.isArray(rows) ? rows : []) {
    const name = Array.isArray(h.name) ? h.name.find((n) => n.language === countryCode)?.text || h.name[0]?.text : String(h.name || "");
    out.push({ start: ymd(h.startDate), end: ymd(h.endDate), name, regions: Array.isArray(h.subdivisions) ? h.subdivisions.map((s) => s.shortName || s.code).slice(0, 12) : [], nationwide: h.nationwide === true || !(Array.isArray(h.subdivisions) && h.subdivisions.length) });
  }
  return out;
};

const fetchTimezone = async (lat, lon, fetchImpl) => {
  const data = await getJson(fetchImpl, `${config.OPEN_METEO_URL}/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&daily=temperature_2m_max&forecast_days=1`);
  return { timezone: typeof data?.timezone === "string" ? data.timezone : null, elevation_m: num(data?.elevation) };
};

// ── Dossier ────────────────────────────────────────────────────────────────

const cacheKey = (q) => q.trim().toLowerCase();

const buildTerritory = async (query, { fetchImpl = null, force = false } = {}) => {
  const q = String(query || "").trim();
  if (q.length < 2) throw Object.assign(new Error("place is required (≥ 2 characters)."), { status: 400, code: "INVALID_INPUT" });
  const key = cacheKey(q);
  const cached = _cache.get(key);
  if (cached && !force && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.dossier, fromCache: true };
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw Object.assign(new Error("No fetch implementation."), { status: 500 });
  const warnings = [];
  const soft = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (err) {
      warnings.push(`${label}: ${err.name === "AbortError" ? "timeout" : err.message}`);
      return fallback;
    }
  };
  const place = await resolvePlace(q, doFetch);
  if (!place) throw Object.assign(new Error(`No place found for "${q}".`), { status: 404, code: "PLACE_NOT_FOUND" });
  const year = new Date().getFullYear();
  const [stops, lines, pois, residential, tz, holidays, schoolHolidays] = await Promise.all([
    soft("overpass stops", () => fetchStops(place.bbox, doFetch), []),
    soft("overpass lines", () => fetchLines(place.bbox, doFetch), []),
    soft("overpass pois", () => fetchPois(place.bbox, doFetch), { categories: {}, items: [] }),
    soft("overpass residential", () => fetchResidential(place.bbox, doFetch), []),
    soft("open-meteo", () => fetchTimezone(place.lat, place.lon, doFetch), { timezone: null, elevation_m: null }),
    place.country_code ? soft("nager", () => fetchHolidays(place.country_code, [year, year + 1], doFetch), []) : Promise.resolve([]),
    place.country_code ? soft("openholidays", () => fetchSchoolHolidays(place.country_code, `${year}-01-01`, `${year + 1}-12-31`, doFetch), []) : Promise.resolve([]),
  ]);
  let population = place.population_osm != null ? { value: Math.round(place.population_osm), source: "osm" } : null;
  if (!population && place.wikidata) {
    const v = await soft("wikidata", () => fetchPopulationWikidata(place.wikidata, doFetch), null);
    if (v != null) population = { value: v, source: "wikidata" };
  }
  const grid = populationGrid(residential, population ? population.value : null);
  const dossier = {
    place: { query: place.query, name: place.name, display_name: place.display_name, country_code: place.country_code, country: place.country, lat: place.lat, lon: place.lon, bbox: place.bbox, wikidata: place.wikidata, osm: place.osm_type && place.osm_id ? `${place.osm_type}/${place.osm_id}` : null },
    timezone: tz.timezone,
    elevation_m: tz.elevation_m,
    population,
    population_grid: grid,
    existing_stops: stops,
    existing_lines: lines,
    pois,
    holidays,
    school_holidays: schoolHolidays,
    sources: [SOURCES.osm, SOURCES.nominatim, SOURCES.overpass, ...(population?.source === "wikidata" ? [SOURCES.wikidata] : []), ...(holidays.length ? [SOURCES.nager] : []), ...(schoolHolidays.length ? [SOURCES.openholidays] : []), ...(tz.timezone ? [SOURCES.openmeteo] : [])],
    warnings,
    generatedAt: new Date().toISOString(),
  };
  _cache.set(key, { at: Date.now(), dossier });
  return { ...dossier, fromCache: false };
};

const getCachedTerritory = (query) => {
  const c = _cache.get(cacheKey(String(query || "")));
  return c ? c.dossier : null;
};

// ── Derived: text for the planner, coverage of a plan ─────────────────────

const TOP_STOPS_FOR_MODEL = 80;
const TOP_POIS_FOR_MODEL = 45;
const TOP_LINES_FOR_MODEL = 30;

const summarizeForModel = (d) => {
  const lines = [];
  lines.push(`[Territory] ${d.place.display_name} (country ${d.place.country_code || "?"}; centre ${d.place.lat.toFixed(4)}, ${d.place.lon.toFixed(4)}; box S${d.place.bbox[0].toFixed(3)} W${d.place.bbox[1].toFixed(3)} N${d.place.bbox[2].toFixed(3)} E${d.place.bbox[3].toFixed(3)})`);
  lines.push(`Timezone: ${d.timezone || "unknown"}. Population: ${d.population ? `${d.population.value} (${d.population.source})` : "unknown"}.`);
  if (d.population_grid) {
    const g = d.population_grid;
    lines.push(`Residents on a ${g.cell_m} m grid over ${g.residential_km2} km² of residential land (${g.estimated ? "estimated from a default density" : "scaled to the known population"}; ${g.cells.length} cells). Densest areas: ${g.cells.slice(0, 6).map((c) => `~${c.pop} at ${c.lat.toFixed(4)},${c.lon.toFixed(4)}`).join("; ")}. Lines must pass through them; coverage_score reports the share of residents within 400 m of a stop.`);
  }
  const named = d.existing_stops.filter((s) => s.name);
  lines.push(`Existing stops (OpenStreetMap): ${d.existing_stops.length} (${named.length} named). Reuse them: same names and coordinates, id = their id. Sample:`);
  const seen = new Set();
  let n = 0;
  for (const s of named) {
    const k = s.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    lines.push(`- ${s.id} "${s.name}" ${s.kind} ${s.lat.toFixed(5)},${s.lon.toFixed(5)}${s.operator ? ` (${s.operator})` : ""}`);
    if (++n >= TOP_STOPS_FOR_MODEL) break;
  }
  if (d.existing_lines.length) {
    lines.push(`Existing transit lines (OSM route relations, ${d.existing_lines.length}): ${d.existing_lines.slice(0, TOP_LINES_FOR_MODEL).map((l) => `${l.ref || l.name || "?"} [${l.mode}]${l.from && l.to ? ` ${l.from} → ${l.to}` : ""}`).join("; ")}`);
  }
  const cats = Object.entries(d.pois.categories).map(([c, k]) => `${c} ${k}`).join(", ");
  lines.push(`Trip generators: ${cats || "none found"}. Main ones:`);
  for (const p of d.pois.items.slice(0, TOP_POIS_FOR_MODEL)) lines.push(`- ${p.category}: ${p.name} ${p.lat.toFixed(5)},${p.lon.toFixed(5)}`);
  if (d.holidays.length) lines.push(`Public holidays (${d.place.country_code}): ${d.holidays.map((h) => `${h.date} ${h.name}`).join(", ")}`);
  if (d.school_holidays.length) lines.push(`School holidays: ${d.school_holidays.filter((h) => h.nationwide).slice(0, 12).map((h) => `${h.name} ${h.start}–${h.end}`).join("; ")}${d.school_holidays.some((h) => !h.nationwide) ? " (regional periods exist; ask the user for their zone if it matters)" : ""}`);
  if (d.warnings.length) lines.push(`Data gaps: ${d.warnings.join("; ")}.`);
  return lines.join("\n");
};

/** How well a (normalised) spec covers the territory's generators and reuses its stops. */
const coverageOf = (spec, d) => {
  const planned = (spec.stops || []).filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  const served = new Set((spec.lines || []).flatMap((l) => (l.directions || []).flatMap((x) => x.stops || [])));
  const active = planned.filter((s) => served.has(s.id));
  const near = (lat, lon, r) => active.some((s) => haversineMeters(lat, lon, s.lat, s.lon) <= r);
  const pois = d.pois.items;
  const covered = pois.filter((p) => near(p.lat, p.lon, COVERAGE_RADIUS_M));
  const byCat = {};
  for (const p of pois) {
    byCat[p.category] = byCat[p.category] || { total: 0, covered: 0 };
    byCat[p.category].total += 1;
  }
  for (const p of covered) byCat[p.category].covered += 1;
  const weight = (list) => list.reduce((a, p) => a + p.weight, 0);
  const reused = active.filter((s) => d.existing_stops.some((e) => haversineMeters(s.lat, s.lon, e.lat, e.lon) <= REUSE_RADIUS_M)).length;
  const missed = pois.filter((p) => !covered.includes(p)).sort((a, b) => b.weight - a.weight).slice(0, 10).map((p) => ({ name: p.name, category: p.category, lat: p.lat, lon: p.lon }));
  // Residents: grid cells whose centre is within the radius of a served stop.
  let population = null;
  if (d.population_grid && d.population_grid.cells.length) {
    const cells = d.population_grid.cells;
    const total = cells.reduce((s, c) => s + c.pop, 0);
    const coveredPop = cells.filter((c) => near(c.lat, c.lon, COVERAGE_RADIUS_M)).reduce((s, c) => s + c.pop, 0);
    const missedCells = cells.filter((c) => !near(c.lat, c.lon, COVERAGE_RADIUS_M)).slice(0, 5).map((c) => ({ lat: c.lat, lon: c.lon, pop: c.pop }));
    population = { total, covered: coveredPop, pct: total ? Math.round((coveredPop / total) * 100) : null, estimated: d.population_grid.estimated, top_missed: missedCells };
  }
  return {
    pois_total: pois.length,
    pois_covered: covered.length,
    coverage_pct: pois.length ? Math.round((weight(covered) / Math.max(1, weight(pois))) * 100) : null,
    by_category: byCat,
    population,
    stops_planned: active.length,
    existing_stops_reused: reused,
    top_missed: missed,
    radius_m: COVERAGE_RADIUS_M,
  };
};

/** Existing stops whose name matches a query (loose), nearest first. */
const findStops = (d, query, near = null, limit = 8) => {
  const q = String(query || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  if (!q) return [];
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const words = q.split(/\s+/).filter(Boolean);
  const scored = d.existing_stops
    .filter((s) => s.name)
    .map((s) => {
      const n = norm(s.name);
      let score = 0;
      if (n === q) score = 3;
      else if (n.includes(q)) score = 2;
      else if (words.every((w) => n.includes(w))) score = 1;
      return { s, score };
    })
    .filter((x) => x.score > 0);
  const centre = near || { lat: d.place.lat, lon: d.place.lon };
  scored.sort((a, b) => b.score - a.score || haversineMeters(centre.lat, centre.lon, a.s.lat, a.s.lon) - haversineMeters(centre.lat, centre.lon, b.s.lat, b.s.lon));
  return scored.slice(0, limit).map((x) => ({ ...x.s, distance_m: Math.round(haversineMeters(centre.lat, centre.lon, x.s.lat, x.s.lon)) }));
};

module.exports = { buildTerritory, getCachedTerritory, summarizeForModel, coverageOf, findStops, populationGrid, SOURCES, POI_CATEGORIES, _internals: { resolvePlace, fetchStops, fetchLines, fetchPois, fetchResidential, fetchHolidays, fetchSchoolHolidays, fetchTimezone, fetchPopulationWikidata, polygonAreaM2, pointInPolygon, _cache } };
