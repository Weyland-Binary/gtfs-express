import React, { useEffect, useState, useCallback } from "react";
import {
  Box,
  Typography,
  Chip,
  CircularProgress,
  IconButton,
  Tooltip,
  TextField,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  ToggleButton,
  ToggleButtonGroup,
  alpha,
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import CancelIcon from "@mui/icons-material/Cancel";
import SaveIcon from "@mui/icons-material/Save";
import UndoIcon from "@mui/icons-material/Undo";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import DeleteForeverIcon from "@mui/icons-material/DeleteForever";
import EventAvailableIcon from "@mui/icons-material/EventAvailable";
import EventBusyIcon from "@mui/icons-material/EventBusy";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import PanelSkeleton from "../common/PanelSkeleton";

const DAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

/** YYYYMMDD → YYYY-MM-DD */
const gtfsToISO = (d) =>
  d && d.length === 8
    ? `${d.substring(0, 4)}-${d.substring(4, 6)}-${d.substring(6, 8)}`
    : "";

/** YYYY-MM-DD → YYYYMMDD */
const isoToGTFS = (d) => (d ? d.replace(/-/g, "") : "");

/** YYYYMMDD → localized display string */
const formatGTFSDate = (d) => {
  if (!d || d.length !== 8) return "—";
  const date = new Date(
    parseInt(d.substring(0, 4)),
    parseInt(d.substring(4, 6)) - 1,
    parseInt(d.substring(6, 8)),
  );
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

function CalendarDetail({ serviceId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [calendarDates, setCalendarDates] = useState([]);
  const [addingException, setAddingException] = useState(false);
  const [savingException, setSavingException] = useState(false);
  const [deletingException, setDeletingException] = useState(null); // date being confirmed
  const [deletingInProgress, setDeletingInProgress] = useState(false);
  const [newException, setNewException] = useState({
    date: "",
    exception_type: "2",
  });
  // Delete-service flow : preview cascade impact, then confirm
  const [deleteServiceOpen, setDeleteServiceOpen] = useState(false);
  const [deleteServicePreview, setDeleteServicePreview] = useState(null);
  const [deleteServiceLoading, setDeleteServiceLoading] = useState(false);
  const [deleteServiceInFlight, setDeleteServiceInFlight] = useState(false);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { editing, dataVersion, recordEdit, showToast } = useEditMode();
  const { t } = useLanguage();
  const { closePanel } = useDetailPanel();

  // Fetch calendar entry by service_id
  // Show spinner only on initial load (serviceId change), silent refetch on dataVersion
  useEffect(() => {
    setLoading(true);
  }, [serviceId]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchWithSession(
        `${API_BASE_URL}/calendar_service/${encodeURIComponent(serviceId)}`,
        { cache: "no-store" },
      ).then((r) => (r.ok ? r.json() : null)),
      fetchWithSession(
        `${API_BASE_URL}/calendar_dates_service/${encodeURIComponent(serviceId)}`,
        { cache: "no-store" },
      ).then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([cal, cds]) => {
        if (cancelled) return;
        if (cal) {
          setData(cal);
          setForm(buildForm(cal));
        }
        setCalendarDates(
          (cds || []).sort((a, b) =>
            String(a.date).localeCompare(String(b.date)),
          ),
        );
      })
      .catch(console.error)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [serviceId, dataVersion]);

  const buildForm = (cal) => ({
    monday: String(cal.monday) === "1",
    tuesday: String(cal.tuesday) === "1",
    wednesday: String(cal.wednesday) === "1",
    thursday: String(cal.thursday) === "1",
    friday: String(cal.friday) === "1",
    saturday: String(cal.saturday) === "1",
    sunday: String(cal.sunday) === "1",
    start_date: gtfsToISO(cal.start_date),
    end_date: gtfsToISO(cal.end_date),
  });

  const isDirty = () => {
    if (!data || !form) return false;
    for (const day of DAY_KEYS) {
      if (form[day] !== (String(data[day]) === "1")) return true;
    }
    if (isoToGTFS(form.start_date) !== data.start_date) return true;
    if (isoToGTFS(form.end_date) !== data.end_date) return true;
    return false;
  };

  const handleReset = () => {
    if (data) setForm(buildForm(data));
  };

  const handleSave = async () => {
    if (!data || !form || saving) return;
    setSaving(true);
    try {
      const payload = {};
      for (const day of DAY_KEYS) {
        const newVal = form[day] ? "1" : "0";
        if (newVal !== String(data[day])) payload[day] = newVal;
      }
      const newStart = isoToGTFS(form.start_date);
      const newEnd = isoToGTFS(form.end_date);
      if (newStart && newStart !== data.start_date)
        payload.start_date = newStart;
      if (newEnd && newEnd !== data.end_date) payload.end_date = newEnd;

      // Validate date range: start must not be after end
      const effStart = newStart || data.start_date;
      const effEnd = newEnd || data.end_date;
      if (effStart && effEnd && effStart > effEnd) {
        showToast(
          t("edit.calendar.startAfterEnd") ||
            "start_date cannot be after end_date",
          "error",
        );
        return;
      }

      if (Object.keys(payload).length === 0) return;

      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/calendar/${encodeURIComponent(serviceId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        showToast(body.error || t("edit.calendar.error"), "error");
        return;
      }
      // Update local data from response
      if (body.calendar) {
        setData(body.calendar);
        setForm(buildForm(body.calendar));
      }
      recordEdit(t("edit.calendar.savedToast", { id: serviceId }), body.validation, {
        entity: "calendar",
        entityId: serviceId,
      });
    } catch (err) {
      showToast(err.message || "Network error", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleAddException = useCallback(async () => {
    if (!newException.date || savingException) return;
    const gtfsDate = isoToGTFS(newException.date);
    if (!gtfsDate || gtfsDate.length !== 8) return;
    setSavingException(true);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/calendar_dates`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            service_id: serviceId,
            date: gtfsDate,
            exception_type: newException.exception_type,
          }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        showToast(body.error || t("edit.calendarDates.error"), "error");
        return;
      }
      recordEdit(
        t("edit.calendarDates.addedToast", {
          date: formatGTFSDate(gtfsDate),
        }),
        body.validation,
        { entity: "calendar_date", entityId: `${serviceId}:${gtfsDate}` },
      );
      setNewException({ date: "", exception_type: "2" });
      setAddingException(false);
    } catch (err) {
      showToast(err.message || "Network error", "error");
    } finally {
      setSavingException(false);
    }
  }, [serviceId, newException, savingException, recordEdit, showToast, t]);

  const handleDeleteException = useCallback(
    async (date) => {
      setDeletingInProgress(true);
      try {
        const res = await fetchWithSession(
          `${API_BASE_URL}/edit/calendar_dates/${encodeURIComponent(serviceId)}/${encodeURIComponent(date)}`,
          { method: "DELETE" },
        );
        const body = await res.json();
        if (!res.ok) {
          showToast(body.error || t("edit.calendarDates.error"), "error");
          return;
        }
        recordEdit(
          t("edit.calendarDates.removedToast", {
            date: formatGTFSDate(date),
          }),
          body.validation,
          { entity: "calendar_date", entityId: `${serviceId}:${date}` },
        );
      } catch (err) {
        showToast(err.message || "Network error", "error");
      } finally {
        setDeletingInProgress(false);
        setDeletingException(null);
      }
    },
    [serviceId, recordEdit, showToast, t],
  );

  // ── Delete service (calendar entry) flow ──────────────────────────────────
  // Step 1: open → fetch preview (trips + calendar_dates that depend)
  // Step 2: if trips > 0 → block (user must reassign them first)
  // Step 3: if OK → DELETE /edit/calendar/:service_id (cascade calendar_dates)
  const openDeleteServiceDialog = useCallback(async () => {
    setDeleteServiceLoading(true);
    setDeleteServiceOpen(true);
    setDeleteServicePreview(null);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/preview/service/${encodeURIComponent(serviceId)}`,
      );
      const body = await res.json();
      if (!res.ok) {
        showToast(body.error || "Preview failed", "error");
        setDeleteServiceOpen(false);
        return;
      }
      setDeleteServicePreview(body);
    } catch (err) {
      showToast(err.message || "Network error", "error");
      setDeleteServiceOpen(false);
    } finally {
      setDeleteServiceLoading(false);
    }
  }, [serviceId, showToast]);

  const confirmDeleteService = useCallback(async () => {
    if (deleteServiceInFlight) return;
    setDeleteServiceInFlight(true);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/calendar/${encodeURIComponent(serviceId)}`,
        { method: "DELETE" },
      );
      const body = await res.json();
      if (!res.ok) {
        showToast(body.error || "Delete failed", "error");
        return;
      }
      recordEdit(
        t("edit.calendar.deletedToast", { id: serviceId }),
        body.validation,
        { entity: "calendar", entityId: serviceId },
      );
      setDeleteServiceOpen(false);
      // The service was just deleted: if we leave the panel open, the
      // next refetch (triggered by dataVersion bump in recordEdit)
      // would show "Calendar not found". We close the panel cleanly.
      closePanel();
    } catch (err) {
      showToast(err.message || "Network error", "error");
    } finally {
      setDeleteServiceInFlight(false);
    }
  }, [serviceId, deleteServiceInFlight, recordEdit, showToast, t, closePanel]);

  if (loading) {
    return <PanelSkeleton />;
  }
  if (!data) {
    return <Typography color="error">{t("edit.calendar.notFound")}</Typography>;
  }

  const dirty = isDirty();
  const activeDays = DAY_KEYS.filter((d) => form[d]);
  const cardBg = isDark ? "#1a1f2e" : "#ffffff";
  const sectionBg = isDark ? "#0f172a" : "#f8fafc";

  return (
    <Box display="flex" flexDirection="column" gap={2}>
      {/* Header */}
      <Box
        sx={{
          background: isDark
            ? "linear-gradient(135deg, #6a1b9a 0%, #4a148c 100%)"
            : "linear-gradient(135deg, #7b1fa2 0%, #6a1b9a 100%)",
          borderRadius: 3,
          p: 2.5,
          color: "#fff",
        }}
      >
        <Box display="flex" alignItems="center" gap={1.5} mb={1}>
          <CalendarMonthIcon sx={{ fontSize: 24 }} />
          <Box sx={{ flex: 1 }}>
            <Typography
              variant="h6"
              fontWeight={800}
              lineHeight={1.2}
              fontSize="1rem"
            >
              {serviceId}
            </Typography>
            <Typography variant="caption" sx={{ opacity: 0.85 }}>
              {t("edit.calendar.serviceCalendar")}
            </Typography>
          </Box>
          {editing && (
            <Tooltip title={t("edit.calendar.deleteServiceTooltip")} arrow>
              <IconButton
                size="small"
                onClick={openDeleteServiceDialog}
                aria-label={t("edit.calendar.deleteServiceTooltip")}
                sx={{
                  color: "#fff",
                  background: "rgba(244,67,54,0.55)",
                  "&:hover": { background: "rgba(244,67,54,0.85)" },
                }}
              >
                <DeleteForeverIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        <Box display="flex" gap={1} flexWrap="wrap">
          <Chip
            label={`${activeDays.length}/7 ${t("edit.calendar.daysActive")}`}
            size="small"
            sx={{
              background: "rgba(255,255,255,0.18)",
              color: "inherit",
              fontWeight: 700,
              fontSize: 11,
            }}
          />
          <Chip
            label={`${formatGTFSDate(data.start_date)} → ${formatGTFSDate(data.end_date)}`}
            size="small"
            sx={{
              background: "rgba(255,255,255,0.9)",
              color: "#4a148c",
              fontWeight: 800,
              fontSize: 11,
            }}
          />
        </Box>
      </Box>

      {/* Day toggles */}
      <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
        <Box display="flex" alignItems="center" mb={1.5}>
          <Typography
            variant="subtitle2"
            fontWeight={700}
            color="text.secondary"
            sx={{
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              flex: 1,
            }}
          >
            {t("edit.calendar.serviceDays")}
          </Typography>
          {editing && dirty && (
            <Box display="flex" gap={0.5}>
              <Tooltip title={t("edit.calendar.reset")} arrow>
                <IconButton
                  size="small"
                  onClick={handleReset}
                  aria-label={t("edit.calendar.reset")}
                  sx={{
                    color: isDark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.5)",
                    background: isDark
                      ? "rgba(255,255,255,0.08)"
                      : "rgba(0,0,0,0.06)",
                    "&:hover": {
                      background: isDark
                        ? "rgba(255,255,255,0.15)"
                        : "rgba(0,0,0,0.1)",
                    },
                  }}
                >
                  <UndoIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
              <Tooltip title={t("app.save")} arrow>
                <IconButton
                  size="small"
                  onClick={handleSave}
                  disabled={saving}
                  aria-label={t("app.save")}
                  sx={{
                    color: "#fff",
                    background: "rgba(76,175,80,0.7)",
                    "&:hover": { background: "rgba(76,175,80,0.9)" },
                  }}
                >
                  {saving ? (
                    <CircularProgress size={16} sx={{ color: "#fff" }} />
                  ) : (
                    <SaveIcon sx={{ fontSize: 16 }} />
                  )}
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            gap: 1,
          }}
        >
          {DAY_KEYS.map((day) => {
            const active = form[day];
            const isWeekend = day === "saturday" || day === "sunday";
            return (
              <Tooltip key={day} title={t(`edit.calendar.${day}`)} arrow>
                <Box
                  onClick={
                    editing
                      ? () => setForm((f) => ({ ...f, [day]: !f[day] }))
                      : undefined
                  }
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 0.5,
                    py: 1.25,
                    px: 0.5,
                    borderRadius: 2,
                    cursor: editing ? "pointer" : "default",
                    transition: "all 0.2s ease",
                    background: active
                      ? isDark
                        ? isWeekend
                          ? "rgba(255,152,0,0.15)"
                          : "rgba(25,118,210,0.15)"
                        : isWeekend
                          ? "#fff3e0"
                          : "#e3f2fd"
                      : isDark
                        ? "rgba(255,255,255,0.03)"
                        : "rgba(0,0,0,0.02)",
                    border: `2px solid ${
                      active
                        ? isDark
                          ? isWeekend
                            ? "#ff9800"
                            : "#42a5f5"
                          : isWeekend
                            ? "#ff9800"
                            : "#1976d2"
                        : "transparent"
                    }`,
                    "&:hover": editing
                      ? {
                          transform: "scale(1.05)",
                          background: active
                            ? isDark
                              ? isWeekend
                                ? "rgba(255,152,0,0.25)"
                                : "rgba(25,118,210,0.25)"
                              : isWeekend
                                ? "#ffe0b2"
                                : "#bbdefb"
                            : isDark
                              ? "rgba(255,255,255,0.06)"
                              : "rgba(0,0,0,0.04)",
                        }
                      : {},
                  }}
                >
                  {active ? (
                    <CheckCircleIcon
                      sx={{
                        fontSize: 22,
                        color: isWeekend
                          ? "#ff9800"
                          : isDark
                            ? "#42a5f5"
                            : "#1976d2",
                      }}
                    />
                  ) : (
                    <CancelIcon
                      sx={{
                        fontSize: 22,
                        color: isDark
                          ? "rgba(255,255,255,0.15)"
                          : "rgba(0,0,0,0.15)",
                      }}
                    />
                  )}
                  <Typography
                    variant="caption"
                    fontWeight={active ? 700 : 400}
                    sx={{
                      fontSize: 11,
                      color: active
                        ? isWeekend
                          ? "#ff9800"
                          : isDark
                            ? "#90caf9"
                            : "#1565c0"
                        : "text.disabled",
                    }}
                  >
                    {t(`edit.calendar.${day}Short`)}
                  </Typography>
                </Box>
              </Tooltip>
            );
          })}
        </Box>
      </Box>

      {/* Date range */}
      <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
        <Typography
          variant="subtitle2"
          fontWeight={700}
          color="text.secondary"
          sx={{ textTransform: "uppercase", letterSpacing: "0.05em", mb: 1.5 }}
        >
          {t("edit.calendar.validityPeriod")}
        </Typography>
        {editing ? (
          <Box display="flex" gap={2}>
            <TextField
              type="date"
              label={t("edit.calendar.startDate")}
              value={form.start_date}
              onChange={(e) =>
                setForm((f) => ({ ...f, start_date: e.target.value }))
              }
              size="small"
              fullWidth
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              type="date"
              label={t("edit.calendar.endDate")}
              value={form.end_date}
              onChange={(e) =>
                setForm((f) => ({ ...f, end_date: e.target.value }))
              }
              size="small"
              fullWidth
              InputLabelProps={{ shrink: true }}
            />
          </Box>
        ) : (
          <Box
            sx={{
              display: "flex",
              justifyContent: "space-around",
              background: sectionBg,
              borderRadius: 1.5,
              p: 1.5,
            }}
          >
            <Box textAlign="center">
              <Typography
                variant="caption"
                color="text.secondary"
                fontWeight={600}
              >
                {t("edit.calendar.startDate").toUpperCase()}
              </Typography>
              <Typography variant="body2" fontWeight={600}>
                {formatGTFSDate(data.start_date)}
              </Typography>
            </Box>
            <Typography
              variant="body1"
              color="text.secondary"
              sx={{ alignSelf: "center" }}
            >
              →
            </Typography>
            <Box textAlign="center">
              <Typography
                variant="caption"
                color="text.secondary"
                fontWeight={600}
              >
                {t("edit.calendar.endDate").toUpperCase()}
              </Typography>
              <Typography variant="body2" fontWeight={600}>
                {formatGTFSDate(data.end_date)}
              </Typography>
            </Box>
          </Box>
        )}
      </Box>

      {/* Calendar date exceptions */}
      <Box sx={{ background: cardBg, borderRadius: 2, p: 2 }}>
        <Box
          display="flex"
          alignItems="center"
          justifyContent="space-between"
          mb={1.5}
        >
          <Typography
            variant="subtitle2"
            fontWeight={700}
            color="text.secondary"
            sx={{
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            {t("edit.calendarDates.title")}
          </Typography>
          {editing && !addingException && (
            <Tooltip title={t("edit.calendarDates.addTooltip")} arrow>
              <IconButton
                size="small"
                onClick={() => setAddingException(true)}
                aria-label={t("edit.calendarDates.addTooltip")}
                sx={{ color: isDark ? "#90caf9" : "#1976d2" }}
              >
                <AddCircleOutlineIcon sx={{ fontSize: 20 }} />
              </IconButton>
            </Tooltip>
          )}
        </Box>

        {/* Add exception form */}
        {editing && addingException && (() => {
          const isAdded = newException.exception_type === "1";
          const accent = isAdded ? "#10b981" : "#ef4444";
          return (
            <Box
              sx={{
                mb: 1.5,
                p: 1.5,
                borderRadius: 2,
                background: isDark ? "rgba(255,255,255,0.02)" : "#f8fafc",
                border: `1px solid ${isDark ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.06)"}`,
                borderLeft: `3px solid ${accent}`,
                transition: "border-color 0.2s ease",
              }}
            >
              {/* Type toggle — visual pills */}
              <ToggleButtonGroup
                value={newException.exception_type}
                exclusive
                fullWidth
                onChange={(_, v) => {
                  if (v !== null) {
                    setNewException((p) => ({ ...p, exception_type: v }));
                  }
                }}
                size="small"
                sx={{
                  mb: 1.25,
                  gap: 0.75,
                  "& .MuiToggleButton-root": {
                    flex: 1,
                    border: `1px solid ${isDark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.10)"}`,
                    borderRadius: "8px !important",
                    textTransform: "none",
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    py: 0.75,
                    color: "text.secondary",
                    transition: "all 0.15s ease",
                    "&:hover": {
                      backgroundColor: isDark ? "rgba(255,255,255,0.04)" : "rgba(15,23,42,0.03)",
                    },
                  },
                  "& .MuiToggleButton-root.Mui-selected": {
                    backgroundColor: alpha("#10b981", isDark ? 0.18 : 0.12),
                    borderColor: "#10b981",
                    color: "#10b981",
                    "&:hover": {
                      backgroundColor: alpha("#10b981", isDark ? 0.24 : 0.16),
                    },
                  },
                  "& .MuiToggleButton-root.Mui-selected[value='2']": {
                    backgroundColor: alpha("#ef4444", isDark ? 0.18 : 0.12),
                    borderColor: "#ef4444",
                    color: "#ef4444",
                    "&:hover": {
                      backgroundColor: alpha("#ef4444", isDark ? 0.24 : 0.16),
                    },
                  },
                }}
              >
                <ToggleButton value="1">
                  <EventAvailableIcon sx={{ fontSize: 16, mr: 0.75 }} />
                  {t("edit.calendarDates.typeAdded")}
                </ToggleButton>
                <ToggleButton value="2">
                  <EventBusyIcon sx={{ fontSize: 16, mr: 0.75 }} />
                  {t("edit.calendarDates.typeRemoved")}
                </ToggleButton>
              </ToggleButtonGroup>

              {/* Date input */}
              <TextField
                type="date"
                value={newException.date}
                onChange={(e) =>
                  setNewException((p) => ({ ...p, date: e.target.value }))
                }
                size="small"
                fullWidth
                autoFocus
                InputLabelProps={{ shrink: true }}
                sx={{
                  mb: 1.25,
                  "& .MuiOutlinedInput-root": {
                    borderRadius: 1.5,
                    fontFamily: "'Roboto Mono', monospace",
                    fontSize: "0.85rem",
                    backgroundColor: isDark ? "rgba(0,0,0,0.18)" : "#ffffff",
                    "& fieldset": {
                      borderColor: isDark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.10)",
                    },
                    "&:hover fieldset": {
                      borderColor: isDark ? "rgba(255,255,255,0.20)" : "rgba(15,23,42,0.16)",
                    },
                    "&.Mui-focused fieldset": {
                      borderColor: accent,
                      borderWidth: 1,
                    },
                  },
                }}
              />

              {/* Actions */}
              <Box sx={{ display: "flex", gap: 0.75, justifyContent: "flex-end" }}>
                <Button
                  size="small"
                  onClick={() => {
                    setAddingException(false);
                    setNewException({ date: "", exception_type: "2" });
                  }}
                  disabled={savingException}
                  sx={{
                    textTransform: "none",
                    fontWeight: 500,
                    fontSize: "0.78rem",
                    color: "text.secondary",
                    px: 1.5,
                  }}
                >
                  {t("app.cancel")}
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleAddException}
                  disabled={!newException.date || savingException}
                  disableElevation
                  startIcon={
                    savingException ? (
                      <CircularProgress size={14} sx={{ color: "inherit" }} />
                    ) : (
                      <CheckCircleIcon sx={{ fontSize: 16 }} />
                    )
                  }
                  sx={{
                    textTransform: "none",
                    fontWeight: 600,
                    fontSize: "0.78rem",
                    borderRadius: 1.5,
                    px: 1.75,
                    backgroundColor: accent,
                    color: "#fff",
                    "&:hover": {
                      backgroundColor: accent,
                      filter: "brightness(0.92)",
                    },
                    "&.Mui-disabled": {
                      backgroundColor: isDark ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.08)",
                      color: isDark ? "rgba(255,255,255,0.3)" : "rgba(15,23,42,0.3)",
                    },
                  }}
                >
                  {t("app.save")}
                </Button>
              </Box>
            </Box>
          );
        })()}

        {/* Exceptions list */}
        {calendarDates.length === 0 && !addingException ? (
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ fontStyle: "italic", textAlign: "center", py: 1.5 }}
          >
            {t("edit.calendarDates.none")}
          </Typography>
        ) : (
          <Box display="flex" flexDirection="column" gap={0.75}>
            {calendarDates.map((cd) => {
              const isAdded = String(cd.exception_type) === "1";
              return (
                <Box
                  key={`${cd.service_id}-${cd.date}`}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    py: 0.75,
                    px: 1.25,
                    borderRadius: 1.5,
                    background: isAdded
                      ? isDark
                        ? "rgba(76,175,80,0.08)"
                        : "#e8f5e9"
                      : isDark
                        ? "rgba(244,67,54,0.08)"
                        : "#ffebee",
                    transition: "all 0.2s ease",
                  }}
                >
                  {isAdded ? (
                    <EventAvailableIcon
                      sx={{
                        fontSize: 18,
                        color: isDark ? "#66bb6a" : "#388e3c",
                      }}
                    />
                  ) : (
                    <EventBusyIcon
                      sx={{
                        fontSize: 18,
                        color: isDark ? "#ef5350" : "#c62828",
                      }}
                    />
                  )}
                  <Typography variant="body2" fontWeight={600} sx={{ flex: 1 }}>
                    {formatGTFSDate(String(cd.date))}
                  </Typography>
                  <Chip
                    label={
                      isAdded
                        ? t("edit.calendarDates.typeAdded")
                        : t("edit.calendarDates.typeRemoved")
                    }
                    size="small"
                    sx={{
                      fontWeight: 700,
                      fontSize: 10,
                      height: 20,
                      background: isAdded
                        ? isDark
                          ? "rgba(76,175,80,0.2)"
                          : "#c8e6c9"
                        : isDark
                          ? "rgba(244,67,54,0.2)"
                          : "#ffcdd2",
                      color: isAdded
                        ? isDark
                          ? "#66bb6a"
                          : "#2e7d32"
                        : isDark
                          ? "#ef5350"
                          : "#c62828",
                    }}
                  />
                  {editing && (
                    <Tooltip
                      title={t("edit.calendarDates.deleteTooltip")}
                      arrow
                    >
                      <IconButton
                        size="small"
                        onClick={() => setDeletingException(String(cd.date))}
                        aria-label={t("edit.calendarDates.deleteTooltip")}
                        sx={{
                          p: 0.3,
                          color: isDark
                            ? "rgba(255,255,255,0.4)"
                            : "rgba(0,0,0,0.3)",
                          "&:hover": {
                            color: "#f44336",
                            background: isDark
                              ? "rgba(244,67,54,0.15)"
                              : "rgba(244,67,54,0.1)",
                          },
                        }}
                      >
                        <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </Tooltip>
                  )}
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* Raw service_id info */}
      <Box sx={{ background: sectionBg, borderRadius: 2, p: 1.5 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontFamily: "monospace", fontSize: 11 }}
        >
          service_id: {serviceId}
        </Typography>
      </Box>

      {/* Confirm delete exception dialog */}
      <Dialog
        open={!!deletingException}
        onClose={() => setDeletingException(null)}
        maxWidth="xs"
      >
        <DialogTitle>{t("edit.calendarDates.confirmDeleteTitle")}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {t("edit.calendarDates.confirmDeleteMsg", {
              date: formatGTFSDate(deletingException || ""),
            })}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setDeletingException(null)}
            color="inherit"
            disabled={deletingInProgress}
          >
            {t("app.cancel")}
          </Button>
          <Button
            onClick={() => handleDeleteException(deletingException)}
            color="error"
            variant="contained"
            disabled={deletingInProgress}
          >
            {deletingInProgress ? t("app.saving") : t("app.delete")}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete service (cascade preview + confirm) */}
      <Dialog
        open={deleteServiceOpen}
        onClose={() => !deleteServiceInFlight && setDeleteServiceOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
          <DeleteForeverIcon sx={{ color: theme.palette.error.main }} />
          <Typography variant="h6" fontWeight={700} sx={{ flex: 1 }}>
            {t("edit.calendar.deleteServiceTitle", { id: serviceId })}
          </Typography>
        </DialogTitle>
        <DialogContent>
          {deleteServiceLoading || !deleteServicePreview ? (
            <Box display="flex" justifyContent="center" py={3}>
              <CircularProgress size={28} />
            </Box>
          ) : (
            <>
              <DialogContentText sx={{ mb: 2 }}>
                {t("edit.calendar.deleteServiceBody")}
              </DialogContentText>

              {Array.isArray(deleteServicePreview.trips) &&
              deleteServicePreview.trips.length > 0 ? (
                <Box
                  sx={{
                    p: 2,
                    borderRadius: 1.5,
                    background: alpha(theme.palette.error.main, 0.08),
                    border: `1px solid ${alpha(theme.palette.error.main, 0.3)}`,
                    mb: 2,
                  }}
                >
                  <Typography
                    variant="body2"
                    fontWeight={700}
                    color="error.main"
                    sx={{ mb: 1 }}
                  >
                    {t("edit.calendar.deleteServiceBlocked", {
                      count: deleteServicePreview.trips.length,
                    })}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t("edit.calendar.deleteServiceBlockedHint")}
                  </Typography>
                  <Box sx={{ mt: 1, maxHeight: 180, overflow: "auto" }}>
                    {deleteServicePreview.trips.slice(0, 50).map((trip) => (
                      <Box
                        key={trip.trip_id}
                        sx={{
                          fontFamily:
                            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
                          fontSize: 11,
                          py: 0.25,
                          color: "text.secondary",
                        }}
                      >
                        {trip.trip_id} · {trip.route_id}
                        {trip.trip_headsign ? ` · ${trip.trip_headsign}` : ""}
                      </Box>
                    ))}
                    {deleteServicePreview.trips.length > 50 && (
                      <Typography variant="caption" color="text.disabled">
                        {t("edit.calendar.deleteServiceMoreTrips", {
                          count: deleteServicePreview.trips.length - 50,
                        })}
                      </Typography>
                    )}
                  </Box>
                </Box>
              ) : (
                <Box
                  sx={{
                    p: 2,
                    borderRadius: 1.5,
                    background: alpha(theme.palette.warning.main, 0.08),
                    border: `1px solid ${alpha(theme.palette.warning.main, 0.3)}`,
                    mb: 2,
                  }}
                >
                  <Typography variant="body2" fontWeight={700}>
                    {t("edit.calendar.deleteServiceCascadeTitle")}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t("edit.calendar.deleteServiceCascadeBody", {
                      count: deleteServicePreview.calendar_dates_count || 0,
                    })}
                  </Typography>
                </Box>
              )}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => setDeleteServiceOpen(false)}
            color="inherit"
            disabled={deleteServiceInFlight}
          >
            {t("app.cancel")}
          </Button>
          <Button
            onClick={confirmDeleteService}
            color="error"
            variant="contained"
            disabled={
              deleteServiceInFlight ||
              deleteServiceLoading ||
              !deleteServicePreview ||
              (deleteServicePreview &&
                Array.isArray(deleteServicePreview.trips) &&
                deleteServicePreview.trips.length > 0)
            }
            startIcon={<DeleteForeverIcon />}
          >
            {deleteServiceInFlight ? t("app.saving") : t("app.delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default CalendarDetail;
