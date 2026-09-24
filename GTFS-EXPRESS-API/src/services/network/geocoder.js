/**
 * geocoder — place names / addresses → coordinate candidates, for the stops
 * of a Network Spec. Backed by Photon (komoot, OpenStreetMap data) by
 * default; any Photon-compatible endpoint works (GEOCODER_URL). Results are
 * cached per process; the caller decides which candidate is right (the UI
 * shows them on the map, the planner picks the one closest to the network).
 */

"use strict";

const config = require("../../config");

const TIMEOUT_MS = 7000;
const MAX_LIMIT = 8;
const _cache = new Map();

const buildUrl = (base, q, { near, limit, lang }) => {
  const u = new URL(base);
  u.searchParams.set("q", q);
  u.searchParams.set("limit", String(limit));
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lon)) {
    u.searchParams.set("lat", String(near.lat));
    u.searchParams.set("lon", String(near.lon));
  }
  if (lang && /^[a-z]{2}$/.test(lang)) u.searchParams.set("lang", lang);
  return u.toString();
};

const labelOf = (p) => {
  const parts = [p.name, p.street && !p.name ? p.street : null, p.housenumber ? `${p.housenumber} ${p.street || ""}`.trim() : null, p.city || p.town || p.village, p.postcode, p.country];
  return [...new Set(parts.filter(Boolean))].join(", ");
};

/**
 * @returns {Promise<{ query, candidates: [{ label, name, lat, lon, kind, city, country, importance }], error? }>}
 */
const geocode = async (query, { near = null, limit = 5, lang = null, fetchImpl = null, baseUrl = null } = {}) => {
  const q = String(query || "").trim();
  if (q.length < 2) return { query: q, candidates: [], error: "query too short" };
  const url = buildUrl(baseUrl || config.GEOCODER_URL, q, { near, limit: Math.min(MAX_LIMIT, Math.max(1, limit)), lang });
  if (_cache.has(url)) return { query: q, candidates: _cache.get(url) };
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return { query: q, candidates: [], error: "no fetch implementation" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "gtfs-express/1.0 (network studio)" } });
    if (!res.ok) return { query: q, candidates: [], error: `geocoder HTTP ${res.status}` };
    const data = await res.json();
    const features = Array.isArray(data?.features) ? data.features : [];
    const candidates = features
      .map((f) => {
        const c = f?.geometry?.coordinates;
        const p = f?.properties || {};
        if (!Array.isArray(c) || c.length < 2) return null;
        return {
          label: labelOf(p),
          name: p.name || p.street || q,
          lat: Number(c[1]),
          lon: Number(c[0]),
          kind: [p.osm_key, p.osm_value].filter(Boolean).join(":") || p.type || null,
          city: p.city || p.town || p.village || null,
          country: p.country || null,
        };
      })
      .filter((c) => c && Number.isFinite(c.lat) && Number.isFinite(c.lon));
    _cache.set(url, candidates);
    return { query: q, candidates };
  } catch (err) {
    return { query: q, candidates: [], error: err.name === "AbortError" ? "geocoder timeout" : err.message };
  } finally {
    clearTimeout(timer);
  }
};

/** Geocode several queries (small concurrency, keeps the public service happy). */
const geocodeMany = async (queries, opts = {}) => {
  const out = [];
  const concurrency = 3;
  let i = 0;
  const worker = async () => {
    while (i < queries.length) {
      const idx = i++;
      out[idx] = await geocode(queries[idx], opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queries.length) }, worker));
  return out;
};

module.exports = { geocode, geocodeMany, _internals: { buildUrl, labelOf, _cache } };
