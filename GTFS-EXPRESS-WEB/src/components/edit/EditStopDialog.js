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
  Autocomplete,
  Tooltip,
} from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import EditIcon from "@mui/icons-material/Edit";
import AddLocationAltIcon from "@mui/icons-material/AddLocationAlt";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LayersIcon from "@mui/icons-material/Layers";
import TranslateIcon from "@mui/icons-material/Translate";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import TranslationsRecordPanel from "./TranslationsRecordPanel";

const STOP_TRANSLATABLE_FIELDS = ["stop_name", "stop_desc", "tts_stop_name", "stop_url"];

const WHEELCHAIR_OPTIONS = [
  { value: "", labelKey: "edit.stop.wheelchairEmpty" },
  { value: "0", labelKey: "edit.stop.wheelchair0" },
  { value: "1", labelKey: "edit.stop.wheelchair1" },
  { value: "2", labelKey: "edit.stop.wheelchair2" },
];

// stop_access is conditionally allowed: only for platforms (location_type=0
// or empty/default) attached to a station (parent_station required).
// Empty ≠ "0": per spec, empty means undefined while "0" explicitly states
// the platform cannot be accessed from the street.
const STOP_ACCESS_OPTIONS = [
  { value: "", labelKey: "edit.stop.stop_access.empty" },
  { value: "0", labelKey: "edit.stop.stop_access.0" },
  { value: "1", labelKey: "edit.stop.stop_access.1" },
];

// GTFS spec: location_type values
const LOCATION_TYPE_OPTIONS = [
  { value: "0", labelKey: "edit.stop.locationType0" },
  { value: "1", labelKey: "edit.stop.locationType1" },
  { value: "2", labelKey: "edit.stop.locationType2" },
  { value: "3", labelKey: "edit.stop.locationType3" },
  { value: "4", labelKey: "edit.stop.locationType4" },
];

// location_type values that require stop_name per the GTFS spec
const LOCATION_TYPES_REQUIRING_NAME = new Set(["0", "1", "2", ""]);

const buildInitialForm = (stop) => ({
  stop_name: stop?.stop_name || "",
  stop_code: stop?.stop_code || "",
  stop_desc: stop?.stop_desc || "",
  stop_lat: stop?.stop_lat != null ? String(stop.stop_lat) : "",
  stop_lon: stop?.stop_lon != null ? String(stop.stop_lon) : "",
  zone_id: stop?.zone_id || "",
  wheelchair_boarding: stop?.wheelchair_boarding || "",
  platform_code: stop?.platform_code || "",
  // location_type stored as string; empty string ≡ default 0 (Stop/Platform)
  location_type:
    stop?.location_type != null ? String(stop.location_type) : "0",
  // GTFS v2.1 advanced fields
  level_id: stop?.level_id || "",
  tts_stop_name: stop?.tts_stop_name || "",
  stop_url: stop?.stop_url || "",
  stop_timezone: stop?.stop_timezone || "",
  // parent_station is read-only here (managed elsewhere) but kept in the form
  // because stop_access eligibility depends on it.
  parent_station: stop?.parent_station || "",
  stop_access: stop?.stop_access != null ? String(stop.stop_access) : "",
});

function EditStopDialog({
  open,
  stop,
  onClose,
  mode = "edit",
  initialCoords = null,
  onCreated = null,
  highlightFields = [],
}) {
  const { t } = useLanguage();
  const { recordEdit, patchStop, showToast } = useEditMode();
  const { openPanel } = useDetailPanel();
  const dialogContentRef = useRef(null);
  const isDuplicate = mode === "duplicate";
  const isCreate = mode === "create" || isDuplicate;

  // Available levels for the level_id autocomplete
  const [availableLevels, setAvailableLevels] = useState([]);

  const initial = useMemo(() => {
    if (isDuplicate && stop) {
      return {
        stop_id: stop.stop_id + "_copy",
        ...buildInitialForm(stop),
      };
    }
    if (isCreate) {
      const base = { stop_id: "", ...buildInitialForm(null) };
      if (initialCoords) {
        base.stop_lat = String(initialCoords.lat.toFixed(6));
        base.stop_lon = String(initialCoords.lon.toFixed(6));
      }
      return base;
    }
    return buildInitialForm(stop);
  }, [stop, isCreate, isDuplicate, initialCoords]);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // stop_name is required when location_type is 0, 1, 2 (or blank = default 0)
  const stopNameRequired = LOCATION_TYPES_REQUIRING_NAME.has(
    form.location_type,
  );
  const stopNameMissing = stopNameRequired && form.stop_name.trim() === "";

  // stop_access is allowed only when:
  //   - location_type === "0" or "" (default = platform)
  //   - parent_station is non-empty (platform attached to a station)
  const isStopAccessAllowed = useMemo(() => {
    const lt = form.location_type;
    const isPlatform = lt === "0" || lt === "";
    return isPlatform && (form.parent_station || "").trim() !== "";
  }, [form.location_type, form.parent_station]);

  // Track whether stop_access was just auto-cleared so we can surface a notice.
  const [stopAccessCleared, setStopAccessCleared] = useState(false);

  // When the eligibility condition falls and stop_access is non-empty, clear it
  // and surface a one-shot info message. Re-run only on the eligibility flag.
  useEffect(() => {
    if (!isStopAccessAllowed && form.stop_access !== "") {
      setForm((f) => ({ ...f, stop_access: "" }));
      setStopAccessCleared(true);
    } else if (isStopAccessAllowed && stopAccessCleared) {
      // Clear the notice once eligibility is restored
      setStopAccessCleared(false);
    }
  }, [isStopAccessAllowed, form.stop_access, stopAccessCleared]);

  useEffect(() => {
    if (open) {
      setForm(initial);
      setError(null);
    }
  }, [open, initial]);

  // Fetch available levels when dialog opens
  useEffect(() => {
    if (!open) return;
    fetchWithSession(`${API_BASE_URL}/edit/levels`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setAvailableLevels(Array.isArray(rows) ? rows : []))
      .catch(() => setAvailableLevels([]));
  }, [open]);

  // Scroll to and highlight the first flagged field when the dialog opens
  useEffect(() => {
    if (!open || highlightFields.length === 0) return;
    const frame = requestAnimationFrame(() => {
      const el = dialogContentRef.current?.querySelector(
        `.gtfs-field-flagged`,
      );
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, highlightFields]);

  /**
   * Returns MUI TextField props that visually flag the field if its name is in
   * highlightFields. Adds the CSS animation class + warning styling.
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

  const dirty = useMemo(
    () =>
      isCreate
        ? form.stop_id.trim() !== "" || form.stop_name.trim() !== ""
        : Object.keys(initial).some((k) => form[k] !== initial[k]),
    [form, initial, isCreate],
  );

  const handleChange = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleClose = (_, reason) => {
    if (saving) return;
    if (dirty && reason === "backdropClick") return;
    onClose();
  };

  const handleSave = async () => {
    if (!isCreate && !stop) return;
    setSaving(true);
    setError(null);

    // Guard: stop_name required for public stops (location_type 0/1/2)
    if (stopNameMissing) {
      setError(t("edit.error.stopNameRequired"));
      setSaving(false);
      return;
    }

    // Validate lat/lon if provided
    if (form.stop_lat !== "") {
      const lat = parseFloat(form.stop_lat);
      if (Number.isNaN(lat) || lat < -90 || lat > 90) {
        setError(t("edit.stop.errorLat"));
        setSaving(false);
        return;
      }
    }
    if (form.stop_lon !== "") {
      const lon = parseFloat(form.stop_lon);
      if (Number.isNaN(lon) || lon < -180 || lon > 180) {
        setError(t("edit.stop.errorLon"));
        setSaving(false);
        return;
      }
    }

    let payload;
    if (isCreate) {
      if (!form.stop_id.trim()) {
        setError(t("edit.stop.stopIdRequired"));
        setSaving(false);
        return;
      }
      // Create mode: send all fields
      payload = {
        stop_id: form.stop_id.trim(),
        stop_name: form.stop_name,
        stop_code: form.stop_code,
        stop_desc: form.stop_desc,
        zone_id: form.zone_id,
        wheelchair_boarding: form.wheelchair_boarding,
        platform_code: form.platform_code,
        location_type: form.location_type !== "" ? Number(form.location_type) : 0,
        level_id: form.level_id,
        tts_stop_name: form.tts_stop_name,
        stop_url: form.stop_url,
        stop_timezone: form.stop_timezone,
        // Only forward stop_access if eligible — otherwise omit/null to avoid
        // STOP_ACCESS_FORBIDDEN from the backend.
        stop_access: isStopAccessAllowed ? form.stop_access : "",
      };
      if (form.stop_lat !== "") payload.stop_lat = parseFloat(form.stop_lat);
      if (form.stop_lon !== "") payload.stop_lon = parseFloat(form.stop_lon);
    } else {
      // Update mode: only changed fields
      payload = {};
      const textFields = [
        "stop_name",
        "stop_code",
        "stop_desc",
        "zone_id",
        "wheelchair_boarding",
        "platform_code",
        "level_id",
        "tts_stop_name",
        "stop_url",
        "stop_timezone",
        "stop_access",
      ];
      textFields.forEach((k) => {
        if (form[k] !== initial[k]) payload[k] = form[k];
      });
      if (form.location_type !== initial.location_type) {
        payload.location_type =
          form.location_type !== "" ? Number(form.location_type) : 0;
      }
      if (form.stop_lat !== initial.stop_lat) {
        payload.stop_lat =
          form.stop_lat !== "" ? parseFloat(form.stop_lat) : "";
      }
      if (form.stop_lon !== initial.stop_lon) {
        payload.stop_lon =
          form.stop_lon !== "" ? parseFloat(form.stop_lon) : "";
      }
      if (Object.keys(payload).length === 0) {
        onClose();
        setSaving(false);
        return;
      }
    }

    try {
      const url = isCreate
        ? `${API_BASE_URL}/edit/stops`
        : `${API_BASE_URL}/edit/stops/${encodeURIComponent(stop.stop_id)}`;
      const method = isCreate ? "POST" : "PATCH";
      const res = await fetchWithSession(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        // Map well-known backend error codes to i18n messages
        if (body.code === "STOP_NAME_REQUIRED") {
          setError(t("edit.error.stopNameRequired"));
        } else {
          setError(
            body.error + (body.details ? ` (${body.details.join(", ")})` : ""),
          );
        }
        setSaving(false);
        return;
      }
      if (!isCreate && body.stop) {
        patchStop({ ...body.stop, stop_id: stop.stop_id });
      }
      const toastKey = isDuplicate
        ? "edit.stop.duplicatedToast"
        : isCreate
          ? "edit.stop.createdToast"
          : "edit.stop.savedToast";
      const toastName = isCreate
        ? form.stop_name || form.stop_id
        : body.stop?.stop_name || stop.stop_name || stop.stop_id;
      recordEdit(t(toastKey, { name: toastName }), body.validation, {
        entity: "stop",
        entityId: isCreate ? payload.stop_id : stop.stop_id,
      });
      if (isCreate) {
        showToast(t("edit.stop.addedToTripsHint"), "info");
      }
      if (isCreate && onCreated) {
        onCreated({
          stop_id: payload.stop_id,
          stop_name: payload.stop_name,
          stop_lat: payload.stop_lat,
          stop_lon: payload.stop_lon,
        });
      }
      onClose();
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setSaving(false);
    }
  };

  if (!isCreate && !stop) return null;

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
            `3px solid ${isCreate ? theme.palette.success.main : theme.palette.warning.main}`,
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
                  ? isCreate
                    ? "rgba(46,125,50,0.18)"
                    : "rgba(237,108,2,0.18)"
                  : isCreate
                    ? "rgba(46,125,50,0.12)"
                    : "rgba(237,108,2,0.12)",
              color: isCreate ? "success.main" : "warning.main",
            }}
          >
            {isDuplicate ? (
              <ContentCopyIcon sx={{ fontSize: 18 }} />
            ) : isCreate ? (
              <AddLocationAltIcon sx={{ fontSize: 18 }} />
            ) : (
              <EditIcon sx={{ fontSize: 18 }} />
            )}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} lineHeight={1.2}>
              {t(
                isDuplicate
                  ? "edit.stop.duplicateTitle"
                  : isCreate
                    ? "edit.stop.createTitle"
                    : "edit.stop.dialogTitle",
              )}
            </Typography>
            {isDuplicate && stop && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  fontFamily: "monospace",
                  display: "block",
                  mt: 0.25,
                }}
              >
                {t("edit.stop.duplicateFrom", { id: stop.stop_id })}
              </Typography>
            )}
            {!isCreate && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  fontFamily: "monospace",
                  display: "block",
                  mt: 0.25,
                }}
              >
                {stop.stop_id}
              </Typography>
            )}
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
          {isCreate && (
            <TextField
              label={t("edit.stop.stopId")}
              value={form.stop_id}
              onChange={handleChange("stop_id")}
              fullWidth
              size="small"
              required
              autoFocus
              inputProps={{ style: { fontFamily: "monospace" } }}
              {...fieldProps("stop_id")}
            />
          )}
          <TextField
            label={t("edit.stop.name")}
            value={form.stop_name}
            onChange={handleChange("stop_name")}
            fullWidth
            size="small"
            required={stopNameRequired}
            autoFocus={!isCreate}
            inputProps={{ "data-testid": "stop-name-input" }}
            error={stopNameMissing}
            helperText={
              stopNameMissing ? t("edit.error.stopNameRequired") : undefined
            }
            {...fieldProps("stop_name")}
          />
          <TextField
            select
            label="location_type"
            value={form.location_type}
            onChange={handleChange("location_type")}
            fullWidth
            size="small"
            {...fieldProps("location_type")}
          >
            {LOCATION_TYPE_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value}>
                {t(o.labelKey)}
              </MenuItem>
            ))}
          </TextField>
          <Box display="flex" gap={2}>
            <TextField
              label={t("edit.stop.code")}
              value={form.stop_code}
              onChange={handleChange("stop_code")}
              size="small"
              sx={{ flex: 1 }}
              {...fieldProps("stop_code")}
            />
            <TextField
              label={t("edit.stop.zone")}
              value={form.zone_id}
              onChange={handleChange("zone_id")}
              size="small"
              sx={{ flex: 1 }}
              {...fieldProps("zone_id")}
            />
          </Box>
          <Box display="flex" gap={2}>
            <TextField
              label={t("edit.stop.lat")}
              value={form.stop_lat}
              onChange={handleChange("stop_lat")}
              size="small"
              type="number"
              inputProps={{ step: "0.000001" }}
              sx={{ flex: 1 }}
              {...fieldProps("stop_lat")}
            />
            <TextField
              label={t("edit.stop.lon")}
              value={form.stop_lon}
              onChange={handleChange("stop_lon")}
              size="small"
              type="number"
              inputProps={{ step: "0.000001" }}
              sx={{ flex: 1 }}
              {...fieldProps("stop_lon")}
            />
          </Box>
          <TextField
            label={t("edit.stop.desc")}
            value={form.stop_desc}
            onChange={handleChange("stop_desc")}
            size="small"
            multiline
            minRows={2}
            {...fieldProps("stop_desc")}
          />
          <Box display="flex" gap={2}>
            <TextField
              select
              label={t("edit.stop.wheelchair")}
              value={form.wheelchair_boarding}
              onChange={handleChange("wheelchair_boarding")}
              size="small"
              sx={{ flex: 1 }}
              {...fieldProps("wheelchair_boarding")}
            >
              {WHEELCHAIR_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label={t("edit.stop.platform")}
              value={form.platform_code}
              onChange={handleChange("platform_code")}
              size="small"
              sx={{ flex: 1 }}
              {...fieldProps("platform_code")}
            />
          </Box>

          {/* parent_station — read-only display so power users can see/copy the value
              and understand why stop_access may be disabled */}
          {form.parent_station && (
            <TextField
              label="parent_station"
              value={form.parent_station}
              size="small"
              fullWidth
              disabled
              inputProps={{ style: { fontFamily: "monospace" }, readOnly: true }}
              InputProps={{
                endAdornment: (
                  <Tooltip title={t("stats.copyRouteId")}>
                    <ContentCopyIcon
                      sx={{ fontSize: 16, cursor: "pointer", opacity: 0.5, mr: 0.5 }}
                      onClick={() => navigator.clipboard.writeText(form.parent_station)}
                    />
                  </Tooltip>
                ),
              }}
            />
          )}
          <TextField
            select
            label={t("edit.stop.stop_access.label")}
            value={form.stop_access}
            onChange={handleChange("stop_access")}
            size="small"
            fullWidth
            disabled={!isStopAccessAllowed}
            helperText={
              isStopAccessAllowed
                ? t("edit.stop.stop_access.help")
                : t("edit.stop.stop_access.disabled")
            }
            {...fieldProps("stop_access")}
          >
            {STOP_ACCESS_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value}>
                {t(o.labelKey)}
              </MenuItem>
            ))}
          </TextField>
          {stopAccessCleared && (
            <Alert
              severity="info"
              onClose={() => setStopAccessCleared(false)}
              sx={{ py: 0.5 }}
            >
              {t("edit.stop.stop_access.cleared")}
            </Alert>
          )}

          {/* GTFS v2.1 advanced fields */}
          <Accordion
            disableGutters
            elevation={0}
            sx={{
              border: (theme) =>
                `1px solid ${theme.palette.divider}`,
              borderRadius: "6px !important",
              "&:before": { display: "none" },
            }}
          >
            <AccordionSummary
              expandIcon={<ExpandMoreIcon />}
              sx={{ minHeight: 36, "& .MuiAccordionSummary-content": { my: 0.75 } }}
            >
              <Typography variant="caption" fontWeight={600} color="text.secondary">
                {t("editStop.sectionAdvanced")}
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0, pb: 1.5 }}>
              <Box display="flex" flexDirection="column" gap={2}>
                <Box>
                  <Autocomplete
                    freeSolo
                    size="small"
                    options={availableLevels}
                    getOptionLabel={(opt) =>
                      typeof opt === "string"
                        ? opt
                        : opt.level_name
                          ? `${opt.level_id} — ${opt.level_name}`
                          : opt.level_id
                    }
                    value={form.level_id || ""}
                    onChange={(_, newValue) => {
                      if (typeof newValue === "string") {
                        handleChange("level_id")({ target: { value: newValue } });
                      } else if (newValue?.level_id) {
                        handleChange("level_id")({ target: { value: newValue.level_id } });
                      } else {
                        handleChange("level_id")({ target: { value: "" } });
                      }
                    }}
                    onInputChange={(_, value) => {
                      handleChange("level_id")({ target: { value } });
                    }}
                    isOptionEqualToValue={(opt, val) => {
                      const optId = typeof opt === "string" ? opt : opt?.level_id;
                      const valId = typeof val === "string" ? val : val?.level_id;
                      return optId === valId;
                    }}
                    renderOption={(props, opt) => (
                      <li {...props} key={opt.level_id}>
                        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                          <LayersIcon sx={{ fontSize: 14, opacity: 0.5 }} />
                          <Typography variant="body2" fontFamily="monospace" fontSize={13}>
                            {opt.level_id}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {opt.level_name || `index ${opt.level_index}`}
                          </Typography>
                        </Box>
                      </li>
                    )}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="level_id"
                        size="small"
                        {...fieldProps("level_id")}
                        InputProps={{
                          ...params.InputProps,
                          endAdornment: (
                            <>
                              {params.InputProps.endAdornment}
                              <Tooltip title={t("editStop.levelCreateHint")}>
                                <InfoOutlinedIcon
                                  sx={{ fontSize: 16, opacity: 0.4, cursor: "help", ml: 0.5 }}
                                  onClick={() => openPanel("levels", "levels.txt")}
                                />
                              </Tooltip>
                            </>
                          ),
                          sx: { fontFamily: form.level_id ? "monospace" : "inherit" },
                        }}
                        helperText={
                          fieldProps("level_id")?.helperText ||
                          (availableLevels.length === 0
                            ? t("editStop.levelCreateHint")
                            : t("editStop.levelIdHelp"))
                        }
                      />
                    )}
                  />
                </Box>
                <TextField
                  label="tts_stop_name"
                  value={form.tts_stop_name}
                  onChange={handleChange("tts_stop_name")}
                  size="small"
                  fullWidth
                  helperText={t("editStop.ttsStopNameHelp")}
                  {...fieldProps("tts_stop_name")}
                />
                <TextField
                  label={t("edit.stop.url")}
                  value={form.stop_url}
                  onChange={handleChange("stop_url")}
                  size="small"
                  fullWidth
                  type="url"
                  helperText={t("edit.stop.url.help")}
                  inputProps={{ style: { fontFamily: "monospace" } }}
                  {...fieldProps("stop_url")}
                />
                <TextField
                  label={t("edit.stop.timezone")}
                  value={form.stop_timezone}
                  onChange={handleChange("stop_timezone")}
                  size="small"
                  fullWidth
                  helperText={t("edit.stop.timezone.help")}
                  inputProps={{ style: { fontFamily: "monospace" } }}
                  {...fieldProps("stop_timezone")}
                />
              </Box>
            </AccordionDetails>
          </Accordion>

          {/* Translations accordion — only in edit mode (record must already exist) */}
          {!isCreate && stop && (
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
                  tableName="stops"
                  recordId={stop.stop_id}
                  fields={STOP_TRANSLATABLE_FIELDS}
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
          color={isCreate ? "success" : "warning"}
          data-testid="stop-dialog-save"
          disabled={
            saving ||
            !dirty ||
            stopNameMissing ||
            (isCreate && !form.stop_id.trim())
          }
          startIcon={saving ? <CircularProgress size={14} /> : null}
        >
          {saving
            ? t("edit.saving")
            : isDuplicate
              ? t("edit.stop.duplicateBtn")
              : isCreate
                ? t("edit.stop.createButton")
                : t("app.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EditStopDialog;
