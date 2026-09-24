/**
 * basemapConfig — where the map tiles come from.
 *
 * The theme-following basemap ("auto") is rendered as VECTOR tiles by
 * MapLibre GL: crisp at every zoom, and one request per z14 tile that is
 * then overzoomed for free — a fraction of what raster tiles bill when a
 * stop editor works at z18. Raster tiles remain for the OpenStreetMap and
 * satellite choices, and as the fallback when WebGL is unavailable.
 *
 * Provider — build-time env (VITE_BASEMAP_PROVIDER, or inferred from the key):
 *   carto        CARTO Positron / Dark Matter, VITE_CARTO_API_KEY.
 *                Keyless tiles are watermarked "API KEY REQUIRED" since
 *                2026-09-23; free up to 1M requests a month for commercial
 *                use, paid beyond.
 *   maptiler     MapTiler dataviz light / dark, VITE_MAPTILER_KEY
 *                (Flex plan for commercial use). Also serves the satellite.
 *   openfreemap  OpenFreeMap positron / dark — no key, no limit, funded by
 *                donations. The default when no key is configured.
 *
 * Every host used here must be allowed in the production CSP
 * (security-headers.conf: img-src, connect-src).
 */

const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Zoom ceiling of the vector basemap (Leaflet bound; MapLibre clamps at 22). */
export const VECTOR_MAX_ZOOM = 20;

export const OSM_RASTER = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: OSM_ATTRIBUTION,
  maxZoom: 19,
};

export const ESRI_SATELLITE = {
  url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
  maxZoom: 19,
};

const withKey = (url, key) => (key ? `${url}${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}` : url);

/**
 * Resolve the provider from an env object ({ VITE_BASEMAP_PROVIDER,
 * VITE_CARTO_API_KEY, VITE_MAPTILER_KEY }). Pure, so tests pass their own.
 */
export const resolveProvider = (env = {}) => {
  const cartoKey = String(env.VITE_CARTO_API_KEY || "").trim();
  const maptilerKey = String(env.VITE_MAPTILER_KEY || "").trim();
  const wanted = String(env.VITE_BASEMAP_PROVIDER || "").trim().toLowerCase();
  const id = ["carto", "maptiler", "openfreemap"].includes(wanted) ? wanted : cartoKey ? "carto" : maptilerKey ? "maptiler" : "openfreemap";

  if (id === "carto") {
    return {
      id,
      name: "CARTO",
      keyed: Boolean(cartoKey),
      attribution: `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
      styleUrl: (dark) => withKey(`https://basemaps.cartocdn.com/gl/${dark ? "dark-matter" : "positron"}-gl-style/style.json`, cartoKey),
      rasterUrl: (dark) => withKey(`https://basemaps.cartocdn.com/rastertiles/${dark ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`, cartoKey),
      rasterMaxZoom: 20,
      satellite: null,
      // The style's tile, sprite and glyph URLs may not carry the key: add it
      // to every CARTO request that lacks one.
      transformRequest: cartoKey ? (url) => (/\bcartocdn\.com\//.test(url) && !/[?&]key=/.test(url) ? { url: withKey(url, cartoKey) } : undefined) : null,
    };
  }
  if (id === "maptiler") {
    return {
      id,
      name: "MapTiler",
      keyed: Boolean(maptilerKey),
      attribution: `${OSM_ATTRIBUTION} &copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a>`,
      styleUrl: (dark) => withKey(`https://api.maptiler.com/maps/${dark ? "dataviz-dark" : "dataviz-light"}/style.json`, maptilerKey),
      rasterUrl: (dark) => withKey(`https://api.maptiler.com/maps/${dark ? "dataviz-dark" : "dataviz-light"}/256/{z}/{x}/{y}{r}.png`, maptilerKey),
      rasterMaxZoom: 20,
      satellite: {
        url: withKey("https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg", maptilerKey),
        attribution: `${OSM_ATTRIBUTION} &copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a>`,
        maxZoom: 20,
        // 512 px tiles: one request covers what four 256 px tiles would.
        tileSize: 512,
        zoomOffset: -1,
      },
      transformRequest: null,
    };
  }
  return {
    id: "openfreemap",
    name: "OpenFreeMap",
    keyed: false,
    attribution: `${OSM_ATTRIBUTION} &copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/">OpenMapTiles</a>`,
    styleUrl: (dark) => `https://tiles.openfreemap.org/styles/${dark ? "dark" : "positron"}`,
    // No raster service: the fallback is OpenStreetMap, inverted in dark mode.
    rasterUrl: null,
    rasterMaxZoom: 19,
    satellite: null,
    transformRequest: null,
  };
};

/**
 * What the theme-following basemap renders, given the environment:
 * { kind: "vector", styleUrl, … } when WebGL works and the style did not
 * fail, else { kind: "raster", url, attribution, maxZoom, className }.
 * Without WebGL the provider is fine and only the renderer is missing, so
 * its own raster tiles serve (keyed, billable, correct). When the vector
 * style FAILED (refused key, outage, dead tiles) the provider itself is not
 * to be trusted: OpenStreetMap takes over, inverted in dark mode.
 */
export const pickAutoLayer = ({ provider, isDark, webgl, failed }) => {
  if (webgl && !failed) return { kind: "vector", styleUrl: provider.styleUrl(isDark), attribution: provider.attribution, transformRequest: provider.transformRequest };
  if (!webgl && !failed && provider.rasterUrl) return { kind: "raster", url: provider.rasterUrl(isDark), attribution: provider.attribution, maxZoom: provider.rasterMaxZoom, className: undefined };
  return { kind: "raster", url: OSM_RASTER.url, attribution: OSM_RASTER.attribution, maxZoom: OSM_RASTER.maxZoom, className: isDark ? "gtfs-basemap-dark-filter" : undefined };
};

export const BASEMAP_PROVIDER = resolveProvider(import.meta.env || {});
