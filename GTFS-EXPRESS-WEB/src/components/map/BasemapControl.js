import React, { useState, useEffect, useCallback } from "react";
import { TileLayer } from "react-leaflet";
import { IconButton, Menu, MenuItem, ListItemIcon, ListItemText, Tooltip } from "@mui/material";
import LayersIcon from "@mui/icons-material/Layers";
import MapIcon from "@mui/icons-material/Map";
import SatelliteAltIcon from "@mui/icons-material/SatelliteAlt";
import BrightnessAutoIcon from "@mui/icons-material/BrightnessAuto";
import { useLanguage } from "../../contexts/LanguageContext";
import { BASEMAP_PROVIDER, OSM_RASTER, ESRI_SATELLITE, VECTOR_MAX_ZOOM, pickAutoLayer } from "./basemapConfig";
import VectorBasemap, { hasWebGL } from "./VectorBasemap";
import "./basemap.css";

// Base maps the user can switch between. "auto" follows the app theme with
// the configured provider's light / dark vector style (basemapConfig.js).
// Tile hosts must be allowed in the production CSP (security-headers.conf).
export const BASEMAPS = {
  auto: {
    labelKey: "map.basemap.auto",
    Icon: BrightnessAutoIcon,
  },
  osm: {
    labelKey: "map.basemap.osm",
    Icon: MapIcon,
    ...OSM_RASTER,
  },
  satellite: {
    labelKey: "map.basemap.satellite",
    Icon: SatelliteAltIcon,
    // MapTiler's satellite when a MapTiler key is configured, Esri otherwise.
    ...(BASEMAP_PROVIDER.satellite || ESRI_SATELLITE),
  },
};

const STORAGE_KEY = "gtfs_basemap";

const readStored = () => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && BASEMAPS[v] ? v : "auto";
  } catch {
    return "auto";
  }
};

// Persisted basemap choice shared by every map on the page.
export function useBasemap() {
  const [basemap, setBasemapState] = useState(readStored);
  useEffect(() => {
    const onChange = (e) => setBasemapState(e.detail?.basemap || readStored());
    window.addEventListener("gtfs:basemap-changed", onChange);
    return () => window.removeEventListener("gtfs:basemap-changed", onChange);
  }, []);
  const setBasemap = useCallback((next) => {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode */
    }
    setBasemapState(next);
    window.dispatchEvent(
      new CustomEvent("gtfs:basemap-changed", { detail: { basemap: next } }),
    );
  }, []);
  return [basemap, setBasemap];
}

// The tile layer for the chosen basemap. "auto" follows the app theme: the
// provider's vector style through MapLibre, or raster tiles when WebGL is
// unavailable or the style failed (refused key, outage).
export function BasemapTileLayer({ basemap, isDark }) {
  const [vectorFailed, setVectorFailed] = useState(false);
  const onFail = useCallback((reason) => {
    console.warn("Vector basemap unavailable, falling back to raster tiles:", reason?.message || reason);
    setVectorFailed(true);
  }, []);
  if (basemap === "auto" || !BASEMAPS[basemap]) {
    const layer = pickAutoLayer({ provider: BASEMAP_PROVIDER, isDark, webgl: hasWebGL(), failed: vectorFailed });
    if (layer.kind === "vector") {
      return <VectorBasemap styleUrl={layer.styleUrl} attribution={layer.attribution} transformRequest={layer.transformRequest} maxZoom={VECTOR_MAX_ZOOM} onFail={onFail} />;
    }
    return (
      <TileLayer
        key={`raster-${isDark ? "dark" : "light"}`}
        url={layer.url}
        attribution={layer.attribution}
        maxZoom={layer.maxZoom}
        className={layer.className}
      />
    );
  }
  const def = BASEMAPS[basemap];
  return (
    <TileLayer
      key={basemap}
      url={def.url}
      attribution={def.attribution}
      maxZoom={def.maxZoom}
      {...(def.tileSize ? { tileSize: def.tileSize, zoomOffset: def.zoomOffset || 0 } : {})}
    />
  );
}

// Floating button (top-right, under Leaflet's layers control) opening the
// basemap menu.
export default function BasemapControl({ basemap, onChange, top = 54 }) {
  const { t } = useLanguage();
  const [anchor, setAnchor] = useState(null);
  const CurrentIcon = BASEMAPS[basemap]?.Icon || LayersIcon;
  return (
    <>
      <Tooltip title={t("map.basemap.title")} placement="left" arrow>
        <IconButton
          size="small"
          onClick={(e) => setAnchor(e.currentTarget)}
          aria-label={t("map.basemap.title")}
          data-testid="basemap-control"
          sx={(theme) => ({
            position: "absolute",
            top,
            right: 10,
            zIndex: 1000,
            width: 34,
            height: 34,
            bgcolor: theme.palette.background.paper,
            border: `2px solid rgba(0,0,0,0.2)`,
            borderRadius: 1,
            boxShadow: "0 1px 5px rgba(0,0,0,0.25)",
            "&:hover": { bgcolor: theme.palette.action.hover },
          })}
        >
          <CurrentIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {Object.entries(BASEMAPS).map(([key, def]) => (
          <MenuItem
            key={key}
            selected={key === basemap}
            onClick={() => {
              setAnchor(null);
              onChange(key);
            }}
            data-testid={`basemap-${key}`}
          >
            <ListItemIcon>
              <def.Icon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={t(def.labelKey)} />
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
