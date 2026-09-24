import { describe, it, expect } from "vitest";
import {
  analyzeStopFit,
  nearestSegmentProjection,
  simplifyRDP,
  cumulativeDistances,
} from "../utils/shapeGeometry";

// A straight west→east line at latitude 48.85 (Paris), ~1.1 km long.
const LINE = [
  { lat: 48.85, lon: 2.3 },
  { lat: 48.85, lon: 2.305 },
  { lat: 48.85, lon: 2.31 },
  { lat: 48.85, lon: 2.315 },
];

describe("shapeGeometry", () => {
  it("projects onto the nearest segment", () => {
    const near = nearestSegmentProjection({ lat: 48.8501, lon: 2.312 }, LINE);
    expect(near.index).toBe(2);
    expect(near.distM).toBeGreaterThan(10);
    expect(near.distM).toBeLessThan(12);
    expect(near.t).toBeCloseTo(0.4, 1);
  });

  it("simplifies collinear points but keeps the endpoints", () => {
    expect(simplifyRDP(LINE, 5)).toEqual([LINE[0], LINE[3]]);
    const bent = [...LINE.slice(0, 2), { lat: 48.851, lon: 2.3075 }, ...LINE.slice(2)];
    // The 111 m kink survives a 100 m tolerance; its neighbours (~74 m off
    // the new chords) are dropped.
    expect(simplifyRDP(bent, 100).length).toBe(3);
    expect(simplifyRDP(bent, 5).length).toBe(5);
  });

  it("accumulates distances along the line", () => {
    const cum = cumulativeDistances(LINE);
    expect(cum[0]).toBe(0);
    expect(cum[3]).toBeGreaterThan(1000);
    expect(cum[3]).toBeLessThan(1200);
  });

  it("flags stops far from the trace and stops served in the wrong order", () => {
    const stops = [
      { stop_id: "A", lat: 48.85, lon: 2.301 },
      { stop_id: "C", lat: 48.85, lon: 2.312 }, // served before B → out of order
      { stop_id: "B", lat: 48.85, lon: 2.306 },
      { stop_id: "FAR", lat: 48.86, lon: 2.31 }, // ~1.1 km north
    ];
    const fit = analyzeStopFit(LINE, stops, { thresholdM: 100 });
    expect(fit.results.length).toBe(4);
    expect(fit.offTrace.map((r) => r.stop.stop_id)).toEqual(["FAR"]);
    expect(fit.outOfOrder.map((r) => r.stop.stop_id)).toEqual(["B"]);
    expect(fit.results[0].distM).toBeLessThan(1);
  });

  it("accepts stop_lat/stop_lon fields and ignores invalid coordinates", () => {
    const fit = analyzeStopFit(LINE, [
      { stop_id: "A", stop_lat: "48.85", stop_lon: "2.302" },
      { stop_id: "BAD", stop_lat: "", stop_lon: null },
    ]);
    expect(fit.results.length).toBe(1);
    expect(fit.results[0].stop.stop_id).toBe("A");
  });

  it("returns nothing for a degenerate polyline", () => {
    expect(analyzeStopFit([LINE[0]], [{ lat: 1, lon: 1 }]).results).toEqual([]);
  });
});
