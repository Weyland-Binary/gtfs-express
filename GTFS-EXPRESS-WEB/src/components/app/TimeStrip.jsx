/**
 * The strip of the network's days under the reader: one bar a date (its height the trips run, its colour the day
 * class), the months along it, the day shown as a cursor, today marked, the classes named beside it. A click, a drag
 * or the keys choose the day every screen of the network then reads. The line's trips when one is chosen, else the
 * network's. Hidden or shown from the status bar's toggle (utils/timeStripPref).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Typography, alpha, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { getDraftSession, getSessionId } from "../../utils/sessionManager";
import { classLabelOf, useNetworkDays } from "../../utils/networkDays";
import { useTimeStripHidden } from "../../utils/timeStripPref";
import { localeOf } from "../../utils/formatDate";

export const STRIP_HEIGHT = 64;
const FLAG_H = 14;
const BARS_H = 32;
const MIN_BAR = 2;
const LABEL_GAP = 30;
const SCHEME_OF = { weekday: "weekday", holiday_weekday: "exception", saturday: "saturday", sunday_holiday: "sunday" };
const STEPS = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -7, ArrowUp: 7, PageDown: -30, PageUp: 30 };
// Pinned to the foot of the reader's column (mt auto, sticky): the screen above it changes height while its data
// loads, and the strip must not move with it.
const PINNED = { flexShrink: 0, mt: "auto", position: "sticky", bottom: 0, zIndex: 1, borderTop: 1, borderColor: "divider", bgcolor: "background.paper" };

const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dateOf = (iso) => new Date(`${iso}T12:00:00`);

export default function TimeStrip({ selectedDate, onDateChange, routeId = null, routeLabel = "", enabled = true }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { dataVersion } = useEditMode();
  const key = `${getDraftSession() || getSessionId()}|${dataVersion}`;
  const hidden = useTimeStripHidden();
  const shown = enabled && !hidden;
  const network = useNetworkDays({ key, enabled: shown });
  const line = useNetworkDays({ key, routeId, enabled: shown && Boolean(routeId) });
  // The line's own days once read, the network's meanwhile or when they cannot be read: each said as what it is.
  const showsLine = Boolean(routeId && line);
  const days = showsLine ? line : network;

  // The box is measured whenever it mounts (the strip hidden then shown mounts a new one), then on every resize.
  const [box, setBox] = useState(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState(null);
  const dragging = useRef(false);
  useEffect(() => {
    if (!box) return undefined;
    const measure = () => setWidth(box.clientWidth);
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [box]);

  const dates = useMemo(() => {
    if (!days) return [];
    const out = [];
    for (let i = 0, d = days.window.from; i < days.days.length; i++, d = addDays(d, 1)) out.push(d);
    return out;
  }, [days]);
  const n = dates.length;
  const bw = n ? width / n : 0;
  const index = useMemo(() => new Map(dates.map((d, i) => [d, i])), [dates]);
  const selected = selectedDate && index.has(selectedDate) ? index.get(selectedDate) : -1;
  const today = useMemo(() => {
    const d = localToday();
    return index.has(d) ? index.get(d) : -1;
  }, [index]);

  const fmt = useMemo(
    () => ({
      flag: new Intl.DateTimeFormat(localeOf(language), { weekday: "short", day: "numeric", month: "short" }),
      full: new Intl.DateTimeFormat(localeOf(language), { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      month: new Intl.DateTimeFormat(localeOf(language), { month: "short" }),
      monthYear: new Intl.DateTimeFormat(localeOf(language), { month: "short", year: "numeric" }),
    }),
    [language],
  );
  const colourOf = useCallback((cls) => (theme.palette.calendarSchemes[SCHEME_OF[cls?.colour] || "weekday"] || theme.palette.calendarSchemes.weekday).dot, [theme]);

  // One path per class: a few nodes for a year of bars.
  const paths = useMemo(() => {
    if (!days || !(bw > 0)) return [];
    const max = Math.max(1, ...days.days.map(([, trips]) => trips));
    const gap = bw >= 3 ? 1 : 0;
    const w = Math.max(0.5, bw - gap);
    const byClass = new Map();
    days.days.forEach(([cls, trips], i) => {
      if (!(trips > 0)) return;
      const h = Math.max(MIN_BAR, (trips / max) * BARS_H);
      const x = i * bw + gap / 2;
      const d = `M${x.toFixed(2)} ${(FLAG_H + BARS_H).toFixed(2)}v${(-h).toFixed(2)}h${w.toFixed(2)}v${h.toFixed(2)}z`;
      const k = cls >= 0 ? cls : -1;
      byClass.set(k, (byClass.get(k) || "") + d);
    });
    return [...byClass].map(([cls, d]) => ({ cls, d, colour: cls >= 0 ? colourOf(days.classes[cls]) : theme.palette.text.disabled }));
  }, [days, bw, colourOf, theme]);

  const months = useMemo(() => {
    if (!(bw > 0)) return [];
    const out = [];
    let lastX = -Infinity;
    dates.forEach((d, i) => {
      if (i !== 0 && d.slice(8) !== "01") return;
      const x = i * bw;
      const first = out.length === 0 || d.slice(5, 7) === "01";
      const label = (first ? fmt.monthYear : fmt.month).format(dateOf(d));
      const shown = x - lastX >= LABEL_GAP;
      out.push({ x, label, shown, key: d });
      if (shown) lastX = x + label.length * 6;
    });
    return out;
  }, [dates, bw, fmt]);

  const indexAt = useCallback(
    (clientX) => {
      if (!box || !(bw > 0)) return -1;
      const x = clientX - box.getBoundingClientRect().left;
      return Math.min(n - 1, Math.max(0, Math.floor(x / bw)));
    },
    [box, bw, n],
  );
  const choose = useCallback(
    (i) => {
      if (i < 0 || i >= n || !onDateChange) return;
      if (dates[i] !== selectedDate) onDateChange(dates[i]);
    },
    [dates, n, onDateChange, selectedDate],
  );
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    choose(indexAt(e.clientX));
  };
  const onPointerMove = (e) => {
    const i = indexAt(e.clientX);
    setHover(i);
    if (dragging.current) choose(i);
  };
  const onPointerUp = () => {
    dragging.current = false;
  };
  const onKeyDown = (e) => {
    let next = null;
    if (e.key in STEPS) next = (selected >= 0 ? selected : today >= 0 ? today : 0) + STEPS[e.key] * (e.shiftKey && Math.abs(STEPS[e.key]) === 1 ? 7 : 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === null) return;
    e.preventDefault();
    choose(Math.min(n - 1, Math.max(0, next)));
  };

  const describe = (i) => {
    if (i < 0 || !days) return "";
    const [cls, trips] = days.days[i];
    const parts = [fmt.full.format(dateOf(dates[i]))];
    if (i === today) parts.push(t("days.today"));
    if (trips > 0 && cls >= 0) parts.push(classLabelOf(days.classes[cls], language, t));
    parts.push(trips > 0 ? (trips === 1 ? t("days.trip") : t("days.trips", { n: trips })) : t("days.none"));
    return parts.join(" · ");
  };

  if (!shown) return null;
  const axisY = FLAG_H + BARS_H;
  const hoverX = hover !== null && hover >= 0 ? (hover + 0.5) * bw : null;
  const flagText = selected >= 0 ? fmt.flag.format(dateOf(dates[selected])) : "";
  const flagRight = selected >= 0 && (selected + 0.5) * bw + flagText.length * 6.5 > width;
  return (
    <Box data-testid="time-strip" sx={{ ...PINNED, display: "flex", alignItems: "stretch", height: STRIP_HEIGHT, userSelect: "none" }}>
      <Box ref={setBox} sx={{ flex: 1, minWidth: 0, position: "relative" }}>
        {days ? (
          <svg
            data-testid="time-strip-bars"
            width={width}
            height={STRIP_HEIGHT}
            role="slider"
            tabIndex={0}
            aria-label={showsLine && routeLabel ? t("days.aria.line", { line: routeLabel }) : t("days.aria.network")}
            aria-valuemin={0}
            aria-valuemax={Math.max(0, n - 1)}
            aria-valuenow={Math.max(0, selected)}
            aria-valuetext={describe(selected)}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={() => setHover(null)}
            onKeyDown={onKeyDown}
            style={{ display: "block", cursor: "pointer", outline: "none", touchAction: "none" }}
          >
            <line x1={0} x2={width} y1={axisY + 0.5} y2={axisY + 0.5} stroke={theme.palette.divider} />
            {paths.map((p) => (
              <path key={p.cls} d={p.d} fill={p.colour} fillOpacity={0.85} />
            ))}
            {months.map((m) => (
              <g key={m.key}>
                <line x1={m.x + 0.5} x2={m.x + 0.5} y1={axisY} y2={axisY + 4} stroke={theme.palette.text.disabled} />
                {m.shown && (
                  <text x={m.x + 3} y={STRIP_HEIGHT - 5} fontSize={10.5} fill={theme.palette.text.secondary} fontFamily={theme.typography.fontFamily}>
                    {m.label}
                  </text>
                )}
              </g>
            ))}
            {today >= 0 && today !== selected && <line data-testid="time-strip-today" x1={(today + 0.5) * bw} x2={(today + 0.5) * bw} y1={FLAG_H} y2={axisY + 4} stroke={theme.palette.text.secondary} strokeDasharray="2 2" />}
            {hoverX !== null && hover !== selected && <rect x={hover * bw} y={FLAG_H} width={Math.max(1, bw)} height={BARS_H} fill={alpha(theme.palette.text.primary, 0.1)} />}
            {selected >= 0 && (
              <g data-testid="time-strip-cursor">
                <line x1={(selected + 0.5) * bw} x2={(selected + 0.5) * bw} y1={FLAG_H - 2} y2={axisY + 4} stroke={theme.palette.text.primary} strokeWidth={1.5} />
                <text x={(selected + 0.5) * bw + (flagRight ? -4 : 4)} y={FLAG_H - 3} fontSize={11} fontWeight={700} textAnchor={flagRight ? "end" : "start"} fill={theme.palette.text.primary} fontFamily={theme.typography.fontFamily}>
                  {flagText}
                </text>
              </g>
            )}
          </svg>
        ) : null}
        {hoverX !== null && days && (
          <Typography
            data-testid="time-strip-tooltip"
            component="div"
            sx={{ position: "absolute", bottom: STRIP_HEIGHT - FLAG_H + 2, left: Math.min(Math.max(0, hoverX - 90), Math.max(0, width - 260)), zIndex: 2, px: 1, py: 0.25, fontSize: 11.5, whiteSpace: "nowrap", pointerEvents: "none", bgcolor: "background.paper", color: "text.primary", boxShadow: 2, borderRadius: 1 }}
          >
            {describe(hover)}
          </Typography>
        )}
      </Box>
      {days && days.classes.length > 0 && (
        <Box data-testid="time-strip-legend" sx={{ flexShrink: 0, maxWidth: 360, display: "grid", gridTemplateColumns: days.classes.length > 2 ? "auto auto" : "auto", columnGap: 1.5, rowGap: 0.25, alignContent: "center", px: 1.5, borderLeft: 1, borderColor: "divider" }}>
          {days.classes.map((cls) => (
            <Box key={cls.id} sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
              <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: colourOf(cls), flexShrink: 0 }} />
              <Typography noWrap sx={{ fontSize: 11, color: "text.secondary", lineHeight: 1.3 }} title={classLabelOf(cls, language, t)}>
                {classLabelOf(cls, language, t)}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
