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
import { editRefusal, editFailure } from "../../utils/editRefusal";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";

const CONTINUOUS_OPTIONS = [
  { value: "", labelKey: "continuous.empty" },
  { value: "0", labelKey: "continuous.0" },
  { value: "1", labelKey: "continuous.1" },
  { value: "2", labelKey: "continuous.2" },
  { value: "3", labelKey: "continuous.3" },
];

const TIMEPOINT_OPTIONS = [
  { value: "", labelKey: "continuous.empty" },
  { value: "0", labelKey: "editStopTime.timepoint.0" },
  { value: "1", labelKey: "editStopTime.timepoint.1" },
];

// Empty is kept verbatim: it means the field is absent from stop_times.txt.
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

/** Edit the advanced fields of one stop_times row (`stopTime` carries trip_id, stop_sequence, stop_id). */
function EditStopTimeDialog({ open, stopTime, onClose }) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();

  const [initial, setInitial] = useState(() => buildInitialForm(stopTime));
  const [form, setForm] = useState(() => buildInitialForm(stopTime));
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Hooks before early returns (#18). The full row is fetched on open: the ScheduleGrid that opens this dialog
  // carries only trip_id / stop_sequence / stop_id, not the advanced columns.
  useEffect(() => {
    if (!open) return undefined;
    const tripId = stopTime?.trip_id;
    const seq = stopTime?.stop_sequence;
    if (!tripId || seq == null) return undefined;

    // Seeded from what the caller passed, so the form is not stale while loading.
    const seed = buildInitialForm(stopTime);
    setForm(seed);
    setInitial(seed);
    setError(null);
    setLoading(true);

    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithSession(
          `${API_BASE_URL}/edit/stop_times/${encodeURIComponent(tripId)}/${encodeURIComponent(seq)}`,
        );
        if (!res.ok) throw new Error("load failed");
        const body = await res.json();
        if (cancelled || !body.stop_time) return;
        const fresh = buildInitialForm(body.stop_time);
        setForm(fresh);
        setInitial(fresh);
      } catch {
        // Network error or 404: the seeded values keep the dialog usable.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // Keyed on the row's identity, not the object, so unrelated parent re-renders do not re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stopTime?.trip_id, stopTime?.stop_sequence]);

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

    if (form.shape_dist_traveled !== "") {
      const val = parseFloat(form.shape_dist_traveled);
      if (Number.isNaN(val) || val < 0) {
        setError(t("editStopTime.errorShapeDist"));
        setSaving(false);
        return;
      }
    }

    // Only the changed fields. pickup_type / drop_off_type / timepoint / continuous_* are TEXT columns: a JS number
    // would be bound as REAL and stored as "1.0", breaking enum matching, so the <select>'s string tokens are sent.
    const patch = {};
    if (form.timepoint !== initial.timepoint) {
      patch.timepoint = form.timepoint !== "" ? form.timepoint : null;
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
        form.continuous_pickup !== "" ? form.continuous_pickup : null;
    }
    if (form.continuous_drop_off !== initial.continuous_drop_off) {
      patch.continuous_drop_off =
        form.continuous_drop_off !== "" ? form.continuous_drop_off : null;
    }
    if (form.pickup_type !== initial.pickup_type) {
      patch.pickup_type = form.pickup_type !== "" ? form.pickup_type : null;
    }
    if (form.drop_off_type !== initial.drop_off_type) {
      patch.drop_off_type =
        form.drop_off_type !== "" ? form.drop_off_type : null;
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
      if (!res.ok) {
        setError((await editRefusal(res, t)).text);
        setSaving(false);
        return;
      }
      const body = await res.json().catch(() => ({}));
      recordEdit(t("editStopTime.savedToast"), body.validation, {
        entity: "stop_time",
        entityId: `${stopTime.trip_id}:${stopTime.stop_sequence}`,
      });
      onClose();
    } catch (err) {
      setError(editFailure(err, t));
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
        <Box
          display="flex"
          flexDirection="column"
          gap={2}
          pt={1}
          sx={{ position: "relative" }}
        >
          {loading && (
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                zIndex: 2,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                bgcolor: (theme) =>
                  theme.palette.mode === "dark"
                    ? "rgba(0,0,0,0.35)"
                    : "rgba(255,255,255,0.6)",
                borderRadius: 1,
              }}
            >
              <CircularProgress size={26} color="warning" />
            </Box>
          )}
          <Typography
            variant="overline"
            color="text.secondary"
            sx={{ lineHeight: 1, mb: -0.5 }}
          >
            {t("editStopTime.advancedTitle")}
          </Typography>

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

          <TextField
            label="stop_headsign"
            value={form.stop_headsign}
            onChange={handleChange("stop_headsign")}
            size="small"
            fullWidth
            helperText={t("editStopTime.stopHeadsign")}
          />

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
          disabled={saving || loading || !dirty}
          startIcon={saving ? <CircularProgress size={14} /> : null}
        >
          {saving ? t("edit.saving") : t("app.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EditStopTimeDialog;
