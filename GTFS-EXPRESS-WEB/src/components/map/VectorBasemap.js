/**
 * VectorBasemap — a MapLibre GL vector basemap inside a react-leaflet map.
 *
 * MapLibre and its Leaflet bridge load on demand, so the bundle only pays
 * for them when a map is shown. The style follows the theme without a
 * remount (setStyle). When the basemap cannot work — no WebGL, a refused
 * key, a provider outage, tiles that never arrive — `onFail` fires once and
 * the caller falls back to raster tiles.
 */

import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "maplibre-gl/dist/maplibre-gl.css";

const LOAD_TIMEOUT_MS = 20000;
const FATAL_STATUSES = new Set([401, 402, 403, 404]);
// Tiles failing before any tile ever rendered: the tile server is down.
const TILE_ERRORS_BEFORE_FALLBACK = 8;

let webglSupport = null;
/** Whether this browser can render MapLibre (memoised). */
export const hasWebGL = () => {
  if (webglSupport != null) return webglSupport;
  try {
    const canvas = document.createElement("canvas");
    webglSupport = Boolean(window.WebGLRenderingContext && (canvas.getContext("webgl2") || canvas.getContext("webgl")));
  } catch {
    webglSupport = false;
  }
  return webglSupport;
};
/** MapLibre could not get a context after all (GPU reset, memory pressure): stay raster for the session. */
export const markWebGLUnavailable = () => {
  webglSupport = false;
};

/**
 * Leaflet registers a layer (map._layers, move/zoom listeners, its pane
 * container) BEFORE calling onAdd. When MapLibre throws inside onAdd, the
 * bridge's onRemove would throw too (no GL map): unhook the dead layer by
 * hand so the map keeps panning and zooming.
 */
const detachDeadLayer = (map, layer) => {
  try {
    map.off(layer.getEvents(), layer);
  } catch {
    /* no events */
  }
  try {
    const id = L.Util.stamp(layer);
    if (map._layers && map._layers[id] === layer) delete map._layers[id];
  } catch {
    /* not registered */
  }
  try {
    layer._map = null;
    if (layer._container && layer._container.parentNode) layer._container.parentNode.removeChild(layer._container);
  } catch {
    /* no container */
  }
};

export default function VectorBasemap({ styleUrl, attribution, transformRequest = null, maxZoom = 20, onFail = null }) {
  const map = useMap();
  const layerRef = useRef(null);
  const glRef = useRef(null);
  const styleRef = useRef(styleUrl);
  const onFailRef = useRef(onFail);
  styleRef.current = styleUrl;
  onFailRef.current = onFail;

  // Create the layer once per map; the style follows separately.
  useEffect(() => {
    let cancelled = false;
    let loaded = false;
    let timer = null;
    let onVisible = null;
    const remove = () => {
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
      onVisible = null;
      if (!layerRef.current) return;
      if (attribution && map.attributionControl) map.attributionControl.removeAttribution(attribution);
      try {
        map.removeLayer(layerRef.current);
      } catch {
        /* already gone */
      }
      layerRef.current = null;
      glRef.current = null;
    };
    const fail = (reason) => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timer);
      remove();
      if (onFailRef.current) onFailRef.current(reason);
    };
    import("@maplibre/maplibre-gl-leaflet")
      .then(({ maplibreGL }) => {
        if (cancelled) return;
        const layer = maplibreGL({
          style: styleRef.current,
          attribution,
          // A Leaflet zoom bound: the map cannot zoom past what MapLibre draws.
          maxZoom,
          interactive: false,
          padding: 0.15,
          attributionControl: false,
          ...(transformRequest ? { transformRequest } : {}),
        });
        try {
          layer.addTo(map);
        } catch (err) {
          detachDeadLayer(map, layer);
          markWebGLUnavailable();
          fail(err);
          return;
        }
        layerRef.current = layer;
        // The bridge reports no attribution when MapLibre's own control is off:
        // credit the data through Leaflet's control (ODbL requires it).
        if (attribution && map.attributionControl) map.attributionControl.addAttribution(attribution);
        const gl = layer.getMaplibreMap();
        glRef.current = gl;
        let tileOk = false;
        let tileErrors = 0;
        const alive = () => {
          loaded = true;
          clearTimeout(timer);
        };
        // style.load fires from the fetch callback (the style and its key are
        // accepted); load only fires from a rendered frame, which a hidden tab
        // never produces.
        gl.once("style.load", alive);
        gl.on("load", alive);
        gl.on("data", (e) => {
          if (e && e.tile) tileOk = true;
        });
        gl.on("error", (e) => {
          const status = e?.error?.status;
          if (e?.tile) {
            // One lost tile is nothing; a refused key or a dead tile server
            // before any tile rendered is the whole basemap.
            tileErrors += 1;
            if (!tileOk && (FATAL_STATUSES.has(status) || tileErrors >= TILE_ERRORS_BEFORE_FALLBACK)) fail(e?.error || new Error("basemap tiles failed"));
            return;
          }
          if (FATAL_STATUSES.has(status) || !loaded) fail(e?.error || new Error("basemap style failed"));
        });
        const arm = () => {
          timer = setTimeout(() => {
            if (loaded || (typeof gl.isStyleLoaded === "function" && gl.isStyleLoaded())) return;
            if (document.visibilityState === "hidden") {
              // Nothing renders in a hidden tab: judge again once it is shown.
              onVisible = () => {
                onVisible = null;
                arm();
              };
              document.addEventListener("visibilitychange", onVisible, { once: true });
              return;
            }
            fail(new Error("basemap style timed out"));
          }, LOAD_TIMEOUT_MS);
        };
        arm();
      })
      .catch(fail);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      remove();
    };
    // The style and the request transform are read through refs / are
    // constant for a provider: only the map identity recreates the layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map]);

  // Theme change: swap the style in place.
  useEffect(() => {
    const gl = glRef.current;
    if (gl && typeof gl.setStyle === "function") gl.setStyle(styleUrl);
  }, [styleUrl]);

  return null;
}
