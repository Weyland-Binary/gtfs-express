import React, { useEffect, useState } from "react";
import {
  Box,
  Typography,
  Chip,
  CircularProgress,
  Divider,
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
import RouteIcon from "@mui/icons-material/Route";
import AccessibleIcon from "@mui/icons-material/Accessible";
import ScheduleIcon from "@mui/icons-material/Schedule";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import EditIcon from "@mui/icons-material/Edit";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import AddIcon from "@mui/icons-material/Add";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import API_BASE_URL from "../../config";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useKeyboardShortcut } from "../../contexts/ShortcutsContext";
import EditStopDialog from "../edit/EditStopDialog";
import CascadePreviewDialog from "../edit/CascadePreviewDialog";
import EditTransferDialog from "../edit/EditTransferDialog";
import EditPathwayDialog from "../edit/EditPathwayDialog";

const hasNonZeroSeconds = (times) =>
  times.some((t) => {
    if (!t) return false;
    const parts = t.split(":");
    return parts.length === 3 && parts[2] !== "00";
  });

const formatTime = (time, showSeconds) => {
  if (!time) return "";
  const parts = time.split(":");
  if (!showSeconds && parts.length === 3 && parts[2] === "00")
    return `${parts[0]}:${parts[1]}`;
  return time;
};
import { fetchWithSession } from "../../utils/sessionManager";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import PanelSkeleton from "../common/PanelSkeleton";

const TRANSFER_TYPE_COLOR = {
  0: "default",
  1: "primary",
  2: "warning",
  3: "error",
  4: "success",
  5: "info",
};

function StopDetail({ stopId }) {
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

  // Transfers state
  const [transfers, setTransfers] = useState([]);
  const [transfersLoading, setTransfersLoading] = useState(false);
  const [transferDialogState, setTransferDialogState] = useState(null); // { mode, initial? }

  // Pathways state
  const [pathways, setPathways] = useState([]);
  const [pathwaysLoading, setPathwaysLoading] = useState(false);
  const [pathwayDialogState, setPathwayDialogState] = useState(null); // { mode, initial? }

  useEffect(() => {
    setLoading(true);
  }, [stopId]);

  useEffect(() => {
    let cancelled = false;
    fetchWithSession(
      `${API_BASE_URL}/stop_detail/${encodeURIComponent(stopId)}`,
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
  }, [stopId, dataVersion]);

  // Fetch transfers for this stop (visible in edit mode or when transfers exist)
  useEffect(() => {
    let cancelled = false;
    setTransfersLoading(true);
    fetchWithSession(
      `${API_BASE_URL}/edit/transfers?stop_id=${encodeURIComponent(stopId)}`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (!cancelled) setTransfers(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setTransfers([]);
      })
      .finally(() => {
        if (!cancelled) setTransfersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stopId, dataVersion]);

  // Fetch pathways involving this stop (visible in edit mode or when pathways exist)
  useEffect(() => {
    let cancelled = false;
    setPathwaysLoading(true);
    fetchWithSession(
      `${API_BASE_URL}/edit/pathways?stop_id=${encodeURIComponent(stopId)}`,
      { cache: "no-store" },
    )
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (!cancelled) setPathways(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        if (!cancelled) setPathways([]);
      })
      .finally(() => {
        if (!cancelled) setPathwaysLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [stopId, dataVersion]);

  useKeyboardShortcut({
    id: "duplicate-stop-panel",
    keys: ["mod+d"],
    description: "Duplicate current stop",
    category: "edit",
    when: () => editing && !!data?.stop,
    handler: (e) => {
      e.preventDefault();
      setDuplicateOpen(true);
    },
  });

  if (loading) return <PanelSkeleton />;
  if (!data || !data.stop)
    return (
      <Alert severity="error">
        stop_id "{stopId}" — {t("detail.notFound")}
      </Alert>
    );

  const { stop, routes, departures } = data;

  const handleDeleteStop = async () => {
    setDeleting(true);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/stops/${encodeURIComponent(stop.stop_id)}`,
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
        t("edit.stop.deletedToast", { name: stop.stop_name || stop.stop_id }),
        body.validation,
        { entity: "stop", entityId: stop.stop_id },
      );
      setDeleteConfirmOpen(false);
      closePanel();
    } catch (err) {
      showToast(err.message || "Network error", "error");
    } finally {
      setDeleting(false);
    }
  };

  const showSeconds = hasNonZeroSeconds(
    departures.map((d) => d.departure_time).filter(Boolean),
  );

  const cardBg = isDark ? "#1a1f2e" : "#ffffff";
  const sectionBg = isDark ? "#0f172a" : "#f8fafc";

  return (
    <Box display="flex" flexDirection="column" gap={2}>
      {/* Stop header */}
      <Box
        sx={{
          background: isDark ? "#1565c0" : "#1976d2",
          borderRadius: 3,
          p: 2.5,
          color: "#fff",
        }}
      >
        <Box
          display="flex"
          alignItems="center"
          gap={1}
          mb={1}
          sx={{ minHeight: 28 }}
        >
          <PlaceIcon sx={{ fontSize: 24 }} />
          <Typography
            variant="h6"
            fontWeight={800}
            lineHeight={1.2}
            fontSize="1.2rem"
            sx={{ flex: 1 }}
          >
            {stop.stop_name}
          </Typography>
          {editing && (
            <Box display="flex" flexDirection="column" gap={0.5}>
              <Tooltip
                title={t("edit.stop.editTooltip")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setEditOpen(true)}
                  data-testid="stop-detail-edit"
                  aria-label={t("edit.stop.editTooltip")}
                  sx={{
                    color: "#fff",
                    background: "rgba(255,255,255,0.18)",
                    "&:hover": { background: "rgba(255,255,255,0.3)" },
                  }}
                >
                  <EditIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip
                title={t("edit.stop.duplicateTitle")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setDuplicateOpen(true)}
                  aria-label={t("edit.stop.duplicateTitle")}
                  sx={{
                    color: "#fff",
                    background: "rgba(255,255,255,0.18)",
                    "&:hover": { background: "rgba(255,255,255,0.3)" },
                  }}
                >
                  <ContentCopyIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip
                title={t("edit.stop.deleteTooltip")}
                arrow
                placement="left"
              >
                <IconButton
                  size="small"
                  onClick={() => setDeleteConfirmOpen(true)}
                  aria-label={t("edit.stop.deleteTooltip")}
                  sx={{
                    color: "#fff",
                    background: "rgba(255,255,255,0.18)",
                    "&:hover": { background: "rgba(244,67,54,0.35)" },
                  }}
                >
                  <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
        <Box display="flex" gap={1} flexWrap="wrap">
          <Chip
            label={stop.stop_id}
            size="small"
            sx={{
              background: "rgba(255,255,255,0.18)",
              color: "#fff",
              fontFamily: "monospace",
              fontWeight: 600,
              fontSize: 11,
            }}
          />
          {stop.stop_code && (
            <Chip
              label={`Code: ${stop.stop_code}`}
              size="small"
              sx={{
                background: "rgba(255,255,255,0.9)",
                color: "#1565c0",
                fontWeight: 700,
                fontSize: 11,
              }}
            />
          )}
          {stop.wheelchair_boarding === "1" && (
            <Chip
              icon={
                <AccessibleIcon
                  sx={{ fontSize: 14, color: "#4ade80 !important" }}
                />
              }
              label="Accessible"
              size="small"
              sx={{
                background: "rgba(74,222,128,0.2)",
                color: "#4ade80",
                fontWeight: 700,
                fontSize: 11,
              }}
            />
          )}
        </Box>
        {stop.zone_id && (
          <Typography
            variant="caption"
            sx={{ opacity: 0.8, mt: 0.5, display: "block" }}
          >
            Zone: {stop.zone_id}
          </Typography>
        )}
      </Box>

      {/* Coordinates */}
      <Box
        sx={{
          background: sectionBg,
          borderRadius: 2,
          p: 1.5,
          display: "flex",
          justifyContent: "space-around",
        }}
      >
        <Box textAlign="center">
          <Typography variant="caption" color="text.secondary" fontWeight={600}>
            LATITUDE
          </Typography>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 0.25,
            }}
          >
            <Typography variant="body2" fontFamily="monospace">
              {parseFloat(stop.stop_lat).toFixed(6)}
            </Typography>
            <Tooltip title={t("stop.copyCoordinate")} arrow>
              <IconButton
                size="small"
                onClick={() => {
                  const value = parseFloat(stop.stop_lat).toFixed(6);
                  navigator.clipboard.writeText(value);
                  showToast(
                    t("stop.coordinateCopied", { value }),
                    "success",
                  );
                }}
                sx={{ p: 0.25, opacity: 0.6, "&:hover": { opacity: 1 } }}
                aria-label={t("stop.copyCoordinate")}
              >
                <ContentCopyIcon sx={{ fontSize: 13 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
        <Divider orientation="vertical" flexItem />
        <Box textAlign="center">
          <Typography variant="caption" color="text.secondary" fontWeight={600}>
            LONGITUDE
          </Typography>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 0.25,
            }}
          >
            <Typography variant="body2" fontFamily="monospace">
              {parseFloat(stop.stop_lon).toFixed(6)}
            </Typography>
            <Tooltip title={t("stop.copyCoordinate")} arrow>
              <IconButton
                size="small"
                onClick={() => {
                  const value = parseFloat(stop.stop_lon).toFixed(6);
                  navigator.clipboard.writeText(value);
                  showToast(
                    t("stop.coordinateCopied", { value }),
                    "success",
                  );
                }}
                sx={{ p: 0.25, opacity: 0.6, "&:hover": { opacity: 1 } }}
                aria-label={t("stop.copyCoordinate")}
              >
                <ContentCopyIcon sx={{ fontSize: 13 }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </Box>

      {/* Serving routes */}
      <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
        <Typography
          variant="subtitle2"
          fontWeight={700}
          color="text.secondary"
          sx={{ textTransform: "uppercase", letterSpacing: "0.05em", mb: 1 }}
        >
          <RouteIcon sx={{ fontSize: 16, verticalAlign: "middle", mr: 0.5 }} />
          Routes serving this stop ({routes.length})
        </Typography>
        <List dense disablePadding>
          {routes.map((r) => (
            <ListItemButton
              key={r.route_id}
              onClick={() => openPanel("route", r.route_id)}
              sx={{ borderRadius: 1.5, mb: 0.5, py: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: 36 }}>
                <Box
                  sx={{
                    width: 28,
                    height: 28,
                    borderRadius: 1.5,
                    background: `#${r.route_color || "1976d2"}`,
                    color: `#${r.route_text_color || "FFFFFF"}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 11,
                    fontWeight: 800,
                  }}
                >
                  {r.route_short_name || "?"}
                </Box>
              </ListItemIcon>
              <ListItemText
                primary={r.route_long_name || r.route_id}
                primaryTypographyProps={{ fontSize: 13, fontWeight: 500 }}
              />
            </ListItemButton>
          ))}
        </List>
      </Box>

      {/* Departures */}
      <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
        <Typography
          variant="subtitle2"
          fontWeight={700}
          color="text.secondary"
          sx={{ textTransform: "uppercase", letterSpacing: "0.05em", mb: 1 }}
        >
          <ScheduleIcon
            sx={{ fontSize: 16, verticalAlign: "middle", mr: 0.5 }}
          />
          Departures ({departures.length})
        </Typography>
        <Box sx={{ maxHeight: 280, overflow: "auto" }}>
          {departures.slice(0, 50).map((d, i) => (
            <Box
              key={i}
              onClick={() => openPanel("trip", d.trip_id)}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1.5,
                py: 0.6,
                px: 1,
                borderRadius: 1,
                cursor: "pointer",
                "&:hover": {
                  background: isDark
                    ? "rgba(255,255,255,0.04)"
                    : "rgba(0,0,0,0.03)",
                },
                borderBottom: `1px solid ${isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)"}`,
              }}
            >
              <DirectionsBusIcon
                sx={{ fontSize: 14, color: "text.secondary" }}
              />
              <Typography
                variant="body2"
                fontFamily="monospace"
                fontWeight={600}
              >
                {formatTime(d.departure_time, showSeconds)}
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                noWrap
                sx={{ flex: 1 }}
              >
                {d.trip_id}
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Transfers section */}
      {(editing || transfers.length > 0) && (
        <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
          <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
            <Typography
              variant="subtitle2"
              fontWeight={700}
              color="text.secondary"
              sx={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
            >
              <SwapHorizIcon sx={{ fontSize: 16, verticalAlign: "middle", mr: 0.5 }} />
              {t("transfers.sectionTitle")} ({transfers.length})
            </Typography>
            {editing && (
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setTransferDialogState({ mode: "create" })}
              >
                {transfers.length === 0 ? t("transfers.addFirstBtn") : t("transfers.addBtn")}
              </Button>
            )}
          </Box>

          {transfersLoading && (
            <Box display="flex" justifyContent="center" py={1}>
              <CircularProgress size={20} />
            </Box>
          )}

          {!transfersLoading && transfers.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12 }}>
              {t("transfers.emptyState")}
            </Typography>
          )}

          {!transfersLoading && transfers.length > 0 && (() => {
            const fromStop = transfers.filter((tr) => tr.from_stop_id === stopId);
            const toStop = transfers.filter((tr) => tr.to_stop_id === stopId);

            const renderRow = (tr) => (
              <Box
                key={tr.id}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1.5,
                  py: 0.6,
                  px: 1,
                  borderRadius: 1,
                  borderBottom: `1px solid ${isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)"}`,
                  "&:hover": {
                    background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
                  },
                }}
              >
                {/* Other stop (clickable) */}
                <Typography
                  variant="body2"
                  fontFamily="monospace"
                  fontSize={12}
                  onClick={() => {
                    const otherId = tr.from_stop_id === stopId ? tr.to_stop_id : tr.from_stop_id;
                    if (otherId) openPanel("stop", otherId);
                  }}
                  sx={{
                    flex: 1,
                    cursor: (tr.from_stop_id === stopId ? tr.to_stop_id : tr.from_stop_id) ? "pointer" : "default",
                    color: "primary.main",
                    "&:hover": { textDecoration: "underline" },
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {tr.from_stop_id === stopId
                    ? (tr.to_stop_id || tr.to_trip_id || "—")
                    : (tr.from_stop_id || tr.from_trip_id || "—")}
                </Typography>

                {/* Type badge */}
                <Chip
                  label={tr.transfer_type}
                  size="small"
                  color={TRANSFER_TYPE_COLOR[tr.transfer_type] || "default"}
                  sx={{ fontSize: 10, height: 18, minWidth: 24 }}
                />

                {/* min_transfer_time */}
                {tr.min_transfer_time != null && (
                  <Typography variant="caption" color="text.secondary" fontFamily="monospace">
                    {tr.min_transfer_time}s
                  </Typography>
                )}

                {/* Edit action */}
                {editing && (
                  <Tooltip title={t("transfers.dialogTitleEdit")}>
                    <IconButton
                      size="small"
                      onClick={() => setTransferDialogState({ mode: "edit", initial: tr })}
                      aria-label={t("transfers.dialogTitleEdit")}
                    >
                      <EditIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            );

            return (
              <>
                {fromStop.length > 0 && (
                  <Box mb={1}>
                    <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ display: "block", mb: 0.5 }}>
                      {t("transfers.fromHeading")}
                    </Typography>
                    {fromStop.map(renderRow)}
                  </Box>
                )}
                {toStop.length > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ display: "block", mb: 0.5 }}>
                      {t("transfers.toHeading")}
                    </Typography>
                    {toStop.map(renderRow)}
                  </Box>
                )}
              </>
            );
          })()}
        </Box>
      )}

      {/* Pathways section */}
      {(editing || pathways.length > 0) && (
        <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
          <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
            <Typography
              variant="subtitle2"
              fontWeight={700}
              color="text.secondary"
              sx={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
            >
              <AltRouteIcon sx={{ fontSize: 16, verticalAlign: "middle", mr: 0.5 }} />
              {t("pathways.sectionTitle")} ({pathways.length})
            </Typography>
            {editing && (
              <Button
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setPathwayDialogState({ mode: "create" })}
              >
                {pathways.length === 0 ? t("pathways.addBtn") : t("pathways.addBtn")}
              </Button>
            )}
          </Box>

          {pathwaysLoading && (
            <Box display="flex" justifyContent="center" py={1}>
              <CircularProgress size={20} />
            </Box>
          )}

          {!pathwaysLoading && pathways.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: 12 }}>
              {t("pathways.emptyState")}
            </Typography>
          )}

          {!pathwaysLoading && pathways.length > 0 && (() => {
            const fromStop = pathways.filter((pw) => pw.from_stop_id === stopId);
            const toStop = pathways.filter((pw) => pw.to_stop_id === stopId && pw.from_stop_id !== stopId);

            const renderPathwayRow = (pw) => (
              <Box
                key={pw.pathway_id}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1.5,
                  py: 0.6,
                  px: 1,
                  borderRadius: 1,
                  borderBottom: `1px solid ${isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)"}`,
                  "&:hover": {
                    background: isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.03)",
                  },
                }}
              >
                <Typography
                  variant="body2"
                  fontFamily="monospace"
                  fontSize={12}
                  onClick={() => {
                    const otherId = pw.from_stop_id === stopId ? pw.to_stop_id : pw.from_stop_id;
                    if (otherId) openPanel("stop", otherId);
                  }}
                  sx={{
                    flex: 1,
                    cursor: "pointer",
                    color: "primary.main",
                    "&:hover": { textDecoration: "underline" },
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {pw.from_stop_id === stopId ? pw.to_stop_id : pw.from_stop_id}
                </Typography>

                {/* Mode badge */}
                <Chip
                  label={`${pw.pathway_mode} ${t(`pathways.mode.${pw.pathway_mode}`)}`}
                  size="small"
                  sx={{ fontSize: 10, height: 18 }}
                />

                {/* Bidirectional indicator */}
                <Typography variant="caption" sx={{ opacity: 0.5 }} title={pw.is_bidirectional ? "Bidirectional" : "One-way"}>
                  {pw.is_bidirectional ? "↔" : "→"}
                </Typography>

                {editing && (
                  <Tooltip title={t("pathways.dialogTitleEdit")}>
                    <IconButton
                      size="small"
                      onClick={() => setPathwayDialogState({ mode: "edit", initial: pw })}
                      aria-label={t("pathways.dialogTitleEdit")}
                    >
                      <EditIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            );

            return (
              <>
                {fromStop.length > 0 && (
                  <Box mb={1}>
                    <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ display: "block", mb: 0.5 }}>
                      {t("pathways.fromHeading")}
                    </Typography>
                    {fromStop.map(renderPathwayRow)}
                  </Box>
                )}
                {toStop.length > 0 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" fontWeight={600} sx={{ display: "block", mb: 0.5 }}>
                      {t("pathways.toHeading")}
                    </Typography>
                    {toStop.map(renderPathwayRow)}
                  </Box>
                )}
              </>
            );
          })()}
        </Box>
      )}

      <EditStopDialog
        open={editOpen}
        stop={stop}
        onClose={() => setEditOpen(false)}
      />

      <EditStopDialog
        open={duplicateOpen}
        stop={stop}
        mode="duplicate"
        onClose={() => setDuplicateOpen(false)}
        onCreated={(newStop) => {
          setDuplicateOpen(false);
          if (newStop?.stop_id) openPanel("stop", newStop.stop_id);
        }}
      />

      {/* Cascade preview + confirm dialog */}
      <CascadePreviewDialog
        open={deleteConfirmOpen}
        entity="stop"
        entityId={stop.stop_id}
        entityLabel={stop.stop_name || stop.stop_id}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={handleDeleteStop}
      />

      {/* Transfer create / edit dialog */}
      {transferDialogState && (
        <EditTransferDialog
          open
          mode={transferDialogState.mode}
          initial={transferDialogState.initial}
          contextStopId={transferDialogState.mode === "create" ? stopId : undefined}
          onClose={() => setTransferDialogState(null)}
          onSaved={() => setTransferDialogState(null)}
        />
      )}

      {/* Pathway create / edit dialog */}
      {pathwayDialogState && (
        <EditPathwayDialog
          open
          mode={pathwayDialogState.mode}
          initial={pathwayDialogState.initial}
          contextStopId={pathwayDialogState.mode === "create" ? stopId : undefined}
          onClose={() => setPathwayDialogState(null)}
          onSaved={() => setPathwayDialogState(null)}
        />
      )}
    </Box>
  );
}

export default StopDetail;
