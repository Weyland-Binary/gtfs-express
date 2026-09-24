import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Chip,
  CircularProgress,
  LinearProgress,
  Alert,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
} from "@mui/material";
import { useTheme, alpha } from "@mui/material/styles";
import TimelineIcon from "@mui/icons-material/Timeline";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import GestureIcon from "@mui/icons-material/Gesture";
import StraightenIcon from "@mui/icons-material/Straighten";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import {
  routeThroughStops,
  straightThroughStops,
} from "../../utils/osrmRouting";

const BLANK = "__blank__";

// Short, sortable, collision-free id for a shape generated from a pattern.
export function buildShapeId(routeId, directionId, existing = new Set()) {
  const safeRoute = String(routeId || "route")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 32);
  const dir = directionId != null && directionId !== "" ? String(directionId) : "x";
  const base = `shp_${safeRoute}_${dir}`;
  let candidate = base;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${base}_${n}`;
    n += 1;
  }
  return candidate;
}

function directionWord(directionId, t) {
  if (directionId == null || directionId === "") return t("shapeStudio.new.direction", { id: "—" });
  const d = String(directionId);
  if (d === "0") return `→ ${t("shapeStudio.label.outbound")}`;
  if (d === "1") return `← ${t("shapeStudio.label.inbound")}`;
  return t("shapeStudio.new.direction", { id: d });
}

// "New shape" flow of the Shape Studio: pick the stop pattern the shape must
// follow (or a blank shape), pick how to build it, create it — or generate
// every missing shape of the line in one go.
export default function NewShapeDialog({
  open,
  onClose,
  routeId,
  routeLabel,
  existingShapeIds,
  onCreate,
  onGenerated,
}) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { recordEdit, showToast } = useEditMode();

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [patterns, setPatterns] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [method, setMethod] = useState("road");
  // { phase: "routing" | "generating", done, total } while OSRM / saves run.
  const [busy, setBusy] = useState(null);
  const abortRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // Load the line's patterns on open.
  useEffect(() => {
    if (!open || !routeId) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setPatterns([]);
    setSelectedKey(null);
    setMethod("road");
    setBusy(null);
    fetchWithSession(`${API_BASE_URL}/route_patterns/${encodeURIComponent(routeId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => {
        if (cancelled) return;
        const list = Array.isArray(body?.patterns) ? body.patterns : [];
        setPatterns(list);
        // Pre-select the first pattern lacking a shape, else the busiest one.
        const first = list.find((p) => p.trips_without_shape > 0) || list[0];
        setSelectedKey(first ? first.pattern_id : BLANK);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || "error");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, routeId]);

  const selected = useMemo(
    () => patterns.find((p) => p.pattern_id === selectedKey) || null,
    [patterns, selectedKey],
  );
  const missingPatterns = useMemo(
    () => patterns.filter((p) => p.trips_without_shape > 0),
    [patterns],
  );

  const handleClose = useCallback(() => {
    if (busy) {
      abortRef.current?.abort();
      setBusy(null);
    }
    onClose();
  }, [busy, onClose]);

  // ── Create one shape (opens the editor) ─────────────────────────────────
  const handleCreate = useCallback(async () => {
    const existing = new Set([...(existingShapeIds || [])]);
    if (selectedKey === BLANK || !selected) {
      onCreate({
        shapeId: buildShapeId(routeId, null, existing),
        points: [],
        linkTripIds: [],
        fitStops: null,
        context: { routeId, directionId: null },
      });
      return;
    }
    const shapeId = buildShapeId(routeId, selected.direction_id, existing);
    const context = { routeId, directionId: selected.direction_id ?? null };
    const stops = selected.stops || [];
    if (method === "draw") {
      onCreate({ shapeId, points: [], linkTripIds: selected.trip_ids, fitStops: stops, context });
      return;
    }
    if (method === "straight") {
      onCreate({
        shapeId,
        points: straightThroughStops(stops),
        linkTripIds: selected.trip_ids,
        fitStops: stops,
        context,
      });
      return;
    }
    // Along roads
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy({ phase: "routing", done: 0, total: Math.max(1, stops.length - 1) });
    try {
      const { points, fallbacks } = await routeThroughStops(stops, {
        signal: controller.signal,
        onProgress: (done, total) => {
          if (mountedRef.current) setBusy({ phase: "routing", done, total });
        },
      });
      if (!mountedRef.current || controller.signal.aborted) return;
      if (fallbacks > 0) {
        showToast(t("shapeStudio.new.routingFallback", { count: fallbacks }), "warning");
      }
      onCreate({ shapeId, points, linkTripIds: selected.trip_ids, fitStops: stops, context });
    } catch (err) {
      if (err?.name === "AbortError") return;
      if (mountedRef.current) showToast(t("edit.shape.autoGenError"), "error");
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [existingShapeIds, selectedKey, selected, routeId, method, onCreate, showToast, t]);

  // ── Generate every missing shape and save them directly ─────────────────
  const handleGenerateAll = useCallback(async () => {
    if (missingPatterns.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const existing = new Set([...(existingShapeIds || [])]);
    let created = 0;
    let linked = 0;
    let failed = 0;
    setBusy({ phase: "generating", done: 0, total: missingPatterns.length });
    try {
      for (let i = 0; i < missingPatterns.length; i++) {
        if (controller.signal.aborted) break;
        const p = missingPatterns[i];
        const shapeId = buildShapeId(routeId, p.direction_id, existing);
        existing.add(shapeId);
        try {
          const { points } = await routeThroughStops(p.stops || [], {
            signal: controller.signal,
          });
          if (points.length < 2) throw new Error("too few points");
          const res = await fetchWithSession(`${API_BASE_URL}/edit/shapes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              shape_id: shapeId,
              points,
              link_trip_ids: p.trip_ids_without_shape || p.trip_ids,
            }),
            signal: controller.signal,
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
          created += 1;
          linked += body.linked_trips || 0;
          // One undo step per generated shape; the summary toast comes last.
          recordEdit("", body.validation, {
            entity: "shape",
            entityId: shapeId,
            noUndoAction: true,
          });
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          failed += 1;
        }
        if (mountedRef.current) {
          setBusy({ phase: "generating", done: i + 1, total: missingPatterns.length });
        }
      }
    } catch (err) {
      if (err?.name !== "AbortError") console.error("generate all error:", err);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
    if (!mountedRef.current) return;
    if (created > 0) {
      showToast(
        t("shapeStudio.new.generatedToast", { count: created, trips: linked }),
        "success",
      );
    }
    if (failed > 0) {
      showToast(t("shapeStudio.new.generateFailed", { count: failed }), "error");
    }
    if (created > 0) {
      onGenerated?.();
      onClose();
    }
  }, [missingPatterns, existingShapeIds, routeId, recordEdit, showToast, t, onGenerated, onClose]);

  const canCreate =
    !loading && !busy && (selectedKey === BLANK || (selected && (selected.stops || []).length >= 2 || method === "draw"));

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : handleClose}
      maxWidth="sm"
      fullWidth
      data-testid="new-shape-dialog"
    >
      <DialogTitle sx={{ pb: 0.5 }}>
        <Box display="flex" alignItems="center" gap={1}>
          <TimelineIcon color="success" />
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" component="span" fontWeight={700}>
              {t("shapeStudio.new.title")}
            </Typography>
            {routeLabel && (
              <Typography variant="body2" color="text.secondary" noWrap>
                {routeLabel}
              </Typography>
            )}
          </Box>
        </Box>
      </DialogTitle>
      <DialogContent dividers sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Typography variant="body2" color="text.secondary">
          {t("shapeStudio.new.subtitle")}
        </Typography>

        {loadError && <Alert severity="error">{loadError}</Alert>}

        {loading ? (
          <Box display="flex" alignItems="center" gap={1.5} py={2}>
            <CircularProgress size={20} />
            <Typography variant="body2" color="text.secondary">
              {t("shapeStudio.new.loading")}
            </Typography>
          </Box>
        ) : (
          <>
            <Typography variant="overline" sx={{ color: "text.secondary", fontWeight: 700 }}>
              {t("shapeStudio.new.patternsHeading")}
            </Typography>
            {patterns.length === 0 && !loadError && (
              <Alert severity="info">{t("shapeStudio.new.noPatterns")}</Alert>
            )}
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                gap: 0.75,
                maxHeight: 300,
                overflowY: "auto",
                pr: 0.5,
              }}
            >
              {patterns.map((p) => {
                const sel = p.pattern_id === selectedKey;
                const missing = p.trips_without_shape > 0;
                const allMissing = p.trips_without_shape === p.trip_count;
                return (
                  <Box
                    key={p.pattern_id}
                    role="button"
                    tabIndex={0}
                    data-testid="new-shape-pattern"
                    onClick={() => !busy && setSelectedKey(p.pattern_id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedKey(p.pattern_id);
                      }
                    }}
                    sx={{
                      cursor: "pointer",
                      borderRadius: 1.5,
                      px: 1.25,
                      py: 1,
                      border: `1px solid ${sel ? theme.palette.primary.main : theme.palette.divider}`,
                      backgroundColor: sel
                        ? alpha(theme.palette.primary.main, 0.1)
                        : "transparent",
                      "&:hover": { backgroundColor: alpha(theme.palette.primary.main, 0.06) },
                    }}
                  >
                    <Box display="flex" alignItems="center" gap={1}>
                      <Typography variant="body2" fontWeight={700} noWrap sx={{ flex: 1, minWidth: 0 }}>
                        {directionWord(p.direction_id, t)}
                        {p.headsign ? ` — ${p.headsign}` : ""}
                      </Typography>
                      {allMissing ? (
                        <Chip
                          size="small"
                          color="error"
                          variant="outlined"
                          label={t("shapeStudio.new.noShape")}
                          sx={{ height: 20, fontSize: 10 }}
                        />
                      ) : missing ? (
                        <Chip
                          size="small"
                          color="warning"
                          variant="outlined"
                          label={t("shapeStudio.new.partialShape", {
                            missing: p.trips_without_shape,
                            count: p.trip_count,
                          })}
                          sx={{ height: 20, fontSize: 10 }}
                        />
                      ) : p.shapes.length === 1 ? (
                        <Chip
                          size="small"
                          variant="outlined"
                          label={t("shapeStudio.new.hasShape", { id: p.shapes[0].shape_id })}
                          sx={{ height: 20, fontSize: 10, fontFamily: "monospace" }}
                        />
                      ) : (
                        <Chip
                          size="small"
                          variant="outlined"
                          label={t("shapeStudio.new.hasShapes", { count: p.shapes.length })}
                          sx={{ height: 20, fontSize: 10 }}
                        />
                      )}
                    </Box>
                    <Typography variant="caption" color="text.secondary">
                      {t("shapeStudio.card.stops", { count: p.stop_count })}
                      {" · "}
                      {t("shapeStudio.new.patternTrips", { count: p.trip_count })}
                      {p.stops?.length > 0 &&
                        ` · ${p.stops[0].stop_name || p.stops[0].stop_id} → ${
                          p.stops[p.stops.length - 1].stop_name || p.stops[p.stops.length - 1].stop_id
                        }`}
                    </Typography>
                  </Box>
                );
              })}
              <Box
                role="button"
                tabIndex={0}
                data-testid="new-shape-blank"
                onClick={() => !busy && setSelectedKey(BLANK)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedKey(BLANK);
                  }
                }}
                sx={{
                  cursor: "pointer",
                  borderRadius: 1.5,
                  px: 1.25,
                  py: 1,
                  border: `1px dashed ${
                    selectedKey === BLANK ? theme.palette.primary.main : theme.palette.divider
                  }`,
                  backgroundColor:
                    selectedKey === BLANK ? alpha(theme.palette.primary.main, 0.1) : "transparent",
                }}
              >
                <Box display="flex" alignItems="center" gap={1}>
                  <GestureIcon fontSize="small" color="action" />
                  <Typography variant="body2" fontWeight={600}>
                    {t("shapeStudio.new.blank")}
                  </Typography>
                </Box>
                <Typography variant="caption" color="text.secondary">
                  {t("shapeStudio.new.blankHint")}
                </Typography>
              </Box>
            </Box>

            {selected && selected.trips_without_shape < selected.trip_count && (
              <Alert severity="info" sx={{ py: 0 }}>
                {t("shapeStudio.new.replaceWarning", { count: selected.trip_count })}
              </Alert>
            )}

            {selectedKey !== BLANK && (
              <>
                <Typography variant="overline" sx={{ color: "text.secondary", fontWeight: 700 }}>
                  {t("shapeStudio.new.method")}
                </Typography>
                <ToggleButtonGroup
                  exclusive
                  fullWidth
                  size="small"
                  value={method}
                  onChange={(_e, v) => v && setMethod(v)}
                  disabled={Boolean(busy)}
                >
                  <ToggleButton value="road" data-testid="new-shape-method-road" sx={{ flexDirection: "column", py: 1 }}>
                    <AltRouteIcon fontSize="small" />
                    <Typography variant="caption" fontWeight={700}>
                      {t("shapeStudio.new.methodRoad")}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, textTransform: "none" }}>
                      {t("shapeStudio.new.methodRoadHint")}
                    </Typography>
                  </ToggleButton>
                  <ToggleButton value="straight" data-testid="new-shape-method-straight" sx={{ flexDirection: "column", py: 1 }}>
                    <StraightenIcon fontSize="small" />
                    <Typography variant="caption" fontWeight={700}>
                      {t("shapeStudio.new.methodStraight")}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, textTransform: "none" }}>
                      {t("shapeStudio.new.methodStraightHint")}
                    </Typography>
                  </ToggleButton>
                  <ToggleButton value="draw" data-testid="new-shape-method-draw" sx={{ flexDirection: "column", py: 1 }}>
                    <GestureIcon fontSize="small" />
                    <Typography variant="caption" fontWeight={700}>
                      {t("shapeStudio.new.methodDraw")}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10, textTransform: "none" }}>
                      {t("shapeStudio.new.methodDrawHint")}
                    </Typography>
                  </ToggleButton>
                </ToggleButtonGroup>
              </>
            )}
          </>
        )}

        {busy && (
          <Box>
            <Typography variant="caption" color="text.secondary">
              {busy.phase === "generating"
                ? t("shapeStudio.new.generating", { done: busy.done, total: busy.total })
                : t("shapeStudio.new.routingProgress", { done: busy.done, total: busy.total })}
            </Typography>
            <LinearProgress
              variant="determinate"
              value={busy.total ? (100 * busy.done) / busy.total : 0}
              sx={{ mt: 0.5, borderRadius: 1 }}
            />
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5, gap: 1 }}>
        {missingPatterns.length > 0 && (
          <Tooltip title={t("shapeStudio.new.generateAllHint")} arrow>
            <span style={{ marginRight: "auto" }}>
              <Button
                onClick={handleGenerateAll}
                disabled={Boolean(busy)}
                startIcon={<AutoFixHighIcon />}
                color="secondary"
                data-testid="new-shape-generate-all"
              >
                {t("shapeStudio.new.generateAll", { count: missingPatterns.length })}
              </Button>
            </span>
          </Tooltip>
        )}
        <Button onClick={handleClose}>{t("app.cancel")}</Button>
        <Button
          variant="contained"
          onClick={handleCreate}
          disabled={!canCreate}
          data-testid="new-shape-create"
          startIcon={busy?.phase === "routing" ? <CircularProgress size={14} color="inherit" /> : null}
        >
          {t("shapeStudio.new.create")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
