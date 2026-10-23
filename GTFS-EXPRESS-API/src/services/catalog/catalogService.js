/**
 * The public GTFS feeds that serve a place. The Mobility Database catalog CSV is cached for a day; France reads its
 * National Access Point first (panCatalog).
 */

"use strict";

const config = require("../../config");

const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 60000;
const MAX_FEEDS = 12;

let _catalog = null; // { at, rows }

/** The body is read inside the timed scope: headers can arrive and the body never end (panCatalog.getJsonOnce). */
const fetchText = async (fetchImpl, url, init = {}, ms = FETCH_TIMEOUT_MS) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal, headers: { "User-Agent": "gtfs-express/1.0", ...(init.headers || {}) } });
    if (!res.ok) throw Object.assign(new Error(`Catalog: HTTP ${res.status}`), { status: 502, code: "CATALOG_UNAVAILABLE" });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
};

/** A small RFC 4180 parser: the catalog has quoted fields with commas and newlines. */
const parseCsvText = (text) => {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.replace(/^﻿/, "").trim());
  return rows.slice(1).filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
};

const loadCatalog = async (fetchImpl, { force = false } = {}) => {
  if (_catalog && !force && Date.now() - _catalog.at < CATALOG_TTL_MS) return _catalog.rows;
  const text = await fetchText(fetchImpl, config.MOBILITY_CATALOG_URL);
  const rows = parseCsvText(text)
    .filter((r) => (r.data_type || "").toLowerCase() === "gtfs" && !/deprecated|inactive/i.test(r.status || "") && !r["urls.authentication_type"]?.match(/^[12]$/))
    .map((r) => ({
      id: r.mdb_source_id,
      provider: r.provider || "",
      name: r.name || "",
      country: r["location.country_code"] || "",
      region: r["location.subdivision_name"] || "",
      municipality: r["location.municipality"] || "",
      url: r["urls.latest"] || r["urls.direct_download"] || "",
      direct: r["urls.direct_download"] || "",
      license: r["urls.license"] || "",
      bbox: [Number(r["location.bounding_box.minimum_latitude"]), Number(r["location.bounding_box.minimum_longitude"]), Number(r["location.bounding_box.maximum_latitude"]), Number(r["location.bounding_box.maximum_longitude"])],
      extracted_on: r["location.bounding_box.extracted_on"] || null,
    }))
    .filter((r) => r.url && r.bbox.every(Number.isFinite));
  _catalog = { at: Date.now(), rows };
  return rows;
};

const bboxArea = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const contains = (b, lat, lon) => lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3];
const intersects = (a, b) => !(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]);
// The catalog's boxes are extracted automatically and some are wrong: a
// corner at (0, 0), inverted, or spanning a continent. Such a box "covers"
// every town and would bury the real local network.
const LOCAL_AREA_DEG2 = 2; // an urban or departmental network
const REGIONAL_AREA_DEG2 = 30; // a region
const MAX_AREA_DEG2 = 150; // beyond: continental or broken, unless named after the place
const degenerateBox = (b) => (b[0] === 0 && b[1] === 0) || (b[2] === 0 && b[3] === 0) || b[2] <= b[0] || b[3] <= b[1] || b[0] < -90 || b[2] > 90 || b[1] < -180 || b[3] > 180;
const scopeOf = (area) => (area <= LOCAL_AREA_DEG2 ? "local" : area <= REGIONAL_AREA_DEG2 ? "regional" : "national");
const fold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Feeds covering the territory, most relevant first.
 *
 * France: the National Access Point (panCatalog: every published GTFS, the
 * area it officially covers, its validity, whether its stops serve the
 * place), then the Mobility Database feeds it does not already publish
 * (the database mirrors many access-point files, sometimes years old).
 * Elsewhere, or when the access point cannot be read: the Mobility
 * Database alone — the feeds named after the place (provider, name or
 * municipality), then those covering its centre, then the smallest areas;
 * only the territory's country, no broken boxes.
 */
const MAX_ALL_FEEDS = 30;
// A Mobility Database entry copied from the French access point.
const mirrorsAccessPoint = (r) => /transport[.-]data[.-]gouv[.-]fr/i.test(`${r.license} ${r.direct} ${r.url}`);

const findFeedsDetailed = async (territory, { fetchImpl = null, force = false } = {}) => {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw Object.assign(new Error("No fetch implementation."), { status: 500 });
  const countryCode = String(territory.place.country_code || "").toUpperCase();
  const sources = { pan: null, mdb: null };
  let pan = null;
  if (countryCode === "FR") {
    try {
      pan = await require("./panCatalog").findPanFeeds(territory.place, { fetchImpl: doFetch });
      sources.pan = { ok: true, count: pan.feeds.length };
    } catch (err) {
      sources.pan = { ok: false, error: err.message };
    }
  }
  let mdb = [];
  try {
    mdb = await mdbFeeds(territory, doFetch, { force });
    if (pan) mdb = mdb.filter((f) => !mirrorsAccessPoint(f));
    sources.mdb = { ok: true, count: mdb.length };
  } catch (err) {
    sources.mdb = { ok: false, error: err.message };
    if (!pan) throw err;
  }
  const feeds = [...(pan ? pan.feeds : []), ...mdb].slice(0, MAX_ALL_FEEDS);
  return { feeds, sources, codes: pan?.codes || null };
};

const findFeeds = async (territory, opts = {}) => (await findFeedsDetailed(territory, opts)).feeds;

/**
 * Feeds found by the network's own name (a brand like « Tisséo », not a town): the French access point's datasets
 * whose commercial name, title, owner or publisher holds every word of the query, then the Mobility Database entries
 * whose provider or name does (those the access point already publishes left out).
 */
const findFeedsByName = async (query, { fetchImpl = null } = {}) => {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) throw Object.assign(new Error("No fetch implementation."), { status: 500 });
  const words = fold(query).split(" ").filter((w) => w.length >= 2);
  const sources = { pan: null, mdb: null };
  if (!words.length) return { feeds: [], sources };
  let pan = [];
  try {
    pan = (await require("./panCatalog").findPanFeedsByName(query, { fetchImpl: doFetch })).feeds;
    sources.pan = { ok: true, count: pan.length };
  } catch (err) {
    sources.pan = { ok: false, error: err.message };
  }
  let mdb = [];
  try {
    const rows = await loadCatalog(doFetch);
    mdb = rows
      .filter((r) => !degenerateBox(r.bbox) && (!pan.length || !mirrorsAccessPoint(r)))
      .filter((r) => {
        const hay = ` ${fold(`${r.provider} ${r.name}`)} `;
        return words.every((w) => hay.includes(w));
      })
      .map((r) => {
        const area = bboxArea(r.bbox);
        return { ...r, source: "mdb", status: "unknown", snapshot: r.extracted_on ? String(r.extracted_on).slice(0, 10) : null, area_deg2: Math.round(area * 1000) / 1000, covers_centre: true, named: true, scope: scopeOf(area) };
      })
      .slice(0, MAX_FEEDS);
    sources.mdb = { ok: true, count: mdb.length };
  } catch (err) {
    sources.mdb = { ok: false, error: err.message };
  }
  return { feeds: [...pan, ...mdb].slice(0, MAX_ALL_FEEDS), sources };
};

// The Mobility Database entries covering the territory (see findFeedsDetailed).
const mdbFeeds = async (territory, doFetch, { force = false } = {}) => {
  const rows = await loadCatalog(doFetch, { force });
  const { lat, lon, bbox } = territory.place;
  const country = String(territory.place.country_code || "").toUpperCase();
  const placeName = fold(territory.place.name);
  const named = (r) => placeName.length >= 3 && ` ${fold(`${r.provider} ${r.name} ${r.municipality}`)} `.includes(` ${placeName} `);
  const hits = rows
    .filter((r) => !degenerateBox(r.bbox))
    .filter((r) => !country || !r.country || r.country.toUpperCase() === country)
    .filter((r) => contains(r.bbox, lat, lon) || intersects(r.bbox, bbox))
    .map((r) => {
      const area = bboxArea(r.bbox);
      return { ...r, source: "mdb", status: "unknown", snapshot: r.extracted_on ? String(r.extracted_on).slice(0, 10) : null, area_deg2: Math.round(area * 1000) / 1000, covers_centre: contains(r.bbox, lat, lon), named: named(r), scope: scopeOf(area) };
    })
    .filter((r) => r.area_deg2 <= MAX_AREA_DEG2 || r.named)
    .sort((a, b) => Number(b.named) - Number(a.named) || Number(b.covers_centre) - Number(a.covers_centre) || a.area_deg2 - b.area_deg2)
    .slice(0, MAX_FEEDS);
  return hits;
};

module.exports = { findFeeds, findFeedsDetailed, findFeedsByName, loadCatalog, _internals: { parseCsvText, reset: () => { _catalog = null; } } };
