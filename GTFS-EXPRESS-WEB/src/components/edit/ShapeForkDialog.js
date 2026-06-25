import React, { useState, useMemo } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Typography,
  Checkbox,
  FormControlLabel,
  Box,
  Alert,
  CircularProgress,
  Divider,
} from "@mui/material";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { fetchWithSession } from "../../utils/sessionManager";
import API_BASE_URL from "../../config";

/**
 * Dialog for forking a shared shape: duplicate it under a new shape_id
 * and reassign selected trips to the new copy.
 */
function ShapeForkDialog({ open, shapeId, trips = [], onClose, onForked }) {
  const { recordEdit } = useEditMode();
  const { t } = useLanguage();
  const [newShapeId, setNewShapeId] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const handleToggle = (tripId) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tripId)) next.delete(tripId);
      else next.add(tripId);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selected.size === trips.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(trips.map((tr) => tr.trip_id)));
    }
  };

  const newCount = selected.size;
  const keepCount = trips.length - newCount;

  const canSave = useMemo(
    () => newShapeId.trim().length > 0 && selected.size > 0 && !saving,
    [newShapeId, selected, saving],
  );

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/shapes/${encodeURIComponent(shapeId)}/fork`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            new_shape_id: newShapeId.trim(),
            trip_ids: [...selected],
          }),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        setError(body.error || "Fork failed.");
        return;
      }
      recordEdit(
        t("edit.shape.forkedToast", {
          id: newShapeId.trim(),
          count: selected.size,
        }),
        body.validation,
        { entity: "shape", entityId: newShapeId.trim() },
      );
      onForked?.(body);
      handleClose();
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setNewShapeId("");
    setSelected(new Set());
    setError("");
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <CallSplitIcon fontSize="small" />
        {t("edit.shape.forkTitle")}
      </DialogTitle>
      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <TextField
          label={t("edit.shape.forkNewId")}
          value={newShapeId}
          onChange={(e) => setNewShapeId(e.target.value)}
          fullWidth
          size="small"
          sx={{ mb: 2 }}
          inputProps={{ style: { fontFamily: "monospace" } }}
          placeholder={`${shapeId}_v2`}
          autoFocus
        />

        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t("edit.shape.forkSelectTrips")}
        </Typography>

        <Box sx={{ mb: 1 }}>
          <FormControlLabel
            control={
              <Checkbox
                checked={selected.size === trips.length && trips.length > 0}
                indeterminate={
                  selected.size > 0 && selected.size < trips.length
                }
                onChange={handleSelectAll}
                size="small"
              />
            }
            label={
              <Typography variant="body2" fontWeight={600}>
                {selected.size === trips.length
                  ? t("edit.shape.deselectAll")
                  : t("edit.shape.selectAll")}
              </Typography>
            }
          />
        </Box>

        <Divider sx={{ mb: 1 }} />

        <Box sx={{ maxHeight: 280, overflow: "auto" }}>
          {trips.map((tr) => (
            <FormControlLabel
              key={tr.trip_id}
              sx={{ display: "flex", width: "100%", ml: 0 }}
              control={
                <Checkbox
                  checked={selected.has(tr.trip_id)}
                  onChange={() => handleToggle(tr.trip_id)}
                  size="small"
                />
              }
              label={
                <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
                  <Typography
                    variant="body2"
                    sx={{ fontFamily: "monospace", fontSize: 12 }}
                  >
                    {tr.trip_id}
                  </Typography>
                  {tr.trip_headsign && (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ fontSize: 12 }}
                    >
                      {tr.trip_headsign}
                    </Typography>
                  )}
                </Box>
              }
            />
          ))}
        </Box>

        {selected.size > 0 && (
          <Alert severity="info" sx={{ mt: 2 }}>
            {t("edit.shape.forkPreview", {
              newCount,
              keepCount,
            })}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={saving}>
          {t("edit.shape.cancel")}
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          disabled={!canSave}
          startIcon={saving ? <CircularProgress size={16} /> : <CallSplitIcon />}
        >
          {t("edit.shape.forkTitle")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ShapeForkDialog;
