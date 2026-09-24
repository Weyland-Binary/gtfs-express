/**
 * SpecEditors — the reviewable, editable plan: lines (names, mode, colour,
 * stop order, services), stops (name, coordinates: geocode candidates, place
 * on the map) and the raw JSON for power users. Every edit mutates the spec
 * held by the studio, which re-validates it.
 */

import React, { useCallback, useState } from "react";
import { Autocomplete, Box, Button, Chip, CircularProgress, IconButton, MenuItem, Menu, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import { useLanguage } from "../../contexts/LanguageContext";
import { geocodeQuery } from "../../utils/networkStudioApi";

export const MODES = ["bus", "coach", "express", "shuttle", "trolleybus", "tram", "metro", "rail", "ferry", "cable", "gondola", "funicular", "monorail"];
export const CALENDARS = ["weekday", "saturday", "sunday", "weekend", "daily", "monsat"];

const calendarLabel = (t, cal) => (typeof cal === "string" ? t(`network.calendar.${cal}`) : cal && Array.isArray(cal.days) ? cal.days.join(", ") : "—");

// ── Lines ──────────────────────────────────────────────────────────────────

function ServiceRow({ service, stopCount, onChange, onRemove }) {
  const { t } = useLanguage();
  const periods = service.periods || [];
  const departures = service.departures || [];
  const cal = typeof service.calendar === "string" ? service.calendar : service.calendar_id || "weekday";
  const setPeriod = (i, patch) => onChange({ ...service, periods: periods.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5, p: 1, borderRadius: 1.5, border: (th) => `1px solid ${alpha(th.palette.divider, 1)}` }} data-testid="line-service">
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
        <TextField select size="small" label={t("network.field.calendar")} value={CALENDARS.includes(cal) ? cal : "weekday"} onChange={(e) => onChange({ ...service, calendar: e.target.value })} sx={{ minWidth: 150 }}>
          {CALENDARS.map((c) => (
            <MenuItem key={c} value={c}>
              {calendarLabel(t, c)}
            </MenuItem>
          ))}
        </TextField>
        <TextField select size="small" label={t("network.field.direction")} value={service.direction || "both"} onChange={(e) => onChange({ ...service, direction: e.target.value })} sx={{ minWidth: 120 }}>
          <MenuItem value="both">{t("network.direction.both")}</MenuItem>
          <MenuItem value="0">0</MenuItem>
          <MenuItem value="1">1</MenuItem>
        </TextField>
        <Box sx={{ flex: 1 }} />
        <IconButton size="small" onClick={onRemove} aria-label={t("network.remove")}>
          <DeleteOutlineIcon sx={{ fontSize: 17 }} />
        </IconButton>
      </Box>
      {periods.map((p, i) => (
        <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <TextField size="small" label={t("network.field.from")} value={p.from || ""} onChange={(e) => setPeriod(i, { from: e.target.value })} sx={{ width: 90 }} inputProps={{ style: { fontFamily: "monospace" } }} />
          <TextField size="small" label={t("network.field.to")} value={p.to || ""} onChange={(e) => setPeriod(i, { to: e.target.value })} sx={{ width: 90 }} inputProps={{ style: { fontFamily: "monospace" } }} />
          <TextField size="small" type="number" label={t("network.field.headway")} value={p.headway_min ?? ""} onChange={(e) => setPeriod(i, { headway_min: Number(e.target.value) })} sx={{ width: 110 }} inputProps={{ min: 1, max: 720 }} />
          <IconButton size="small" onClick={() => onChange({ ...service, periods: periods.filter((_, j) => j !== i) })} aria-label={t("network.remove")}>
            <DeleteOutlineIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>
      ))}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
        <Button size="small" startIcon={<AddIcon />} onClick={() => onChange({ ...service, periods: [...periods, { from: periods.length ? periods[periods.length - 1].to : "06:00", to: "20:00", headway_min: 30 }] })} sx={{ textTransform: "none" }}>
          {t("network.addPeriod")}
        </Button>
        <TextField
          size="small"
          label={t("network.field.departures")}
          placeholder="07:30, 12:15, 17:30"
          value={departures.join(", ")}
          onChange={(e) => onChange({ ...service, departures: e.target.value.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean) })}
          sx={{ flex: 1, minWidth: 180 }}
          inputProps={{ style: { fontFamily: "monospace" } }}
        />
      </Box>
      <Typography sx={{ fontSize: "0.68rem", color: "text.disabled" }}>{t("network.service.hint", { stops: stopCount })}</Typography>
    </Box>
  );
}

function DirectionEditor({ direction, index, stops, onChange, onRemove }) {
  const { t } = useLanguage();
  const names = new Map(stops.map((s) => [s.id, s.name]));
  const move = (i, delta) => {
    const arr = [...direction.stops];
    const j = i + delta;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange({ ...direction, stops: arr });
  };
  return (
    <Box sx={{ p: 1, borderRadius: 1.5, border: (th) => `1px solid ${alpha(th.palette.divider, 1)}`, display: "flex", flexDirection: "column", gap: 0.75 }} data-testid="line-direction">
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
        <Chip size="small" label={t("network.directionN", { n: direction.id ?? index })} sx={{ height: 20, fontSize: "0.64rem", fontWeight: 700 }} />
        <TextField size="small" label={t("network.field.headsign")} value={direction.headsign || ""} onChange={(e) => onChange({ ...direction, headsign: e.target.value })} sx={{ flex: 1 }} />
        {onRemove && (
          <IconButton size="small" onClick={onRemove} aria-label={t("network.remove")}>
            <DeleteOutlineIcon sx={{ fontSize: 17 }} />
          </IconButton>
        )}
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.25 }}>
        {direction.stops.map((id, i) => (
          <Box key={`${id}-${i}`} sx={{ display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.78rem" }}>
            <Box sx={{ width: 20, textAlign: "right", color: "text.disabled", fontFamily: "monospace", fontSize: "0.68rem" }}>{i + 1}</Box>
            <Box sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{names.get(id) || id}</Box>
            <IconButton size="small" onClick={() => move(i, -1)} disabled={i === 0} sx={{ p: 0.3 }} aria-label="up">
              <ArrowUpwardIcon sx={{ fontSize: 14 }} />
            </IconButton>
            <IconButton size="small" onClick={() => move(i, 1)} disabled={i === direction.stops.length - 1} sx={{ p: 0.3 }} aria-label="down">
              <ArrowDownwardIcon sx={{ fontSize: 14 }} />
            </IconButton>
            <IconButton size="small" onClick={() => onChange({ ...direction, stops: direction.stops.filter((_, j) => j !== i) })} sx={{ p: 0.3 }} aria-label={t("network.remove")}>
              <DeleteOutlineIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Box>
        ))}
      </Box>
      <Autocomplete
        size="small"
        options={stops.filter((s) => !direction.stops.includes(s.id))}
        getOptionLabel={(o) => o.name}
        value={null}
        onChange={(_, s) => s && onChange({ ...direction, stops: [...direction.stops, s.id] })}
        renderInput={(params) => <TextField {...params} label={t("network.addStop")} placeholder={t("network.addStopPlaceholder")} />}
        blurOnSelect
        clearOnBlur
      />
    </Box>
  );
}

export function LinesEditor({ spec, onChange }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const lines = spec.lines || [];
  const stops = spec.stops || [];
  const setLine = (i, patch) => onChange({ ...spec, lines: lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) });
  const addLine = () =>
    onChange({
      ...spec,
      lines: [...lines, { short_name: String(lines.length + 1), mode: "bus", directions: [{ id: "0", headsign: "", stops: [] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "20:00", headway_min: 30 }] }] }],
    });
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.25 }} data-testid="lines-editor">
      {lines.map((line, i) => (
        <Box key={line.id || i} sx={{ borderRadius: 2, border: `1px solid ${alpha(`#${line.color || "1E88E5"}`, 0.6)}`, overflow: "hidden" }} data-testid="line-card">
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1.25, py: 0.75, background: alpha(`#${line.color || "1E88E5"}`, 0.08) }}>
            <Box component="label" sx={{ width: 26, height: 26, borderRadius: "8px", background: `#${line.color || "1E88E5"}`, cursor: "pointer", position: "relative", flexShrink: 0 }} title={t("network.field.color")}>
              <input type="color" value={`#${line.color || "1E88E5"}`} onChange={(e) => setLine(i, { color: e.target.value.replace("#", "").toUpperCase() })} style={{ opacity: 0, position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "pointer" }} />
            </Box>
            <TextField size="small" label={t("network.field.shortName")} value={line.short_name || ""} onChange={(e) => setLine(i, { short_name: e.target.value })} sx={{ width: 110 }} inputProps={{ "data-testid": "line-short-name" }} />
            <TextField size="small" label={t("network.field.longName")} value={line.long_name || ""} onChange={(e) => setLine(i, { long_name: e.target.value })} sx={{ flex: 1, minWidth: 160 }} />
            <TextField select size="small" label={t("network.field.mode")} value={MODES.includes(line.mode) ? line.mode : "bus"} onChange={(e) => setLine(i, { mode: e.target.value })} sx={{ minWidth: 120 }}>
              {MODES.map((m) => (
                <MenuItem key={m} value={m}>
                  {t(`network.mode.${m}`)}
                </MenuItem>
              ))}
            </TextField>
            <Tooltip title={t("network.removeLine")}>
              <IconButton size="small" onClick={() => onChange({ ...spec, lines: lines.filter((_, j) => j !== i) })} aria-label={t("network.removeLine")}>
                <DeleteOutlineIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Tooltip>
          </Box>
          <Box sx={{ p: 1.25, display: "flex", flexDirection: "column", gap: 1 }}>
            <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: "text.secondary" }}>{t("network.section.directions")}</Typography>
            {(line.directions || []).map((d, di) => (
              <DirectionEditor key={di} direction={d} index={di} stops={stops} onChange={(nd) => setLine(i, { directions: line.directions.map((x, k) => (k === di ? nd : x)) })} onRemove={line.directions.length > 1 ? () => setLine(i, { directions: line.directions.filter((_, k) => k !== di) }) : null} />
            ))}
            {(line.directions || []).length < 2 && (
              <Button size="small" startIcon={<AddIcon />} onClick={() => setLine(i, { directions: [...(line.directions || []), { id: "1", headsign: "", stops: [...((line.directions || [])[0]?.stops || [])].reverse() }], round_trip: false })} sx={{ alignSelf: "flex-start", textTransform: "none" }}>
                {t("network.addReturn")}
              </Button>
            )}
            <Typography sx={{ fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, color: "text.secondary", mt: 0.5 }}>{t("network.section.services")}</Typography>
            {(line.services || []).map((s, si) => (
              <ServiceRow key={si} service={s} stopCount={(line.directions?.[0]?.stops || []).length} onChange={(ns) => setLine(i, { services: line.services.map((x, k) => (k === si ? ns : x)) })} onRemove={() => setLine(i, { services: line.services.filter((_, k) => k !== si) })} />
            ))}
            <Button size="small" startIcon={<AddIcon />} onClick={() => setLine(i, { services: [...(line.services || []), { calendar: "saturday", periods: [{ from: "08:00", to: "20:00", headway_min: 30 }] }] })} sx={{ alignSelf: "flex-start", textTransform: "none" }}>
              {t("network.addService")}
            </Button>
          </Box>
        </Box>
      ))}
      <Button variant="outlined" startIcon={<AddIcon />} onClick={addLine} sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 600, borderColor: alpha(theme.palette.primary.main, 0.5) }} data-testid="add-line">
        {t("network.addLine")}
      </Button>
    </Box>
  );
}

// ── Stops ──────────────────────────────────────────────────────────────────

function LocateButton({ stop, near, onPick }) {
  const { t, language } = useLanguage();
  const [anchor, setAnchor] = useState(null);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const run = async (e) => {
    setAnchor(e.currentTarget);
    setLoading(true);
    try {
      const r = await geocodeQuery(stop.address || stop.name, near, language);
      setCandidates(r.candidates || []);
    } catch {
      setCandidates([]);
    } finally {
      setLoading(false);
    }
  };
  return (
    <>
      <Tooltip title={t("network.locate")}>
        <IconButton size="small" onClick={run} data-testid="stop-locate" aria-label={t("network.locate")}>
          {loading ? <CircularProgress size={14} /> : <TravelExploreIcon sx={{ fontSize: 17 }} />}
        </IconButton>
      </Tooltip>
      <Menu open={Boolean(anchor) && candidates !== null && !loading} anchorEl={anchor} onClose={() => setAnchor(null)}>
        {candidates && candidates.length === 0 && <MenuItem disabled>{t("network.noCandidates")}</MenuItem>}
        {(candidates || []).map((c, i) => (
          <MenuItem
            key={i}
            onClick={() => {
              onPick(c.lat, c.lon);
              setAnchor(null);
            }}
            sx={{ fontSize: "0.8rem" }}
          >
            <PlaceOutlinedIcon sx={{ fontSize: 15, mr: 1, color: "text.secondary" }} />
            {c.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export function StopsEditor({ spec, onChange, selectedStopId, onSelectStop, placingStopId, onPlaceRequest, near, existingStops = [] }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const stops = spec.stops || [];
  const setStop = useCallback((i, patch) => onChange({ ...spec, stops: stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) }), [onChange, spec, stops]);
  const used = new Set((spec.lines || []).flatMap((l) => (l.directions || []).flatMap((d) => d.stops || [])));
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }} data-testid="stops-editor">
      {stops.map((s, i) => {
        const located = Number.isFinite(s.lat) && Number.isFinite(s.lon);
        const selected = s.id === selectedStopId;
        return (
          <Box
            key={s.id || i}
            data-testid="stop-row"
            onClick={() => onSelectStop && onSelectStop(s.id)}
            sx={{ display: "flex", alignItems: "center", gap: 0.75, px: 1, py: 0.5, borderRadius: 1.5, border: `1px solid ${alpha(selected ? theme.palette.primary.main : theme.palette.divider, selected ? 0.8 : 1)}`, background: selected ? alpha(theme.palette.primary.main, 0.05) : placingStopId === s.id ? alpha(theme.palette.warning.main, 0.08) : "transparent", cursor: "pointer" }}
          >
            {located ? <CheckCircleOutlineIcon sx={{ fontSize: 16, color: "success.main", flexShrink: 0 }} /> : <ErrorOutlineIcon sx={{ fontSize: 16, color: "warning.main", flexShrink: 0 }} />}
            <TextField size="small" variant="standard" value={s.name || ""} onChange={(e) => setStop(i, { name: e.target.value })} onClick={(e) => e.stopPropagation()} sx={{ flex: 1, minWidth: 120 }} inputProps={{ "data-testid": "stop-name", style: { fontSize: "0.82rem" } }} />
            <Typography sx={{ fontSize: "0.66rem", fontFamily: "monospace", color: "text.disabled", width: 132, textAlign: "right" }}>{located ? `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}` : t("network.noCoordinates")}</Typography>
            {!used.has(s.id) && <Chip size="small" label={t("network.stopUnused")} sx={{ height: 18, fontSize: "0.6rem" }} />}
            <Box onClick={(e) => e.stopPropagation()} sx={{ display: "flex" }}>
              <LocateButton stop={s} near={near} onPick={(lat, lon) => setStop(i, { lat, lon })} />
              <Tooltip title={t("network.placeOnMap")}>
                <IconButton size="small" color={placingStopId === s.id ? "warning" : "default"} onClick={() => onPlaceRequest && onPlaceRequest(placingStopId === s.id ? null : s.id)} data-testid="stop-place" aria-label={t("network.placeOnMap")}>
                  <PlaceOutlinedIcon sx={{ fontSize: 17 }} />
                </IconButton>
              </Tooltip>
              <IconButton size="small" onClick={() => onChange({ ...spec, stops: stops.filter((_, j) => j !== i), lines: (spec.lines || []).map((l) => ({ ...l, directions: (l.directions || []).map((d) => ({ ...d, stops: (d.stops || []).filter((id) => id !== s.id) })) })) })} aria-label={t("network.remove")}>
                <DeleteOutlineIcon sx={{ fontSize: 17 }} />
              </IconButton>
            </Box>
          </Box>
        );
      })}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Button size="small" startIcon={<AddIcon />} onClick={() => onChange({ ...spec, stops: [...stops, { name: t("network.newStop", { n: stops.length + 1 }) }] })} sx={{ textTransform: "none" }} data-testid="add-stop">
          {t("network.addStopRow")}
        </Button>
        {existingStops.length > 0 && (
          <Autocomplete
            size="small"
            sx={{ minWidth: 260, flex: 1 }}
            options={existingStops.filter((s) => s.name && !stops.some((x) => x.id === s.id))}
            getOptionLabel={(o) => `${o.name}${o.kind === "station" ? " (station)" : ""}`}
            value={null}
            onChange={(_, s) => s && onChange({ ...spec, stops: [...stops, { id: s.id, name: s.name, lat: s.lat, lon: s.lon, source: "osm" }] })}
            renderInput={(params) => <TextField {...params} label={t("territory.addExisting")} placeholder={t("territory.addExistingPlaceholder")} inputProps={{ ...params.inputProps, "data-testid": "add-existing-stop" }} />}
            blurOnSelect
            clearOnBlur
          />
        )}
      </Box>
    </Box>
  );
}

// ── JSON ───────────────────────────────────────────────────────────────────

export function JsonEditor({ spec, onChange }) {
  const { t } = useLanguage();
  const [text, setText] = useState(() => JSON.stringify(spec, null, 2));
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const apply = () => {
    try {
      const parsed = JSON.parse(text);
      setError(null);
      setDirty(false);
      onChange(parsed);
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, height: "100%" }}>
      <TextField
        multiline
        fullWidth
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        inputProps={{ "data-testid": "spec-json", style: { fontFamily: "monospace", fontSize: "0.72rem", lineHeight: 1.4 } }}
        minRows={18}
        maxRows={40}
      />
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Button size="small" variant="contained" disableElevation disabled={!dirty} onClick={apply} sx={{ textTransform: "none", fontWeight: 700 }} data-testid="spec-json-apply">
          {t("network.applyJson")}
        </Button>
        <Button size="small" onClick={() => { setText(JSON.stringify(spec, null, 2)); setDirty(false); setError(null); }} sx={{ textTransform: "none" }}>
          {t("network.reloadJson")}
        </Button>
        {error && <Typography sx={{ fontSize: "0.74rem", color: "error.main" }}>{error}</Typography>}
      </Box>
    </Box>
  );
}
