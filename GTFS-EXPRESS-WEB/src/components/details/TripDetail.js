import React, { useEffect, useState, useCallback } from "react";
import {
  Box,
  Typography,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  Tooltip,
  Button,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import PlaceIcon from "@mui/icons-material/Place";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import EditIcon from "@mui/icons-material/Edit";
import DeleteIcon from "@mui/icons-material/Delete";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import AddIcon from "@mui/icons-material/Add";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import TimelineIcon from "@mui/icons-material/Timeline";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useKeyboardShortcut } from "../../contexts/ShortcutsContext";
import EditTripDialog from "../edit/EditTripDialog";
import CascadePreviewDialog from "../edit/CascadePreviewDialog";
import EditFrequencyDialog from "../edit/EditFrequencyDialog";
import PanelSkeleton from "../common/PanelSkeleton";

const hasNonZeroSeconds = (times) =>
  times.some((t) => {
    if (!t) return false;
    const parts = t.split(":");
    return parts.length === 3 && parts[2] !== "00";
  });

/**
 * Format headway_secs into a human-readable string.
 * Examples:
 *   600   → "Every 10 min"
 *   90    → "Every 1 min 30 sec"
 *   3600  → "Every 1h"
 *   5400  → "Every 1h 30 min"
 *   45    → "Every 45s"
 */
const formatHeadway = (secs) => {
  const n = Number(secs);
  if (!n || n <= 0) return String(secs);
  if (n % 3600 === 0) return `Every ${n / 3600}h`;
  if (n >= 3600) {
    const h = Math.floor(n / 3600);
    const rem = n % 3600;
    if (rem % 60 === 0) return `Every ${h}h ${rem / 60} min`;
    return `Every ${h}h ${Math.floor(rem / 60)} min ${rem % 60} sec`;
  }
  if (n % 60 === 0) return `Every ${n / 60} min`;
  const mins = Math.floor(n / 60);
  const remSec = n % 60;
  if (mins > 0) return `Every ${mins} min ${remSec} sec`;
  return `Every ${n}s`;
};

const formatTime = (time, showSeconds) => {
  if (!time) return "";
  const parts = time.split(":");
  if (!showSeconds && parts.length === 3 && parts[2] === "00")
    return `${parts[0]}:${parts[1]}`;
  return time;
};

function TripDetail({ tripId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Frequencies state
  const [frequencies, setFrequencies] = useState([]);
  const [freqLoading, setFreqLoading] = useState(false);
  const [freqDialogOpen, setFreqDialogOpen] = useState(false);
  const [freqDialogMode, setFreqDialogMode] = useState("create");
  const [freqEditTarget, setFreqEditTarget] = useState(null);
  const [freqDeleteTarget, setFreqDeleteTarget] = useState(null);
  const [freqDeleting, setFreqDeleting] = useState(false);

  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel } = useDetailPanel();
  const { editing, dataVersion, recordEdit, showToast } = useEditMode();
  const { t } = useLanguage();

  useEffect(() => {
    setLoading(true);
  }, [tripId]);

  useEffect(() => {
    let cancelled = false;
    fetchWithSession(
      `${API_BASE_URL}/trip_detail/${encodeURIComponent(tripId)}`,
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
  }, [tripId, dataVersion]);

  // Fetch frequencies for this trip separately (no dedicated GET endpoint yet —
  // falls back to empty array if the backend returns 404/error).
  useEffect(() => {
    let cancelled = false;
    setFreqLoading(true);
    fetchWithSession(
      `${API_BASE_URL}/edit/frequencies/${encodeURIComponent(tripId)}`,
      { cache: "no-store" },
    )
      .then((r) => {
        if (!r.ok) return [];
        return r.json();
      })
      .then((rows) => {
        if (!cancelled) setFrequencies(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setFrequencies([]);
      })
      .finally(() => {
        if (!cancelled) setFreqLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tripId, dataVersion]);

  const handleDeleteFrequency = useCallback(async () => {
    if (!freqDeleteTarget) return;
    setFreqDeleting(true);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/frequencies/${encodeURIComponent(tripId)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ start_time: freqDeleteTarget.start_time }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        showToast(body.error || "Delete failed", "error");
        return;
      }
      recordEdit(t("frequency.deletedToast"), body.validation, {
        entity: "frequency",
        entityId: `${tripId}:${freqDeleteTarget.start_time}`,
      });
      setFreqDeleteTarget(null);
    } catch (err) {
      showToast(err.message || "Network error", "error");
    } finally {
      setFreqDeleting(false);
    }
  }, [tripId, freqDeleteTarget, recordEdit, showToast, t]);

  const handleDeleteTrip = useCallback(async () => {
    setDeleting(true);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/trips/${encodeURIComponent(tripId)}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) {
        showToast(body.error || "Delete failed", "error");
        return;
      }
      recordEdit(
        t("edit.trip.deletedToast", {
          id: tripId,
          stopTimes: body.cascade?.stop_times || 0,
        }),
        body.validation,
        { entity: "trip", entityId: tripId },
      );
      // Navigate to the route panel if we know the route
      if (data?.route?.route_id) {
        openPanel("route", data.route.route_id);
      }
    } catch (err) {
      showToast(err.message || "Network error", "error");
    } finally {
      setDeleting(false);
      setDeleteConfirm(false);
    }
  }, [tripId, data, recordEdit, showToast, openPanel, t]);

  useKeyboardShortcut({
    id: "duplicate-trip-panel",
    keys: ["mod+d"],
    description: "Duplicate current trip",
    category: "edit",
    when: () => editing && !!data?.trip,
    handler: (e) => {
      e.preventDefault();
      setDuplicateOpen(true);
    },
  });

  if (loading) return <PanelSkeleton />;
  if (!data || !data.trip)
    return (
      <Alert severity="error">
        trip_id "{tripId}" — {t("detail.notFound")}
      </Alert>
    );

  const { trip, route, stop_sequence } = data;
  const routeColor = route ? `#${route.route_color || "1976d2"}` : "#1976d2";
  const textColor = route ? `#${route.route_text_color || "FFFFFF"}` : "#fff";
  const cardBg = isDark ? "#1a1f2e" : "#ffffff";
  const first = stop_sequence[0];
  const last = stop_sequence[stop_sequence.length - 1];
  const showSeconds = hasNonZeroSeconds(
    stop_sequence.flatMap((st) =>
      [st.arrival_time, st.departure_time].filter(Boolean),
    ),
  );

  return (
    <Box display="flex" flexDirection="column" gap={2}>
      {/* Trip header */}
      <Box
        sx={{
          background: routeColor,
          borderRadius: 3,
          p: 2.5,
          color: textColor,
        }}
      >
        <Box display="flex" alignItems="center" gap={1.5} mb={1}>
          <DirectionsBusIcon sx={{ fontSize: 24 }} />
          <Box>
            <Typography
              variant="h6"
              fontWeight={800}
              lineHeight={1.2}
              fontSize="1.1rem"
            >
              {trip.trip_headsign || trip.trip_id}
            </Typography>
            {route && (
              <Typography
                variant="caption"
                sx={{
                  opacity: 0.85,
                  cursor: "pointer",
                  "&:hover": { opacity: 1 },
                }}
                onClick={() => openPanel("route", route.route_id)}
              >
                {route.route_short_name} — {route.route_long_name}
              </Typography>
            )}
          </Box>
          <Box sx={{ flex: 1 }} />
          {editing && (
            <Box display="flex" flexDirection="column" gap={0.5}>
              <Tooltip
                title={t("edit.trip.editTooltip")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setEditOpen(true)}
                  aria-label={t("edit.trip.editTooltip")}
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
                title={t("edit.trip.duplicateTooltip")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setDuplicateOpen(true)}
                  aria-label={t("edit.trip.duplicateTooltip")}
                  sx={{
                    color: textColor,
                    background: "rgba(255,255,255,0.2)",
                    "&:hover": { background: "rgba(255,255,255,0.32)" },
                  }}
                >
                  <ContentCopyIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
              <Tooltip
                title={t("edit.trip.deleteTooltip")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setDeleteConfirm(true)}
                  aria-label={t("edit.trip.deleteTooltip")}
                  sx={{
                    color: textColor,
                    background: "rgba(255,0,0,0.2)",
                    "&:hover": { background: "rgba(255,0,0,0.35)" },
                  }}
                >
                  <DeleteIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
        <Box display="flex" gap={1} flexWrap="wrap">
          <Chip
            label={trip.trip_id}
            size="small"
            sx={{
              background: "rgba(255,255,255,0.18)",
              color: "inherit",
              fontFamily: "monospace",
              fontWeight: 600,
              fontSize: 10,
            }}
          />
          {trip.direction_id !== undefined && (
            <Chip
              label={`Dir ${trip.direction_id}`}
              size="small"
              sx={{
                background: "rgba(255,255,255,0.18)",
                color: "inherit",
                fontWeight: 700,
                fontSize: 11,
              }}
            />
          )}
          <Chip
            label={`${stop_sequence.length} stops`}
            size="small"
            sx={{
              background: "rgba(255,255,255,0.18)",
              color: "inherit",
              fontWeight: 700,
              fontSize: 11,
            }}
          />
          {first && last && (
            <Chip
              label={`${formatTime(first.departure_time, showSeconds)} → ${formatTime(last.arrival_time, showSeconds)}`}
              size="small"
              sx={{
                background: "rgba(255,255,255,0.9)",
                color: routeColor,
                fontWeight: 800,
                fontSize: 11,
              }}
            />
          )}
          {trip.service_id && (
            <Chip
              icon={<CalendarMonthIcon sx={{ fontSize: 13 }} />}
              label={trip.service_id}
              size="small"
              onClick={() => openPanel("calendar", trip.service_id)}
              sx={{
                background: "rgba(255,255,255,0.18)",
                color: "inherit",
                fontWeight: 700,
                fontSize: 10,
                cursor: "pointer",
                "& .MuiChip-icon": { color: "inherit" },
                "&:hover": { background: "rgba(255,255,255,0.32)" },
              }}
            />
          )}
          {trip.shape_id && (
            <Chip
              icon={<TimelineIcon sx={{ fontSize: 13 }} />}
              label={trip.shape_id}
              size="small"
              onClick={() => openPanel("shape", trip.shape_id)}
              sx={{
                background: "rgba(255,255,255,0.18)",
                color: "inherit",
                fontWeight: 700,
                fontSize: 10,
                fontFamily: "monospace",
                cursor: "pointer",
                "& .MuiChip-icon": { color: "inherit" },
                "&:hover": { background: "rgba(255,255,255,0.32)" },
              }}
            />
          )}
        </Box>
      </Box>

      {/* ── Frequencies section ─────────────────────────────────────── */}
      {(editing || frequencies.length > 0) && (
        <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
          <Box display="flex" alignItems="center" justifyContent="space-between" mb={1.5}>
            <Typography
              variant="subtitle2"
              fontWeight={700}
              color="text.secondary"
              sx={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
            >
              <AccessTimeIcon sx={{ fontSize: 16, verticalAlign: "middle", mr: 0.5 }} />
              {t("frequency.sectionTitle")}
            </Typography>
            {editing && (
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => {
                  setFreqDialogMode("create");
                  setFreqEditTarget(null);
                  setFreqDialogOpen(true);
                }}
                variant="outlined"
                color="info"
                sx={{ fontSize: "0.72rem", py: 0.25 }}
              >
                {t("frequency.addBtn")}
              </Button>
            )}
          </Box>

          {freqLoading && (
            <Box display="flex" justifyContent="center" py={1}>
              <CircularProgress size={20} />
            </Box>
          )}

          {!freqLoading && frequencies.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ fontStyle: "italic", fontSize: "0.8rem" }}>
              {t("frequency.emptyState")}
            </Typography>
          )}

          {!freqLoading && frequencies.length > 0 && (
            <Box
              component="table"
              sx={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.78rem",
                "& th": {
                  textAlign: "left",
                  fontWeight: 700,
                  color: "text.secondary",
                  pb: 0.5,
                  fontSize: "0.7rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  whiteSpace: "nowrap",
                },
                "& td": {
                  py: 0.5,
                  pr: 1.5,
                  verticalAlign: "middle",
                  fontFamily: "monospace",
                },
                "& tr:not(:last-child) td": {
                  borderBottom: (theme) =>
                    `1px solid ${theme.palette.divider}`,
                },
              }}
            >
              <thead>
                <tr>
                  <th>{t("frequency.colStart")}</th>
                  <th>{t("frequency.colEnd")}</th>
                  <th>{t("frequency.colHeadway")}</th>
                  <th>{t("frequency.colExactTimes")}</th>
                  {editing && <th />}
                </tr>
              </thead>
              <tbody>
                {frequencies.map((freq) => (
                  <tr key={freq.start_time}>
                    <td>{freq.start_time}</td>
                    <td>{freq.end_time}</td>
                    <td>
                      <Typography
                        component="span"
                        variant="caption"
                        sx={{
                          fontFamily: "monospace",
                          fontWeight: 600,
                          color: isDark ? "#90caf9" : "#1565c0",
                        }}
                      >
                        {formatHeadway(freq.headway_secs)}
                      </Typography>
                    </td>
                    <td>
                      {freq.exact_times != null && String(freq.exact_times) !== "" ? (
                        <Chip
                          label={t(`frequency.exactTimes.${freq.exact_times}`)}
                          size="small"
                          color={String(freq.exact_times) === "1" ? "success" : "default"}
                          sx={{ height: 18, fontSize: "0.65rem", fontFamily: "sans-serif" }}
                        />
                      ) : (
                        <Typography component="span" variant="caption" color="text.disabled">
                          —
                        </Typography>
                      )}
                    </td>
                    {editing && (
                      <td>
                        <Box display="flex" gap={0.5}>
                          <Tooltip title={t("frequency.editBtn")} arrow>
                            <IconButton
                              size="small"
                              onClick={() => {
                                setFreqDialogMode("edit");
                                setFreqEditTarget(freq);
                                setFreqDialogOpen(true);
                              }}
                              aria-label={t("frequency.editBtn")}
                              sx={{ p: 0.25 }}
                            >
                              <EditIcon sx={{ fontSize: 14 }} />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title={t("frequency.deleteBtn")} arrow>
                            <IconButton
                              size="small"
                              onClick={() => setFreqDeleteTarget(freq)}
                              aria-label={t("frequency.deleteBtn")}
                              sx={{ p: 0.25, color: "error.main" }}
                            >
                              <DeleteIcon sx={{ fontSize: 14 }} />
                            </IconButton>
                          </Tooltip>
                        </Box>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Box>
          )}
        </Box>
      )}

      {/* ── Frequency edit/create dialog ─────────────────────────────── */}
      <EditFrequencyDialog
        open={freqDialogOpen}
        onClose={() => {
          setFreqDialogOpen(false);
          setFreqEditTarget(null);
        }}
        mode={freqDialogMode}
        tripId={tripId}
        initial={freqEditTarget}
      />

      {/* ── Frequency delete confirmation dialog ────────────────────── */}
      <Dialog
        open={!!freqDeleteTarget}
        onClose={() => !freqDeleting && setFreqDeleteTarget(null)}
        maxWidth="xs"
        fullWidth
        PaperProps={{ sx: { borderTop: (theme) => `3px solid ${theme.palette.error.main}`, borderRadius: 2 } }}
      >
        <DialogTitle sx={{ fontWeight: 700, fontSize: "1rem" }}>
          {t("frequency.deleteConfirmTitle")}
        </DialogTitle>
        <DialogContent>
          <DialogContentText sx={{ fontSize: "0.875rem" }}>
            {t("frequency.deleteConfirmBody", { tripId })}
          </DialogContentText>
          {freqDeleteTarget && (
            <Box mt={1.5} display="flex" gap={1} flexWrap="wrap">
              <Chip label={freqDeleteTarget.start_time} size="small" sx={{ fontFamily: "monospace" }} />
              <Chip label={`→ ${freqDeleteTarget.end_time}`} size="small" sx={{ fontFamily: "monospace" }} />
              <Chip label={formatHeadway(freqDeleteTarget.headway_secs)} size="small" color="info" />
            </Box>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button
            onClick={() => setFreqDeleteTarget(null)}
            disabled={freqDeleting}
            color="inherit"
          >
            {t("app.cancel")}
          </Button>
          <Button
            onClick={handleDeleteFrequency}
            variant="contained"
            color="error"
            disabled={freqDeleting}
            startIcon={freqDeleting ? <CircularProgress size={14} /> : null}
          >
            {t("app.delete")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Stop sequence timeline */}
      <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
        <Typography
          variant="subtitle2"
          fontWeight={700}
          color="text.secondary"
          sx={{ textTransform: "uppercase", letterSpacing: "0.05em", mb: 1.5 }}
        >
          <PlaceIcon sx={{ fontSize: 16, verticalAlign: "middle", mr: 0.5 }} />
          Stop sequence
        </Typography>
        <Box sx={{ maxHeight: 500, overflow: "auto" }}>
          {stop_sequence.map((st, i) => {
            const isFirst = i === 0;
            const isLast = i === stop_sequence.length - 1;
            return (
              <Box key={i} display="flex" gap={1.5}>
                {/* Timeline */}
                <Box
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    width: 20,
                    flexShrink: 0,
                  }}
                >
                  <Box
                    sx={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background:
                        isFirst || isLast
                          ? routeColor
                          : isDark
                            ? "#475569"
                            : "#94a3b8",
                      border: `2px solid ${isFirst || isLast ? routeColor : isDark ? "#334155" : "#cbd5e1"}`,
                      zIndex: 1,
                    }}
                  />
                  {!isLast && (
                    <Box
                      sx={{
                        width: 2,
                        flex: 1,
                        background: isDark ? "#334155" : "#e2e8f0",
                      }}
                    />
                  )}
                </Box>

                {/* Content */}
                <Box
                  onClick={() => openPanel("stop", st.stop_id)}
                  sx={{
                    flex: 1,
                    cursor: "pointer",
                    pb: 1.5,
                    "&:hover": {
                      background: isDark
                        ? "rgba(255,255,255,0.03)"
                        : "rgba(0,0,0,0.02)",
                    },
                    borderRadius: 1,
                    px: 0.5,
                  }}
                >
                  <Box display="flex" alignItems="center" gap={1}>
                    <Typography
                      variant="body2"
                      fontWeight={isFirst || isLast ? 700 : 500}
                      noWrap
                    >
                      {st.stop_name}
                    </Typography>
                  </Box>
                  <Box display="flex" alignItems="center" gap={1}>
                    <Typography
                      variant="caption"
                      fontFamily="monospace"
                      fontWeight={600}
                      color={isDark ? "#90caf9" : "#1565c0"}
                    >
                      {st.arrival_time !== st.departure_time
                        ? `${formatTime(st.arrival_time, showSeconds)} → ${formatTime(st.departure_time, showSeconds)}`
                        : formatTime(st.departure_time, showSeconds)}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      fontFamily="monospace"
                    >
                      #{st.stop_sequence}
                    </Typography>
                  </Box>
                </Box>
              </Box>
            );
          })}
        </Box>
      </Box>

      <EditTripDialog
        open={editOpen}
        trip={trip}
        onClose={() => setEditOpen(false)}
      />

      {/* Duplicate trip dialog */}
      <EditTripDialog
        open={duplicateOpen}
        trip={trip}
        mode="duplicate"
        routeId={route?.route_id}
        serviceId={trip.service_id}
        onClose={() => setDuplicateOpen(false)}
        onCreated={(created) => {
          if (created?.trip_id) openPanel("trip", created.trip_id);
        }}
      />

      {/* Cascade preview + confirm dialog */}
      <CascadePreviewDialog
        open={deleteConfirm}
        entity="trip"
        entityId={trip.trip_id}
        entityLabel={trip.trip_headsign || trip.trip_id}
        onCancel={() => setDeleteConfirm(false)}
        onConfirm={handleDeleteTrip}
      />
    </Box>
  );
}

export default TripDetail;
