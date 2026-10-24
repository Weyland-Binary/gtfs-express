import React, { useState, useEffect, useMemo, useCallback } from "react";
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
  Autocomplete,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  InputAdornment,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import AddLocationAltIcon from "@mui/icons-material/AddLocationAlt";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import PlaceIcon from "@mui/icons-material/Place";
import LoginIcon from "@mui/icons-material/Login";
import LogoutIcon from "@mui/icons-material/Logout";
import VerticalAlignTopIcon from "@mui/icons-material/VerticalAlignTop";
import VerticalAlignBottomIcon from "@mui/icons-material/VerticalAlignBottom";
import LinearScaleIcon from "@mui/icons-material/LinearScale";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useEditMode } from "../../contexts/EditModeContext";
import { useLanguage } from "../../contexts/LanguageContext";
import { readJson } from "../../utils/apiRequest";
import { humanError } from "../../utils/humanError";
import { gtfsTimeToSeconds, secondsToGtfsTime, shareAlong, timeBetween } from "../../utils/gtfsTime";
import { shapeDistWithin } from "../../utils/shapeGeometry";

// A stop farther than this from the trip's shape is not placed on it.
const SHAPE_OFF_M = 50;
const finite = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * The time to propose for a stop inserted between prev and next: where it lies on the trip's shape when the two
 * calls and the shape carry shape_dist_traveled, else null (the caller keeps the midpoint).
 */
export const timeOnShape = (prev, next, stop, tripShape) => {
  const lat = finite(stop?.stop_lat);
  const lon = finite(stop?.stop_lon);
  if (!prev || !next || !tripShape || lat == null || lon == null) return null;
  const a = tripShape.dists.get(Number(prev.stop_sequence));
  const b = tripShape.dists.get(Number(next.stop_sequence));
  const d = a != null && b != null && b > a ? shapeDistWithin({ lat, lon }, tripShape.points, a, b, SHAPE_OFF_M) : null;
  const share = d != null ? shareAlong(a, b, d) : null;
  return share != null ? timeBetween(prev.departure_time || prev.arrival_time, next.arrival_time || next.departure_time, share) : null;
};

const POS_AT_START = "__at_start__";
const POS_AT_END = "__at_end__";

const buildPositionOptions = (existingStopTimes, stopsMap, t) => {
  const options = [];

  if (existingStopTimes.length === 0) {
    options.push({ value: POS_AT_END, label: t("schedule.insertStop.atEnd"), interpolatedTime: null });
    return options;
  }

  const first = existingStopTimes[0];
  const last = existingStopTimes[existingStopTimes.length - 1];

  options.push({
    value: POS_AT_START,
    label: t("schedule.insertStop.atStart"),
    nextStop: first,
    interpolatedTime:
      first.arrival_time
        ? secondsToGtfsTime(Math.max(0, gtfsTimeToSeconds(first.arrival_time) - 60))
        : null,
  });

  for (let i = 0; i < existingStopTimes.length - 1; i++) {
    const prev = existingStopTimes[i];
    const next = existingStopTimes[i + 1];
    const prevName = stopsMap[prev.stop_id]?.stop_name || prev.stop_id;
    const nextName = stopsMap[next.stop_id]?.stop_name || next.stop_id;
    options.push({
      value: `between_${i}`,
      label: t("schedule.insertStop.between", { from: prevName, to: nextName }),
      prevStop: prev,
      nextStop: next,
      interpolatedTime: timeBetween(
        prev.departure_time || prev.arrival_time,
        next.arrival_time || next.departure_time,
      ),
    });
  }

  options.push({
    value: POS_AT_END,
    label: t("schedule.insertStop.atEnd"),
    prevStop: last,
    interpolatedTime:
      last.departure_time
        ? secondsToGtfsTime(gtfsTimeToSeconds(last.departure_time) + 60)
        : null,
  });

  return options;
};

/** The stop_sequence of the chosen position: the API shifts the following sequences itself. */
const computeStopSequence = (positionValue, existingStopTimes) => {
  if (existingStopTimes.length === 0) return 1;

  const sorted = [...existingStopTimes].sort(
    (a, b) => a.stop_sequence - b.stop_sequence,
  );
  const minSeq = sorted[0].stop_sequence;
  const maxSeq = sorted[sorted.length - 1].stop_sequence;

  if (positionValue === POS_AT_START) {
    return minSeq;
  }
  if (positionValue === POS_AT_END) {
    return maxSeq + 1;
  }
  // "between_i": after sorted[i].
  const idx = parseInt(positionValue.replace("between_", ""), 10);
  if (isNaN(idx) || idx < 0 || idx >= sorted.length - 1) {
    return maxSeq + 1;
  }
  return sorted[idx].stop_sequence + 1;
};

const TIME_REGEX = /^\d{1,2}:\d{2}:\d{2}$/;

const positionIcon = (value) => {
  if (value === POS_AT_START) return <VerticalAlignTopIcon sx={{ fontSize: 15, opacity: 0.7 }} />;
  if (value === POS_AT_END)   return <VerticalAlignBottomIcon sx={{ fontSize: 15, opacity: 0.7 }} />;
  return <LinearScaleIcon sx={{ fontSize: 15, opacity: 0.7 }} />;
};
const isValidTime = (v) => !v || TIME_REGEX.test(v);

/** Insert a stop_time into an existing trip. */
function InsertStopDialog({
  open,
  onClose,
  tripId,
  tripLabel,
  existingStopTimes = [],
  stopsMap = {},
  // Optional: without it the stop list is loaded when the dialog opens, not by the app on every dataVersion bump.
  allStops: allStopsProp,
}) {
  const { t } = useLanguage();
  const { recordEdit, dataVersion } = useEditMode();

  const [fetchedStops, setFetchedStops] = useState(null);
  const [stopsLoading, setStopsLoading] = useState(false);

  const allStops = allStopsProp || fetchedStops || [];

  useEffect(() => {
    if (!open) return undefined;
    if (allStopsProp && allStopsProp.length > 0) return undefined;
    // Re-fetched on dataVersion so a stop just created shows up without reopening.
    let cancelled = false;
    const controller = new AbortController();
    setStopsLoading(true);
    fetchWithSession(`${API_BASE_URL}/stops/all`, { signal: controller.signal })
      .then((r) => readJson(r))
      .then((body) => {
        if (cancelled) return;
        setFetchedStops(body?.stops || []);
      })
      .catch((err) => {
        if (cancelled || err.name === "AbortError") return;
        // An empty picker would read as a network without stops: the failure is said.
        console.warn("InsertStopDialog: /stops/all fetch failed", err);
        setError(humanError(err, t)?.message || t("error.human.unknown"));
      })
      .finally(() => {
        if (!cancelled) setStopsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, allStopsProp, dataVersion]);

  // The trip's shape with its distances, to time a stop by where it lies on it (shape_dist_traveled).
  const [tripShape, setTripShape] = useState(null);
  useEffect(() => {
    if (!open || !tripId) return undefined;
    let cancelled = false;
    setTripShape(null);
    fetchWithSession(`${API_BASE_URL}/trip_detail/${encodeURIComponent(tripId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled || !body) return;
        const points = (body.shape || []).map(([lat, lon], i) => ({ lat, lon, dist: finite(body.shape_dist?.[i]) ?? NaN }));
        const dists = new Map((body.stop_sequence || []).map((r) => [Number(r.stop_sequence), finite(r.shape_dist_traveled)]));
        setTripShape({ points, dists });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, tripId, dataVersion]);

  const [selectedStop, setSelectedStop] = useState(null);
  const [positionValue, setPositionValue] = useState("");
  const [arrivalTime, setArrivalTime] = useState("");
  const [departureTime, setDepartureTime] = useState("");
  const [arrivalInterpolated, setArrivalInterpolated] = useState(false);
  const [departureInterpolated, setDepartureInterpolated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const sortedExisting = useMemo(
    () =>
      [...existingStopTimes].sort((a, b) => a.stop_sequence - b.stop_sequence),
    [existingStopTimes],
  );

  // Stops already in the trip, marked but not filtered out: a stop_id may appear several times (loops).
  const existingStopIds = useMemo(
    () => new Set(sortedExisting.map((st) => st.stop_id)),
    [sortedExisting],
  );

  const positionOptions = useMemo(
    () => buildPositionOptions(sortedExisting, stopsMap, t),
    [sortedExisting, stopsMap, t],
  );

  useEffect(() => {
    if (open) {
      setSelectedStop(null);
      setPositionValue(positionOptions[0]?.value || POS_AT_END);
      setArrivalTime("");
      setDepartureTime("");
      setArrivalInterpolated(false);
      setDepartureInterpolated(false);
      setError(null);
    } else {
      // The cached list is purged so the next open fetches fresh data.
      setFetchedStops(null);
    }
    // Only on `open`: resetting on every positionOptions rebuild would fight the person's own choice.
  }, [open]); // eslint-disable-line

  const suggestion = useMemo(() => {
    const opt = positionOptions.find((o) => o.value === positionValue);
    if (!opt) return null;
    return timeOnShape(opt.prevStop, opt.nextStop, selectedStop, tripShape) || opt.interpolatedTime || null;
  }, [positionOptions, positionValue, selectedStop, tripShape]);

  // A new position always proposes its time; a new stop or the shape arriving only replaces a proposed one.
  useEffect(() => {
    if (!open) return;
    const suggested = suggestion || "";
    setArrivalTime(suggested);
    setDepartureTime(suggested);
    setArrivalInterpolated(Boolean(suggested));
    setDepartureInterpolated(Boolean(suggested));
  }, [positionValue, positionOptions, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || !suggestion) return;
    if (arrivalInterpolated) setArrivalTime(suggestion);
    if (departureInterpolated) setDepartureTime(suggestion);
  }, [suggestion]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleArrivalChange = useCallback((e) => {
    setArrivalTime(e.target.value);
    setArrivalInterpolated(false);
  }, []);

  const handleDepartureChange = useCallback((e) => {
    setDepartureTime(e.target.value);
    setDepartureInterpolated(false);
  }, []);

  const handleClose = useCallback(
    (_, reason) => {
      if (saving) return;
      if (reason === "backdropClick" && selectedStop) return;
      onClose();
    },
    [saving, selectedStop, onClose],
  );

  const canInsert =
    selectedStop != null &&
    positionValue !== "" &&
    isValidTime(arrivalTime) &&
    isValidTime(departureTime);

  const handleInsert = useCallback(async () => {
    if (!canInsert || saving) return;
    setSaving(true);
    setError(null);

    const seq = computeStopSequence(positionValue, sortedExisting);
    const stopName =
      stopsMap[selectedStop.stop_id]?.stop_name || selectedStop.stop_id;
    const label = tripLabel || tripId;

    const payload = {
      trip_id: tripId,
      stop_id: selectedStop.stop_id,
      stop_sequence: seq,
    };
    if (arrivalTime) payload.arrival_time = arrivalTime;
    if (departureTime) payload.departure_time = departureTime;

    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/stop_times/insert`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const body = await res.json();
      if (!res.ok) {
        setError(
          t("schedule.insertStop.insertError", {
            error: body.error || res.statusText,
          }),
        );
        return;
      }
      recordEdit(
        t("schedule.insertStop.insertedToast", {
          stop: stopName,
          trip: label,
          seq,
        }),
        body.validation,
        { entity: "stop_time", entityId: `${tripId}:${seq}` },
      );
      onClose();
    } catch (err) {
      setError(
        t("schedule.insertStop.insertError", { error: err.message || "Network error" }),
      );
    } finally {
      setSaving(false);
    }
  }, [
    canInsert,
    saving,
    positionValue,
    sortedExisting,
    stopsMap,
    selectedStop,
    tripLabel,
    tripId,
    arrivalTime,
    departureTime,
    t,
    recordEdit,
    onClose,
  ]);

  const displayLabel = tripLabel || tripId;

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      maxWidth="md"
      fullWidth
      disableEscapeKeyDown={saving}
      PaperProps={{
        sx: {
          borderTop: (theme) => `3px solid ${theme.palette.success.main}`,
          borderRadius: 2,
        },
      }}
    >
      <DialogTitle sx={{ pb: 0.75 }}>
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
                alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.18 : 0.12),
              color: "success.main",
              flexShrink: 0,
            }}
          >
            <AddLocationAltIcon sx={{ fontSize: 18 }} />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={700} lineHeight={1.2}>
              {t("schedule.insertStop.title")}
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mt: 0.25, flexWrap: "wrap" }}>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
                {tripId}
              </Typography>
              {displayLabel !== tripId && (
                <Chip label={displayLabel} size="small" sx={{ height: 18, fontSize: "0.68rem" }} />
              )}
              <Chip
                icon={<ContentCopyIcon sx={{ fontSize: "12px !important" }} />}
                label={tripId}
                size="small"
                onClick={() => navigator.clipboard.writeText(tripId)}
                sx={{ height: 18, fontSize: "0.68rem", cursor: "pointer" }}
              />
            </Box>
          </Box>
        </Box>
      </DialogTitle>

      <DialogContent dividers sx={{ py: 2 }}>
        <Box display="flex" flexDirection="column" gap={2}>
          {error && (
            <Alert severity="error" size="small" onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <Autocomplete
            options={allStops}
            value={selectedStop}
            onChange={(_, v) => setSelectedStop(v)}
            loading={stopsLoading}
            getOptionLabel={(o) =>
              o ? `${o.stop_name || o.stop_id} (${o.stop_id})` : ""
            }
            isOptionEqualToValue={(o, v) => o.stop_id === v.stop_id}
            noOptionsText={t("schedule.insertStop.noStops")}
            renderInput={(params) => (
              <TextField
                {...params}
                label={t("schedule.insertStop.pickStop")}
                placeholder={t("schedule.insertStop.pickStopPlaceholder")}
                size="small"
                required
              />
            )}
            renderOption={(props, option) => {
              const alreadyIn = existingStopIds.has(option.stop_id);
              return (
                <Box component="li" {...props} sx={{ ...props.sx, alignItems: "flex-start !important" }}>
                  <PlaceIcon sx={{ fontSize: 16, color: alreadyIn ? "success.main" : "text.disabled", mt: 0.3, mr: 1, flexShrink: 0 }} />
                  <Box sx={{ flex: 1, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1 }}>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="body2" noWrap>{option.stop_name || option.stop_id}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
                        {option.stop_id}
                        {option.stop_lat && option.stop_lon
                          ? ` · ${parseFloat(option.stop_lat).toFixed(5)}, ${parseFloat(option.stop_lon).toFixed(5)}`
                          : ""}
                      </Typography>
                    </Box>
                    {alreadyIn && (
                      <Chip
                        label={t("schedule.insertStop.alreadyInTrip")}
                        size="small"
                        sx={{ height: 16, fontSize: "0.62rem", opacity: 0.7, flexShrink: 0 }}
                      />
                    )}
                  </Box>
                </Box>
              );
            }}
          />

          {selectedStop && (
            <Box
              sx={{
                px: 1.5, py: 0.75,
                borderRadius: 1.5,
                background: (theme) => alpha(theme.palette.success.main, 0.06),
                border: (theme) => `1px solid ${alpha(theme.palette.success.main, 0.2)}`,
                display: "flex", alignItems: "center", gap: 2, flexWrap: "wrap",
              }}
            >
              <MyLocationIcon sx={{ fontSize: 14, color: "success.main", flexShrink: 0 }} />
              <Typography variant="caption" fontWeight={600} sx={{ fontFamily: "monospace" }}>
                {selectedStop.stop_id}
              </Typography>
              {selectedStop.stop_code && (
                <Typography variant="caption" color="text.secondary">
                  code&nbsp;<Box component="span" sx={{ fontFamily: "monospace" }}>{selectedStop.stop_code}</Box>
                </Typography>
              )}
              {selectedStop.stop_lat && selectedStop.stop_lon && (
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
                  {parseFloat(selectedStop.stop_lat).toFixed(6)}, {parseFloat(selectedStop.stop_lon).toFixed(6)}
                </Typography>
              )}
              {selectedStop.stop_desc && (
                <Typography variant="caption" color="text.secondary" sx={{ fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}>
                  {selectedStop.stop_desc}
                </Typography>
              )}
            </Box>
          )}

          <Box
            display="grid"
            gridTemplateColumns="2fr 1fr 1fr"
            gap={1.5}
            alignItems="flex-start"
          >
            <FormControl size="small" fullWidth>
              <InputLabel>{t("schedule.insertStop.position")}</InputLabel>
              <Select
                value={positionValue}
                label={t("schedule.insertStop.position")}
                onChange={(e) => setPositionValue(e.target.value)}
                MenuProps={{ PaperProps: { sx: { maxHeight: 320 } } }}
              >
                {positionOptions.map((opt) => (
                  <MenuItem key={opt.value} value={opt.value}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      {positionIcon(opt.value)}
                      <Typography variant="body2">{opt.label}</Typography>
                    </Box>
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <TextField
              label={t("schedule.insertStop.arrivalTime")}
              value={arrivalTime}
              onChange={handleArrivalChange}
              size="small"
              placeholder="HH:MM:SS"
              error={arrivalTime !== "" && !isValidTime(arrivalTime)}
              helperText={
                arrivalTime !== "" && !isValidTime(arrivalTime)
                  ? "HH:MM:SS"
                  : arrivalInterpolated
                  ? t("schedule.insertStop.interpolated")
                  : " "
              }
              slotProps={{ htmlInput: { style: { fontFamily: "monospace" } } }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <LoginIcon sx={{ fontSize: 15, color: "text.disabled" }} />
                  </InputAdornment>
                ),
              }}
            />

            <TextField
              label={t("schedule.insertStop.departureTime")}
              value={departureTime}
              onChange={handleDepartureChange}
              size="small"
              placeholder="HH:MM:SS"
              error={departureTime !== "" && !isValidTime(departureTime)}
              helperText={
                departureTime !== "" && !isValidTime(departureTime)
                  ? "HH:MM:SS"
                  : departureInterpolated
                  ? t("schedule.insertStop.interpolated")
                  : " "
              }
              slotProps={{ htmlInput: { style: { fontFamily: "monospace" } } }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <LogoutIcon sx={{ fontSize: 15, color: "text.disabled" }} />
                  </InputAdornment>
                ),
              }}
            />
          </Box>
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} disabled={saving} size="small">
          {t("app.cancel")}
        </Button>
        <Button
          variant="contained"
          color="success"
          onClick={handleInsert}
          disabled={!canInsert || saving}
          size="small"
          startIcon={
            saving ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <AddLocationAltIcon sx={{ fontSize: 16 }} />
            )
          }
        >
          {saving ? t("app.saving") : t("schedule.insertStop.insert")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default InsertStopDialog;
