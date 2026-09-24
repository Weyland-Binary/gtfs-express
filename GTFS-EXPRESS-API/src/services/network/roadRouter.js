/**
 * roadRouter — the geometry and distances of a line's path along roads,
 * server-side (OSRM `route` service; OSRM_URL). Every leg between two
 * consecutive stops gets a distance and a nominal duration; the polyline
 * becomes the shape. When routing is disabled, fails or times out, the
 * straight-line fallback joins the stops with a detour factor so the
 * compiler always produces a feed (flagged in `fallbacks`).
 */

"use strict";

const config = require("../../config");
const { haversineMeters } = require("../../utils/geoUtils");

const TIMEOUT_MS = 10000;
const WAYPOINTS_PER_REQUEST = 25;
const DETOUR_FACTOR = 1.3;
const _cache = new Map();

const key = (points) => points.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(";");

const straightRoute = (points, detour = DETOUR_FACTOR) => {
  const legs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const d = haversineMeters(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon) * detour;
    legs.push({ distanceM: d, durationS: null, straight: true });
  }
  return { points: points.map((p) => ({ lat: p.lat, lon: p.lon })), legs, distanceM: legs.reduce((a, l) => a + l.distanceM, 0), fallbacks: legs.length };
};

const fetchChunk = async (points, { fetchImpl, baseUrl, signal }) => {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const url = `${baseUrl}/${coords}?overview=full&geometries=geojson&steps=false`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { "User-Agent": "gtfs-express/1.0 (network studio)" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.[0]) return null;
    const route = data.routes[0];
    const legs = (route.legs || []).map((l) => ({ distanceM: Number(l.distance) || 0, durationS: Number(l.duration) || 0, straight: false }));
    if (legs.length !== points.length - 1) return null;
    return { points: route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })), legs };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
};

/**
 * Route through ordered stops. Returns { points, legs, distanceM, fallbacks }.
 * `mode` "straight" skips the network entirely.
 */
const createRouter = ({ mode = null, fetchImpl = null, baseUrl = null } = {}) => {
  const routing = mode || (config.NETWORK_ROUTING_ENABLED ? "osrm" : "straight");
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const base = baseUrl || config.OSRM_URL;
  const route = async (stops, { signal } = {}) => {
    const points = (stops || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
    if (points.length < 2) return straightRoute(points);
    if (routing === "straight" || !doFetch) return straightRoute(points);
    const k = key(points);
    if (_cache.has(k)) return _cache.get(k);
    const out = { points: [], legs: [], distanceM: 0, fallbacks: 0 };
    for (let start = 0; start + 1 < points.length; start += WAYPOINTS_PER_REQUEST - 1) {
      const chunk = points.slice(start, start + WAYPOINTS_PER_REQUEST);
      const res = await fetchChunk(chunk, { fetchImpl: doFetch, baseUrl: base, signal });
      const part = res || straightRoute(chunk);
      if (!res) out.fallbacks += chunk.length - 1;
      const pts = out.points.length ? part.points.slice(1) : part.points;
      out.points.push(...pts);
      out.legs.push(...part.legs);
    }
    out.distanceM = out.legs.reduce((a, l) => a + l.distanceM, 0);
    _cache.set(k, out);
    return out;
  };
  return { route, mode: routing };
};

module.exports = { createRouter, straightRoute, _internals: { fetchChunk, _cache, DETOUR_FACTOR } };
