/**
 * A line's path along roads (OSRM `route`, OSRM_URL): each leg between two stops gets a distance and a duration,
 * the polyline becomes the shape. When routing is off, fails or times out, a straight line with a detour factor
 * joins the stops (counted in `fallbacks`), never cached so the next call routes again.
 *
 * A road route is not trusted blindly: the public OSRM routes a car, one point per stop and no side of the road,
 * so it ignores bus-only streets and may loop round the block to reach a stop. Hence:
 *   • `suspicious`: the routed legs over twice the straight distance and over 300 m; the path is still returned,
 *     callers warn and the transform operators do not time a leg on it.
 *   • curb approaches (`curb`, NETWORK_ROUTING_CURB) are off by default: where one pole serves both directions,
 *     one direction would loop round the block to every such stop.
 *   • continue_straight is not sent: the car profile already forbids U-turns at waypoints, and sending it would
 *     override a self-hosted profile's own choice.
 */

"use strict";

const config = require("../../config");
const { haversineMeters } = require("../../utils/geoUtils");

const TIMEOUT_MS = 10000;
const WAYPOINTS_PER_REQUEST = 25;
const DETOUR_FACTOR = 1.3;
const SUSPICIOUS_RATIO = 2; // routed over twice the straight distance…
const SUSPICIOUS_MIN_M = 300; // …and over this length: a leg worth a look
const _cache = new Map();
const MAX_CACHE = 5000;

const key = (points, { base, curb }) => `${base}|${curb ? "curb" : "any"}|${points.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(";")}`;

const straightRoute = (points, detour = DETOUR_FACTOR) => {
  const legs = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const d = haversineMeters(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon) * detour;
    legs.push({ distanceM: d, durationS: null, straight: true });
  }
  return { points: points.map((p) => ({ lat: p.lat, lon: p.lon })), legs, distanceM: legs.reduce((a, l) => a + l.distanceM, 0), fallbacks: legs.length, suspicious: [] };
};

const fetchChunk = async (points, { fetchImpl, baseUrl, signal, curb = false }) => {
  const coords = points.map((p) => `${p.lon},${p.lat}`).join(";");
  const approaches = curb ? `&approaches=${points.map(() => "curb").join(";")}` : "";
  const url = `${baseUrl}/${coords}?overview=full&geometries=geojson&steps=false${approaches}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { "User-Agent": "gtfs-express/1.0" } });
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

const stopIdOf = (p) => (p.id != null && p.id !== "" ? p.id : p.stop_id != null && p.stop_id !== "" ? p.stop_id : null);

const suspiciousLegs = (stops, legs) => {
  const out = [];
  legs.forEach((l, i) => {
    const a = stops[i];
    const b = stops[i + 1];
    if (!l || l.straight || !(l.distanceM > 0) || !a || !b) return;
    const straight = haversineMeters(a.lat, a.lon, b.lat, b.lon);
    if (!(l.distanceM > SUSPICIOUS_RATIO * straight && l.distanceM > SUSPICIOUS_MIN_M)) return;
    const from = stopIdOf(a);
    const to = stopIdOf(b);
    out.push({ index: i, ...(from != null ? { from_stop: from } : {}), ...(to != null ? { to_stop: to } : {}), straight_m: Math.round(straight), routed_m: Math.round(l.distanceM), ratio: straight > 0 ? Math.round((l.distanceM / straight) * 100) / 100 : null });
  });
  return out;
};

/** `suspicious` is computed on every call from the stops given: their ids are not part of the cache key. */
const createRouter = ({ mode = null, fetchImpl = null, baseUrl = null, curb = null } = {}) => {
  const routing = mode || (config.NETWORK_ROUTING_ENABLED ? "osrm" : "straight");
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const base = baseUrl || config.OSRM_URL;
  const curbDefault = curb != null ? Boolean(curb) : Boolean(config.NETWORK_ROUTING_CURB);
  const route = async (stops, { signal, curb: curbCall = null } = {}) => {
    const points = (stops || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
    if (points.length < 2) return straightRoute(points);
    if (routing === "straight" || !doFetch) return straightRoute(points);
    const withCurb = curbCall != null ? Boolean(curbCall) : curbDefault;
    const k = key(points, { base, curb: withCurb });
    let out = _cache.get(k);
    if (!out) {
      out = { points: [], legs: [], distanceM: 0, fallbacks: 0 };
      for (let start = 0; start + 1 < points.length; start += WAYPOINTS_PER_REQUEST - 1) {
        const chunk = points.slice(start, start + WAYPOINTS_PER_REQUEST);
        const res = await fetchChunk(chunk, { fetchImpl: doFetch, baseUrl: base, signal, curb: withCurb });
        const part = res || straightRoute(chunk);
        if (!res) out.fallbacks += chunk.length - 1;
        const pts = out.points.length ? part.points.slice(1) : part.points;
        out.points.push(...pts);
        out.legs.push(...part.legs);
      }
      out.distanceM = out.legs.reduce((a, l) => a + l.distanceM, 0);
      if (!out.fallbacks) {
        if (_cache.size >= MAX_CACHE) _cache.delete(_cache.keys().next().value);
        _cache.set(k, out);
      }
    }
    return { ...out, suspicious: suspiciousLegs(points, out.legs) };
  };
  return { route, mode: routing, curb: curbDefault };
};

module.exports = { createRouter, straightRoute, suspiciousLegs, _internals: { fetchChunk, _cache, DETOUR_FACTOR, SUSPICIOUS_RATIO, SUSPICIOUS_MIN_M } };
