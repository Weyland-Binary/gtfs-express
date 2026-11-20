import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  Box,
  Typography,
  Chip,
  CircularProgress,
  IconButton,
  Tooltip,
  TextField,
  Dialog,
  DialogContent,
  DialogContentText,
  DialogActions,
  Button,
  ToggleButton,
  ToggleButtonGroup,
  Alert,
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
import { editErrorText, editRefusalOf } from "../../utils/editRefusal";
import { readJson } from "../../utils/apiRequest";
import DetailLoadError from "./DetailLoadError";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useUnsavedForm } from "../../contexts/DestructiveGuardContext";
import { useFollowingForm } from "../../utils/formState";
import { GTFS_DAY_MIN, GTFS_DAY_MAX, isGtfsDay } from "../../utils/calendarUtils";
import PanelSkeleton from "../common/PanelSkeleton";
import NewServiceDialog from "../edit/NewServiceDialog";
import DialogHeader from "../common/DialogHeader";
import { formatYmd } from "../../utils/formatDate";

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

/** A GTFS date in the interface's language; a dash for what is no date. */
const dateText = (d, language) => formatYmd(d, language) || "—";

/** A date of calendar_dates.txt: when, added or removed, and its delete act where one is given. */
function DateRow({ date, added, label, isDark, onDelete = null, deleteLabel = "" }) {
  return (
    <Box
      data-testid="calendar-date"
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 1,
        py: 0.75,
        px: 1.25,
        borderRadius: 1.5,
        background: added
          ? isDark
            ? "rgba(76,175,80,0.08)"
            : "#e8f5e9"
          : isDark
            ? "rgba(244,67,54,0.08)"
            : "#ffebee",
        transition: "all 0.2s ease",
      }}
    >
      {added ? (
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
        {date}
      </Typography>
      <Chip
        label={label}
        size="small"
        sx={{
          fontWeight: 700,
          fontSize: 10,
          height: 20,
          background: added
            ? isDark
              ? "rgba(76,175,80,0.2)"
              : "#c8e6c9"
            : isDark
              ? "rgba(244,67,54,0.2)"
              : "#ffcdd2",
          color: added
            ? isDark
              ? "#66bb6a"
              : "#2e7d32"
            : isDark
              ? "#ef5350"
              : "#c62828",
        }}
      />
      {onDelete && (
        <Tooltip title={deleteLabel} arrow>
          <IconButton
            size="small"
            onClick={onDelete}
            aria-label={deleteLabel}
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
}

function CalendarDetail({ serviceId }) {
  const [data, setData] = useState(null);
  const [createServiceOpen, setCreateServiceOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const { form, setForm, dirty, follow, restart } = useFollowingForm(null);
  // The service the form was read for: read again, it keeps what is being changed.
  const formServiceRef = useRef(null);
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
  const [deleteServiceOpen, setDeleteServiceOpen] = useState(false);
  const [deleteServicePreview, setDeleteServicePreview] = useState(null);
  const [deleteServiceLoading, setDeleteServiceLoading] = useState(false);
  const [deleteServiceInFlight, setDeleteServiceInFlight] = useState(false);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { editing, dataVersion, recordEdit, showToast } = useEditMode();
  const { t, language } = useLanguage();
  const { closePanel } = useDetailPanel();
  // Only a 404 means the service has no calendar row; any other failure is said with a retry.
  const [loadError, setLoadError] = useState(null);
  const [retryTick, setRetryTick] = useState(0);

  // The spinner only when the service changes; a refetch on dataVersion is silent.
  useEffect(() => {
    setLoading(true);
  }, [serviceId]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchWithSession(
        `${API_BASE_URL}/calendar_service/${encodeURIComponent(serviceId)}`,
        { cache: "no-store" },
      ).then((r) => (r.status === 404 ? null : readJson(r))),
      fetchWithSession(
        `${API_BASE_URL}/calendar_dates_service/${encodeURIComponent(serviceId)}`,
        { cache: "no-store" },
      ).then((r) => (r.status === 404 ? [] : readJson(r))),
    ])
      .then(([cal, cds]) => {
        if (cancelled) return;
        setLoadError(null);
        if (cal) {
          setData(cal);
          if (formServiceRef.current === serviceId) follow(buildForm(cal));
          else restart(buildForm(cal));
          formServiceRef.current = serviceId;
        } else {
          // No row of calendar.txt, or none any more: the one read before is not shown in its place.
          setData(null);
          restart(null);
          formServiceRef.current = null;
        }
        setCalendarDates(
          (cds || []).sort((a, b) =>
            String(a.date).localeCompare(String(b.date)),
          ),
        );
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [serviceId, dataVersion, retryTick, follow, restart]);

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

  useUnsavedForm("calendar", editing && (dirty || (addingException && Boolean(newException.date))));

  const handleReset = () => {
    if (data) restart(buildForm(data));
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
      // Both dates are the service's own and required: one emptied or of a year no service means is said, not skipped.
      if (!isGtfsDay(form.start_date) || !isGtfsDay(form.end_date)) {
        showToast(t("edit.calendar.invalidDate"), "error");
        return;
      }
      const newStart = isoToGTFS(form.start_date);
      const newEnd = isoToGTFS(form.end_date);
      if (newStart !== data.start_date) payload.start_date = newStart;
      if (newEnd !== data.end_date) payload.end_date = newEnd;

      if (newStart > newEnd) {
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
        showToast(editRefusalOf(res.status, body, t).text, "error");
        return;
      }
      if (body.calendar) {
        setData(body.calendar);
        restart(buildForm(body.calendar));
      }
      recordEdit(t("edit.calendar.savedToast", { id: serviceId }), body.validation, {
        entity: "calendar",
        entityId: serviceId,
        changed: body.changed,
      });
    } catch (err) {
      showToast(editErrorText(err, t), "error");
    } finally {
      setSaving(false);
    }
  };

  const handleAddException = useCallback(async () => {
    if (!newException.date || savingException) return;
    if (!isGtfsDay(newException.date)) {
      showToast(t("edit.calendar.invalidDate"), "error");
      return;
    }
    const gtfsDate = isoToGTFS(newException.date);
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
        showToast(editRefusalOf(res.status, body, t).text, "error");
        return;
      }
      recordEdit(
        t("edit.calendarDates.addedToast", {
          date: dateText(gtfsDate, language),
        }),
        body.validation,
        { entity: "calendar_date", entityId: `${serviceId}:${gtfsDate}` },
      );
      setNewException({ date: "", exception_type: "2" });
      setAddingException(false);
    } catch (err) {
      showToast(editErrorText(err, t), "error");
    } finally {
      setSavingException(false);
    }
  }, [serviceId, newException, savingException, recordEdit, showToast, t, language]);

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
          showToast(editRefusalOf(res.status, body, t).text, "error");
          return;
        }
        recordEdit(
          t("edit.calendarDates.removedToast", {
            date: dateText(date, language),
          }),
          body.validation,
          { entity: "calendar_date", entityId: `${serviceId}:${date}` },
        );
      } catch (err) {
        showToast(editErrorText(err, t), "error");
      } finally {
        setDeletingInProgress(false);
        setDeletingException(null);
      }
    },
    [serviceId, recordEdit, showToast, t, language],
  );

  // Deleting a service: its dependants previewed first; trips block it (reassigned first); the DELETE cascades to
  // its calendar_dates.
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
        showToast(editRefusalOf(res.status, body, t).text, "error");
        setDeleteServiceOpen(false);
        return;
      }
      setDeleteServicePreview(body);
    } catch (err) {
      showToast(editErrorText(err, t), "error");
      setDeleteServiceOpen(false);
    } finally {
      setDeleteServiceLoading(false);
    }
  }, [serviceId, showToast, t]);

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
        showToast(editRefusalOf(res.status, body, t).text, "error");
        return;
      }
      recordEdit(
        t("edit.calendar.deletedToast", { id: serviceId }),
        body.validation,
        { entity: "calendar", entityId: serviceId },
      );
      setDeleteServiceOpen(false);
      // Closed at once: the refetch after recordEdit would show "Calendar not found".
      closePanel();
    } catch (err) {
      showToast(editErrorText(err, t), "error");
    } finally {
      setDeleteServiceInFlight(false);
    }
  }, [serviceId, deleteServiceInFlight, recordEdit, showToast, t, closePanel]);

  if (loading) {
    return <PanelSkeleton />;
  }
  if (loadError) {
    return (
      <DetailLoadError
        error={loadError}
        onRetry={() => {
          setLoading(true);
          setRetryTick((n) => n + 1);
        }}
      />
    );
  }
  if (!data && calendarDates.length > 0) {
    // A service of calendar_dates.txt alone: its dates are its calendar.
    const first = String(calendarDates[0].date);
    const last = String(calendarDates[calendarDates.length - 1].date);
    return (
      <Box display="flex" flexDirection="column" gap={2} data-testid="calendar-dates-only">
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
              <Typography variant="h6" fontWeight={800} lineHeight={1.2} fontSize="1rem">
                {serviceId}
              </Typography>
              <Typography variant="caption" sx={{ opacity: 0.85 }}>
                {t("edit.calendar.serviceCalendar")}
              </Typography>
            </Box>
          </Box>
          <Chip
            label={first === last ? formatYmd(first, language) : `${formatYmd(first, language)} → ${formatYmd(last, language)}`}
            size="small"
            sx={{ background: "rgba(255,255,255,0.9)", color: "#4a148c", fontWeight: 800, fontSize: 11 }}
          />
        </Box>
        <Alert severity="info">{t("edit.calendar.datesOnly")}</Alert>
        <Box sx={{ background: isDark ? "#1a1f2e" : "#ffffff", borderRadius: 2, p: 2 }}>
          <Typography
            variant="subtitle2"
            fontWeight={700}
            color="text.secondary"
            data-testid="calendar-dates-title"
            sx={{ textTransform: "uppercase", letterSpacing: "0.05em", mb: 1.5 }}
          >
            {t("edit.calendarDates.datesTitle", { count: calendarDates.length })}
          </Typography>
          <Box display="flex" flexDirection="column" gap={0.75} sx={{ maxHeight: 420, overflow: "auto" }}>
            {calendarDates.map((cd) => (
              <DateRow
                key={cd.date}
                date={formatYmd(cd.date, language, "weekday")}
                added={String(cd.exception_type) === "1"}
                label={String(cd.exception_type) === "1" ? t("edit.calendarDates.typeAdded") : t("edit.calendarDates.typeRemoved")}
                isDark={isDark}
              />
            ))}
          </Box>
        </Box>
      </Box>
    );
  }
  if (!data) {
    // No calendar.txt row and no date either (a typo in a trip's service_id): offer to create it here rather than end
    // on "Calendar not found".
    return (
      <Box display="flex" flexDirection="column" gap={1.5}>
        <Alert severity="warning">
          <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
            {t("edit.calendar.notFound")}
          </Typography>
          <Typography variant="body2">{t("edit.calendar.notFoundHint")}</Typography>
        </Alert>
        {editing && (
          <Button
            variant="contained"
            size="small"
            onClick={() => setCreateServiceOpen(true)}
            data-testid="calendar-create-service"
            sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 600 }}
          >
            {t("edit.calendar.createThisService")}
          </Button>
        )}
        <NewServiceDialog
          open={createServiceOpen}
          initialServiceId={serviceId}
          onClose={() => setCreateServiceOpen(false)}
        />
      </Box>
    );
  }

  const activeDays = DAY_KEYS.filter((d) => form[d]);
  const cardBg = isDark ? "#1a1f2e" : "#ffffff";
  const sectionBg = isDark ? "#0f172a" : "#f8fafc";

  return (
    <Box display="flex" flexDirection="column" gap={2}>
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
            label={`${dateText(data.start_date, language)} → ${dateText(data.end_date, language)}`}
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
                  // A button while it can be toggled: reached with Tab, toggled with Enter or Space, its state said.
                  {...(editing
                    ? {
                        component: "button",
                        type: "button",
                        "aria-pressed": active,
                        onClick: () => setForm((f) => ({ ...f, [day]: !f[day] })),
                      }
                    : {})}
                  sx={{
                    font: "inherit",
                    color: "inherit",
                    appearance: "none",
                    "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
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
              error={!isGtfsDay(form.start_date)}
              inputProps={{ min: GTFS_DAY_MIN, max: GTFS_DAY_MAX }}
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
              error={!isGtfsDay(form.end_date)}
              inputProps={{ min: GTFS_DAY_MIN, max: GTFS_DAY_MAX }}
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
                {dateText(data.start_date, language)}
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
                {dateText(data.end_date, language)}
              </Typography>
            </Box>
          </Box>
        )}
      </Box>

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

              <TextField
                type="date"
                value={newException.date}
                onChange={(e) =>
                  setNewException((p) => ({ ...p, date: e.target.value }))
                }
                size="small"
                fullWidth
                autoFocus
                inputProps={{ min: GTFS_DAY_MIN, max: GTFS_DAY_MAX, "data-testid": "calendar-exception-date" }}
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
            {calendarDates.map((cd) => (
              <DateRow
                key={`${cd.service_id}-${cd.date}`}
                date={dateText(String(cd.date), language)}
                added={String(cd.exception_type) === "1"}
                label={String(cd.exception_type) === "1" ? t("edit.calendarDates.typeAdded") : t("edit.calendarDates.typeRemoved")}
                isDark={isDark}
                onDelete={editing ? () => setDeletingException(String(cd.date)) : null}
                deleteLabel={t("edit.calendarDates.deleteTooltip")}
              />
            ))}
          </Box>
        )}
      </Box>

      <Box sx={{ background: sectionBg, borderRadius: 2, p: 1.5 }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ fontFamily: "monospace", fontSize: 11 }}
        >
          service_id: {serviceId}
        </Typography>
      </Box>

      <Dialog
        open={!!deletingException}
        onClose={() => setDeletingException(null)}
        maxWidth="xs"
      >
        <DialogHeader
          tone="error"
          title={t("edit.calendarDates.confirmDeleteTitle")}
          onClose={() => setDeletingException(null)}
          closeDisabled={deletingInProgress}
        />
        <DialogContent>
          <DialogContentText>
            {t("edit.calendarDates.confirmDeleteMsg", {
              date: dateText(deletingException || "", language),
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

      <Dialog
        open={deleteServiceOpen}
        onClose={() => !deleteServiceInFlight && setDeleteServiceOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogHeader
          icon={<DeleteForeverIcon />}
          tone="error"
          title={t("edit.calendar.deleteServiceTitle", { id: serviceId })}
          onClose={() => setDeleteServiceOpen(false)}
          closeDisabled={deleteServiceInFlight}
        />
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
