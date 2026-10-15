/**
 * ChangeReview — the middle of ③: the changed lines, one list (a « supporting
 * pane » layout: one object at the centre, one pane beside it; the review
 * reads as a difference).
 *
 * Each line the simulated draft touches is a row: its name, what changes
 * on it in the engine's words (preview.diff, the same sentences ④ reads),
 * how many more changes it carries. Opened — by its row, by an operation or
 * an objective naming it, by the keyboard's J / K — a row unfolds its
 * timetable « Avant | Après »: the draft through the API's lens
 * (X-View-Preview on the reader's own reads, never the engine's), its new
 * trips marked, read only; or, on the map view, the change drawn (the
 * preview's geometry). One row open at a time, as GitHub folds its files:
 * a timetable takes the height a screen has. The timetables are the
 * server's, read on demand and kept per line, side and draft (a line read
 * once shows at once again; two sides read together). The full-width
 * reader stays one click away (`onOpenReader`).
 *
 *   change-review               the board (`data-state`: source | simulating | draft | applied)
 *   change-review-state         the state said once, change-review-lines the count of lines
 *   change-reader               the body (`data-side`: before | after; `data-view`: list | map; `data-route`: the open line)
 *   change-reader-before/after  « Avant » | « Après · brouillon » (`role="radio"`), with a draft
 *   change-reader-view-list/map Lignes | Carte
 *   change-review-filter        a filter by line, once there are many
 *   change-review-open          « Pleine largeur » (the app's reader, on « Après », at the open line)
 *   change-review-keys          the keyboard's way, in a tooltip
 *   change-review-line          one row (`data-route`, `data-focused`: open, `aria-expanded`)
 *   change-review-line-body     the open row's body: its sentences (change-diff-line, change-review-sentences-more),
 *                               change-reader-direction (one chip per direction when the line runs two),
 *                               change-reader-compare (its trips before → after, the new ones counted),
 *                               change-reader-grid (`data-loaded`, `data-side`), change-reader-empty (`data-reason`:
 *                               date | service), change-reader-error with change-reader-retry
 *   change-review-network       the row of what belongs to no line (stops, calendars, validity)
 *   change-reader-map           the map view
 *   change-review-empty         nothing simulated yet; change-diff-empty: a draft that changes nothing
 *   change-review-retouches     under the lines, the draft's retouches since the last version (by hand, SQL, a
 *                               correction): what the draft changes besides its operations (DraftRetouches)
 */

import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, ButtonBase, CircularProgress, IconButton, InputBase, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import OpenInFullRoundedIcon from "@mui/icons-material/OpenInFullRounded";
import SearchIcon from "@mui/icons-material/Search";
import CheckCircleOutlineRoundedIcon from "@mui/icons-material/CheckCircleOutlineRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import KeyboardOutlinedIcon from "@mui/icons-material/KeyboardOutlined";
import FormatListBulletedRoundedIcon from "@mui/icons-material/FormatListBulletedRounded";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { describeItem } from "./ChangePlanParts";
import { lineColorsOf } from "./lineColors";
import { fetchDirections, fetchTimetable } from "../../utils/readerApi";
import DraftRetouches from "./DraftRetouches";

// The grid (PrimeReact) and the map (Leaflet) load when first shown: neither is in the app's first chunk.
const ScheduleGrid = lazy(() => import("../ScheduleGrid"));
const ChangeMap = lazy(() => import("./ChangeMap"));

// Past this many lines the board offers its filter.
const FILTER_FROM = 6;
// The sentences of the open line, before « n de plus ».
const SENTENCES_SHOWN = 3;
// The reads kept (per line, side and draft): enough for a review by the keyboard, bounded.
const CACHE_MAX = 48;
// The timetable's height inside its row: a screen's worth, the list stays in reach.
const GRID_HEIGHT = 440;

/** The draft's changes grouped by line ({ route, label, date, items }) and the rest (no line), in the diff's order. */
export const reviewOf = (preview) => {
  const lines = new Map();
  const network = [];
  for (const it of preview?.diff?.items || []) {
    const key = it?.route ? String(it.route) : it?.label ? `label:${it.label}` : null;
    if (!key) {
      network.push(it);
      continue;
    }
    if (!lines.has(key)) lines.set(key, { route: it.route ? String(it.route) : null, label: String(it.label || it.route), date: it.date || null, items: [] });
    const line = lines.get(key);
    if (!line.date && it.date) line.date = it.date;
    line.items.push(it);
  }
  return { lines: [...lines.values()], network };
};

/** The trips the draft adds and removes on a line: from its timetable before and after (sets of trip ids). */
export const compareTrips = (before, after) => {
  const ids = (body) => new Set((body?.stop_times || []).map((st) => String(st.trip_id)));
  const a = ids(before);
  const b = ids(after);
  return { before: a.size, after: b.size, added: new Set([...b].filter((id) => !a.has(id))), removed: [...a].filter((id) => !b.has(id)).length };
};

/** The direction to read first: the one kept when the line still runs it, else 0, else the first. */
export const pickDirection = (directions, kept = null) => {
  const values = (directions || []).map((d) => (d?.direction_id !== null && d?.direction_id !== undefined ? String(d.direction_id) : "null"));
  if (kept !== null && kept !== undefined && values.includes(String(kept))) return String(kept);
  if (values.includes("0")) return "0";
  return values[0] ?? null;
};

/** The diff's dates come as YYYYMMDD (the engine's) or YYYY-MM-DD (the project's): one form. */
const isoDate = (d) => (d ? String(d).replace(/^(\d{4})-?(\d{2})-?(\d{2})$/, "$1-$2-$3") : null);

/** The timetable of one line on one date, both sides when a draft is simulated — read on demand, kept. */
function useLineTimetable({ route, date, previewId, enabled }) {
  const cache = useRef(new Map());
  const [directions, setDirections] = useState({ key: null, list: [] });
  const [direction, setDirection] = useState(null);
  const [sides, setSides] = useState({ key: null, before: null, after: null });
  const [state, setState] = useState("idle");
  const [attempt, setAttempt] = useState(0);
  const keep = (key, value) => {
    cache.current.set(key, value);
    if (cache.current.size > CACHE_MAX) cache.current.delete(cache.current.keys().next().value);
    return value;
  };
  const cached = (key, make) =>
    cache.current.get(key) ||
    keep(
      key,
      make().catch((err) => {
        cache.current.delete(key);
        throw err;
      }),
    );

  // The line's directions on the date (through the lens when a draft is simulated: a direction it adds counts).
  const dirKey = enabled && route && date ? `dir|${previewId || ""}|${route}|${date}` : null;
  useEffect(() => {
    if (!dirKey) return undefined;
    let live = true;
    setState("loading");
    cached(dirKey, () => fetchDirections(route, date, { previewId })).then(
      (list) => {
        if (!live) return;
        setDirections({ key: dirKey, list: Array.isArray(list) ? list : [] });
        setDirection((kept) => pickDirection(list, kept));
      },
      () => {
        if (live) setState("error");
      },
    );
    return () => {
      live = false;
    };
    // The key says it all (route, date, draft); a retry asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirKey, attempt]);

  // The timetable, before and (with a draft) after, in parallel. No direction at all: no service that day.
  const ready = directions.key === dirKey && (direction !== null || !directions.list.length);
  const ttKey = ready && dirKey ? `tt|${previewId || ""}|${route}|${direction ?? "none"}|${date}` : null;
  useEffect(() => {
    if (!ttKey) return undefined;
    if (!directions.list.length) {
      const none = { stop_times: [], stops: [] };
      setSides({ key: ttKey, before: none, after: previewId ? none : null });
      setState("ready");
      return undefined;
    }
    let live = true;
    setState("loading");
    const before = cached(`${ttKey}|before`, () => fetchTimetable(route, direction, date, { previewId: null }));
    const after = previewId ? cached(`${ttKey}|after`, () => fetchTimetable(route, direction, date, { previewId })) : Promise.resolve(null);
    Promise.all([before, after]).then(
      ([b, a]) => {
        if (!live) return;
        setSides({ key: ttKey, before: b, after: a });
        setState("ready");
      },
      () => {
        if (live) setState("error");
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttKey, directions.list.length, attempt]);

  const current = sides.key === ttKey ? sides : { before: null, after: null };
  return { state: dirKey ? state : "idle", directions: directions.key === dirKey ? directions.list : [], direction, setDirection, before: current.before, after: current.after, loaded: Boolean(ttKey) && sides.key === ttKey, retry: () => setAttempt((n) => n + 1) };
}

function Segment({ value, current, onPick, testid, tone = null, children, role = "radio", disabled = false }) {
  const theme = useTheme();
  const on = current === value;
  const color = tone || theme.palette.text.primary;
  return (
    <ButtonBase
      onClick={() => !on && onPick(value)}
      disabled={disabled}
      role={role}
      aria-checked={role === "radio" ? (on ? "true" : "false") : undefined}
      aria-pressed={role === "button" ? (on ? "true" : "false") : undefined}
      data-testid={testid}
      sx={{ height: 28, px: 1.25, display: "inline-flex", alignItems: "center", gap: 0.5, borderRadius: "7px", fontSize: "0.76rem", fontWeight: on ? 700 : 500, color: on ? color : "text.secondary", backgroundColor: on ? alpha(color, theme.palette.mode === "dark" ? 0.22 : 0.1) : "transparent", "&:hover": { backgroundColor: alpha(color, 0.08) } }}
    >
      {children}
    </ButtonBase>
  );
}

// `onFocus(route | null)`: a row opened (or closed); `routes`: the network's lines ({ id, short_name, long_name })
// for the grid's head; `defaultDate`: the date a line without one reads on (the change's « mise en service », else
// the feed's first day); `hint`: the keyboard's way through the lines, in a tooltip.
export default function ChangeReview({ preview = null, previewing = false, operations = 0, frozen = null, focus = null, onFocus = null, onOpenReader = null, hint = null, routes = [], defaultDate = null, edit = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [sidePick, setSidePick] = useState("after");
  const [view, setView] = useState("list");
  const [closed, setClosed] = useState(false); // the row open by default was closed by hand
  const [networkOpen, setNetworkOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { lines, network } = useMemo(() => reviewOf(preview), [preview]);
  const state = frozen ? "applied" : previewing && !preview ? "simulating" : preview ? "draft" : "source";
  const hasDraft = state === "draft" && Boolean(preview?.id);
  const shownLines = query.trim() ? lines.filter((l) => l.label.toLowerCase().includes(query.trim().toLowerCase())) : lines;

  // The row open: the line in focus when the draft touches it, else — until closed by hand — the first line read.
  const focused = focus !== null && focus !== undefined ? lines.find((l) => l.route === String(focus)) || null : null;
  const open = focused || (closed || network.length && networkOpen ? null : lines.find((l) => l.route) || lines[0] || null);
  // A line put in focus by the host (an operation, an objective, the keyboard) opens its row; a focus cleared by the
  // row itself (closed by hand) keeps the list folded.
  useEffect(() => {
    setMoreOpen(false);
    if (focus !== null && focus !== undefined) {
      setClosed(false);
      setNetworkOpen(false);
    }
  }, [focus]);
  const date = isoDate(open?.date) || isoDate(defaultDate);
  const side = hasDraft ? sidePick : "before";
  const reading = useLineTimetable({ route: open?.route || null, date, previewId: hasDraft ? preview.id : null, enabled: state !== "source" && state !== "simulating" && view === "list" });
  const compare = useMemo(() => (reading.loaded && reading.after ? compareTrips(reading.before, reading.after) : null), [reading.loaded, reading.before, reading.after]);
  const body = side === "after" ? reading.after : reading.before;
  const details = useMemo(() => {
    const r = (routes || []).find((x) => String(x.id) === String(open?.route));
    return { route_id: open?.route || "", route_short_name: r?.short_name || open?.label || "", route_long_name: r?.long_name || "", route_color: r?.color || null };
  }, [routes, open]);
  const rowRefs = useRef({});
  useEffect(() => {
    if (open) rowRefs.current[open.route || open.label]?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [open]);
  const dateWords = date ? new Date(`${date}T12:00:00`).toLocaleDateString(language || undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

  const paper = theme.palette.background.paper;
  const tone = state === "draft" ? theme.palette.warning : state === "applied" ? theme.palette.success : theme.palette.info;
  const toggleRow = (line) => {
    const isOpen = open === line;
    if (isOpen) {
      setClosed(true);
      onFocus?.(null);
    } else {
      setClosed(false);
      setNetworkOpen(false);
      setMoreOpen(false);
      onFocus?.(line.route || null);
    }
  };

  // The open row's body: the line's sentences, then its timetable (or why it cannot be read).
  const rowBody = (line) => {
    const sentences = line.items;
    let reader = null;
    if (!line.route) reader = null;
    else if (!date) {
      reader = <Typography data-testid="change-reader-empty" data-reason="date" sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("transform.reader.noDate")}</Typography>;
    } else if (reading.state === "error") {
      reader = (
        <Box data-testid="change-reader-error" sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("transform.reader.error")}</Typography>
          <Button size="small" onClick={reading.retry} data-testid="change-reader-retry" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("transform.reader.retry")}
          </Button>
        </Box>
      );
    } else if (!reading.loaded || !body) {
      reader = (
        <Box data-testid="change-reader-loading" sx={{ display: "flex", alignItems: "center", gap: 1, py: 2 }}>
          <CircularProgress size={16} />
          <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("transform.reader.loading")}</Typography>
        </Box>
      );
    } else if (!(body.stop_times || []).length) {
      reader = <Typography data-testid="change-reader-empty" data-reason="service" sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("transform.reader.noService")}</Typography>;
    } else {
      reader = (
        // Keyed by the side: the other timetable fades in (none for a person who asked for less motion).
        <Box key={side} data-testid="change-reader-grid" data-loaded="true" data-side={side} sx={{ height: GRID_HEIGHT, overflow: "auto", borderRadius: "10px", border: `1px solid ${theme.palette.divider}`, backgroundColor: paper, "@keyframes gtfsReaderSide": { from: { opacity: 0 }, to: { opacity: 1 } }, animation: "gtfsReaderSide 180ms ease-out both", "@media (prefers-reduced-motion: reduce)": { animation: "none" } }}>
          <Suspense fallback={<Box sx={{ display: "flex", justifyContent: "center", py: 4 }}><CircularProgress size={20} /></Box>}>
            <ScheduleGrid
              stops={body.stops || []}
              stopTimes={body.stop_times || []}
              selectedRouteDetails={details}
              frequencyInfo={body.frequency_info}
              hasFrequencies={body.has_frequencies}
              hasNormalTimes={body.has_normal_times}
              datasetKey={`${line.route}|${reading.direction}|${date}|${side}|${hasDraft ? preview.id : ""}`}
              wheelchairAccessibleTrips={body.wheelchair_accessible_trips || 0}
              totalTrips={body.total_trips || 0}
              highlightTripIds={side === "after" && compare ? compare.added : null}
              readOnly={side === "after"}
            />
          </Suspense>
        </Box>
      );
    }
    return (
      <Box data-testid="change-review-line-body" sx={{ display: "flex", flexDirection: "column", gap: 1, px: 1.5, pb: 1.5 }}>
        {sentences.length > 0 && (
          <Box sx={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0.25 }}>
            <Box component="ul" data-testid="change-review-sentences" sx={{ alignSelf: "stretch", m: 0, pl: 2, display: "flex", flexDirection: "column", gap: 0.1 }}>
              {(moreOpen ? sentences : sentences.slice(0, SENTENCES_SHOWN)).map((it, i) => (
                <Typography component="li" key={i} data-testid="change-diff-line" sx={{ fontSize: "0.78rem", lineHeight: 1.5 }}>
                  {describeItem(t, it, language)}
                </Typography>
              ))}
            </Box>
            {sentences.length > SENTENCES_SHOWN && (
              <Button size="small" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen ? "true" : "false"} data-testid="change-review-sentences-more" sx={{ flexShrink: 0, textTransform: "none", fontWeight: 700, fontSize: "0.72rem", py: 0, minWidth: 0 }}>
                {moreOpen ? t("transform.reader.lessSentences") : t("transform.reader.moreSentences", { count: sentences.length - SENTENCES_SHOWN })}
              </Button>
            )}
          </Box>
        )}
        {line.route && date && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
            {reading.directions.length > 1 && (
              <Box role="radiogroup" aria-label={t("transform.reader.direction", { n: "" }).trim()} sx={{ display: "inline-flex", gap: 0.25 }}>
                {reading.directions.map((d) => {
                  const id = d?.direction_id !== null && d?.direction_id !== undefined ? String(d.direction_id) : "null";
                  return (
                    <Segment key={id} value={id} current={reading.direction} onPick={reading.setDirection} testid="change-reader-direction">
                      {/* The API names a direction by its headsigns (routeService); none: « Direction n » in the reader's words. */}
                      {Array.isArray(d?.headsigns) && d.headsigns.length ? d.headsigns.map((h) => h?.name).filter(Boolean).join(" / ") : d?.headsign || t("transform.reader.direction", { n: id })}
                    </Segment>
                  );
                })}
              </Box>
            )}
            <Typography data-testid="change-reader-compare" sx={{ flex: "1 1 200px", minWidth: 0, fontSize: "0.76rem", color: compare && compare.added.size ? theme.palette.warning.dark : "text.secondary", fontWeight: compare ? 600 : 500, fontVariantNumeric: "tabular-nums" }}>
              {compare
                ? `${t("lens.compare", { line: line.label, date: dateWords, before: compare.before, after: compare.after })}${compare.added.size ? ` · ${t("lens.compare.added", { count: compare.added.size })}` : ""}${compare.removed ? ` · ${t("lens.compare.removed", { count: compare.removed })}` : ""}`
                : t("transform.reader.date", { date: dateWords })}
            </Typography>
          </Box>
        )}
        {reader}
      </Box>
    );
  };

  const row = (line) => {
    const isOpen = open === line;
    const first = line.items[0] ? describeItem(t, line.items[0], language) : "";
    return (
      <Box
        key={line.route || line.label}
        ref={(el) => {
          rowRefs.current[line.route || line.label] = el;
        }}
        data-testid="change-review-line"
        data-route={line.route || ""}
        data-focused={isOpen ? "true" : "false"}
        sx={{ borderRadius: "12px", border: `1px solid ${isOpen ? alpha(theme.palette.warning.main, 0.6) : theme.palette.divider}`, backgroundColor: paper, boxShadow: isOpen ? `0 0 0 2px ${alpha(theme.palette.warning.main, 0.16)}` : "none", overflow: "hidden" }}
      >
        <ButtonBase onClick={() => toggleRow(line)} aria-expanded={isOpen ? "true" : "false"} aria-label={t(isOpen ? "transform.review.collapse" : "transform.review.expand", { line: line.label })} sx={{ width: "100%", display: "flex", alignItems: "center", gap: 1, px: 1.5, py: 1, textAlign: "left", "&:hover": { backgroundColor: alpha(theme.palette.text.primary, 0.03) } }}>
          <Box component="span" data-testid="change-review-line-badge" sx={{ flexShrink: 0, minWidth: 34, px: 1, py: 0.25, borderRadius: "7px", fontSize: "0.82rem", fontWeight: 800, textAlign: "center", ...(lineColorsOf(routes, line.route || line.label, theme) ? { color: lineColorsOf(routes, line.route || line.label, theme).fg, backgroundColor: lineColorsOf(routes, line.route || line.label, theme).bg } : { color: theme.palette.warning.dark, backgroundColor: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.2 : 0.12) }) }}>
            {line.label}
          </Box>
          {/* Closed: the first change in one line and how many more; open: the count alone, the changes are listed under. */}
          <Typography component="span" sx={{ flex: 1, minWidth: 0, fontSize: "0.8rem", lineHeight: 1.4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: isOpen ? "text.secondary" : "text.primary" }}>
            {isOpen ? t("review.line.changes", { count: line.items.length }) : first}
          </Typography>
          {!isOpen && line.items.length > 1 && (
            <Typography component="span" aria-label={t("review.line.changes", { count: line.items.length })} sx={{ flexShrink: 0, fontSize: "0.72rem", fontWeight: 700, color: "text.secondary" }}>
              {t("transform.review.more", { count: line.items.length - 1 })}
            </Typography>
          )}
          <ExpandMoreRoundedIcon aria-hidden sx={{ fontSize: 20, color: "text.secondary", flexShrink: 0, transform: isOpen ? "rotate(180deg)" : "none", transition: "transform 160ms" }} />
        </ButtonBase>
        {isOpen && rowBody(line)}
      </Box>
    );
  };

  const networkRow = network.length > 0 && !query.trim() && (
    <Box data-testid="change-review-network" data-focused={networkOpen ? "true" : "false"} sx={{ borderRadius: "12px", border: `1px solid ${theme.palette.divider}`, backgroundColor: paper, overflow: "hidden" }}>
      <ButtonBase
        onClick={() => {
          setNetworkOpen((v) => !v);
          if (!networkOpen) {
            setClosed(true);
            onFocus?.(null);
          }
        }}
        aria-expanded={networkOpen ? "true" : "false"}
        sx={{ width: "100%", display: "flex", alignItems: "center", gap: 1, px: 1.5, py: 1, textAlign: "left" }}
      >
        <Typography component="span" sx={{ flex: 1, minWidth: 0, fontSize: "0.8rem", fontWeight: 700 }}>
          {t("review.network")}
        </Typography>
        <Typography component="span" sx={{ flexShrink: 0, fontSize: "0.72rem", fontWeight: 700, color: "text.secondary" }}>
          {network.length}
        </Typography>
        <ExpandMoreRoundedIcon aria-hidden sx={{ fontSize: 20, color: "text.secondary", transform: networkOpen ? "rotate(180deg)" : "none", transition: "transform 160ms" }} />
      </ButtonBase>
      {networkOpen && (
        <Box component="ul" data-testid="change-review-sentences" sx={{ m: 0, pl: 3.5, pr: 1.5, pb: 1.25, display: "flex", flexDirection: "column", gap: 0.1 }}>
          {network.map((it, i) => (
            <Typography component="li" key={i} data-testid="change-diff-line" sx={{ fontSize: "0.78rem", lineHeight: 1.5 }}>
              {describeItem(t, it, language)}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );

  const listBody = () => {
    if (state === "source") {
      return (
        <Box data-testid="change-review-empty" sx={{ m: "auto", maxWidth: 460, textAlign: "center", px: 2 }}>
          <Typography sx={{ fontSize: "0.86rem", color: "text.secondary", lineHeight: 1.55 }}>{t(operations > 0 ? "transform.previewing" : "review.empty")}</Typography>
        </Box>
      );
    }
    if (state === "simulating" && !lines.length) {
      return (
        <Box sx={{ m: "auto", display: "flex", alignItems: "center", gap: 1 }}>
          <CircularProgress size={18} />
          <Typography sx={{ fontSize: "0.84rem", color: "text.secondary" }}>{t("lens.simulating")}</Typography>
        </Box>
      );
    }
    if (state === "applied" && !lines.length) {
      return (
        <Typography sx={{ m: "auto", maxWidth: 460, px: 2, textAlign: "center", fontSize: "0.84rem", lineHeight: 1.55 }}>{t("review.applied", { n: frozen })}</Typography>
      );
    }
    if (state === "draft" && preview && (preview.empty || (!lines.length && !network.length))) {
      return <Typography data-testid="change-diff-empty" sx={{ m: "auto", px: 2, fontSize: "0.84rem", color: "text.secondary" }}>{t("transform.noChanges")}</Typography>;
    }
    return (
      <Box sx={{ flex: 1, minHeight: 0, overflowY: "auto", p: 1.5, display: "flex", flexDirection: "column", gap: 1 }}>
        {shownLines.map(row)}
        {lines.length >= FILTER_FROM && !shownLines.length && <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("review.filter.none")}</Typography>}
        {networkRow}
      </Box>
    );
  };

  return (
    <Box data-testid="change-review" data-state={state} sx={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", minHeight: 0, backgroundColor: "background.default" }}>
      {/* One head: the state, the side, the view, the filter, the way to the full-width reader. */}
      <Box sx={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", px: 1.5, py: 0.75, borderBottom: `1px solid ${theme.palette.divider}`, backgroundColor: paper }}>
        <Typography data-testid="change-review-state" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, px: 1, height: 26, borderRadius: "7px", fontSize: "0.74rem", fontWeight: 700, color: tone.dark, backgroundColor: alpha(tone.main, theme.palette.mode === "dark" ? 0.18 : 0.1), whiteSpace: "nowrap" }}>
          {state === "simulating" && <CircularProgress size={11} color="inherit" />}
          {state === "applied" && <CheckCircleOutlineRoundedIcon aria-hidden sx={{ fontSize: 15 }} />}
          {t(`transform.review.state.${state}`, { n: frozen })}
        </Typography>
        {lines.length > 0 && (
          <Typography data-testid="change-review-lines" sx={{ fontSize: "0.76rem", color: "text.secondary", fontWeight: 600, whiteSpace: "nowrap" }}>
            {t("review.lines", { count: lines.length })}
          </Typography>
        )}
        {hasDraft && (
          <Box role="radiogroup" aria-label={t("lens.label")} sx={{ display: "inline-flex", gap: 0.25, p: 0.25, borderRadius: "9px", border: `1px solid ${theme.palette.divider}` }}>
            <Segment value="before" current={side} onPick={setSidePick} testid="change-reader-before">{t("lens.before")}</Segment>
            <Segment value="after" current={side} onPick={setSidePick} testid="change-reader-after" tone={theme.palette.warning.dark}>{t("lens.after")}</Segment>
          </Box>
        )}
        {state !== "source" && (lines.length > 0 || network.length > 0) && (
          <Box sx={{ display: "inline-flex", gap: 0.25 }}>
            <Segment role="button" value="list" current={view} onPick={setView} testid="change-reader-view-list">
              <FormatListBulletedRoundedIcon sx={{ fontSize: 15 }} /> {t("transform.reader.list")}
            </Segment>
            <Segment role="button" value="map" current={view} onPick={setView} testid="change-reader-view-map">
              <MapOutlinedIcon sx={{ fontSize: 15 }} /> {t("transform.reader.map")}
            </Segment>
          </Box>
        )}
        {lines.length >= FILTER_FROM && (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, px: 1, height: 28, borderRadius: "8px", border: `1px solid ${theme.palette.divider}` }}>
            <SearchIcon aria-hidden sx={{ fontSize: 16, color: "text.secondary" }} />
            <InputBase value={query} onChange={(e) => setQuery(e.target.value.slice(0, 60))} placeholder={t("review.filter")} inputProps={{ "data-testid": "change-review-filter", "aria-label": t("review.filter") }} sx={{ width: 120, fontSize: "0.78rem" }} />
          </Box>
        )}
        <Box sx={{ flex: 1 }} />
        {hint && lines.length > 0 && state === "draft" && (
          <Tooltip title={hint}>
            <IconButton size="small" aria-label={hint} data-testid="change-review-keys">
              <KeyboardOutlinedIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        )}
        {onOpenReader && (
          <Tooltip title={t("review.open.hint")}>
            <Button size="small" variant="text" startIcon={<OpenInFullRoundedIcon sx={{ fontSize: "16px !important" }} />} onClick={() => onOpenReader(open?.route ? { route: open.route, date: open.date } : null)} data-testid="change-review-open" sx={{ textTransform: "none", fontWeight: 700, whiteSpace: "nowrap" }}>
              {t("transform.reader.full")}
            </Button>
          </Tooltip>
        )}
      </Box>

      <Box data-testid="change-reader" data-side={side} data-view={view} data-route={open?.route || ""} sx={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        {view === "map" && state !== "source" ? (
          <Box data-testid="change-reader-map" sx={{ position: "absolute", inset: 0 }}>
            <Suspense fallback={<Box sx={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}><CircularProgress size={20} /></Box>}>
              <ChangeMap geo={preview?.geo || null} hasPreview={Boolean(preview)} previewing={previewing} height="fill" state={state} appliedIn={frozen} focus={open?.route || null} focusLabel={open?.label || null} />
            </Suspense>
          </Box>
        ) : (
          <>
            {listBody()}
            <Box sx={{ flexShrink: 0, maxHeight: "45%", overflowY: "auto", px: 1.5, pb: 1.5 }}>
              <DraftRetouches testid="change-review-retouches" edit={edit} />
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}
