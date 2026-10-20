/**
 * roadRouteService — POST /edit/route: the shape editor's road routing
 * (snap to road, a section re-routed, a shape generated from its stops)
 * through the server's router (network/roadRouter: OSRM_URL, the same
 * self-hosted bus profile the studios use, its cache and its timeouts).
 * The browser never calls a routing service itself, so the visitor's
 * address reaches no third party; only the waypoints' coordinates do.
 *
 * Body { points: [{ lat, lon }, …] } (2 to MAX_ROUTE_POINTS, in order).
 * Answers { points, fallbacks, suspicious, mode }: the polyline through
 * them, and how many legs fell back to a straight line (router off, down
 * or unable to route them) — the caller decides what a fallback means.
 */

"use strict";

const { createRouter } = require("../network/roadRouter");

// One request routes at most this many waypoints (the router splits them
// into OSRM requests of 25); a shape generated from a long line's stops
// stays well under it.
const MAX_ROUTE_POINTS = 500;

const routeAlongRoads = async (req, res) => {
  const raw = req.body && Array.isArray(req.body.points) ? req.body.points : null;
  if (!raw || raw.length < 2 || raw.length > MAX_ROUTE_POINTS) {
    return res.status(400).json({ error: `points must list 2 to ${MAX_ROUTE_POINTS} waypoints.` });
  }
  const points = raw.map((p) => ({ lat: Number(p?.lat), lon: Number(p?.lon) }));
  if (points.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180)) {
    return res.status(400).json({ error: "Every waypoint needs a valid lat and lon." });
  }
  const router = createRouter();
  const out = await router.route(points);
  res.json({ points: out.points, fallbacks: out.fallbacks, suspicious: out.suspicious, mode: router.mode });
};

module.exports = { routeAlongRoads, MAX_ROUTE_POINTS };
