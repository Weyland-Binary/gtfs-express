/**
 * feedChecks — what the canonical validator does not look at but the big
 * consumers do (Google's extra checks, Transit, trip planners): a feed that
 * passes the spec can still be rejected or display badly.
 *
 *   stop_far_from_shape   a stop more than 150 m from its trip's shape
 *   fast_travel           a hop faster than the mode can go (bus 100 km/h,
 *                         tram 80, metro 120, rail 300, ferry 60), or an
 *                         instantaneous hop over 1 km
 *   duplicate_trips       two trips of a route on the same service with the
 *                         same stops and times
 *   low_contrast          route_text_color on route_color below 4.5:1
 *   block_overlap         two trips of one vehicle block running at the
 *                         same time on a same day
 *
 *   feedChecks(db, model) → [{ code, count, examples: [...] }]
 *   newChecks(before, after) → the problems a change introduced (count up)
 */

"use strict";

const geo = require("./geometry");
const { haversineMeters } = require("../../utils/geoUtils");

const FAR_FROM_SHAPE_M = 150;
const MAX_KMH = { bus: 100, trolleybus: 80, tram: 80, metro: 120, rail: 300, ferry: 60, cable: 50, gondola: 50, funicular: 50, monorail: 120 };
const MAX_EXAMPLES = 5;

const add = (out, code, example) => {
  if (!out.has(code)) out.set(code, { code, count: 0, examples: [] });
  const c = out.get(code);
  c.count += 1;
  if (c.examples.length < MAX_EXAMPLES) c.examples.push(example);
};

// WCAG relative luminance and contrast ratio.
const luminance = (hex) => {
  const h = String(hex || "").replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
  const x = luminance(a);
  const y = luminance(b);
  if (x == null || y == null) return null;
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

// The model stands for the database it was built from: measured once per model.
const feedChecks = (db, model) => require("./feedModel").memo(model, "feedChecks", () => computeFeedChecks(db, model));

const computeFeedChecks = (db, model) => {
  const out = new Map();
  // Stops far from their shape (once per shape and pattern).
  const seen = new Set();
  const shapes = new Map();
  for (const t of model.trips.values()) {
    if (!t.shape_id) continue;
    const key = `${t.shape_id}|${t.pattern}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!shapes.has(t.shape_id)) {
      const pts = geo.readShape(db, t.shape_id);
      shapes.set(t.shape_id, pts.length >= 2 ? { pts, cum: geo.measure(pts) } : null);
    }
    const sh = shapes.get(t.shape_id);
    if (!sh) continue;
    const stops = t.stops.map((id) => model.stops.get(id));
    geo.projectStops(sh.pts, sh.cum, stops.map((s) => (s && s.lat != null ? s : { lat: NaN, lon: NaN })), { tolerance: 1e9 }).forEach((p, i) => {
      if (p && Number.isFinite(p.off) && p.off > FAR_FROM_SHAPE_M) add(out, "stop_far_from_shape", { shape_id: t.shape_id, stop_id: t.stops[i], stop_name: stops[i]?.name || null, meters: Math.round(p.off) });
    });
  }
  // Impossible speeds.
  const fastSeen = new Set();
  for (const t of model.trips.values()) {
    const mode = model.routes.get(t.route_id)?.mode || "bus";
    const max = MAX_KMH[mode] || 100;
    for (let k = 1; k < t.stops.length; k++) {
      const a = model.stops.get(t.stops[k - 1]);
      const b = model.stops.get(t.stops[k]);
      if (!a || !b || a.lat == null || b.lat == null || t.dep[k - 1] == null || t.arr[k] == null) continue;
      const m = haversineMeters(a.lat, a.lon, b.lat, b.lon);
      const s = t.arr[k] - t.dep[k - 1];
      const key = `${t.pattern}|${k}|${s}`;
      if (fastSeen.has(key)) continue;
      if ((s <= 0 && m > 1000) || (s > 0 && (m / s) * 3.6 > max)) {
        fastSeen.add(key);
        add(out, "fast_travel", { trip_id: t.id, from: a.name, to: b.name, meters: Math.round(m), seconds: s });
      }
    }
  }
  // Duplicate trips.
  const sig = new Map();
  for (const t of model.trips.values()) {
    const k = `${t.route_id}|${t.service_id}|${t.stops.join(">")}|${t.dep.join(",")}`;
    if (sig.has(k)) add(out, "duplicate_trips", { trip_id: t.id, same_as: sig.get(k) });
    else sig.set(k, t.id);
  }
  // Colour contrast.
  for (const r of db.prepare("SELECT route_id, route_short_name, route_color, route_text_color FROM routes").all()) {
    if (!r.route_color) continue;
    const ratio = contrast(r.route_color, r.route_text_color || "000000");
    if (ratio != null && ratio < 4.5) add(out, "low_contrast", { route_id: r.route_id, label: r.route_short_name || r.route_id, ratio: Math.round(ratio * 100) / 100 });
  }
  // Vehicle blocks: trips of one block overlapping in time on a shared service date.
  const blocks = new Map();
  for (const t of model.trips.values()) {
    if (!t.block_id || t.first == null) continue;
    if (!blocks.has(t.block_id)) blocks.set(t.block_id, []);
    blocks.get(t.block_id).push(t);
  }
  const S = require("./scope");
  for (const [bid, list] of blocks) {
    const sorted = list.sort((a, b) => a.first - b.first);
    for (let i = 1; i < sorted.length; i++) {
      for (let j = i - 1; j >= 0 && j >= i - 4; j--) {
        const a = sorted[j];
        const b = sorted[i];
        if ((a.lastArr ?? a.first) <= b.first) continue;
        const da = new Set(S.activeDates(model, a.service_id));
        if (S.activeDates(model, b.service_id).some((d) => da.has(d))) {
          add(out, "block_overlap", { block_id: bid, trips: [a.id, b.id] });
          break;
        }
      }
    }
  }
  return [...out.values()];
};

/** The checks a change made worse (a problem appears or grows). */
const newChecks = (before, after) => {
  const b = new Map(before.map((c) => [c.code, c.count]));
  return after.filter((c) => c.count > (b.get(c.code) || 0)).map((c) => ({ ...c, before: b.get(c.code) || 0 }));
};

module.exports = { feedChecks, newChecks, _internals: { contrast, FAR_FROM_SHAPE_M, MAX_KMH } };
