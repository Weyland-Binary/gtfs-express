import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  TextField,
  Box,
  Alert,
  CircularProgress,
  Chip,
  Typography,
  Divider,
  Radio,
  RadioGroup,
  FormControl,
  FormControlLabel,
  FormLabel,
  FormHelperText,
  Checkbox,
  FormGroup,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import AddIcon from "@mui/icons-material/Add";
import EditIcon from "@mui/icons-material/Edit";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import EntityAutocomplete from "./EntityAutocomplete";

/**
 * Determine the initial target mode from the existing attribution row.
 * mutual exclusivity is enforced server-side and surfaced in the UI as
 * a single radio group ("Feed-wide" / "Agency" / "Route" / "Trip").
 */
function deriveInitialTarget(initial) {
  if (!initial) return "feed";
  if (initial.agency_id) return "agency";
  if (initial.route_id) return "route";
  if (initial.trip_id) return "trip";
  return "feed";
}

const buildInitialForm = (initial) => ({
  attribution_id: initial?.attribution_id || "",
  agency_id: initial?.agency_id || "",
  route_id: initial?.route_id || "",
  trip_id: initial?.trip_id || "",
  organization_name: initial?.organization_name || "",
  is_producer: Number(initial?.is_producer) === 1,
  is_operator: Number(initial?.is_operator) === 1,
  is_authority: Number(initial?.is_authority) === 1,
  attribution_url: initial?.attribution_url || "",
  attribution_email: initial?.attribution_email || "",
  attribution_phone: initial?.attribution_phone || "",
});

/**
 * EditAttributionDialog — CREATE / EDIT an attributions.txt entry.
 *
 * Props:
 *   open      — boolean
 *   onClose   — callback
 *   mode      — "create" | "edit"
 *   initial   — existing attribution object (edit mode) — must include `id` (rowid)
 *   onSaved   — callback() after successful save
 */
function EditAttributionDialog({ open, onClose, mode = "create", initial, onSaved }) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();

  const [target, setTarget] = useState(() => deriveInitialTarget(initial));
  const [form, setForm] = useState(() => buildInitialForm(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [submitted, setSubmitted] = useState(false);

  // Reset state on open
  useEffect(() => {
    if (open) {
      setTarget(deriveInitialTarget(initial));
      setForm(buildInitialForm(initial));
      setError(null);
      setSubmitted(false);
    }
  }, [open, initial]);

  const setField = (name, value) => {
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleTargetChange = (newTarget) => {
    // Mutual exclusivity: switching target clears all FK fields.
    setTarget(newTarget);
    setForm((prev) => ({
      ...prev,
      agency_id: "",
      route_id: "",
      trip_id: "",
    }));
  };

  const orgMissing = !form.organization_name.trim();
  const noRoles = !form.is_producer && !form.is_operator && !form.is_authority;
  const targetMissing =
    (target === "agency" && !form.agency_id) ||
    (target === "route" && !form.route_id) ||
    (target === "trip" && !form.trip_id);

  const validate = () => {
    if (orgMissing) return t("edit.attribution.organization_name.required");
    if (noRoles) return t("edit.attribution.roles.atLeastOne");
    if (targetMissing) return t("edit.attribution.target.missing");
    return null;
  };

  const buildPayload = () => {
    const payload = {
      organization_name: form.organization_name.trim(),
      is_producer: form.is_producer ? 1 : 0,
      is_operator: form.is_operator ? 1 : 0,
      is_authority: form.is_authority ? 1 : 0,
    };
    if (form.attribution_id.trim()) payload.attribution_id = form.attribution_id.trim();
    if (target === "agency") payload.agency_id = form.agency_id;
    else if (target === "route") payload.route_id = form.route_id;
    else if (target === "trip") payload.trip_id = form.trip_id;
    if (form.attribution_url.trim()) payload.attribution_url = form.attribution_url.trim();
    if (form.attribution_email.trim()) payload.attribution_email = form.attribution_email.trim();
    if (form.attribution_phone.trim()) payload.attribution_phone = form.attribution_phone.trim();
    return payload;
  };

  const handleSave = async () => {
    setSubmitted(true);
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const isEdit = mode === "edit" && initial?.id != null;
      const url = isEdit
        ? `${API_BASE_URL}/edit/attributions/${initial.id}`
        : `${API_BASE_URL}/edit/attributions`;
      const res = await fetchWithSession(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || t("app.saving"));
      recordEdit(
        isEdit ? t("edit.attribution.savedToast") : t("edit.attribution.createdToast"),
        body.validation,
        {
          entity: "attribution",
          entityId: isEdit ? String(initial.id) : (body.attribution?.id != null ? String(body.attribution.id) : null),
        },
      );
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const isEdit = mode === "edit";
  const title = isEdit
    ? t("edit.attribution.dialogTitle")
    : t("edit.attribution.createTitle");

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="md"
      fullWidth
      disableEscapeKeyDown={saving}
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
                  ? isEdit
                    ? "rgba(237,108,2,0.18)"
                    : "rgba(46,125,50,0.18)"
                  : isEdit
                    ? "rgba(237,108,2,0.12)"
                    : "rgba(46,125,50,0.12)",
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
            {isEdit && initial?.id != null && (
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

        {/* attribution_id (optional) */}
        <Box sx={{ display: "flex", gap: 2, mb: 2, flexWrap: "wrap" }}>
          <TextField
            label="attribution_id"
            value={form.attribution_id}
            onChange={(e) => setField("attribution_id", e.target.value)}
            size="small"
            sx={{ flex: "1 1 240px" }}
            helperText={t("edit.attribution.attribution_id.help")}
            inputProps={{ style: { fontFamily: "monospace" } }}
          />
          <TextField
            label={t("edit.attribution.organization_name")}
            value={form.organization_name}
            onChange={(e) => setField("organization_name", e.target.value)}
            size="small"
            required
            sx={{ flex: "2 1 320px" }}
            error={submitted && orgMissing}
            helperText={
              submitted && orgMissing
                ? t("edit.attribution.organization_name.required")
                : ""
            }
          />
        </Box>

        <Divider sx={{ my: 1.5 }} />

        {/* Target — radio group + entity picker */}
        <FormControl
          component="fieldset"
          sx={{ mb: 2, width: "100%" }}
          error={submitted && targetMissing}
        >
          <FormLabel
            component="legend"
            sx={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              mb: 0.5,
            }}
          >
            {t("edit.attribution.target.label")}
          </FormLabel>
          <FormHelperText sx={{ ml: 0, mb: 0.75 }}>
            {t("edit.attribution.target.help")}
          </FormHelperText>
          <RadioGroup
            row
            value={target}
            onChange={(e) => handleTargetChange(e.target.value)}
          >
            <FormControlLabel
              value="feed"
              control={<Radio size="small" />}
              label={t("attributions.targetFeed")}
            />
            <FormControlLabel
              value="agency"
              control={<Radio size="small" />}
              label={t("attributions.targetAgency")}
            />
            <FormControlLabel
              value="route"
              control={<Radio size="small" />}
              label={t("attributions.targetRoute")}
            />
            <FormControlLabel
              value="trip"
              control={<Radio size="small" />}
              label={t("attributions.targetTrip")}
            />
          </RadioGroup>

          {target === "agency" && (
            <Box sx={{ mt: 1 }}>
              <EntityAutocomplete
                entity="agency"
                label="agency_id"
                value={form.agency_id}
                onChange={(v) => setField("agency_id", v)}
                placeholder="agency_id…"
                error={submitted && targetMissing}
              />
            </Box>
          )}
          {target === "route" && (
            <Box sx={{ mt: 1 }}>
              <EntityAutocomplete
                entity="route"
                label="route_id"
                value={form.route_id}
                onChange={(v) => setField("route_id", v)}
                placeholder="route_id…"
                error={submitted && targetMissing}
              />
            </Box>
          )}
          {target === "trip" && (
            <Box sx={{ mt: 1 }}>
              <EntityAutocomplete
                entity="trip"
                label="trip_id"
                value={form.trip_id}
                onChange={(v) => setField("trip_id", v)}
                placeholder="trip_id…"
                error={submitted && targetMissing}
              />
            </Box>
          )}
        </FormControl>

        <Divider sx={{ my: 1.5 }} />

        {/* Roles (at least one required) */}
        <FormControl
          component="fieldset"
          sx={{ mb: 2, width: "100%" }}
          error={submitted && noRoles}
        >
          <FormLabel
            component="legend"
            sx={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              mb: 0.5,
            }}
          >
            {t("attributions.colRoles")}
          </FormLabel>
          <FormHelperText sx={{ ml: 0, mb: 0.5 }}>
            {submitted && noRoles
              ? t("edit.attribution.roles.atLeastOne")
              : t("edit.attribution.roles.help")}
          </FormHelperText>
          <FormGroup row>
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={form.is_producer}
                  onChange={(e) => setField("is_producer", e.target.checked)}
                />
              }
              label={
                <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                  <Box component="span" sx={{ fontFamily: "monospace", opacity: 0.55, fontSize: 11 }}>
                    is_producer
                  </Box>
                  <Box component="span">{t("attributions.roleProducer")}</Box>
                </Box>
              }
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={form.is_operator}
                  onChange={(e) => setField("is_operator", e.target.checked)}
                />
              }
              label={
                <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                  <Box component="span" sx={{ fontFamily: "monospace", opacity: 0.55, fontSize: 11 }}>
                    is_operator
                  </Box>
                  <Box component="span">{t("attributions.roleOperator")}</Box>
                </Box>
              }
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={form.is_authority}
                  onChange={(e) => setField("is_authority", e.target.checked)}
                />
              }
              label={
                <Box component="span" sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                  <Box component="span" sx={{ fontFamily: "monospace", opacity: 0.55, fontSize: 11 }}>
                    is_authority
                  </Box>
                  <Box component="span">{t("attributions.roleAuthority")}</Box>
                </Box>
              }
            />
          </FormGroup>
        </FormControl>

        <Divider sx={{ my: 1.5 }} />

        {/* Contact info */}
        <Typography
          variant="overline"
          color="text.secondary"
          sx={{ fontWeight: 700, letterSpacing: "0.08em", display: "block", mb: 1 }}
        >
          {t("attributions.colContact")}
        </Typography>
        <Box sx={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
          <TextField
            label={t("edit.attribution.url")}
            value={form.attribution_url}
            onChange={(e) => setField("attribution_url", e.target.value)}
            size="small"
            type="url"
            sx={{ flex: "1 1 260px" }}
            placeholder="https://example.org"
          />
          <TextField
            label={t("edit.attribution.email")}
            value={form.attribution_email}
            onChange={(e) => setField("attribution_email", e.target.value)}
            size="small"
            type="email"
            sx={{ flex: "1 1 240px" }}
            placeholder="contact@example.org"
          />
          <TextField
            label={t("edit.attribution.phone")}
            value={form.attribution_phone}
            onChange={(e) => setField("attribution_phone", e.target.value)}
            size="small"
            type="tel"
            sx={{ flex: "1 1 200px" }}
            placeholder="+33 1 23 45 67 89"
          />
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>
          {t("app.cancel")}
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={saving}>
          {saving ? <CircularProgress size={20} /> : t("app.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EditAttributionDialog;
