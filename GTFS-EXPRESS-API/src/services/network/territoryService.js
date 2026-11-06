/**
 * territoryService — a place and its public calendars, from public keyless sources:
 *
 *   resolvePlace(query, fetchImpl)                         Nominatim (OpenStreetMap): centre, box, country
 *   fetchHolidays(countryCode, years, fetchImpl)           Nager.Date: the country's public holidays
 *   fetchSchoolHolidays(countryCode, from, to, fetchImpl)  OpenHolidays: school holidays, by region
 */

"use strict";

const config = require("../../config");

const TIMEOUT_MS = 20000;
// A town, not a region: the box the catalogue search reads is capped.
const MAX_BBOX_SIDE_KM = 30;
const USER_AGENT = "gtfs-express/1.0 (contact via app)";

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const ymd = (iso) => String(iso || "").slice(0, 10).replace(/-/g, "");

/** The body is read inside the timed scope: headers can arrive and the body never end. */
const getJson = async (fetchImpl, url, init = {}, ms = TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal, headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

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

// Both calendar services want the ISO code in capitals: a session's country is kept lowercase (sessionCountry), and
// openholidays answers « fr » with an empty list — every school period then unknown.
const isoUpper = (code) => String(code || "").trim().toUpperCase();

const fetchHolidays = async (countryCode, years, fetchImpl) => {
  countryCode = isoUpper(countryCode);
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
  countryCode = isoUpper(countryCode);
  const u = new URL(`${config.OPENHOLIDAYS_URL}/SchoolHolidays`);
  u.searchParams.set("countryIsoCode", countryCode);
  u.searchParams.set("validFrom", from);
  u.searchParams.set("validTo", to);
  const rows = await getJson(fetchImpl, u.toString());
  const out = [];
  for (const h of Array.isArray(rows) ? rows : []) {
    const name = Array.isArray(h.name) ? h.name.find((n) => n.language === countryCode)?.text || h.name[0]?.text : String(h.name || "");
    // Every region is kept: a France-wide period lists 15 (the zones come last), a Swiss one up to 26 cantons.
    out.push({ start: ymd(h.startDate), end: ymd(h.endDate), name, regions: Array.isArray(h.subdivisions) ? h.subdivisions.map((s) => s.shortName || s.code).slice(0, 40) : [], nationwide: h.nationwide === true || !(Array.isArray(h.subdivisions) && h.subdivisions.length) });
  }
  return out;
};

module.exports = { _internals: { resolvePlace, fetchHolidays, fetchSchoolHolidays } };
