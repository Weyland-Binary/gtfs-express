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
  Switch,
  FormControlLabel,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Divider,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import AltRouteIcon from "@mui/icons-material/AltRoute";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import EntityAutocomplete from "./EntityAutocomplete";

// pathway_mode options — labels resolved via i18n
const PATHWAY_MODE_OPTIONS = [
  { value: 1, labelKey: "pathways.mode.1" },
  { value: 2, labelKey: "pathways.mode.2" },
  { value: 3, labelKey: "pathways.mode.3" },
  { value: 4, labelKey: "pathways.mode.4" },
  { value: 5, labelKey: "pathways.mode.5" },
  { value: 6, labelKey: "pathways.mode.6" },
  { value: 7, labelKey: "pathways.mode.7" },
];

// Gates (6, 7) are always one-way per GTFS spec
const GATE_MODES = new Set([6, 7]);
// Elevators (5) have no stair count
const ELEVATOR_MODE = 5;

const buildInitialForm = (initial, contextStopId) => ({
  pathway_id: initial?.pathway_id || "",
  from_stop_id: initial?.from_stop_id || contextStopId || "",
  to_stop_id: initial?.to_stop_id || "",
  pathway_mode: initial?.pathway_mode != null ? Number(initial.pathway_mode) : 1,
  is_bidirectional: initial?.is_bidirectional != null ? Number(initial.is_bidirectional) : 1,
  length: initial?.length != null ? String(initial.length) : "",
  traversal_time: initial?.traversal_time != null ? String(initial.traversal_time) : "",
  stair_count: initial?.stair_count != null ? String(initial.stair_count) : "",
  max_slope: initial?.max_slope != null ? String(initial.max_slope) : "",
  min_width: initial?.min_width != null ? String(initial.min_width) : "",
  signposted_as: initial?.signposted_as || "",
  reversed_signposted_as: initial?.reversed_signposted_as || "",
});

/**
 * EditPathwayDialog — CREATE / EDIT a pathways.txt entry.
 *
 * Props:
 *   open            — boolean
 *   onClose         — callback
 *   mode            — "create" | "edit"
 *   initial         — existing pathway object (edit mode)
 *   contextStopId   — pre-fills from_stop_id when opening from StopDetail
 *   onSaved         — callback() after successful save
 */
function EditPathwayDialog({ open, onClose, mode = "create", initial, contextStopId, onSaved }) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();

  const [form, setForm] = useState(() => buildInitialForm(initial, contextStopId));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [slopeWarning, setSlopeWarning] = useState(false);

  // All hooks BEFORE early returns (rules-of-hooks)
  const isEdit = mode === "edit";
  const isGate = GATE_MODES.has(form.pathway_mode);
  const isElevator = form.pathway_mode === ELEVATOR_MODE;

  // Derived: effective is_bidirectional (gates are always 0)
  const effectiveBidi = isGate ? 0 : form.is_bidirectional;

  useEffect(() => {
    if (open) {
      setForm(buildInitialForm(initial, contextStopId));
      setError(null);
      setDeleteConfirm(false);
      setSlopeWarning(false);
    }
  }, [open, initial, contextStopId]);

  const setField = (name, value) => {
    setForm((prev) => {
      const next = { ...prev, [name]: value };
      // Force is_bidirectional=0 for gates
      if (name === "pathway_mode" && GATE_MODES.has(Number(value))) {
        next.is_bidirectional = 0;
      }
      // Clear stair_count when switching to elevator
      if (name === "pathway_mode" && Number(value) === ELEVATOR_MODE) {
        next.stair_count = "";
      }
      return next;
    });
    // Soft warning for max_slope out of recommended range
    if (name === "max_slope" && value !== "") {
      const v = parseFloat(value);
      setSlopeWarning(!isNaN(v) && (v < -1 || v > 1));
    }
  };

  const validate = () => {
    if (!form.pathway_id.trim()) return t("pathways.errorIdRequired");
    if (!form.from_stop_id || !form.to_stop_id) return t("pathways.errorModeRequired");
    if (form.from_stop_id === form.to_stop_id) return t("pathways.errorFromToSame");
    if (!form.pathway_mode || form.pathway_mode < 1 || form.pathway_mode > 7)
      return t("pathways.errorModeRequired");
    const numFields = ["length", "traversal_time", "stair_count", "max_slope", "min_width"];
    for (const f of numFields) {
      if (form[f] !== "" && isNaN(parseFloat(form[f]))) {
        return t("pathways.errorNumericField", { field: f });
      }
    }
    return null;
  };

  const buildPayload = () => {
    const payload = {
      pathway_mode: Number(form.pathway_mode),
      is_bidirectional: effectiveBidi,
      from_stop_id: form.from_stop_id,
      to_stop_id: form.to_stop_id,
    };
    if (!isEdit) payload.pathway_id = form.pathway_id.trim();
    const numFields = ["length", "traversal_time", "stair_count", "max_slope", "min_width"];
    for (const f of numFields) {
      if (form[f] !== "" && !isNaN(parseFloat(form[f]))) {
        payload[f] = parseFloat(form[f]);
      }
    }
    if (form.signposted_as.trim()) payload.signposted_as = form.signposted_as.trim();
    if (form.reversed_signposted_as.trim() && effectiveBidi === 1)
      payload.reversed_signposted_as = form.reversed_signposted_as.trim();
    return payload;
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) { setError(validationError); return; }
    setSaving(true);
    setError(null);
    try {
      const url = isEdit
        ? `${API_BASE_URL}/edit/pathways/${encodeURIComponent(initial.pathway_id)}`
        : `${API_BASE_URL}/edit/pathways`;
      const res = await fetchWithSession(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t("app.saving"));
      recordEdit(t("pathways.savedToast"), body.validation, {
        entity: "pathway",
        entityId: isEdit ? initial.pathway_id : null,
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteConfirm) { setDeleteConfirm(true); return; }
    setDeleting(true);
    setError(null);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/pathways/${encodeURIComponent(initial.pathway_id)}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Delete failed");
      }
      recordEdit(t("pathways.deletedToast"), body.validation, {
        entity: "pathway",
        entityId: initial.pathway_id,
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const title = isEdit ? t("pathways.dialogTitleEdit") : t("pathways.dialogTitleCreate");

  return (
    <Dialog
      open={open}
      onClose={saving || deleting ? undefined : onClose}
      maxWidth="md"
      fullWidth
      disableEscapeKeyDown={saving || deleting}
      PaperProps={{
        sx: {
          borderTop: (theme) =>
            `3px solid ${isEdit ? theme.palette.warning.main : theme.palette.success.main}`,
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
                  ? isEdit ? "rgba(237,108,2,0.18)" : "rgba(46,125,50,0.18)"
                  : isEdit ? "rgba(237,108,2,0.12)" : "rgba(46,125,50,0.12)",
              color: isEdit ? "warning.main" : "success.main",
              flexShrink: 0,
            }}
          >
            {isEdit ? (
              <EditIcon sx={{ fontSize: 18 }} />
            ) : (
              <AddIcon sx={{ fontSize: 18 }} />
            )}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} lineHeight={1.2}>
              {title}
            </Typography>
            {isEdit && initial?.pathway_id && (
              <Chip
                label={initial.pathway_id}
                size="small"
                sx={{ mt: 0.25, height: 18, fontSize: "0.68rem", fontFamily: "monospace" }}
                icon={<ContentCopyIcon sx={{ fontSize: "12px !important" }} />}
                onClick={() => navigator.clipboard.writeText(initial.pathway_id)}
              />
            )}
          </Box>
        </Box>
      </DialogTitle>

      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {slopeWarning && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {t("pathways.slopeWarning")}
          </Alert>
        )}

        {/* Section: Identification */}
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ fontWeight: 700, letterSpacing: "0.08em", display: "block", mb: 1 }}
        >
          {t("pathways.pathwayId")}
        </Typography>
        <TextField
          label="pathway_id"
          value={form.pathway_id}
          onChange={(e) => setField("pathway_id", e.target.value)}
          size="small"
          fullWidth
          required
          disabled={isEdit}
          inputProps={{ style: { fontFamily: "monospace" } }}
          sx={{ mb: 2 }}
        />

        <Divider sx={{ my: 1.5 }} />

        {/* Section: Endpoints */}
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ fontWeight: 700, letterSpacing: "0.08em", display: "block", mb: 1 }}
        >
          {t("pathways.sectionEndpoints")}
        </Typography>
        <Box sx={{ display: "flex", gap: 2, mb: 2, flexWrap: "wrap" }}>
          <Box sx={{ flex: "1 1 240px" }}>
            <EntityAutocomplete
              entity="stop"
              label="from_stop_id"
              value={form.from_stop_id}
              onChange={(v) => setField("from_stop_id", v)}
              placeholder="stop_id…"
              required
            />
          </Box>
          <Box sx={{ flex: "1 1 240px" }}>
            <EntityAutocomplete
              entity="stop"
              label="to_stop_id"
              value={form.to_stop_id}
              onChange={(v) => setField("to_stop_id", v)}
              placeholder="stop_id…"
              required
              getOptionDisabled={(opt) => opt.stop_id === form.from_stop_id}
            />
          </Box>
        </Box>

        <Divider sx={{ my: 1.5 }} />

        {/* Section: Type & direction */}
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ fontWeight: 700, letterSpacing: "0.08em", display: "block", mb: 1 }}
        >
          {t("pathways.pathwayMode")} &amp; {t("pathways.isBidirectional")}
        </Typography>
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", mb: 1 }}>
          <TextField
            select
            label="pathway_mode"
            value={form.pathway_mode}
            onChange={(e) => setField("pathway_mode", Number(e.target.value))}
            required
            size="small"
            sx={{ flex: "1 1 240px" }}
          >
            {PATHWAY_MODE_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                <Box component="span" sx={{ fontFamily: "monospace", mr: 1, opacity: 0.6, minWidth: 18 }}>
                  {opt.value}
                </Box>
                {t(opt.labelKey)}
              </MenuItem>
            ))}
          </TextField>

          <Box sx={{ flex: "1 1 200px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <FormControlLabel
              control={
                <Switch
                  checked={effectiveBidi === 1}
                  onChange={(e) => setField("is_bidirectional", e.target.checked ? 1 : 0)}
                  disabled={isGate}
                  size="small"
                />
              }
              label={
                <Typography variant="body2">
                  {t("pathways.isBidirectional")}
                </Typography>
              }
            />
            {isGate && (
              <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5, mt: -0.5 }}>
                {t("pathways.gateOneWayHelp")}
              </Typography>
            )}
          </Box>
        </Box>

        {/* Section: Advanced physical characteristics */}
        <Accordion
          disableGutters
          elevation={0}
          sx={{
            mt: 1.5,
            border: (theme) => `1px solid ${theme.palette.divider}`,
            borderRadius: "6px !important",
            "&:before": { display: "none" },
          }}
        >
          <AccordionSummary
            expandIcon={<ExpandMoreIcon />}
            sx={{ minHeight: 40, "& .MuiAccordionSummary-content": { my: 0.75 } }}
          >
            <Typography variant="caption" fontWeight={600} color="text.secondary">
              {t("pathways.advancedSection")}
            </Typography>
          </AccordionSummary>
          <AccordionDetails sx={{ pt: 1, pb: 2 }}>
            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap", mb: 2 }}>
              <TextField
                label="length"
                value={form.length}
                onChange={(e) => setField("length", e.target.value)}
                size="small"
                type="number"
                inputProps={{ min: 0, step: 0.1 }}
                helperText={t("pathways.length")}
                sx={{ flex: "1 1 130px" }}
              />
              <TextField
                label="traversal_time"
                value={form.traversal_time}
                onChange={(e) => setField("traversal_time", e.target.value)}
                size="small"
                type="number"
                inputProps={{ min: 0, step: 1 }}
                helperText={t("pathways.traversalTime")}
                sx={{ flex: "1 1 130px" }}
              />
              <TextField
                label="stair_count"
                value={form.stair_count}
                onChange={(e) => setField("stair_count", e.target.value)}
                size="small"
                type="number"
                inputProps={{ step: 1 }}
                disabled={isElevator}
                helperText={isElevator ? t("pathways.elevatorNoStairsHelp") : t("pathways.stairCount")}
                sx={{ flex: "1 1 130px" }}
              />
              <TextField
                label="max_slope"
                value={form.max_slope}
                onChange={(e) => setField("max_slope", e.target.value)}
                size="small"
                type="number"
                inputProps={{ step: 0.01 }}
                helperText={t("pathways.maxSlope")}
                sx={{ flex: "1 1 130px" }}
              />
              <TextField
                label="min_width"
                value={form.min_width}
                onChange={(e) => setField("min_width", e.target.value)}
                size="small"
                type="number"
                inputProps={{ min: 0, step: 0.1 }}
                helperText={t("pathways.minWidth")}
                sx={{ flex: "1 1 130px" }}
              />
            </Box>
            <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
              <TextField
                label="signposted_as"
                value={form.signposted_as}
                onChange={(e) => setField("signposted_as", e.target.value)}
                size="small"
                helperText={t("pathways.signposted")}
                sx={{ flex: "1 1 220px" }}
              />
              {effectiveBidi === 1 && (
                <TextField
                  label="reversed_signposted_as"
                  value={form.reversed_signposted_as}
                  onChange={(e) => setField("reversed_signposted_as", e.target.value)}
                  size="small"
                  helperText={t("pathways.reversedSignposted")}
                  sx={{ flex: "1 1 220px" }}
                />
              )}
            </Box>
          </AccordionDetails>
        </Accordion>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        {isEdit && (
          <>
            {deleteConfirm ? (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, mr: "auto" }}>
                <Typography variant="caption" color="error">
                  {t("pathways.deleteConfirmBody")}
                </Typography>
                <Button color="error" size="small" onClick={handleDelete} disabled={deleting}>
                  {deleting ? <CircularProgress size={16} /> : t("app.confirm")}
                </Button>
                <Button size="small" onClick={() => setDeleteConfirm(false)}>
                  {t("app.cancel")}
                </Button>
              </Box>
            ) : (
              <Button
                color="error"
                onClick={handleDelete}
                disabled={saving || deleting}
                sx={{ mr: "auto" }}
              >
                {t("app.delete")}
              </Button>
            )}
          </>
        )}
        <Button onClick={onClose} disabled={saving || deleting}>
          {t("app.cancel")}
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={saving || deleting}>
          {saving ? <CircularProgress size={20} /> : t("app.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EditPathwayDialog;
