/**
 * SpecEditors — the reviewable, editable plan: lines (names, mode, colour,
 * stop order, services), stops (name, coordinates: geocode candidates, place
 * on the map) and the raw JSON for power users. Every edit mutates the spec
 * held by the studio, which re-validates it.
 *
 * Same rules as the side panel (StudioUI): no outlined boxes inside the
 * region — sections separated by hairlines and spacing, fields as soft fills
 * with a focus ring, secondary actions revealed on hover.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Autocomplete, Box, Button, ButtonBase, CircularProgress, IconButton, InputBase, Menu, MenuItem, Select, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AddIcon from "@mui/icons-material/Add";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import TravelExploreIcon from "@mui/icons-material/TravelExplore";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import SearchIcon from "@mui/icons-material/Search";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { geocodeQuery } from "../../utils/networkStudioApi";
import { QuietButton, SectionHeader, Tag, soft } from "./StudioUI";

export const MODES = ["bus", "coach", "express", "shuttle", "trolleybus", "tram", "metro", "rail", "ferry", "cable", "gondola", "funicular", "monorail"];
export const CALENDARS = ["weekday", "saturday", "sunday", "weekend", "daily", "monsat"];

// Calendars as the server names them once normalised (networkSpec NAMED_CALENDARS).
const CAL_BY_ID = { WKD: "weekday", SAT: "saturday", SUN: "sunday", WKE: "weekend", DAILY: "daily", MONSAT: "monsat" };
const CAL_DAYS = { weekday: ["mon", "tue", "wed", "thu", "fri"], saturday: ["sat"], sunday: ["sun"], weekend: ["sat", "sun"], daily: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], monsat: ["mon", "tue", "wed", "thu", "fri", "sat"] };
const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const calendarName = (cal) => (typeof cal === "string" ? (CALENDARS.includes(cal) ? cal : CAL_BY_ID[cal] || null) : null);
const sameDays = (a, b) => a.length === b.length && a.every((d) => b.includes(d));

/** "mon…fri" → "Mon–Fri", "sun…thu" → "Sun–Thu", "sat, sun" → "Sat, Sun", in the reader's language. */
const daysLabel = (days, language) => {
  const idx = [...new Set(days.map((d) => WEEK.indexOf(String(d).slice(0, 3).toLowerCase())).filter((i) => i >= 0))];
  if (!idx.length) return "—";
  const name = (i) => {
    try {
      return new Intl.DateTimeFormat(language, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + i)));
    } catch {
      return WEEK[i];
    }
  };
  // A cyclic run of 3+ days reads as a range (a Fri–Sat weekend makes Sun–Thu).
  if (idx.length >= 3 && idx.length < 7) {
    const start = idx.find((i) => !idx.includes((i + 6) % 7));
    if (start != null && idx.every((_, k) => idx.includes((start + k) % 7))) return `${name(start)}–${name((start + idx.length - 1) % 7)}`;
  }
  if (idx.length === 7) return `${name(0)}–${name(6)}`;
  return idx.sort((a, b) => a - b).map(name).join(", ");
};

/**
 * A service's days, never a raw key: named calendars are translated, unless
 * the spec defines them on other days (a local Fri–Sat weekend turns
 * "weekday" into Sun–Thu); custom calendars show their days.
 */
const calendarLabel = (t, cal, { calendars = [], language = "en" } = {}) => {
  if (cal && typeof cal === "object") return Array.isArray(cal.days) ? daysLabel(cal.days, language) : "—";
  if (typeof cal !== "string" || !cal) return "—";
  const name = calendarName(cal);
  const def = calendars.find((c) => c && (c.id === cal || (name && c.id === Object.keys(CAL_BY_ID).find((id) => CAL_BY_ID[id] === name))));
  if (name && !(def?.days && !sameDays(def.days, CAL_DAYS[name]))) return t(`network.calendar.${name}`);
  if (def?.days) return daysLabel(def.days, language);
  return cal;
};

// ── Fields: soft fills, no outline ─────────────────────────────────────────

const fieldSx = (theme, { ghost = false, strength = 1 } = {}) => ({
  fontSize: "0.8rem",
  borderRadius: "8px",
  px: 1,
  py: 0.2,
  background: ghost ? "transparent" : soft(theme, strength),
  // Invisible, except in forced-colours mode where it draws the field and its focus.
  outline: "1px solid transparent",
  transition: "background 120ms, box-shadow 120ms",
  "&:hover": { background: soft(theme, ghost ? 1 : strength + 0.8) },
  "&.Mui-focused": { background: theme.palette.background.paper, boxShadow: `0 0 0 2px ${alpha(theme.palette.primary.main, 0.45)}`, outline: "2px solid transparent" },
  "& input": { p: 0, py: 0.5 },
  // The placeholder is the field's only visible label: readable, not faded.
  "& input::placeholder": { color: theme.palette.text.secondary, opacity: 1 },
});

/** A text field without a box: the label is its placeholder and accessible name. */
function Field({ value, onChange, label, width = null, mono = false, ghost = false, strength = 1, testid = undefined, sx = {}, inputSx = {}, inputProps = {}, ...rest }) {
  const theme = useTheme();
  return (
    <InputBase
      {...rest}
      value={value}
      onChange={onChange}
      placeholder={label}
      inputProps={{ "aria-label": label, "data-testid": testid, style: mono ? { fontVariantNumeric: "tabular-nums" } : undefined, ...inputProps }}
      sx={{ ...fieldSx(theme, { ghost, strength }), ...(width ? { width } : {}), "& input": { p: 0, py: 0.5, ...inputSx }, ...sx }}
    />
  );
}

/** A compact select on the same soft fill. */
function SelectField({ value, onChange, label, children, ghost = false, strength = 1, minWidth = 0, testid = undefined, sx = {} }) {
  const theme = useTheme();
  return (
    <Select
      value={value}
      onChange={onChange}
      input={<InputBase sx={{ ...fieldSx(theme, { ghost, strength }), minWidth, "& .MuiSelect-select": { py: 0.5, pr: "24px !important" }, ...sx }} />}
      inputProps={{ "data-testid": testid }}
      SelectDisplayProps={{ "aria-label": label }}
      MenuProps={{ PaperProps: { sx: { maxHeight: 360 } } }}
    >
      {children}
    </Select>
  );
}

/**
 * Actions that appear on hover or focus of their own row (always on touch
 * screens). Each nesting level has its own class, so hovering a line does
 * not reveal the actions of every stop inside it.
 */
const reveal = (cls) => ({
  [`& .${cls}`]: { opacity: 0, transition: "opacity 120ms" },
  [`&:hover .${cls}, &:focus-within .${cls}`]: { opacity: 1 },
  "@media (hover: none)": { [`& .${cls}`]: { opacity: 1 } },
});

/** Read by screen readers, not shown. */
const visuallyHidden = { position: "absolute", width: 1, height: 1, p: 0, m: "-1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 };

const lineColor = (line) => `#${line?.color || "1E88E5"}`;
const readableOn = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#fff";
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#1a1a1a" : "#fff";
};

/** A line's badge: its colour and short name, as passengers see it. */
export function LineBadge({ line, size = "small" }) {
  const bg = lineColor(line);
  return (
    <Box component="span" sx={{ display: "inline-flex", alignItems: "center", justifyContent: "center", minWidth: size === "small" ? 22 : 30, height: size === "small" ? 18 : 26, px: 0.6, borderRadius: "6px", background: bg, color: line?.text_color ? `#${line.text_color}` : readableOn(bg), fontSize: size === "small" ? "0.64rem" : "0.8rem", fontWeight: 800, lineHeight: 1 }}>
      {line?.short_name || "?"}
    </Box>
  );
}

// ── Lines ──────────────────────────────────────────────────────────────────

function PeriodPill({ period, onChange, onRemove }) {
  const { t } = useLanguage();
  const theme = useTheme();
  return (
    <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.25, pl: 0.5, pr: 0.25, py: 0.25, borderRadius: "10px", background: soft(theme), fontSize: "0.78rem", color: "text.secondary", ...reveal("rv-period") }}>
      <Field value={period.from || ""} onChange={(e) => onChange({ from: e.target.value })} label={t("network.field.from")} width={50} mono ghost sx={{ px: 0.5 }} inputSx={{ textAlign: "center" }} />
      <span>–</span>
      <Field value={period.to || ""} onChange={(e) => onChange({ to: e.target.value })} label={t("network.field.to")} width={50} mono ghost sx={{ px: 0.5 }} inputSx={{ textAlign: "center" }} />
      <Box component="span" sx={{ mx: 0.25, color: "text.disabled" }}>
        ·
      </Box>
      <span>{t("network.period.everyBefore")}</span>
      <Field value={period.headway_min ?? ""} onChange={(e) => onChange({ headway_min: Number(e.target.value) })} label={t("network.field.headway")} width={38} mono ghost sx={{ px: 0.5 }} type="number" inputProps={{ min: 1, max: 720 }} inputSx={{ textAlign: "center", MozAppearance: "textfield", "&::-webkit-inner-spin-button, &::-webkit-outer-spin-button": { WebkitAppearance: "none", m: 0 } }} />
      <span>{t("network.period.everyAfter")}</span>
      <IconButton className="rv-period" size="small" onClick={onRemove} aria-label={t("network.remove")} sx={{ p: 0.25, ml: 0.25 }}>
        <DeleteOutlineIcon sx={{ fontSize: 15 }} />
      </IconButton>
    </Box>
  );
}

function ServiceRow({ service, stopCount, calendars, onChange, onRemove }) {
  const { t, language } = useLanguage();
  const hintId = useId();
  const periods = service.periods || [];
  const departures = service.departures || [];
  const cal = service.calendar ?? service.calendar_id ?? "weekday";
  const named = calendarName(cal);
  const setPeriod = (i, patch) => onChange({ ...service, periods: periods.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  return (
    <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "max-content 1fr" }, columnGap: 2, rowGap: 0.75, py: 1, alignItems: "start", ...reveal("rv-service") }} data-testid="line-service">
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
        <SelectField value={named || "__custom"} onChange={(e) => e.target.value !== "__custom" && onChange({ ...service, calendar: e.target.value })} label={t("network.field.calendar")} ghost sx={{ fontWeight: 700 }}>
          {/* A calendar the list does not name (custom days) stays shown as it is. */}
          {!named && <MenuItem value="__custom">{calendarLabel(t, cal, { calendars, language })}</MenuItem>}
          {CALENDARS.map((c) => (
            <MenuItem key={c} value={c}>
              {calendarLabel(t, c, { calendars, language })}
            </MenuItem>
          ))}
        </SelectField>
        <SelectField value={service.direction || "both"} onChange={(e) => onChange({ ...service, direction: e.target.value })} label={t("network.field.direction")} ghost sx={{ color: "text.secondary" }}>
          <MenuItem value="both">{t("network.direction.both")}</MenuItem>
          <MenuItem value="0">{t("network.directionN", { n: 0 })}</MenuItem>
          <MenuItem value="1">{t("network.directionN", { n: 1 })}</MenuItem>
        </SelectField>
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
          {periods.map((p, i) => (
            <PeriodPill key={i} period={p} onChange={(patch) => setPeriod(i, patch)} onRemove={() => onChange({ ...service, periods: periods.filter((_, j) => j !== i) })} />
          ))}
          <QuietButton startIcon={<AddIcon sx={{ fontSize: "16px !important" }} />} onClick={() => onChange({ ...service, periods: [...periods, { from: periods.length ? periods[periods.length - 1].to : "06:00", to: "20:00", headway_min: 30 }] })}>
            {t("network.addPeriod")}
          </QuietButton>
          <Box sx={{ flex: 1 }} />
          <Tooltip title={t("network.removeService")}>
            <IconButton className="rv-service" size="small" onClick={onRemove} aria-label={t("network.remove")}>
              <DeleteOutlineIcon sx={{ fontSize: 17 }} />
            </IconButton>
          </Tooltip>
        </Box>
        <Tooltip title={t("network.service.hint", { stops: stopCount })} placement="bottom-start" describeChild>
          <Box sx={{ maxWidth: 520 }}>
            <Field value={departures.join(", ")} onChange={(e) => onChange({ ...service, departures: e.target.value.split(/[,\s;]+/).map((s) => s.trim()).filter(Boolean) })} label={`${t("network.field.departures")} — 07:30, 12:15, 17:30`} mono ghost inputProps={{ "aria-describedby": hintId }} sx={{ width: "100%" }} />
          </Box>
        </Tooltip>
        <Box component="span" id={hintId} sx={visuallyHidden}>
          {t("network.service.hint", { stops: stopCount })}
        </Box>
      </Box>
    </Box>
  );
}

function DirectionEditor({ direction, index, stops, color, onChange, onRemove, mirrorOf = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  // A return that only reverses the outbound shows as one line until the user edits its order.
  const [editOrder, setEditOrder] = useState(false);
  // "Edit the order" replaces its own button: focus moves to the list it reveals.
  const listRef = useRef(null);
  useEffect(() => {
    if (editOrder) listRef.current?.focus();
  }, [editOrder]);
  const names = new Map(stops.map((s) => [s.id, s.name]));
  const move = (i, delta) => {
    const arr = [...direction.stops];
    const j = i + delta;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    onChange({ ...direction, stops: arr });
  };
  const last = direction.stops.length - 1;
  return (
    <Box sx={{ p: 1.25, borderRadius: "12px", background: soft(theme, 0.9), display: "flex", flexDirection: "column", gap: 0.75, minWidth: 0 }} data-testid="line-direction">
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, ...reveal("rv-dir") }}>
        <Tag color={theme.palette.text.secondary}>{t("network.directionN", { n: direction.id ?? index })}</Tag>
        <Field value={direction.headsign || ""} onChange={(e) => onChange({ ...direction, headsign: e.target.value })} label={t("network.field.headsign")} ghost sx={{ flex: 1, fontWeight: 700, fontSize: "0.84rem" }} />
        {onRemove && (
          <IconButton className="rv-dir" size="small" onClick={onRemove} aria-label={t("network.remove")}>
            <DeleteOutlineIcon sx={{ fontSize: 17 }} />
          </IconButton>
        )}
      </Box>
      {mirrorOf != null && !editOrder ? (
        <Box data-testid="direction-mirror" sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", pl: 0.5, fontSize: "0.78rem", color: "text.secondary" }}>
          <span>{t("network.direction.mirror", { n: mirrorOf, count: direction.stops.length })}</span>
          <QuietButton onClick={() => setEditOrder(true)} data-testid="direction-mirror-edit">
            {t("network.direction.editOrder")}
          </QuietButton>
        </Box>
      ) : (
        <>
      <Box component="ol" ref={listRef} tabIndex={-1} aria-label={t("network.directionN", { n: direction.id ?? index })} sx={{ listStyle: "none", m: 0, p: 0, outline: "none" }}>
        {direction.stops.map((id, i) => (
          <Box component="li" key={`${id}-${i}`} sx={{ display: "flex", alignItems: "center", gap: 0.75, minHeight: 28, fontSize: "0.8rem", borderRadius: "8px", pr: 0.25, "&:hover": { background: soft(theme, 1.2) }, ...reveal("rv-stop") }}>
            {/* Timeline: the line's colour, filled dots at the termini. */}
            <Box sx={{ position: "relative", width: 18, alignSelf: "stretch", flexShrink: 0 }}>
              {i > 0 && <Box sx={{ position: "absolute", left: 8, top: 0, height: "50%", width: 2, background: alpha(color, 0.55) }} />}
              {i < last && <Box sx={{ position: "absolute", left: 8, top: "50%", height: "50%", width: 2, background: alpha(color, 0.55) }} />}
              <Box sx={{ position: "absolute", left: 4, top: "50%", mt: "-5px", width: 10, height: 10, borderRadius: "50%", border: `2px solid ${color}`, background: i === 0 || i === last ? color : theme.palette.background.paper }} />
            </Box>
            <Box sx={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: i === 0 || i === last ? 700 : 400 }}>{names.get(id) || id}</Box>
            <Box className="rv-stop" sx={{ display: "flex" }}>
              <IconButton size="small" onClick={() => move(i, -1)} disabled={i === 0} sx={{ p: 0.3 }} aria-label="up">
                <ArrowUpwardIcon sx={{ fontSize: 14 }} />
              </IconButton>
              <IconButton size="small" onClick={() => move(i, 1)} disabled={i === last} sx={{ p: 0.3 }} aria-label="down">
                <ArrowDownwardIcon sx={{ fontSize: 14 }} />
              </IconButton>
              <IconButton size="small" onClick={() => onChange({ ...direction, stops: direction.stops.filter((_, j) => j !== i) })} sx={{ p: 0.3 }} aria-label={t("network.remove")}>
                <DeleteOutlineIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </Box>
          </Box>
        ))}
      </Box>
      <Autocomplete
        size="small"
        options={stops.filter((s) => !direction.stops.includes(s.id))}
        getOptionLabel={(o) => o.name}
        value={null}
        onChange={(_, s) => s && onChange({ ...direction, stops: [...direction.stops, s.id] })}
        renderInput={(params) => (
          <InputBase ref={params.InputProps.ref} inputProps={{ ...params.inputProps, "aria-label": t("network.addStop") }} placeholder={t("network.addStop")} startAdornment={<AddIcon sx={{ fontSize: 16, color: "text.secondary", mr: 0.5 }} />} sx={{ ...fieldSx(theme, { ghost: true }), color: "text.secondary", width: "100%" }} />
        )}
        blurOnSelect
        clearOnBlur
      />
        </>
      )}
    </Box>
  );
}

/** The return serves the outbound's stops in reverse order, nothing else. */
const isMirror = (a, b) => {
  const x = a?.stops || [];
  const y = b?.stops || [];
  return x.length > 1 && x.length === y.length && x.every((id, i) => id === y[y.length - 1 - i]);
};

/** One line of the plan: a header always visible, the details on demand. */
function LineSection({ line, stops, calendars, defaultOpen, onChange, onRemove }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [open, setOpen] = useState(defaultOpen);
  const color = lineColor(line);
  const directions = line.directions || [];
  const services = line.services || [];
  const set = (patch) => onChange({ ...line, ...patch });
  // A new colour gets a readable text colour with it (route_text_color in the feed).
  const setColor = (hex) => set({ color: hex, text_color: readableOn(`#${hex}`) === "#fff" ? "FFFFFF" : "000000" });
  // "8 stops · Monday–Friday 06:00–20:00 · every 30 min (+1)": the line at a glance, collapsed or not.
  const first = services[0];
  const period = first?.periods?.[0];
  const summary = [
    t("network.line.stops", { count: (directions[0]?.stops || []).length }),
    first ? `${calendarLabel(t, first.calendar ?? first.calendar_id ?? "weekday", { calendars, language })}${period ? ` ${period.from}–${period.to} · ${t("network.period.every", { min: period.headway_min })}` : ""}${services.length > 1 ? ` (+${services.length - 1})` : ""}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const ring = `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 4px ${alpha(theme.palette.primary.main, 0.6)}`;

  return (
    <Box data-testid="line-card" sx={{ borderBottom: `1px solid ${alpha(theme.palette.divider, 0.7)}` }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 1.25, ...reveal("rv-line") }}>
        <IconButton size="small" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={t(open ? "network.line.collapse" : "network.line.expand")} sx={{ color: "text.secondary" }}>
          <ExpandMoreIcon sx={{ fontSize: 20, transform: open ? "none" : "rotate(-90deg)", transition: "transform 150ms" }} />
        </IconButton>
        {/* The badge is the short name field, on the line's colour; the dot beside it picks the colour. */}
        <Tooltip title={t("network.field.color")}>
          <Box component="label" sx={{ width: 14, height: 14, borderRadius: "50%", background: color, cursor: "pointer", position: "relative", flexShrink: 0, boxShadow: `0 0 0 2px ${theme.palette.background.paper}, 0 0 0 3px ${alpha(color, 0.35)}`, "&:focus-within": { boxShadow: ring } }}>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value.replace("#", "").toUpperCase())} style={{ opacity: 0, position: "absolute", inset: 0, width: "100%", height: "100%", cursor: "pointer" }} aria-label={t("network.field.color")} />
          </Box>
        </Tooltip>
        <InputBase
          value={line.short_name || ""}
          onChange={(e) => set({ short_name: e.target.value })}
          inputProps={{ "data-testid": "line-short-name", "aria-label": t("network.field.shortName") }}
          sx={{ borderRadius: "8px", background: color, color: line.text_color ? `#${line.text_color}` : readableOn(color), fontWeight: 800, fontSize: "0.9rem", px: 0.75, outline: "1px solid transparent", "& input": { p: 0, py: 0.4, textAlign: "center", width: `${Math.max(1.5, (line.short_name || "").length * 0.72 + 0.6)}em` }, "&.Mui-focused": { boxShadow: ring, outline: "2px solid transparent" } }}
        />
        <Field value={line.long_name || ""} onChange={(e) => set({ long_name: e.target.value })} label={t("network.field.longName")} ghost sx={{ flex: 1, minWidth: 120, fontWeight: 700, fontSize: "0.9rem" }} />
        {/* A mouse shortcut: the chevron is the keyboard control (it carries aria-expanded). */}
        <ButtonBase tabIndex={-1} aria-hidden onClick={() => setOpen((v) => !v)} sx={{ display: { xs: "none", md: "block" }, fontSize: "0.74rem", color: "text.secondary", borderRadius: 1, px: 0.5, maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "right" }}>
          {summary}
        </ButtonBase>
        <SelectField value={MODES.includes(line.mode) ? line.mode : "bus"} onChange={(e) => set({ mode: e.target.value })} label={t("network.field.mode")} ghost sx={{ color: "text.secondary" }}>
          {MODES.map((m) => (
            <MenuItem key={m} value={m}>
              {t(`network.mode.${m}`)}
            </MenuItem>
          ))}
        </SelectField>
        <Tooltip title={t("network.removeLine")}>
          <IconButton className="rv-line" size="small" onClick={onRemove} aria-label={t("network.removeLine")}>
            <DeleteOutlineIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
      </Box>
      {open && (
        <Box sx={{ pl: { xs: 0, md: 5 }, pb: 2, display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "1fr 1fr" }, gap: 1.25, alignItems: "start" }}>
            {directions.map((d, di) => (
              <DirectionEditor key={di} direction={d} index={di} stops={stops} color={color} mirrorOf={di === 1 && isMirror(directions[0], d) ? directions[0].id ?? 0 : null} onChange={(nd) => set({ directions: directions.map((x, k) => (k === di ? nd : x)) })} onRemove={directions.length > 1 ? () => set({ directions: directions.filter((_, k) => k !== di) }) : null} />
            ))}
            {directions.length < 2 && (
              <Box>
                <QuietButton startIcon={<AddIcon sx={{ fontSize: "16px !important" }} />} onClick={() => set({ directions: [...directions, { id: "1", headsign: "", stops: [...(directions[0]?.stops || [])].reverse() }], round_trip: false })}>
                  {t("network.addReturn")}
                </QuietButton>
              </Box>
            )}
          </Box>
          <Box>
            <SectionHeader label={t("network.section.services")} right={<QuietButton startIcon={<AddIcon sx={{ fontSize: "16px !important" }} />} onClick={() => set({ services: [...services, { calendar: "saturday", periods: [{ from: "08:00", to: "20:00", headway_min: 30 }] }] })}>{t("network.addService")}</QuietButton>} />
            <Box sx={{ "& > * + *": { borderTop: `1px solid ${alpha(theme.palette.divider, 0.5)}` } }}>
              {services.map((s, si) => (
                <ServiceRow key={si} service={s} stopCount={(directions[0]?.stops || []).length} calendars={calendars} onChange={(ns) => set({ services: services.map((x, k) => (k === si ? ns : x)) })} onRemove={() => set({ services: services.filter((_, k) => k !== si) })} />
              ))}
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
}

let keySeq = 0;
const newKey = () => `line-${++keySeq}`;

export function LinesEditor({ spec, onChange }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const lines = spec.lines || [];
  const stops = spec.stops || [];
  // Stable keys for the sections (lines often have no id): open/closed and
  // "edit order" stay with their line when another one is removed. Lines
  // replaced from outside (assistant, JSON, import) get fresh keys.
  const [keys, setKeys] = useState(() => lines.map(() => newKey()));
  useEffect(() => {
    if (keys.length !== lines.length) setKeys(Array.from({ length: lines.length }, () => newKey()));
  }, [keys.length, lines.length]);
  const keyOf = (i) => (keys.length === lines.length ? keys[i] : `pending-${i}`);
  const addLine = () => {
    setKeys((k) => [...k, newKey()]);
    onChange({
      ...spec,
      lines: [...lines, { short_name: String(lines.length + 1), mode: "bus", directions: [{ id: "0", headsign: "", stops: [] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "20:00", headway_min: 30 }] }] }],
    });
  };
  const removeLine = (i) => {
    setKeys((k) => k.filter((_, j) => j !== i));
    onChange({ ...spec, lines: lines.filter((_, j) => j !== i) });
  };
  const syncStop = spec.sync && spec.sync !== false ? spec.sync.stop_id || spec.sync.stop || "" : "";
  const setSync = (stop, minute) => onChange({ ...spec, sync: stop ? { stop, minute: Number.isFinite(minute) ? minute : 0 } : undefined });
  return (
    <Box sx={{ maxWidth: 1120, mx: "auto", display: "flex", flexDirection: "column", gap: 1 }} data-testid="lines-editor">
      {lines.length > 0 && stops.length > 0 && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", px: 1.5, py: 1, borderRadius: "12px", background: soft(theme) }} data-testid="sync-editor">
          <HubOutlinedIcon sx={{ fontSize: 18, color: "text.secondary" }} />
          <Typography sx={{ fontSize: "0.8rem", fontWeight: 700 }}>{t("network.sync.title")}</Typography>
          <Tooltip title={t("network.sync.hint")}>
            <IconButton size="small" aria-label={t("network.sync.hint")} sx={{ p: 0.25, color: "text.disabled" }}>
              <InfoOutlinedIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Tooltip>
          <Box sx={{ flex: 1 }} />
          <SelectField value={stops.some((s) => s.id === syncStop) ? syncStop : ""} onChange={(e) => setSync(e.target.value, spec.sync?.minute)} label={t("network.sync.title")} minWidth={220} strength={0} testid="sync-stop" sx={{ background: theme.palette.background.paper }}>
            <MenuItem value="">{t("network.sync.none")}</MenuItem>
            {stops.map((s) => (
              <MenuItem key={s.id} value={s.id}>
                {s.name}
              </MenuItem>
            ))}
          </SelectField>
          {syncStop && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, fontSize: "0.78rem", color: "text.secondary" }}>
              {t("network.sync.minute")}
              <Field value={spec.sync?.minute ?? 0} onChange={(e) => setSync(syncStop, Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0)))} label={t("network.sync.minute")} width={52} mono type="number" testid="sync-minute" inputProps={{ min: 0, max: 59 }} sx={{ background: theme.palette.background.paper }} inputSx={{ textAlign: "center" }} />
            </Box>
          )}
        </Box>
      )}
      <Box>
        {lines.map((line, i) => (
          // Open when there are few lines, and a line without stops yet (just added) so its stops can be picked.
          <LineSection key={keyOf(i)} line={line} stops={stops} calendars={spec.calendars || []} defaultOpen={lines.length <= 2 || !(line.directions?.[0]?.stops || []).length} onChange={(nl) => onChange({ ...spec, lines: lines.map((l, j) => (j === i ? nl : l)) })} onRemove={() => removeLine(i)} />
        ))}
      </Box>
      <QuietButton startIcon={<AddIcon />} onClick={addLine} data-testid="add-line" sx={{ alignSelf: "flex-start", mt: 0.5 }}>
        {t("network.addLine")}
      </QuietButton>
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

const STOP_GRID = { xs: "12px minmax(0, 1fr) 96px", md: "12px minmax(200px, 1fr) minmax(90px, 280px) 96px" };

export function StopsEditor({ spec, onChange, selectedStopId, onSelectStop, placingStopId, onPlaceRequest, near, existingStops = [] }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [filter, setFilter] = useState("");
  // The row being renamed stays listed even when its new name no longer matches the filter.
  const [editing, setEditing] = useState(null);
  const stops = spec.stops || [];
  const setStop = useCallback((i, patch) => onChange({ ...spec, stops: stops.map((s, j) => (j === i ? { ...s, ...patch } : s)) }), [onChange, spec, stops]);
  // Which lines serve each stop: shown as badges, and "not served" otherwise.
  const linesAt = useMemo(() => {
    const m = new Map();
    for (const l of spec.lines || []) for (const d of l.directions || []) for (const id of d.stops || []) {
      if (!m.has(id)) m.set(id, []);
      if (!m.get(id).includes(l)) m.get(id).push(l);
    }
    return m;
  }, [spec.lines]);
  const missing = stops.filter((s) => !(Number.isFinite(s.lat) && Number.isFinite(s.lon))).length;
  const unused = stops.filter((s) => !linesAt.has(s.id)).length;
  // The filter applies only while its field is on screen (long lists), so it can always be cleared.
  const showFilter = stops.length > 8 || Boolean(filter);
  const q = showFilter ? filter.trim().toLowerCase() : "";
  const rows = stops.map((s, i) => ({ s, i })).filter(({ s, i }) => !q || i === editing || String(s.name || "").toLowerCase().includes(q) || String(s.id || "").toLowerCase().includes(q));
  // A stop added while the list is filtered must be seen: adding clears the filter.
  const addStops = (added) => {
    setFilter("");
    onChange({ ...spec, stops: [...stops, ...added] });
  };
  const head = { fontSize: "0.64rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "text.secondary" };

  return (
    <Box sx={{ maxWidth: 1120, mx: "auto", display: "flex", flexDirection: "column", gap: 1 }} data-testid="stops-editor">
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.5, flexWrap: "wrap" }}>
        <Typography sx={{ fontSize: "0.8rem", fontWeight: 700 }}>{t("network.stops.count", { count: stops.length })}</Typography>
        {missing > 0 && <Tag color={theme.palette.warning.dark}>{t("network.stops.missing", { count: missing })}</Tag>}
        {unused > 0 && <Tag color={theme.palette.text.secondary}>{t("network.stops.unused", { count: unused })}</Tag>}
        <Box sx={{ flex: 1 }} />
        {showFilter && <Field value={filter} onChange={(e) => setFilter(e.target.value)} label={t("network.stops.filter")} startAdornment={<SearchIcon sx={{ fontSize: 16, color: "text.secondary", mr: 0.5 }} />} sx={{ width: 240 }} testid="stops-filter" />}
      </Box>
      <Box>
        <Box sx={{ display: "grid", gridTemplateColumns: STOP_GRID, columnGap: 1.5, alignItems: "center", px: 1, py: 0.75, borderBottom: `1px solid ${alpha(theme.palette.divider, 0.8)}` }}>
          <span />
          <Typography sx={head}>{t("network.stops.col.name")}</Typography>
          <Typography sx={{ ...head, display: { xs: "none", md: "block" } }}>{t("network.stops.col.lines")}</Typography>
          <span />
        </Box>
        {rows.map(({ s, i }) => {
          const located = Number.isFinite(s.lat) && Number.isFinite(s.lon);
          const selected = s.id === selectedStopId;
          const placing = placingStopId === s.id;
          const served = linesAt.get(s.id) || [];
          return (
            <Box
              key={s.id || i}
              data-testid="stop-row"
              onClick={() => onSelectStop && onSelectStop(s.id)}
              sx={{ display: "grid", gridTemplateColumns: STOP_GRID, columnGap: 1.5, alignItems: "center", px: 1, minHeight: 40, cursor: "pointer", borderBottom: `1px solid ${alpha(theme.palette.divider, 0.45)}`, background: placing ? alpha(theme.palette.warning.main, 0.08) : selected ? alpha(theme.palette.primary.main, 0.06) : "transparent", transition: "background 120ms", "&:hover": { background: placing ? alpha(theme.palette.warning.main, 0.1) : selected ? alpha(theme.palette.primary.main, 0.08) : soft(theme) }, ...reveal("rv-row") }}
            >
              <Tooltip title={located ? `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}` : t("network.noCoordinates")}>
                <Box sx={{ width: 8, height: 8, borderRadius: "50%", background: located ? theme.palette.success.main : theme.palette.warning.main }} />
              </Tooltip>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
                <Field value={s.name || ""} onChange={(e) => setStop(i, { name: e.target.value })} onClick={(e) => e.stopPropagation()} onFocus={() => setEditing(i)} onBlur={() => setEditing(null)} label={t("network.stops.col.name")} ghost testid="stop-name" sx={{ flex: 1, fontWeight: selected ? 700 : 500, minWidth: 0 }} />
                {!located && <Tag color={theme.palette.warning.dark}>{t("network.noCoordinates")}</Tag>}
              </Box>
              <Box sx={{ display: { xs: "none", md: "flex" }, gap: 0.4, flexWrap: "wrap", alignItems: "center" }}>
                {served.length ? served.map((l) => <LineBadge key={l.id || l.short_name} line={l} />) : <Tag color={theme.palette.text.secondary}>{t("network.stopUnused")}</Tag>}
              </Box>
              <Box onClick={(e) => e.stopPropagation()} className={located && !placing ? "rv-row" : undefined} sx={{ display: "flex", justifyContent: "flex-end" }}>
                <LocateButton stop={s} near={near} onPick={(lat, lon) => setStop(i, { lat, lon })} />
                <Tooltip title={t("network.placeOnMap")}>
                  <IconButton size="small" color={placing ? "warning" : "default"} onClick={() => onPlaceRequest && onPlaceRequest(placing ? null : s.id)} data-testid="stop-place" aria-label={t("network.placeOnMap")}>
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
        {q && rows.length === 0 && <Typography sx={{ px: 1, py: 2, fontSize: "0.78rem", color: "text.secondary" }}>{t("network.stops.noMatch")}</Typography>}
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", mt: 0.5 }}>
        <QuietButton startIcon={<AddIcon />} onClick={() => addStops([{ name: t("network.newStop", { n: stops.length + 1 }) }])} data-testid="add-stop">
          {t("network.addStopRow")}
        </QuietButton>
        {existingStops.length > 0 && (
          <Autocomplete
            size="small"
            sx={{ minWidth: 280, flex: 1, maxWidth: 480 }}
            options={existingStops.filter((s) => s.name && !stops.some((x) => x.id === s.id))}
            getOptionLabel={(o) => `${o.name}${o.kind === "station" ? " (station)" : ""}`}
            value={null}
            onChange={(_, s) => s && addStops([{ id: s.id, name: s.name, lat: s.lat, lon: s.lon, source: "osm" }])}
            renderInput={(params) => (
              <InputBase ref={params.InputProps.ref} inputProps={{ ...params.inputProps, "data-testid": "add-existing-stop", "aria-label": t("territory.addExisting") }} placeholder={t("territory.addExisting")} startAdornment={<SearchIcon sx={{ fontSize: 16, color: "text.secondary", mr: 0.5 }} />} sx={{ ...fieldSx(theme), width: "100%" }} />
            )}
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
