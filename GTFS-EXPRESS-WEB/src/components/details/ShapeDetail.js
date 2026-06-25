import React, { useState, useEffect, useCallback } from "react";
import {
  Box,
  Typography,
  Chip,
  Button,
  Alert,
  Skeleton,
  IconButton,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  Divider,
  List,
  ListItemButton,
  ListItemText,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import TimelineIcon from "@mui/icons-material/Timeline";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import RouteIcon from "@mui/icons-material/Route";
import VerifiedIcon from "@mui/icons-material/Verified";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import ShapeForkDialog from "../edit/ShapeForkDialog";

const TRIP_DISPLAY_LIMIT = 10;

function ShapeDetail({ shapeId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationResults, setValidationResults] = useState(null);
  const [fetchError, setFetchError] = useState(null); // "not_found" | "not_edit_mode" | null

  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { editing, dataVersion, recordEdit, showToast } = useEditMode();
  const { t } = useLanguage();
  const { openPanel, closePanel } = useDetailPanel();

  // Trigger spinner on shapeId change; silent refetch on dataVersion bump
  useEffect(() => {
    setLoading(true);
    setValidationResults(null);
    setFetchError(null);
  }, [shapeId]);

  // Clear stale validation when data changes
  useEffect(() => {
    setValidationResults(null);
  }, [dataVersion]);

  useEffect(() => {
    let cancelled = false;
    // Use the read-mode endpoint (always available); fall back to edit
    // endpoint when in edit mode (richer data from the SQLite edit DB).
    const url = editing
      ? `${API_BASE_URL}/edit/shapes/${encodeURIComponent(shapeId)}`
      : `${API_BASE_URL}/shape_detail/${encodeURIComponent(shapeId)}`;
    fetchWithSession(url, { cache: "no-store" })
      .then((r) => {
        if (r.ok) return r.json();
        if (r.status === 404) {
          if (!cancelled) setFetchError("not_found");
        } else {
          if (!cancelled) setFetchError("not_edit_mode");
        }
        return null;
      })
      .then((d) => {
        if (cancelled) return;
        if (d) {
          setData(d);
          setFetchError(null);
        } else {
          setData(null);
        }
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setFetchError("not_found");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shapeId, dataVersion, editing]);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/shapes/${encodeURIComponent(shapeId)}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) {
        showToast(body.error || t("edit.shape.deleteError"), "error");
        setDeleteConfirmOpen(false);
        return;
      }
      recordEdit(t("edit.shape.deletedToast", { id: shapeId }), body.validation, {
        entity: "shape",
        entityId: shapeId,
      });
      setDeleteConfirmOpen(false);
      closePanel();
    } catch (err) {
      showToast(err.message || "Network error", "error");
    } finally {
      setDeleting(false);
    }
  }, [shapeId, recordEdit, showToast, closePanel, t]);

  const handleValidate = useCallback(async () => {
    setValidating(true);
    setValidationResults(null);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/shapes/${encodeURIComponent(shapeId)}/validate`,
      );
      const body = await res.json();
      if (!res.ok) {
        showToast(body.error || t("edit.shape.validateError"), "error");
        return;
      }
      setValidationResults(body);
    } catch (err) {
      showToast(err.message || "Network error", "error");
    } finally {
      setValidating(false);
    }
  }, [shapeId, showToast, t]);

  const handleEditOnMap = useCallback(() => {
    window.dispatchEvent(new CustomEvent("editShape", { detail: { shapeId } }));
  }, [shapeId]);

  // --- Loading skeleton ---
  if (loading) {
    return (
      <Box display="flex" flexDirection="column" gap={2}>
        <Skeleton variant="rounded" height={90} sx={{ borderRadius: 3 }} />
        <Skeleton variant="rounded" height={120} sx={{ borderRadius: 2 }} />
        <Skeleton variant="rounded" height={80} sx={{ borderRadius: 2 }} />
      </Box>
    );
  }

  // --- Fallback: data unavailable (not in edit mode, 404, or fetch error) ---
  if (!data) {
    const isNotFound = fetchError === "not_found";
    return (
      <Box display="flex" flexDirection="column" gap={2}>
        {/* Minimal header even without data */}
        <Box
          sx={{
            background: isDark
              ? "linear-gradient(135deg, #1b5e20 0%, #2e7d32 100%)"
              : "linear-gradient(135deg, #388e3c 0%, #43a047 100%)",
            borderRadius: 3,
            p: 2.5,
            color: "#fff",
          }}
        >
          <Box display="flex" alignItems="center" gap={1.5}>
            <TimelineIcon sx={{ fontSize: 24 }} />
            <Box>
              <Typography
                variant="h6"
                fontWeight={800}
                lineHeight={1.2}
                fontSize="1rem"
                sx={{ fontFamily: "monospace" }}
              >
                {shapeId}
              </Typography>
              <Typography variant="caption" sx={{ opacity: 0.85 }}>
                shape_id
              </Typography>
            </Box>
          </Box>
        </Box>
        {isNotFound ? (
          <Alert severity="error">
            {t("edit.shape.notFound", { id: shapeId })}
          </Alert>
        ) : (
          <Alert severity="info" icon={<EditIcon fontSize="small" />}>
            {t("edit.shape.editModeRequired")}
          </Alert>
        )}
      </Box>
    );
  }

  const { points, trips = [], point_count, total_distance_m } = data;
  const distanceKm =
    total_distance_m != null
      ? (total_distance_m / 1000).toFixed(2)
      : null;
  const displayedTrips = trips.slice(0, TRIP_DISPLAY_LIMIT);
  const hiddenTripCount = trips.length - displayedTrips.length;
  const cardBg = isDark ? "#1a1f2e" : "#ffffff";
  const sectionBg = isDark ? "#0f172a" : "#f8fafc";

  return (
    <Box display="flex" flexDirection="column" gap={2}>
      {/* Header */}
      <Box
        sx={{
          background: isDark
            ? "linear-gradient(135deg, #1b5e20 0%, #2e7d32 100%)"
            : "linear-gradient(135deg, #388e3c 0%, #43a047 100%)",
          borderRadius: 3,
          p: 2.5,
          color: "#fff",
        }}
      >
        <Box display="flex" alignItems="center" gap={1.5} mb={1}>
          <TimelineIcon sx={{ fontSize: 24 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="h6"
              fontWeight={800}
              lineHeight={1.2}
              fontSize="1.2rem"
              noWrap
              sx={{ fontFamily: "monospace" }}
            >
              {shapeId}
            </Typography>
            <Typography variant="caption" sx={{ opacity: 0.85 }}>
              shape_id
            </Typography>
          </Box>
          {editing && (
            <Box display="flex" flexDirection="column" gap={0.5}>
              <Tooltip
                title={t("edit.shape.editOnMapTooltip")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={handleEditOnMap}
                  aria-label={t("edit.shape.editOnMapTooltip")}
                  sx={{
                    color: "#fff",
                    background: "rgba(255,255,255,0.2)",
                    "&:hover": { background: "rgba(255,255,255,0.32)" },
                  }}
                >
                  <EditIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip
                title={t("edit.shape.deleteTooltip")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setDeleteConfirmOpen(true)}
                  aria-label={t("edit.shape.deleteTooltip")}
                  sx={{
                    color: "#fff",
                    background: "rgba(255,255,255,0.2)",
                    "&:hover": { background: "rgba(244,67,54,0.4)" },
                  }}
                >
                  <DeleteIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              {trips.length > 1 && (
                <Tooltip
                  title={t("edit.shape.forkTooltip")}
                  arrow
                  placement="left"
                >
                  <IconButton
                    size="small"
                    onClick={() => setForkOpen(true)}
                    aria-label={t("edit.shape.forkTooltip")}
                    sx={{
                      color: "#fff",
                      background: "rgba(255,193,7,0.3)",
                      "&:hover": { background: "rgba(255,193,7,0.5)" },
                    }}
                  >
                    <CallSplitIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          )}
        </Box>
        <Box display="flex" gap={1} flexWrap="wrap">
          <Chip
            label={`${point_count ?? (points?.length ?? 0)} ${t("edit.shape.points")}`}
            size="small"
            sx={{
              background: "rgba(255,255,255,0.18)",
              color: "inherit",
              fontWeight: 700,
              fontSize: 11,
            }}
          />
          {distanceKm !== null && (
            <Chip
              label={`${distanceKm} km`}
              size="small"
              sx={{
                background: "rgba(255,255,255,0.9)",
                color: "#2e7d32",
                fontWeight: 800,
                fontSize: 11,
              }}
            />
          )}
          {trips.length > 0 && (
            <Chip
              icon={<DirectionsBusIcon sx={{ fontSize: 13, color: "inherit !important" }} />}
              label={`${trips.length} ${t("edit.trip.shapeTrips")}`}
              size="small"
              sx={{
                background: "rgba(255,255,255,0.18)",
                color: "inherit",
                fontWeight: 700,
                fontSize: 11,
                "& .MuiChip-icon": { color: "inherit" },
              }}
            />
          )}
        </Box>
      </Box>

      {/* Parent route(s) — derived from linked trips */}
      {trips.length > 0 && (() => {
        const routeIds = [...new Set(trips.map((tr) => tr.route_id).filter(Boolean))];
        if (routeIds.length === 0) return null;
        return (
          <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
            <Typography
              variant="subtitle2"
              fontWeight={700}
              color="text.secondary"
              sx={{ textTransform: "uppercase", letterSpacing: "0.05em", mb: 1 }}
            >
              <RouteIcon sx={{ fontSize: 15, verticalAlign: "middle", mr: 0.5 }} />
              {routeIds.length === 1 ? t("detail.shape.parentRoute") : t("detail.shape.parentRoutes")}
            </Typography>
            <Box display="flex" gap={0.75} flexWrap="wrap">
              {routeIds.map((rid) => (
                <Chip
                  key={rid}
                  icon={<RouteIcon sx={{ fontSize: 13 }} />}
                  label={rid}
                  size="small"
                  onClick={() => openPanel("route", rid)}
                  sx={{
                    fontFamily: "monospace",
                    fontWeight: 600,
                    fontSize: 11,
                    cursor: "pointer",
                  }}
                />
              ))}
            </Box>
          </Box>
        );
      })()}

      {/* Orphan shape warning */}
      {trips.length === 0 && (
        <Alert severity="warning" sx={{ borderRadius: 2 }}>
          {t("edit.shape.noTrips")}
        </Alert>
      )}

      {/* Linked trips section */}
      {trips.length > 0 && (
        <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
          <Typography
            variant="subtitle2"
            fontWeight={700}
            color="text.secondary"
            sx={{
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              mb: 1.5,
            }}
          >
            <DirectionsBusIcon
              sx={{ fontSize: 15, verticalAlign: "middle", mr: 0.5 }}
            />
            {t("edit.shape.linkedTrips")} ({trips.length})
          </Typography>

          {/* Multi-trip warning banner */}
          {trips.length > 1 && (
            <Alert
              icon={<WarningAmberIcon fontSize="small" />}
              severity="warning"
              sx={{ mb: 1.5, py: 0.5 }}
            >
              <Typography variant="body2" fontWeight={600}>
                {t("edit.shape.sharedWarning", { count: trips.length })}
              </Typography>
            </Alert>
          )}

          <List dense disablePadding>
            {displayedTrips.map((trip) => (
              <ListItemButton
                key={trip.trip_id}
                onClick={() => openPanel("trip", trip.trip_id)}
                sx={{ borderRadius: 1.5, mb: 0.3, py: 0.5 }}
              >
                <ListItemText
                  primary={
                    <Box display="flex" alignItems="center" gap={1}>
                      <Typography
                        component="span"
                        variant="body2"
                        fontWeight={700}
                        sx={{ fontFamily: "monospace", fontSize: 12 }}
                      >
                        {trip.trip_id}
                      </Typography>
                      {trip.trip_headsign && (
                        <Typography
                          component="span"
                          variant="body2"
                          color="text.secondary"
                          noWrap
                        >
                          {trip.trip_headsign}
                        </Typography>
                      )}
                    </Box>
                  }
                  secondary={
                    trip.route_id ? (
                      <Typography
                        variant="caption"
                        fontFamily="monospace"
                        color="text.secondary"
                      >
                        route_id: {trip.route_id}
                        {trip.service_id ? ` · service_id: ${trip.service_id}` : ""}
                      </Typography>
                    ) : null
                  }
                />
              </ListItemButton>
            ))}
          </List>

          {hiddenTripCount > 0 && (
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontStyle: "italic", pl: 1 }}
            >
              {t("edit.shape.andMoreTrips", { n: hiddenTripCount })}
            </Typography>
          )}
        </Box>
      )}

      {/* Actions section — edit mode only */}
      {editing && (
        <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
          <Typography
            variant="subtitle2"
            fontWeight={700}
            color="text.secondary"
            sx={{
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              mb: 1.5,
            }}
          >
            {t("edit.shape.actionsTitle")}
          </Typography>
          <Box display="flex" flexDirection="column" gap={1}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<EditIcon />}
              onClick={handleEditOnMap}
              sx={{ justifyContent: "flex-start" }}
            >
              {t("edit.shape.editOnMap")}
            </Button>
            {trips.length > 1 && (
              <Button
                variant="outlined"
                size="small"
                color="warning"
                startIcon={<CallSplitIcon />}
                onClick={() => setForkOpen(true)}
                sx={{ justifyContent: "flex-start" }}
              >
                {t("edit.shape.fork")}
              </Button>
            )}
            <Button
              variant="outlined"
              size="small"
              color="error"
              startIcon={<DeleteIcon />}
              onClick={() => setDeleteConfirmOpen(true)}
              sx={{ justifyContent: "flex-start" }}
            >
              {t("edit.shape.delete")}
            </Button>
          </Box>
        </Box>
      )}

      {/* Validation section — edit mode only */}
      {editing && (
        <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
          <Box
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            mb={validationResults ? 1.5 : 0}
          >
            <Typography
              variant="subtitle2"
              fontWeight={700}
              color="text.secondary"
              sx={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
            >
              <VerifiedIcon
                sx={{ fontSize: 15, verticalAlign: "middle", mr: 0.5 }}
              />
              {t("edit.shape.validationTitle")}
            </Typography>
            <Button
              size="small"
              variant="outlined"
              onClick={handleValidate}
              disabled={validating}
              startIcon={
                validating ? (
                  <CircularProgress size={14} />
                ) : (
                  <VerifiedIcon />
                )
              }
            >
              {t("edit.shape.checkProximity")}
            </Button>
          </Box>

          {validationResults && (
            <>
              <Divider sx={{ mb: 1.5 }} />
              <Box display="flex" flexDirection="column" gap={0.75}>
                {Array.isArray(validationResults.results) &&
                validationResults.results.length > 0 ? (
                  validationResults.results.map((item, i) => {
                    const isOk = !item.warning;
                    return (
                      <Box
                        key={i}
                        display="flex"
                        alignItems="center"
                        gap={1}
                        sx={{
                          py: 0.5,
                          px: 1,
                          borderRadius: 1.5,
                          background: isOk
                            ? isDark
                              ? "rgba(76,175,80,0.08)"
                              : "#e8f5e9"
                            : isDark
                              ? "rgba(255,152,0,0.08)"
                              : "#fff8e1",
                        }}
                      >
                        {isOk ? (
                          <CheckCircleIcon
                            sx={{
                              fontSize: 16,
                              color: isDark ? "#66bb6a" : "#2e7d32",
                              flexShrink: 0,
                            }}
                          />
                        ) : (
                          <WarningAmberIcon
                            sx={{
                              fontSize: 16,
                              color: isDark ? "#ffa726" : "#e65100",
                              flexShrink: 0,
                            }}
                          />
                        )}
                        <Typography variant="body2" sx={{ flex: 1, fontSize: 12 }}>
                          {item.stop_name || item.stop_id}
                          {item.stop_id && item.stop_name ? (
                            <Typography
                              component="span"
                              variant="caption"
                              fontFamily="monospace"
                              color="text.secondary"
                              sx={{ ml: 0.5 }}
                            >
                              ({item.stop_id})
                            </Typography>
                          ) : null}
                        </Typography>
                        {!isOk && item.distance_m != null && (
                          <Chip
                            label={`${Math.round(item.distance_m)} m`}
                            size="small"
                            sx={{
                              fontSize: 10,
                              height: 18,
                              background: isDark
                                ? "rgba(255,152,0,0.2)"
                                : "#ffe0b2",
                              color: isDark ? "#ffa726" : "#e65100",
                              fontWeight: 700,
                            }}
                          />
                        )}
                      </Box>
                    );
                  })
                ) : (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ fontStyle: "italic" }}
                  >
                    {t("edit.shape.noValidationResults")}
                  </Typography>
                )}
              </Box>
            </>
          )}
        </Box>
      )}

      {/* Raw ID footer */}
      <Box sx={{ background: sectionBg, borderRadius: 2, p: 1.5 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontFamily: "monospace", fontSize: 11 }}
        >
          shape_id: {shapeId}
        </Typography>
      </Box>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteConfirmOpen}
        onClose={() => !deleting && setDeleteConfirmOpen(false)}
        maxWidth="xs"
      >
        <DialogTitle>{t("edit.shape.deleteTitle")}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mt: 1 }}>
            <Typography variant="body2" gutterBottom>
              {t("edit.shape.deleteConfirm", { id: shapeId })}
            </Typography>
            {trips.length > 0 && (
              <Typography variant="body2" fontWeight={600} sx={{ mt: 0.5 }}>
                {t("edit.shape.deleteLinkedTrips", { count: trips.length })}
              </Typography>
            )}
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setDeleteConfirmOpen(false)}
            disabled={deleting}
            color="inherit"
          >
            {t("app.cancel")}
          </Button>
          <Button
            onClick={handleDelete}
            variant="contained"
            color="error"
            disabled={deleting}
            startIcon={deleting ? <CircularProgress size={14} /> : null}
          >
            {t("app.delete")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Fork dialog */}
      <ShapeForkDialog
        open={forkOpen}
        shapeId={shapeId}
        trips={trips}
        onClose={() => setForkOpen(false)}
        onForked={() => setForkOpen(false)}
      />
    </Box>
  );
}

export default ShapeDetail;
