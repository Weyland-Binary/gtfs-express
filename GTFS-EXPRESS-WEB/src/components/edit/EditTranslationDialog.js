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
  RadioGroup,
  FormControlLabel,
  Radio,
  FormControl,
  FormLabel,
} from "@mui/material";
import TranslateIcon from "@mui/icons-material/Translate";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";

// BCP-47 simple validation: "fr", "en-US", "zh-CN", "sr-Latn", etc.
const BCP47_RE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|[0-9]{3})?(-[a-zA-Z0-9]+)*$/;

const TABLES = [
  "agency",
  "stops",
  "routes",
  "trips",
  "stop_times",
  "feed_info",
  "pathways",
  "levels",
  "attributions",
];

const FIELDS_BY_TABLE = {
  agency: ["agency_name", "agency_url", "agency_fare_url"],
  stops: ["stop_name", "stop_desc", "tts_stop_name", "stop_url"],
  routes: ["route_short_name", "route_long_name", "route_desc", "route_url"],
  trips: ["trip_headsign", "trip_short_name"],
  stop_times: ["stop_headsign"],
  feed_info: ["feed_publisher_name", "feed_publisher_url"],
  pathways: ["signposted_as", "reversed_signposted_as"],
  levels: ["level_name"],
  attributions: ["organization_name"],
};

function buildInitial(initial) {
  return {
    table_name: initial?.table_name || "stops",
    field_name: initial?.field_name || "",
    language: initial?.language || "",
    translation: initial?.translation || "",
    record_id: initial?.record_id ?? "",
    record_sub_id: initial?.record_sub_id ?? "",
    field_value: initial?.field_value ?? "",
  };
}

/**
 * EditTranslationDialog — create/edit a single translation row.
 *
 * Props:
 *   open           — boolean
 *   onClose        — callback
 *   onSaved        — callback called after successful save
 *   mode           — "create" | "edit"
 *   initial        — partial translation row for pre-filling
 *   lockedTable    — if set, table_name Select is disabled
 *   availableFields — if set, overrides FIELDS_BY_TABLE for the locked table
 */
function EditTranslationDialog({
  open,
  onClose,
  onSaved,
  mode = "create",
  initial,
  lockedTable,
  availableFields,
}) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();

  const [form, setForm] = useState(() => buildInitial(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // "by_record" | "by_value" — controls which identifier field is active
  const [matchMode, setMatchMode] = useState(
    initial?.field_value ? "by_value" : "by_record",
  );

  useEffect(() => {
    if (open) {
      const init = buildInitial(initial);
      setForm(init);
      setMatchMode(init.field_value ? "by_value" : "by_record");
      setError(null);
    }
  }, [open, initial]);

  const isFeedInfo = form.table_name === "feed_info";
  const isStopTimes = form.table_name === "stop_times";

  const fieldOptions = useMemo(() => {
    if (lockedTable && availableFields) return availableFields;
    return FIELDS_BY_TABLE[form.table_name] || [];
  }, [form.table_name, lockedTable, availableFields]);

  const handleChange = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleTableChange = (e) => {
    const tbl = e.target.value;
    const firstField = (FIELDS_BY_TABLE[tbl] || [])[0] || "";
    setForm((f) => ({
      ...f,
      table_name: tbl,
      field_name: firstField,
      record_id: "",
      record_sub_id: "",
      field_value: "",
    }));
    setMatchMode("by_record");
  };

  // Client-side validation
  const validate = () => {
    if (!form.language.trim() || !BCP47_RE.test(form.language.trim())) {
      return t("translations.errorBCP47");
    }
    if (!form.field_name) {
      return t("translations.errorFieldNotTranslatable");
    }
    if (!form.translation.trim()) {
      return t("translations.errorTranslationRequired");
    }
    return null;
  };

  const buildPayload = () => {
    const payload = {
      table_name: form.table_name,
      field_name: form.field_name,
      language: form.language.trim(),
      translation: form.translation.trim(),
    };
    if (!isFeedInfo) {
      if (matchMode === "by_record" && form.record_id.trim()) {
        payload.record_id = form.record_id.trim();
      } else if (matchMode === "by_value" && form.field_value.trim()) {
        payload.field_value = form.field_value.trim();
      }
    }
    if (isStopTimes && form.record_sub_id.trim()) {
      payload.record_sub_id = form.record_sub_id.trim();
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
      const payload = buildPayload();
      let res;
      if (mode === "edit" && initial?.id) {
        res = await fetchWithSession(
          `${API_BASE_URL}/edit/translations/${initial.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
      } else {
        res = await fetchWithSession(`${API_BASE_URL}/edit/translations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          body.error ||
            (body.details ? body.details.join(", ") : t("edit.errors.saveFailed")),
        );
      }
      recordEdit(t("translations.savedToast"), body.validation, {
        entity: "translation",
        entityId: `${form.table_name}:${form.field_name}:${form.language}`,
      });
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown={saving}
      PaperProps={{
        sx: {
          borderTop: (theme) => `3px solid ${theme.palette.primary.main}`,
          borderRadius: 2,
        },
      }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
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
                  ? "rgba(25,118,210,0.18)"
                  : "rgba(25,118,210,0.10)",
              color: "primary.main",
            }}
          >
            <TranslateIcon sx={{ fontSize: 18 }} />
          </Box>
          <Box>
            <Typography variant="subtitle1" fontWeight={700} lineHeight={1.2}>
              {mode === "edit"
                ? t("translations.dialogTitleEdit")
                : t("translations.dialogTitleCreate")}
            </Typography>
            {form.table_name && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontFamily: "monospace" }}
              >
                translations.txt
              </Typography>
            )}
          </Box>
        </Box>
      </DialogTitle>

      <DialogContent dividers>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
          {error && (
            <Alert severity="error" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {/* table_name — disabled when lockedTable */}
          <TextField
            select
            label="table_name"
            value={form.table_name}
            onChange={handleTableChange}
            size="small"
            disabled={Boolean(lockedTable)}
            inputProps={{ style: { fontFamily: "monospace" } }}
          >
            {TABLES.map((tbl) => (
              <MenuItem key={tbl} value={tbl} sx={{ fontFamily: "monospace" }}>
                {tbl}
              </MenuItem>
            ))}
          </TextField>

          {/* field_name */}
          <TextField
            select
            label={t("translations.fieldName")}
            value={form.field_name}
            onChange={handleChange("field_name")}
            size="small"
            inputProps={{ style: { fontFamily: "monospace" } }}
          >
            {fieldOptions.map((f) => (
              <MenuItem key={f} value={f} sx={{ fontFamily: "monospace" }}>
                {f}
              </MenuItem>
            ))}
          </TextField>

          {/* language — BCP-47 */}
          <TextField
            label={t("translations.languageLabel")}
            value={form.language}
            onChange={handleChange("language")}
            size="small"
            placeholder="fr, en-US, zh-CN…"
            error={
              form.language.trim().length > 0 &&
              !BCP47_RE.test(form.language.trim())
            }
            helperText={
              form.language.trim().length > 0 &&
              !BCP47_RE.test(form.language.trim())
                ? t("translations.errorBCP47")
                : undefined
            }
            inputProps={{ style: { fontFamily: "monospace" } }}
          />

          {/* translation */}
          <TextField
            label={t("translations.translationLabel")}
            value={form.translation}
            onChange={handleChange("translation")}
            size="small"
            multiline
            minRows={2}
            autoFocus={mode === "edit"}
          />

          {/* Identifier section — hidden for feed_info */}
          {!isFeedInfo && (
            <Box>
              <FormControl component="fieldset" size="small">
                <FormLabel component="legend" sx={{ fontSize: 12, mb: 0.5 }}>
                  {/* No i18n label for the radio group — kept technical */}
                  record_id vs field_value
                </FormLabel>
                <RadioGroup
                  row
                  value={matchMode}
                  onChange={(e) => {
                    setMatchMode(e.target.value);
                    setForm((f) => ({
                      ...f,
                      record_id: "",
                      field_value: "",
                    }));
                  }}
                >
                  <FormControlLabel
                    value="by_record"
                    control={<Radio size="small" />}
                    label={
                      <Typography variant="caption">
                        {t("translations.matchByRecord")}
                      </Typography>
                    }
                  />
                  <FormControlLabel
                    value="by_value"
                    control={<Radio size="small" />}
                    label={
                      <Typography variant="caption">
                        {t("translations.matchByValue")}
                      </Typography>
                    }
                  />
                </RadioGroup>
              </FormControl>

              {matchMode === "by_record" ? (
                <TextField
                  label={t("translations.recordIdLabel")}
                  value={form.record_id}
                  onChange={handleChange("record_id")}
                  size="small"
                  fullWidth
                  sx={{ mt: 1 }}
                  inputProps={{ style: { fontFamily: "monospace" } }}
                />
              ) : (
                <TextField
                  label={t("translations.fieldValueLabel")}
                  value={form.field_value}
                  onChange={handleChange("field_value")}
                  size="small"
                  fullWidth
                  sx={{ mt: 1 }}
                />
              )}
            </Box>
          )}

          {/* record_sub_id — only for stop_times */}
          {isStopTimes && (
            <TextField
              label={t("translations.recordSubIdLabel")}
              value={form.record_sub_id}
              onChange={handleChange("record_sub_id")}
              size="small"
              type="number"
              inputProps={{ style: { fontFamily: "monospace" } }}
              helperText={t("translations.recordSubIdHelp")}
            />
          )}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} disabled={saving} color="inherit">
          {t("app.cancel")}
        </Button>
        <Button
          variant="contained"
          onClick={handleSave}
          disabled={saving}
          startIcon={saving ? <CircularProgress size={14} /> : null}
        >
          {saving ? t("app.saving") : t("app.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EditTranslationDialog;
