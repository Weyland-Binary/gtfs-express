/**
 * The stop sheets, as an operator posts them. By line: choose a line on the left (in the feed's order), its direction
 * and the period above; its stops are listed in order beside the sheet as it will be printed; « Imprimer » prints the
 * direction, one sheet a page (or this sheet alone, or both directions, or the sheets a draft changes). By stop: a
 * stop's poster, every line calling there on one page. What the sheets show and the network's look wait behind
 * « Personnaliser ». The server computes the sheets; this screen lays them out on paper and prints them from the page
 * itself. On a draft the stops whose sheet it changes are marked, line by line. Anyone sees the sheets; printing them
 * is the licence's: without it they carry the « preview » watermark, the print button its lock, and « Imprimer » opens
 * the offer, the print carried out once the licence runs.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, ButtonGroup, CircularProgress, InputAdornment, ListItemIcon, ListItemText, Menu, MenuItem, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import PrintOutlinedIcon from "@mui/icons-material/PrintOutlined";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import TuneIcon from "@mui/icons-material/Tune";
import SearchIcon from "@mui/icons-material/Search";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import SwapVertIcon from "@mui/icons-material/SwapVert";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import DifferenceOutlinedIcon from "@mui/icons-material/DifferenceOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { getSheets, getSheetChanges, getSheetsSetup, getSheetCalendar, putSheetCalendar, suggestSheetCalendar, BATCH } from "../../utils/sheetsApi";
import { humanError } from "../../utils/humanError";
import { countWords } from "../../utils/countWords";
import { licenceLockOf, openPaywall, useFeatures } from "../../utils/featuresApi";
import { trackUi } from "../../utils/uiTelemetry";
import SegmentedSwitch from "../common/SegmentedSwitch";
import SheetCustomize from "./SheetCustomize";
import SheetPage from "./SheetPage";
import { SHEET_CSS } from "./sheetStyles";
import { fitPage, paperOf, schoolLinesOf } from "./sheetLayout";
import { readPrefs, writePrefs, takeAskedStop, onSheetAsked } from "./sheetPrefs";
import printSheets from "./printSheets";

const PX_PER_MM = 96 / 25.4;
// The stops listed at once in « Par arrêt »: a search narrows a large network.
const MAX_STOPS_LISTED = 300;

function LineBadge({ route, size = 28 }) {
  return (
    <Box component="span" sx={{ minWidth: size, height: size, px: 0.75, borderRadius: "7px", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: size > 30 ? "1rem" : size < 24 ? "0.68rem" : "0.8rem", bgcolor: `#${route.color}`, color: `#${route.text}`, flexShrink: 0, letterSpacing: "-0.01em" }}>
      {route.short}
    </Box>
  );
}

function ChangedChip({ label }) {
  const theme = useTheme();
  return (
    <Box component="span" data-testid="sheets-changed" sx={{ px: 0.6, py: 0.1, borderRadius: 1, fontSize: "0.62rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: theme.palette.warning.dark, bgcolor: alpha(theme.palette.warning.main, 0.16), whiteSpace: "nowrap" }}>
      {label}
    </Box>
  );
}

function Preview({ page, labels, prefs, paper, watermark, school, onDense }) {
  const theme = useTheme();
  const boxRef = useRef(null);
  const pageRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  useLayoutEffect(() => {
    if (pageRef.current) onDense(page.key, fitPage(pageRef.current).overflow);
  }, [page, labels, prefs, paper, school, onDense]);
  const pw = paper.w * PX_PER_MM;
  const ph = paper.h * PX_PER_MM;
  const zoom = box.w && box.h ? Math.min((box.w - 64) / pw, (box.h - 48) / ph, 1.4) : 0.5;
  return (
    <Box ref={boxRef} sx={{ flex: 1, minWidth: 0, minHeight: 0, position: "relative", overflow: "hidden" }}>
      <Box sx={{ position: "absolute", left: "50%", top: "50%", width: pw, height: ph, transform: `translate(-50%, -50%) scale(${zoom})`, transformOrigin: "center", boxShadow: `0 1px 3px ${alpha(theme.palette.common.black, 0.12)}, 0 12px 40px ${alpha(theme.palette.common.black, 0.18)}` }}>
        <SheetPage ref={pageRef} page={page} labels={labels} prefs={prefs} paper={paper} watermark={watermark} school={school} />
      </Box>
    </Box>
  );
}

const listSx = (theme, on) => ({ all: "unset", boxSizing: "border-box", width: "100%", cursor: "pointer", bgcolor: on ? alpha(theme.palette.primary.main, 0.1) : "transparent", "&:hover": { bgcolor: on ? alpha(theme.palette.primary.main, 0.14) : theme.palette.action.hover }, "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 } });

export default function StopSheets() {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const { dataVersion } = useEditMode();
  const { features } = useFeatures();
  // The licence's state is part of what the server answers (the watermark): a licence taken asks the sheets again.
  const lock = licenceLockOf(features?.access) || "";
  const [setup, setSetup] = useState(null);
  const [setupError, setSetupError] = useState(null);
  const [region, setRegion] = useState(null);
  const [periodKey, setPeriodKey] = useState("p0");
  const [custom, setCustom] = useState({ from: "", to: "" });
  const [prefs, setPrefs] = useState(readPrefs);
  const [asked, setAsked] = useState(() => takeAskedStop());
  // « Par ligne » (a line, its direction, its stops one sheet each) or « Par arrêt » (a stop's poster, its lines).
  const [mode, setMode] = useState(asked ? "stop" : "line");
  const [routeId, setRouteId] = useState(null);
  const [dirIndex, setDirIndex] = useState(0);
  const [stopId, setStopId] = useState(null);
  const [posterId, setPosterId] = useState(null);
  const [query, setQuery] = useState("");
  const [cache, setCache] = useState({ key: "", meta: null, sheets: new Map() });
  const [posters, setPosters] = useState({ key: "", meta: null, sheets: new Map() });
  const [changes, setChanges] = useState({ key: "", list: null });
  // The calendar's names: read when « Personnaliser » opens, written as the person edits, named by the model on request.
  const [calendar, setCalendar] = useState({ key: "", data: null, loading: false, error: null });
  const [suggesting, setSuggesting] = useState(false);
  const [loading, setLoading] = useState({ busy: false, error: null });
  const [dense, setDense] = useState(new Map());
  const [printing, setPrinting] = useState(false);
  const [printMenu, setPrintMenu] = useState(null);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [pendingPrint, setPendingPrint] = useState(null);
  const listRef = useRef(null);
  // Counted once a visit of the screen, for the console: opened by its tab or from a stop's panel.
  const openedFromRef = useRef(asked ? "stop" : "tab");
  useEffect(() => trackUi("sheets.open", openedFromRef.current), []);

  const setPref = useCallback((key, value) => setPrefs((p) => ({ ...p, [key]: value })), []);
  useEffect(() => writePrefs(prefs), [prefs]);
  useEffect(() => onSheetAsked(() => setAsked(takeAskedStop())), []);

  // ── What can be printed, for this state of the network
  useEffect(() => {
    const ctrl = new AbortController();
    setSetupError(null);
    getSheetsSetup({ region, signal: ctrl.signal })
      .then(setSetup)
      .catch((err) => {
        if (err?.code !== "ABORTED") setSetupError(err);
      });
    return () => ctrl.abort();
  }, [region, dataVersion, retry, lock]);

  const routes = useMemo(() => setup?.routes || [], [setup]);
  const routesById = useMemo(() => new Map(routes.map((r) => [r.id, r])), [routes]);
  const route = routesById.get(routeId) || null;
  const stopsById = useMemo(() => new Map((setup?.stops || []).map((s) => [s.id, s])), [setup]);
  // The places a poster is made for: a station stands for its quays.
  const places = useMemo(() => (setup?.stops || []).filter((s) => s.station || !s.parent || !stopsById.has(s.parent)), [setup, stopsById]);
  const placeOf = useCallback((id) => {
    const s = stopsById.get(id);
    return s?.parent && stopsById.has(s.parent) ? s.parent : id;
  }, [stopsById]);

  // A stop asked from the reader opens its poster; else the first line.
  useEffect(() => {
    if (!routes.length) return;
    if (asked) {
      setMode("stop");
      setPosterId(placeOf(asked));
      setAsked(null);
      return;
    }
    if (!route) {
      setRouteId(routes[0].id);
      setDirIndex(0);
      setStopId(null);
    }
  }, [routes, route, asked, placeOf]);
  useEffect(() => {
    if (mode === "stop" && !posterId && places.length) setPosterId(places[0].id);
  }, [mode, posterId, places]);

  const direction = route?.directions[Math.min(dirIndex, route.directions.length - 1)] || null;

  const period = useMemo(() => {
    if (!setup) return null;
    if (periodKey === "all") return setup.range;
    if (periodKey === "custom") return custom.from && custom.to && custom.from <= custom.to ? custom : setup.period;
    return setup.periods[Number(periodKey.slice(1))] || setup.period;
  }, [setup, periodKey, custom]);
  const lang = prefs.lang || language;
  // A name confirmed or proposed changes the sheets: their key carries the calendar's date.
  const calendarVersion = calendar.data?.updatedAt || setup?.calendar?.updatedAt || "";
  const baseKey = period ? `${period.from}|${period.to}|${lang}|${region || ""}|${dataVersion}|${lock}|${calendarVersion}` : "";
  const calendarKey = period ? `${period.from}|${period.to}|${lang}|${region || ""}|${dataVersion}` : "";
  useEffect(() => {
    if (!customizeOpen || !calendarKey || calendar.key === calendarKey) return undefined;
    const ctrl = new AbortController();
    setCalendar((c) => ({ ...c, key: calendarKey, loading: true, error: null }));
    getSheetCalendar({ from: period.from, to: period.to, lang, region, signal: ctrl.signal })
      .then((data) => setCalendar({ key: calendarKey, data, loading: false, error: null }))
      .catch((err) => {
        if (err?.code !== "ABORTED") setCalendar({ key: calendarKey, data: null, loading: false, error: err });
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customizeOpen, calendarKey]);
  const onCalendarChange = useCallback(
    (next) => {
      if (!period) return;
      trackUi("sheets.calendar", "confirm");
      putSheetCalendar({ periods: next.periods, holidays: next.holidays, from: period.from, to: period.to, lang, region })
        .then((data) => setCalendar({ key: calendarKey, data, loading: false, error: null }))
        .catch((err) => setCalendar((c) => ({ ...c, error: err })));
    },
    [period, lang, region, calendarKey],
  );
  const aiLock = licenceLockOf(features?.access);
  const onCalendarSuggest = useCallback(() => {
    if (!period) return;
    if (aiLock === "sign_in_required" || aiLock === "subscription_required") {
      openPaywall("studio", aiLock, () => onCalendarSuggest());
      return;
    }
    trackUi("sheets.calendar", "ai");
    setSuggesting(true);
    suggestSheetCalendar({ from: period.from, to: period.to, lang, region })
      .then((data) => setCalendar({ key: calendarKey, data, loading: false, error: null }))
      .catch((err) => setCalendar((c) => ({ ...c, error: err })))
      .finally(() => setSuggesting(false));
  }, [period, lang, region, calendarKey, aiLock]);
  const key = baseKey && route ? `${baseKey}|${route.id}` : "";

  // ── The line's sheets, both directions, the one shown first
  useEffect(() => {
    if (!key || mode !== "line") return undefined;
    const fresh = cache.key !== key;
    const known = fresh ? new Map() : cache.sheets;
    const all = [...new Set([...(direction?.stops || []), ...route.directions.flatMap((d) => d.stops)])];
    const missing = all.filter((id) => !known.has(id));
    if (fresh) setCache({ key, meta: null, sheets: new Map() });
    if (!missing.length) return undefined;
    const first = stopId && missing.includes(stopId) ? [stopId, ...missing.filter((id) => id !== stopId)] : missing;
    const ctrl = new AbortController();
    let cancelled = false;
    setLoading({ busy: true, error: null });
    (async () => {
      try {
        // The sheet shown alone first, so it appears at once; then the rest by batches.
        const parts = [first.slice(0, 1)];
        for (let i = 1; i < first.length; i += BATCH) parts.push(first.slice(i, i + BATCH));
        for (const ids of parts) {
          const part = await getSheets({ stopIds: ids, routeId: route.id, from: period.from, to: period.to, lang, region, signal: ctrl.signal });
          if (cancelled) return;
          setCache((c) => {
            if (c.key !== key) return c;
            const sheets = new Map(c.sheets);
            for (const s of part.sheets) sheets.set(s.stop.id, s);
            for (const id of part.unknown || []) sheets.set(id, null);
            return { key, meta: c.meta || part, sheets };
          });
        }
        if (!cancelled) setLoading({ busy: false, error: null });
      } catch (err) {
        if (!cancelled && err?.code !== "ABORTED") setLoading({ busy: false, error: err });
      }
    })();
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // The cache is read, not followed: a batch landing must not start the fetch again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, mode, retry]);

  // ── A stop's poster: every line at the stop, asked when it is shown
  useEffect(() => {
    if (!baseKey || mode !== "stop" || !posterId) return undefined;
    const fresh = posters.key !== baseKey;
    if (fresh) setPosters({ key: baseKey, meta: null, sheets: new Map() });
    if (!fresh && posters.sheets.has(posterId)) return undefined;
    const ctrl = new AbortController();
    let cancelled = false;
    setLoading({ busy: true, error: null });
    getSheets({ stopIds: [posterId], routeId: null, from: period.from, to: period.to, lang, region, signal: ctrl.signal })
      .then((part) => {
        if (cancelled) return;
        setPosters((c) => {
          if (c.key !== baseKey) return c;
          const sheets = new Map(c.sheets);
          for (const s of part.sheets) sheets.set(s.stop.id, s);
          for (const id of part.unknown || []) sheets.set(id, null);
          return { key: baseKey, meta: c.meta || part, sheets };
        });
        setLoading({ busy: false, error: null });
      })
      .catch((err) => {
        if (!cancelled && err?.code !== "ABORTED") setLoading({ busy: false, error: err });
      });
    return () => {
      cancelled = true;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, mode, posterId, retry]);

  // ── On a draft, the stops whose sheet it changes over the period
  const changesKey = setup?.draft && period ? `${period.from}|${period.to}|${dataVersion}` : "";
  useEffect(() => {
    if (!changesKey) return undefined;
    const ctrl = new AbortController();
    getSheetChanges({ from: period.from, to: period.to, signal: ctrl.signal })
      .then((res) => setChanges({ key: changesKey, list: res?.changed || [] }))
      .catch(() => {});
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changesKey]);
  const changed = useMemo(() => {
    const map = new Map();
    if (!changesKey || changes.key !== changesKey) return map;
    for (const c of changes.list || []) map.set(c.stop_id, c);
    return map;
  }, [changes, changesKey]);
  const changedPlaces = useMemo(() => new Set([...changed.keys()].map(placeOf)), [changed, placeOf]);
  const changedLines = useMemo(() => [...new Set([...changed.values()].flatMap((c) => c.lines))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [changed]);
  const changedOfLine = useCallback((r) => (r ? [...changed.values()].filter((c) => c.lines.includes(r.short)).length : 0), [changed]);

  /** The pages of a direction: one a stop where it leaves, in the direction's order. */
  const pagesOf = useCallback(
    (dir) =>
      (dir?.stops || [])
        .map((id) => {
          const sheet = cache.sheets.get(id);
          const block = sheet?.blocks.find((b) => b.direction_id === dir.direction_id);
          return block ? { key: `${id}|${block.key}`, stop: sheet.stop, block, warnings: sheet.warnings } : null;
        })
        .filter(Boolean),
    [cache],
  );
  const pages = useMemo(() => pagesOf(direction), [pagesOf, direction]);
  const allPages = useMemo(() => (route ? route.directions.flatMap((d) => pagesOf(d)) : []), [route, pagesOf]);
  const changedPages = useMemo(() => allPages.filter((p) => changed.has(p.stop.id)), [allPages, changed]);
  const linePage = pages.find((p) => p.stop.id === stopId) || pages[0] || null;
  const posterSheet = mode === "stop" && posterId ? posters.sheets.get(posterId) : null;
  const posterPage = useMemo(() => (posterSheet && posterSheet.blocks.length ? { key: `poster|${posterSheet.stop.id}`, stop: posterSheet.stop, blocks: posterSheet.blocks, warnings: posterSheet.warnings } : null), [posterSheet]);
  const page = mode === "stop" ? posterPage : linePage;
  const shownStop = linePage?.stop.id || stopId;
  const complete = mode === "stop" ? Boolean(posterPage) && !loading.busy : Boolean(route) && !loading.busy && route.directions.every((d) => d.stops.every((id) => cache.sheets.has(id)));

  const paper = useMemo(() => paperOf(prefs), [prefs]);
  const shownPrefs = useMemo(() => ({ ...prefs, network: prefs.network || setup?.agency?.name || "" }), [prefs, setup]);
  const meta = mode === "stop" ? posters.meta : cache.meta;
  const labels = meta?.labels || null;
  const watermark = (meta ? meta.watermark : setup?.watermark) || null;
  const locked = watermark === "preview";
  const school = useMemo(() => schoolLinesOf(meta?.school, lang), [meta, lang]);

  const onDense = useCallback((k, overflow) => {
    setDense((prev) => {
      if (Boolean(prev.get(k)) === overflow) return prev;
      const next = new Map(prev);
      if (overflow) next.set(k, true);
      else next.delete(k);
      return next;
    });
  }, []);
  // What to look at before printing, per stop of the direction.
  const alertsOf = useCallback(
    (id) => {
      const sheet = cache.sheets.get(id);
      if (!sheet) return [];
      const out = [];
      if (!sheet.blocks.some((b) => b.direction_id === direction?.direction_id)) out.push(t("sheets.warn.noDepartures", { stop: sheet.stop.name }));
      for (const w of sheet.warnings) {
        if (w.code === "duplicate_departures") out.push(t("sheets.warn.duplicates", { stop: sheet.stop.name, line: w.line, count: w.count }));
        else if (w.code === "untimed_calls") out.push(t("sheets.warn.untimed", { stop: sheet.stop.name, count: w.count }));
      }
      const p = pages.find((x) => x.stop.id === id);
      if (p && dense.get(p.key)) out.push(t("sheets.warn.dense", { stop: p.stop.name }));
      return out;
    },
    [cache, direction, pages, dense, t],
  );

  const visibleRoutes = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? routes.filter((r) => `${r.short} ${r.long}`.toLowerCase().includes(q)) : routes;
  }, [routes, query]);
  const visiblePlaces = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? places.filter((s) => `${s.name} ${s.code || ""}`.toLowerCase().includes(q)) : places;
  }, [places, query]);

  const go = useCallback(
    (delta) => {
      if (mode === "stop") {
        const list = visiblePlaces.slice(0, MAX_STOPS_LISTED);
        if (!list.length) return;
        const i = Math.max(0, list.findIndex((s) => s.id === posterId));
        setPosterId(list[Math.max(0, Math.min(list.length - 1, i + delta))].id);
        return;
      }
      if (!pages.length) return;
      const i = Math.max(0, pages.findIndex((p) => p.stop.id === shownStop));
      setStopId(pages[Math.max(0, Math.min(pages.length - 1, i + delta))].stop.id);
    },
    [mode, visiblePlaces, posterId, pages, shownStop],
  );
  // ↑ ↓ (and ← →) go through the stops when the focus is not in a field.
  useEffect(() => {
    const onKey = (e) => {
      const tag = String(e.target?.tagName || "").toLowerCase();
      if (["input", "textarea", "select"].includes(tag) || e.target?.isContentEditable || e.altKey || e.ctrlKey || e.metaKey || customizeOpen) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") go(-1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, customizeOpen]);
  useEffect(() => {
    listRef.current?.querySelector('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [shownStop, posterId]);

  const print = async (which) => {
    setPrintMenu(null);
    // Without the licence the offer opens; the print is carried out once it runs and the sheets came back clean.
    if (locked) {
      trackUi("sheets.print", "locked");
      openPaywall("deliver", lock || "subscription_required", () => setPendingPrint(which));
      return;
    }
    trackUi("sheets.print", watermark === "trial" ? "trial" : "licence");
    const list = which === "poster" ? (posterPage ? [posterPage] : []) : which === "one" ? (linePage ? [linePage] : []) : which === "line" ? allPages : which === "changed" ? changedPages : pages;
    if (!list.length || !labels) return;
    setPrinting(true);
    try {
      const tooDense = await printSheets({ pages: list, labels, prefs: shownPrefs, paper, watermark, school });
      if (tooDense.length) setDense((prev) => new Map([...prev, ...tooDense.map((k) => [k, true])]));
    } finally {
      setPrinting(false);
    }
  };

  useEffect(() => {
    if (!pendingPrint || !complete || locked || !labels) return;
    const which = pendingPrint;
    setPendingPrint(null);
    print(which);
    // print reads the state of this render; it is not a dependency to follow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPrint, complete, locked, labels]);

  const shortDate = (iso) => new Intl.DateTimeFormat(language, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
  const periodLabel = (p) => `${shortDate(p.from)} → ${shortDate(p.to)}`;

  if (setupError) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={() => setRetry((n) => n + 1)}>{t("sheets.retry")}</Button>}>
          {humanError(setupError, t)?.message}
        </Alert>
      </Box>
    );
  }
  if (!setup) {
    return (
      <Box sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <CircularProgress size={32} />
      </Box>
    );
  }
  if (!routes.length) {
    return (
      <Box sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", p: 4 }}>
        <Typography color="text.secondary">{t("sheets.noLines")}</Typography>
      </Box>
    );
  }

  const rule = theme.palette.divider;
  const directionAlerts = (direction?.stops || []).reduce((n, id) => n + alertsOf(id).length, 0);
  const poster = mode === "stop" ? stopsById.get(posterId) || null : null;
  const posterRoutes = poster ? poster.lines.map((id) => routesById.get(id)).filter(Boolean) : [];
  const periodField = (
    <TextField select size="small" label={t("sheets.period.title")} value={periodKey} onChange={(e) => setPeriodKey(e.target.value)} sx={{ minWidth: 200 }} inputProps={{ "data-testid": "sheets-period" }}>
      {setup.periods.map((p, i) => (
        <MenuItem key={`${p.from}-${p.to}`} value={`p${i}`}>
          {periodLabel(p)}
        </MenuItem>
      ))}
      {setup.range && <MenuItem value="all">{t("sheets.period.whole")}</MenuItem>}
      {periodKey === "custom" && <MenuItem value="custom">{custom.from && custom.to ? periodLabel(custom) : t("sheets.period.customDates")}</MenuItem>}
    </TextField>
  );
  const customizeButton = (
    <Button color="inherit" startIcon={<TuneIcon />} onClick={() => setCustomizeOpen((o) => !o)} aria-pressed={customizeOpen} data-testid="sheets-customize-open" sx={{ textTransform: "none", fontWeight: 600, color: customizeOpen ? "primary.main" : "text.secondary", bgcolor: customizeOpen ? alpha(theme.palette.primary.main, 0.08) : "transparent" }}>
      {t("sheets.customize.open")}
    </Button>
  );
  const printIcon = printing ? <CircularProgress size={16} color="inherit" /> : locked ? <LockOutlinedIcon /> : <PrintOutlinedIcon />;
  const customize = (
    <SheetCustomize
      open={customizeOpen}
      onClose={() => setCustomizeOpen(false)}
      setup={setup}
      custom={custom}
      setCustom={setCustom}
      usingCustom={periodKey === "custom"}
      setUsingCustom={(on) => {
        if (on) {
          if (!custom.from && period) setCustom({ from: period.from, to: period.to });
          setPeriodKey("custom");
        } else setPeriodKey("p0");
      }}
      region={region}
      setRegion={setRegion}
      prefs={prefs}
      setPref={setPref}
      sample={mode === "stop" ? { route: posterRoutes[0] || null, headsign: posterSheet?.blocks?.[0]?.headsign || null } : { route, headsign: direction?.headsign || null }}
      calendar={calendar}
      onCalendarChange={onCalendarChange}
      onCalendarSuggest={onCalendarSuggest}
      suggesting={suggesting}
      aiLocked={aiLock === "sign_in_required" || aiLock === "subscription_required"}
    />
  );
  const preview = (
    <Box component="section" aria-label={t("sheets.preview.title")} sx={{ flex: 1, minWidth: 0, display: "flex", bgcolor: theme.palette.mode === "dark" ? alpha(theme.palette.common.white, 0.04) : alpha(theme.palette.common.black, 0.045) }}>
      {page && labels ? (
        <Preview page={page} labels={labels} prefs={shownPrefs} paper={paper} watermark={watermark} school={school} onDense={onDense} />
      ) : (
        <Box sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>{loading.busy ? <CircularProgress size={28} /> : <Typography color="text.secondary">{t(mode === "stop" ? "sheets.noPoster" : "sheets.noSheet")}</Typography>}</Box>
      )}
    </Box>
  );
  const draftBanner = setup.draft && changed.size > 0 && (
    <Box data-testid="sheets-changes" sx={{ display: "flex", alignItems: "center", gap: 1.5, px: 2.5, py: 0.75, borderBottom: `1px solid ${rule}`, bgcolor: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.12 : 0.08) }}>
      <DifferenceOutlinedIcon sx={{ fontSize: 18, color: "warning.dark" }} />
      <Typography variant="body2" sx={{ fontWeight: 700 }}>
        {countWords(t, "sheets.changes.count", changed.size)}
      </Typography>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>
        {t("sheets.changes.lines", { lines: changedLines.join(", ") })}
      </Typography>
    </Box>
  );

  return (
    <Box data-testid="stop-sheets" data-mode={mode} sx={{ flex: 1, minHeight: 0, display: "flex", bgcolor: "background.default" }}>
      <style>{SHEET_CSS}</style>
      <Typography component="h1" sx={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {t("sheets.title")}
      </Typography>

      {/* By line (in the feed's order) or by stop. */}
      <Box component="nav" aria-label={t(mode === "stop" ? "sheets.searchStop" : "sheets.lines")} sx={{ width: 264, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, borderRight: `1px solid ${rule}`, bgcolor: "background.paper" }}>
        <Box sx={{ p: 1.5, pb: 1, display: "flex", flexDirection: "column", gap: 1 }}>
          <SegmentedSwitch
            options={[{ value: "line", label: t("sheets.mode.line") }, { value: "stop", label: t("sheets.mode.stop") }]}
            value={mode}
            onChange={(v) => {
              setMode(v);
              setQuery("");
            }}
            label={t("sheets.title")}
            testid="sheets-mode"
            size="small"
          />
          <TextField
            fullWidth
            size="small"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(mode === "stop" ? "sheets.searchStop" : "sheets.searchLine")}
            inputProps={{ "aria-label": t(mode === "stop" ? "sheets.searchStop" : "sheets.searchLine"), "data-testid": "sheets-search" }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          />
        </Box>
        {mode === "line" ? (
          <Box data-testid="sheets-lines" sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 1, pb: 1 }}>
            {visibleRoutes.map((r) => {
              const on = r.id === routeId;
              const n = changedOfLine(r);
              return (
                <Box
                  key={r.id}
                  component="button"
                  type="button"
                  data-testid="sheets-line"
                  data-route={r.id}
                  aria-current={on ? "true" : undefined}
                  onClick={() => {
                    setRouteId(r.id);
                    setDirIndex(0);
                    setStopId(null);
                  }}
                  sx={{ ...listSx(theme, on), display: "flex", alignItems: "center", gap: 1.25, px: 1, py: 0.9, borderRadius: 2 }}
                >
                  <LineBadge route={r} />
                  <Typography variant="body2" sx={{ flex: 1, minWidth: 0, fontWeight: on ? 700 : 500, lineHeight: 1.25, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {r.long || r.directions.map((d) => d.headsign).join(" ⇄ ")}
                  </Typography>
                  {n > 0 && <ChangedChip label={String(n)} />}
                </Box>
              );
            })}
          </Box>
        ) : (
          <Box ref={listRef} role="list" data-testid="sheets-places" sx={{ flex: 1, minHeight: 0, overflowY: "auto", px: 1, pb: 1 }}>
            {visiblePlaces.slice(0, MAX_STOPS_LISTED).map((s) => {
              const on = s.id === posterId;
              return (
                <Box key={s.id} role="listitem" component="button" type="button" aria-current={on ? "true" : undefined} data-testid="sheets-place" data-stop={s.id} onClick={() => setPosterId(s.id)} sx={{ ...listSx(theme, on), display: "flex", flexDirection: "column", gap: 0.4, px: 1, py: 0.75, borderRadius: 2 }}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1, width: "100%" }}>
                    <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: on ? 700 : 500 }}>
                      {s.name}
                    </Typography>
                    {changedPlaces.has(s.id) && <ChangedChip label={t("sheets.changes.chip")} />}
                  </Box>
                  <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.4 }}>
                    {s.lines.map((id) => routesById.get(id)).filter(Boolean).map((r) => (
                      <LineBadge key={r.id} route={r} size={20} />
                    ))}
                  </Box>
                </Box>
              );
            })}
            {visiblePlaces.length > MAX_STOPS_LISTED && (
              <Typography variant="caption" sx={{ display: "block", px: 1, py: 1, color: "text.secondary" }}>
                {t("sheets.stops.more", { count: visiblePlaces.length - MAX_STOPS_LISTED })}
              </Typography>
            )}
          </Box>
        )}
      </Box>

      {mode === "stop" && (
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* The stop, its lines, the period; one action. */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, px: 2.5, py: 1.25, borderBottom: `1px solid ${rule}`, bgcolor: "background.paper", flexWrap: "wrap", rowGap: 1 }}>
            <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 0.4 }}>
              <Typography sx={{ fontWeight: 750, fontSize: "1.05rem", lineHeight: 1.2 }} noWrap data-testid="sheets-poster-name">
                {poster?.name || ""}
              </Typography>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, flexWrap: "wrap" }}>
                {posterRoutes.map((r) => (
                  <LineBadge key={r.id} route={r} size={22} />
                ))}
                <Typography variant="caption" sx={{ color: "text.secondary", ml: 0.5 }}>
                  {countWords(t, "sheets.poster.lines", posterRoutes.length)}
                </Typography>
              </Box>
            </Box>
            {periodField}
            <Box sx={{ flex: 1 }} />
            {loading.busy && <CircularProgress size={18} aria-label={t("sheets.loading")} />}
            {customizeButton}
            <Button variant="contained" disableElevation startIcon={printIcon} onClick={() => print("poster")} disabled={!complete || !posterPage || printing} data-testid="sheets-print" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("sheets.printPoster")}
            </Button>
          </Box>
          {draftBanner}
          {loading.error && (
            <Alert severity="error" sx={{ m: 1.5 }} action={<Button color="inherit" size="small" onClick={() => setRetry((n) => n + 1)}>{t("sheets.retry")}</Button>}>
              {humanError(loading.error, t)?.message}
            </Alert>
          )}
          {calendar.error && (
            <Alert severity="error" sx={{ m: 1.5 }} onClose={() => setCalendar((c) => ({ ...c, error: null }))} data-testid="sheets-calendar-error">
              {humanError(calendar.error, t)?.message}
            </Alert>
          )}
          <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
            {preview}
            {customize}
          </Box>
        </Box>
      )}

      {mode === "line" && route && direction && (
        <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* The line, its direction, the period; one action. */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 2, px: 2.5, py: 1.25, borderBottom: `1px solid ${rule}`, bgcolor: "background.paper", flexWrap: "wrap", rowGap: 1 }}>
            <LineBadge route={route} size={36} />
            <SegmentedSwitch
              options={route.directions.map((d, i) => ({ value: String(i), label: t("sheets.towards", { place: d.headsign }) }))}
              value={String(dirIndex)}
              onChange={(v) => {
                setDirIndex(Number(v));
                setStopId(null);
              }}
              label={t("sheets.direction")}
              testid="sheets-direction"
              size="large"
            />
            {periodField}
            <Box sx={{ flex: 1 }} />
            {loading.busy && <CircularProgress size={18} aria-label={t("sheets.loading")} />}
            {customizeButton}
            <ButtonGroup variant="contained" disableElevation sx={{ "& .MuiButton-root": { textTransform: "none", fontWeight: 700 } }}>
              <Button startIcon={printIcon} onClick={() => print("direction")} disabled={!complete || !pages.length || printing} data-testid="sheets-print">
                {countWords(t, "sheets.printDirection", pages.length)}
              </Button>
              <Button size="small" onClick={(e) => setPrintMenu(e.currentTarget)} disabled={!complete || printing} aria-label={t("sheets.printMore")} data-testid="sheets-print-more" sx={{ px: 0.5, minWidth: 0 }}>
                <ArrowDropDownIcon />
              </Button>
            </ButtonGroup>
            <Menu anchorEl={printMenu} open={Boolean(printMenu)} onClose={() => setPrintMenu(null)} anchorOrigin={{ vertical: "bottom", horizontal: "right" }} transformOrigin={{ vertical: "top", horizontal: "right" }}>
              <MenuItem onClick={() => print("one")} disabled={!linePage} data-testid="sheets-print-one">
                <ListItemIcon>
                  <DescriptionOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={t("sheets.printOne")} secondary={linePage?.stop.name} />
              </MenuItem>
              <MenuItem onClick={() => print("line")} disabled={!allPages.length} data-testid="sheets-print-line">
                <ListItemIcon>
                  <SwapVertIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={countWords(t, "sheets.printLine", allPages.length)} />
              </MenuItem>
              {setup.draft && (
                <MenuItem onClick={() => print("changed")} disabled={!changedPages.length} data-testid="sheets-print-changed">
                  <ListItemIcon>
                    <DifferenceOutlinedIcon fontSize="small" />
                  </ListItemIcon>
                  <ListItemText primary={countWords(t, "sheets.printChanged", changedPages.length)} />
                </MenuItem>
              )}
            </Menu>
          </Box>
          {draftBanner}
          {loading.error && (
            <Alert severity="error" sx={{ m: 1.5 }} action={<Button color="inherit" size="small" onClick={() => setRetry((n) => n + 1)}>{t("sheets.retry")}</Button>}>
              {humanError(loading.error, t)?.message}
            </Alert>
          )}
          {calendar.error && (
            <Alert severity="error" sx={{ m: 1.5 }} onClose={() => setCalendar((c) => ({ ...c, error: null }))} data-testid="sheets-calendar-error">
              {humanError(calendar.error, t)?.message}
            </Alert>
          )}

          <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
            {/* The direction's stops, one sheet each. */}
            <Box sx={{ width: 248, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, borderRight: `1px solid ${rule}`, bgcolor: "background.paper" }}>
              <Box sx={{ px: 2, py: 1.25, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 1 }}>
                <Typography variant="overline" sx={{ fontWeight: 700, color: "text.secondary", lineHeight: 1.4 }}>
                  {countWords(t, "sheets.stopsCount", direction.stops.length)}
                </Typography>
                {directionAlerts > 0 && (
                  <Typography variant="caption" sx={{ color: "warning.main", fontWeight: 700 }} data-testid="sheets-alerts">
                    {countWords(t, "sheets.checks.count", directionAlerts)}
                  </Typography>
                )}
              </Box>
              <Box ref={listRef} role="list" data-testid="sheets-stops" sx={{ flex: 1, minHeight: 0, overflowY: "auto", pb: 1 }}>
                {direction.stops.map((id, i) => {
                  const s = stopsById.get(id);
                  const on = id === shownStop;
                  const alerts = alertsOf(id);
                  const empty = cache.sheets.has(id) && !pages.some((p) => p.stop.id === id);
                  return (
                    <Box
                      key={id}
                      role="listitem"
                      component="button"
                      type="button"
                      aria-current={on ? "true" : undefined}
                      data-testid="sheets-stop"
                      data-stop={id}
                      onClick={() => setStopId(id)}
                      sx={{ ...listSx(theme, on), display: "grid", gridTemplateColumns: "22px 16px minmax(0, 1fr) auto 18px", alignItems: "center", columnGap: 1, px: 1.5, minHeight: 34 }}
                    >
                      <Typography variant="caption" sx={{ color: "text.disabled", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                        {i + 1}
                      </Typography>
                      <Box sx={{ position: "relative", alignSelf: "stretch", display: "flex", alignItems: "center", justifyContent: "center", "&::before": { content: '""', position: "absolute", left: "50%", ml: "-1.5px", width: 3, top: i === 0 ? "50%" : 0, bottom: i === direction.stops.length - 1 ? "50%" : 0, bgcolor: `#${route.color}` } }}>
                        <Box sx={{ position: "relative", width: on ? 13 : 9, height: on ? 13 : 9, borderRadius: "50%", bgcolor: theme.palette.background.paper, border: `${on ? 3 : 2}px solid ${on ? theme.palette.text.primary : `#${route.color}`}` }} />
                      </Box>
                      <Typography variant="body2" noWrap sx={{ fontWeight: on ? 700 : 500, color: empty ? "text.disabled" : "text.primary" }}>
                        {s?.name || id}
                      </Typography>
                      {changed.has(id) ? <ChangedChip label={t("sheets.changes.chip")} /> : <span />}
                      {alerts.length > 0 ? (
                        <Tooltip title={alerts.join(" · ")} arrow placement="right">
                          <ErrorOutlineIcon sx={{ fontSize: 16, color: "warning.main" }} />
                        </Tooltip>
                      ) : (
                        <span />
                      )}
                    </Box>
                  );
                })}
              </Box>
            </Box>
            {preview}
            {/* Beside the sheet, which shrinks to stay whole while it is open. */}
            {customize}
          </Box>
        </Box>
      )}
    </Box>
  );
}
