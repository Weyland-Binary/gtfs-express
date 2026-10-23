import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import {
  MapContainer,
  Polyline,
  Marker,
  CircleMarker,
  useMap,
  useMapEvents,
  LayerGroup,
  LayersControl,
  ScaleControl,
  Tooltip as LeafletTooltip,
} from "react-leaflet";
import { useLeafletContext } from "@react-leaflet/core";
import { useTheme } from "@mui/material/styles";
import {
  Fab,
  Tooltip,
  Menu,
  MenuItem,
  Divider,
  ListItemIcon,
  ListItemText,
  Chip,
  IconButton,
  Popover,
  Box,
  Typography,
} from "@mui/material";
import AddLocationAltIcon from "@mui/icons-material/AddLocationAlt";
import EditNoteIcon from "@mui/icons-material/EditNote";
import PinDropIcon from "@mui/icons-material/PinDrop";
import TimelineIcon from "@mui/icons-material/Timeline";
import OpenWithIcon from "@mui/icons-material/OpenWith";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import TouchAppIcon from "@mui/icons-material/TouchApp";
import AddIcon from "@mui/icons-material/Add";
import MarkerClusterGroup from "react-leaflet-cluster";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import "leaflet-polylinedecorator";

import StopFloatingCard from "./StopFloatingCard";
import EditStopDialog from "./edit/EditStopDialog";
import ShapeEditorOverlay from "./edit/ShapeEditorOverlay";
import BasemapControl, {
  BasemapTileLayer,
  useBasemap,
} from "./map/BasemapControl";
import { useDetailPanel } from "../contexts/DetailPanelContext";
import { useEditMode } from "../contexts/EditModeContext";
import { useLanguage } from "../contexts/LanguageContext";
import { fetchWithSession } from "../utils/sessionManager";
import API_BASE_URL from "../config";

// Module scope keeps its identity across LineMap renders: an inline component would remount on every parent render
// and pan only by accident of that remount.
function PanToCreated({ createdStop }) {
  const map = useMap();
  useEffect(() => {
    if (createdStop?.stop_lat != null && createdStop?.stop_lon != null) {
      map.flyTo(
        [parseFloat(createdStop.stop_lat), parseFloat(createdStop.stop_lon)],
        16,
        { duration: 0.8 },
      );
    }
  }, [map, createdStop]);
  return null;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function formatMeters(m) {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)} km`;
  return `${Math.round(m)} m`;
}

export const SHAPE_PALETTE = [
  "#1976d2",
  "#e91e63",
  "#4caf50",
  "#ff9800",
  "#9c27b0",
  "#00bcd4",
  "#f44336",
  "#8bc34a",
  "#ff5722",
  "#607d8b",
];

function FitBounds({ shapesById, stops, focusedStopId }) {
  const map = useMap();
  const prevFocusRef = useRef(null);
  const prevDatasetKeyRef = useRef(null);

  // Every edit refetches new arrays for the same dataset: refit only when the set of shapes or stops changes, so the
  // user's zoom survives each change.
  const datasetKey = useMemo(() => {
    const shapeIds = Object.keys(shapesById).sort().join(",");
    const stopIds = stops
      .map((s) => s.stop_id)
      .sort()
      .join(",");
    return `${shapeIds}|${stopIds}`;
  }, [shapesById, stops]);

  useEffect(() => {
    const prevFocus = prevFocusRef.current;
    prevFocusRef.current = focusedStopId;

    // A focused stop's viewport belongs to FlyToFocusedStop.
    if (focusedStopId) return;
    // Focus just cleared: FlyToFocusedStop animates the refit.
    if (prevFocus) return;
    if (prevDatasetKeyRef.current === datasetKey) return;
    prevDatasetKeyRef.current = datasetKey;

    const shapeArrays = Object.values(shapesById);
    if (shapeArrays.length > 0 || stops.length > 0) {
      const bounds = L.latLngBounds([]);
      shapeArrays.forEach((shape) => {
        shape.forEach((point) => {
          bounds.extend([point[0], point[1]]);
        });
      });
      stops.forEach((stop) => {
        const lat = parseFloat(stop.stop_lat);
        const lon = parseFloat(stop.stop_lon);
        if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
          bounds.extend([lat, lon]);
        }
      });
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [50, 50] });
      }
    }
  }, [shapesById, stops, map, focusedStopId, datasetKey]);

  return null;
}

// Flies to the stop picked in the search, and back to the full view when the search is cleared.
function FlyToFocusedStop({ stops, focusedStopId, shapesById }) {
  const map = useMap();
  const prevIdRef = useRef(null);
  // Snaps (setView) the first time, e.g. back from another tab with a focus already set, instead of replaying the
  // flyTo on every mount.
  const justMountedRef = useRef(true);
  useEffect(() => {
    const prev = prevIdRef.current;

    // A re-run caused only by new stops / shapesById references leaves the map where it is.
    if (!justMountedRef.current && prev === focusedStopId) return;

    prevIdRef.current = focusedStopId;

    if (focusedStopId) {
      const stop = stops.find((s) => s.stop_id === focusedStopId);
      if (!stop) return;
      const lat = parseFloat(stop.stop_lat);
      const lon = parseFloat(stop.stop_lon);
      if (Number.isNaN(lat) || Number.isNaN(lon)) return;
      const zoom = Math.max(map.getZoom(), 17);
      if (justMountedRef.current) {
        map.setView([lat, lon], zoom, { animate: false });
      } else {
        map.flyTo([lat, lon], zoom, { duration: 0.8 });
      }
      justMountedRef.current = false;
      return;
    }

    justMountedRef.current = false;
    // focusedStopId just became null AFTER a previous focus → refit full view
    if (prev) {
      const bounds = L.latLngBounds([]);
      Object.values(shapesById || {}).forEach((shape) => {
        shape.forEach((point) => bounds.extend([point[0], point[1]]));
      });
      stops.forEach((stop) => {
        const lat = parseFloat(stop.stop_lat);
        const lon = parseFloat(stop.stop_lon);
        if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
          bounds.extend([lat, lon]);
        }
      });
      if (bounds.isValid()) {
        map.flyToBounds(bounds, { padding: [50, 50], duration: 0.8 });
      }
    }
  }, [focusedStopId, stops, shapesById, map]);
  return null;
}

// Refits to the whole route when the shape editor closes, so a discard does not leave the map zoomed on the edited
// shape. Skipped while a stop is focused (FlyToFocusedStop owns the viewport then).
function RefitOnShapeEditorClose({ shapesById, stops, focusedStopId }) {
  const map = useMap();
  const shapesRef = useRef(shapesById);
  const stopsRef = useRef(stops);
  const focusRef = useRef(focusedStopId);
  shapesRef.current = shapesById;
  stopsRef.current = stops;
  focusRef.current = focusedStopId;

  useEffect(() => {
    const onClosed = () => {
      if (focusRef.current) return;
      const bounds = L.latLngBounds([]);
      Object.values(shapesRef.current || {}).forEach((shape) => {
        shape.forEach((pt) => bounds.extend([pt[0], pt[1]]));
      });
      (stopsRef.current || []).forEach((s) => {
        const lat = parseFloat(s.stop_lat);
        const lon = parseFloat(s.stop_lon);
        if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
          bounds.extend([lat, lon]);
        }
      });
      if (bounds.isValid()) {
        map.flyToBounds(bounds, { padding: [50, 50], duration: 0.8 });
      }
    };
    window.addEventListener("shapeEditorClosed", onClosed);
    return () => window.removeEventListener("shapeEditorClosed", onClosed);
  }, [map]);

  return null;
}

function FlyToShape({ shapesById, allRouteShapes, focusedShapeId }) {
  const map = useMap();
  useEffect(() => {
    if (!focusedShapeId) return;
    // Try current-direction shapes first, then fall back to all-route shapes
    const pts = shapesById[focusedShapeId] || allRouteShapes[focusedShapeId];
    if (!pts || pts.length === 0) return;
    const bounds = L.latLngBounds(pts);
    map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16 });
  }, [focusedShapeId, shapesById, allRouteShapes, map]);
  return null;
}

// Parent stations as halos in the overlay pane, under the stops' markers, so a station never hides a platform; the
// radius follows the zoom.
const metresPerPixel = (lat, zoom) => (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** (zoom + 8);
const distanceM = (a, b) => {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};

// stations: [{ id, name, points: [[lat, lon]] }]
function StationHalos({ stations = [], ring, fill, onOpen }) {
  const map = useMap();
  const [zoom, setZoom] = useState(map.getZoom());
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });
  return stations.map((st) => {
    const lat = st.points.reduce((a, p) => a + p[0], 0) / st.points.length;
    const lon = st.points.reduce((a, p) => a + p[1], 0) / st.points.length;
    const spreadM = Math.max(0, ...st.points.map((p) => distanceM([lat, lon], p)));
    const radius = Math.min(60, Math.max(11, spreadM / metresPerPixel(lat, zoom) + 10));
    return (
      <CircleMarker
        key={`station-${st.id}`}
        center={[lat, lon]}
        radius={radius}
        color={ring}
        weight={2}
        opacity={0.85}
        fillColor={fill}
        fillOpacity={0.9}
        eventHandlers={{ click: () => onOpen(st.id) }}
      >
        <LeafletTooltip direction="top" offset={[0, -radius]}>
          {st.name}
        </LeafletTooltip>
      </CircleMarker>
    );
  });
}

const ARROW_MIN_ZOOM = 12;

// entries: [{ points: [[lat,lon]], color, emphasize }] — arrows follow each
// shape's own point order, so they encode that shape's direction of travel.
function ShapeArrows({ entries = [] }) {
  const context = useLeafletContext();
  const container = context.layerContainer || context.map;
  const map = context.map;
  const [zoom, setZoom] = useState(map.getZoom());

  useMapEvents({ zoomend: () => setZoom(map.getZoom()) });

  // Primitive signature so the effect re-runs only when the meaningful inputs
  // change (not on every parent render, which would flicker the decorators).
  const sig = entries
    .map(
      (e) =>
        `${e.color}:${e.emphasize ? 1 : 0}:${e.points.length}:${
          e.points[0]?.join(",") || ""
        }:${e.points[e.points.length - 1]?.join(",") || ""}`,
    )
    .join("|");

  // Read entries via a ref so the effect depends only on `sig` (the meaningful
  // change) — no exhaustive-deps churn, no per-render flicker.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => {
    const current = entriesRef.current;
    if (zoom < ARROW_MIN_ZOOM || current.length === 0) return undefined;

    const repeat = zoom >= 16 ? 80 : zoom >= 14 ? 120 : 200;
    const decorators = current.map(({ points, color, emphasize }) => {
      const size = emphasize ? (zoom >= 15 ? 15 : 12) : zoom >= 15 ? 11 : 9;
      const op = emphasize ? 0.95 : 0.55;
      const decorator = L.polylineDecorator(points, {
        patterns: [
          {
            offset: "50px",
            repeat,
            symbol: L.Symbol.arrowHead({
              pixelSize: size,
              polygon: true,
              pathOptions: {
                color,
                fillColor: color,
                fillOpacity: op,
                weight: 1,
                opacity: op,
              },
            }),
          },
        ],
      });
      container.addLayer(decorator);
      return decorator;
    });

    return () => decorators.forEach((d) => container.removeLayer(d));
  }, [sig, zoom, container, map]);

  return null;
}

// Active only in « Place on map » mode.
function MapClickHandler({ placingStop, onPlaceStop }) {
  useMapEvents({
    click(e) {
      if (!placingStop) return;
      onPlaceStop({ lat: e.latlng.lat, lon: e.latlng.lng });
    },
  });
  return null;
}

// A map mounted in a freshly shown tab can measure 0×0 before layout settles: recompute its size once.
function InvalidateSizeOnMount() {
  const map = useMap();
  useEffect(() => {
    const id = setTimeout(() => map.invalidateSize(), 0);
    return () => clearTimeout(id);
  }, [map]);
  return null;
}

// Recentres the map on the shape selected in the Shape Studio's rail.
function FlyToSelectedShape({ shapesById, selectedShapeId }) {
  const map = useMap();
  // Read shapes via a ref so re-fitting fires ONLY when the selection changes,
  // never when shapesById is replaced by an unrelated edit refetch.
  const shapesRef = useRef(shapesById);
  shapesRef.current = shapesById;
  useEffect(() => {
    if (!selectedShapeId) return;
    const pts = shapesRef.current[selectedShapeId];
    if (!pts || pts.length === 0) return;
    const latlngs = pts
      .map((p) => [p[0], p[1]])
      .filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
    if (latlngs.length === 0) return;
    const bounds = L.latLngBounds(latlngs);
    if (bounds.isValid()) {
      map.flyToBounds(bounds, {
        padding: [60, 60],
        maxZoom: 16,
        duration: 0.6,
      });
    }
  }, [selectedShapeId, map]);
  return null;
}

function LineMap({
  shapesById = {},
  allRouteShapes = {},
  stops,
  editShapeRequest = null,
  focusedStopId = null,
  // chrome="studio" suppresses LineMap's own FAB + help button so the Shape
  // Studio shell can supply those affordances around a full-bleed map.
  chrome = "default",
  // studioMode "shapes"|"stops" gates whether stops are draggable (only in the
  // Studio's "Arrêts" mode), removing vertex/stop click ambiguity.
  studioMode = "shapes",
  // When set, the matching polyline is rendered bold (the "selected" shape) and
  // every polyline click is routed to onShapeClick instead of the detail panel.
  selectedShapeId = null,
  onShapeClick = null,
  // Two-way hover sync with the Shape Studio rail: hoveredShapeId emphasises a
  // polyline; onShapeHover reports map-side hover back to the rail.
  hoveredShapeId = null,
  onShapeHover = null,
  // Studio: double-clicking a polyline opens it in the editor.
  onShapeDoubleClick = null,
  // A monotonic counter the parent bumps to arm "place a stop on the map" mode.
  placeStopSignal = 0,
  // Ordered stops the shape being edited should serve (Shape Studio) —
  // drives the editor's numbered badges and fit feedback.
  editorStops = null,
  // Extra polylines rendered read-only under the route's shapes (e.g. an
  // unassigned shape previewed from the Studio rail).
  extraShapes = null,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel, entity, panelOpen } = useDetailPanel();
  const { editing, patchStop, recordEdit, showToast, stopOverrides } =
    useEditMode();
  const focusedShapeId =
    panelOpen && entity?.type === "shape" ? entity.id : null;
  const { t } = useLanguage();
  const [createStopOpen, setCreateStopOpen] = useState(false);
  const [createCoords, setCreateCoords] = useState(null);
  const [createdStop, setCreatedStop] = useState(null);
  const [editingShapeId, setEditingShapeId] = useState(null);
  const [placingStop, setPlacingStop] = useState(false);
  const [fabMenuAnchor, setFabMenuAnchor] = useState(null);
  const [helpAnchor, setHelpAnchor] = useState(null);
  const [highlightedStop, setHighlightedStop] = useState(null);
  const [basemap, setBasemap] = useBasemap();

  // Short-lived ring marker around a stop the user just picked in the
  // carto autocomplete search. Fades out after ~2.5s.
  useEffect(() => {
    if (!focusedStopId) return;
    const stop = stops.find((s) => s.stop_id === focusedStopId);
    if (!stop) return;
    setHighlightedStop(stop);
    const timer = setTimeout(() => setHighlightedStop(null), 2500);
    return () => clearTimeout(timer);
  }, [focusedStopId, stops]);

  useEffect(() => {
    const onActive = (e) => setEditingShapeId(e.detail?.shapeId ?? null);
    const onClosed = () => setEditingShapeId(null);
    window.addEventListener("shapeEditorActive", onActive);
    window.addEventListener("shapeEditorClosed", onClosed);
    return () => {
      window.removeEventListener("shapeEditorActive", onActive);
      window.removeEventListener("shapeEditorClosed", onClosed);
    };
  }, []);

  const shapeEntries = useMemo(() => Object.entries(shapesById), [shapesById]);

  // Shapes from other directions (in allRouteShapes but NOT in shapesById)
  const otherDirShapes = useMemo(() => {
    const entries = [];
    for (const [sid, pts] of Object.entries(allRouteShapes)) {
      if (!shapesById[sid]) entries.push([sid, pts]);
    }
    return entries;
  }, [allRouteShapes, shapesById]);
  // Total shape count across all directions (for "multiple shapes" behavior)
  const totalShapeCount = shapeEntries.length + otherDirShapes.length;

  const handlePlaceStop = useCallback((coords) => {
    setPlacingStop(false);
    setCreateCoords(coords);
    setCreateStopOpen(true);
  }, []);

  useEffect(() => {
    if (!placingStop) return;
    const onKey = (e) => {
      if (e.key === "Escape") setPlacingStop(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placingStop]);

  useEffect(() => {
    if (editingShapeId) setPlacingStop(false);
  }, [editingShapeId]);

  // Guarded on a truthy counter so the initial mount (0) is a no-op.
  useEffect(() => {
    if (placeStopSignal) setPlacingStop(true);
  }, [placeStopSignal]);

  const handleStopCreated = useCallback(
    (stopData) => {
      if (stopData.stop_lat != null && stopData.stop_lon != null) {
        setCreatedStop(stopData);
      }
      openPanel("stop", stopData.stop_id);
    },
    [openPanel],
  );

  useEffect(() => {
    if (!createdStop) return;
    const timer = setTimeout(() => setCreatedStop(null), 12000);
    return () => clearTimeout(timer);
  }, [createdStop]);


  // Memoized: otherwise react-leaflet calls marker.setIcon() on every render, rebuilding the DOM mid-drag. Their
  // hover growth is in GTFSApp.css (.gtfs-stop-dot).
  const dotColors = `--ring:${theme.palette.primary.main};--fill:${theme.palette.background.paper}`;
  const stopIcon = useMemo(
    () =>
      L.divIcon({
        html: `<span class="gtfs-stop-dot" style="${dotColors}"></span>`,
        className: "gtfs-stop-marker",
        iconSize: [16, 16],
        iconAnchor: [8, 8],
        popupAnchor: [0, -8],
      }),
    [dotColors],
  );

  // A pulsing ring under the usual glyph draws the eye to the stop just created.
  const newStopIcon = useMemo(
    () =>
      L.divIcon({
        html: `
          <div class="gtfs-new-stop-wrap gtfs-new-stop-wrap--dot">
            <div class="gtfs-new-stop-pulse"></div>
            <span class="gtfs-stop-dot" style="${dotColors}"></span>
          </div>`,
        className: "gtfs-stop-marker gtfs-new-stop-marker",
        iconSize: [16, 16],
        iconAnchor: [8, 8],
        popupAnchor: [0, -8],
      }),
    [dotColors],
  );

  // A per-marker origin in a ref keeps each marker's baseline after an optimistic patchStop.
  const dragOriginsRef = useRef({});
  // Hides the hover card so it does not overlap the moving marker.
  const [stopDragging, setStopDragging] = useState(false);

  const handleStopDragStart = useCallback(
    (stop) => (e) => {
      const ll = e.target.getLatLng();
      dragOriginsRef.current[stop.stop_id] = { lat: ll.lat, lon: ll.lng };
      setHoveredStop(null);
      setStopDragging(true);
    },
    [],
  );

  const handleStopDragEnd = useCallback(
    (stop) => async (e) => {
      setStopDragging(false);
      const marker = e.target;
      const { lat, lng } = marker.getLatLng();
      const origin = dragOriginsRef.current[stop.stop_id] || {
        lat: parseFloat(stop.stop_lat),
        lon: parseFloat(stop.stop_lon),
      };
      const newLat = Math.round(lat * 1e6) / 1e6;
      const newLon = Math.round(lng * 1e6) / 1e6;
      const dist = haversineMeters(origin.lat, origin.lon, newLat, newLon);
      // Ignore sub-10cm jitter (accidental click-drag) — snap back silently
      if (dist < 0.1) {
        marker.setLatLng([origin.lat, origin.lon]);
        return;
      }
      // Optimistic override so ScheduleGrid and other consumers see new coords
      patchStop({
        stop_id: stop.stop_id,
        stop_lat: newLat,
        stop_lon: newLon,
      });
      try {
        const res = await fetchWithSession(
          `${API_BASE_URL}/edit/stops/${encodeURIComponent(stop.stop_id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stop_lat: newLat, stop_lon: newLon }),
          },
        );
        const body = await res.json();
        if (!res.ok) {
          throw new Error((body && body.error) || `HTTP ${res.status}`);
        }
        if (body.stop) {
          patchStop({ ...body.stop, stop_id: stop.stop_id });
        }
        recordEdit(
          t("edit.stop.movedToast", {
            name: stop.stop_name || stop.stop_id,
            dist: formatMeters(dist),
          }),
          body.validation,
          { entity: "stop", entityId: stop.stop_id },
        );
        // Refresh origin to the new position (in case user drags again before refetch)
        dragOriginsRef.current[stop.stop_id] = { lat: newLat, lon: newLon };
      } catch (err) {
        marker.setLatLng([origin.lat, origin.lon]);
        patchStop({
          stop_id: stop.stop_id,
          stop_lat: origin.lat,
          stop_lon: origin.lon,
        });
        showToast(
          t("edit.stop.moveFailed", { error: err.message || "error" }),
          "error",
        );
      }
    },
    [patchStop, recordEdit, showToast, t],
  );

  // Merge any live stop override (coords/name) onto the feed data.
  const applyOverride = useCallback(
    (stop) => {
      const ov = stopOverrides && stopOverrides[stop.stop_id];
      return ov ? { ...stop, ...ov } : stop;
    },
    [stopOverrides],
  );

  // react-leaflet compares positions by reference: a new [lat, lon] on each render would call setLatLng mid-drag and
  // fight the cursor, so an entry is rebuilt only when its coordinates change.
  const positionCacheRef = useRef(new Map());
  const getPosition = useCallback((stop) => {
    const lat = parseFloat(stop.stop_lat);
    const lon = parseFloat(stop.stop_lon);
    const cached = positionCacheRef.current.get(stop.stop_id);
    if (cached && cached[0] === lat && cached[1] === lon) return cached;
    const next = [lat, lon];
    positionCacheRef.current.set(stop.stop_id, next);
    return next;
  }, []);

  // No dragging while the shape editor or « place on map » is on (a click-drag would be ambiguous), outside the Shape
  // Studio's stops mode, or in the read-only Lines chrome.
  const readOnly = chrome === "readonly";
  const stopsDraggable =
    editing &&
    !editingShapeId &&
    !placingStop &&
    !readOnly &&
    (chrome !== "studio" || studioMode === "stops");

  const lineColor = isDark ? "#42a5f5" : "#1976d2";

  const [hoveredStop, setHoveredStop] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const hoverPosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!hoveredStop) return;
    const handleMove = (e) => {
      const dx = e.clientX - hoverPosRef.current.x;
      const dy = e.clientY - hoverPosRef.current.y;
      if (dx * dx + dy * dy > 40 * 40) setHoveredStop(null);
    };
    window.addEventListener("pointermove", handleMove);
    return () => window.removeEventListener("pointermove", handleMove);
  }, [hoveredStop]);

  return (
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        borderRadius: "10px",
        position: "relative",
      }}
    >
      <MapContainer
        center={[0, 0]}
        zoom={2}
        style={{
          height: "100%",
          width: "100%",
          cursor: placingStop ? "crosshair" : undefined,
        }}
        attributionControl
      >
        <BasemapTileLayer basemap={basemap} isDark={isDark} />

        {chrome === "studio" && <InvalidateSizeOnMount />}

        {chrome === "studio" && (
          <FlyToSelectedShape
            shapesById={shapesById}
            selectedShapeId={selectedShapeId}
          />
        )}

        <FitBounds
          shapesById={shapesById}
          stops={stops}
          focusedStopId={focusedStopId}
        />

        <FlyToFocusedStop
          stops={stops}
          focusedStopId={focusedStopId}
          shapesById={shapesById}
        />

        <RefitOnShapeEditorClose
          shapesById={shapesById}
          stops={stops}
          focusedStopId={focusedStopId}
        />

        {highlightedStop &&
          !Number.isNaN(parseFloat(highlightedStop.stop_lat)) &&
          !Number.isNaN(parseFloat(highlightedStop.stop_lon)) && (
            <CircleMarker
              center={[
                parseFloat(highlightedStop.stop_lat),
                parseFloat(highlightedStop.stop_lon),
              ]}
              radius={18}
              pathOptions={{
                color: "#f59e0b",
                weight: 3,
                opacity: 0.9,
                fillColor: "#f59e0b",
                fillOpacity: 0.15,
              }}
              interactive={false}
            />
          )}

        <FlyToShape
          shapesById={shapesById}
          allRouteShapes={allRouteShapes}
          focusedShapeId={focusedShapeId}
        />

        <ScaleControl position="bottomleft" />

        <MapClickHandler
          placingStop={placingStop}
          onPlaceStop={handlePlaceStop}
        />

        {createdStop && createdStop.stop_lat != null && (
          <>
            <PanToCreated createdStop={createdStop} />
            <Marker
              position={[
                parseFloat(createdStop.stop_lat),
                parseFloat(createdStop.stop_lon),
              ]}
              icon={newStopIcon}
              eventHandlers={{
                click: () => openPanel("stop", createdStop.stop_id),
              }}
            />
          </>
        )}

        <LayersControl position="topright">
          <LayersControl.Overlay checked name={t("map.layer.lineShape")}>
            <LayerGroup>
              {editingShapeId ? null : focusedShapeId != null ? (
                (() => {
                  const pts =
                    shapesById[focusedShapeId] ||
                    allRouteShapes[focusedShapeId];
                  if (!pts || pts.length === 0) return null;
                  return (
                    <React.Fragment key={`focused-${focusedShapeId}`}>
                      <ShapeArrows
                        entries={[
                          { points: pts, color: lineColor, emphasize: true },
                        ]}
                      />
                      <Polyline
                        positions={pts}
                        color={lineColor}
                        weight={5}
                        opacity={0.9}
                        eventHandlers={{
                          click: (e) => {
                            L.DomEvent.stopPropagation(e);
                            openPanel("shape", focusedShapeId);
                          },
                        }}
                        pathOptions={{ className: "shape-clickable", lineCap: "round", lineJoin: "round" }}
                      >
                        <LeafletTooltip sticky>
                          <div
                            style={{
                              fontFamily: "system-ui, sans-serif",
                              minWidth: 110,
                            }}
                          >
                            <div
                              style={{
                                fontWeight: 700,
                                fontSize: 13,
                                marginBottom: 2,
                                fontFamily: "monospace",
                              }}
                            >
                              {focusedShapeId}
                            </div>
                            <div style={{ fontSize: 11, color: "#666" }}>
                              {pts.length} {t("map.shapePoints")}
                            </div>
                          </div>
                        </LeafletTooltip>
                      </Polyline>
                    </React.Fragment>
                  );
                })()
              ) : (
                <>
                  {/* In the Studio, with a shape selected, arrows show for that shape only, so they follow its direction. */}
                  <ShapeArrows
                    entries={shapeEntries
                      .map(([sid, points], index) => ({
                        sid,
                        points,
                        color:
                          totalShapeCount > 1
                            ? SHAPE_PALETTE[index % SHAPE_PALETTE.length]
                            : lineColor,
                        emphasize: selectedShapeId
                          ? sid === selectedShapeId
                          : index === 0,
                      }))
                      .filter((e) => e.sid !== editingShapeId)
                      .filter(
                        (e) => !selectedShapeId || e.sid === selectedShapeId,
                      )}
                  />
                  {shapeEntries.map(([shapeId, points], index) => {
                    if (editingShapeId === shapeId) return null;
                    const hasSelection = selectedShapeId != null;
                    const isSel = hasSelection && selectedShapeId === shapeId;
                    const isHover = hoveredShapeId === shapeId;
                    const isPrimary = hasSelection ? isSel : index === 0;
                    const emphasized = isSel || isHover;
                    const color =
                      totalShapeCount > 1
                        ? SHAPE_PALETTE[index % SHAPE_PALETTE.length]
                        : lineColor;

                    return (
                      <React.Fragment key={shapeId}>
                        <Polyline
                          positions={points}
                          color={color}
                          weight={emphasized ? 6 : isPrimary ? 5 : 3}
                          opacity={
                            isSel ? 1 : isHover ? 0.9 : isPrimary ? 0.85 : 0.55
                          }
                          dashArray={emphasized || isPrimary ? null : "8 6"}
                          eventHandlers={{
                            click: (e) => {
                              L.DomEvent.stopPropagation(e);
                              if (onShapeClick) onShapeClick(shapeId);
                              else openPanel("shape", shapeId);
                            },
                            dblclick: (e) => {
                              if (!onShapeDoubleClick) return;
                              L.DomEvent.stopPropagation(e);
                              e.originalEvent?.preventDefault?.();
                              onShapeDoubleClick(shapeId);
                            },
                            mouseover: () =>
                              onShapeHover && onShapeHover(shapeId),
                            mouseout: () => onShapeHover && onShapeHover(null),
                          }}
                          pathOptions={{ className: "shape-clickable", lineCap: "round", lineJoin: "round" }}
                        >
                          <LeafletTooltip sticky>
                            <div
                              style={{
                                fontFamily: "system-ui, sans-serif",
                                minWidth: 110,
                              }}
                            >
                              <div
                                style={{
                                  fontWeight: 700,
                                  fontSize: 13,
                                  marginBottom: 2,
                                  fontFamily: "monospace",
                                }}
                              >
                                {shapeId}
                              </div>
                              <div style={{ fontSize: 11, color: "#666" }}>
                                {points.length} {t("map.shapePoints")}
                              </div>
                              {editing && !readOnly && (
                                <div
                                  style={{
                                    fontSize: 10,
                                    color: "#1976d2",
                                    marginTop: 2,
                                  }}
                                >
                                  {t("edit.shape.editOnMap")}
                                </div>
                              )}
                            </div>
                          </LeafletTooltip>
                        </Polyline>
                      </React.Fragment>
                    );
                  })}
                  {Array.isArray(extraShapes) &&
                    extraShapes.map((extra) => (
                      <Polyline
                        key={`extra-${extra.shape_id}`}
                        positions={extra.points}
                        color={extra.color || "#607d8b"}
                        weight={extra.selected ? 6 : 3}
                        opacity={extra.selected ? 0.95 : 0.6}
                        dashArray={extra.selected ? null : "4 6"}
                        eventHandlers={{
                          click: (e) => {
                            L.DomEvent.stopPropagation(e);
                            if (onShapeClick) onShapeClick(extra.shape_id);
                          },
                        }}
                        pathOptions={{ className: "shape-clickable", lineCap: "round", lineJoin: "round" }}
                      />
                    ))}
                  {otherDirShapes.map(([shapeId, points], index) => {
                    if (editingShapeId === shapeId) return null;
                    const colorIdx = shapeEntries.length + index;
                    const color =
                      SHAPE_PALETTE[colorIdx % SHAPE_PALETTE.length];

                    return (
                      <Polyline
                        key={`other-${shapeId}`}
                        positions={points}
                        color={color}
                        weight={2}
                        opacity={0.3}
                        dashArray="6 8"
                        eventHandlers={{
                          click: (e) => {
                            L.DomEvent.stopPropagation(e);
                            openPanel("shape", shapeId);
                          },
                        }}
                        pathOptions={{ className: "shape-clickable", lineCap: "round", lineJoin: "round" }}
                      >
                        <LeafletTooltip sticky>
                          <div
                            style={{
                              fontFamily: "system-ui, sans-serif",
                              minWidth: 110,
                            }}
                          >
                            <div
                              style={{
                                fontWeight: 700,
                                fontSize: 13,
                                marginBottom: 2,
                                fontFamily: "monospace",
                              }}
                            >
                              {shapeId}
                            </div>
                            <div style={{ fontSize: 11, color: "#666" }}>
                              {points.length} {t("map.shapePoints")}
                            </div>
                            <div
                              style={{
                                fontSize: 10,
                                color: "#999",
                                marginTop: 2,
                              }}
                            >
                              {t("map.otherDirection")}
                            </div>
                          </div>
                        </LeafletTooltip>
                      </Polyline>
                    );
                  })}
                </>
              )}
            </LayerGroup>
          </LayersControl.Overlay>

          {/* Each station is a halo drawn under its platforms, which stay visible and clickable on top. */}
          <LayersControl.Overlay checked name={t("map.layer.parentStations")}>
            <LayerGroup>
              <StationHalos
                stations={(() => {
                  const byStation = new Map();
                  for (const rawStop of stops) {
                    const stop = applyOverride(rawStop);
                    if (!stop.parent_station) continue;
                    const [lat, lon] = getPosition(stop);
                    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
                    const entry = byStation.get(stop.parent_station) || { id: stop.parent_station, name: stop.stop_name, points: [] };
                    entry.points.push([lat, lon]);
                    byStation.set(stop.parent_station, entry);
                  }
                  return [...byStation.values()];
                })()}
                ring={theme.palette.text.primary}
                fill={theme.palette.background.paper}
                onOpen={(id) => openPanel("stop", id)}
              />
            </LayerGroup>
          </LayersControl.Overlay>

          <LayersControl.BaseLayer checked name={t("map.layer.stops")}>
            <LayerGroup>
              {stops.map((rawStop, index) => {
                const stop = applyOverride(rawStop);
                return (
                  <Marker
                    key={`individual-${stop.stop_id || index}`}
                    position={getPosition(stop)}
                    icon={stopIcon}
                    draggable={stopsDraggable}
                    eventHandlers={{
                      mouseover: (e) => {
                        const { clientX, clientY } = e.originalEvent;
                        hoverPosRef.current = { x: clientX, y: clientY };
                        setHoveredStop(stop);
                        setMousePos({ x: clientX, y: clientY });
                      },
                      click: () => openPanel("stop", stop.stop_id),
                      dragstart: handleStopDragStart(stop),
                      dragend: handleStopDragEnd(stop),
                    }}
                  />
                );
              })}
            </LayerGroup>
          </LayersControl.BaseLayer>

          <LayersControl.BaseLayer name={t("map.layer.clusteredStops")}>
            <MarkerClusterGroup>
              {stops.map((rawStop, index) => {
                const stop = applyOverride(rawStop);
                return (
                  <Marker
                    key={`cluster-${stop.stop_id || index}`}
                    position={getPosition(stop)}
                    icon={stopIcon}
                    draggable={stopsDraggable}
                    eventHandlers={{
                      mouseover: (e) => {
                        const { clientX, clientY } = e.originalEvent;
                        hoverPosRef.current = { x: clientX, y: clientY };
                        setHoveredStop(stop);
                        setMousePos({ x: clientX, y: clientY });
                      },
                      click: () => openPanel("stop", stop.stop_id),
                      dragstart: handleStopDragStart(stop),
                      dragend: handleStopDragEnd(stop),
                    }}
                  />
                );
              })}
            </MarkerClusterGroup>
          </LayersControl.BaseLayer>
        </LayersControl>

        {/* Inside MapContainer for useMap; never in the read-only Lines chrome. */}
        {editing && !readOnly && (
          <ShapeEditorOverlay
            editShapeRequest={editShapeRequest}
            fitStops={editorStops}
          />
        )}
      </MapContainer>
      <BasemapControl basemap={basemap} onChange={setBasemap} />
      <StopFloatingCard
        stop={stopDragging ? null : hoveredStop}
        isDark={isDark}
        x={mousePos.x}
        y={mousePos.y}
      />

      {/* Hidden in the Shape Studio, which supplies its own guidance. */}
      {stopsDraggable && chrome !== "studio" && (
        <>
          <Tooltip
            title={t("edit.map.interactionsTitle")}
            placement="right"
            arrow
          >
            <IconButton
              onClick={(e) => setHelpAnchor(e.currentTarget)}
              size="small"
              sx={{
                position: "absolute",
                top: 10,
                left: 54,
                zIndex: 1000,
                bgcolor: isDark
                  ? "rgba(25,118,210,0.9)"
                  : "rgba(25,118,210,0.92)",
                color: "#fff",
                boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
                "&:hover": {
                  bgcolor: isDark ? "rgba(25,118,210,1)" : "rgba(25,118,210,1)",
                },
              }}
            >
              <InfoOutlinedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
          <Popover
            open={Boolean(helpAnchor)}
            anchorEl={helpAnchor}
            onClose={() => setHelpAnchor(null)}
            anchorOrigin={{ vertical: "top", horizontal: "right" }}
            transformOrigin={{ vertical: "top", horizontal: "left" }}
            slotProps={{
              paper: {
                sx: {
                  mt: 0,
                  ml: 1,
                  maxWidth: 360,
                  boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                },
              },
            }}
          >
            <Box sx={{ p: 2 }}>
              <Typography
                variant="subtitle2"
                sx={{
                  fontWeight: 700,
                  mb: 1.5,
                  color: "primary.main",
                  fontSize: 13,
                  letterSpacing: 0.5,
                }}
              >
                {t("edit.map.interactionsTitle").toUpperCase()}
              </Typography>
              <Box component="ul" sx={{ m: 0, pl: 2.5, listStyle: "none" }}>
                <Box
                  component="li"
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 1,
                    mb: 1,
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <OpenWithIcon
                    sx={{ fontSize: 14, mt: 0.25, color: "text.secondary" }}
                  />
                  <Typography variant="body2" sx={{ fontSize: 12 }}>
                    {t("edit.map.dragStop")}
                  </Typography>
                </Box>
                <Box
                  component="li"
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 1,
                    mb: 1,
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <TouchAppIcon
                    sx={{ fontSize: 14, mt: 0.25, color: "text.secondary" }}
                  />
                  <Typography variant="body2" sx={{ fontSize: 12 }}>
                    {t("edit.map.clickStop")}
                  </Typography>
                </Box>
                <Box
                  component="li"
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 1,
                    mb: 1,
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <TouchAppIcon
                    sx={{ fontSize: 14, mt: 0.25, color: "text.secondary" }}
                  />
                  <Typography variant="body2" sx={{ fontSize: 12 }}>
                    {t("edit.map.clickShape")}
                  </Typography>
                </Box>
                <Box
                  component="li"
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 1,
                    mb: 1,
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <AddIcon
                    sx={{ fontSize: 14, mt: 0.25, color: "text.secondary" }}
                  />
                  <Typography variant="body2" sx={{ fontSize: 12 }}>
                    {t("edit.map.fabCreate")}
                  </Typography>
                </Box>
                <Box
                  component="li"
                  sx={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 1,
                    fontSize: 12,
                    lineHeight: 1.5,
                  }}
                >
                  <EditNoteIcon
                    sx={{ fontSize: 14, mt: 0.25, color: "text.secondary" }}
                  />
                  <Typography variant="body2" sx={{ fontSize: 12 }}>
                    {t("edit.map.editShape")}
                  </Typography>
                </Box>
              </Box>
            </Box>
          </Popover>
        </>
      )}

      {placingStop && (
        <Chip
          icon={<PinDropIcon sx={{ fontSize: 16 }} />}
          label={t("edit.stop.placingHint")}
          onDelete={() => setPlacingStop(false)}
          color="success"
          sx={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000,
            fontWeight: 700,
            fontSize: 12,
            boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
          }}
        />
      )}

      {/* Hidden while a shape is edited or a stop pin placed (those modes own the map cursor), in the Shape Studio (its
          rail has its own) and in the read-only Lines chrome. */}
      {editing &&
        !editingShapeId &&
        !placingStop &&
        chrome !== "studio" &&
        !readOnly && (
          <>
            <Tooltip title={t("edit.fab.createTooltip")} placement="left" arrow>
              <Fab
                color="success"
                size="medium"
                onClick={(e) => setFabMenuAnchor(e.currentTarget)}
                sx={{
                  position: "absolute",
                  bottom: 24,
                  right: 24,
                  zIndex: 1000,
                }}
              >
                <AddLocationAltIcon />
              </Fab>
            </Tooltip>
            <Menu
              anchorEl={fabMenuAnchor}
              open={Boolean(fabMenuAnchor)}
              onClose={() => setFabMenuAnchor(null)}
              anchorOrigin={{ vertical: "top", horizontal: "left" }}
              transformOrigin={{ vertical: "bottom", horizontal: "right" }}
              slotProps={{
                paper: {
                  sx: { minWidth: 240 },
                },
              }}
            >
              <MenuItem
                onClick={() => {
                  setFabMenuAnchor(null);
                  setCreateCoords(null);
                  setCreateStopOpen(true);
                }}
              >
                <ListItemIcon>
                  <EditNoteIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={t("edit.stop.defineManually")}
                  secondary={t("edit.fab.defineManuallyHint")}
                  primaryTypographyProps={{ fontSize: 14 }}
                  secondaryTypographyProps={{ fontSize: 11 }}
                />
              </MenuItem>
              <MenuItem
                onClick={() => {
                  setFabMenuAnchor(null);
                  setPlacingStop(true);
                }}
              >
                <ListItemIcon>
                  <PinDropIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={t("edit.stop.placeOnMap")}
                  secondary={t("edit.fab.placeOnMapHint")}
                  primaryTypographyProps={{ fontSize: 14 }}
                  secondaryTypographyProps={{ fontSize: 11 }}
                />
              </MenuItem>
              <Divider sx={{ my: 0.5 }} />
              <MenuItem
                onClick={() => {
                  setFabMenuAnchor(null);
                  // A base36 timestamp: short, sortable and collision-free in practice.
                  const newShapeId = `new_shape_${Date.now().toString(36)}`;
                  window.dispatchEvent(
                    new CustomEvent("createShape", {
                      detail: {
                        shapeId: newShapeId,
                        initialPoints: [],
                        linkTripIds: [],
                        directionId: null,
                      },
                    }),
                  );
                }}
              >
                <ListItemIcon>
                  <TimelineIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={t("edit.shape.drawNewShape")}
                  secondary={t("edit.fab.drawNewShapeHint")}
                  primaryTypographyProps={{ fontSize: 14 }}
                  secondaryTypographyProps={{ fontSize: 11 }}
                />
              </MenuItem>
            </Menu>
          </>
        )}

      <EditStopDialog
        open={createStopOpen}
        stop={null}
        onClose={() => setCreateStopOpen(false)}
        mode="create"
        initialCoords={createCoords}
        onCreated={handleStopCreated}
      />
    </div>
  );
}

export default LineMap;
