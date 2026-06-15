import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import ReactDOM from "react-dom";
import {
  Box,
  Typography,
  Button,
  IconButton,
  Tooltip,
  Chip,
  Switch,
  Slider,
  FormControlLabel,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Alert,
} from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import SaveIcon from "@mui/icons-material/Save";
import CloseIcon from "@mui/icons-material/Close";
import UndoIcon from "@mui/icons-material/Undo";
import RedoIcon from "@mui/icons-material/Redo";
import SwapCallsIcon from "@mui/icons-material/SwapCalls";
import AddIcon from "@mui/icons-material/Add";
import RouteIcon from "@mui/icons-material/Route";
import TimelineIcon from "@mui/icons-material/Timeline";
import StraightenIcon from "@mui/icons-material/Straighten";
import CompressIcon from "@mui/icons-material/Compress";
import WarningIcon from "@mui/icons-material/Warning";
import { Polyline, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import API_BASE_URL from "../../config";
import LinkShapeToTripsDialog from "./LinkShapeToTripsDialog";

// ── OSRM routing ────────────────────────────────────────────────────────────
const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

// Re-throws AbortError so callers can distinguish user-cancellation from
// network/OSRM failures (the latter fall back to straight-line).
async function fetchRoadRoute(from, to, signal) {
  const url = `${OSRM_BASE}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.[0]) return null;
    const coords = data.routes[0].geometry.coordinates;
    // OSRM returns [lon, lat]; convert to {lat, lon}
    // Skip first point (it's the `from` point already in our array)
    return coords.slice(1).map(([lon, lat]) => ({ lat, lon }));
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return null;
  }
}

// ── Haversine (client-side distance) ────────────────────────────────────────
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function totalDistanceKm(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
  }
  return (d / 1000).toFixed(2);
}

// ── Planar geometry (local equirectangular projection) ─────────────────────
// Lat/lon are mapped onto a flat frame scaled to meters at the segment's mean
// latitude (x = lon·cos(lat0), y = lat, both × meters/degree). Plenty
// accurate at the city scale where GTFS shapes live.
const M_PER_DEG = 111_320;

// Projects p onto segment [a, b]. Returns the clamped projection point, the
// clamped parametric position t in [0, 1], and the distance to p in meters.
function projectPointOnSegment(p, a, b) {
  const lat0Rad = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  const kx = M_PER_DEG * Math.cos(lat0Rad);
  const ky = M_PER_DEG;
  const apx = (p.lon - a.lon) * kx;
  const apy = (p.lat - a.lat) * ky;
  const abx = (b.lon - a.lon) * kx;
  const aby = (b.lat - a.lat) * ky;
  const len2 = abx * abx + aby * aby;
  const t =
    len2 === 0 ? 0 : Math.min(1, Math.max(0, (apx * abx + apy * aby) / len2));
  const projX = abx * t;
  const projY = aby * t;
  return {
    point: { lat: a.lat + projY / ky, lon: a.lon + projX / kx },
    t,
    distM: Math.hypot(apx - projX, apy - projY),
  };
}

// Finds the polyline segment closest to p. Returns { index, point, distM }
// where `index` is the segment's start vertex and `point` the clamped
// projection of p onto that segment, or null when pts has no segment.
function nearestSegmentProjection(p, pts) {
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const proj = projectPointOnSegment(p, pts[i], pts[i + 1]);
    if (!best || proj.distM < best.distM) {
      best = { index: i, point: proj.point, distM: proj.distM };
    }
  }
  return best;
}

// ── Ramer–Douglas–Peucker simplification (metric tolerance) ────────────────
// Iterative RDP over {lat, lon} points. Perpendicular distances are measured
// in meters via projectPointOnSegment (point-to-SEGMENT, so collapsed or
// folded chords degrade gracefully). First and last points are always kept,
// so the result never drops below 2 points.
function simplifyRDP(pts, toleranceM) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const { distM } = projectPointOnSegment(pts[i], pts[start], pts[end]);
      if (distM > maxDist) {
        maxDist = distM;
        maxIdx = i;
      }
    }
    if (maxIdx !== -1 && maxDist > toleranceM) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1);
}

// ── Vertex DivIcon ──────────────────────────────────────────────────────────
const makeVertexIcon = (color = "#1976d2", size = 12) =>
  L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:2px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:grab;
    "></div>`,
  });

const vertexIcon = makeVertexIcon("#1976d2", 12);
const endpointIcon = makeVertexIcon("#f44336", 14);

const midpointIcon = L.divIcon({
  className: "",
  iconSize: [8, 8],
  iconAnchor: [4, 4],
  html: `<div style="
    width:8px;height:8px;border-radius:50%;
    background:rgba(25,118,210,0.35);border:1.5px solid rgba(25,118,210,0.6);
    cursor:pointer;
  "></div>`,
});

// ── Leaflet path colors (hex by file convention — Leaflet renders outside
// the MUI theme) ────────────────────────────────────────────────────────────
const EDIT_LINE_COLOR = "#1976d2";
const EDIT_LINE_HOVER_COLOR = "#42a5f5";
const SIMPLIFY_PREVIEW_COLOR = "#9c27b0";

// ── MapControl — renders React children into a Leaflet control ──────────────
function MapControl({ position = "topleft", children }) {
  const map = useMap();
  const [container] = useState(() => {
    const div = L.DomUtil.create("div");
    div.style.pointerEvents = "auto";
    return div;
  });

  useEffect(() => {
    const control = L.control({ position });
    control.onAdd = () => {
      L.DomEvent.disableClickPropagation(container);
      L.DomEvent.disableScrollPropagation(container);
      return container;
    };
    control.addTo(map);
    return () => control.remove();
  }, [map, position, container]);

  return ReactDOM.createPortal(children, container);
}

// ── Toolbar (MUI, dark-mode aware) ──────────────────────────────────────────
function EditorToolbar({
  shapeId,
  saving,
  dirty,
  routing,
  pointCount,
  distanceKm,
  snapToRoad,
  extending,
  undoAvailable,
  redoAvailable,
  canReverse,
  mode,
  linkTripCount,
  sharedTripCount,
  simplifyOpen,
  simplifyTolerance,
  simplifyAfter,
  simplifyCanApply,
  onSave,
  onCancel,
  onUndo,
  onRedo,
  onReverse,
  onToggleExtend,
  onToggleSnap,
  onToggleSimplify,
  onSimplifyToleranceChange,
  onSimplifyApply,
  onSimplifyCancel,
}) {
  const theme = useTheme();
  const { t } = useLanguage();

  return (
    <MapControl position="bottomright">
      <Box
        sx={{
          background: alpha(theme.palette.background.paper, 0.95),
          backdropFilter: "blur(8px)",
          borderRadius: 2.5,
          p: 1.5,
          minWidth: 220,
          maxWidth: 264,
          boxShadow: theme.shadows[8],
          border: `1px solid ${theme.palette.divider}`,
          display: "flex",
          flexDirection: "column",
          gap: 0.75,
          mb: 1,
          mr: 0.5,
        }}
      >
        {/* Title */}
        <Box display="flex" alignItems="center" gap={1}>
          <TimelineIcon
            sx={{
              fontSize: 18,
              color:
                mode === "create" ? "success.main" : "primary.main",
            }}
          />
          <Typography
            variant="subtitle2"
            fontWeight={700}
            color={mode === "create" ? "success.main" : "primary"}
            noWrap
          >
            {mode === "create"
              ? t("edit.shape.createTitle")
              : t("edit.shape.editorTitle")}
          </Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title={t("edit.shape.cancel")} arrow>
            <IconButton size="small" onClick={onCancel} sx={{ p: 0.3 }}>
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Shape ID */}
        <Typography
          variant="caption"
          fontFamily="monospace"
          color="text.secondary"
          noWrap
          sx={{ fontSize: 10 }}
        >
          {shapeId}
        </Typography>

        {mode === "create" && linkTripCount > 0 && (
          <Typography
            variant="caption"
            color="success.main"
            sx={{ fontSize: 10, fontWeight: 700 }}
          >
            {t("edit.shape.linkTripsHint", { count: linkTripCount })}
          </Typography>
        )}

        {/* Stats */}
        <Box display="flex" gap={0.5} flexWrap="wrap">
          <Chip
            label={`${pointCount} ${t("edit.shape.points")}`}
            size="small"
            sx={{ fontSize: 10, height: 20, fontWeight: 600 }}
          />
          <Chip
            label={`${distanceKm} km`}
            size="small"
            sx={{ fontSize: 10, height: 20, fontWeight: 600 }}
          />
          {dirty && (
            <Chip
              label={t("edit.shape.modified")}
              size="small"
              color="warning"
              sx={{ fontSize: 10, height: 20, fontWeight: 700 }}
            />
          )}
          {routing && (
            <Chip
              icon={<CircularProgress size={10} />}
              label={t("edit.shape.routing")}
              size="small"
              color="info"
              sx={{ fontSize: 10, height: 20 }}
            />
          )}
        </Box>

        {/* Shared-shape banner — edits to this geometry propagate to every
            trip referencing it */}
        {mode !== "create" && sharedTripCount > 1 && (
          <Tooltip title={t("edit.shape.sharedByTooltip")} arrow>
            <Chip
              icon={<WarningIcon sx={{ fontSize: 14 }} />}
              label={t("edit.shape.sharedBy", { count: sharedTripCount })}
              size="small"
              color="warning"
              sx={{
                height: "auto",
                "& .MuiChip-label": {
                  whiteSpace: "normal",
                  fontSize: 10,
                  fontWeight: 600,
                  py: 0.25,
                },
              }}
            />
          </Tooltip>
        )}

        {/* Simplify — Ramer–Douglas–Peucker with live preview */}
        <Button
          size="small"
          variant={simplifyOpen ? "contained" : "outlined"}
          color={simplifyOpen ? "primary" : "inherit"}
          onClick={onToggleSimplify}
          startIcon={<CompressIcon sx={{ fontSize: 14 }} />}
          data-testid="shape-simplify"
          sx={{ fontSize: 11 }}
        >
          {t("edit.shape.simplify")}
        </Button>
        {simplifyOpen && (
          <Box
            sx={{
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 1.5,
              px: 1,
              py: 0.5,
              display: "flex",
              flexDirection: "column",
              gap: 0.25,
            }}
          >
            <Slider
              size="small"
              min={0}
              max={50}
              step={1}
              value={simplifyTolerance}
              onChange={onSimplifyToleranceChange}
              disabled={pointCount < 3}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${v} m`}
              aria-label={t("edit.shape.simplify")}
              sx={{ mx: 0.5 }}
            />
            <Box display="flex" alignItems="center" gap={0.5}>
              <Typography
                variant="caption"
                color="text.secondary"
                noWrap
                sx={{ fontSize: 10, flex: 1 }}
              >
                {t("edit.shape.simplifyPreview", {
                  before: pointCount,
                  after: simplifyAfter,
                })}
              </Typography>
              <Button
                size="small"
                variant="contained"
                onClick={onSimplifyApply}
                disabled={!simplifyCanApply}
                data-testid="shape-simplify-apply"
                sx={{ fontSize: 10, px: 1, minWidth: 0 }}
              >
                {t("edit.shape.simplifyApply")}
              </Button>
              <IconButton
                size="small"
                onClick={onSimplifyCancel}
                aria-label={t("app.cancel")}
                sx={{ p: 0.3 }}
              >
                <CloseIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Box>
          </Box>
        )}

        {/* Hints */}
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontSize: 9, lineHeight: 1.4, opacity: 0.7 }}
        >
          {t("edit.shape.hintDrag")}
          <br />
          {t("edit.shape.hintMidpoint")}
          <br />
          {t("edit.shape.hintRightClick")}
          <br />
          {t("edit.shape.hintKeys")}
        </Typography>

        {/* Snap to road toggle */}
        <FormControlLabel
          control={
            <Switch
              checked={snapToRoad}
              onChange={onToggleSnap}
              size="small"
              color="primary"
            />
          }
          label={
            <Box display="flex" alignItems="center" gap={0.5}>
              {snapToRoad ? (
                <RouteIcon sx={{ fontSize: 14 }} />
              ) : (
                <StraightenIcon sx={{ fontSize: 14 }} />
              )}
              <Typography variant="caption" fontWeight={600} sx={{ fontSize: 11 }}>
                {snapToRoad
                  ? t("edit.shape.snapToRoad")
                  : t("edit.shape.straightLine")}
              </Typography>
            </Box>
          }
          sx={{ mx: 0, mt: 0.25 }}
        />

        {/* Buttons */}
        <Box display="flex" gap={0.5}>
          <Tooltip title="Ctrl+Z" arrow>
            <span>
              <Button
                size="small"
                variant="outlined"
                onClick={onUndo}
                disabled={!undoAvailable}
                aria-label={t("edit.undoTooltip")}
                data-testid="shape-undo"
                sx={{ minWidth: 0, px: 1 }}
              >
                <UndoIcon sx={{ fontSize: 16 }} />
              </Button>
            </span>
          </Tooltip>
          <Tooltip title="Ctrl+Shift+Z" arrow>
            <span>
              <Button
                size="small"
                variant="outlined"
                onClick={onRedo}
                disabled={!redoAvailable}
                aria-label={t("edit.redoTooltip")}
                data-testid="shape-redo"
                sx={{ minWidth: 0, px: 1 }}
              >
                <RedoIcon sx={{ fontSize: 16 }} />
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={t("edit.shape.reverse")} arrow>
            <span>
              <Button
                size="small"
                variant="outlined"
                onClick={onReverse}
                disabled={!canReverse}
                aria-label={t("edit.shape.reverse")}
                data-testid="shape-reverse"
                sx={{ minWidth: 0, px: 1 }}
              >
                <SwapCallsIcon sx={{ fontSize: 16 }} />
              </Button>
            </span>
          </Tooltip>

          <Button
            size="small"
            variant={extending ? "contained" : "outlined"}
            color={extending ? "success" : "inherit"}
            onClick={onToggleExtend}
            startIcon={<AddIcon sx={{ fontSize: 14 }} />}
            sx={{ flex: 1, fontSize: 11 }}
          >
            {t("edit.shape.extendLine")}
          </Button>
        </Box>

        <Box display="flex" gap={0.5} mt={0.25}>
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            onClick={onCancel}
            sx={{ flex: 1, fontSize: 11 }}
          >
            {t("edit.shape.cancel")}
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={onSave}
            disabled={saving || !dirty}
            startIcon={
              saving ? <CircularProgress size={12} /> : <SaveIcon sx={{ fontSize: 14 }} />
            }
            sx={{ flex: 1, fontSize: 11 }}
          >
            {t("edit.shape.save")}
          </Button>
        </Box>
      </Box>
    </MapControl>
  );
}

// ── Main Overlay ────────────────────────────────────────────────────────────
function ShapeEditorOverlay({ editShapeRequest = null }) {
  const map = useMap();
  const { editing, recordEdit, showToast } = useEditMode();
  const { t } = useLanguage();

  const [activeShapeId, setActiveShapeId] = useState(null);
  const [originalPoints, setOriginalPoints] = useState([]);
  const [points, setPoints] = useState([]);
  const [history, setHistory] = useState([]); // undo stack
  const [redoStack, setRedoStack] = useState([]); // redo stack (mirror of history)
  const [saving, setSaving] = useState(false);
  const [extending, setExtending] = useState(false);
  const [snapToRoad, setSnapToRoad] = useState(true);
  const [routing, setRouting] = useState(false);
  // "create" mode: POST new shape + optionally link trips; "edit" (default) PUTs an existing shape
  const [mode, setMode] = useState("edit");
  const [linkTripIds, setLinkTripIds] = useState([]);
  // Number of trips referencing the loaded shape (edit mode only) — drives
  // the "shared by N trips" warning banner in the toolbar.
  const [sharedTripCount, setSharedTripCount] = useState(0);
  // Simplify panel (RDP live preview)
  const [simplifyOpen, setSimplifyOpen] = useState(false);
  const [simplifyTolerance, setSimplifyTolerance] = useState(5);
  // Pointer currently hovering the editable polyline (insert-vertex gesture)
  const [lineHover, setLineHover] = useState(false);

  // Post-save link dialog (standalone "draw new shape" only). When the user
  // created a shape without pre-selected trips, we offer a dedicated dialog
  // to attach the orphan shape to one or more trips after save.
  const [postSaveLinkOpen, setPostSaveLinkOpen] = useState(false);
  const [savedShapeId, setSavedShapeId] = useState(null);
  const [savedPointCount, setSavedPointCount] = useState(0);
  const [savedDistanceKm, setSavedDistanceKm] = useState("0");

  // Confirmation dialog state (replaces window.confirm / confirm)
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    message: "",
    onConfirm: null,
  });

  const routingRef = useRef(0); // cancel stale routing calls
  const pointsRef = useRef(points);
  pointsRef.current = points;
  // Abort controller for the current /edit/shapes/:id fetch. Switching to
  // another shape (or unmounting) cancels the previous request so the editor
  // never loads the wrong shape's points on top of newer state.
  const loadAbortRef = useRef(null);
  // Abort controller shared by all OSRM requests issued from the current
  // extend-click session. Cancelling it aborts in-flight routing on
  // unmount / cancel / save / shape switch.
  const osrmAbortRef = useRef(null);
  // Warn only once per editing session when OSRM falls back to a straight
  // segment — repeated clicks while the service is down must not spam toasts.
  const osrmWarnedRef = useRef(false);

  // Tracks whether the component is still mounted — guards async setState
  // from emitting warnings (and subtle bugs) when the user closes the editor
  // while save / load / OSRM is in flight.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const dirty = useMemo(() => {
    // In create mode, any point is "dirty" (there's nothing to compare against)
    if (mode === "create") return points.length >= 2;
    if (points.length !== originalPoints.length) return true;
    return points.some(
      (p, i) => p.lat !== originalPoints[i].lat || p.lon !== originalPoints[i].lon,
    );
  }, [points, originalPoints, mode]);

  const distanceKm = useMemo(() => totalDistanceKm(points), [points]);

  // Live preview of the simplified geometry while the panel is open.
  // null when the panel is closed or the shape is too short to simplify.
  const simplifiedPreview = useMemo(() => {
    if (!simplifyOpen || points.length < 3) return null;
    return simplifyRDP(points, simplifyTolerance);
  }, [simplifyOpen, points, simplifyTolerance]);

  // Refs for values accessed inside the editShapeRequest effect (avoids stale closures)
  const activeShapeIdRef = useRef(activeShapeId);
  activeShapeIdRef.current = activeShapeId;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const lastTokenRef = useRef(0); // monotonic token — guarantees each request is handled once

  // ── Push to undo stack ──────────────────────────────────────────────────
  // Any new action invalidates the redo branch, as in every editor.
  const pushUndo = useCallback(() => {
    setHistory((prev) => [...prev.slice(-49), pointsRef.current]);
    setRedoStack([]);
  }, []);

  // Full local-session reset — used whenever an editing session starts or
  // ends (load, create, save, cancel): history stacks, simplify panel,
  // shared-trips banner, hover highlight. Also re-arms the once-per-session
  // OSRM fallback warning.
  const resetHistoryStacks = useCallback(() => {
    setHistory([]);
    setRedoStack([]);
    setSimplifyOpen(false);
    setSimplifyTolerance(5);
    setSharedTripCount(0);
    setLineHover(false);
    osrmWarnedRef.current = false;
  }, []);

  // ── Callbacks ───────────────────────────────────────────────────────────

  const handleVertexDragEnd = useCallback(
    (index, e) => {
      pushUndo();
      const { lat, lng } = e.target.getLatLng();
      setPoints((prev) => {
        const next = [...prev];
        next[index] = { lat, lon: lng };
        return next;
      });
    },
    [pushUndo],
  );

  const handleVertexRemove = useCallback(
    (index) => {
      if (pointsRef.current.length <= 2) return;
      pushUndo();
      setPoints((prev) => prev.filter((_, i) => i !== index));
    },
    [pushUndo],
  );

  const handleMidpointClick = useCallback(
    (afterIndex) => {
      pushUndo();
      setPoints((prev) => {
        const p1 = prev[afterIndex];
        const p2 = prev[afterIndex + 1];
        if (!p1 || !p2) return prev;
        const mid = {
          lat: (p1.lat + p2.lat) / 2,
          lon: (p1.lon + p2.lon) / 2,
        };
        const next = [...prev];
        next.splice(afterIndex + 1, 0, mid);
        return next;
      });
    },
    [pushUndo],
  );

  const handleUndo = useCallback(() => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      setRedoStack((r) => [...r.slice(-49), pointsRef.current]);
      setPoints(prev[prev.length - 1]);
      return prev.slice(0, -1);
    });
  }, []);

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      // Re-applying moves the current state back onto the undo stack
      // WITHOUT clearing the remaining redo branch.
      setHistory((h) => [...h.slice(-49), pointsRef.current]);
      setPoints(prev[prev.length - 1]);
      return prev.slice(0, -1);
    });
  }, []);

  const handleReverse = useCallback(() => {
    if (pointsRef.current.length < 2) return;
    pushUndo();
    setPoints((prev) => [...prev].reverse());
  }, [pushUndo]);

  // Click on the edit polyline inserts a vertex at the click point projected
  // onto the nearest segment — the standard GIS gesture. Midpoint markers are
  // kept alongside for discoverability at low zoom.
  const handleLineClick = useCallback(
    (e) => {
      // The polyline has bubblingMouseEvents disabled (Leaflet-level), but
      // also stop the DOM event so map-level click handlers (e.g. stop
      // placement) can never double-fire.
      L.DomEvent.stopPropagation(e);
      e.originalEvent?.stopPropagation?.();
      const pts = pointsRef.current;
      if (pts.length < 2) return;
      const nearest = nearestSegmentProjection(
        { lat: e.latlng.lat, lon: e.latlng.lng },
        pts,
      );
      if (!nearest) return;
      pushUndo();
      setPoints((prev) => {
        const next = [...prev];
        next.splice(nearest.index + 1, 0, nearest.point);
        return next;
      });
    },
    [pushUndo],
  );

  const handleLineMouseOver = useCallback((e) => {
    setLineHover(true);
    // Element-level cursor (SVG path) wins over the default
    // .leaflet-interactive pointer cursor.
    const el = e.target.getElement?.();
    if (el) el.style.cursor = "crosshair";
  }, []);

  const handleLineMouseOut = useCallback((e) => {
    setLineHover(false);
    const el = e.target.getElement?.();
    if (el) el.style.cursor = "";
  }, []);

  // Clear a stale highlight when the layer unmounts mid-hover (extend mode
  // toggling remounts the polyline; closing the editor removes it).
  const handleLineRemove = useCallback(() => {
    setLineHover(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!activeShapeId || saving || !dirty) return;
    if (points.length < 2) {
      showToast(t("edit.shape.needTwoPoints"), "error");
      return;
    }
    setSaving(true);
    // Cancel any in-flight OSRM routing so a pending click can't append
    // points to a shape that is currently being saved.
    osrmAbortRef.current?.abort();
    try {
      const isCreate = mode === "create";
      const res = await fetchWithSession(
        isCreate
          ? `${API_BASE_URL}/edit/shapes`
          : `${API_BASE_URL}/edit/shapes/${encodeURIComponent(activeShapeId)}`,
        {
          method: isCreate ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isCreate
              ? {
                  shape_id: activeShapeId,
                  points,
                  // Backend atomically creates the shape AND reassigns trips,
                  // producing a single undoable _edit_log entry.
                  ...(linkTripIds.length > 0 && { link_trip_ids: linkTripIds }),
                }
              : { points },
          ),
        },
      );
      if (!mountedRef.current) return;
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        showToast(errBody.error || t("edit.shape.saveError"), "error");
        return;
      }

      // Read the single-use response body once — used for both the linked-trip
      // count (create mode) and the validation block passed to recordEdit.
      const body = await res.json().catch(() => ({}));
      if (!mountedRef.current) return;

      let linkedCount = 0;
      if (isCreate && linkTripIds.length > 0) {
        linkedCount = body.linked_trips ?? linkTripIds.length;
      }

      const toastKey = isCreate
        ? linkedCount > 0
          ? "edit.shape.createdAndLinkedToast"
          : "edit.shape.createdToast"
        : "edit.shape.savedToast";
      recordEdit(
        t(toastKey, {
          id: activeShapeId,
          count: points.length,
          trips: linkedCount,
        }),
        body.validation,
        { entity: "shape", entityId: activeShapeId },
      );

      // Standalone create (no pre-selected trips) → offer the link-to-trips
      // dialog so the freshly drawn shape doesn't stay orphaned. We capture
      // the metadata BEFORE resetting the editor state below so the dialog
      // header can show the correct point count / distance.
      const isStandaloneCreate = isCreate && linkTripIds.length === 0;
      if (isStandaloneCreate) {
        setSavedShapeId(activeShapeId);
        setSavedPointCount(points.length);
        setSavedDistanceKm(distanceKm);
        setPostSaveLinkOpen(true);
      }

      routingRef.current++;
      setRouting(false);
      setActiveShapeId(null);
      setPoints([]);
      setOriginalPoints([]);
      resetHistoryStacks();
      setExtending(false);
      setMode("edit");
      setLinkTripIds([]);
      window.dispatchEvent(new CustomEvent("shapeEditorClosed"));
    } catch (err) {
      if (!mountedRef.current) return;
      console.error("Shape save error:", err);
      showToast(err.message || t("edit.shape.saveError"), "error");
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [
    activeShapeId,
    saving,
    dirty,
    points,
    mode,
    linkTripIds,
    distanceKm,
    recordEdit,
    showToast,
    t,
  ]);

  // Extracted cancel logic — called directly when not dirty, or from dialog onConfirm
  const doCancelEditor = useCallback(() => {
    routingRef.current++; // cancel any in-flight OSRM request (legacy guard)
    osrmAbortRef.current?.abort();
    loadAbortRef.current?.abort();
    setRouting(false);
    setActiveShapeId(null);
    setPoints([]);
    setOriginalPoints([]);
    resetHistoryStacks();
    setExtending(false);
    setMode("edit");
    setLinkTripIds([]);
    window.dispatchEvent(new CustomEvent("shapeEditorClosed"));
  }, []);

  const handleCancel = useCallback(() => {
    if (dirtyRef.current) {
      setConfirmDialog({
        open: true,
        message: t("edit.shape.discardWarning"),
        onConfirm: doCancelEditor,
      });
      return;
    }
    doCancelEditor();
  }, [t, doCancelEditor]);

  // Allow the Shape Studio shell to force-close the editor — e.g. after the user
  // confirmed discarding unsaved changes to navigate elsewhere in the rail. The
  // shell owns the confirmation, so this closes unconditionally.
  useEffect(() => {
    const onForceCancel = () => doCancelEditor();
    window.addEventListener("cancelShapeEditor", onForceCancel);
    return () => window.removeEventListener("cancelShapeEditor", onForceCancel);
  }, [doCancelEditor]);

  const handleToggleExtend = useCallback(() => {
    setExtending((prev) => !prev);
  }, []);

  const handleToggleSnap = useCallback(() => {
    setSnapToRoad((prev) => !prev);
  }, []);

  // ── Simplify panel ──────────────────────────────────────────────────────

  const handleToggleSimplify = useCallback(() => {
    setSimplifyOpen((prev) => !prev);
  }, []);

  const handleSimplifyToleranceChange = useCallback((_e, value) => {
    setSimplifyTolerance(Array.isArray(value) ? value[0] : value);
  }, []);

  const handleSimplifyCancel = useCallback(() => {
    setSimplifyOpen(false);
  }, []);

  // Apply the previewed simplification. RDP always preserves both endpoints;
  // the guard additionally ensures we never go below 2 points and never
  // record a no-op undo entry when nothing was removed.
  const handleSimplifyApply = useCallback(() => {
    if (
      simplifiedPreview &&
      simplifiedPreview.length >= 2 &&
      simplifiedPreview.length < pointsRef.current.length
    ) {
      pushUndo();
      setPoints(simplifiedPreview);
    }
    setSimplifyOpen(false);
  }, [simplifiedPreview, pushUndo]);

  // ── Effects ─────────────────────────────────────────────────────────────

  // Ref to track editing state inside event listeners (avoids stale closure)
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // Load a shape by ID — extracted so it can be called both from the effect
  // and from the confirm dialog's onConfirm handler.
  const loadShape = useCallback(
    (shapeId) => {
      // Cancel any previous in-flight load so a slow fetch can't overwrite a
      // newer shape's state.
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;

      // Reset editor state for the incoming shape — also cancels any in-flight
      // OSRM routing from the previous shape.
      routingRef.current++;
      osrmAbortRef.current?.abort();
      setRouting(false);
      setExtending(false);
      resetHistoryStacks();

      fetchWithSession(
        `${API_BASE_URL}/edit/shapes/${encodeURIComponent(shapeId)}`,
        { signal: controller.signal },
      )
        .then((r) => {
          if (!r.ok) {
            throw new Error(`HTTP ${r.status}`);
          }
          return r.json();
        })
        .then((data) => {
          if (controller.signal.aborted) return;
          if (!data || !Array.isArray(data.points) || data.points.length === 0) {
            showToast(
              t("edit.shape.loadError") || "Failed to load shape points",
              "error",
            );
            return;
          }
          const pts = data.points
            .map((p) => ({
              lat: parseFloat(p.shape_pt_lat),
              lon: parseFloat(p.shape_pt_lon),
            }))
            .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
          if (pts.length === 0) {
            showToast(
              t("edit.shape.loadError") || "Shape has no valid coordinates",
              "error",
            );
            return;
          }
          setOriginalPoints(pts);
          setPoints(pts.map((p) => ({ ...p })));
          setActiveShapeId(shapeId);
          setExtending(false);
          resetHistoryStacks();
          // The load response lists the trips referencing this shape — feeds
          // the shared-shape banner (set after resetHistoryStacks zeroes it).
          setSharedTripCount(Array.isArray(data.trips) ? data.trips.length : 0);
          setRouting(false);
          window.dispatchEvent(
            new CustomEvent("shapeEditorActive", { detail: { shapeId } }),
          );
          // Pan map to fit the loaded shape
          const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lon]));
          map.fitBounds(bounds, { padding: [80, 80], maxZoom: 16 });
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          console.error("Shape load error:", err);
          showToast(
            t("edit.shape.loadError") || "Failed to load shape",
            "error",
          );
        });
    },
    [map, showToast, t],
  );

  // Initialise the editor in "create" mode with a blank shape, optional pre-seeded
  // points (typically the stops of the target trips) and a list of trip_ids to bulk-link
  // on save.
  const loadCreateMode = useCallback(
    ({ shapeId, initialPoints = [], linkTripIds: tripIds = [] }) => {
      // Cancel any in-flight shape load / OSRM routing from a prior session.
      loadAbortRef.current?.abort();
      osrmAbortRef.current?.abort();
      routingRef.current++;
      setRouting(false);
      resetHistoryStacks();
      setMode("create");
      setLinkTripIds(Array.isArray(tripIds) ? tripIds : []);
      setOriginalPoints([]);
      const seed = (initialPoints || []).filter(
        (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
      );
      setPoints(seed.map((p) => ({ lat: p.lat, lon: p.lon })));
      setActiveShapeId(shapeId);
      // Auto-enable extend so the user can immediately click the map to add points
      setExtending(true);
      window.dispatchEvent(
        new CustomEvent("shapeEditorActive", { detail: { shapeId } }),
      );
      if (seed.length > 0) {
        const bounds = L.latLngBounds(seed.map((p) => [p.lat, p.lon]));
        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 16 });
      }
    },
    [map],
  );

  // React to shape edit/create requests (token-based).
  // Each request carries a unique monotonic token. lastTokenRef ensures
  // a given token is never processed twice — no complex deduplication needed.
  // The only clearing of editShapeRequest happens via the "shapeEditorClosed"
  // event listened to in GTFSApp (fired by handleSave, handleCancel, or unmount).
  useEffect(() => {
    if (!editShapeRequest || !editingRef.current) return;

    const { shapeId, token, mode: requestMode } = editShapeRequest;

    // Already handled this exact token — no-op
    if (token === lastTokenRef.current) return;
    lastTokenRef.current = token;

    // Already active on this exact shape — nothing to load
    if (shapeId === activeShapeIdRef.current) return;

    const startRequest = () => {
      if (requestMode === "create") {
        loadCreateMode(editShapeRequest);
      } else {
        loadShape(shapeId);
      }
    };

    // Warn if switching away from unsaved edits — show MUI dialog instead of confirm()
    if (activeShapeIdRef.current && dirtyRef.current) {
      setConfirmDialog({
        open: true,
        message: t("edit.shape.unsavedWarning"),
        onConfirm: startRequest,
      });
      return;
    }

    startRequest();
  }, [editShapeRequest, t, loadShape, loadCreateMode]);

  // Dispatch shapeEditorClosed on unmount (handles exit edit mode, tab switch, etc.)
  // so LineMap clears editingShapeId and polylines reappear.
  // Also aborts any in-flight shape load or OSRM routing so pending network
  // work can't resolve and setState on an unmounted component.
  useEffect(() => {
    return () => {
      loadAbortRef.current?.abort();
      osrmAbortRef.current?.abort();
      window.dispatchEvent(new CustomEvent("shapeEditorClosed"));
    };
  }, []);

  // beforeunload guard: block page refresh/close while the editor has unsaved
  // shape changes (points not yet POSTed/PUT — not tracked in _edit_log).
  useEffect(() => {
    if (!activeShapeId || !dirty) return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [activeShapeId, dirty]);

  // Broadcast dirty state so EditModeToggle can warn on exit-edit-mode.
  // The shape draft isn't in _edit_log yet (only POST/PUT persists it),
  // so pendingEdits alone misses this.
  useEffect(() => {
    const isDirty = Boolean(activeShapeId && dirty);
    window.__gtfsShapeEditorDirty = isDirty;
    window.dispatchEvent(
      new CustomEvent("shapeEditorDirtyChanged", { detail: { dirty: isDirty } }),
    );
    return () => {
      window.__gtfsShapeEditorDirty = false;
    };
  }, [activeShapeId, dirty]);

  // Escape = close simplify panel first, then exit extend, then cancel editor
  useEffect(() => {
    if (!activeShapeId) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (simplifyOpen) {
          setSimplifyOpen(false);
        } else if (extending) {
          setExtending(false);
        } else {
          handleCancel();
        }
      }
      // Ctrl+Z = local undo
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      }
      // Ctrl+Shift+Z (or Ctrl+Y) = local redo
      if (
        (e.ctrlKey || e.metaKey) &&
        ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y")
      ) {
        e.preventDefault();
        handleRedo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeShapeId, simplifyOpen, extending, handleCancel, handleUndo, handleRedo]);

  // Map click to extend line (with optional OSRM routing).
  //
  // Clicks are serialized through a promise chain: each click waits for the
  // previous OSRM routing to resolve before issuing its own. This preserves
  // GTFS-critical point order even when the user clicks faster than OSRM can
  // respond (rapid clicks), and prevents lost points.
  //
  // Cancellation: on unmount / shape switch / cancel / save, `cancelled` is
  // flipped and the shared AbortController aborts any in-flight OSRM fetch.
  useEffect(() => {
    if (!activeShapeId || !extending) return;

    let cancelled = false;
    const controller = new AbortController();
    osrmAbortRef.current = controller;
    let queue = Promise.resolve();

    const onClick = (e) => {
      const clicked = { lat: e.latlng.lat, lon: e.latlng.lng };

      queue = queue
        .then(async () => {
          if (cancelled) return;
          const current = pointsRef.current;
          // Push current state to undo stack BEFORE appending anything
          setHistory((h) => [...h.slice(-49), current]);

          if (!snapToRoad || current.length === 0) {
            // Straight line: just append the point
            setPoints((cur) => [...cur, clicked]);
            return;
          }

          const lastPt = current[current.length - 1];
          setRouting(true);

          try {
            const routedPts = await fetchRoadRoute(
              lastPt,
              clicked,
              controller.signal,
            );
            if (cancelled) return;
            if (routedPts && routedPts.length > 0) {
              setPoints((cur) => [...cur, ...routedPts]);
            } else {
              // Fallback: straight line if routing failed
              if (!osrmWarnedRef.current) {
                osrmWarnedRef.current = true;
                showToast(t("edit.shape.osrmFallback"), "warning");
              }
              setPoints((cur) => [...cur, clicked]);
            }
          } catch (err) {
            if (err?.name === "AbortError") return;
            if (cancelled) return;
            // Unexpected routing error → straight-line fallback
            if (!osrmWarnedRef.current) {
              osrmWarnedRef.current = true;
              showToast(t("edit.shape.osrmFallback"), "warning");
            }
            setPoints((cur) => [...cur, clicked]);
          } finally {
            if (!cancelled) setRouting(false);
          }
        })
        .catch(() => {
          // Swallow — individual click errors are handled above; this only
          // guards against promise chain poisoning.
        });
    };

    map.on("click", onClick);
    map.getContainer().style.cursor = "crosshair";
    return () => {
      cancelled = true;
      controller.abort();
      if (osrmAbortRef.current === controller) osrmAbortRef.current = null;
      map.off("click", onClick);
      map.getContainer().style.cursor = "";
    };
  }, [activeShapeId, extending, snapToRoad, map]);

  // ── Confirmation dialog — portalled to document.body so it renders
  // regardless of whether the Leaflet editor is active.
  const closeConfirmDialog = () =>
    setConfirmDialog({ open: false, message: "", onConfirm: null });

  const confirmDialogPortal = ReactDOM.createPortal(
    <>
      <Dialog open={confirmDialog.open} onClose={closeConfirmDialog}>
        <DialogTitle>{t("edit.shape.editorTitle")}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mt: 1 }}>
            {confirmDialog.message}
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeConfirmDialog}>{t("edit.shape.cancel")}</Button>
          <Button
            variant="contained"
            color="warning"
            onClick={() => {
              confirmDialog.onConfirm?.();
              closeConfirmDialog();
            }}
          >
            {t("edit.shape.discardAndContinue") || "Discard changes"}
          </Button>
        </DialogActions>
      </Dialog>
      {/* Post-save link dialog. Rendered through the same portal as the
          confirm dialog so it survives the editor's early-return paths
          (the editor resets activeShapeId on save success). */}
      {postSaveLinkOpen && savedShapeId && (
        <LinkShapeToTripsDialog
          open
          shapeId={savedShapeId}
          pointCount={savedPointCount}
          distanceKm={savedDistanceKm}
          onClose={() => setPostSaveLinkOpen(false)}
          onLinked={() => {
            setPostSaveLinkOpen(false);
            // Toast is already emitted by recordEdit() inside the dialog.
          }}
        />
      )}
    </>,
    document.body,
  );

  // ── Don't render Leaflet elements when inactive ─────────────────────────
  if (!activeShapeId || !editing) return confirmDialogPortal;

  const positions = points.map((p) => [p.lat, p.lon]);
  const ghostPositions = originalPoints.map((p) => [p.lat, p.lon]);

  // Compute midpoints (skip if too many — performance guard)
  const showMidpoints = points.length < 500;
  const midpoints = [];
  if (showMidpoints) {
    for (let i = 0; i < points.length - 1; i++) {
      midpoints.push({
        index: i,
        lat: (points[i].lat + points[i + 1].lat) / 2,
        lon: (points[i].lon + points[i + 1].lon) / 2,
      });
    }
  }

  // Show simplified vertex markers when there are many points
  // Only show every Nth vertex + endpoints
  const vertexStride = points.length > 300 ? Math.ceil(points.length / 150) : 1;

  return (
    <>
      {confirmDialogPortal}

      {/* Ghost: original shape (dashed, gray) */}
      <Polyline
        positions={ghostPositions}
        color="#9e9e9e"
        weight={3}
        opacity={0.35}
        dashArray="6 4"
        interactive={false}
      />

      {/* Active: current edited shape (solid, blue). Hovering highlights it
          and a click inserts a vertex at the projected point on the nearest
          segment. `interactive` is a creation-time Leaflet option, so the key
          forces a remount when extend mode toggles it; reactive styling goes
          through pathOptions. */}
      <Polyline
        key={extending ? "edit-line-extend" : "edit-line-insert"}
        positions={positions}
        color={EDIT_LINE_COLOR}
        weight={4}
        opacity={0.9}
        interactive={!extending}
        bubblingMouseEvents={false}
        pathOptions={{
          color:
            lineHover && !extending ? EDIT_LINE_HOVER_COLOR : EDIT_LINE_COLOR,
          weight: lineHover && !extending ? 6 : 4,
          opacity: simplifyOpen && simplifiedPreview ? 0.4 : 0.9,
        }}
        eventHandlers={{
          click: handleLineClick,
          mouseover: handleLineMouseOver,
          mouseout: handleLineMouseOut,
          remove: handleLineRemove,
        }}
      />

      {/* Simplify live preview: dashed overlay of the simplified geometry
          (the edited line above is dimmed while this is visible) */}
      {simplifyOpen && simplifiedPreview && (
        <Polyline
          positions={simplifiedPreview.map((p) => [p.lat, p.lon])}
          color={SIMPLIFY_PREVIEW_COLOR}
          weight={4}
          opacity={0.95}
          dashArray="8 6"
          interactive={false}
        />
      )}

      {/* Midpoint markers — click to insert a new vertex */}
      {showMidpoints &&
        midpoints.map((mp) => (
          <Marker
            key={`mid-${mp.index}`}
            position={[mp.lat, mp.lon]}
            icon={midpointIcon}
            eventHandlers={{
              click: (e) => {
                L.DomEvent.stopPropagation(e);
                handleMidpointClick(mp.index);
              },
            }}
          />
        ))}

      {/* Draggable vertex markers */}
      {points.map((p, i) => {
        const isEndpoint = i === 0 || i === points.length - 1;
        if (!isEndpoint && vertexStride > 1 && i % vertexStride !== 0) return null;
        return (
          <Marker
            key={`v-${i}`}
            position={[p.lat, p.lon]}
            icon={isEndpoint ? endpointIcon : vertexIcon}
            draggable
            eventHandlers={{
              dragend: (e) => handleVertexDragEnd(i, e),
              contextmenu: (e) => {
                L.DomEvent.preventDefault(e);
                L.DomEvent.stopPropagation(e);
                handleVertexRemove(i);
              },
            }}
          />
        );
      })}

      {/* MUI Toolbar */}
      <EditorToolbar
        shapeId={activeShapeId}
        saving={saving}
        dirty={dirty}
        routing={routing}
        pointCount={points.length}
        distanceKm={distanceKm}
        snapToRoad={snapToRoad}
        extending={extending}
        undoAvailable={history.length > 0}
        redoAvailable={redoStack.length > 0}
        canReverse={points.length >= 2}
        mode={mode}
        linkTripCount={linkTripIds.length}
        sharedTripCount={sharedTripCount}
        simplifyOpen={simplifyOpen}
        simplifyTolerance={simplifyTolerance}
        simplifyAfter={simplifiedPreview ? simplifiedPreview.length : points.length}
        simplifyCanApply={Boolean(
          simplifiedPreview && simplifiedPreview.length < points.length,
        )}
        onSave={handleSave}
        onCancel={handleCancel}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onReverse={handleReverse}
        onToggleExtend={handleToggleExtend}
        onToggleSnap={handleToggleSnap}
        onToggleSimplify={handleToggleSimplify}
        onSimplifyToleranceChange={handleSimplifyToleranceChange}
        onSimplifyApply={handleSimplifyApply}
        onSimplifyCancel={handleSimplifyCancel}
      />
    </>
  );
}

export default ShapeEditorOverlay;
