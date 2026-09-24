/**
 * basemap.test.js — where the map tiles come from: the provider resolved
 * from the build env (a key selects CARTO or MapTiler, none selects
 * OpenFreeMap), the keyed URLs, the request transform that carries the
 * CARTO key, and the vector-or-raster decision for the theme basemap.
 */

import { describe, expect, it } from "vitest";
import { resolveProvider, pickAutoLayer, OSM_RASTER, ESRI_SATELLITE } from "../components/map/basemapConfig";

describe("resolveProvider", () => {
  it("defaults to OpenFreeMap without any key: free vector styles, OpenStreetMap as raster fallback", () => {
    const p = resolveProvider({});
    expect(p.id).toBe("openfreemap");
    expect(p.keyed).toBe(false);
    expect(p.styleUrl(false)).toBe("https://tiles.openfreemap.org/styles/positron");
    expect(p.styleUrl(true)).toBe("https://tiles.openfreemap.org/styles/dark");
    expect(p.rasterUrl).toBeNull();
    expect(p.satellite).toBeNull();
    expect(p.transformRequest).toBeNull();
    expect(p.attribution).toMatch(/OpenStreetMap.*OpenFreeMap.*OpenMapTiles/);
  });

  it("a CARTO key selects CARTO and rides on every style, tile and raster request", () => {
    const p = resolveProvider({ VITE_CARTO_API_KEY: "abc 123" });
    expect(p.id).toBe("carto");
    expect(p.keyed).toBe(true);
    expect(p.styleUrl(false)).toBe("https://basemaps.cartocdn.com/gl/positron-gl-style/style.json?key=abc%20123");
    expect(p.styleUrl(true)).toBe("https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=abc%20123");
    expect(p.rasterUrl(true)).toBe("https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png?key=abc%20123");
    // The transform adds the key to CARTO requests that lack it, and leaves the rest alone.
    expect(p.transformRequest("https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/3/4/2.mvt")).toEqual({ url: "https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/3/4/2.mvt?key=abc%20123" });
    expect(p.transformRequest("https://basemaps.cartocdn.com/gl/positron-gl-style/sprite.json?key=abc%20123")).toBeUndefined();
    expect(p.transformRequest("https://fonts.example/glyphs/0-255.pbf")).toBeUndefined();
  });

  it("a MapTiler key selects MapTiler, including its satellite", () => {
    const p = resolveProvider({ VITE_MAPTILER_KEY: "mt" });
    expect(p.id).toBe("maptiler");
    expect(p.styleUrl(false)).toBe("https://api.maptiler.com/maps/dataviz-light/style.json?key=mt");
    expect(p.styleUrl(true)).toBe("https://api.maptiler.com/maps/dataviz-dark/style.json?key=mt");
    expect(p.rasterUrl(false)).toBe("https://api.maptiler.com/maps/dataviz-light/256/{z}/{x}/{y}{r}.png?key=mt");
    expect(p.satellite.url).toBe("https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=mt");
    expect(p.satellite).toMatchObject({ tileSize: 512, zoomOffset: -1 });
    expect(p.transformRequest).toBeNull();
  });

  it("an explicit provider wins over the keys; a CARTO key wins over a MapTiler key", () => {
    expect(resolveProvider({ VITE_BASEMAP_PROVIDER: "openfreemap", VITE_CARTO_API_KEY: "k" }).id).toBe("openfreemap");
    expect(resolveProvider({ VITE_BASEMAP_PROVIDER: "MapTiler", VITE_MAPTILER_KEY: "k" }).id).toBe("maptiler");
    expect(resolveProvider({ VITE_CARTO_API_KEY: "a", VITE_MAPTILER_KEY: "b" }).id).toBe("carto");
    expect(resolveProvider({ VITE_BASEMAP_PROVIDER: "nope" }).id).toBe("openfreemap");
  });
});

describe("pickAutoLayer", () => {
  const ofm = resolveProvider({});
  const carto = resolveProvider({ VITE_CARTO_API_KEY: "k" });

  it("renders the vector style when WebGL works", () => {
    const layer = pickAutoLayer({ provider: ofm, isDark: true, webgl: true, failed: false });
    expect(layer).toMatchObject({ kind: "vector", styleUrl: "https://tiles.openfreemap.org/styles/dark" });
  });

  it("falls back to OpenStreetMap, inverted in dark mode, when the free provider cannot render", () => {
    expect(pickAutoLayer({ provider: ofm, isDark: true, webgl: false, failed: false })).toEqual({ kind: "raster", url: OSM_RASTER.url, attribution: OSM_RASTER.attribution, maxZoom: 19, className: "gtfs-basemap-dark-filter" });
    expect(pickAutoLayer({ provider: ofm, isDark: false, webgl: true, failed: true }).className).toBeUndefined();
  });

  it("without WebGL, a keyed provider serves its own raster tiles", () => {
    const layer = pickAutoLayer({ provider: carto, isDark: false, webgl: false, failed: false });
    expect(layer.kind).toBe("raster");
    expect(layer.url).toBe("https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png?key=k");
    expect(layer.maxZoom).toBe(20);
  });

  it("a failed vector style (refused key, outage) never reuses the same provider: OpenStreetMap takes over", () => {
    const maptiler = resolveProvider({ VITE_MAPTILER_KEY: "rotated" });
    for (const provider of [carto, maptiler]) {
      const layer = pickAutoLayer({ provider, isDark: true, webgl: true, failed: true });
      expect(layer).toEqual({ kind: "raster", url: OSM_RASTER.url, attribution: OSM_RASTER.attribution, maxZoom: 19, className: "gtfs-basemap-dark-filter" });
    }
  });

  it("keeps the public raster choices intact", () => {
    expect(OSM_RASTER.url).toMatch(/tile\.openstreetmap\.org/);
    expect(ESRI_SATELLITE.url).toMatch(/arcgisonline/);
  });
});
