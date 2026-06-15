import React, { useState, useEffect, useRef, useMemo } from "react";
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
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import EditIcon from "@mui/icons-material/Edit";
import TranslateIcon from "@mui/icons-material/Translate";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import ColorPickerField, { bestContrastColor } from "./ColorPickerField";
import EntityAutocomplete from "./EntityAutocomplete";
import TranslationsRecordPanel from "./TranslationsRecordPanel";

const ROUTE_TRANSLATABLE_FIELDS = ["route_short_name", "route_long_name", "route_desc", "route_url"];

const CONTINUOUS_OPTIONS = [
  { value: "", labelKey: "continuous.empty" },
  { value: "0", labelKey: "continuous.0" },
  { value: "1", labelKey: "continuous.1" },
  { value: "2", labelKey: "continuous.2" },
  { value: "3", labelKey: "continuous.3" },
];

const CEMV_SUPPORT_OPTIONS = [
  { value: "", labelKey: "edit.route.cemv_support.0" },
  { value: "1", labelKey: "edit.route.cemv_support.1" },
  { value: "2", labelKey: "edit.route.cemv_support.2" },
];

const ROUTE_TYPE_OPTIONS = [
  { value: "", labelKey: "edit.route.typeEmpty" },
  { value: "0", labelKey: "edit.route.type0" },
  { value: "1", labelKey: "edit.route.type1" },
  { value: "2", labelKey: "edit.route.type2" },
  { value: "3", labelKey: "edit.route.type3" },
  { value: "4", labelKey: "edit.route.type4" },
  { value: "5", labelKey: "edit.route.type5" },
  { value: "6", labelKey: "edit.route.type6" },
  { value: "7", labelKey: "edit.route.type7" },
  { value: "11", labelKey: "edit.route.type11" },
  { value: "12", labelKey: "edit.route.type12" },
];

const HEX_RE = /^[0-9A-Fa-f]{6}$/;

const stripHash = (v) => (v || "").replace(/^#/, "").trim();

const buildInitialForm = (route) => ({
  route_short_name: route?.route_short_name || "",
  route_long_name: route?.route_long_name || "",
  route_desc: route?.route_desc || "",
  route_type: route?.route_type != null ? String(route.route_type) : "",
  route_color: stripHash(route?.route_color),
  route_text_color: stripHash(route?.route_text_color),
  route_url: route?.route_url || "",
  route_sort_order:
    route?.route_sort_order != null ? String(route.route_sort_order) : "",
  agency_id: route?.agency_id || "",
  // GTFS v2.1 advanced fields
  continuous_pickup:
    route?.continuous_pickup != null ? String(route.continuous_pickup) : "",
  continuous_drop_off:
    route?.continuous_drop_off != null ? String(route.continuous_drop_off) : "",
  network_id: route?.network_id || "",
  cemv_support:
    route?.cemv_support != null ? String(route.cemv_support) : "",
});

function EditRouteDialog({
  open,
  route,
  onClose,
  mode = "edit",
  onCreated,
  highlightFields = [],
}) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();
  const dialogContentRef = useRef(null);
  const isDuplicate = mode === "duplicate";

  const initial = useMemo(() => buildInitialForm(route), [route]);
  const [form, setForm] = useState(initial);
  const [routeId, setRouteId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setForm(initial);
      setError(null);
      if (isDuplicate && route) {
        setRouteId(route.route_id + "_copy");
      } else {
        setRouteId("");
      }
    }
  }, [open, initial, isDuplicate, route]);

  const dirty = useMemo(
    () =>
      isDuplicate
        ? routeId.trim().length > 0
        : Object.keys(initial).some((k) => form[k] !== initial[k]),
    [form, initial, isDuplicate, routeId],
  );

  const handleChange = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const setColor = (field) => (value) =>
    setForm((f) => ({ ...f, [field]: stripHash(value).toUpperCase() }));

  // When the user changes the background color, auto-update the text color
  // to maximise WCAG contrast — only if the text color was empty OR was set
  // by a previous auto-pick (tracked implicitly: black/white).
  const handleBgColorChange = (value) => {
    const clean = stripHash(value).toUpperCase();
    setForm((f) => {
      const prevText = f.route_text_color;
      const wasAutoOrEmpty =
        !prevText || prevText === "FFFFFF" || prevText === "000000";
      const next = { ...f, route_color: clean };
      if (wasAutoOrEmpty && HEX_RE.test(clean)) {
        next.route_text_color = bestContrastColor(clean);
      }
      return next;
    });
  };

  const handleClose = (_, reason) => {
    if (saving) return;
    if (dirty && reason === "backdropClick") return;
    onClose();
  };

  const handleSave = async () => {
    if (!route) return;
    setSaving(true);
    setError(null);

    if (form.route_color && !HEX_RE.test(form.route_color)) {
      setError(t("edit.route.errorColor"));
      setSaving(false);
      return;
    }
    if (form.route_text_color && !HEX_RE.test(form.route_text_color)) {
      setError(t("edit.route.errorTextColor"));
      setSaving(false);
      return;
    }

    try {
      if (isDuplicate) {
        if (!routeId.trim()) {
          setError(t("edit.route.errorIdRequired") || "route_id is required.");
          setSaving(false);
          return;
        }
        const payload = {
          route_id: routeId.trim(),
          agency_id: form.agency_id || null,
          route_short_name: form.route_short_name || null,
          route_long_name: form.route_long_name || null,
          route_desc: form.route_desc || null,
          route_type: form.route_type || null,
          route_color: form.route_color || null,
          route_text_color: form.route_text_color || null,
          route_url: form.route_url || null,
          route_sort_order: form.route_sort_order || null,
          continuous_pickup: form.continuous_pickup || null,
          continuous_drop_off: form.continuous_drop_off || null,
          network_id: form.network_id || null,
          cemv_support: form.cemv_support || null,
        };
        const res = await fetchWithSession(`${API_BASE_URL}/edit/routes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.json();
        if (!res.ok) {
          setError(
            body.error + (body.details ? ` (${body.details.join(", ")})` : ""),
          );
          setSaving(false);
          return;
        }
        const label =
          body.route?.route_short_name ||
          payload.route_short_name ||
          payload.route_id;
        recordEdit(t("edit.route.duplicatedToast", { name: label }), body.validation, {
          entity: "route",
          entityId: payload.route_id,
        });
        onCreated?.(body.route || payload);
        onClose();
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

      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/routes/${encodeURIComponent(route.route_id)}`,
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
        body.route?.route_short_name ||
        route.route_short_name ||
        route.route_id;
      recordEdit(t("edit.route.savedToast", { name: label }), body.validation, {
        entity: "route",
        entityId: route.route_id,
      });
      onClose();
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setSaving(false);
    }
  };

  // Scroll to and highlight the first flagged field when the dialog opens
  useEffect(() => {
    if (!open || highlightFields.length === 0) return;
    const frame = requestAnimationFrame(() => {
      const el = dialogContentRef.current?.querySelector(".gtfs-field-flagged");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, highlightFields]);

  /**
   * Returns MUI TextField props that visually flag the field if its name is in
   * highlightFields.
   */
  const fieldProps = (name) => {
    if (!highlightFields.includes(name)) return {};
    return {
      className: "gtfs-field-flagged",
      helperText: t("validation.fix.flagged"),
      FormHelperTextProps: {
        sx: { color: "warning.main", fontWeight: 600, fontSize: "0.72rem" },
      },
      InputLabelProps: { sx: { color: "warning.main" } },
    };
  };

  if (!route) return null;

  const colorPreview = (hex) =>
    hex && HEX_RE.test(hex) ? `#${hex}` : "transparent";

  const previewBg = colorPreview(form.route_color) || "#1976d2";
  const previewFg = colorPreview(form.route_text_color) || "#ffffff";

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown={saving}
      PaperProps={{
        sx: {
          borderTop: (theme) =>
            `3px solid ${
              isDuplicate
                ? theme.palette.info.main
                : theme.palette.warning.main
            }`,
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
                  ? isDuplicate
                    ? "rgba(2,136,209,0.18)"
                    : "rgba(237,108,2,0.18)"
                  : isDuplicate
                    ? "rgba(2,136,209,0.12)"
                    : "rgba(237,108,2,0.12)",
              color: isDuplicate ? "info.main" : "warning.main",
            }}
          >
            {isDuplicate ? (
              <ContentCopyIcon sx={{ fontSize: 18 }} />
            ) : (
              <EditIcon sx={{ fontSize: 18 }} />
            )}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} lineHeight={1.2}>
              {t(
                isDuplicate
                  ? "edit.route.duplicateTitle"
                  : "edit.route.dialogTitle",
              )}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontFamily: "monospace", display: "block", mt: 0.25 }}
            >
              {isDuplicate
                ? t("edit.route.duplicateFrom", { id: route.route_id })
                : route.route_id}
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
      <DialogContent dividers ref={dialogContentRef}>
        <Box display="flex" flexDirection="column" gap={2} pt={1}>
          {isDuplicate && (
            <TextField
              label="route_id"
              value={routeId}
              onChange={(e) => setRouteId(e.target.value)}
              size="small"
              required
              autoFocus
              inputProps={{ style: { fontFamily: "monospace" } }}
            />
          )}
          {/* Live preview chip */}
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1.5,
              p: 1.25,
              borderRadius: 1.5,
              background: (theme) =>
                theme.palette.mode === "dark"
                  ? "rgba(255,255,255,0.04)"
                  : "rgba(0,0,0,0.03)",
              border: (theme) =>
                `1px dashed ${
                  theme.palette.mode === "dark"
                    ? "rgba(255,255,255,0.12)"
                    : "rgba(0,0,0,0.12)"
                }`,
            }}
          >
            <Box
              sx={{
                px: 1.25,
                py: 0.75,
                borderRadius: 1,
                minWidth: 44,
                textAlign: "center",
                background: previewBg,
                color: previewFg,
                fontWeight: 800,
                fontSize: 13,
                letterSpacing: "0.02em",
                boxShadow: "0 1px 3px rgba(0,0,0,0.18)",
              }}
            >
              {form.route_short_name || "—"}
            </Box>
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {form.route_long_name || t("edit.route.previewPlaceholder")}
            </Typography>
          </Box>

          <Box display="flex" gap={2}>
            <TextField
              label={t("edit.route.shortName")}
              value={form.route_short_name}
              onChange={handleChange("route_short_name")}
              size="small"
              sx={{ flex: 1 }}
              autoFocus
              {...fieldProps("route_short_name")}
            />
            <TextField
              label={t("edit.route.longName")}
              value={form.route_long_name}
              onChange={handleChange("route_long_name")}
              size="small"
              sx={{ flex: 2 }}
              {...fieldProps("route_long_name")}
            />
          </Box>
          <TextField
            select
            label={t("edit.route.type")}
            value={form.route_type}
            onChange={handleChange("route_type")}
            size="small"
            {...fieldProps("route_type")}
          >
            {ROUTE_TYPE_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value}>
                {t(o.labelKey)}
              </MenuItem>
            ))}
          </TextField>
          <Box display="flex" gap={2}>
            <ColorPickerField
              label={t("edit.route.color")}
              value={form.route_color}
              onChange={handleBgColorChange}
              contrastAgainst={form.route_text_color}
              sx={{
                flex: 1,
                ...(highlightFields.includes("route_color")
                  ? { "& .MuiOutlinedInput-notchedOutline": { borderColor: "warning.main", borderWidth: 2 } }
                  : {}),
              }}
              className={
                highlightFields.includes("route_color")
                  ? "gtfs-field-flagged"
                  : undefined
              }
            />
            <ColorPickerField
              label={t("edit.route.textColor")}
              value={form.route_text_color}
              onChange={setColor("route_text_color")}
              contrastAgainst={form.route_color}
              sx={{
                flex: 1,
                ...(highlightFields.includes("route_text_color")
                  ? { "& .MuiOutlinedInput-notchedOutline": { borderColor: "warning.main", borderWidth: 2 } }
                  : {}),
              }}
              className={
                highlightFields.includes("route_text_color")
                  ? "gtfs-field-flagged"
                  : undefined
              }
            />
          </Box>
          <Box display="flex" gap={2}>
            <TextField
              label={t("edit.route.url")}
              value={form.route_url}
              onChange={handleChange("route_url")}
              size="small"
              type="url"
              sx={{ flex: 2 }}
              helperText={t("edit.route.url.help")}
              inputProps={{ style: { fontFamily: "monospace" } }}
              {...fieldProps("route_url")}
            />
            <TextField
              label={t("edit.route.sortOrder")}
              value={form.route_sort_order}
              onChange={handleChange("route_sort_order")}
              size="small"
              type="number"
              sx={{ flex: 1 }}
              inputProps={{ min: 0, step: 1 }}
              helperText={t("edit.route.sortOrder.help")}
              {...fieldProps("route_sort_order")}
            />
          </Box>
          <EntityAutocomplete
            entity="agency"
            value={form.agency_id}
            onChange={(v) => setForm((f) => ({ ...f, agency_id: v }))}
            label={t("edit.route.agency")}
            size="small"
          />
          <TextField
            label={t("edit.route.desc")}
            value={form.route_desc}
            onChange={handleChange("route_desc")}
            size="small"
            multiline
            minRows={2}
            {...fieldProps("route_desc")}
          />

          {/* GTFS v2.1 advanced fields */}
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
              sx={{ minHeight: 36, "& .MuiAccordionSummary-content": { my: 0.75 } }}
            >
              <Typography variant="caption" fontWeight={600} color="text.secondary">
                {t("editRoute.sectionAdvanced")}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0, pb: 1.5 }}>
              <Box display="flex" flexDirection="column" gap={2}>
                <Box display="flex" gap={2}>
                  <TextField
                    select
                    label="continuous_pickup"
                    value={form.continuous_pickup}
                    onChange={handleChange("continuous_pickup")}
                    size="small"
                    sx={{ flex: 1 }}
                    helperText={t("editRoute.continuousPickupHelp")}
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
                    helperText={t("editRoute.continuousDropOffHelp")}
                  >
                    {CONTINUOUS_OPTIONS.map((o) => (
                      <MenuItem key={o.value} value={o.value}>
                        {t(o.labelKey)}
                      </MenuItem>
                    ))}
                  </TextField>
                </Box>
                <TextField
                  label="network_id"
                  value={form.network_id}
                  onChange={handleChange("network_id")}
                  size="small"
                  fullWidth
                  helperText={t("editRoute.networkIdHelp")}
                  inputProps={{ style: { fontFamily: "monospace" } }}
                />
                <TextField
                  select
                  label={t("edit.route.cemv_support.label")}
                  value={form.cemv_support}
                  onChange={handleChange("cemv_support")}
                  size="small"
                  fullWidth
                  helperText={t("edit.route.cemv_support.help")}
                >
                  {CEMV_SUPPORT_OPTIONS.map((o) => (
                    <MenuItem key={o.value} value={o.value}>
                      {t(o.labelKey)}
                    </MenuItem>
                  ))}
                </TextField>
              </Box>
            </AccordionDetails>
          </Accordion>

          {/* Translations accordion — only in edit mode */}
          {!isDuplicate && route && (
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
                sx={{ minHeight: 36, "& .MuiAccordionSummary-content": { my: 0.75 } }}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
                  <TranslateIcon sx={{ fontSize: 15, opacity: 0.6 }} />
                  <Typography variant="caption" fontWeight={600} color="text.secondary">
                    {t("translations.accordionTitle")}
                  </Typography>
                </Box>
              </AccordionSummary>
              <AccordionDetails sx={{ pt: 0, pb: 1.5 }}>
                <TranslationsRecordPanel
                  tableName="routes"
                  recordId={route.route_id}
                  fields={ROUTE_TRANSLATABLE_FIELDS}
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
          color={isDuplicate ? "info" : "warning"}
          disabled={saving || !dirty}
          startIcon={saving ? <CircularProgress size={14} /> : null}
        >
          {saving
            ? t("edit.saving")
            : isDuplicate
              ? t("edit.route.duplicateBtn")
              : t("app.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EditRouteDialog;
