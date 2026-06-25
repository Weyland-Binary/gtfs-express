import React, { useState, useEffect, useMemo } from "react";
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
  Typography,
  Chip,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TranslateIcon from "@mui/icons-material/Translate";
import MenuItem from "@mui/material/MenuItem";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import TranslationsRecordPanel from "./TranslationsRecordPanel";

const AGENCY_TRANSLATABLE_FIELDS = [
  "agency_name",
  "agency_url",
  "agency_fare_url",
];

const CEMV_SUPPORT_OPTIONS = [
  { value: "", labelKey: "edit.agency.cemv_support.0" },
  { value: "1", labelKey: "edit.agency.cemv_support.1" },
  { value: "2", labelKey: "edit.agency.cemv_support.2" },
];

const buildInitialForm = (agency) => ({
  agency_name: agency?.agency_name || "",
  agency_url: agency?.agency_url || "",
  agency_timezone: agency?.agency_timezone || "",
  agency_lang: agency?.agency_lang || "",
  agency_phone: agency?.agency_phone || "",
  agency_fare_url: agency?.agency_fare_url || "",
  agency_email: agency?.agency_email || "",
  cemv_support:
    agency?.cemv_support != null ? String(agency.cemv_support) : "",
});

function EditAgencyDialog({ open, agency, onClose, onSaved }) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();

  const initial = useMemo(() => buildInitialForm(agency), [agency]);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

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
    if (!agency) return;
    setSaving(true);
    setError(null);

    // Client-side required field validation
    if (!form.agency_name.trim()) {
      setError(t("edit.agency.errorNameRequired"));
      setSaving(false);
      return;
    }
    if (!form.agency_url.trim()) {
      setError(t("edit.agency.errorUrlRequired"));
      setSaving(false);
      return;
    }
    if (!form.agency_timezone.trim()) {
      setError(t("edit.agency.errorTimezoneRequired"));
      setSaving(false);
      return;
    }

    const payload = {};
    Object.keys(initial).forEach((k) => {
      if (form[k] !== initial[k]) payload[k] = form[k];
    });

    if (Object.keys(payload).length === 0) {
      onClose();
      setSaving(false);
      return;
    }

    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/agencies/${encodeURIComponent(agency.agency_id)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        setError(
          body.error + (body.details ? ` (${body.details.join(", ")})` : ""),
        );
        setSaving(false);
        return;
      }
      const label =
        body.agency?.agency_name || agency.agency_name || agency.agency_id;
      recordEdit(t("edit.agency.savedToast", { name: label }), body.validation, {
        entity: "agency",
        entityId: agency.agency_id,
      });
      if (onSaved) onSaved({ ...agency, ...form, ...body.agency });
      onClose();
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setSaving(false);
    }
  };

  if (!agency) return null;

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
              {t("edit.agency.dialogTitle")}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontFamily: "monospace", display: "block", mt: 0.25 }}
            >
              {agency.agency_id}
            </Typography>
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
          <TextField
            label={t("edit.agency.name")}
            value={form.agency_name}
            onChange={handleChange("agency_name")}
            size="small"
            required
            autoFocus
          />
          <TextField
            label={t("edit.agency.url")}
            value={form.agency_url}
            onChange={handleChange("agency_url")}
            size="small"
            required
            placeholder="https://..."
          />
          <Box display="flex" gap={2}>
            <TextField
              label={t("edit.agency.timezone")}
              value={form.agency_timezone}
              onChange={handleChange("agency_timezone")}
              size="small"
              required
              placeholder="Europe/Paris"
              sx={{ flex: 1 }}
            />
            <TextField
              label={t("edit.agency.lang")}
              value={form.agency_lang}
              onChange={handleChange("agency_lang")}
              size="small"
              placeholder="fr"
              sx={{ flex: 1 }}
            />
          </Box>
          <Box display="flex" gap={2}>
            <TextField
              label={t("edit.agency.phone")}
              value={form.agency_phone}
              onChange={handleChange("agency_phone")}
              size="small"
              sx={{ flex: 1 }}
            />
            <TextField
              label={t("edit.agency.email")}
              value={form.agency_email}
              onChange={handleChange("agency_email")}
              size="small"
              sx={{ flex: 1 }}
            />
          </Box>
          <TextField
            label={t("edit.agency.fareUrl")}
            value={form.agency_fare_url}
            onChange={handleChange("agency_fare_url")}
            size="small"
            placeholder="https://..."
          />
          <TextField
            select
            label={t("edit.agency.cemv_support.label")}
            value={form.cemv_support}
            onChange={handleChange("cemv_support")}
            size="small"
            fullWidth
            helperText={t("edit.agency.cemv_support.help")}
          >
            {CEMV_SUPPORT_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value}>
                {t(o.labelKey)}
              </MenuItem>
            ))}
          </TextField>

          {/* Translations accordion — only in edit mode */}
          {agency && (
            <Accordion
              disableGutters
              elevation={0}
              sx={{
                border: (theme) => `1px solid ${theme.palette.divider}`,
                borderRadius: "6px !important",
                "&:before": { display: "none" },
              }}
            >
              <AccordionSummary
                expandIcon={<ExpandMoreIcon />}
                sx={{
                  minHeight: 36,
                  "& .MuiAccordionSummary-content": { my: 0.75 },
                }}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                  <TranslateIcon sx={{ fontSize: 15, opacity: 0.6 }} />
                  <Typography
                    variant="caption"
                    fontWeight={600}
                    color="text.secondary"
                  >
                    {t("translations.accordionTitle")}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0, pb: 1.5 }}>
                <TranslationsRecordPanel
                  tableName="agency"
                  recordId={agency.agency_id}
                  fields={AGENCY_TRANSLATABLE_FIELDS}
                />
              </AccordionDetails>
            </Accordion>
          )}

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

export default EditAgencyDialog;
