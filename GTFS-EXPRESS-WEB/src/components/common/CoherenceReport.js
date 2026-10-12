/**
 * CoherenceReport — the coherence report of step ④ (target design §4 A4,
 * §5 B4, §6.2, D11, M-5): by line × direction × day type (× period when a
 * change touches part of the validity), the first and last departure, the
 * headway at peak and off-peak, the departures, the patterns used, the
 * running time — and what does not hold together, FIRST, in words.
 *
 * The report is the server's (GET /network/coherence, GET
 * /transform/preview/:id/coherence, or the design's dry run): read from the
 * feed, never computed here and never a verdict. A modification reads
 * before → after on the same date; "Only what changes" (the default when
 * comparing) keeps the rows the change touches. The table is a real table
 * (caption, column headers with their scope, the sort said by aria-sort),
 * filtered by line and day type, sorted by any column; it prints on its own
 * in black and white (`coherence-print`) and downloads as CSV
 * (`coherence-csv`) — both load the lines not read yet first, so the file
 * and the page are the whole report, and say what they leave out. A long
 * report comes a page of lines at a time ("next lines"), a slow one says how
 * long it has been running and can be stopped. The column headers are named
 * by their label alone (the sort is said by aria-sort and one shared hint).
 *
 *   <CoherenceReport source={{ kind: "network", sessionId?, clauses? }
 *                           | { kind: "preview", previewId, clauses?, framing? }
 *                           | { kind: "static", report }} pending="…" note="…"
 *                    onResimulate={…} onResume={…} />
 *
 * `source` null renders the section with `pending` (what makes the report
 * appear); `note` is a sentence said above the report (where it comes from,
 * when that is not what the step shows). A refusal is said in place with its
 * action (refusalToAction): Try again; simulate again (`onResimulate`, an
 * expired or older simulation); resume (`onResume`, the network's working
 * copy is gone) — an action is offered only when its host handles it. The
 * report read is remembered for the delivery note
 * (coherenceApi.rememberCoherence).
 *
 * The report as an operator's service-méthode sheet (mission step 7): « Tableur
 * (.xlsx) » (`coherence-xlsx`) and « PDF » (`coherence-pdf`) download the files
 * the SERVER renders from the same data (`exportSource`: the network or the
 * simulation it can read again; a static report — a design's dry run, a
 * frozen scenario — has none unless the host names the version's network:
 * then the buttons are disabled with their reason, `coherence-file-reason`).
 * `labels` ({ network, version, versionAt }) are printed in the files'
 * header as they are.
 *
 * « Chaque ligne cochée devient une clause » (`contractAdd`): each row has a
 * box (`coherence-row-select`); the rows ticked are listed below the table
 * (`coherence-selection`) with their measures, each one a toggle
 * (`coherence-measure`, « garder cette ligne telle quelle » among them), the
 * name of the person who decides (`coherence-add-name`) and « Ajouter au
 * contrat » (`coherence-add-to-contract`): the rows are named to the server by
 * their key — never a value of this page —, the server builds the clauses on
 * the version, measures them there and merges them into the contract
 * (`contractAdd.onMerged(answer)`); what it built and what gave no clause, and
 * why, are said in place (`coherence-added`, `coherence-add-refused`), a
 * refusal with its action (`coherence-add-refusal`). Only on a report the
 * server can read again (a network, a simulation: its `before` side, the
 * version the change starts from). The rows join a contract a person
 * decided: while the contract is a draft (the modify journey's default) the
 * add is disabled with its reason and the way to ② (`coherence-add-undecided`,
 * `coherence-add-open-contract`) — a draft's clauses would be measured by
 * nobody, then dropped when a version records it empty. A network designed
 * here (`journey: "create"`) is not offered « garder telle quelle »: its next
 * build measures the design, with nothing before it to compare with. The
 * answer takes the focus (`coherence-added`), and takes it back once the
 * report is read again.
 *
 *   contractAdd = { contract, name, setName, version: { label, date }, journey, measures, onMerged(answer), onOpenContract? }
 *
 * useCoherenceDownloads() / <CoherenceDownloadNotice>: ⑤'s deliverables that
 * carry the report (the note, the CSV) — one at a time, busy with the time
 * elapsed, and a report that cannot be read said with Try again.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Box, Button, Checkbox, CircularProgress, GlobalStyles, MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography, alpha, useTheme } from "@mui/material";
import TableViewOutlinedIcon from "@mui/icons-material/TableViewOutlined";
import PictureAsPdfOutlinedIcon from "@mui/icons-material/PictureAsPdfOutlined";
import PlaylistAddCheckOutlinedIcon from "@mui/icons-material/PlaylistAddCheckOutlined";
import PrintOutlinedIcon from "@mui/icons-material/PrintOutlined";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import FlagOutlinedIcon from "@mui/icons-material/FlagOutlined";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import { useLanguage } from "../../contexts/LanguageContext";
import RefusalNotice from "./RefusalNotice";
import useElapsed from "./useElapsed";
import { DEFAULT_ROW_MEASURES, ROW_MEASURES, addCoherenceClauses, anomalyText, coherenceForNote, coherenceGaps, dateText, dayTypeLabel, downloadCoherenceCsv, downloadCoherenceFile, exportSourceOf, headwayText, mergeServerContract, lineLabel, loadCoherence, loadCoherencePage, mergePages, periodText, rememberCoherence, runTimeText, schoolCalendarText, sourceKey } from "../../utils/coherenceApi";
import { contractForServer, nameOk } from "../../utils/contract";

const PRINT_CLASS = "gx-print-coherence";
const DAY_ORDER = ["school_weekday", "holiday_weekday", "weekday", "saturday", "sunday_holiday"];

const sameMeasure = (a, b, pick) => JSON.stringify(pick(a)) === JSON.stringify(pick(b));

/** The anomalies that concern a row (its line, its direction, its day type). */
const anomaliesOfRow = (anomalies, row) => anomalies.filter((a) => a.route_id === row.route_id && (!a.day_type || a.day_type === row.day_type) && (a.direction_id == null || a.direction_id === row.direction_id));

// The sortable columns: how a row compares (nulls last).
const SORTS = {
  line: (r, i) => i.line,
  direction: (r) => String(r.direction_name || r.direction_id || ""),
  dayType: (r) => DAY_ORDER.indexOf(r.day_type),
  period: (r) => (r.period ? `${r.period.name === "rest" ? "1" : "0"}${r.period.from}` : ""),
  first: (r) => r.first_departure,
  last: (r) => r.last_departure,
  headway: (r) => r.headway?.peak ?? r.headway?.offpeak ?? null,
  trips: (r) => r.trips,
  patterns: (r) => (r.patterns || []).length,
  runTime: (r) => r.running_time?.max ?? null,
  anomalies: (r, i) => i.anomalies,
};
const compare = (a, b) => (a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));

// The sr-only style (the shared sort hint is read, not shown).
const VISUALLY_HIDDEN = { position: "absolute", width: 1, height: 1, p: 0, m: "-1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 };

/** A row's label for a person: « S1, vers Gare, Semaine ». */
const rowLabel = (r, t) => [lineLabel(r), r.direction_name || r.direction_id, dayTypeLabel(r.day_type, t)].filter(Boolean).join(", ");

export default function CoherenceReport({ source = null, pending = null, note = null, onResimulate = null, onResume = null, testid = "coherence-report", exportSource: exportSourceProp = null, labels = null, contractAdd = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const titleId = useId();
  const sortHintId = useId();
  const key = sourceKey(source);
  const [state, setState] = useState({ key: null, status: "idle", report: null, error: null });
  const [lineFilter, setLineFilter] = useState("");
  const [dayFilter, setDayFilter] = useState("");
  const [onlyChanges, setOnlyChanges] = useState(true);
  const [sort, setSort] = useState({ by: null, dir: "asc" });
  const controller = useRef(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const seconds = useElapsed(state.status === "loading" || state.status === "more");
  // An export waiting for the lines not loaded yet ("csv" | "print"), and a print to run once they are shown.
  const [exporting, setExporting] = useState(null);
  const [printPending, setPrintPending] = useState(false);
  const lastExport = useRef(null);
  // The files the server renders (xlsx, pdf), and the rows ticked for the contract.
  const [file, setFile] = useState({ busy: null, error: null, retry: null });
  const [selected, setSelected] = useState(() => new Map());
  const [adding, setAdding] = useState({ busy: false, error: null, result: null });
  // The answer to « Ajouter au contrat » takes the focus (the button it came from is gone with the ticks), and takes it
  // back after the report is read again (the merged contract makes a new simulation): never left on <body>.
  const addedRef = useRef(null);
  const focusAdded = useRef(false);

  const load = useCallback((offset = 0, previous = null) => {
    const src = sourceRef.current;
    if (!src) return;
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    const k = sourceKey(src);
    lastExport.current = null;
    setState((s) => ({ key: k, status: offset ? "more" : "loading", report: offset ? s.report : null, error: null }));
    loadCoherencePage(src, { offset, signal: ctl.signal })
      .then((page) => {
        if (ctl.signal.aborted) return;
        const report = mergePages(previous, page);
        rememberCoherence(src, report);
        setState({ key: k, status: "ready", report, error: null });
      })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        setState({ key: k, status: "error", report: previous, error: err });
      });
  }, []);

  useEffect(() => {
    // Another report (the contract merged makes a new simulation): the ticks go, the last answer stays said.
    setSelected(new Map());
    setAdding((a) => ({ busy: false, error: null, result: a.result }));
    if (!source) {
      setState({ key: null, status: "idle", report: null, error: null });
      return undefined;
    }
    if (source.kind === "static") {
      rememberCoherence(source, source.report);
      setState({ key, status: source.report?.error ? "unreadable" : "ready", report: source.report?.error ? null : source.report, error: source.report?.error || null });
      return undefined;
    }
    load(0);
    return () => controller.current?.abort();
    // The source's identity is its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const cancel = () => {
    controller.current?.abort();
    setExporting(null);
    setState((s) => ({ ...s, status: "cancelled" }));
  };


  const report = state.report;
  const comparing = report?.mode === "compare";
  const anomalies = useMemo(() => report?.anomalies || [], [report]);

  // The files: rendered by the server from a source it can read again (this report's, else the host's).
  const fileSource = exportSourceOf(source, exportSourceProp);
  const downloadFile = async (format) => {
    if (!fileSource || file.busy) return;
    setFile({ busy: format, error: null, retry: null });
    try {
      await downloadCoherenceFile(fileSource, format, { network: labels?.network || null, version: labels?.version || null, versionAt: labels?.versionAt || null, lang: language });
      setFile({ busy: null, error: null, retry: null });
    } catch (err) {
      setFile({ busy: null, error: err, retry: () => downloadFile(format) });
    }
  };

  // The rows ticked for the contract: only on a report the server reads again, never a static one.
  const tickable = Boolean(contractAdd && source && (source.kind === "network" || source.kind === "preview") && report?.version?.fingerprint);
  // The measures the host offers (a network designed here has no « garder telle quelle »: nothing to compare it with
  // at its next build), and those ticked by default.
  const measures = Array.isArray(contractAdd?.measures) && contractAdd.measures.length ? ROW_MEASURES.filter((m) => contractAdd.measures.includes(m)) : ROW_MEASURES;
  const defaultMeasures = DEFAULT_ROW_MEASURES.filter((m) => measures.includes(m));
  // The rows join a contract a person decided (decided, assumed — or empty, which they then decide): a draft's
  // clauses are measured by nobody and a version made from it records it empty, so ② decides it first.
  const contractReady = ["decided", "assumed", "empty"].includes(contractAdd?.contract?.status);
  const toggleRow = (row) =>
    setSelected((m) => {
      const next = new Map(m);
      if (next.has(row.key)) next.delete(row.key);
      else next.set(row.key, new Set(defaultMeasures));
      return next;
    });
  const toggleMeasure = (key, measure) =>
    setSelected((m) => {
      const next = new Map(m);
      const set = new Set(next.get(key) || []);
      if (set.has(measure)) set.delete(measure);
      else set.add(measure);
      next.set(key, set);
      return next;
    });
  const picks = [...selected.entries()].map(([key, set]) => [key, measures.filter((m) => set.has(m))]).filter(([, list]) => list.length > 0).map(([key, list]) => ({ key, measures: list }));
  const deciderOk = nameOk(contractAdd?.name || "");
  const addToContract = async () => {
    if (!tickable || adding.busy || !picks.length || !deciderOk || !contractReady) return;
    setAdding({ busy: true, error: null, result: null });
    try {
      const answer = await addCoherenceClauses(source, { fingerprint: report.version.fingerprint, rows: picks, by: { name: contractAdd.name.trim() }, contract: contractForServer(contractAdd.contract), version: contractAdd.version || null, journey: contractAdd.journey || null, lang: language });
      contractAdd.onMerged?.(answer, contractAdd.name.trim());
      focusAdded.current = true;
      setSelected(new Map());
      setAdding({ busy: false, error: null, result: { ...answer, by: contractAdd.name.trim() } });
    } catch (err) {
      setAdding({ busy: false, error: err, result: null });
    }
  };
  const onAddRefusal = (id) => {
    if (id === "openContract") contractAdd?.onOpenContract?.();
    // Rows of another version, or a row the report has not: the report is read again (its rows are the version's now), the ticks dropped.
    else if (id === "reload") {
      setSelected(new Map());
      setAdding({ busy: false, error: null, result: null });
      load(0);
    }
    else if (id === "retry") addToContract();
  };

  // Rows: filtered, then sorted (the server's order — line, direction, day type, period — by default).
  const rows = useMemo(() => {
    if (!report) return [];
    const order = new Map();
    report.rows.forEach((r) => {
      if (!order.has(r.route_id)) order.set(r.route_id, order.size);
    });
    let list = report.rows.map((r, idx) => ({ r, idx, i: { line: order.get(r.route_id), anomalies: anomaliesOfRow(anomalies, r).length } }));
    if (lineFilter) list = list.filter((x) => x.r.route_id === lineFilter);
    if (dayFilter) list = list.filter((x) => x.r.day_type === dayFilter);
    if (comparing && onlyChanges) list = list.filter((x) => x.r.changed);
    if (sort.by && SORTS[sort.by]) {
      const f = SORTS[sort.by];
      list = [...list].sort((a, b) => (sort.dir === "asc" ? 1 : -1) * compare(f(a.r, a.i), f(b.r, b.i)) || a.idx - b.idx);
    }
    return list;
  }, [report, anomalies, lineFilter, dayFilter, comparing, onlyChanges, sort]);

  const lines = useMemo(() => {
    const seen = new Map();
    for (const r of report?.rows || []) if (!seen.has(r.route_id)) seen.set(r.route_id, lineLabel(r));
    return [...seen];
  }, [report]);

  const printNow = () => {
    document.body.classList.add(PRINT_CLASS);
    const done = () => {
      document.body.classList.remove(PRINT_CLASS);
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    try {
      window.print();
    } finally {
      // Browsers that print synchronously (and test runners) never fire afterprint.
      setTimeout(done, 1000);
    }
  };

  // The CSV and the print are the whole report: the lines not loaded yet are read first (with the time said).
  const exportWhole = (what) => {
    const src = sourceRef.current;
    const current = state.report;
    if (!current || exporting) return;
    lastExport.current = what;
    // `loaded`: new lines were read, the print waits for them to be on the page; else it runs now.
    const done = (whole, loaded) => {
      lastExport.current = null;
      if (what === "csv") downloadCoherenceCsv(whole, t, language);
      else if (loaded) setPrintPending(true);
      else printNow();
    };
    if (current.next_offset == null || !src || src.kind === "static") return done(current, false);
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    const k = sourceKey(src);
    setExporting(what);
    setState((s) => ({ ...s, key: k, status: "more", error: null }));
    loadCoherence(src, { signal: ctl.signal, from: current, onPage: (r) => !ctl.signal.aborted && setState({ key: k, status: "more", report: r, error: null }) })
      .then((whole) => {
        if (ctl.signal.aborted) return;
        rememberCoherence(src, whole);
        setState({ key: k, status: "ready", report: whole, error: null });
        setExporting(null);
        done(whole, true);
      })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        setExporting(null);
        setState((s) => ({ ...s, key: k, status: "error", error: err }));
      });
    return undefined;
  };
  // The refusal's actions this report can take: try again always; simulate again and resume when the host handles them.
  const supported = ["retry", ...(onResimulate ? ["resimulate"] : []), ...(onResume ? ["resume"] : [])];
  const onRefusalAction = (id) => {
    if (id === "resimulate") onResimulate?.();
    else if (id === "resume") onResume?.();
    else if (id === "retry") {
      if (lastExport.current) exportWhole(lastExport.current);
      else if (state.report) load(state.report.next_offset || 0, state.report);
      else load(0);
    }
  };
  // The answer keeps the focus while the report is read again: given back when it is shown and the focus was lost
  // (on <body>); the person moving it elsewhere ends that.
  useEffect(() => {
    if (!focusAdded.current || state.status !== "ready" || !addedRef.current) return;
    const active = document.activeElement;
    if (!active || active === document.body) addedRef.current.focus();
    else if (active !== addedRef.current) focusAdded.current = false;
  });
  // The print runs once the whole report is on the page.
  useEffect(() => {
    if (!printPending || state.status !== "ready") return;
    setPrintPending(false);
    printNow();
  }, [printPending, state.status]);

  const border = theme.palette.divider;
  const muted = theme.palette.text.secondary;
  const warn = theme.palette.warning.main;

  const cellValue = (row, pick, format) => {
    const after = format(pick(row));
    if (!comparing || !row.before || sameMeasure(row, row.before, pick)) return after;
    return (
      <span>
        <Box component="span" sx={{ color: muted }}>
          {format(pick(row.before))}
        </Box>
        {" → "}
        <strong>{after}</strong>
      </span>
    );
  };
  const text = (v) => (v == null || v === "" ? "—" : String(v));
  const columns = [
    ["line", t("coherence.col.line")],
    ["direction", t("coherence.col.direction")],
    ["dayType", t("coherence.col.dayType")],
    ...(comparing ? [["period", t("coherence.col.period")]] : []),
    ["first", t("coherence.col.first")],
    ["last", t("coherence.col.last")],
    ["headway", t("coherence.col.headway")],
    ["trips", t("coherence.col.trips")],
    ["patterns", t("coherence.col.patterns")],
    ["runTime", t("coherence.col.runTime")],
    ["anomalies", t("coherence.col.anomalies")],
  ];
  const toggleSort = (by) => setSort((s) => (s.by === by ? { by, dir: s.dir === "asc" ? "desc" : "asc" } : { by, dir: "asc" }));

  const busy = state.status === "loading";
  const body = (() => {
    if (!source) return pending ? <Typography data-testid="coherence-pending" sx={{ fontSize: "0.8rem", color: muted }}>{pending}</Typography> : null;
    if (busy)
      return (
        <Box data-testid="coherence-running" sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Typography sx={{ fontSize: "0.8rem", color: muted }}>{t("coherence.loading", { seconds })}</Typography>
          <Button size="small" onClick={cancel} data-testid="coherence-cancel" data-no-print sx={{ textTransform: "none" }}>
            {t("coherence.cancel")}
          </Button>
        </Box>
      );
    if (state.status === "cancelled")
      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Typography sx={{ fontSize: "0.8rem", color: muted }}>{t("coherence.cancelled")}</Typography>
          <Button size="small" onClick={() => load(0)} data-testid="coherence-retry" sx={{ textTransform: "none" }}>
            {t("coherence.retry")}
          </Button>
        </Box>
      );
    if (state.status === "unreadable") return <Typography data-testid="coherence-unreadable" sx={{ fontSize: "0.8rem", color: muted }}>{t("coherence.unreadable", { reason: String(state.error || "") })}</Typography>;
    if (state.status === "error" && !report) return <RefusalNotice refusal={state.error} onAction={onRefusalAction} supported={supported} testid="coherence-refusal" />;
    return null;
  })();

  return (
    <Box component="section" aria-labelledby={titleId} data-testid={testid} data-print-root="coherence" data-state={state.status === "idle" && !source ? "waiting" : state.status} data-mode={report?.mode || ""} sx={{ p: 1.5, borderRadius: "12px", border: `1px solid ${border}`, background: theme.palette.background.paper, display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
      <GlobalStyles
        styles={{
          "@media print": {
            [`body.${PRINT_CLASS} *`]: { visibility: "hidden" },
            [`body.${PRINT_CLASS} [data-print-root="coherence"], body.${PRINT_CLASS} [data-print-root="coherence"] *`]: { visibility: "visible", color: "#000 !important", background: "#fff !important", boxShadow: "none !important" },
            [`body.${PRINT_CLASS} [data-print-root="coherence"]`]: { position: "absolute", left: 0, top: 0, width: "100%", border: "0 !important" },
            [`body.${PRINT_CLASS} [data-no-print]`]: { display: "none !important" },
            [`body.${PRINT_CLASS} [data-print-root="coherence"] tr`]: { breakInside: "avoid" },
          },
        }}
      />
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Typography id={titleId} component="h2" sx={{ fontSize: "0.86rem", fontWeight: 800, flex: 1, minWidth: 220 }}>
          {t("coherence.title")}
        </Typography>
        <Box data-no-print sx={{ display: "flex", gap: 0.75 }}>
          <Button size="small" variant="outlined" startIcon={<PrintOutlinedIcon />} onClick={() => exportWhole("print")} disabled={!report || Boolean(exporting)} data-testid="coherence-print" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("coherence.print")}
          </Button>
          <Button size="small" variant="outlined" startIcon={<FileDownloadOutlinedIcon />} onClick={() => exportWhole("csv")} disabled={!report || Boolean(exporting)} data-testid="coherence-csv" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("coherence.csv")}
          </Button>
          <Button size="small" variant="outlined" startIcon={file.busy === "xlsx" ? <CircularProgress size={12} color="inherit" /> : <TableViewOutlinedIcon />} onClick={() => downloadFile("xlsx")} disabled={!report || !fileSource || Boolean(file.busy)} aria-describedby={!fileSource && report ? `${titleId}-file-reason` : undefined} data-testid="coherence-xlsx" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("coherence.xlsx")}
          </Button>
          <Button size="small" variant="outlined" startIcon={file.busy === "pdf" ? <CircularProgress size={12} color="inherit" /> : <PictureAsPdfOutlinedIcon />} onClick={() => downloadFile("pdf")} disabled={!report || !fileSource || Boolean(file.busy)} aria-describedby={!fileSource && report ? `${titleId}-file-reason` : undefined} data-testid="coherence-pdf" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("coherence.pdf")}
          </Button>
        </Box>
      </Box>
      {report && !fileSource && (
        <Typography id={`${titleId}-file-reason`} data-no-print data-testid="coherence-file-reason" sx={{ fontSize: "0.74rem", color: muted }}>
          {t("coherence.file.unavailable")}
        </Typography>
      )}
      {file.error && <RefusalNotice refusal={file.error} onAction={(id) => id === "retry" && file.retry?.()} supported={["retry"]} testid="coherence-file-refusal" />}
      {note && (
        <Typography data-testid="coherence-note" sx={{ fontSize: "0.76rem", color: muted, lineHeight: 1.45 }}>
          {note}
        </Typography>
      )}
      {body}
      {report && (
        <>
          {report.school_calendar && (
            <Typography data-testid="coherence-school" sx={{ fontSize: "0.74rem", color: muted, lineHeight: 1.45 }}>
              {schoolCalendarText(report.school_calendar, t, language)}
            </Typography>
          )}
          {/* The anomalies first, in words, before the grid (RGAA 5: the table's summary in text). */}
          <Box data-testid="coherence-anomalies" data-count={anomalies.length}>
            <Typography component="h3" sx={{ fontSize: "0.8rem", fontWeight: 800, mb: 0.25 }}>
              {t("coherence.anomalies", { count: anomalies.length })}
            </Typography>
            {anomalies.length ? (
              <Box component="ul" sx={{ m: 0, pl: 2.25, display: "flex", flexDirection: "column", gap: 0.25 }}>
                {anomalies.map((a, i) => {
                  const { head, text: sentence } = anomalyText(a, t, language);
                  return (
                    <Typography component="li" key={`${a.code}-${i}`} data-testid="coherence-anomaly" data-code={a.code} data-preexisting={a.preexisting ? "true" : "false"} sx={{ fontSize: "0.78rem", lineHeight: 1.5 }}>
                      <FlagOutlinedIcon aria-hidden sx={{ fontSize: 14, color: a.preexisting ? muted : warn, verticalAlign: "-2px", mr: 0.5 }} />
                      {head && <strong>{head} — </strong>}
                      {sentence}
                      {a.preexisting && <Box component="span" sx={{ color: muted }}>{` (${t("coherence.preexisting")})`}</Box>}
                    </Typography>
                  );
                })}
              </Box>
            ) : (
              <Typography data-testid="coherence-no-anomaly" sx={{ fontSize: "0.78rem", color: muted }}>
                {t("coherence.noAnomaly")}
              </Typography>
            )}
          </Box>
          <Box data-no-print sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
            <TextField select size="small" label={t("coherence.filter.line")} value={lineFilter} onChange={(e) => setLineFilter(e.target.value)} SelectProps={{ SelectDisplayProps: { "data-testid": "coherence-filter-line" } }} sx={{ minWidth: 160 }}>
              <MenuItem value="">{t("coherence.filter.allLines")}</MenuItem>
              {lines.map(([id, name]) => (
                <MenuItem key={id} value={id}>
                  {name}
                </MenuItem>
              ))}
            </TextField>
            <TextField select size="small" label={t("coherence.filter.dayType")} value={dayFilter} onChange={(e) => setDayFilter(e.target.value)} SelectProps={{ SelectDisplayProps: { "data-testid": "coherence-filter-daytype" } }} sx={{ minWidth: 180 }}>
              <MenuItem value="">{t("coherence.filter.allDayTypes")}</MenuItem>
              {(report.day_types || []).map((d) => (
                <MenuItem key={d} value={d}>
                  {dayTypeLabel(d, t)}
                </MenuItem>
              ))}
            </TextField>
            {comparing && !report.frozen && (
              <ToggleButtonGroup exclusive size="small" value={onlyChanges ? "changes" : "all"} onChange={(_, v) => v && setOnlyChanges(v === "changes")} aria-label={t("coherence.view")} data-testid="coherence-only-changes" data-value={onlyChanges ? "changes" : "all"}>
                <ToggleButton value="all" sx={{ textTransform: "none", fontSize: "0.76rem" }}>
                  {t("coherence.all")}
                </ToggleButton>
                <ToggleButton value="changes" sx={{ textTransform: "none", fontSize: "0.76rem" }}>
                  {t("coherence.onlyChanges")}
                </ToggleButton>
              </ToggleButtonGroup>
            )}
          </Box>
          <Box sx={{ overflowX: "auto", maxWidth: "100%" }}>
            <Box
              component="table"
              data-testid="coherence-table"
              sx={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "0.76rem",
                "& caption": { captionSide: "top", textAlign: "left", color: muted, fontSize: "0.72rem", pb: 0.5 },
                "& th, & td": { textAlign: "left", px: 0.75, py: 0.5, borderBottom: `1px solid ${border}`, verticalAlign: "top", whiteSpace: "nowrap" },
                "& th": { fontWeight: 700, color: muted },
                "& td.num, & th.num": { textAlign: "right", fontVariantNumeric: "tabular-nums" },
                "& tr[data-changed='true'] td": { background: alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.1 : 0.06) },
              }}
            >
              <caption>
                {comparing ? t("coherence.caption.compare") : t("coherence.caption")} {t("coherence.rowsShown", { shown: rows.length, total: report.rows.length })}
                {coherenceGaps(report, t).map((gap) => (
                  <Box component="span" key={gap} data-testid="coherence-gap" sx={{ display: "block" }}>
                    {gap}
                  </Box>
                ))}
                <Box component="span" id={sortHintId} sx={VISUALLY_HIDDEN}>
                  {t("coherence.sortHint")}
                </Box>
              </caption>
              <thead>
                <tr>
                  {tickable && (
                    <th scope="col" data-no-print>
                      <Box component="span" sx={VISUALLY_HIDDEN}>
                        {t("coherence.select.column")}
                      </Box>
                    </th>
                  )}
                  {columns.map(([id, label]) => {
                    const active = sort.by === id;
                    const numeric = ["headway", "trips", "patterns", "runTime", "anomalies"].includes(id);
                    return (
                      <th key={id} scope="col" className={numeric ? "num" : undefined} aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                        <Box component="button" type="button" onClick={() => toggleSort(id)} data-testid={`coherence-sort-${id}`} aria-describedby={sortHintId} sx={{ all: "unset", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 0.25, "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2, borderRadius: "3px" } }}>
                          {label}
                          {active && (sort.dir === "asc" ? <ArrowUpwardIcon aria-hidden sx={{ fontSize: 12 }} /> : <ArrowDownwardIcon aria-hidden sx={{ fontSize: 12 }} />)}
                        </Box>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ r, i }) => (
                  <tr key={`${r.route_id}|${r.direction_id}|${r.day_type}|${r.period?.from || ""}|${r.period?.name || ""}`} data-testid="coherence-row" data-route={r.route_id} data-day-type={r.day_type} data-changed={r.changed ? "true" : "false"} data-key={r.key || ""} data-selected={selected.has(r.key) ? "true" : "false"}>
                    {tickable && (
                      <td data-no-print style={{ paddingTop: 0, paddingBottom: 0 }}>
                        <Checkbox size="small" checked={selected.has(r.key)} onChange={() => toggleRow(r)} disabled={!r.key || adding.busy} inputProps={{ "aria-label": t("coherence.select.row", { row: rowLabel(r, t) }), "data-testid": "coherence-row-select" }} sx={{ p: 0.25 }} />
                      </td>
                    )}
                    <th scope="row" style={{ color: "inherit" }}>
                      {r.route_color && <Box component="span" aria-hidden sx={{ display: "inline-block", width: 8, height: 8, borderRadius: "2px", background: `#${r.route_color}`, mr: 0.5 }} />}
                      {lineLabel(r)}
                    </th>
                    <td>{text(r.direction_name || r.direction_id)}</td>
                    <td title={t("coherence.representative", { date: dateText(r.date, language), days: r.days })}>{dayTypeLabel(r.day_type, t)}</td>
                    {comparing && <td>{r.period ? periodText(r.period, t, language) : t("coherence.period.whole")}</td>}
                    <td>{cellValue(r, (m) => m.first_departure, text)}</td>
                    <td>{cellValue(r, (m) => m.last_departure, text)}</td>
                    <td className="num">{cellValue(r, (m) => m.headway, (h) => headwayText(h, t))}</td>
                    <td className="num">{cellValue(r, (m) => m.trips, text)}</td>
                    <td className="num" title={(r.patterns || []).map((p) => t("coherence.pattern.detail", { from: p.from || "—", to: p.to || "—", stops: p.stops, trips: p.trips })).join("\n")}>
                      {cellValue(r, (m) => (m.patterns || []).length, text)}
                    </td>
                    <td className="num">{cellValue(r, (m) => m.running_time, (rt) => runTimeText(rt, t))}</td>
                    <td className="num">{i.anomalies ? <Box component="span" sx={{ color: warn, fontWeight: 700 }}>{`⚑ ${i.anomalies}`}</Box> : ""}</td>
                  </tr>
                ))}
              </tbody>
            </Box>
          </Box>
          {contractAdd && !tickable && source && (
            <Typography data-no-print data-testid="coherence-select-unavailable" sx={{ fontSize: "0.74rem", color: muted }}>
              {t("coherence.select.unavailable")}
            </Typography>
          )}
          {tickable && (selected.size > 0 || adding.result || adding.error) && (
            <Box component="section" aria-label={t("coherence.select.title")} data-no-print data-testid="coherence-selection" data-count={picks.length} sx={{ p: 1.25, borderRadius: "10px", border: `1px solid ${alpha(theme.palette.primary.main, 0.35)}`, background: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.08 : 0.03), display: "flex", flexDirection: "column", gap: 0.75 }}>
              {selected.size > 0 && (
                <>
                  <Typography component="h3" sx={{ fontSize: "0.8rem", fontWeight: 800 }}>
                    {t("coherence.select.title")}
                  </Typography>
                  <Typography sx={{ fontSize: "0.74rem", color: muted, lineHeight: 1.45 }}>{comparing ? t("coherence.select.hintPreview", { version: contractAdd.version?.label || "—" }) : t("coherence.select.hint", { version: contractAdd.version?.label || "—" })}</Typography>
                  <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.75 }}>
                    {[...selected.entries()].map(([key, set]) => {
                      const row = report.rows.find((x) => x.key === key);
                      if (!row) return null;
                      const label = rowLabel(row, t);
                      return (
                        <Box component="li" key={key} data-testid="coherence-selected-row" data-key={key} sx={{ display: "flex", flexDirection: "column", gap: 0.4 }}>
                          <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                            <Typography sx={{ fontSize: "0.78rem", fontWeight: 700, flex: 1, minWidth: 200 }}>
                              {label}
                              {row.period && <Box component="span" sx={{ color: muted, fontWeight: 400 }}>{` — ${periodText(row.period, t, language)}`}</Box>}
                            </Typography>
                            <Button size="small" onClick={() => toggleRow(row)} disabled={adding.busy} data-testid="coherence-selected-remove" aria-label={`${t("coherence.select.remove")} — ${label}`} sx={{ textTransform: "none" }}>
                              {t("coherence.select.remove")}
                            </Button>
                          </Box>
                          <Box role="group" aria-label={t("coherence.select.measures", { row: label })} sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
                            {measures.map((m) => (
                              <Button key={m} size="small" variant={set.has(m) ? "contained" : "outlined"} aria-pressed={set.has(m)} onClick={() => toggleMeasure(key, m)} disabled={adding.busy} data-testid="coherence-measure" data-measure={m} data-on={set.has(m) ? "true" : "false"} sx={{ textTransform: "none", fontSize: "0.72rem", py: 0.1, minWidth: 0 }}>
                                {t(`coherence.measure.${m}`)}
                              </Button>
                            ))}
                          </Box>
                        </Box>
                      );
                    })}
                  </Box>
                  {!contractReady && (
                    // The reason the add is disabled, said in text, with the way forward (② decides the contract).
                    <Box data-testid="coherence-add-undecided" data-status={contractAdd.contract?.status || "none"} sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                      <Typography id={`${titleId}-undecided`} sx={{ fontSize: "0.76rem", color: "text.primary", fontWeight: 600, lineHeight: 1.45, flex: 1, minWidth: 220 }}>
                        {t("coherence.select.undecided")}
                      </Typography>
                      {contractAdd.onOpenContract && (
                        <Button size="small" variant="outlined" onClick={() => contractAdd.onOpenContract()} data-testid="coherence-add-open-contract" sx={{ textTransform: "none", fontWeight: 700 }}>
                          {t("coherence.select.openContract")}
                        </Button>
                      )}
                    </Box>
                  )}
                  <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, flexWrap: "wrap" }}>
                    <TextField size="small" label={t("coherence.select.name")} value={contractAdd.name || ""} onChange={(e) => contractAdd.setName?.(e.target.value)} helperText={deciderOk ? t("coherence.select.nameHint") : t("coherence.select.nameRequired")} error={!deciderOk && Boolean(contractAdd.name)} inputProps={{ "data-testid": "coherence-add-name", maxLength: 120 }} sx={{ minWidth: 240 }} />
                    <Button variant="contained" size="small" startIcon={adding.busy ? <CircularProgress size={12} color="inherit" /> : <PlaylistAddCheckOutlinedIcon />} onClick={addToContract} disabled={adding.busy || !picks.length || !deciderOk || !contractReady} aria-describedby={contractReady ? undefined : `${titleId}-undecided`} data-testid="coherence-add-to-contract" sx={{ textTransform: "none", fontWeight: 700, mt: 0.25 }}>
                      {adding.busy ? t("coherence.select.busy") : t("coherence.select.add", { count: picks.length })}
                    </Button>
                    <Button size="small" onClick={() => setSelected(new Map())} disabled={adding.busy} data-testid="coherence-select-clear" sx={{ textTransform: "none", mt: 0.25 }}>
                      {t("coherence.select.clear")}
                    </Button>
                  </Box>
                </>
              )}
              {adding.error && <RefusalNotice refusal={adding.error} onAction={onAddRefusal} supported={["retry", "reload", ...(contractAdd.onOpenContract ? ["openContract"] : [])]} testid="coherence-add-refusal" />}
              {adding.result && (
                <Box ref={addedRef} tabIndex={-1} data-testid="coherence-added" data-count={adding.result.added?.length || 0} data-measured={adding.result.measured ? "true" : "false"} role="status" sx={{ display: "flex", flexDirection: "column", gap: 0.25, outline: "none", "&:focus-visible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2, borderRadius: "4px" } }}>
                  <Typography sx={{ fontSize: "0.78rem", fontWeight: 700 }}>
                    {t("coherence.added", { count: adding.result.added?.length || 0, name: adding.result.by })}
                    {adding.result.kept?.length ? ` ${t("coherence.addedKept", { count: adding.result.kept.length })}` : ""}
                  </Typography>
                  {(adding.result.refused || []).length > 0 && (
                    <Box data-testid="coherence-add-refused" data-count={adding.result.refused.length}>
                      <Typography sx={{ fontSize: "0.74rem", color: muted }}>{t("coherence.refused.title", { count: adding.result.refused.length })}</Typography>
                      <Box component="ul" sx={{ m: 0, pl: 2.25 }}>
                        {adding.result.refused.slice(0, 12).map((x, i) => {
                          const row = report.rows.find((r) => r.key === x.key);
                          return (
                            <Typography component="li" key={`${x.key}-${x.measure}-${i}`} data-reason={x.reason} sx={{ fontSize: "0.74rem", color: muted }}>
                              {`${row ? rowLabel(row, t) : x.key} — ${t(`coherence.measure.${x.measure}`)} : ${t(`coherence.refused.${["no_service", "line_absent", "line_ambiguous", "no_trip", "band_without_service", "keep_not_measurable", "self_check_failed"].includes(x.reason) ? x.reason : "other"}`, { window: x.window || "" })}`}
                            </Typography>
                          );
                        })}
                      </Box>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          )}
          {!rows.length && (
            <Typography data-testid="coherence-empty" sx={{ fontSize: "0.78rem", color: muted }}>
              {comparing && onlyChanges ? t("coherence.noChange") : t("coherence.empty")}
            </Typography>
          )}
          {state.status === "error" && <RefusalNotice refusal={state.error} onAction={onRefusalAction} supported={supported} testid="coherence-refusal" />}
          {report.next_offset != null && source?.kind !== "static" && (
            <Box data-no-print sx={{ display: "flex", alignItems: "center", gap: 1 }}>
              <Button size="small" variant="outlined" onClick={() => load(report.next_offset, report)} disabled={state.status === "more" || Boolean(exporting)} data-testid="coherence-more" sx={{ textTransform: "none", fontWeight: 700 }}>
                {t("coherence.more", { count: report.routes_total - report.next_offset })}
              </Button>
              {state.status === "more" && <Typography sx={{ fontSize: "0.76rem", color: muted }}>{t("coherence.loading", { seconds })}</Typography>}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

/**
 * ⑤'s deliverables that carry the report (the note, the CSV): `run(id,
 * source, deliver)` reads the report (coherenceApi.coherenceForNote) and
 * hands `deliver` { report } or { error }; one at a time (a second click
 * while one runs does nothing), `running` names the one running and
 * `seconds` how long it has; a report that cannot be read leaves `failed`
 * (the id, the error, and `retry`). `required: false` delivers anyway (the
 * note says the report could not be read) and still says the failure.
 */
export function useCoherenceDownloads() {
  const [state, setState] = useState({ running: null, failed: null, error: null, retry: null });
  const busy = useRef(false);
  const seconds = useElapsed(Boolean(state.running));
  const run = useCallback(async (id, source, deliver, { required = true } = {}) => {
    if (busy.current) return;
    busy.current = true;
    setState({ running: id, failed: null, error: null, retry: null });
    const got = await coherenceForNote(source);
    busy.current = false;
    const retry = () => run(id, source, deliver, { required });
    if (got.error && required) {
      setState({ running: null, failed: id, error: got.error, retry });
      return;
    }
    deliver(got);
    setState({ running: null, failed: got.error ? id : null, error: got.error || null, retry: got.error ? retry : null });
  }, []);
  return { ...state, seconds, run };
}

/** The failure of a ⑤ download that needed the report, in place, with Try again (`testid`-refusal). */
export function CoherenceDownloadNotice({ downloads, testid = "delivery-coherence-refusal" }) {
  if (!downloads?.failed || !downloads.error) return null;
  return <RefusalNotice refusal={downloads.error} onAction={(id) => id === "retry" && downloads.retry?.()} supported={["retry"]} testid={testid} />;
}

/** "Reading the report… 12 s" beside the ⑤ button whose download is running (`id`). */
export function CoherenceRunning({ downloads, id }) {
  const { t } = useLanguage();
  if (downloads?.running !== id) return null;
  return (
    <Typography data-testid={`delivery-coherence-running-${id}`} sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
      {t("coherence.loading", { seconds: downloads.seconds })}
    </Typography>
  );
}

/**
 * ⑤'s service-méthode files of the report (mission step 7): « Tableur (.xlsx) » and « PDF », rendered by the
 * server from the version it reads (`source`: a network or a simulation; none: disabled with the reason said),
 * with the project's labels in their header. `testid`-xlsx, `testid`-pdf, a refusal in place (`testid`-refusal).
 */
export function CoherenceFileButtons({ source = null, labels = null, testid = "delivery-coherence" }) {
  const { t, language } = useLanguage();
  const [file, setFile] = useState({ busy: null, error: null, retry: null });
  const run = async (format) => {
    if (!source || file.busy) return;
    setFile({ busy: format, error: null, retry: null });
    try {
      await downloadCoherenceFile(source, format, { network: labels?.network || null, version: labels?.version || null, versionAt: labels?.versionAt || null, lang: language });
      setFile({ busy: null, error: null, retry: null });
    } catch (err) {
      setFile({ busy: null, error: err, retry: () => run(format) });
    }
  };
  return (
    <>
      <Button size="small" variant="outlined" startIcon={file.busy === "xlsx" ? <CircularProgress size={12} color="inherit" /> : <TableViewOutlinedIcon />} onClick={() => run("xlsx")} disabled={!source || Boolean(file.busy)} title={source ? undefined : t("coherence.file.unavailable")} data-testid={`${testid}-xlsx`} sx={{ textTransform: "none", fontWeight: 700 }}>
        {t("coherence.xlsx")}
      </Button>
      <Button size="small" variant="outlined" startIcon={file.busy === "pdf" ? <CircularProgress size={12} color="inherit" /> : <PictureAsPdfOutlinedIcon />} onClick={() => run("pdf")} disabled={!source || Boolean(file.busy)} title={source ? undefined : t("coherence.file.unavailable")} data-testid={`${testid}-pdf`} sx={{ textTransform: "none", fontWeight: 700 }}>
        {t("coherence.pdf")}
      </Button>
      {file.error && <RefusalNotice refusal={file.error} onAction={(id) => id === "retry" && file.retry?.()} supported={["retry"]} testid={`${testid}-file-refusal`} sx={{ width: "100%" }} />}
    </>
  );
}

/**
 * What a host passes as `contractAdd` (« chaque ligne cochée devient une clause »): its contract (useContract's
 * state), the decider's name, the version the rows are measured on ({ n, at } of the project), and the merge — the
 * server's answer applied to the project's contract (mergeServerContract), journaled under the person's name.
 */
export const coherenceContractAdd = ({ contractState, version = null, onOpenContract = null, journey = "modify" }) =>
  contractState
    ? {
        contract: contractState.contract,
        name: contractState.name,
        setName: contractState.setName,
        version: version ? { label: `v${version.n}`, date: typeof version.at === "string" ? version.at.slice(0, 10) : null } : null,
        // A network designed here is measured on its design at the next build, with no feed before it: « garder telle
        // quelle » could never be measured there — not offered (and refused by the server, journey "create").
        journey: journey === "create" ? "create" : "modify",
        measures: journey === "create" ? ROW_MEASURES.filter((m) => m !== "keep") : ROW_MEASURES,
        onMerged: (answer, name) => contractState.setContract((c) => mergeServerContract(c, answer), { actor: name, action: "contract", object: `coherence:${(answer.added || []).length}` }),
        onOpenContract,
      }
    : null;
