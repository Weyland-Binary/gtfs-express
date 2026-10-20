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
import ScheduleIcon from "@mui/icons-material/Schedule";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";

/**
 * ShiftTimesDialog — retime one or several trips by ±N minutes in a single
 * undo step (POST /edit/trips/shift).
 *
 * Props:
 *   open        — bool
 *   tripIds     — string[] (1..500)
 *   tripLabel   — display string for the header (optional)
 *   onClose     — callback
 *   onShifted   — callback(body) after a successful shift (optional)
 */
function ShiftTimesDialog({ open, tripIds, tripLabel, onClose, onShifted }) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();
  const [sign, setSign] = useState("+");
  const [minutes, setMinutes] = useState("5");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setSign("+");
      setMinutes("5");
      setError(null);
    }
  }, [open]);

  const parsedMinutes = Number.parseInt(minutes, 10);
  const valid =
    Number.isInteger(parsedMinutes) && parsedMinutes > 0 && parsedMinutes <= 1440;
  const count = Array.isArray(tripIds) ? tripIds.length : 0;

  const submit = async () => {
    if (!valid || saving || count === 0) return;
    setSaving(true);
    setError(null);
    const offsetSecs = (sign === "-" ? -1 : 1) * parsedMinutes * 60;
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/trips/shift`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trip_ids: tripIds, offset_secs: offsetSecs }),
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
        t("schedule.shift.toast", {
          count: body.shifted_trips ?? count,
          offset: `${sign}${parsedMinutes}`,
        }),
        body.validation,
        { entity: "trip", entityId: tripIds.join(",") },
      );
      if (onShifted) onShifted(body);
      onClose();
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <ScheduleIcon color="primary" sx={{ fontSize: 22 }} />
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h6" fontWeight={700} sx={{ lineHeight: 1.2 }}>
            {t("schedule.shift.title")}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {count === 1
              ? tripLabel || tripIds[0]
              : t("schedule.shift.tripCount", { count })}
          </Typography>
        </Box>
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t("schedule.shift.hint")}
        </Typography>
        <Box
          component="form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          sx={{ display: "flex", alignItems: "center", gap: 1.5 }}
        >
          <ToggleButtonGroup
            exclusive
            size="small"
            value={sign}
            onChange={(_, v) => v && setSign(v)}
            aria-label={t("schedule.shift.direction")}
          >
            <ToggleButton value="-" aria-label={t("schedule.shift.earlier")}>
              −
            </ToggleButton>
            <ToggleButton value="+" aria-label={t("schedule.shift.later")}>
              +
            </ToggleButton>
          </ToggleButtonGroup>
          <TextField
            autoFocus
            size="small"
            type="number"
            label={t("schedule.shift.minutes")}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            inputProps={{ min: 1, max: 1440, step: 1, "data-testid": "shift-minutes" }}
            error={minutes !== "" && !valid}
            sx={{ width: 140 }}
          />
          <Typography variant="body2" color="text.secondary">
            {sign === "-" ? t("schedule.shift.earlier") : t("schedule.shift.later")}
          </Typography>
        </Box>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} color="inherit" disabled={saving}>
          {t("app.cancel")}
        </Button>
        <Button
          onClick={submit}
          variant="contained"
          disabled={!valid || saving || count === 0}
          data-testid="shift-apply"
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : null}
        >
          {t("schedule.shift.apply")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ShiftTimesDialog;
