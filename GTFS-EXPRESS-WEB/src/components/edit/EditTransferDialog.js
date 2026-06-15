import React, { useState, useEffect } from "react";
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
  Chip,
  Typography,
  Divider,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import SwapHorizIcon from "@mui/icons-material/SwapHoriz";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import EntityAutocomplete from "./EntityAutocomplete";

const TRANSFER_TYPE_OPTIONS = [
  { value: "0", labelKey: "transfers.type.0" },
  { value: "1", labelKey: "transfers.type.1" },
  { value: "2", labelKey: "transfers.type.2" },
  { value: "3", labelKey: "transfers.type.3" },
  { value: "4", labelKey: "transfers.type.4" },
  { value: "5", labelKey: "transfers.type.5" },
];

const buildInitialForm = (initial, contextStopId) => ({
  from_stop_id: initial?.from_stop_id || contextStopId || "",
  from_route_id: initial?.from_route_id || "",
  from_trip_id: initial?.from_trip_id || "",
  to_stop_id: initial?.to_stop_id || "",
  to_route_id: initial?.to_route_id || "",
  to_trip_id: initial?.to_trip_id || "",
  transfer_type: initial?.transfer_type != null ? String(initial.transfer_type) : "0",
  min_transfer_time: initial?.min_transfer_time != null ? String(initial.min_transfer_time) : "",
});

/**
 * EditTransferDialog — CREATE / EDIT a transfers.txt entry.
 *
 * Props:
 *   open            — boolean
 *   onClose         — callback
 *   mode            — "create" | "edit"
 *   initial         — existing transfer object (edit mode)
 *   contextStopId   — pre-fills from_stop_id when opening from StopDetail
 *   onSaved         — callback() after successful save
 */
function EditTransferDialog({ open, onClose, mode = "create", initial, contextStopId, onSaved }) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();

  const [form, setForm] = useState(() => buildInitialForm(initial, contextStopId));
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  // Reset form when dialog opens with new data
  useEffect(() => {
    if (open) {
      setForm(buildInitialForm(initial, contextStopId));
      setError(null);
      setDeleteConfirm(false);
    }
  }, [open, initial, contextStopId]);

  const setField = (name, value) => {
    setForm((prev) => {
      const next = { ...prev, [name]: value };
      // Auto-clear min_transfer_time when transfer_type changes away from "2"
      if (name === "transfer_type" && value !== "2") {
        next.min_transfer_time = "";
      }
      return next;
    });
  };

  const validate = () => {
    // At least one of (from_stop_id AND to_stop_id) OR (from_trip_id AND to_trip_id)
    const hasStopPair = form.from_stop_id && form.to_stop_id;
    const hasTripPair = form.from_trip_id && form.to_trip_id;
    if (!hasStopPair && !hasTripPair) {
      return t("transfers.errorAtLeastOne");
    }
    if (form.transfer_type === "2") {
      const minTime = parseInt(form.min_transfer_time, 10);
      if (!form.min_transfer_time || isNaN(minTime) || minTime <= 0) {
        return t("transfers.errorMinTime");
      }
    }
    return null;
  };

  const buildPayload = () => {
    const payload = {
      transfer_type: parseInt(form.transfer_type, 10),
    };
    if (form.from_stop_id) payload.from_stop_id = form.from_stop_id;
    if (form.from_route_id) payload.from_route_id = form.from_route_id;
    if (form.from_trip_id) payload.from_trip_id = form.from_trip_id;
    if (form.to_stop_id) payload.to_stop_id = form.to_stop_id;
    if (form.to_route_id) payload.to_route_id = form.to_route_id;
    if (form.to_trip_id) payload.to_trip_id = form.to_trip_id;
    if (form.transfer_type === "2" && form.min_transfer_time) {
      payload.min_transfer_time = parseInt(form.min_transfer_time, 10);
    }
    return payload;
  };

  const handleSave = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const isEdit = mode === "edit" && initial?.id;
      const url = isEdit
        ? `${API_BASE_URL}/edit/transfers/${initial.id}`
        : `${API_BASE_URL}/edit/transfers`;
      const res = await fetchWithSession(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t("app.saving"));
      recordEdit(t("transfers.savedToast"), body.validation, {
        entity: "transfer",
        entityId: isEdit ? initial.id : null,
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
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/transfers/${initial.id}`,
        { method: "DELETE" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || "Delete failed");
      }
      recordEdit(t("transfers.deletedToast"), body.validation, {
        entity: "transfer",
        entityId: initial.id,
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const isEdit = mode === "edit";
  const title = isEdit ? t("transfers.dialogTitleEdit") : t("transfers.dialogTitleCreate");

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
            {isEdit && initial?.id && (
              <Chip
                label={`#${initial.id}`}
                size="small"
                sx={{ mt: 0.25, height: 18, fontSize: "0.68rem", fontFamily: "monospace" }}
                icon={<ContentCopyIcon sx={{ fontSize: "12px !important" }} />}
                onClick={() => navigator.clipboard.writeText(String(initial.id))}
              />
            )}
          </Box>
        </Box>
      </DialogTitle>

      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {/* Section: Source (from) */}
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ fontWeight: 700, letterSpacing: "0.08em", display: "block", mb: 1, mt: 0.5 }}
        >
          {t("transfers.sectionSource")}
        </Typography>
        <Box sx={{ display: "flex", gap: 2, mb: 2, flexWrap: "wrap" }}>
          <Box sx={{ flex: "1 1 220px" }}>
            <EntityAutocomplete
              entity="stop"
              label="from_stop_id"
              value={form.from_stop_id}
              onChange={(v) => setField("from_stop_id", v)}
              placeholder="stop_id…"
            />
          </Box>
          <Box sx={{ flex: "1 1 220px" }}>
            <EntityAutocomplete
              entity="route"
              label="from_route_id"
              value={form.from_route_id}
              onChange={(v) => setField("from_route_id", v)}
              placeholder="route_id… (optional)"
            />
          </Box>
          <Box sx={{ flex: "1 1 220px" }}>
            <EntityAutocomplete
              entity="trip"
              label="from_trip_id"
              value={form.from_trip_id}
              onChange={(v) => setField("from_trip_id", v)}
              placeholder="trip_id… (optional)"
            />
          </Box>
        </Box>

        <Divider sx={{ my: 1.5 }} />

        {/* Section: Destination (to) */}
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ fontWeight: 700, letterSpacing: "0.08em", display: "block", mb: 1 }}
        >
          {t("transfers.sectionDestination")}
        </Typography>
        <Box sx={{ display: "flex", gap: 2, mb: 2, flexWrap: "wrap" }}>
          <Box sx={{ flex: "1 1 220px" }}>
            <EntityAutocomplete
              entity="stop"
              label="to_stop_id"
              value={form.to_stop_id}
              onChange={(v) => setField("to_stop_id", v)}
              placeholder="stop_id…"
            />
          </Box>
          <Box sx={{ flex: "1 1 220px" }}>
            <EntityAutocomplete
              entity="route"
              label="to_route_id"
              value={form.to_route_id}
              onChange={(v) => setField("to_route_id", v)}
              placeholder="route_id… (optional)"
            />
          </Box>
          <Box sx={{ flex: "1 1 220px" }}>
            <EntityAutocomplete
              entity="trip"
              label="to_trip_id"
              value={form.to_trip_id}
              onChange={(v) => setField("to_trip_id", v)}
              placeholder="trip_id… (optional)"
            />
          </Box>
        </Box>

        <Divider sx={{ my: 1.5 }} />

        {/* Transfer type + min time */}
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
          <TextField
            select
            label="transfer_type"
            value={form.transfer_type}
            onChange={(e) => setField("transfer_type", e.target.value)}
            required
            size="small"
            sx={{ flex: "1 1 260px" }}
          >
            {TRANSFER_TYPE_OPTIONS.map((opt) => (
              <MenuItem key={opt.value} value={opt.value}>
                <Box component="span" sx={{ fontFamily: "monospace", mr: 1, opacity: 0.6 }}>
                  {opt.value}
                </Box>
                {t(opt.labelKey)}
              </MenuItem>
            ))}
          </TextField>

          {form.transfer_type === "2" && (
            <TextField
              label="min_transfer_time"
              value={form.min_transfer_time}
              onChange={(e) => setField("min_transfer_time", e.target.value)}
              type="number"
              size="small"
              inputProps={{ min: 1 }}
              helperText={t("transfers.minTransferTimeHelp")}
              sx={{ flex: "1 1 200px" }}
              required
            />
          )}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        {isEdit && (
          <>
            {deleteConfirm ? (
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, mr: "auto" }}>
                <Typography variant="caption" color="error">
                  {t("transfers.deleteConfirmBody")}
                </Typography>
                <Button
                  color="error"
                  size="small"
                  onClick={handleDelete}
                  disabled={deleting}
                >
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
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving || deleting}
        >
          {saving ? <CircularProgress size={20} /> : t("app.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EditTransferDialog;
