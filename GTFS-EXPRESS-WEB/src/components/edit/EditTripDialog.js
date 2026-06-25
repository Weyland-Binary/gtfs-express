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
  Autocomplete,
  Divider,
  InputAdornment,
  Accordion,
  AccordionSummary,
  AccordionDetails,
} from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import AddIcon from "@mui/icons-material/Add";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import GestureIcon from "@mui/icons-material/Gesture";
import Tooltip from "@mui/material/Tooltip";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TranslateIcon from "@mui/icons-material/Translate";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import EntityAutocomplete from "./EntityAutocomplete";
import TranslationsRecordPanel from "./TranslationsRecordPanel";

const TRIP_TRANSLATABLE_FIELDS = ["trip_headsign", "trip_short_name"];

const DIRECTION_OPTIONS = [
  { value: "", labelKey: "edit.trip.dirEmpty" },
  { value: "0", labelKey: "edit.trip.dir0" },
  { value: "1", labelKey: "edit.trip.dir1" },
];

const WHEELCHAIR_OPTIONS = [
  { value: "", labelKey: "edit.trip.wheelchairEmpty" },
  { value: "0", labelKey: "edit.trip.wheelchair0" },
  { value: "1", labelKey: "edit.trip.wheelchair1" },
  { value: "2", labelKey: "edit.trip.wheelchair2" },
];

const BIKES_OPTIONS = [
  { value: "", labelKey: "edit.trip.bikesEmpty" },
  { value: "0", labelKey: "edit.trip.bikes0" },
  { value: "1", labelKey: "edit.trip.bikes1" },
  { value: "2", labelKey: "edit.trip.bikes2" },
];

const CARS_ALLOWED_OPTIONS = [
  { value: "", labelKey: "edit.trip.cars_allowed.empty" },
  { value: "0", labelKey: "edit.trip.cars_allowed.0" },
  { value: "1", labelKey: "edit.trip.cars_allowed.1" },
  { value: "2", labelKey: "edit.trip.cars_allowed.2" },
];

const buildInitialForm = (trip) => ({
  trip_headsign: trip?.trip_headsign || "",
  trip_short_name: trip?.trip_short_name || "",
  direction_id: trip?.direction_id != null ? String(trip.direction_id) : "",
  wheelchair_accessible:
    trip?.wheelchair_accessible != null
      ? String(trip.wheelchair_accessible)
      : "",
  bikes_allowed: trip?.bikes_allowed != null ? String(trip.bikes_allowed) : "",
  cars_allowed: trip?.cars_allowed != null ? String(trip.cars_allowed) : "",
  block_id: trip?.block_id || "",
  shape_id: trip?.shape_id || "",
});

/**
 * EditTripDialog — CREATE / DUPLICATE / UPDATE trip.
 *
 * Props:
 *   open       — boolean
 *   trip       — existing trip object (null for pure create)
 *   onClose    — callback
 *   mode       — "edit" (default) | "create" | "duplicate"
 *   routeId    — required for create/duplicate (optional for edit, taken from trip)
 *   serviceId  — optional pre-fill for create mode
 *   onCreated  — callback(createdTrip) after successful CREATE/DUPLICATE
 */
function EditTripDialog({
  open,
  trip,
  onClose,
  mode: modeProp = "edit",
  routeId: routeIdProp,
  serviceId: serviceIdProp,
  onCreated,
  highlightFields = [],
}) {
  const { t } = useLanguage();
  const { recordEdit } = useEditMode();
  const dialogContentRef = useRef(null);
  const isCreate = modeProp === "create" || modeProp === "duplicate";
  const isDuplicate = modeProp === "duplicate";

  const effectiveRouteId = routeIdProp || trip?.route_id || "";

  const initial = useMemo(() => buildInitialForm(trip), [trip]);
  const [form, setForm] = useState(initial);
  const [tripId, setTripId] = useState("");
  const [routeId, setRouteId] = useState(effectiveRouteId);
  const [serviceId, setServiceId] = useState(
    serviceIdProp || trip?.service_id || "",
  );
  const [timeOffset, setTimeOffset] = useState(""); // minutes offset for duplicate
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [availableShapes, setAvailableShapes] = useState([]);
  const [shapesLoading, setShapesLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(initial);
      setError(null);
      setRouteId(effectiveRouteId);
      setServiceId(serviceIdProp || trip?.service_id || "");
      if (isDuplicate && trip) {
        setTripId(trip.trip_id + "_copy");
        setTimeOffset("");
      } else if (isCreate) {
        setTripId("");
        setTimeOffset("");
      }
    }
  }, [
    open,
    initial,
    isCreate,
    isDuplicate,
    trip,
    effectiveRouteId,
    serviceIdProp,
  ]);

  // Fetch available shapes for the route (with abort on stale requests)
  useEffect(() => {
    const rid = routeId || effectiveRouteId;
    if (!open || !rid) {
      setAvailableShapes([]);
      return;
    }
    const controller = new AbortController();
    setShapesLoading(true);
    fetchWithSession(
      `${API_BASE_URL}/shapes_for_route/${encodeURIComponent(rid)}`,
      { signal: controller.signal },
    )
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => setAvailableShapes(Array.isArray(data) ? data : []))
      .catch((err) => {
        if (err.name !== "AbortError") setAvailableShapes([]);
      })
      .finally(() => setShapesLoading(false));
    return () => controller.abort();
  }, [open, routeId, effectiveRouteId]);

  const dirty = useMemo(
    () => Object.keys(initial).some((k) => form[k] !== initial[k]),
    [form, initial],
  );

  const canSubmitCreate =
    tripId.trim().length > 0 &&
    routeId.trim().length > 0 &&
    serviceId.trim().length > 0;

  const handleChange = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleDrawShape = () => {
    if (!trip?.trip_id) return;
    const baseName = (
      trip.route_id ||
      effectiveRouteId ||
      "trip"
    )
      .toString()
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 32);
    const dirSuffix = form.direction_id || "0";
    const existing = new Set(availableShapes.map((s) => s.shape_id));
    let candidate = `shp_${baseName}_${dirSuffix}`;
    let suffix = 2;
    while (existing.has(candidate)) {
      candidate = `shp_${baseName}_${dirSuffix}_${suffix}`;
      suffix += 1;
    }
    setForm((f) => ({ ...f, shape_id: candidate }));
    window.dispatchEvent(
      new CustomEvent("createShape", {
        detail: {
          shapeId: candidate,
          initialPoints: [],
          linkTripIds: [trip.trip_id],
        },
      }),
    );
    onClose();
  };

  const handleClose = (_, reason) => {
    if (saving) return;
    if ((dirty || (isCreate && tripId)) && reason === "backdropClick") return;
    onClose();
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      if (isCreate) {
        // CREATE or DUPLICATE
        const payload = {
          trip_id: tripId.trim(),
          route_id: routeId.trim(),
          service_id: serviceId.trim(),
          trip_headsign: form.trip_headsign || null,
          trip_short_name: form.trip_short_name || null,
          direction_id: form.direction_id || null,
          wheelchair_accessible: form.wheelchair_accessible || null,
          bikes_allowed: form.bikes_allowed || null,
          cars_allowed: form.cars_allowed || null,
          block_id: form.block_id || null,
          shape_id: form.shape_id || null,
        };
        if (isDuplicate && trip) {
          payload._source_trip_id = trip.trip_id;
          if (timeOffset) {
            const offsetMin = parseFloat(timeOffset);
            if (Number.isNaN(offsetMin) || Math.abs(offsetMin) > 1440) {
              setError("Time offset must be between -1440 and +1440 minutes.");
              setSaving(false);
              return;
            }
            payload._time_offset_seconds = offsetMin * 60;
          }
        }

        const res = await fetchWithSession(`${API_BASE_URL}/edit/trips`, {
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
        const label = body.trip?.trip_headsign || body.trip?.trip_id || tripId;
        const toastKey = isDuplicate
          ? "edit.trip.duplicatedToast"
          : "edit.trip.createdToast";
        recordEdit(
          t(toastKey, {
            name: label,
            count: body.copied_stop_times || 0,
          }),
          body.validation,
          { entity: "trip", entityId: body.trip?.trip_id || tripId },
        );
        onCreated?.(body.trip);
        onClose();
      } else {
        // UPDATE
        if (!trip) return;
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
          `${API_BASE_URL}/edit/trips/${encodeURIComponent(trip.trip_id)}`,
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
          body.trip?.trip_headsign || trip.trip_headsign || trip.trip_id;
        recordEdit(t("edit.trip.savedToast", { name: label }), body.validation, {
          entity: "trip",
          entityId: trip.trip_id,
        });
        onClose();
      }
    } catch (err) {
      setError(err.message || "Network error");
    } finally {
      setSaving(false);
    }
  };

  // Determine dialog styling per mode
  const modeConfig = {
    edit: {
      icon: <EditIcon sx={{ fontSize: 18 }} />,
      color: "warning",
      borderColor: (th) => th.palette.warning.main,
      bgColor: (th) =>
        th.palette.mode === "dark"
          ? "rgba(237,108,2,0.18)"
          : "rgba(237,108,2,0.12)",
      title: t("edit.trip.dialogTitle"),
    },
    create: {
      icon: <AddIcon sx={{ fontSize: 18 }} />,
      color: "success",
      borderColor: (th) => th.palette.success.main,
      bgColor: (th) =>
        th.palette.mode === "dark"
          ? "rgba(46,125,50,0.18)"
          : "rgba(46,125,50,0.12)",
      title: t("edit.trip.createTitle"),
    },
    duplicate: {
      icon: <ContentCopyIcon sx={{ fontSize: 18 }} />,
      color: "info",
      borderColor: (th) => th.palette.info.main,
      bgColor: (th) =>
        th.palette.mode === "dark"
          ? "rgba(2,136,209,0.18)"
          : "rgba(2,136,209,0.12)",
      title: t("edit.trip.duplicateTitle"),
    },
  };
  const mc = modeConfig[modeProp] || modeConfig.edit;

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

  if (!isCreate && !trip) return null;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown={saving}
      PaperProps={{
        sx: {
          borderTop: (theme) => `3px solid ${mc.borderColor(theme)}`,
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
              background: (theme) => mc.bgColor(theme),
              color: `${mc.color}.main`,
            }}
          >
            {mc.icon}
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} lineHeight={1.2}>
              {mc.title}
            </Typography>
            {trip && !isCreate && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontFamily: "monospace", display: "block", mt: 0.25 }}
              >
                {trip.trip_id}
              </Typography>
            )}
            {isDuplicate && trip && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: "block", mt: 0.25 }}
              >
                {t("edit.trip.duplicateFrom", { id: trip.trip_id })}
              </Typography>
            )}
          </Box>
          {!isCreate && dirty && (
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
          {error && (
            <Alert severity="error" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          {/* CREATE-only fields */}
          {isCreate && (
            <>
              <TextField
                label={t("edit.trip.tripId")}
                value={tripId}
                onChange={(e) => setTripId(e.target.value)}
                size="small"
                fullWidth
                required
                helperText={t("edit.trip.tripIdHelp")}
                slotProps={{
                  htmlInput: { style: { fontFamily: "monospace" } },
                }}
              />
              <Box display="flex" gap={2}>
                <EntityAutocomplete
                  entity="route"
                  value={routeId}
                  onChange={(v) => setRouteId(v)}
                  label={t("edit.trip.routeId")}
                  required
                  size="small"
                  sx={{ flex: 1 }}
                />
                <EntityAutocomplete
                  entity="service"
                  value={serviceId}
                  onChange={(v) => setServiceId(v)}
                  label={t("edit.trip.serviceId")}
                  required
                  size="small"
                  sx={{ flex: 1 }}
                />
              </Box>
              {isDuplicate && (
                <TextField
                  label={t("edit.trip.timeOffset")}
                  value={timeOffset}
                  onChange={(e) => setTimeOffset(e.target.value)}
                  size="small"
                  fullWidth
                  type="number"
                  helperText={t("edit.trip.timeOffsetHelp")}
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end">min</InputAdornment>
                      ),
                    },
                  }}
                />
              )}
              <Divider />
            </>
          )}

          <TextField
            label={t("edit.trip.headsign")}
            value={form.trip_headsign}
            onChange={handleChange("trip_headsign")}
            size="small"
            fullWidth
            {...fieldProps("trip_headsign")}
          />
          <TextField
            label={t("edit.trip.shortName")}
            value={form.trip_short_name}
            onChange={handleChange("trip_short_name")}
            size="small"
            fullWidth
            {...fieldProps("trip_short_name")}
          />

          <Box display="flex" gap={2}>
            <TextField
              select
              label={t("edit.trip.direction")}
              value={form.direction_id}
              onChange={handleChange("direction_id")}
              size="small"
              fullWidth
              {...fieldProps("direction_id")}
            >
              {DIRECTION_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </MenuItem>
              ))}
            </TextField>
          </Box>

          <Box display="flex" gap={2}>
            <TextField
              select
              label={t("edit.trip.wheelchair")}
              value={form.wheelchair_accessible}
              onChange={handleChange("wheelchair_accessible")}
              size="small"
              fullWidth
              {...fieldProps("wheelchair_accessible")}
            >
              {WHEELCHAIR_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              label={t("edit.trip.bikes")}
              value={form.bikes_allowed}
              onChange={handleChange("bikes_allowed")}
              size="small"
              fullWidth
              {...fieldProps("bikes_allowed")}
            >
              {BIKES_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {t(o.labelKey)}
                </MenuItem>
              ))}
            </TextField>
          </Box>

          <TextField
            select
            label={t("edit.trip.cars_allowed.label")}
            value={form.cars_allowed}
            onChange={handleChange("cars_allowed")}
            size="small"
            fullWidth
            helperText={
              highlightFields.includes("cars_allowed")
                ? t("validation.fix.flagged")
                : t("edit.trip.cars_allowed.help")
            }
            FormHelperTextProps={
              highlightFields.includes("cars_allowed")
                ? { sx: { color: "warning.main", fontWeight: 600, fontSize: "0.72rem" } }
                : undefined
            }
            {...(highlightFields.includes("cars_allowed")
              ? { className: "gtfs-field-flagged", InputLabelProps: { sx: { color: "warning.main" } } }
              : {})}
          >
            {CARS_ALLOWED_OPTIONS.map((o) => (
              <MenuItem key={o.value} value={o.value}>
                {t(o.labelKey)}
              </MenuItem>
            ))}
          </TextField>

          <TextField
            label={t("edit.trip.blockId")}
            value={form.block_id}
            onChange={handleChange("block_id")}
            size="small"
            fullWidth
            helperText={
              highlightFields.includes("block_id")
                ? t("validation.fix.flagged")
                : t("edit.trip.blockIdHelp")
            }
            FormHelperTextProps={
              highlightFields.includes("block_id")
                ? { sx: { color: "warning.main", fontWeight: 600, fontSize: "0.72rem" } }
                : undefined
            }
            {...(highlightFields.includes("block_id")
              ? { className: "gtfs-field-flagged", InputLabelProps: { sx: { color: "warning.main" } } }
              : {})}
          />
          <Box display="flex" alignItems="stretch" gap={1}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
          <Autocomplete
            freeSolo
            options={availableShapes}
            getOptionLabel={(opt) =>
              typeof opt === "string" ? opt : opt.shape_id || ""
            }
            inputValue={form.shape_id}
            onInputChange={(_, value) =>
              setForm((f) => ({ ...f, shape_id: value }))
            }
            onChange={(_, value) => {
              const id =
                typeof value === "string" ? value : value?.shape_id || "";
              setForm((f) => ({ ...f, shape_id: id }));
            }}
            loading={shapesLoading}
            isOptionEqualToValue={(opt, val) =>
              (typeof opt === "string" ? opt : opt.shape_id) ===
              (typeof val === "string" ? val : val.shape_id)
            }
            renderInput={(params) => (
              <TextField
                {...params}
                label={t("edit.trip.shapeId")}
                size="small"
                fullWidth
                slotProps={{
                  input: {
                    ...params.InputProps,
                    endAdornment: (
                      <>
                        {shapesLoading && <CircularProgress size={16} />}
                        {params.InputProps.endAdornment}
                      </>
                    ),
                  },
                }}
              />
            )}
            renderOption={(props, option) => {
              const { key, ...rest } = props;
              return (
                <li key={option.shape_id} {...rest}>
                  <Box sx={{ py: 0.25 }}>
                    <Typography
                      variant="body2"
                      fontWeight={
                        option.shape_id === initial.shape_id ? 700 : 500
                      }
                      sx={{ fontFamily: "monospace", fontSize: 13 }}
                    >
                      {option.shape_id}
                      {option.shape_id === initial.shape_id && (
                        <Chip
                          label={t("edit.trip.shapeCurrent")}
                          size="small"
                          color="info"
                          sx={{
                            ml: 1,
                            height: 18,
                            fontSize: 9,
                            fontWeight: 700,
                          }}
                        />
                      )}
                    </Typography>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ display: "block", mt: 0.25 }}
                    >
                      {option.point_count} {t("edit.trip.shapePoints")} ·{" "}
                      {option.trip_count} {t("edit.trip.shapeTrips")}
                      {option.directions?.length > 0 &&
                        ` · dir ${option.directions.join(", ")}`}
                    </Typography>
                  </Box>
                </li>
              );
            }}
          />
            </Box>
            {!isCreate && trip?.trip_id && (
              <Tooltip title={t("edit.trip.drawShapeTooltip")} arrow>
                <span>
                  <Button
                    variant="outlined"
                    color="success"
                    size="small"
                    onClick={handleDrawShape}
                    disabled={!!form.shape_id?.trim()}
                    startIcon={<GestureIcon sx={{ fontSize: 16 }} />}
                    sx={{
                      whiteSpace: "nowrap",
                      fontSize: 11,
                      fontWeight: 700,
                      textTransform: "none",
                      minWidth: "auto",
                    }}
                  >
                    {t("edit.trip.drawShape")}
                  </Button>
                </span>
              </Tooltip>
            )}
          </Box>
        {/* Translations accordion — only in edit mode */}
        {!isCreate && trip?.trip_id && (
          <Accordion
            disableGutters
            elevation={0}
            sx={{
              border: (theme) => `1px solid ${theme.palette.divider}`,
              borderRadius: "6px !important",
              "&:before": { display: "none" },
              mt: 1,
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
                tableName="trips"
                recordId={trip.trip_id}
                fields={TRIP_TRANSLATABLE_FIELDS}
              />
            </AccordionDetails>
          </Accordion>
        )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} disabled={saving} color="inherit">
          {t("app.cancel")}
        </Button>
        <Button
          onClick={handleSave}
          variant="contained"
          color={mc.color}
          disabled={saving || (isCreate ? !canSubmitCreate : !dirty)}
          startIcon={saving ? <CircularProgress size={16} /> : null}
        >
          {isCreate ? t("edit.trip.createBtn") : t("app.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default EditTripDialog;
