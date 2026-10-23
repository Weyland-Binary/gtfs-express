/**
 * The shape editor's road routing through the server's router: the browser never calls a routing service itself,
 * so the visitor's address reaches no third party, only the waypoints do. The caller decides what a leg that fell
 * back to a straight line means.
 */

"use strict";

const { createRouter } = require("../network/roadRouter");

// The router splits the waypoints into OSRM requests of 25.
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
