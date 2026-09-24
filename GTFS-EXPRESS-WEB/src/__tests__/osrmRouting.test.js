import { describe, it, expect, vi, afterEach } from "vitest";
import { routeThroughStops } from "../utils/osrmRouting";

const stop = (i) => ({ lat: 48.85 + i * 0.001, lon: 2.3 + i * 0.001 });

// Fake OSRM: echoes the requested waypoints plus one midpoint per pair, so
// the routed polyline is recognisable in the assertions.
const okResponse = (url) => {
  const coordPart = url.split("/driving/")[1].split("?")[0];
  const wps = coordPart.split(";").map((c) => c.split(",").map(Number));
  const coords = [];
  for (let i = 0; i < wps.length; i++) {
    if (i > 0) {
      coords.push([(wps[i - 1][0] + wps[i][0]) / 2, (wps[i - 1][1] + wps[i][1]) / 2]);
    }
    coords.push(wps[i]);
  }
  return {
    ok: true,
    json: async () => ({ code: "Ok", routes: [{ geometry: { coordinates: coords } }] }),
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routeThroughStops", () => {
  it("routes many stops in a few multi-waypoint requests, sharing boundary stops", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(url);
        return okResponse(url);
      }),
    );
    const stops = Array.from({ length: 40 }, (_, i) => stop(i));
    const progress = [];
    const { points, fallbacks } = await routeThroughStops(stops, {
      onProgress: (d, t) => progress.push([d, t]),
    });
    // 40 stops → 39 pairs → chunks of 25 waypoints (24 pairs) → 2 requests.
    expect(calls.length).toBe(2);
    expect(fallbacks).toBe(0);
    // Every stop is on the polyline, in order, with one midpoint per pair.
    expect(points.length).toBe(40 + 39);
    expect(points[0]).toEqual(stop(0));
    expect(points[points.length - 1]).toEqual(stop(39));
    expect(progress[progress.length - 1]).toEqual([39, 39]);
  });

  it("falls back to straight segments for a chunk OSRM cannot route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ code: "NoRoute" }) })),
    );
    const stops = [stop(0), stop(1), stop(2)];
    const { points, fallbacks } = await routeThroughStops(stops);
    expect(points).toEqual(stops.map((s) => ({ lat: s.lat, lon: s.lon })));
    expect(fallbacks).toBe(2);
  });

  it("propagates an abort", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => okResponse(url)));
    const controller = new AbortController();
    controller.abort();
    await expect(
      routeThroughStops([stop(0), stop(1)], { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
