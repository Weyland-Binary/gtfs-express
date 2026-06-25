import React, { useEffect, useState } from "react";
import {
  Box,
  Typography,
  Chip,
  CircularProgress,
  List,
  ListItemButton,
  ListItemText,
  ListItemIcon,
  IconButton,
  Tooltip,
  Alert,
  Button,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import PlaceIcon from "@mui/icons-material/Place";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import TimelineIcon from "@mui/icons-material/Timeline";
import GestureIcon from "@mui/icons-material/Gesture";
import { alpha } from "@mui/material/styles";
import { SHAPE_PALETTE } from "../LineMap";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import {
  routeThroughStops,
  straightThroughStops,
} from "../../utils/osrmRouting";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useKeyboardShortcut } from "../../contexts/ShortcutsContext";
import EditRouteDialog from "../edit/EditRouteDialog";
import EditTripDialog from "../edit/EditTripDialog";
import EditAgencyDialog from "../edit/EditAgencyDialog";
import CascadePreviewDialog from "../edit/CascadePreviewDialog";
import PanelSkeleton from "../common/PanelSkeleton";

function RouteDetail({ routeId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel, closePanel } = useDetailPanel();
  const { editing, dataVersion, recordEdit, showToast } = useEditMode();
  const { t } = useLanguage();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [createTripOpen, setCreateTripOpen] = useState(false);
  const [editAgencyOpen, setEditAgencyOpen] = useState(false);
  const [autoGenState, setAutoGenState] = useState({
    dirKey: null,
    mode: null,
    progress: 0,
    total: 0,
  });

  useEffect(() => {
    setLoading(true);
  }, [routeId]);

  useEffect(() => {
    let cancelled = false;
    fetchWithSession(
      `${API_BASE_URL}/route_detail/${encodeURIComponent(routeId)}`,
      { cache: "no-store" },
    )
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [routeId, dataVersion]);

  useKeyboardShortcut({
    id: "duplicate-route-panel",
    keys: ["mod+d"],
    description: "Duplicate current route",
    category: "edit",
    when: () => editing && !!data?.route,
    handler: (e) => {
      e.preventDefault();
      setDuplicateOpen(true);
    },
  });

  if (loading) return <PanelSkeleton />;
  if (!data || !data.route)
    return (
      <Alert severity="error">
        route_id "{routeId}" — {t("detail.notFound")}
      </Alert>
    );

  const { route, agency, directions, stops, trip_count, shape_ids = [], shapes_info = [] } = data;
  const routeColor = `#${route.route_color || "1976d2"}`;
  const textColor = `#${route.route_text_color || "FFFFFF"}`;
  const cardBg = isDark ? "#1a1f2e" : "#ffffff";

  const buildShapeIdForDirection = (direction) => {
    const safeShortName = (route.route_short_name || route.route_id || "route")
      .toString()
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 32);
    const dirSuffix =
      direction.direction_id != null ? direction.direction_id : "0";
    const base = `shp_${safeShortName}_${dirSuffix}`;
    const existing = new Set(shape_ids || []);
    let candidate = base;
    let suffix = 2;
    while (existing.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    return candidate;
  };

  const dispatchCreate = (shapeId, initialPoints, linkTripIds, direction) => {
    const directionId =
      direction?.direction_id != null ? String(direction.direction_id) : null;
    window.dispatchEvent(
      new CustomEvent("createShape", {
        detail: {
          shapeId,
          initialPoints,
          linkTripIds,
          routeId: route.route_id,
          agencyId: route.agency_id,
          directionId,
        },
      }),
    );
  };

  const dirKeyFor = (d) =>
    d.direction_id != null ? String(d.direction_id) : "null";

  const handleDrawShapeForDirection = (direction) => {
    const shapeId = buildShapeIdForDirection(direction);
    const initialPoints = (direction.stops_ordered || []).map((s) => ({
      lat: s.lat,
      lon: s.lon,
    }));
    dispatchCreate(shapeId, initialPoints, direction.trip_ids || [], direction);
  };

  const handleStraightLineForDirection = (direction) => {
    const shapeId = buildShapeIdForDirection(direction);
    const initialPoints = straightThroughStops(direction.stops_ordered || []);
    if (initialPoints.length < 2) {
      showToast(t("edit.shape.autoGenNoStops"), "warning");
      return;
    }
    dispatchCreate(shapeId, initialPoints, direction.trip_ids || [], direction);
  };

  const handleAutoGenForDirection = async (direction) => {
    const stops = direction.stops_ordered || [];
    if (stops.length < 2) {
      showToast(t("edit.shape.autoGenNoStops"), "warning");
      return;
    }
    const dirKey = dirKeyFor(direction);
    setAutoGenState({
      dirKey,
      mode: "auto",
      progress: 0,
      total: stops.length - 1,
    });
    try {
      const { points, fallbacks } = await routeThroughStops(stops, {
        onProgress: (done, total) =>
          setAutoGenState((s) =>
            s.dirKey === dirKey ? { ...s, progress: done, total } : s,
          ),
      });
      const shapeId = buildShapeIdForDirection(direction);
      dispatchCreate(shapeId, points, direction.trip_ids || [], direction);
      if (fallbacks > 0) {
        showToast(
          t("edit.shape.autoGenPartial", {
            fallbacks,
            total: stops.length - 1,
          }),
          "warning",
        );
      } else {
        showToast(
          t("edit.shape.autoGenSuccess", { count: points.length }),
          "success",
        );
      }
    } catch (err) {
      showToast(t("edit.shape.autoGenError"), "error");
    } finally {
      setAutoGenState({ dirKey: null, mode: null, progress: 0, total: 0 });
    }
  };

  const handleDeleteRoute = async () => {
    setDeleting(true);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/routes/${encodeURIComponent(route.route_id)}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) {
        showToast(body.error || "Delete failed", "error");
        setDeleting(false);
        setDeleteConfirmOpen(false);
        return;
      }
      recordEdit(
        t("edit.route.deletedToast", {
          name: route.route_short_name || route.route_id,
        }),
        body.validation,
        { entity: "route", entityId: route.route_id },
      );
      setDeleteConfirmOpen(false);
      closePanel();
    } catch (err) {
      showToast(err.message || "Network error", "error");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Box display="flex" flexDirection="column" gap={2}>
      {/* Route header */}
      <Box
        sx={{
          background: routeColor,
          borderRadius: 3,
          p: 2.5,
          color: textColor,
        }}
      >
        <Box display="flex" alignItems="center" gap={1.5} mb={1}>
          <Box
            sx={{
              width: 40,
              height: 40,
              borderRadius: 2,
              background: "rgba(255,255,255,0.2)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 900,
              fontSize: 18,
            }}
          >
            {route.route_short_name || "?"}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="h6"
              fontWeight={800}
              lineHeight={1.2}
              fontSize="1.1rem"
            >
              {route.route_long_name || route.route_id}
            </Typography>
            {agency && (
              <Box display="flex" alignItems="center" gap={0.5}>
                <Typography variant="caption" sx={{ opacity: 0.8 }}>
                  {agency.agency_name}
                </Typography>
                {editing && (
                  <Tooltip title={t("edit.agency.editTooltip")} arrow>
                    <IconButton
                      size="small"
                      onClick={() => setEditAgencyOpen(true)}
                      aria-label={t("edit.agency.editTooltip")}
                      sx={{
                        color: textColor,
                        opacity: 0.7,
                        p: 0.25,
                        "&:hover": {
                          opacity: 1,
                          background: "rgba(255,255,255,0.18)",
                        },
                      }}
                    >
                      <EditIcon sx={{ fontSize: 12 }} />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            )}
          </Box>
          {editing && (
            <Box display="flex" flexDirection="column" gap={0.5}>
              <Tooltip
                title={t("edit.route.editTooltip")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setEditOpen(true)}
                  aria-label={t("edit.route.editTooltip")}
                  sx={{
                    color: textColor,
                    background: "rgba(255,255,255,0.2)",
                    "&:hover": { background: "rgba(255,255,255,0.32)" },
                  }}
                >
                  <EditIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip
                title={t("edit.route.duplicateTitle")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setDuplicateOpen(true)}
                  aria-label={t("edit.route.duplicateTitle")}
                  sx={{
                    color: textColor,
                    background: "rgba(255,255,255,0.2)",
                    "&:hover": { background: "rgba(255,255,255,0.32)" },
                  }}
                >
                  <ContentCopyIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip
                title={t("edit.route.deleteTooltip")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setDeleteConfirmOpen(true)}
                  aria-label={t("edit.route.deleteTooltip")}
                  sx={{
                    color: textColor,
                    background: "rgba(255,255,255,0.2)",
                    "&:hover": { background: "rgba(244,67,54,0.35)" },
                  }}
                >
                  <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip
                title={t("edit.trip.createTooltip")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setCreateTripOpen(true)}
                  aria-label={t("edit.trip.createTooltip")}
                  sx={{
                    color: textColor,
                    background: "rgba(76,175,80,0.25)",
                    "&:hover": { background: "rgba(76,175,80,0.45)" },
                  }}
                >
                  <AddIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
        <Box display="flex" gap={1} flexWrap="wrap">
          <Chip
            label={`${trip_count} trips`}
            size="small"
            sx={{
              background: "rgba(255,255,255,0.18)",
              color: "inherit",
              fontWeight: 700,
              fontSize: 11,
            }}
          />
          <Chip
            label={`${stops.length} stops`}
            size="small"
            sx={{
              background: "rgba(255,255,255,0.18)",
              color: "inherit",
              fontWeight: 700,
              fontSize: 11,
            }}
          />
          {route.route_type && (
            <Chip
              label={`Type ${route.route_type}`}
              size="small"
              sx={{
                background: "rgba(255,255,255,0.18)",
                color: "inherit",
                fontWeight: 700,
                fontSize: 11,
              }}
            />
          )}
        </Box>
      </Box>

      {/* Directions */}
      <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
        <Typography
          variant="subtitle2"
          fontWeight={700}
          color="text.secondary"
          sx={{ textTransform: "uppercase", letterSpacing: "0.05em", mb: 1 }}
        >
          <SwapVertIcon
            sx={{ fontSize: 16, verticalAlign: "middle", mr: 0.5 }}
          />
          Directions ({directions.length})
        </Typography>
        {directions.map((d) => (
          <Box
            key={d.direction_id ?? "null"}
            sx={{
              p: 1.5,
              mb: 1,
              borderRadius: 1.5,
              background: isDark
                ? "rgba(255,255,255,0.04)"
                : "rgba(0,0,0,0.02)",
            }}
          >
            <Box display="flex" alignItems="center" gap={1} mb={0.5}>
              <Chip
                label={`Dir ${d.direction_id ?? "?"}`}
                size="small"
                sx={{ fontWeight: 700, fontSize: 10 }}
              />
              <Typography variant="caption" color="text.secondary">
                {d.trip_count} trips
              </Typography>
              {editing && !d.has_shape && shape_ids.length > 0 && (() => {
                const dk = dirKeyFor(d);
                const isThisAuto =
                  autoGenState.dirKey === dk && autoGenState.mode === "auto";
                const anyBusy = autoGenState.dirKey !== null;
                return (
                  <Box display="flex" gap={0.4} sx={{ ml: "auto" }}>
                    <Tooltip title={t("edit.shape.autoGenTooltip")} arrow placement="top">
                      <span>
                        <Button
                          size="small"
                          variant="contained"
                          color="success"
                          startIcon={
                            isThisAuto ? (
                              <CircularProgress
                                size={10}
                                sx={{ color: "inherit" }}
                              />
                            ) : (
                              <GestureIcon sx={{ fontSize: 12 }} />
                            )
                          }
                          onClick={() => handleAutoGenForDirection(d)}
                          disabled={anyBusy || (d.stops_ordered?.length || 0) < 2}
                          sx={{
                            py: 0.1,
                            px: 0.8,
                            minHeight: 0,
                            fontSize: 9.5,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {isThisAuto
                            ? `${autoGenState.progress}/${autoGenState.total}`
                            : t("edit.shape.autoGenBtn")}
                        </Button>
                      </span>
                    </Tooltip>
                    <Tooltip title={t("edit.shape.drawDirectionTooltip")} arrow placement="top">
                      <span>
                        <Button
                          size="small"
                          variant="outlined"
                          color="success"
                          onClick={() => handleDrawShapeForDirection(d)}
                          disabled={anyBusy}
                          sx={{
                            py: 0.1,
                            px: 0.8,
                            minHeight: 0,
                            fontSize: 9.5,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                          }}
                        >
                          {t("edit.shape.drawShape")}
                        </Button>
                      </span>
                    </Tooltip>
                  </Box>
                );
              })()}
            </Box>
            <Typography variant="body2" fontWeight={500}>
              {d.headsigns.join(" / ") || "—"}
            </Typography>
          </Box>
        ))}
      </Box>

      {/* Empty state: no shapes at all on the route */}
      {editing && shape_ids.length === 0 && directions.length > 0 && (
        <Box
          sx={{
            borderRadius: 2,
            p: 2,
            border: `1px dashed ${alpha(theme.palette.success.main, isDark ? 0.5 : 0.6)}`,
            background: alpha(
              theme.palette.success.main,
              isDark ? 0.08 : 0.05,
            ),
          }}
        >
          <Box display="flex" alignItems="center" gap={1} mb={1}>
            <GestureIcon
              sx={{ fontSize: 18, color: theme.palette.success.main }}
            />
            <Typography
              variant="subtitle2"
              fontWeight={800}
              sx={{
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                color: theme.palette.success.main,
              }}
            >
              {t("edit.shape.noShapeTitle")}
            </Typography>
          </Box>
          <Typography
            variant="caption"
            color="text.secondary"
            display="block"
            mb={1.25}
          >
            {t("edit.shape.noShapeHint")}
          </Typography>
          <Box display="flex" flexDirection="column" gap={1}>
            {directions.map((d) => {
              const dk = dirKeyFor(d);
              const isThisAuto =
                autoGenState.dirKey === dk && autoGenState.mode === "auto";
              const anyBusy = autoGenState.dirKey !== null;
              const stopCount = d.stops_ordered?.length || 0;
              return (
                <Box
                  key={`dir-${d.direction_id ?? "null"}`}
                  sx={{
                    p: 1,
                    borderRadius: 1.5,
                    background: isDark
                      ? "rgba(0,0,0,0.25)"
                      : "rgba(255,255,255,0.7)",
                    border: `1px solid ${alpha(theme.palette.success.main, 0.2)}`,
                  }}
                >
                  <Box
                    display="flex"
                    alignItems="center"
                    gap={1}
                    mb={0.75}
                    flexWrap="wrap"
                  >
                    <Chip
                      label={`Dir ${d.direction_id ?? "?"}`}
                      size="small"
                      sx={{ fontWeight: 800, fontSize: 10, height: 18 }}
                    />
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontSize: 10 }}
                    >
                      {d.trip_count} trips · {stopCount} stops
                    </Typography>
                  </Box>
                  <Box display="flex" gap={0.75} flexWrap="wrap">
                    <Tooltip title={t("edit.shape.autoGenTooltip")} arrow>
                      <span style={{ flex: 1, minWidth: 140 }}>
                        <Button
                          fullWidth
                          size="small"
                          variant="contained"
                          color="success"
                          startIcon={
                            isThisAuto ? (
                              <CircularProgress
                                size={12}
                                sx={{ color: "inherit" }}
                              />
                            ) : (
                              <GestureIcon sx={{ fontSize: 14 }} />
                            )
                          }
                          onClick={() => handleAutoGenForDirection(d)}
                          disabled={anyBusy || stopCount < 2}
                          sx={{
                            py: 0.5,
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: "none",
                          }}
                        >
                          {isThisAuto
                            ? t("edit.shape.autoGenProgress", {
                                done: autoGenState.progress,
                                total: autoGenState.total,
                              })
                            : t("edit.shape.autoGenBtn")}
                        </Button>
                      </span>
                    </Tooltip>
                    <Tooltip title={t("edit.shape.straightLineTooltip")} arrow>
                      <span>
                        <Button
                          size="small"
                          variant="outlined"
                          color="success"
                          onClick={() => handleStraightLineForDirection(d)}
                          disabled={anyBusy || stopCount < 2}
                          sx={{
                            py: 0.5,
                            px: 1,
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: "none",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {t("edit.shape.straightLineBtn")}
                        </Button>
                      </span>
                    </Tooltip>
                    <Tooltip title={t("edit.shape.drawDirectionTooltip")} arrow>
                      <span>
                        <Button
                          size="small"
                          variant="text"
                          color="success"
                          onClick={() => handleDrawShapeForDirection(d)}
                          disabled={anyBusy}
                          sx={{
                            py: 0.5,
                            px: 1,
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: "none",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {t("edit.shape.manualDrawBtn")}
                        </Button>
                      </span>
                    </Tooltip>
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {/* Stops list */}
      <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
        <Typography
          variant="subtitle2"
          fontWeight={700}
          color="text.secondary"
          sx={{ textTransform: "uppercase", letterSpacing: "0.05em", mb: 1 }}
        >
          <PlaceIcon sx={{ fontSize: 16, verticalAlign: "middle", mr: 0.5 }} />
          Stops ({stops.length})
        </Typography>
        <List dense disablePadding sx={{ maxHeight: 350, overflow: "auto" }}>
          {stops.map((s) => (
            <ListItemButton
              key={s.stop_id}
              onClick={() => openPanel("stop", s.stop_id)}
              sx={{ borderRadius: 1.5, mb: 0.3, py: 0.4 }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}>
                <PlaceIcon sx={{ fontSize: 16, color: routeColor }} />
              </ListItemIcon>
              <ListItemText
                primary={s.stop_name}
                secondary={s.stop_id}
                primaryTypographyProps={{ fontSize: 13, fontWeight: 500 }}
                secondaryTypographyProps={{
                  fontSize: 10,
                  fontFamily: "monospace",
                }}
              />
            </ListItemButton>
          ))}
        </List>
      </Box>

      {/* Shapes list */}
      {shape_ids.length > 0 && (
        <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
          <Typography
            variant="subtitle2"
            fontWeight={700}
            color="text.secondary"
            sx={{ textTransform: "uppercase", letterSpacing: "0.05em", mb: 1 }}
          >
            <TimelineIcon
              sx={{ fontSize: 16, verticalAlign: "middle", mr: 0.5 }}
            />
            Shapes ({shape_ids.length})
          </Typography>
          <Box display="flex" gap={0.75} flexWrap="wrap">
            {(shapes_info.length > 0 ? shapes_info : shape_ids.map((sid) => ({ shape_id: sid, directions: [] }))).map((info, idx) => {
              const chipColor = shape_ids.length > 1
                ? SHAPE_PALETTE[idx % SHAPE_PALETTE.length]
                : "#1976d2";
              const dirLabel = info.directions.length > 0
                ? info.directions.map((d) => `Dir ${d}`).join(", ")
                : null;
              return (
                <Chip
                  key={info.shape_id}
                  icon={<TimelineIcon sx={{ fontSize: 13 }} />}
                  label={
                    <span>
                      {info.shape_id}
                      {dirLabel && (
                        <span style={{ opacity: 0.6, marginLeft: 4, fontSize: 9, fontFamily: "sans-serif" }}>
                          ({dirLabel})
                        </span>
                      )}
                    </span>
                  }
                  size="small"
                  onClick={() => openPanel("shape", info.shape_id, { routeId: route.route_id, agencyId: route.agency_id, directionId: info.directions[0] })}
                  sx={{
                    fontFamily: "monospace",
                    fontWeight: 600,
                    fontSize: 11,
                    cursor: "pointer",
                    borderLeft: `4px solid ${chipColor}`,
                    "& .MuiChip-icon": { color: chipColor },
                  }}
                />
              );
            })}
          </Box>
        </Box>
      )}

      <EditRouteDialog
        open={editOpen}
        route={route}
        onClose={() => setEditOpen(false)}
      />

      <EditRouteDialog
        open={duplicateOpen}
        route={route}
        mode="duplicate"
        onClose={() => setDuplicateOpen(false)}
        onCreated={(newRoute) => {
          setDuplicateOpen(false);
          if (newRoute?.route_id) openPanel("route", newRoute.route_id);
        }}
      />

      <EditAgencyDialog
        open={editAgencyOpen}
        agency={agency}
        onClose={() => setEditAgencyOpen(false)}
      />

      {/* Cascade preview + confirm dialog */}
      <CascadePreviewDialog
        open={deleteConfirmOpen}
        entity="route"
        entityId={route.route_id}
        entityLabel={route.route_short_name || route.route_id}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={handleDeleteRoute}
      />

      {/* Create trip dialog */}
      <EditTripDialog
        open={createTripOpen}
        mode="create"
        routeId={data?.route?.route_id}
        onClose={() => setCreateTripOpen(false)}
        onCreated={(newTrip) => {
          setCreateTripOpen(false);
          openPanel("trip", newTrip.trip_id);
        }}
      />
    </Box>
  );
}

export default RouteDetail;
