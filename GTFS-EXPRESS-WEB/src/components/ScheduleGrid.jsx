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
import { Typography, Chip, alpha, useTheme } from "@mui/material";
import ScheduleRoundedIcon from "@mui/icons-material/ScheduleRounded";
import FiberNewRoundedIcon from "@mui/icons-material/FiberNewRounded";
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
import { editRefusal, editFailure } from "../utils/editRefusal";
import InsertStopDialog from "./edit/InsertStopDialog";
import EditStopTimeDialog from "./edit/EditStopTimeDialog";
import ShiftTimesDialog from "./edit/ShiftTimesDialog";
import EditTripDialog from "./edit/EditTripDialog";
import CascadePreviewDialog from "./edit/CascadePreviewDialog";
import ScheduleIcon from "@mui/icons-material/Schedule";
import { formatGtfsTime, hasSeconds } from "../utils/gtfsTime";

// ── Segmented time input (HH:MM:SS; GTFS hours may exceed 23 for next-day service)
// Its own state keeps a partial input intact: normalising it with padStart on every keystroke would destroy it.

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
  // Built once so the key handlers keep their identity.
  const refs = useMemo(() => [React.createRef(), React.createRef(), React.createRef()], []);

  const [segs, setSegs] = useState(() => parseTime(value));
  const internalRef = useRef(false); // true when the change comes from typing

  // Sync from the parent only on external changes (e.g. « Copy arrival → departure »).
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
  }, [onEnter, onEscape, refs]);

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
              // eslint-disable-next-line jsx-a11y/no-autofocus -- the cell the person just opened for editing
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

// The stop order follows the longest trip; stops it does not serve come after.
const computeMasterStopOrderFromReference = (stopTimes) => {
  const tripsMap = {};
  const unionStops = new Set();

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
    const refStops = tripsMap[referenceTripId].sort(
      (a, b) => a.stop_sequence - b.stop_sequence,
    );
    masterOrder = refStops.map((item) => item.stop_id);
  }

  unionStops.forEach((stop_id) => {
    if (!masterOrder.includes(stop_id)) {
      masterOrder.push(stop_id);
    }
  });

  return masterOrder;
};

// grid[stop_id].times[trip_id] = [timeInfo]
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

// PrimeReact does not virtualise columns: past ~200 trip columns the grid freezes the main thread, so the trips
// are paged, and « all » is reset to the default whenever the dataset changes so it never carries to a larger line.
const TRIP_PAGE_SIZE_OPTIONS = [50, 100, 200, 500, "all"];
const TRIP_PAGE_DEFAULT_SIZE = 50;

const ScheduleGrid = ({
  stops,
  stopTimes,
  selectedRouteDetails,
  stopFilter = "",
  // route|direction|date: paging resets only when this changes, never on the silent refetch after every edit.
  datasetKey = "",
  // The trips a simulated draft adds, marked « nouvelle »: a stable Set (the grid is memoised), or null.
  highlightTripIds = null,
  // No editing whatever the edit mode (a draft read only on « Après »).
  readOnly = false,
  // frequencies.txt windows: [{ headway_mins, start_time, end_time }], or null.
  frequencyInfo = null,
}) => {
  const [openSnackbar, setOpenSnackbar] = useState(false);
  const [snackbarMessage, setSnackbarMessage] = useState("");
  const [editCell, setEditCell] = useState(null);
  const [saving, setSaving] = useState(false);
  // { anchorEl, tripId } | null
  const [colMenu, setColMenu] = useState(null);
  // { tripId, tripLabel } | null
  const [insertDialogTrip, setInsertDialogTrip] = useState(null);
  const [stopTimeDetail, setStopTimeDetail] = useState(null);
  const [shiftDialogTrip, setShiftDialogTrip] = useState(null);
  // { kind: "duplicate"|"delete", tripId, trip }
  const [tripAction, setTripAction] = useState(null);

  const [tripPageSize, setTripPageSize] = useState(TRIP_PAGE_DEFAULT_SIZE);
  const [tripPage, setTripPage] = useState(0);
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { openPanel } = useDetailPanel();
  const { t } = useLanguage();
  const { editing: editingInContext, stopOverrides, recordEdit, showToast } = useEditMode();
  const editing = editingInContext && !readOnly;

  // No early return here: every hook below runs on every render (#18).
  const isEmpty =
    !stops || stops.length === 0 || !stopTimes || stopTimes.length === 0;

  // The derivations below are memoised: a parent re-render (theme, snackbar, the heartbeat bumping dataVersion)
  // would otherwise re-iterate tens of thousands of stop_times on a large line.

  // With the edit mode's live overrides applied (e.g. a renamed stop).
  const stopsMap = useMemo(() => {
    const m = {};
    stops.forEach((stop) => {
      const override = stopOverrides && stopOverrides[stop.stop_id];
      m[stop.stop_id] = override ? { ...stop, ...override } : stop;
    });
    return m;
  }, [stops, stopOverrides]);

  const grid = useMemo(() => transformStopTimesToGrid(stopTimes), [stopTimes]);

  const masterStopOrder = useMemo(
    () => computeMasterStopOrderFromReference(stopTimes),
    [stopTimes],
  );

  // Also read as is by computeInsertSequence (stopId.indexOf).
  const sortedStopIds = useMemo(
    () => masterStopOrder.filter((stop_id) => stopsMap[stop_id]),
    [masterStopOrder, stopsMap],
  );
  const sortedStops = useMemo(
    () => sortedStopIds.map((stop_id) => stopsMap[stop_id]),
    [sortedStopIds, stopsMap],
  );

  // Hot path while typing: must stay fast with thousands of stops.
  const filteredStops = useMemo(() => {
    if (!stopFilter) return sortedStops;
    const q = stopFilter.toLowerCase();
    return sortedStops.filter((stop) =>
      stop.stop_name.toLowerCase().includes(q),
    );
  }, [sortedStops, stopFilter]);

  const showSeconds = useMemo(
    () =>
      hasSeconds(
        stopTimes.flatMap((st) =>
          [st.arrival_time, st.departure_time].filter(Boolean),
        ),
      ),
    [stopTimes],
  );

  // The sort key computed once: a comparator reading the grid on every call is the costliest path here.
  const { tripIds } = useMemo(() => {
    const firstArrivalByTrip = new Map();
    for (const st of stopTimes) {
      const t = st.arrival_time || st.departure_time || "";
      const cur = firstArrivalByTrip.get(st.trip_id);
      if (cur === undefined || (t && (!cur || t < cur))) {
        firstArrivalByTrip.set(st.trip_id, t);
      }
    }
    const ids = Array.from(firstArrivalByTrip.entries())
      .sort((a, b) => (a[1] || "").localeCompare(b[1] || ""))
      .map(([tripId]) => tripId);
    return { tripIds: ids };
  }, [stopTimes]);

  // A new array on every render defeats PrimeReact's diff and repaints the whole table.
  const tableValue = useMemo(
    () =>
      filteredStops.map((stop) => ({
        stop_id: stop.stop_id,
        stop_name: stop.stop_name,
        times: grid[stop.stop_id] ? grid[stop.stop_id].times : {},
      })),
    [filteredStops, grid],
  );

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

  // On a new dataset: back to the default page size, and to the first page, or to the window of the first trip a
  // draft adds so the change is in sight.
  useEffect(() => {
    const firstNew = highlightTripIds ? tripIds.findIndex((id) => highlightTripIds.has(id)) : -1;
    setTripPage(firstNew > 0 ? Math.floor(firstNew / TRIP_PAGE_DEFAULT_SIZE) : 0);
    setTripPageSize(TRIP_PAGE_DEFAULT_SIZE);
    // Keyed on the dataset identity, not the stopTimes reference, so the refetch after an edit keeps the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datasetKey]);

  const lineColor = selectedRouteDetails.route_color
    ? `#${selectedRouteDetails.route_color}`
    : "#2781BB";

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
        role="button"
        tabIndex={0}
        onClick={() => openPanel("stop", rowData.stop_id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openPanel("stop", rowData.stop_id);
          }
        }}
        title={t("schedule.viewStopDetails")}
        data-testid="schedule-stop-name"
      >
        {rowData.stop_name}
      </span>
    </div>
  ), [filteredStops.length, lineColor, openPanel, t]);

  const renderScheduleTime = useCallback((rowData, tripId) => {
    const timeInfos = rowData.times[tripId];
    if (!timeInfos || timeInfos.length === 0) return "";
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
    // One time per cell keeps the columns aligned; a dwell stays readable on hover and in the stop-time popover.
    const departure = timeInfo.departure_time;
    const hasDwell =
      Boolean(arrival_time) && Boolean(departure) && departure !== arrival_time;
    return (
      <div
        className="schedule-cell"
        title={hasDwell ? `${formatGtfsTime(arrival_time, { seconds: showSeconds })} → ${formatGtfsTime(departure, { seconds: showSeconds })}` : undefined}
      >
        <span className="schedule-time">
          {formatGtfsTime(arrival_time || departure, { seconds: showSeconds })}
        </span>
        {showIcon && iconComponent}
      </div>
    );
  }, [showSeconds]);

  // ── Edit mode
  // POST /edit/stop_times/insert shifts every sequence >= the one asked: take the sequence of the next stop the trip
  // serves in the master order, so the new stop lands between its neighbours (after the last one otherwise).
  const computeInsertSequence = (stopId, tripId) => {
    const myIdx = sortedStopIds.indexOf(stopId);
    let maxSeq = -1;
    for (let i = myIdx + 1; i < sortedStopIds.length; i++) {
      const ti = grid[sortedStopIds[i]]?.times[tripId];
      if (ti && ti.length > 0 && ti[0].stop_sequence != null) {
        return ti[0].stop_sequence;
      }
    }
    Object.keys(grid).forEach((sid) => {
      const ti = grid[sid]?.times[tripId];
      if (ti)
        ti.forEach((t) => {
          if (t.stop_sequence != null && t.stop_sequence > maxSeq)
            maxSeq = t.stop_sequence;
        });
    });
    return maxSeq + 1;
  };

  const handleCellClick = useCallback(
    (e, stopId, tripId, timeInfos) => {
      if (!editing) return;
      // Frequency-generated trips do not exist in the database.
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
          stopSequence: computeInsertSequence(stopId, tripId),
        });
      }
    },
    // grid and sortedStopIds are memoised on stopTimes; the popover snapshot is taken at click time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [editing, grid, sortedStopIds],
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
        // Only the fields that changed; an empty string lets the backend set a cleared time to NULL.
        const patchBody = {};
        if (arrival !== originalArrival) {
          patchBody.arrival_time = arrival || "";
        }
        if (departure !== originalDeparture) {
          patchBody.departure_time = departure || "";
        }
        if (Object.keys(patchBody).length === 0) {
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
          showToast((await editRefusal(res, t)).text, "error");
          setSaving(false);
          return;
        }
        const body = await res.json().catch(() => ({}));
        if (body.changed && body.changed.length === 0) {
          setEditCell(null);
          return;
        }
        recordEdit(t("schedule.timeUpdated"), body.validation, {
          entity: "stop_time",
          entityId: `${tripId}:${stopSequence}`,
        });
      } else {
        // Insert with renumbering: a plain POST would append the stop at the end of the trip whenever the numbering
        // has no gap, whatever row was clicked.
        const seq =
          stopSequence != null
            ? stopSequence
            : computeInsertSequence(stopId, tripId);
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
        const res = await fetchWithSession(
          `${API_BASE_URL}/edit/stop_times/insert`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(postBody),
          },
        );
        if (!res.ok) {
          showToast((await editRefusal(res, t)).text, "error");
          return;
        }
        const postRespBody = await res.json().catch(() => ({}));
        recordEdit(t("schedule.timeAdded"), postRespBody.validation, {
          entity: "stop_time",
          entityId: `${tripId}:${seq}`,
        });
      }
      setEditCell(null);
    } catch (err) {
      console.error("handleSaveStopTime:", err);
      showToast(editFailure(err, t), "error");
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
      if (!res.ok) {
        showToast((await editRefusal(res, t)).text, "error");
        return;
      }
      const delBody = await res.json().catch(() => ({}));
      recordEdit(t("schedule.timeDeleted"), delBody.validation, {
        entity: "stop_time",
        entityId: `${editCell.tripId}:${editCell.stopSequence}`,
      });
      setEditCell(null);
    } catch (err) {
      console.error("handleDeleteStopTime:", err);
      showToast(editFailure(err, t), "error");
    } finally {
      setSaving(false);
    }
  };

  // Arrows move between editable cells, Enter / F2 / Space open the editor, Home / End jump along the row.
  const gridRef = useRef(null);
  const focusCell = useCallback((row, col) => {
    const el = gridRef.current?.querySelector(
      `[data-cell="${row}:${col}"]`,
    );
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
      return true;
    }
    return false;
  }, []);

  const handleCellKeyDown = useCallback(
    (e, rowData, tripId, timeInfos, row, col) => {
      let handled = true;
      switch (e.key) {
        case "Enter":
        case "F2":
        case " ":
          handleCellClick(e, rowData.stop_id, tripId, timeInfos);
          break;
        case "ArrowDown":
          focusCell(row + 1, col);
          break;
        case "ArrowUp":
          focusCell(row - 1, col);
          break;
        case "ArrowRight":
          focusCell(row, col + 1);
          break;
        case "ArrowLeft":
          focusCell(row, col - 1);
          break;
        case "Home":
          focusCell(row, 0);
          break;
        case "End": {
          let c = col;
          while (focusCell(row, c + 1)) c += 1;
          break;
        }
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    },
    [handleCellClick, focusCell],
  );

  const renderEditableCell = useCallback(
    (rowData, tripId, row, col) => {
      const timeInfos = rowData.times[tripId];
      const hasTimes = timeInfos && timeInfos.length > 0;
      const stopName = stopsMap[rowData.stop_id]?.stop_name || rowData.stop_id;
      return (
        <div
          className="schedule-editable-cell"
          role="gridcell"
          tabIndex={0}
          data-cell={`${row}:${col}`}
          aria-label={`${stopName} · ${tripId}`}
          onClick={(e) =>
            handleCellClick(e, rowData.stop_id, tripId, timeInfos)
          }
          onKeyDown={(e) =>
            handleCellKeyDown(e, rowData, tripId, timeInfos, row, col)
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
    [isDark, renderScheduleTime, handleCellClick, handleCellKeyDown, stopsMap],
  );

  // Duplicate keeps every attribute and the cascade preview wants the headsign: fetch the trip row once.
  const openTripAction = useCallback(
    async (tripId, kind) => {
      try {
        const res = await fetchWithSession(
          `${API_BASE_URL}/trip_detail/${encodeURIComponent(tripId)}`,
        );
        const data = res.ok ? await res.json() : null;
        const trip = data?.trip || null;
        if (kind === "duplicate" && !trip) {
          showToast(t("schedule.editError"), "error");
          return;
        }
        setTripAction({ kind, tripId, trip });
      } catch (err) {
        showToast(editFailure(err, t), "error");
      }
    },
    [showToast, t],
  );

  const handleDeleteTrip = useCallback(async () => {
    const tripId = tripAction?.tripId;
    if (!tripId) return;
    try {
      const res = await fetchWithSession(
        `${API_BASE_URL}/edit/trips/${encodeURIComponent(tripId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        showToast((await editRefusal(res, t)).text, "error");
        return;
      }
      const body = await res.json().catch(() => ({}));
      recordEdit(
        t("edit.trip.deletedToast", {
          id: tripId,
          stopTimes: body.cascade?.stop_times || 0,
        }),
        body.validation,
        { entity: "trip", entityId: tripId },
      );
    } catch (err) {
      showToast(editFailure(err, t), "error");
    } finally {
      setTripAction(null);
    }
  }, [tripAction, recordEdit, showToast, t]);

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

  // Up to 1 500 columns: rebuilt on every render they would all be reconciled.
  const tripColumns = useMemo(
    () =>
      visibleTripIds.map((tripId, colIdx) => {
        const isFreq = tripId.startsWith("freq_");
        // A column is named by its trip (its whole id in the tooltip); a frequency trip keeps its F label.
        const display = isFreq ? `F${tripId.split("freq_")[1]}` : tripId.substring(0, 10);
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
                {highlightTripIds?.has(tripId) && (
                  // Laid in the header cell's top corner, above the label and its menu, so nothing moves when « Après » shows it.
                  <Box
                    component="span"
                    role="img"
                    aria-label={t("lens.trip.new")}
                    title={t("lens.trip.new")}
                    data-testid="schedule-trip-new"
                    sx={{
                      position: "absolute",
                      top: 2,
                      right: 2,
                      zIndex: 1,
                      display: "inline-flex",
                      lineHeight: 0,
                      borderRadius: "5px",
                      backgroundColor: theme.palette.common.white,
                      boxShadow: `0 1px 3px ${alpha(theme.palette.common.black, 0.3)}`,
                      pointerEvents: "none",
                      "@keyframes gtfsTripNew": { from: { opacity: 0, transform: "scale(0.4)" }, to: { opacity: 1, transform: "none" } },
                      animation: "gtfsTripNew 360ms cubic-bezier(0.34, 1.56, 0.64, 1) both",
                      "@media (prefers-reduced-motion: reduce)": { animation: "none" },
                    }}
                  >
                    <FiberNewRoundedIcon aria-hidden sx={{ fontSize: 22, m: "-4px -2px", color: theme.palette.success.main }} />
                  </Box>
                )}
                <Tooltip title={t("schedule.tripTooltip", { tripId })}>
                  <span
                    onContextMenu={(e) => handleRightClick(e, tripId)}
                    role="button"
                    tabIndex={0}
                    onClick={() => openPanel("trip", tripId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openPanel("trip", tripId);
                      }
                    }}
                    style={{
                      color: "white",
                      fontStyle: isFreq ? "italic" : "normal",
                      cursor: "pointer",
                      display: "inline-flex",
                      flexDirection: "column",
                      alignItems: "center",
                      lineHeight: 1.15,
                    }}
                  >
                    <span data-testid="schedule-trip-id">{display}</span>
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
                      data-testid="trip-col-menu"
                      aria-label={t("schedule.colMenu.tooltip")}
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
            body={(rowData, options) =>
              // Frequency-generated columns do not exist in the database: no editable cell.
              editing && !isFreq
                ? renderEditableCell(rowData, tripId, options.rowIndex, colIdx)
                : renderScheduleTime(rowData, tripId)
            }
            className="schedule-time"
            headerStyle={{ position: "relative" }}
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
      highlightTripIds,
      theme,
    ],
  );

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
      {/* Outside the scrolling container so it stays visible while the grid scrolls sideways. */}
      {totalTripCount > 0 && (
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
          {frequencyInfo && frequencyInfo.length > 0 && (
            <Chip
              data-testid="schedule-frequency"
              icon={<ScheduleRoundedIcon sx={{ fontSize: 14 }} />}
              label={
                frequencyInfo.length === 1
                  ? `${t("schedule.frequencyBased")} · ${frequencyInfo[0].headway_mins} min · ${String(frequencyInfo[0].start_time).substring(0, 5)}–${String(frequencyInfo[0].end_time).substring(0, 5)}`
                  : `${t("schedule.frequencyBased")} · ${frequencyInfo[0].headway_mins} min · ${frequencyInfo.length}`
              }
              size="small"
              sx={{ height: 22, fontSize: "0.72rem", fontWeight: 500, color: theme.palette.info.main, backgroundColor: alpha(theme.palette.info.main, isDark ? 0.16 : 0.08), "& .MuiChip-icon": { color: theme.palette.info.main } }}
            />
          )}
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
          {totalTripCount > TRIP_PAGE_DEFAULT_SIZE && (
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
          )}
        </Stack>
      )}
      <Box
        ref={gridRef}
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

      <Popover
        open={Boolean(editCell)}
        anchorEl={editCell?.anchorEl}
        onClose={() => setEditCell(null)}
        // The focus goes back to the cell so the arrows keep working after Enter / Esc.
        TransitionProps={{
          onExited: () => {
            const el = editCell?.anchorEl;
            if (el && typeof el.focus === "function") el.focus();
          },
        }}
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
            <Box
              sx={{ minWidth: 280, maxWidth: 340 }}
              data-testid="schedule-edit-popover"
            >
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
                  label={
                    editCell.stopSequence != null
                      ? `#${editCell.stopSequence}`
                      : "#?"
                  }
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
        <MenuItem
          onClick={() => {
            const tid = colMenu.tripId;
            setColMenu(null);
            setShiftDialogTrip(tid);
          }}
          dense
          data-testid="col-menu-shift"
        >
          <ScheduleIcon sx={{ fontSize: 16, mr: 1.5, color: "primary.main" }} />
          <Typography variant="body2">{t("schedule.colMenu.shift")}</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            const tid = colMenu.tripId;
            setColMenu(null);
            openTripAction(tid, "duplicate");
          }}
          dense
        >
          <ContentCopyIcon sx={{ fontSize: 16, mr: 1.5, color: "info.main" }} />
          <Typography variant="body2">{t("schedule.colMenu.duplicate")}</Typography>
        </MenuItem>
        <MenuItem
          onClick={() => {
            const tid = colMenu.tripId;
            setColMenu(null);
            openTripAction(tid, "delete");
          }}
          dense
        >
          <DeleteIcon sx={{ fontSize: 16, mr: 1.5, color: "error.main" }} />
          <Typography variant="body2">{t("schedule.colMenu.delete")}</Typography>
        </MenuItem>
      </Menu>

      <ShiftTimesDialog
        open={Boolean(shiftDialogTrip)}
        tripIds={shiftDialogTrip ? [shiftDialogTrip] : []}
        tripLabel={shiftDialogTrip || ""}
        onClose={() => setShiftDialogTrip(null)}
      />

      {tripAction?.kind === "duplicate" && tripAction.trip && (
        <EditTripDialog
          open
          trip={tripAction.trip}
          mode="duplicate"
          routeId={tripAction.trip.route_id}
          serviceId={tripAction.trip.service_id}
          onClose={() => setTripAction(null)}
          onCreated={(created) => {
            if (created?.trip_id) openPanel("trip", created.trip_id);
          }}
        />
      )}

      {tripAction?.kind === "delete" && (
        <CascadePreviewDialog
          open
          entity="trip"
          entityId={tripAction.tripId}
          entityLabel={tripAction.trip?.trip_headsign || tripAction.tripId}
          onCancel={() => setTripAction(null)}
          onConfirm={handleDeleteTrip}
        />
      )}

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

      <EditStopTimeDialog
        open={Boolean(stopTimeDetail)}
        stopTime={stopTimeDetail}
        onClose={() => setStopTimeDetail(null)}
      />
    </Box>
  );
};

// Memoised: GTFSApp re-renders often and the grid's render costs more than a shallow prop compare.
export default memo(ScheduleGrid);
