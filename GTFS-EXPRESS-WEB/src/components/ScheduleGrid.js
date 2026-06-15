import React, {
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  memo,
} from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import Tooltip from "@mui/material/Tooltip";
import Snackbar from "@mui/material/Snackbar";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import { Typography, Chip, useTheme } from "@mui/material";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import "./GTFSApp.css";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import PhoneIcon from "@mui/icons-material/Phone";
import TransferWithinAStationIcon from "@mui/icons-material/TransferWithinAStation";
import BlockIcon from "@mui/icons-material/Block";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import AddLocationAltIcon from "@mui/icons-material/AddLocationAlt";
import KeyboardArrowLeftIcon from "@mui/icons-material/KeyboardArrowLeft";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";
import FirstPageIcon from "@mui/icons-material/FirstPage";
import LastPageIcon from "@mui/icons-material/LastPage";
import Stack from "@mui/material/Stack";
import { useDetailPanel } from "../contexts/DetailPanelContext";
import { useLanguage } from "../contexts/LanguageContext";
import { useEditMode } from "../contexts/EditModeContext";
import Popover from "@mui/material/Popover";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import DeleteIcon from "@mui/icons-material/Delete";
import API_BASE_URL from "../config";
import { fetchWithSession } from "../utils/sessionManager";
import InsertStopDialog from "./edit/InsertStopDialog";
import EditStopTimeDialog from "./edit/EditStopTimeDialog";

// ── Segmented time input (HH:MM:SS with fixed colons) ──────────────────────
// GTFS times support hours > 23 (e.g. 25:30:00 for next-day service).
// Each segment is a tiny input; focus auto-advances on 2-digit entry.
// Internal state avoids the round-trip normalization bug (padStart destroying partial input).

const SEG_STYLE = {
  width: 26,
  textAlign: "center",
  fontFamily: "'Roboto Mono', 'Consolas', monospace",
  fontSize: "0.9rem",
  fontWeight: 400,
  border: "none",
  outline: "none",
  background: "transparent",
  padding: "5px 0",
  caretColor: "auto",
};

const COLON_STYLE = {
  fontFamily: "'Roboto Mono', 'Consolas', monospace",
  fontSize: "0.9rem",
  fontWeight: 400,
  opacity: 0.3,
  userSelect: "none",
  lineHeight: "32px",
};

const parseTime = (v) => {
  if (!v) return ["", "", ""];
  const parts = v.split(":");
  return [parts[0] || "", parts[1] || "", parts[2] || ""];
};

const assembleTime = (segs) => {
  if (!segs[0] && !segs[1] && !segs[2]) return "";
  return `${(segs[0] || "0").padStart(2, "0")}:${(segs[1] || "0").padStart(2, "0")}:${(segs[2] || "0").padStart(2, "0")}`;
};

const TimeInput = React.memo(({ label, value, onChange, onEnter, onEscape, autoFocus, theme }) => {
  const isDark = theme.palette.mode === "dark";
  const refs = [useRef(null), useRef(null), useRef(null)];

  // Internal state — NOT derived from parent value on every render
  const [segs, setSegs] = useState(() => parseTime(value));
  const internalRef = useRef(false); // true when change originates from typing

  // Sync from parent only on external changes (e.g. "Copy arrival → departure")
  React.useEffect(() => {
    if (internalRef.current) {
      internalRef.current = false;
      return;
    }
    setSegs(parseTime(value));
  }, [value]);

  const handleChange = useCallback((idx, rawVal) => {
    const digits = rawVal.replace(/\D/g, "").slice(0, 2);
    let clamped = digits;
    if (idx > 0 && clamped.length === 2) {
      const num = parseInt(clamped, 10);
      if (num > 59) clamped = "59";
    }
    setSegs((prev) => {
      const next = [...prev];
      next[idx] = clamped;
      internalRef.current = true;
      onChange(assembleTime(next));
      return next;
    });
    if (clamped.length === 2 && idx < 2) {
      setTimeout(() => {
        refs[idx + 1].current?.focus();
        refs[idx + 1].current?.select();
      }, 0);
    }
  }, [onChange, refs]);

  const handleKeyDown = useCallback((idx, e) => {
    if (e.key === "Enter") { e.preventDefault(); onEnter?.(); return; }
    if (e.key === "Escape") { e.preventDefault(); onEscape?.(); return; }
    if (e.key === "ArrowRight" && idx < 2) {
      const input = e.target;
      if (input.selectionStart === input.value.length) {
        e.preventDefault();
        refs[idx + 1].current?.focus();
        refs[idx + 1].current?.setSelectionRange(0, 0);
      }
    }
    if (e.key === "ArrowLeft" && idx > 0) {
      const input = e.target;
      if (input.selectionStart === 0) {
        e.preventDefault();
        const prev = refs[idx - 1].current;
        prev?.focus();
        prev?.setSelectionRange(prev.value.length, prev.value.length);
      }
    }
    if (e.key === "Backspace" && idx > 0) {
      const input = e.target;
      if (input.selectionStart === 0 && input.selectionEnd === 0) {
        e.preventDefault();
        refs[idx - 1].current?.focus();
      }
    }
  }, [onEnter, refs]);

  const handleFocus = useCallback((e) => e.target.select(), []);

  const borderColor = isDark ? "rgba(255,255,255,0.23)" : "rgba(0,0,0,0.23)";
  const focusBorder = theme.palette.primary.main;

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
      <Typography
        variant="caption"
        sx={{ color: "text.secondary", fontSize: "0.72rem", minWidth: 28 }}
      >
        {label}
      </Typography>
      <Box
        sx={{
          display: "inline-flex",
          alignItems: "center",
          borderBottom: `1.5px solid ${borderColor}`,
          pb: "2px",
          transition: "border-color 0.15s",
          "&:focus-within": { borderColor: focusBorder },
        }}
      >
        {[0, 1, 2].map((idx) => (
          <React.Fragment key={idx}>
            {idx > 0 && <span style={COLON_STYLE}>:</span>}
            <input
              ref={refs[idx]}
              value={segs[idx]}
              onChange={(e) => handleChange(idx, e.target.value)}
              onKeyDown={(e) => handleKeyDown(idx, e)}
              onFocus={handleFocus}
              placeholder={["HH", "MM", "SS"][idx]}
              maxLength={2}
              autoFocus={autoFocus && idx === 0}
              style={{
                ...SEG_STYLE,
                color: isDark ? "rgba(255,255,255,0.87)" : "rgba(0,0,0,0.87)",
              }}
              inputMode="numeric"
              aria-label={`${label} ${["hours", "minutes", "seconds"][idx]}`}
            />
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
});

// Returns true if at least one time has non-zero seconds
const hasNonZeroSeconds = (times) =>
  times.some((t) => {
    if (!t) return false;
    const parts = t.split(":");
    return parts.length === 3 && parts[2] !== "00";
  });

// Renders HH:MM or HH:MM:SS depending on the showSeconds flag
const formatTime = (time, showSeconds) => {
  if (!time) return "";
  const parts = time.split(":");
  if (!showSeconds && parts.length === 3 && parts[2] === "00")
    return `${parts[0]}:${parts[1]}`;
  return time;
};

// ----------------------------------------------------------------------
// Compute the master ordering using a reference trip (the longest trip)
// ----------------------------------------------------------------------
const computeMasterStopOrderFromReference = (stopTimes) => {
  const tripsMap = {}; // trip_id -> array of { stop_id, stop_sequence }
  const unionStops = new Set();

  // For each record, we build the list of stops per trip
  stopTimes.forEach((stopTime) => {
    const seq = parseInt(stopTime.stop_sequence, 10);
    unionStops.add(stopTime.stop_id);
    if (!isNaN(seq)) {
      if (!tripsMap[stopTime.trip_id]) {
        tripsMap[stopTime.trip_id] = [];
      }
      tripsMap[stopTime.trip_id].push({
        stop_id: stopTime.stop_id,
        stop_sequence: seq,
      });
    }
  });

  // Select the trip with the largest number of stops
  let referenceTripId = null;
  let maxCount = 0;
  for (const tripId in tripsMap) {
    if (tripsMap[tripId].length > maxCount) {
      maxCount = tripsMap[tripId].length;
      referenceTripId = tripId;
    }
  }

  let masterOrder = [];
  if (referenceTripId) {
    // Sort the reference trip stops by stop_sequence
    const refStops = tripsMap[referenceTripId].sort(
      (a, b) => a.stop_sequence - b.stop_sequence,
    );
    masterOrder = refStops.map((item) => item.stop_id);
  }

  // Fill in with all stops that appear elsewhere but not in the reference trip
  unionStops.forEach((stop_id) => {
    if (!masterOrder.includes(stop_id)) {
      masterOrder.push(stop_id);
    }
  });

  return masterOrder;
};

// ----------------------------------------------------------------------
// Build a lookup grid for stop_times : grid[stop_id].times[trip_id] = array of timeInfo
// ----------------------------------------------------------------------
const transformStopTimesToGrid = (stopTimes) => {
  const grid = {};
  stopTimes.forEach((stopTime) => {
    if (!grid[stopTime.stop_id]) {
      grid[stopTime.stop_id] = { times: {} };
    }
    if (!grid[stopTime.stop_id].times[stopTime.trip_id]) {
      grid[stopTime.stop_id].times[stopTime.trip_id] = [];
    }
    grid[stopTime.stop_id].times[stopTime.trip_id].push({
      arrival_time: stopTime.arrival_time,
      departure_time: stopTime.departure_time,
      stop_sequence: stopTime.stop_sequence,
      pickup_type:
        stopTime.pickup_type !== undefined
          ? stopTime.pickup_type
          : stopTime.pickupType,
      start_pickup_drop_off_window:
        stopTime.start_pickup_drop_off_window !== undefined
          ? stopTime.start_pickup_drop_off_window
          : stopTime.startPickupDropOffWindow,
      end_pickup_drop_off_window:
        stopTime.end_pickup_drop_off_window !== undefined
          ? stopTime.end_pickup_drop_off_window
          : stopTime.endPickupDropOffWindow,
    });
  });
  return grid;
};

// ── Trip column pagination (top-level so the array reference is stable) ────
// PrimeReact does NOT virtualize columns. Past ~200 columns the schedule
// grid takes seconds to render and freezes the main thread, so we default
// to a small window. The "all" option lets a power user override this when
// the feed is small enough to handle, but it is intentionally NOT the
// default and it is reset to TRIP_PAGE_DEFAULT_SIZE every time the
// underlying dataset changes, to avoid carrying it across to a much
// larger route.
const TRIP_PAGE_SIZE_OPTIONS = [50, 100, 200, 500, "all"];
const TRIP_PAGE_DEFAULT_SIZE = 50;

const ScheduleGrid = ({
  stops,
  allStops,
  stopTimes,
  selectedRouteDetails,
  frequencyInfo,
  hasFrequencies,
  hasNormalTimes,
  stopFilter = "",
  wheelchairAccessibleTrips = 0,
  totalTrips = 0,
}) => {
  const [openSnackbar, setOpenSnackbar] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");
  const [editCell, setEditCell] = useState(null);
  const [saving, setSaving] = useState(false);
  // Column kebab menu state: { anchorEl, tripId } | null
  const [colMenu, setColMenu] = useState(null);
  // Insert stop dialog state: { tripId, tripLabel } | null
  const [insertDialogTrip, setInsertDialogTrip] = useState(null);
  // EditStopTimeDialog state: stopTime row object | null
  const [stopTimeDetail, setStopTimeDetail] = useState(null);

  // Trip column pagination state. The toolbar (rendered below) lets the
  // user navigate / change page size. Both pieces of state are reset to
  // their defaults whenever stopTimes changes (route or date switch) so
  // that an "All" preference made on a small route does not bleed into a
  // huge one and freeze the main thread.
  const [tripPageSize, setTripPageSize] = useState(TRIP_PAGE_DEFAULT_SIZE);
  const [tripPage, setTripPage] = useState(0);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel } = useDetailPanel();
  const { t } = useLanguage();
  const { editing, stopOverrides, recordEdit, showToast } = useEditMode();

  // Empty-state flag. We deliberately do NOT early-return here so that all
  // hooks below run unconditionally on every render (rules of hooks). The
  // empty UI is rendered as a JSX branch at the bottom of the component.
  const isEmpty =
    !stops || stops.length === 0 || !stopTimes || stopTimes.length === 0;

  // ─────────────────────────────────────────────────────────────────────────
  // PERFORMANCE — All heavy derivations below are memoized so they only run
  // when their concrete inputs change. Without these, every parent re-render
  // (theme change, snackbar open, hover, scroll, the 30 s heartbeat that
  // bumps dataVersion, …) re-iterates the full stopTimes array, which costs
  // tens of thousands of operations on large feeds (a route with 1 500
  // trips/day × 30 stops = 45 000 stop_times rows).
  // ─────────────────────────────────────────────────────────────────────────

  // Mapping stop_id -> stop (from stops.txt), with live overrides from
  // edit mode applied (e.g. modified stop name).
  const stopsMap = useMemo(() => {
    const m = {};
    stops.forEach((stop) => {
      const override = stopOverrides && stopOverrides[stop.stop_id];
      m[stop.stop_id] = override ? { ...stop, ...override } : stop;
    });
    return m;
  }, [stops, stopOverrides]);

  // Build the grid for fast schedule lookup.
  const grid = useMemo(() => transformStopTimesToGrid(stopTimes), [stopTimes]);

  // Master stop order (from the reference trip).
  const masterStopOrder = useMemo(
    () => computeMasterStopOrderFromReference(stopTimes),
    [stopTimes],
  );

  // Keep only stops present in stops.txt, in master order.
  // sortedStopIds is also used as-is by computeStopSequence
  // in edit mode (stopId.indexOf), so we expose it separately.
  const sortedStopIds = useMemo(
    () => masterStopOrder.filter((stop_id) => stopsMap[stop_id]),
    [masterStopOrder, stopsMap],
  );
  const sortedStops = useMemo(
    () => sortedStopIds.map((stop_id) => stopsMap[stop_id]),
    [sortedStopIds, stopsMap],
  );

  // Text filter (hot path — user types in the search bar).
  // Must stay fast even when stops has 6,000 entries.
  const filteredStops = useMemo(() => {
    if (!stopFilter) return sortedStops;
    const q = stopFilter.toLowerCase();
    return sortedStops.filter((stop) =>
      stop.stop_name.toLowerCase().includes(q),
    );
  }, [sortedStops, stopFilter]);

  // Do we show seconds? Scan stopTimes once, not on every
  // render.
  const showSeconds = useMemo(
    () =>
      hasNonZeroSeconds(
        stopTimes.flatMap((st) =>
          [st.arrival_time, st.departure_time].filter(Boolean),
        ),
      ),
    [stopTimes],
  );

  // Trip list sorted by first arrival time. This was the worst
  // cost: a Set + sort whose comparator re-accessed grid on every
  // call (sort = O(n log n) comparator calls). We pre-compute the
  // sort key once.
  const tripIds = useMemo(() => {
    const firstArrivalByTrip = new Map();
    for (const st of stopTimes) {
      const t = st.arrival_time || "";
      const cur = firstArrivalByTrip.get(st.trip_id);
      if (cur === undefined || (t && t < cur)) {
        firstArrivalByTrip.set(st.trip_id, t);
      }
    }
    return Array.from(firstArrivalByTrip.entries())
      .sort((a, b) => (a[1] || "").localeCompare(b[1] || ""))
      .map(([tripId]) => tripId);
  }, [stopTimes]);

  // Data passed to <DataTable value=…>. A new array instance on
  // every render defeats PrimeReact's internal diff and triggers a full
  // repaint. We memoize.
  const tableValue = useMemo(
    () =>
      filteredStops.map((stop) => ({
        stop_id: stop.stop_id,
        stop_name: stop.stop_name,
        times: grid[stop.stop_id] ? grid[stop.stop_id].times : {},
      })),
    [filteredStops, grid],
  );

  // Trip column window. PrimeReact does not virtualize columns: rendering
  // 1 500 columns is what blows up the main thread on heavy feeds, far
  // more than any of the JS computations above. We slice to a window
  // unless the user explicitly asked for "all".
  const totalTripCount = tripIds.length;
  const effectivePageSize =
    tripPageSize === "all" ? Math.max(totalTripCount, 1) : tripPageSize;
  const totalPages = Math.max(
    1,
    Math.ceil(totalTripCount / effectivePageSize),
  );
  const safePage = Math.min(tripPage, totalPages - 1);
  const visibleTripIds = useMemo(() => {
    if (tripPageSize === "all") return tripIds;
    const start = safePage * effectivePageSize;
    return tripIds.slice(start, start + effectivePageSize);
  }, [tripIds, safePage, effectivePageSize, tripPageSize]);

  // Reset pagination state when the underlying dataset changes (route or
  // date switch).
  // - tripPage    -> 0      so the user lands on the first window of the
  //                         new dataset, not on a stale page index.
  // - tripPageSize -> default
  //                         If the user had switched to "All" on a small
  //                         route (e.g. 30 trips) and then switches to a
  //                         large one (1 500 trips), keeping "All" would
  //                         render 1 500 columns and freeze the main
  //                         thread. Resetting back to the default 50 is
  //                         the safe behaviour; the user can re-opt into
  //                         a larger window deliberately.
  useEffect(() => {
    setTripPage(0);
    setTripPageSize(TRIP_PAGE_DEFAULT_SIZE);
    // The dep is the array reference: a fresh fetch returns a new array
    // even when the row count happens to be identical, which is what we
    // want here.
  }, [stopTimes]);

  const lineColor = selectedRouteDetails.route_color
    ? `#${selectedRouteDetails.route_color}`
    : "#2781BB";

  // Render of the stops column (fixed column). useCallback so the
  // <Column body={...}> reference is stable between renders, which lets
  // PrimeReact skip its internal cell re-render path when nothing changed.
  const renderStopName = useCallback((rowData, options) => (
    <div className="timeline-container">
      <div className="timeline-circle" style={{ borderColor: lineColor }}></div>
      {options.rowIndex !== 0 && (
        <div
          className="timeline-line"
          style={{ top: "-50%", backgroundColor: lineColor }}
        ></div>
      )}
      {options.rowIndex !== filteredStops.length - 1 && (
        <div
          className="timeline-line"
          style={{ backgroundColor: lineColor }}
        ></div>
      )}
      <span
        style={{ fontWeight: "bold", cursor: "pointer" }}
        onClick={() => openPanel("stop", rowData.stop_id)}
        title={t("schedule.viewStopDetails")}
        data-testid="schedule-stop-name"
      >
        {rowData.stop_name}
      </span>
    </div>
  ), [filteredStops.length, lineColor, openPanel, t]);

  // Render a schedule cell for a given trip at a given stop.
  // If the trip does not serve the stop, display an empty cell.
  const renderScheduleTime = useCallback((rowData, tripId) => {
    const timeInfos = rowData.times[tripId];
    if (!timeInfos || timeInfos.length === 0) return "";
    // We assume there is only one occurrence per stop per trip (otherwise we could pick the first)
    const timeInfo = timeInfos[0];
    const {
      arrival_time,
      pickup_type,
      start_pickup_drop_off_window,
      end_pickup_drop_off_window,
    } = timeInfo;
    const pickupTypeStr =
      pickup_type !== undefined && pickup_type !== null
        ? pickup_type.toString()
        : "";
    let showIcon = false;
    let iconComponent = null;
    if (pickupTypeStr === "1") {
      showIcon = true;
      iconComponent = <BlockIcon className="schedule-icon" />;
    } else if (pickupTypeStr === "2") {
      showIcon = true;
      iconComponent = <PhoneIcon className="schedule-icon" />;
    } else if (pickupTypeStr === "3") {
      if (!start_pickup_drop_off_window && !end_pickup_drop_off_window) {
        showIcon = true;
        iconComponent = (
          <TransferWithinAStationIcon className="schedule-icon" />
        );
      }
    } else if (pickupTypeStr === "0" || pickupTypeStr === "") {
      if (start_pickup_drop_off_window || end_pickup_drop_off_window) {
        showIcon = true;
        iconComponent = <DirectionsBusIcon className="schedule-icon" />;
      }
    }
    return (
      <div className="schedule-cell">
        <span className="schedule-time">
          {formatTime(arrival_time, showSeconds)}
        </span>
        {showIcon && iconComponent}
      </div>
    );
  }, [showSeconds]);

  // ── Edit mode: inline schedule editing ──────────────────────────────────────────────────
  const computeStopSequence = (stopId, tripId) => {
    const myIdx = sortedStopIds.indexOf(stopId);
    // Collect all existing sequences for this trip to guarantee uniqueness
    let maxSeq = 0;
    Object.keys(grid).forEach((sid) => {
      const ti = grid[sid]?.times[tripId];
      if (ti)
        ti.forEach((t) => {
          if (t.stop_sequence != null && t.stop_sequence > maxSeq)
            maxSeq = t.stop_sequence;
        });
    });
    let prevSeq = null,
      nextSeq = null;
    for (let i = myIdx - 1; i >= 0; i--) {
      const sid = sortedStopIds[i];
      const ti = grid[sid]?.times[tripId];
      if (ti && ti.length > 0 && ti[0].stop_sequence != null) {
        prevSeq = ti[0].stop_sequence;
        break;
      }
    }
    for (let i = myIdx + 1; i < sortedStopIds.length; i++) {
      const sid = sortedStopIds[i];
      const ti = grid[sid]?.times[tripId];
      if (ti && ti.length > 0 && ti[0].stop_sequence != null) {
        nextSeq = ti[0].stop_sequence;
        break;
      }
    }
    if (prevSeq != null && nextSeq != null && nextSeq - prevSeq > 1)
      return Math.floor((prevSeq + nextSeq) / 2);
    if (prevSeq != null && nextSeq != null) return maxSeq + 1; // no integer gap — use max+1 to avoid PK collision
    if (prevSeq != null) return prevSeq + 1;
    if (nextSeq != null) return Math.max(0, nextSeq - 1);
    return (myIdx + 1) * 10;
  };

  const handleCellClick = useCallback(
    (e, stopId, tripId, timeInfos) => {
      if (!editing) return;
      // Frequency-generated synthetic trips don't exist in the DB.
      if (tripId.startsWith("freq_")) return;
      const hasTimes = timeInfos && timeInfos.length > 0;
      if (hasTimes) {
        const info = timeInfos[0];
        setEditCell({
          stopId,
          tripId,
          anchorEl: e.currentTarget,
          mode: "edit",
          arrival: info.arrival_time || "",
          departure: info.departure_time || "",
          originalArrival: info.arrival_time || "",
          originalDeparture: info.departure_time || "",
          stopSequence: info.stop_sequence,
        });
      } else {
        setEditCell({
          stopId,
          tripId,
          anchorEl: e.currentTarget,
          mode: "create",
          arrival: "",
          departure: "",
        });
      }
    },
    [editing],
  );

  const handleSaveStopTime = async () => {
    if (!editCell || saving) return;
    setSaving(true);
    const {
      mode,
      tripId,
      stopId,
      arrival,
      departure,
      stopSequence,
      originalArrival,
      originalDeparture,
    } = editCell;
    try {
      if (mode === "edit") {
        // Build patch from fields that actually changed, sending explicit
        // empty string so the backend can NULL-ify cleared times.
        const patchBody = {};
        if (arrival !== originalArrival) {
          patchBody.arrival_time = arrival || "";
        }
        if (departure !== originalDeparture) {
          patchBody.departure_time = departure || "";
        }
        if (Object.keys(patchBody).length === 0) {
          // Nothing changed — close silently, no spurious toast
          setEditCell(null);
          return;
        }
        const res = await fetchWithSession(
          `${API_BASE_URL}/edit/stop_times/${encodeURIComponent(tripId)}/${stopSequence}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patchBody),
          },
        );
        if (!res.ok) {
          const errBody = await res.json();
          const msg = errBody.details
            ? errBody.details.join("; ")
            : errBody.error || t("schedule.editError");
          showToast(msg, "error");
          setSaving(false);
          return;
        }
        const body = await res.json();
        if (body.changed && body.changed.length === 0) {
          // Backend confirmed nothing actually changed (e.g. same value)
          setEditCell(null);
          return;
        }
        recordEdit(t("schedule.timeUpdated"), body.validation, {
          entity: "stop_time",
          entityId: `${tripId}:${stopSequence}`,
        });
      } else {
        const seq = computeStopSequence(stopId, tripId);
        if (seq == null) {
          showToast(t("schedule.editError"), "error");
          setSaving(false);
          return;
        }
        const postBody = {
          trip_id: tripId,
          stop_id: stopId,
          stop_sequence: seq,
        };
        if (arrival) postBody.arrival_time = arrival;
        if (departure) postBody.departure_time = departure;
        const res = await fetchWithSession(`${API_BASE_URL}/edit/stop_times`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(postBody),
        });
        const postRespBody = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(postRespBody.error || t("schedule.editError"), "error");
          return;
        }
        recordEdit(t("schedule.timeAdded"), postRespBody.validation, {
          entity: "stop_time",
          entityId: `${tripId}:${seq}`,
        });
      }
      setEditCell(null);
    } catch (err) {
      console.error("handleSaveStopTime:", err);
      showToast(err.message || "Network error", "error");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteStopTime = async () => {
    if (!editCell || editCell.mode !== "edit" || saving) return;
    setSaving(true);
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/stop_times/${encodeURIComponent(editCell.tripId)}/${editCell.stopSequence}`,
        { method: "DELETE" },
      );
      const delBody = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(delBody.error || t("schedule.editError"), "error");
        return;
      }
      recordEdit(t("schedule.timeDeleted"), delBody.validation, {
        entity: "stop_time",
        entityId: `${editCell.tripId}:${editCell.stopSequence}`,
      });
      setEditCell(null);
    } catch (err) {
      console.error("handleDeleteStopTime:", err);
      showToast(err.message || "Network error", "error");
    } finally {
      setSaving(false);
    }
  };

  const renderEditableCell = useCallback(
    (rowData, tripId) => {
      const timeInfos = rowData.times[tripId];
      const hasTimes = timeInfos && timeInfos.length > 0;
      return (
        <div
          onClick={(e) =>
            handleCellClick(e, rowData.stop_id, tripId, timeInfos)
          }
          style={{
            cursor: "pointer",
            minHeight: 24,
            width: "100%",
            borderRadius: 4,
            transition: "background-color 0.15s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = isDark
              ? "rgba(255,255,255,0.08)"
              : "rgba(0,0,0,0.04)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "transparent";
          }}
        >
          {hasTimes ? (
            renderScheduleTime(rowData, tripId)
          ) : (
            <span style={{ opacity: 0.3, fontSize: 16, fontWeight: "bold" }}>
              +
            </span>
          )}
        </div>
      );
    },
    // handleCellClick is defined just above and uses setEditCell which is
    // stable, so we treat it as stable too.
    [isDark, renderScheduleTime, handleCellClick],
  );

  // Function to copy trip_id via right-click on the header.
  const handleRightClick = useCallback(
    (event, tripId) => {
      event.preventDefault();
      navigator.clipboard
        .writeText(tripId)
        .then(() => {
          setSnackbarMessage(t("schedule.tripCopied", { tripId }));
          setOpenSnackbar(true);
          setTimeout(() => setOpenSnackbar(false), 2000);
        })
        .catch((err) => {
          console.error("Failed to copy trip ID:", err);
        });
    },
    [t],
  );

  // Memoize the array of trip <Column> elements. Without this, every
  // render rebuilt visibleTripIds.length React elements (up to 1500),
  // forcing the reconciler to compare them all even when nothing about
  // the underlying data changed.
  const tripColumns = useMemo(
    () =>
      visibleTripIds.map((tripId) => {
        const isFreq = tripId.startsWith("freq_");
        const display = isFreq
          ? `F${tripId.split("freq_")[1]}`
          : tripId.substring(0, 10);
        return (
          <Column
            key={tripId}
            field={`times[${tripId}]`}
            header={
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 0.25,
                }}
              >
                <Tooltip title={t("schedule.tripTooltip", { tripId })}>
                  <span
                    onContextMenu={(e) => handleRightClick(e, tripId)}
                    onClick={() => openPanel("trip", tripId)}
                    style={{
                      color: "white",
                      fontStyle: isFreq ? "italic" : "normal",
                      cursor: "pointer",
                    }}
                  >
                    {display}
                  </span>
                </Tooltip>
                {editing && !isFreq && (
                  <Tooltip
                    title={t("schedule.colMenu.tooltip")}
                    placement="top"
                    arrow
                  >
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        setColMenu({ anchorEl: e.currentTarget, tripId });
                      }}
                      sx={{
                        color: "rgba(255,255,255,0.7)",
                        p: 0.25,
                        ml: 0.25,
                        "&:hover": {
                          color: "white",
                          background: "rgba(255,255,255,0.12)",
                        },
                      }}
                    >
                      <MoreVertIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            }
            body={(rowData) =>
              editing
                ? renderEditableCell(rowData, tripId)
                : renderScheduleTime(rowData, tripId)
            }
            className="schedule-time"
            style={{ minWidth: "80px", width: "80px" }}
          />
        );
      }),
    [
      visibleTripIds,
      editing,
      renderEditableCell,
      renderScheduleTime,
      handleRightClick,
      openPanel,
      t,
    ],
  );

  // Bounds displayed in the pagination toolbar.
  const tripWindowStart =
    tripPageSize === "all" ? 1 : safePage * effectivePageSize + 1;
  const tripWindowEnd =
    tripPageSize === "all"
      ? totalTripCount
      : Math.min(totalTripCount, (safePage + 1) * effectivePageSize);
  const showPaginator = tripPageSize !== "all" && totalTripCount > tripPageSize;

  if (isEmpty) {
    return (
      <Box
        display="flex"
        justifyContent="center"
        alignItems="center"
        height="100%"
      >
        <Alert severity="info" style={{ textAlign: "center" }}>
          <Typography variant="h7">{t("schedule.noSchedule")}</Typography>
        </Alert>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {/* Pagination toolbar — lives outside the scrollable container of the
          DataTable to stay visible when the user scrolls the grid
          horizontally. The toolbar only appears if the row loads more trips
          than the default window. PrimeReact does not virtualise columns:
          rendering 1500 columns at once blocks the UI, so the default
          window is capped at 50 trips. */}
      {totalTripCount > TRIP_PAGE_DEFAULT_SIZE && (
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{
            flexShrink: 0,
            px: 1.25,
            py: 0.75,
            borderBottom: `1px solid ${theme.palette.divider}`,
            background: isDark
              ? "rgba(255,255,255,0.02)"
              : "rgba(15,23,42,0.02)",
            fontSize: "0.78rem",
          }}
        >
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              fontVariantNumeric: "tabular-nums",
              fontSize: "0.74rem",
            }}
          >
            {t("schedule.tripPage.range", {
              start: tripWindowStart,
              end: tripWindowEnd,
              total: totalTripCount,
            })}
          </Typography>
          {showPaginator && (
            <>
              <Box sx={{ flex: 1 }} />
              <Tooltip title={t("schedule.tripPage.first")}>
                <span>
                  <IconButton
                    size="small"
                    disabled={safePage === 0}
                    onClick={() => setTripPage(0)}
                  >
                    <FirstPageIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={t("schedule.tripPage.prev")}>
                <span>
                  <IconButton
                    size="small"
                    disabled={safePage === 0}
                    onClick={() => setTripPage((p) => Math.max(0, p - 1))}
                  >
                    <KeyboardArrowLeftIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  fontSize: "0.7rem",
                  fontVariantNumeric: "tabular-nums",
                  minWidth: 60,
                  textAlign: "center",
                }}
              >
                {t("schedule.tripPage.page", {
                  page: safePage + 1,
                  total: totalPages,
                })}
              </Typography>
              <Tooltip title={t("schedule.tripPage.next")}>
                <span>
                  <IconButton
                    size="small"
                    disabled={safePage >= totalPages - 1}
                    onClick={() =>
                      setTripPage((p) => Math.min(totalPages - 1, p + 1))
                    }
                  >
                    <KeyboardArrowRightIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={t("schedule.tripPage.last")}>
                <span>
                  <IconButton
                    size="small"
                    disabled={safePage >= totalPages - 1}
                    onClick={() => setTripPage(totalPages - 1)}
                  >
                    <LastPageIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          )}
          {!showPaginator && <Box sx={{ flex: 1 }} />}
          <Stack direction="row" spacing={0.5} alignItems="center">
            <Typography
              variant="caption"
              sx={{ color: "text.secondary", fontSize: "0.72rem" }}
            >
              {t("schedule.tripPage.size")}
            </Typography>
            {TRIP_PAGE_SIZE_OPTIONS.map((size) => (
              <Chip
                key={size}
                size="small"
                label={
                  size === "all" ? t("schedule.tripPage.all") : String(size)
                }
                onClick={() => {
                  setTripPageSize(size);
                  setTripPage(0);
                }}
                color={tripPageSize === size ? "primary" : "default"}
                variant={tripPageSize === size ? "filled" : "outlined"}
                sx={{
                  height: 22,
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              />
            ))}
          </Stack>
        </Stack>
      )}
      {/* Scroll wrapper — ONLY the DataTable scrolls horizontally. The
          pagination toolbar above is outside this wrapper so it stays
          fully visible when the user pans across 50+ trip columns. */}
      <Box
        className="schedule-grid-container"
        data-testid="schedule-grid"
        sx={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
        }}
      >
      <DataTable
        value={tableValue}
        className="DataTable"
        showGridlines
        stripedRows
        scrollable
      >
        <Column
          field="stop_name"
          header={t("schedule.stopsTrips")}
          body={renderStopName}
          style={{
            width: "250px",
            position: "sticky",
            left: 0,
            zIndex: 1,
          }}
          headerStyle={{
            width: "250px",
            position: "sticky",
            left: 0,
            top: 0,
            zIndex: 3,
          }}
          className="p-datatable-column fixed-column"
        />
        {tripColumns}
      </DataTable>
      </Box>

      {/* Schedule edit popover */}
      <Popover
        open={Boolean(editCell)}
        anchorEl={editCell?.anchorEl}
        onClose={() => setEditCell(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        transformOrigin={{ vertical: "top", horizontal: "center" }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.75,
              borderRadius: 2,
              overflow: "hidden",
              boxShadow: isDark
                ? "0 8px 32px rgba(0,0,0,0.55), 0 2px 6px rgba(0,0,0,0.4)"
                : "0 8px 32px rgba(15,23,42,0.12), 0 2px 6px rgba(15,23,42,0.06)",
              borderTop: `3px solid ${
                editCell?.mode === "edit"
                  ? theme.palette.warning.main
                  : theme.palette.success.main
              }`,
              backgroundImage: "none",
              backgroundColor: isDark ? "#1a1f2e" : "#ffffff",
            },
          },
        }}
      >
        {editCell && (() => {
          const isCreate = editCell.mode !== "edit";
          const accent = isCreate
            ? theme.palette.success.main
            : theme.palette.warning.main;
          const accentBg = isCreate
            ? (isDark ? "rgba(16,185,129,0.12)" : "rgba(16,185,129,0.10)")
            : (isDark ? "rgba(237,108,2,0.14)" : "rgba(237,108,2,0.10)");
          const stopName =
            stopsMap[editCell.stopId]?.stop_name || editCell.stopId;
          return (
            <Box sx={{ minWidth: 280, maxWidth: 340 }}>
              {/* Header — context strip */}
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  px: 1.75,
                  py: 1,
                  borderBottom: `1px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.06)"}`,
                  backgroundColor: accentBg,
                  borderLeft: `3px solid ${accent}`,
                }}
              >
                <Box
                  sx={{
                    fontSize: "0.62rem",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    color: accent,
                    textTransform: "uppercase",
                  }}
                >
                  {isCreate ? t("schedule.createTime") || "New" : t("schedule.editTime") || "Edit"}
                </Box>
                <Box
                  sx={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: "0.78rem",
                    fontWeight: 600,
                    color: "text.primary",
                  }}
                  title={stopName}
                >
                  {stopName}
                </Box>
                <Chip
                  label={`#${editCell.stopSequence}`}
                  size="small"
                  sx={{
                    height: 18,
                    fontSize: "0.65rem",
                    fontFamily: "'Roboto Mono', monospace",
                    fontWeight: 600,
                    backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.06)",
                    color: "text.secondary",
                    "& .MuiChip-label": { px: 0.75 },
                  }}
                />
              </Box>

              {/* Body — time inputs */}
              <Box sx={{ px: 2, pt: 1.75, pb: 1.25 }}>
                <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
                  <TimeInput
                    label={t("schedule.arrivalTime")}
                    value={editCell.arrival}
                    onChange={(v) =>
                      setEditCell((prev) => ({ ...prev, arrival: v }))
                    }
                    onEnter={handleSaveStopTime}
                    onEscape={() => setEditCell(null)}
                    autoFocus
                    theme={theme}
                  />

                  <Box sx={{ display: "flex", alignItems: "center", gap: 0 }}>
                    <TimeInput
                      label={t("schedule.departureTime")}
                      value={editCell.departure}
                      onChange={(v) =>
                        setEditCell((prev) => ({ ...prev, departure: v }))
                      }
                      onEnter={handleSaveStopTime}
                      onEscape={() => setEditCell(null)}
                      theme={theme}
                    />
                    <Tooltip
                      title={t("schedule.copyArrival") || "Copy arrival"}
                      placement="right"
                      arrow
                    >
                      <span>
                        <IconButton
                          size="small"
                          onClick={() =>
                            setEditCell((prev) => ({
                              ...prev,
                              departure: prev.arrival,
                            }))
                          }
                          disabled={!editCell.arrival || saving}
                          sx={{
                            ml: 0.75,
                            width: 24,
                            height: 24,
                            color: "text.secondary",
                            opacity: 0.5,
                            transition: "opacity 0.15s, color 0.15s",
                            "&:hover": {
                              opacity: 1,
                              color: theme.palette.primary.main,
                              backgroundColor: "transparent",
                            },
                          }}
                        >
                          <ContentCopyIcon sx={{ fontSize: 13 }} />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Box>
                </Box>
              </Box>

              {/* Footer — actions + shortcut hints */}
              <Box
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 0.5,
                  px: 1.5,
                  py: 1,
                  borderTop: `1px solid ${isDark ? "rgba(255,255,255,0.06)" : "rgba(15,23,42,0.05)"}`,
                  backgroundColor: isDark ? "rgba(255,255,255,0.015)" : "rgba(15,23,42,0.015)",
                }}
              >
                {editCell.mode === "edit" && (
                  <Tooltip title={t("schedule.deleteTime")} placement="top" arrow>
                    <span>
                      <IconButton
                        size="small"
                        onClick={handleDeleteStopTime}
                        disabled={saving}
                        sx={{
                          color: "error.main",
                          opacity: 0.55,
                          width: 28,
                          height: 28,
                          transition: "opacity 0.15s, background-color 0.15s",
                          "&:hover": {
                            opacity: 1,
                            backgroundColor: isDark
                              ? "rgba(244,67,54,0.12)"
                              : "rgba(244,67,54,0.08)",
                          },
                        }}
                      >
                        <DeleteIcon sx={{ fontSize: 16 }} />
                      </IconButton>
                    </span>
                  </Tooltip>
                )}
                {editCell.mode === "edit" && (
                  <Tooltip title={t("editStopTime.detailsBtn")} placement="top" arrow>
                    <Button
                      size="small"
                      onClick={() => {
                        const info = editCell;
                        setEditCell(null);
                        setStopTimeDetail({
                          trip_id: info.tripId,
                          stop_sequence: info.stopSequence,
                          stop_id: info.stopId,
                          stop_name:
                            stopsMap[info.stopId]?.stop_name || info.stopId,
                        });
                      }}
                      disabled={saving}
                      sx={{
                        textTransform: "none",
                        fontWeight: 500,
                        fontSize: "0.72rem",
                        minWidth: 0,
                        px: 1,
                        py: 0.25,
                        height: 26,
                        color: "text.secondary",
                        "&:hover": {
                          backgroundColor: isDark
                            ? "rgba(255,255,255,0.05)"
                            : "rgba(15,23,42,0.04)",
                          color: "text.primary",
                        },
                      }}
                    >
                      {t("editStopTime.detailsBtn")}
                    </Button>
                  </Tooltip>
                )}
                <Box sx={{ flex: 1 }} />
                <Box
                  sx={{
                    display: { xs: "none", sm: "flex" },
                    alignItems: "center",
                    gap: 0.5,
                    fontSize: "0.62rem",
                    color: "text.secondary",
                    opacity: 0.7,
                    fontFamily: "'Roboto Mono', monospace",
                    mr: 0.5,
                  }}
                >
                  <Box
                    component="span"
                    sx={{
                      px: 0.5,
                      borderRadius: 0.5,
                      border: `1px solid ${isDark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.12)"}`,
                      lineHeight: 1.4,
                    }}
                  >
                    Esc
                  </Box>
                  <Box
                    component="span"
                    sx={{
                      px: 0.5,
                      borderRadius: 0.5,
                      border: `1px solid ${isDark ? "rgba(255,255,255,0.12)" : "rgba(15,23,42,0.12)"}`,
                      lineHeight: 1.4,
                    }}
                  >
                    ↵
                  </Box>
                </Box>
                <Button
                  size="small"
                  onClick={() => setEditCell(null)}
                  disabled={saving}
                  sx={{
                    textTransform: "none",
                    fontWeight: 500,
                    fontSize: "0.78rem",
                    minWidth: 0,
                    px: 1.25,
                    py: 0.25,
                    height: 28,
                    color: "text.secondary",
                  }}
                >
                  {t("app.cancel")}
                </Button>
                <Button
                  size="small"
                  variant="contained"
                  onClick={handleSaveStopTime}
                  disabled={saving}
                  disableElevation
                  sx={{
                    textTransform: "none",
                    fontWeight: 600,
                    fontSize: "0.78rem",
                    minWidth: 60,
                    px: 1.5,
                    py: 0.25,
                    height: 28,
                    borderRadius: 1.25,
                    backgroundColor: accent,
                    color: "#fff",
                    boxShadow: "none",
                    "&:hover": {
                      backgroundColor: accent,
                      filter: "brightness(0.92)",
                      boxShadow: "none",
                    },
                  }}
                >
                  {saving ? "…" : t("app.save")}
                </Button>
              </Box>
            </Box>
          );
        })()}
      </Popover>

      <Snackbar
        open={openSnackbar}
        message={snackbarMessage}
        autoHideDuration={2000}
        onClose={() => setOpenSnackbar(false)}
      />

      {/* Column actions kebab menu */}
      <Menu
        anchorEl={colMenu?.anchorEl}
        open={Boolean(colMenu)}
        onClose={() => setColMenu(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 200 } } }}
      >
        <MenuItem
          onClick={() => {
            const tid = colMenu.tripId;
            setColMenu(null);
            setInsertDialogTrip({ tripId: tid, tripLabel: tid });
          }}
          dense
        >
          <AddLocationAltIcon sx={{ fontSize: 16, mr: 1.5, color: "success.main" }} />
          <Typography variant="body2">
            {t("schedule.insertStop.tooltip")}
          </Typography>
        </MenuItem>
      </Menu>

      {/* Insert stop dialog */}
      {insertDialogTrip && (
        <InsertStopDialog
          open={Boolean(insertDialogTrip)}
          onClose={() => setInsertDialogTrip(null)}
          tripId={insertDialogTrip.tripId}
          tripLabel={insertDialogTrip.tripLabel}
          existingStopTimes={stopTimes
            .filter((st) => st.trip_id === insertDialogTrip.tripId)
            .sort((a, b) => a.stop_sequence - b.stop_sequence)}
          stopsMap={stopsMap}
        />
      )}

      {/* Advanced stop_time fields dialog (GTFS v2.1) */}
      <EditStopTimeDialog
        open={Boolean(stopTimeDetail)}
        stopTime={stopTimeDetail}
        onClose={() => setStopTimeDetail(null)}
      />
    </Box>
  );
};

// React.memo so that re-renders of GTFSApp (theme, snackbar, header
// state, etc.) do not re-render the schedule grid unless its concrete
// data props (stops / stopTimes / selectedRouteDetails / stopFilter)
// actually change. The component is large enough that the shallow prop
// compare is cheaper than its render path.
export default memo(ScheduleGrid);
