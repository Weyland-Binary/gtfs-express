import React, { useState, useEffect, useMemo } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  MenuItem,
  Box,
  Alert,
  CircularProgress,
  Typography,
  Chip,
  InputAdornment,
} from "@mui/material";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";

// ── helpers ────────────────────────────────────────────────────────────────

const TIME_RE = /^\d{1,2}:\d{2}:\d{2}$/;

/**
 * Compare two HH:MM:SS strings (may exceed 24:xx:xx).
 * Returns true if a < b.
 */
const timeLt = (a, b) => {
  const parse = (s) => {
    const [h, m, sec] = s.split(":").map(Number);
    return h * 3600 + m * 60 + sec;
  };
  return parse(a) < parse(b);
};

const UNIT_OPTIONS = [
  { value: "sec", multiplier: 1 },
  { value: "min", multiplier: 60 },
  { value: "hour", multiplier: 3600 },
];

const EXACT_TIMES_OPTIONS = [
  { value: "", labelKey: "frequency.exactTimes.empty" },
  { value: "0", labelKey: "frequency.exactTimes.0" },
  { value: "1", labelKey: "frequency.exactTimes.1" },
];

/** Derive unit and display value from headway_secs */
const secsToUnitValue = (secs) => {
  const n = Number(secs);
  if (!n || n <= 0) return { unit: "sec", display: "" };
  if (n % 3600 === 0) return { unit: "hour", display: String(n / 3600) };
  if (n % 60 === 0) return { unit: "min", display: String(n / 60) };
  return { unit: "sec", display: String(n) };
};

const buildInitialForm = (mode, initial) => {
  if (mode === "edit" && initial) {
    const { unit, display } = secsToUnitValue(initial.headway_secs);
    return {
      start_time: initial.start_time || "",
      end_time: initial.end_time || "",
      headway_display: display,
      headway_unit: unit,
      exact_times:
        initial.exact_times != null ? String(initial.exact_times) : "",
    };
  }
  return {
    start_time: "",
    end_time: "",
    headway_display: "",
    headway_unit: "min",
    exact_times: "",
  };
};

// ── component ──────────────────────────────────────────────────────────────

/**
 * EditFrequencyDialog — create or edit a single frequencies.txt row.
 *
 * Props:
 *   open       {boolean}
 *   onClose    {function}
 *   mode       {"create" | "edit"}
 *   tripId     {string}   — read-only, displayed as a copiable Chip
 *   initial    {object}   — required when mode="edit": { start_time, end_time, headway_secs, exact_times }
 */
function EditFrequencyDialog({ open, onClose, mode = "create", tripId, initial }) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();

  const initialForm = useMemo(
    () => buildInitialForm(mode, initial),
    [mode, initial?.start_time],
  );

  const [form, setForm] = useState(initialForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Hooks before early returns (rules-of-hooks)
  useEffect(() => {
    if (open) {
      setForm(initialForm);
      setError(null);
    }
  }, [open, initialForm]);

  // Derived: headway_secs computed from display + unit
  const headwaySecs = useMemo(() => {
    const val = parseInt(form.headway_display, 10);
    if (!form.headway_display || isNaN(val) || val <= 0) return null;
    const mult = UNIT_OPTIONS.find((u) => u.value === form.headway_unit)?.multiplier ?? 1;
    return val * mult;
  }, [form.headway_display, form.headway_unit]);

  const handleChange = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  // ── validation ────────────────────────────────────────────────────────────

  const validate = () => {
    if (!TIME_RE.test(form.start_time)) {
      return t("frequency.errorStartTime");
    }
    if (!TIME_RE.test(form.end_time)) {
      return t("frequency.errorEndTime");
    }
    if (!timeLt(form.start_time, form.end_time)) {
      return t("frequency.errorTimeRange");
    }
    if (!headwaySecs || headwaySecs <= 0) {
      return t("frequency.errorHeadway");
    }
    return null;
  };

  // ── save ─────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(null);

    const payload = {
      trip_id: tripId,
      start_time: form.start_time,
      end_time: form.end_time,
      headway_secs: headwaySecs,
      ...(form.exact_times !== "" && { exact_times: Number(form.exact_times) }),
    };

    try {
      let res;
      if (mode === "create") {
        res = await fetchWithSession(`${API_BASE_URL}/edit/frequencies`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        res = await fetchWithSession(
          `${API_BASE_URL}/edit/frequencies/${encodeURIComponent(tripId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              start_time: initial.start_time,
              patch: {
                end_time: form.end_time,
                headway_secs: headwaySecs,
                ...(form.exact_times !== "" && {
                  exact_times: Number(form.exact_times),
                }),
              },
            }),
          },
        );
      }

      const body = await res.json();
      if (!res.ok) {
        const msg = body.details
          ? body.details.join("; ")
          : body.error || t("app.saving");
        setError(msg);
        setSaving(false);
        return;
      }

      recordEdit(t("frequency.savedToast"), body.validation, {
        entity: "frequency",
        entityId: `${tripId}:${form.start_time}`,
      });
      onClose();
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setSaving(false);
    }
  };

  const handleClose = (_, reason) => {
    if (saving) return;
    if (reason === "backdropClick") return;
    onClose();
  };

  // ── render ────────────────────────────────────────────────────────────────

  const dialogTitle =
    mode === "create"
      ? t("frequency.dialogTitleCreate", { tripId })
      : t("frequency.dialogTitleEdit", { start: initial?.start_time ?? "" });

  const headwaySummary = useMemo(() => {
    if (!headwaySecs) return null;
    const mins = Math.floor(headwaySecs / 60);
    const secs = headwaySecs % 60;
    if (headwaySecs % 3600 === 0) {
      return `${headwaySecs / 3600}h`;
    }
    if (secs === 0) return `${mins} min`;
    return `${mins > 0 ? `${mins} min ` : ""}${secs} sec`;
  }, [headwaySecs]);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown={saving}
      PaperProps={{
        sx: {
          borderTop: (theme) => `3px solid ${theme.palette.info.main}`,
          borderRadius: 2,
        },
      }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Box display="flex" alignItems="center" gap={1.25} flexWrap="wrap">
          <Box
            sx={{
              width: 32,
              height: 32,
              borderRadius: 1.5,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: (theme) =>
                theme.palette.mode === "dark"
                  ? "rgba(2,136,209,0.18)"
                  : "rgba(2,136,209,0.12)",
              color: "info.main",
              flexShrink: 0,
            }}
          >
            <AccessTimeIcon sx={{ fontSize: 18 }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} lineHeight={1.2}>
              {dialogTitle}
            </Typography>
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                mt: 0.25,
                flexWrap: "wrap",
              }}
            >
              <Chip
                label={tripId}
                size="small"
                icon={<ContentCopyIcon sx={{ fontSize: "12px !important" }} />}
                onClick={() => navigator.clipboard.writeText(tripId)}
                sx={{
                  height: 18,
                  fontSize: "0.68rem",
                  fontFamily: "monospace",
                  cursor: "pointer",
                }}
              />
            </Box>
          </Box>
        </Box>
      </DialogTitle>

      <DialogContent dividers>
        <Box display="flex" flexDirection="column" gap={2} pt={1}>

          {/* start_time */}
          <TextField
            label="start_time"
            value={form.start_time}
            onChange={handleChange("start_time")}
            disabled={mode === "edit"}
            size="small"
            fullWidth
            placeholder="06:00:00"
            helperText={
              mode === "edit"
                ? t("frequency.startTimePrimaryKey")
                : t("frequency.startTime")
            }
            error={
              form.start_time !== "" && !TIME_RE.test(form.start_time)
            }
          />

          {/* end_time */}
          <TextField
            label="end_time"
            value={form.end_time}
            onChange={handleChange("end_time")}
            size="small"
            fullWidth
            placeholder="22:00:00"
            helperText={t("frequency.endTime")}
            error={
              form.end_time !== "" &&
              (!TIME_RE.test(form.end_time) ||
                (TIME_RE.test(form.start_time) &&
                  TIME_RE.test(form.end_time) &&
                  !timeLt(form.start_time, form.end_time)))
            }
          />

          {/* headway_secs — dual-input: display value + unit selector */}
          <Box>
            <Box display="flex" gap={1} alignItems="flex-start">
              <TextField
                label="headway_secs"
                value={form.headway_display}
                onChange={handleChange("headway_display")}
                size="small"
                sx={{ flex: 2 }}
                type="number"
                inputProps={{ min: 1, step: 1 }}
                helperText={t("frequency.headwayLabel")}
                error={
                  form.headway_display !== "" &&
                  (!Number.isInteger(Number(form.headway_display)) ||
                    Number(form.headway_display) <= 0)
                }
                InputProps={{
                  endAdornment: headwaySecs ? (
                    <InputAdornment position="end">
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {t("frequency.headwaySummary", { secs: headwaySecs })}
                      </Typography>
                    </InputAdornment>
                  ) : null,
                }}
              />
              <TextField
                select
                label={t("frequency.headwayLabel")}
                value={form.headway_unit}
                onChange={handleChange("headway_unit")}
                size="small"
                sx={{ flex: 1 }}
              >
                {UNIT_OPTIONS.map((u) => (
                  <MenuItem key={u.value} value={u.value}>
                    {t(`frequency.headwayUnit.${u.value}`)}
                  </MenuItem>
                ))}
              </TextField>
            </Box>

            {/* real-time human readable summary */}
            {headwaySecs && headwaySummary && (
              <Typography
                variant="caption"
                color="info.main"
                sx={{ mt: 0.5, display: "block", fontWeight: 600 }}
              >
                {t("frequency.every", { value: headwaySummary })}
              </Typography>
            )}
          </Box>

          {/* exact_times */}
          <TextField
            select
            label="exact_times"
            value={form.exact_times}
            onChange={handleChange("exact_times")}
            size="small"
            fullWidth
            helperText={t("frequency.exactTimesHelp")}
          >
            {EXACT_TIMES_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value}>
                {t(o.labelKey)}
              </MenuItem>
            ))}
          </TextField>

          {error && <Alert severity="error">{error}</Alert>}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={() => handleClose()} disabled={saving} color="inherit">
          {t("app.cancel")}
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          color="info"
          disabled={saving}
          startIcon={saving ? <CircularProgress size={14} /> : null}
        >
          {saving ? t("app.saving") : t("app.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EditFrequencyDialog;
