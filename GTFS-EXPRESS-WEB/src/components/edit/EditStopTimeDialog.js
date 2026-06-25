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
} from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";

// Shared continuous_pickup / continuous_drop_off enum
const CONTINUOUS_OPTIONS = [
  { value: "", labelKey: "continuous.empty" },
  { value: "0", labelKey: "continuous.0" },
  { value: "1", labelKey: "continuous.1" },
  { value: "2", labelKey: "continuous.2" },
  { value: "3", labelKey: "continuous.3" },
];

const TIMEPOINT_OPTIONS = [
  { value: "", labelKey: "continuous.empty" }, // reuse "not set" label
  { value: "0", labelKey: "editStopTime.timepoint.0" },
  { value: "1", labelKey: "editStopTime.timepoint.1" },
];

// pickup_type / drop_off_type enums (GTFS spec values 0..3, default = 0).
// Empty string is preserved verbatim to mean "field absent in stop_times.txt".
const PICKUP_TYPE_OPTIONS = [
  { value: "", labelKey: "edit.stopTime.pickup_type.empty" },
  { value: "0", labelKey: "edit.stopTime.pickup_type.0" },
  { value: "1", labelKey: "edit.stopTime.pickup_type.1" },
  { value: "2", labelKey: "edit.stopTime.pickup_type.2" },
  { value: "3", labelKey: "edit.stopTime.pickup_type.3" },
];

const DROP_OFF_TYPE_OPTIONS = [
  { value: "", labelKey: "edit.stopTime.drop_off_type.empty" },
  { value: "0", labelKey: "edit.stopTime.drop_off_type.0" },
  { value: "1", labelKey: "edit.stopTime.drop_off_type.1" },
  { value: "2", labelKey: "edit.stopTime.drop_off_type.2" },
  { value: "3", labelKey: "edit.stopTime.drop_off_type.3" },
];

const buildInitialForm = (stopTime) => ({
  timepoint: stopTime?.timepoint != null ? String(stopTime.timepoint) : "",
  stop_headsign: stopTime?.stop_headsign || "",
  shape_dist_traveled:
    stopTime?.shape_dist_traveled != null
      ? String(stopTime.shape_dist_traveled)
      : "",
  continuous_pickup:
    stopTime?.continuous_pickup != null
      ? String(stopTime.continuous_pickup)
      : "",
  continuous_drop_off:
    stopTime?.continuous_drop_off != null
      ? String(stopTime.continuous_drop_off)
      : "",
  pickup_type:
    stopTime?.pickup_type != null ? String(stopTime.pickup_type) : "",
  drop_off_type:
    stopTime?.drop_off_type != null ? String(stopTime.drop_off_type) : "",
});

/**
 * EditStopTimeDialog — edit advanced stop_time fields for a single row.
 *
 * Props:
 *   open         {boolean}
 *   stopTime     {object}  — must contain trip_id, stop_sequence, stop_id, stop_name (optional)
 *   onClose      {function}
 */
function EditStopTimeDialog({ open, stopTime, onClose }) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();

  const initial = useMemo(
    () => buildInitialForm(stopTime),
    [stopTime?.trip_id, stopTime?.stop_sequence],
  );

  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // Hooks before early returns (rules-of-hooks)
  useEffect(() => {
    if (open) {
      setForm(initial);
      setError(null);
    }
  }, [open, initial]);

  const dirty = useMemo(
    () => Object.keys(initial).some((k) => form[k] !== initial[k]),
    [form, initial],
  );

  const handleChange = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleClose = (_, reason) => {
    if (saving) return;
    if (dirty && reason === "backdropClick") return;
    onClose();
  };

  const handleSave = async () => {
    if (!stopTime) return;
    setSaving(true);
    setError(null);

    // Validate shape_dist_traveled if provided
    if (form.shape_dist_traveled !== "") {
      const val = parseFloat(form.shape_dist_traveled);
      if (Number.isNaN(val) || val < 0) {
        setError(t("editStopTime.errorShapeDist"));
        setSaving(false);
        return;
      }
    }

    // Build patch with only changed fields
    const patch = {};
    if (form.timepoint !== initial.timepoint) {
      patch.timepoint =
        form.timepoint !== "" ? Number(form.timepoint) : null;
    }
    if (form.stop_headsign !== initial.stop_headsign) {
      patch.stop_headsign = form.stop_headsign;
    }
    if (form.shape_dist_traveled !== initial.shape_dist_traveled) {
      patch.shape_dist_traveled =
        form.shape_dist_traveled !== ""
          ? parseFloat(form.shape_dist_traveled)
          : null;
    }
    if (form.continuous_pickup !== initial.continuous_pickup) {
      patch.continuous_pickup =
        form.continuous_pickup !== "" ? Number(form.continuous_pickup) : null;
    }
    if (form.continuous_drop_off !== initial.continuous_drop_off) {
      patch.continuous_drop_off =
        form.continuous_drop_off !== ""
          ? Number(form.continuous_drop_off)
          : null;
    }
    if (form.pickup_type !== initial.pickup_type) {
      patch.pickup_type =
        form.pickup_type !== "" ? Number(form.pickup_type) : null;
    }
    if (form.drop_off_type !== initial.drop_off_type) {
      patch.drop_off_type =
        form.drop_off_type !== "" ? Number(form.drop_off_type) : null;
    }

    if (Object.keys(patch).length === 0) {
      onClose();
      setSaving(false);
      return;
    }

    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/stop_times/${encodeURIComponent(stopTime.trip_id)}/${stopTime.stop_sequence}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        const msg = body.details
          ? body.details.join("; ")
          : body.error || "Save failed";
        setError(msg);
        setSaving(false);
        return;
      }
      recordEdit(t("editStopTime.savedToast"), body.validation, {
        entity: "stop_time",
        entityId: `${stopTime.trip_id}:${stopTime.stop_sequence}`,
      });
      onClose();
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setSaving(false);
    }
  };

  if (!stopTime) return null;

  const entityLabel = stopTime.stop_name || stopTime.stop_id;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown={saving}
      PaperProps={{
        sx: {
          borderTop: (theme) => `3px solid ${theme.palette.warning.main}`,
          borderRadius: 2,
        },
      }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Box display="flex" alignItems="center" gap={1.25}>
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
                  ? "rgba(237,108,2,0.18)"
                  : "rgba(237,108,2,0.12)",
              color: "warning.main",
            }}
          >
            <EditIcon sx={{ fontSize: 18 }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} lineHeight={1.2}>
              {t("editStopTime.dialogTitle")}
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
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontFamily: "monospace" }}
              >
                {entityLabel}
              </Typography>
              <Chip
                label={`seq ${stopTime.stop_sequence}`}
                size="small"
                sx={{ height: 18, fontSize: "0.68rem" }}
              />
              <Chip
                label={stopTime.trip_id}
                size="small"
                icon={<ContentCopyIcon sx={{ fontSize: "12px !important" }} />}
                onClick={() =>
                  navigator.clipboard.writeText(stopTime.trip_id)
                }
                sx={{
                  height: 18,
                  fontSize: "0.68rem",
                  fontFamily: "monospace",
                  cursor: "pointer",
                }}
              />
            </Box>
          </Box>
          {dirty && (
            <Chip
              label={t("edit.unsavedBadge")}
              size="small"
              color="warning"
              sx={{ height: 22, fontSize: 10, fontWeight: 700 }}
            />
          )}
        </Box>
      </DialogTitle>

      <DialogContent dividers>
        <Box display="flex" flexDirection="column" gap={2} pt={1}>
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ lineHeight: 1, mb: -0.5 }}
          >
            {t("editStopTime.advancedTitle")}
          </Typography>

          {/* timepoint */}
          <TextField
            select
            label="timepoint"
            value={form.timepoint}
            onChange={handleChange("timepoint")}
            size="small"
            fullWidth
            helperText={t("editStopTime.timepoint")}
          >
            {TIMEPOINT_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value}>
                {t(o.labelKey)}
              </MenuItem>
            ))}
          </TextField>

          {/* stop_headsign */}
          <TextField
            label="stop_headsign"
            value={form.stop_headsign}
            onChange={handleChange("stop_headsign")}
            size="small"
            fullWidth
            helperText={t("editStopTime.stopHeadsign")}
          />

          {/* shape_dist_traveled */}
          <TextField
            label="shape_dist_traveled"
            value={form.shape_dist_traveled}
            onChange={handleChange("shape_dist_traveled")}
            size="small"
            fullWidth
            type="number"
            inputProps={{ min: 0, step: 0.01 }}
            helperText={t("editStopTime.shapeDistTraveled")}
          />

          {/* continuous_pickup / continuous_drop_off */}
          <Box display="flex" gap={2}>
            <TextField
              select
              label="continuous_pickup"
              value={form.continuous_pickup}
              onChange={handleChange("continuous_pickup")}
              size="small"
              sx={{ flex: 1 }}
              helperText={t("editStopTime.continuousPickup")}
            >
              {CONTINUOUS_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label="continuous_drop_off"
              value={form.continuous_drop_off}
              onChange={handleChange("continuous_drop_off")}
              size="small"
              sx={{ flex: 1 }}
              helperText={t("editStopTime.continuousDropOff")}
            >
              {CONTINUOUS_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </MenuItem>
              ))}
            </TextField>
          </Box>

          {/* pickup_type / drop_off_type */}
          <Box display="flex" gap={2}>
            <TextField
              select
              label={t("edit.stopTime.pickup_type.label")}
              value={form.pickup_type}
              onChange={handleChange("pickup_type")}
              size="small"
              sx={{ flex: 1 }}
              helperText={t("edit.stopTime.pickup_type.help")}
            >
              {PICKUP_TYPE_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label={t("edit.stopTime.drop_off_type.label")}
              value={form.drop_off_type}
              onChange={handleChange("drop_off_type")}
              size="small"
              sx={{ flex: 1 }}
              helperText={t("edit.stopTime.drop_off_type.help")}
            >
              {DROP_OFF_TYPE_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </MenuItem>
              ))}
            </TextField>
          </Box>

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
          color="warning"
          disabled={saving || !dirty}
          startIcon={saving ? <CircularProgress size={14} /> : null}
        >
          {saving ? t("edit.saving") : t("app.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EditStopTimeDialog;
