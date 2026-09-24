import React, { useEffect, useState } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Box,
  ToggleButton,
  ToggleButtonGroup,
  Alert,
  CircularProgress,
} from "@mui/material";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

const toGtfsDate = (iso) => (iso ? iso.replace(/-/g, "") : "");

const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const isoInOneYear = () => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * NewServiceDialog — create a calendar.txt row (service) without SQL.
 *
 * Props:
 *   open             — bool
 *   onClose          — callback
 *   initialServiceId — optional pre-filled service_id
 *   onCreated        — callback(service_id) after a successful create
 */
function NewServiceDialog({ open, onClose, initialServiceId = "", onCreated }) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();
  const [serviceId, setServiceId] = useState(initialServiceId);
  const [days, setDays] = useState(["monday", "tuesday", "wednesday", "thursday", "friday"]);
  const [startDate, setStartDate] = useState(isoToday());
  const [endDate, setEndDate] = useState(isoInOneYear());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setServiceId(initialServiceId || "");
      setDays(["monday", "tuesday", "wednesday", "thursday", "friday"]);
      setStartDate(isoToday());
      setEndDate(isoInOneYear());
      setError(null);
    }
  }, [open, initialServiceId]);

  const valid =
    serviceId.trim().length > 0 &&
    days.length > 0 &&
    Boolean(startDate) &&
    Boolean(endDate) &&
    startDate <= endDate;

  const submit = async () => {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    const payload = {
      service_id: serviceId.trim(),
      start_date: toGtfsDate(startDate),
      end_date: toGtfsDate(endDate),
    };
    for (const d of DAYS) payload[d] = days.includes(d) ? 1 : 0;
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/calendar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          Array.isArray(body.details)
            ? body.details.join("; ")
            : body.error || `HTTP ${res.status}`,
        );
        return;
      }
      recordEdit(
        t("edit.calendar.createdToast", { id: payload.service_id }),
        body.validation,
        { entity: "calendar", entityId: payload.service_id },
      );
      onCreated?.(payload.service_id);
      onClose();
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="xs"
      fullWidth
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          submit();
        }
      }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <CalendarMonthIcon color="primary" sx={{ fontSize: 22 }} />
        <Typography variant="h6" fontWeight={700}>
          {t("edit.calendar.createTitle")}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} pt={1}>
          <TextField
            autoFocus
            size="small"
            label={t("edit.trip.serviceId")}
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            required
            inputProps={{
              style: { fontFamily: "monospace" },
              "data-testid": "new-service-id",
            }}
            helperText={t("edit.calendar.createIdHelp")}
          />
          <Box>
            <Typography variant="caption" color="text.secondary">
              {t("edit.calendar.serviceDays")}
            </Typography>
            <ToggleButtonGroup
              value={days}
              onChange={(_, v) => setDays(v)}
              size="small"
              sx={{ mt: 0.5, flexWrap: "wrap" }}
              aria-label={t("edit.calendar.serviceDays")}
            >
              {DAYS.map((d) => (
                <ToggleButton key={d} value={d} sx={{ px: 1.25, textTransform: "none" }}>
                  {t(`edit.calendar.${d}Short`)}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Box>
          <Box display="flex" gap={2}>
            <TextField
              size="small"
              type="date"
              label={t("edit.calendar.startDate")}
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
              sx={{ flex: 1 }}
            />
            <TextField
              size="small"
              type="date"
              label={t("edit.calendar.endDate")}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
              error={Boolean(startDate && endDate && startDate > endDate)}
              sx={{ flex: 1 }}
            />
          </Box>
          {error && <Alert severity="error">{error}</Alert>}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>
          {t("app.cancel")}
        </Button>
        <Button
          onClick={submit}
          variant="contained"
          disabled={!valid || saving}
          data-testid="new-service-create"
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : null}
        >
          {t("edit.trip.createBtn")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default NewServiceDialog;
