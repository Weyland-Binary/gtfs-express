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
  ToggleButton,
  ToggleButtonGroup,
  Divider,
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
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import HorizontalRuleIcon from "@mui/icons-material/HorizontalRule";
import FirstPageIcon from "@mui/icons-material/FirstPage";
import LastPageIcon from "@mui/icons-material/LastPage";
import WrongLocationIcon from "@mui/icons-material/WrongLocation";
import LowPriorityIcon from "@mui/icons-material/LowPriority";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { Polyline, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import API_BASE_URL from "../../config";
import LinkShapeToTripsDialog from "./LinkShapeToTripsDialog";
import { fetchRoadRouteVia } from "../../utils/osrmRouting";
import {
  totalDistanceKm,
  nearestSegmentProjection,
  simplifyRDP,
  analyzeStopFit,
} from "../../utils/shapeGeometry";

// ── Constants ───────────────────────────────────────────────────────────────

// Stops farther than this from the polyline are reported as "off trace".
const FIT_THRESHOLD_M = 100;
// Vertex markers rendered at once. Beyond this the visible stretch is
// decimated; zooming in always brings every vertex back.
const MAX_VISIBLE_VERTICES = 400;
const MAX_MIDPOINTS = 250;

// ── Vertex DivIcons ─────────────────────────────────────────────────────────
const makeVertexIcon = (color = "#1976d2", size = 12, ring = false) =>
  L.divIcon({
    className: "",
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:2px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,0.4)${ring ? ",0 0 0 3px rgba(255,152,0,0.45)" : ""};cursor:grab;
    "></div>`,
  });

const vertexIcon = makeVertexIcon("#1976d2", 12);
const endpointIcon = makeVertexIcon("#f44336", 14);
const selectedVertexIcon = makeVertexIcon("#ff9800", 14, true);
const selectedEndpointIcon = makeVertexIcon("#ff9800", 16, true);
const extendTargetIcon = makeVertexIcon("#2e7d32", 18, true);

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

// Numbered badge shown above the pattern's stops while editing: blue when the
// stop sits on the trace, red when it is off trace, orange when the trace
// serves it out of order.
const stopBadgeCache = new Map();
const makeStopBadge = (n, kind) => {
  const key = `${n}:${kind}`;
  if (stopBadgeCache.has(key)) return stopBadgeCache.get(key);
  const bg = kind === "off" ? "#d32f2f" : kind === "order" ? "#ef6c00" : "#1565c0";
  const icon = L.divIcon({
    className: "",
    iconSize: [20, 20],
    iconAnchor: [10, 36],
    html: `<div style="
      width:20px;height:20px;border-radius:50%;background:${bg};color:#fff;
      font:700 10px/20px system-ui,sans-serif;text-align:center;
      border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.45);
      pointer-events:none;
    ">${n}</div>`,
  });
  stopBadgeCache.set(key, icon);
  return icon;
};

// ── Leaflet path colors (hex by file convention — Leaflet renders outside
// the MUI theme) ────────────────────────────────────────────────────────────
const EDIT_LINE_COLOR = "#1976d2";
const EDIT_LINE_HOVER_COLOR = "#42a5f5";
const SIMPLIFY_PREVIEW_COLOR = "#9c27b0";
const SELECTION_COLOR = "#ff9800";

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

const SmallIconButton = ({ title, testid, disabled, onClick, children, color }) => (
  <Tooltip title={title} arrow>
    <span>
      <IconButton
        size="small"
        onClick={onClick}
        disabled={disabled}
        aria-label={typeof title === "string" ? title : undefined}
        data-testid={testid}
        color={color}
        sx={{ border: 1, borderColor: "divider", borderRadius: 1.5, p: 0.5 }}
      >
        {children}
      </IconButton>
    </span>
  </Tooltip>
);

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
  extendAt,
  undoAvailable,
  redoAvailable,
  canReverse,
  mode,
  linkTripCount,
  sharedTripCount,
  selection,
  selectionDistanceM,
  fit,
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
  onExtendAtChange,
  onToggleSnap,
  onToggleSimplify,
  onSimplifyToleranceChange,
  onSimplifyApply,
  onSimplifyCancel,
  onSectionReroute,
  onSectionStraighten,
  onSelectionDelete,
  onClearSelection,
  onFlyOffTrace,
  onFlyOutOfOrder,
}) {
  const theme = useTheme();
  const { t } = useLanguage();
  const hasRange = selection && selection.end > selection.start;
  const rangeCount = selection ? selection.end - selection.start + 1 : 0;
  const offCount = fit ? fit.offTrace.length : 0;
  const orderCount = fit ? fit.outOfOrder.length : 0;
  const fitChecked = fit && fit.results.length > 0;

  return (
    <MapControl position="bottomright">
      <Box
        data-testid="shape-editor-toolbar"
        sx={{
          background: alpha(theme.palette.background.paper, 0.96),
          backdropFilter: "blur(8px)",
          borderRadius: 2.5,
          p: 1.5,
          width: 276,
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
              color: mode === "create" ? "success.main" : "primary.main",
            }}
          />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography
              variant="subtitle2"
              fontWeight={700}
              color={mode === "create" ? "success.main" : "primary"}
              noWrap
              sx={{ lineHeight: 1.2 }}
            >
              {mode === "create"
                ? t("edit.shape.createTitle")
                : t("edit.shape.editorTitle")}
            </Typography>
            <Typography
              variant="caption"
              fontFamily="monospace"
              color="text.secondary"
              noWrap
              sx={{ fontSize: 10, display: "block" }}
            >
              {shapeId}
            </Typography>
          </Box>
          <Tooltip title={t("edit.shape.cancel")} arrow>
            <IconButton
              size="small"
              onClick={onCancel}
              sx={{ p: 0.3 }}
              data-testid="shape-cancel"
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        </Box>

        {mode === "create" && linkTripCount > 0 && (
          <Typography
            variant="caption"
            color="success.main"
            sx={{ fontSize: 10, fontWeight: 700 }}
          >
            {t("edit.shape.linkTripsHint", { count: linkTripCount })}
          </Typography>
        )}

        {/* Stats + fit */}
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
          {fitChecked && offCount === 0 && orderCount === 0 && (
            <Tooltip title={t("edit.shape.fit.okTooltip", { m: FIT_THRESHOLD_M })} arrow>
              <Chip
                icon={<CheckCircleOutlineIcon sx={{ fontSize: 14 }} />}
                label={t("edit.shape.fit.ok", { count: fit.results.length })}
                size="small"
                color="success"
                variant="outlined"
                data-testid="shape-fit-ok"
                sx={{ fontSize: 10, height: 20 }}
              />
            </Tooltip>
          )}
          {offCount > 0 && (
            <Tooltip title={t("edit.shape.fit.offTraceTooltip", { m: FIT_THRESHOLD_M })} arrow>
              <Chip
                icon={<WrongLocationIcon sx={{ fontSize: 14 }} />}
                label={t("edit.shape.fit.offTrace", { count: offCount })}
                size="small"
                color="error"
                onClick={onFlyOffTrace}
                data-testid="shape-fit-offtrace"
                sx={{ fontSize: 10, height: 20, fontWeight: 700 }}
              />
            </Tooltip>
          )}
          {orderCount > 0 && (
            <Tooltip title={t("edit.shape.fit.orderTooltip")} arrow>
              <Chip
                icon={<LowPriorityIcon sx={{ fontSize: 14 }} />}
                label={t("edit.shape.fit.order", { count: orderCount })}
                size="small"
                color="warning"
                onClick={onFlyOutOfOrder}
                data-testid="shape-fit-order"
                sx={{ fontSize: 10, height: 20, fontWeight: 700 }}
              />
            </Tooltip>
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

        <Divider sx={{ my: 0.25 }} />

        {/* Section / vertex selection */}
        {selection ? (
          <Box
            data-testid="shape-selection-panel"
            sx={{
              border: `1px solid ${alpha(SELECTION_COLOR, 0.6)}`,
              background: alpha(SELECTION_COLOR, 0.08),
              borderRadius: 1.5,
              px: 1,
              py: 0.75,
              display: "flex",
              flexDirection: "column",
              gap: 0.5,
            }}
          >
            <Box display="flex" alignItems="center" gap={0.5}>
              <Typography variant="caption" fontWeight={700} sx={{ fontSize: 11, flex: 1 }}>
                {hasRange
                  ? t("edit.shape.selection.range", {
                      from: selection.start + 1,
                      to: selection.end + 1,
                      count: rangeCount,
                      m: Math.round(selectionDistanceM),
                    })
                  : t("edit.shape.selection.single", { n: selection.start + 1 })}
              </Typography>
              <IconButton
                size="small"
                onClick={onClearSelection}
                aria-label={t("app.close")}
                sx={{ p: 0.2 }}
              >
                <CloseIcon sx={{ fontSize: 13 }} />
              </IconButton>
            </Box>
            {!hasRange && (
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, lineHeight: 1.3 }}>
                {t("edit.shape.selection.hintShift")}
              </Typography>
            )}
            <Box display="flex" gap={0.5}>
              <Tooltip title={t("edit.shape.selection.rerouteTooltip")} arrow>
                <span style={{ flex: 1, display: "flex" }}>
                  <Button
                    size="small"
                    variant="contained"
                    onClick={onSectionReroute}
                    disabled={!hasRange || routing}
                    startIcon={<AltRouteIcon sx={{ fontSize: 14 }} />}
                    data-testid="shape-section-reroute"
                    sx={{ flex: 1, fontSize: 10, px: 0.5 }}
                  >
                    {t("edit.shape.selection.reroute")}
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={t("edit.shape.selection.straightenTooltip")} arrow>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={onSectionStraighten}
                    disabled={!hasRange || rangeCount < 3}
                    data-testid="shape-section-straighten"
                    sx={{ minWidth: 0, px: 0.75 }}
                  >
                    <HorizontalRuleIcon sx={{ fontSize: 16 }} />
                  </Button>
                </span>
              </Tooltip>
              <Tooltip title={t("edit.shape.selection.deleteTooltip")} arrow>
                <span>
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    onClick={onSelectionDelete}
                    disabled={pointCount - rangeCount < 2}
                    data-testid="shape-section-delete"
                    sx={{ minWidth: 0, px: 0.75 }}
                  >
                    <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                  </Button>
                </span>
              </Tooltip>
            </Box>
          </Box>
        ) : (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ fontSize: 10, lineHeight: 1.4, opacity: 0.85 }}
          >
            {extending ? t("edit.shape.hintExtend") : t("edit.shape.hintSelect")}
          </Typography>
        )}

        {/* Extend line: where new points go + road snapping */}
        <Box display="flex" gap={0.5} alignItems="center">
          <Button
            size="small"
            variant={extending ? "contained" : "outlined"}
            color={extending ? "success" : "inherit"}
            onClick={onToggleExtend}
            startIcon={<AddIcon sx={{ fontSize: 14 }} />}
            data-testid="shape-extend"
            sx={{ flex: 1, fontSize: 11 }}
          >
            {t("edit.shape.extendLine")}
          </Button>
          {extending && (
            <ToggleButtonGroup
              size="small"
              exclusive
              value={extendAt}
              onChange={(_e, v) => v && onExtendAtChange(v)}
              aria-label={t("edit.shape.extendAt")}
            >
              <ToggleButton value="start" sx={{ px: 0.6, py: 0.3 }} data-testid="shape-extend-start">
                <Tooltip title={t("edit.shape.extendAtStart")} arrow>
                  <FirstPageIcon sx={{ fontSize: 16 }} />
                </Tooltip>
              </ToggleButton>
              <ToggleButton value="end" sx={{ px: 0.6, py: 0.3 }} data-testid="shape-extend-end">
                <Tooltip title={t("edit.shape.extendAtEnd")} arrow>
                  <LastPageIcon sx={{ fontSize: 16 }} />
                </Tooltip>
              </ToggleButton>
            </ToggleButtonGroup>
          )}
        </Box>
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
          sx={{ mx: 0, mt: -0.5 }}
        />

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

        {/* History + reverse */}
        <Box display="flex" gap={0.5} alignItems="center">
          <SmallIconButton
            title={`${t("edit.undoTooltip")} (Ctrl+Z)`}
            testid="shape-undo"
            disabled={!undoAvailable}
            onClick={onUndo}
          >
            <UndoIcon sx={{ fontSize: 16 }} />
          </SmallIconButton>
          <SmallIconButton
            title={`${t("edit.redoTooltip")} (Ctrl+Shift+Z)`}
            testid="shape-redo"
            disabled={!redoAvailable}
            onClick={onRedo}
          >
            <RedoIcon sx={{ fontSize: 16 }} />
          </SmallIconButton>
          <SmallIconButton
            title={t("edit.shape.reverse")}
            testid="shape-reverse"
            disabled={!canReverse}
            onClick={onReverse}
          >
            <SwapCallsIcon sx={{ fontSize: 16 }} />
          </SmallIconButton>
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: 9, opacity: 0.7 }}>
            {t("edit.shape.hintKeysShort")}
          </Typography>
        </Box>

        {/* Save / cancel */}
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
            data-testid="shape-save"
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
// fitStops: ordered stops ({stop_id, stop_name, lat, lon}) the edited shape
// is expected to serve — the pattern's stops in Shape Studio. Drives the
// numbered badges and the off-trace / out-of-order feedback.
function ShapeEditorOverlay({ editShapeRequest = null, fitStops = null }) {
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
  const [extendAt, setExtendAt] = useState("end"); // "end" | "start"
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
  // Vertex / section selection: { anchor, start, end } (indices, start ≤ end)
  const [selection, setSelection] = useState(null);
  // Bumped on every map move so the visible-vertex window is recomputed.
  const [viewTick, setViewTick] = useState(0);
  // Cycling cursors for the "fly to next problem stop" chips.
  const fitCursorRef = useRef({ off: 0, order: 0 });

  // Post-save link dialog (standalone "draw new shape" only). When the user
  // created a shape without pre-selected trips, we offer a dedicated dialog
  // to attach the orphan shape to one or more trips after save.
  const [postSaveLinkOpen, setPostSaveLinkOpen] = useState(false);
  const [savedShapeId, setSavedShapeId] = useState(null);
  const [savedPointCount, setSavedPointCount] = useState(0);
  const [savedDistanceKm, setSavedDistanceKm] = useState("0");
  const [savedContext, setSavedContext] = useState(null);

  // Confirmation dialog state (replaces window.confirm / confirm)
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    message: "",
    onConfirm: null,
  });

  const routingRef = useRef(0); // cancel stale routing calls
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  // Abort controller for the current /edit/shapes/:id fetch. Switching to
  // another shape (or unmounting) cancels the previous request so the editor
  // never loads the wrong shape's points on top of newer state.
  const loadAbortRef = useRef(null);
  // Abort controller shared by all OSRM requests issued from the current
  // extend-click session. Cancelling it aborts in-flight routing on
  // unmount / cancel / save / shape switch.
  const osrmAbortRef = useRef(null);
  // Abort controller of an in-flight section re-route (kept apart from the
  // extend-click controller so one never cancels the other).
  const rerouteAbortRef = useRef(null);
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

  useMapEvents({
    moveend: () => setViewTick((n) => n + 1),
    zoomend: () => setViewTick((n) => n + 1),
  });

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

  // How well the current geometry serves the pattern's stops.
  const fit = useMemo(() => {
    if (!activeShapeId || !Array.isArray(fitStops) || fitStops.length === 0) return null;
    if (points.length < 2) return null;
    return analyzeStopFit(points, fitStops, { thresholdM: FIT_THRESHOLD_M });
  }, [activeShapeId, fitStops, points]);

  const selectionDistanceM = useMemo(() => {
    if (!selection || selection.end <= selection.start) return 0;
    const slice = points.slice(selection.start, selection.end + 1);
    return parseFloat(totalDistanceKm(slice)) * 1000;
  }, [selection, points]);

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
  // shared-trips banner, hover highlight, selection. Also re-arms the
  // once-per-session OSRM fallback warning.
  const resetHistoryStacks = useCallback(() => {
    setHistory([]);
    setRedoStack([]);
    setSimplifyOpen(false);
    setSimplifyTolerance(5);
    setSharedTripCount(0);
    setLineHover(false);
    setSelection(null);
    setExtendAt("end");
    fitCursorRef.current = { off: 0, order: 0 };
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
      setSelection(null);
    },
    [pushUndo],
  );

  // Click selects a vertex; Shift+click extends the selection into a
  // section running from the anchor vertex to the clicked one.
  const handleVertexClick = useCallback((index, e) => {
    const shift = Boolean(e?.originalEvent?.shiftKey);
    setSelection((prev) => {
      if (shift && prev) {
        const anchor = prev.anchor;
        return {
          anchor,
          start: Math.min(anchor, index),
          end: Math.max(anchor, index),
        };
      }
      if (prev && prev.start === prev.end && prev.start === index) return null;
      return { anchor: index, start: index, end: index };
    });
  }, []);

  const handleClearSelection = useCallback(() => setSelection(null), []);

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
      setSelection(null);
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
    setSelection(null);
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
    setSelection(null);
  }, []);

  const handleReverse = useCallback(() => {
    if (pointsRef.current.length < 2) return;
    pushUndo();
    setPoints((prev) => [...prev].reverse());
    setSelection(null);
  }, [pushUndo]);

  // ── Section tools ───────────────────────────────────────────────────────

  // Replace the vertices strictly between the selection's ends with a road
  // route between those two vertices.
  const handleSectionReroute = useCallback(async () => {
    const sel = selectionRef.current;
    const pts = pointsRef.current;
    if (!sel || sel.end <= sel.start || !pts[sel.start] || !pts[sel.end]) return;
    const controller = new AbortController();
    rerouteAbortRef.current?.abort();
    rerouteAbortRef.current = controller;
    setRouting(true);
    try {
      const routed = await fetchRoadRouteVia([pts[sel.start], pts[sel.end]], {
        signal: controller.signal,
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      if (!routed || routed.length < 2) {
        showToast(t("edit.shape.osrmFallback"), "warning");
        return;
      }
      const interior = routed.slice(1, -1);
      pushUndo();
      const base = pointsRef.current;
      const next = [...base.slice(0, sel.start + 1), ...interior, ...base.slice(sel.end)];
      setPoints(next);
      setSelection({
        anchor: sel.start,
        start: sel.start,
        end: sel.start + interior.length + 1,
      });
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (mountedRef.current) showToast(t("edit.shape.osrmFallback"), "warning");
    } finally {
      if (mountedRef.current && rerouteAbortRef.current === controller) {
        rerouteAbortRef.current = null;
        setRouting(false);
      }
    }
  }, [pushUndo, showToast, t]);

  // Drop the interior vertices of the section: a straight segment remains.
  const handleSectionStraighten = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel || sel.end - sel.start < 2) return;
    pushUndo();
    setPoints((prev) => [...prev.slice(0, sel.start + 1), ...prev.slice(sel.end)]);
    setSelection({ anchor: sel.start, start: sel.start, end: sel.start + 1 });
  }, [pushUndo]);

  // Remove every selected vertex (the shape keeps at least two points).
  const handleSelectionDelete = useCallback(() => {
    const sel = selectionRef.current;
    if (!sel) return;
    const count = sel.end - sel.start + 1;
    if (pointsRef.current.length - count < 2) return;
    pushUndo();
    setPoints((prev) => [...prev.slice(0, sel.start), ...prev.slice(sel.end + 1)]);
    setSelection(null);
  }, [pushUndo]);

  // ── Fit navigation ──────────────────────────────────────────────────────
  const flyToFitEntry = useCallback(
    (list, key) => {
      if (!list || list.length === 0) return;
      const idx = fitCursorRef.current[key] % list.length;
      fitCursorRef.current[key] = idx + 1;
      const entry = list[idx];
      const lat = Number(entry.stop.lat ?? entry.stop.stop_lat);
      const lon = Number(entry.stop.lon ?? entry.stop.stop_lon);
      map.flyTo([lat, lon], Math.max(map.getZoom(), 16), { duration: 0.6 });
    },
    [map],
  );
  const handleFlyOffTrace = useCallback(
    () => flyToFitEntry(fit?.offTrace, "off"),
    [fit, flyToFitEntry],
  );
  const handleFlyOutOfOrder = useCallback(
    () => flyToFitEntry(fit?.outOfOrder, "order"),
    [fit, flyToFitEntry],
  );

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
      // The new vertex becomes the selection so it can be dragged / deleted
      // right away.
      setSelection({
        anchor: nearest.index + 1,
        start: nearest.index + 1,
        end: nearest.index + 1,
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
    rerouteAbortRef.current?.abort();
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
      window.dispatchEvent(
        new CustomEvent("shapeEditorClosed", {
          detail: { shapeId: activeShapeId, saved: true, created: isCreate },
        }),
      );
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
    resetHistoryStacks,
  ]);

  // Extracted cancel logic — called directly when not dirty, or from dialog onConfirm
  const doCancelEditor = useCallback(() => {
    routingRef.current++; // cancel any in-flight OSRM request (legacy guard)
    osrmAbortRef.current?.abort();
    rerouteAbortRef.current?.abort();
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
  }, [resetHistoryStacks]);

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
    setSelection(null);
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
      setSelection(null);
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
      rerouteAbortRef.current?.abort();
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
    [map, showToast, t, resetHistoryStacks],
  );

  // Initialise the editor in "create" mode with a blank shape, optional pre-seeded
  // points (typically the stops of the target trips) and a list of trip_ids to bulk-link
  // on save.
  const loadCreateMode = useCallback(
    ({ shapeId, initialPoints = [], linkTripIds: tripIds = [], context = null }) => {
      // Cancel any in-flight shape load / OSRM routing from a prior session.
      loadAbortRef.current?.abort();
      osrmAbortRef.current?.abort();
      rerouteAbortRef.current?.abort();
      routingRef.current++;
      setRouting(false);
      resetHistoryStacks();
      setMode("create");
      setLinkTripIds(Array.isArray(tripIds) ? tripIds : []);
      setSavedContext(context);
      setOriginalPoints([]);
      const seed = (initialPoints || []).filter(
        (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
      );
      setPoints(seed.map((p) => ({ lat: p.lat, lon: p.lon })));
      setActiveShapeId(shapeId);
      // A blank shape starts in extend mode so the first click adds a point;
      // a pre-seeded one starts in select mode so the user can fix it.
      setExtending(seed.length < 2);
      window.dispatchEvent(
        new CustomEvent("shapeEditorActive", { detail: { shapeId } }),
      );
      if (seed.length > 0) {
        const bounds = L.latLngBounds(seed.map((p) => [p.lat, p.lon]));
        map.fitBounds(bounds, { padding: [80, 80], maxZoom: 16 });
      }
    },
    [map, resetHistoryStacks],
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
      rerouteAbortRef.current?.abort();
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
    // While a shape is being edited, Ctrl+Z / Ctrl+Shift+Z belong to the
    // local vertex history. The global EditModeContext handler reads this
    // flag and stays out of the way (otherwise one keypress would undo a
    // vertex locally AND the last saved edit on the server).
    window.__gtfsShapeEditorActive = Boolean(activeShapeId);
    window.dispatchEvent(
      new CustomEvent("shapeEditorDirtyChanged", { detail: { dirty: isDirty } }),
    );
    return () => {
      window.__gtfsShapeEditorDirty = false;
      window.__gtfsShapeEditorActive = false;
    };
  }, [activeShapeId, dirty]);

  // Keyboard: Escape closes the simplify panel, then clears the selection,
  // then exits extend mode, then cancels the editor. Delete removes the
  // selected vertices. Ctrl+Z / Ctrl+Shift+Z drive the local history.
  useEffect(() => {
    if (!activeShapeId) return;
    const onKey = (e) => {
      // Leave text fields alone: keys inside an input edit the text, not
      // the shape.
      const tag = document.activeElement?.tagName;
      const inField =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        document.activeElement?.isContentEditable;
      if (e.key === "Escape") {
        if (inField) return;
        if (simplifyOpen) {
          setSimplifyOpen(false);
        } else if (selectionRef.current) {
          setSelection(null);
        } else if (extending) {
          setExtending(false);
        } else {
          handleCancel();
        }
        return;
      }
      if (inField) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectionRef.current) {
        e.preventDefault();
        handleSelectionDelete();
        return;
      }
      // Ctrl+Z = local undo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
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
  }, [
    activeShapeId,
    simplifyOpen,
    extending,
    handleCancel,
    handleUndo,
    handleRedo,
    handleSelectionDelete,
  ]);

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
    const atStart = extendAt === "start";

    const onClick = (e) => {
      const clicked = { lat: e.latlng.lat, lon: e.latlng.lng };

      queue = queue
        .then(async () => {
          if (cancelled) return;
          const current = pointsRef.current;
          // Push current state to undo stack BEFORE appending anything
          setHistory((h) => [...h.slice(-49), current]);
          setRedoStack([]);

          const addStraight = () =>
            setPoints((cur) => (atStart ? [clicked, ...cur] : [...cur, clicked]));

          if (!snapToRoad || current.length === 0) {
            addStraight();
            return;
          }

          const anchor = atStart ? current[0] : current[current.length - 1];
          setRouting(true);

          try {
            const routed = await fetchRoadRouteVia(
              atStart ? [clicked, anchor] : [anchor, clicked],
              { signal: controller.signal },
            );
            if (cancelled) return;
            if (routed && routed.length > 1) {
              setPoints((cur) =>
                atStart
                  ? [...routed.slice(0, -1), ...cur]
                  : [...cur, ...routed.slice(1)],
              );
            } else {
              // Fallback: straight line if routing failed
              if (!osrmWarnedRef.current) {
                osrmWarnedRef.current = true;
                showToast(t("edit.shape.osrmFallback"), "warning");
              }
              addStraight();
            }
          } catch (err) {
            if (err?.name === "AbortError") return;
            if (cancelled) return;
            // Unexpected routing error → straight-line fallback
            if (!osrmWarnedRef.current) {
              osrmWarnedRef.current = true;
              showToast(t("edit.shape.osrmFallback"), "warning");
            }
            addStraight();
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
  }, [activeShapeId, extending, extendAt, snapToRoad, map, showToast, t]);

  // Clicking the empty map (outside extend mode) clears the selection.
  useEffect(() => {
    if (!activeShapeId || extending) return;
    const onClick = () => {
      if (selectionRef.current) setSelection(null);
    };
    map.on("click", onClick);
    return () => map.off("click", onClick);
  }, [activeShapeId, extending, map]);

  // ── Visible vertex window ───────────────────────────────────────────────
  // Only vertices inside the (padded) viewport get a marker. When the
  // visible stretch still holds too many, it is decimated evenly — every
  // vertex comes back as the user zooms in, so long shapes stay editable
  // everywhere. Endpoints and the selection are always rendered.
  const visibleVertices = useMemo(() => {
    if (!activeShapeId || points.length === 0) return { indices: [], stride: 1 };
    let bounds;
    try {
      bounds = map.getBounds().pad(0.15);
    } catch {
      bounds = null;
    }
    const inView = [];
    for (let i = 0; i < points.length; i++) {
      if (!bounds || bounds.contains([points[i].lat, points[i].lon])) inView.push(i);
    }
    const stride =
      inView.length > MAX_VISIBLE_VERTICES
        ? Math.ceil(inView.length / MAX_VISIBLE_VERTICES)
        : 1;
    const last = points.length - 1;
    const keep = new Set();
    inView.forEach((i, k) => {
      if (k % stride === 0) keep.add(i);
    });
    keep.add(0);
    keep.add(last);
    if (selection) {
      for (let i = selection.start; i <= selection.end && i - selection.start < 2000; i++) {
        keep.add(i);
      }
    }
    return { indices: [...keep].sort((a, b) => a - b), stride };
    // viewTick is the map-move signal; the bounds are read from the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShapeId, points, selection, map, viewTick]);

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
          defaultRouteId={savedContext?.routeId || null}
          defaultDirectionId={savedContext?.directionId ?? null}
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

  // Midpoints between consecutive visible vertices (only when the visible
  // stretch is not decimated, otherwise a midpoint would not sit between
  // real neighbours).
  const midpoints = [];
  if (visibleVertices.stride === 1 && visibleVertices.indices.length <= MAX_MIDPOINTS) {
    const set = new Set(visibleVertices.indices);
    for (const i of visibleVertices.indices) {
      if (i < points.length - 1 && set.has(i + 1)) {
        midpoints.push({
          index: i,
          lat: (points[i].lat + points[i + 1].lat) / 2,
          lon: (points[i].lon + points[i + 1].lon) / 2,
        });
      }
    }
  }

  const selectionPositions =
    selection && selection.end > selection.start
      ? positions.slice(selection.start, selection.end + 1)
      : null;

  const fitKindByIndex = new Map();
  if (fit) {
    for (const r of fit.results) {
      fitKindByIndex.set(r.index, r.offTrace ? "off" : r.outOfOrder ? "order" : "ok");
    }
  }

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

      {/* Selected section highlight */}
      {selectionPositions && (
        <Polyline
          positions={selectionPositions}
          color={SELECTION_COLOR}
          weight={8}
          opacity={0.6}
          interactive={false}
        />
      )}

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

      {/* Numbered badges on the pattern's stops */}
      {Array.isArray(fitStops) &&
        fitStops.map((s, i) => {
          const lat = Number(s.lat ?? s.stop_lat);
          const lon = Number(s.lon ?? s.stop_lon);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
          return (
            <Marker
              key={`fit-${s.stop_id || i}`}
              position={[lat, lon]}
              icon={makeStopBadge(i + 1, fitKindByIndex.get(i) || "ok")}
              interactive={false}
              zIndexOffset={500}
            />
          );
        })}

      {/* Midpoint markers — click to insert a new vertex */}
      {midpoints.map((mp) => (
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

      {/* Draggable vertex markers (visible window) */}
      {visibleVertices.indices.map((i) => {
        const p = points[i];
        const isEndpoint = i === 0 || i === points.length - 1;
        const isSelected = selection && i >= selection.start && i <= selection.end;
        const isExtendTarget =
          extending && (extendAt === "start" ? i === 0 : i === points.length - 1);
        const icon = isExtendTarget
          ? extendTargetIcon
          : isSelected
            ? isEndpoint
              ? selectedEndpointIcon
              : selectedVertexIcon
            : isEndpoint
              ? endpointIcon
              : vertexIcon;
        return (
          <Marker
            key={`v-${i}`}
            position={[p.lat, p.lon]}
            icon={icon}
            draggable
            zIndexOffset={isSelected ? 1000 : 0}
            eventHandlers={{
              click: (e) => {
                L.DomEvent.stopPropagation(e);
                handleVertexClick(i, e);
              },
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
        extendAt={extendAt}
        undoAvailable={history.length > 0}
        redoAvailable={redoStack.length > 0}
        canReverse={points.length >= 2}
        mode={mode}
        linkTripCount={linkTripIds.length}
        sharedTripCount={sharedTripCount}
        selection={selection}
        selectionDistanceM={selectionDistanceM}
        fit={fit}
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
        onExtendAtChange={setExtendAt}
        onToggleSnap={handleToggleSnap}
        onToggleSimplify={handleToggleSimplify}
        onSimplifyToleranceChange={handleSimplifyToleranceChange}
        onSimplifyApply={handleSimplifyApply}
        onSimplifyCancel={handleSimplifyCancel}
        onSectionReroute={handleSectionReroute}
        onSectionStraighten={handleSectionStraighten}
        onSelectionDelete={handleSelectionDelete}
        onClearSelection={handleClearSelection}
        onFlyOffTrace={handleFlyOffTrace}
        onFlyOutOfOrder={handleFlyOutOfOrder}
      />
    </>
  );
}

export default ShapeEditorOverlay;
