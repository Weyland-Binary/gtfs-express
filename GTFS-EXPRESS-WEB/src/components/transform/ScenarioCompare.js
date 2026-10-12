/**
 * ScenarioCompare — two or three scenarios side by side, each simulated on
 * the feed as it is now (one after the other, with progress), in the
 * figures an authority arbitrates on: steps simulated / blocked, the
 * change in kilometres, service hours, operating cost and vehicles at the
 * peak, the quality score after, the brief's MUST requirements met, stops
 * losing all service and — when the server estimates ridership — trips a
 * day, estimated on the feed each scenario would produce (POST
 * /transform/demand with its preview id), with how far to trust it. The
 * best value of each row is highlighted; any scenario can be loaded from
 * its column. The table is exported as it reads (`change-compare-export`, a
 * .csv: one row per figure, one column per scenario) — the comparison the
 * dissolved Project Studio delivered, written from what this screen shows.
 */

import React, { useEffect, useId, useMemo, useState } from "react";
import { Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, LinearProgress, Typography, alpha, useMediaQuery, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { fetchDemand, isUnavailable, previewChangePlan } from "../../utils/transformApi";
import { estimatedTrips } from "../../utils/ridership";
import { activeScenario, isPlanEmpty } from "../../utils/changeScenarios";
import { formatDate } from "./localDates";
import { saveBlob } from "../../utils/deliverablesApi";

export const MAX_COMPARED = 3;
const DRAFT = "__draft__";

/** The comparable figures of one simulated scenario. */
export const scenarioKpis = (preview, scenario = null) => {
  if (!preview) return null;
  const steps = preview.steps || [];
  const imp = preview.impact && !preview.impact.error ? preview.impact : null;
  const zero = preview.empty ? 0 : null;
  const musts = (preview.conformance?.after?.results || []).filter((r) => r.level === "must");
  const q = preview.quality && !preview.quality.error ? preview.quality.score : null;
  // An estimate of no trip at all is none (utils/ridership): « — », never « 0 ».
  const trips = estimatedTrips(null, preview.kpis) ?? estimatedTrips(preview.demand) ?? estimatedTrips(null, scenario?.origin?.kpis_after);
  return {
    steps: { applied: steps.filter((s) => s.status === "applied").length, blocked: steps.filter((s) => s.status === "blocked" || s.status === "failed").length },
    km: imp ? imp.totals.km.delta : zero,
    hours: imp ? imp.totals.hours.delta : zero,
    cost: imp ? imp.totals.cost.delta : zero,
    currency: imp?.currency || null,
    fleet: imp ? imp.totals.fleet.delta : zero,
    quality: q ? { after: q.after, grade: q.grade_after, delta: q.after - q.before } : null,
    musts: musts.length ? { met: musts.filter((r) => r.status === "pass").length, total: musts.length } : null,
    lostStops: imp ? (imp.stops?.lost || []).length : zero,
    tripsDay: Number.isFinite(trips) ? trips : null,
    window: imp?.window || null,
  };
};

// Each row: how to read its value and which one is best (cost-like rows: the lowest).
const ROWS = [
  { key: "steps", score: (k) => k.steps.blocked * 1000 - k.steps.applied, best: "min" },
  { key: "km", score: (k) => k.km, best: "min" },
  { key: "hours", score: (k) => k.hours, best: "min" },
  { key: "cost", score: (k) => k.cost, best: "min" },
  { key: "fleet", score: (k) => k.fleet, best: "min" },
  { key: "quality", score: (k) => k.quality?.after ?? null, best: "max" },
  { key: "musts", score: (k) => (k.musts ? k.musts.met / k.musts.total : null), best: "max" },
  { key: "lostStops", score: (k) => k.lostStops, best: "min" },
  { key: "tripsDay", score: (k) => k.tripsDay, best: "max" },
];

/** The column index(es) holding the best value of a row (none when all are equal). */
export const bestOf = (row, kpis) => {
  const vals = kpis.map((k) => (k ? row.score(k) : null));
  const known = vals.filter((v) => v != null && Number.isFinite(v));
  if (known.length < 2 || known.every((v) => v === known[0])) return [];
  const target = row.best === "min" ? Math.min(...known) : Math.max(...known);
  return vals.map((v, i) => (v === target ? i : -1)).filter((i) => i >= 0);
};

const signed = (n, lang) => (n == null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(Math.round(n)).toLocaleString(lang || undefined)}`);

/** A CSV field: quoted, its quotes doubled (a scenario's name, a figure with its unit). */
const csvField = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
/**
 * The comparison as a .csv the spreadsheets open (UTF-8 with its byte-order mark, semicolons): the header row
 * names the scenarios, each row is a figure (`label`) and its value in each scenario (`cell`), as on screen.
 */
export const comparisonCsv = ({ names, rows }) => `\ufeff${[["", ...names], ...rows.map((r) => [r.label, ...r.cells])].map((line) => line.map(csvField).join(";")).join("\r\n")}\r\n`;

export default function ScenarioCompare({ open, onClose, ws, onLoad }) {
  const { t, language } = useLanguage();
  // The progress sentence names the bar above it (a gauge, not "Loading").
  const progressId = useId();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const candidates = useMemo(() => {
    if (!ws) return [];
    const list = ws.scenarios.filter((s) => !isPlanEmpty(s.plan)).map((s) => ({ id: s.id, name: s.name, plan: s.plan, scenario: s, updated: s.updated_at || "" }));
    if (!isPlanEmpty(ws.draft?.plan)) list.unshift({ id: DRAFT, name: t("transform.scenario.draft"), plan: ws.draft.plan, scenario: null, updated: ws.draft.updated_at || "" });
    return list;
  }, [ws, t]);
  const [selected, setSelected] = useState([]);
  const [run, setRun] = useState(null); // { index, total, name } while running
  const [results, setResults] = useState(null); // [{ id, name, preview?, error?, kpis }]
  useEffect(() => {
    if (!open) return;
    setResults(null);
    setRun(null);
    // The one being edited first, then the most recent.
    const activeId = activeScenario(ws)?.id || DRAFT;
    const sorted = [...candidates].sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : String(b.updated).localeCompare(String(a.updated))));
    setSelected(sorted.slice(0, MAX_COMPARED).map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= MAX_COMPARED ? s : [...s, id]));
  const compare = async () => {
    const chosen = candidates.filter((c) => selected.includes(c.id));
    const out = [];
    let demandOn = true; // a server without ridership estimates is asked once
    for (const [i, c] of chosen.entries()) {
      setRun({ index: i + 1, total: chosen.length, name: c.name });
      try {
        const preview = await previewChangePlan(c.plan, { language });
        const kpis = scenarioKpis(preview, c.scenario);
        // The ridership of the feed this scenario would produce, on the same demand as today's.
        if (demandOn && preview?.id && !preview.blocked) {
          try {
            const d = await fetchDemand({ previewId: preview.id });
            const trips = estimatedTrips(d?.estimate, d?.kpis);
            if (trips != null) {
              kpis.tripsDay = trips;
              kpis.tripsTrust = { calibrated: Boolean(d.estimate?.calibrated ?? d.kpis?.calibrated), uncertainty: d.estimate?.uncertainty || d.kpis?.uncertainty || null };
            }
          } catch (err) {
            // A missing or stale preview is this scenario's; anything else: the server has no estimates.
            if (isUnavailable(err) && !String(err.code || "").startsWith("PREVIEW_")) demandOn = false;
          }
        }
        out.push({ id: c.id, name: c.name, preview, kpis });
      } catch (err) {
        out.push({ id: c.id, name: c.name, error: err.message, kpis: null });
      }
    }
    setRun(null);
    setResults(out);
  };

  const kpis = (results || []).map((r) => r.kpis);
  const showTrips = kpis.some((k) => k && k.tripsDay != null);
  const rows = ROWS.filter((r) => r.key !== "tripsDay" || showTrips);
  const windowOf = kpis.find((k) => k?.window)?.window || null;
  const trust = kpis.find((k) => k?.tripsTrust)?.tripsTrust || null;
  const cell = (k, key) => {
    if (!k) return "—";
    switch (key) {
      case "steps":
        return t("transform.compare.stepsValue", { applied: k.steps.applied, blocked: k.steps.blocked });
      case "cost":
        return k.cost == null ? "—" : `${signed(k.cost, language)}${k.currency ? ` ${k.currency}` : ""}`;
      case "quality":
        return k.quality ? `${k.quality.grade} ${k.quality.after} (${signed(k.quality.delta, language)})` : "—";
      case "musts":
        return k.musts ? `${k.musts.met} / ${k.musts.total}` : "—";
      case "lostStops":
        return k.lostStops == null ? "—" : String(k.lostStops);
      case "tripsDay":
        return k.tripsDay == null ? "—" : Math.round(k.tripsDay).toLocaleString(language);
      default:
        return signed(k[key], language);
    }
  };

  const exportCsv = () => {
    if (!results) return;
    const csv = comparisonCsv({ names: results.map((r) => r.name), rows: rows.map((row) => ({ label: t(`transform.compare.row.${row.key}`), cells: results.map((r) => cell(r.kpis, row.key)) })) });
    saveBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${t("transform.compare.fileName")}_${new Date().toISOString().slice(0, 10)}.csv`);
  };

  return (
    <Dialog open={open} onClose={run ? undefined : onClose} maxWidth="md" fullWidth fullScreen={fullScreen} data-testid="change-compare">
      <DialogTitle sx={{ fontWeight: 800 }}>{t("transform.compare.title")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        {!results && (
          <>
            <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("transform.compare.pick", { max: MAX_COMPARED })}</Typography>
            <Box sx={{ display: "flex", flexDirection: "column" }}>
              {candidates.map((c) => (
                <FormControlLabel
                  key={c.id}
                  control={<Checkbox size="small" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} disabled={Boolean(run) || (!selected.includes(c.id) && selected.length >= MAX_COMPARED)} inputProps={{ "data-testid": "change-compare-pick" }} />}
                  label={<Typography sx={{ fontSize: "0.82rem" }}>{`${c.name} — ${t("transform.scenario.steps", { count: c.plan.operations.length })}`}</Typography>}
                />
              ))}
            </Box>
          </>
        )}
        {run && (
          <Box data-testid="change-compare-progress">
            <LinearProgress variant="determinate" value={(100 * (run.index - 1)) / run.total} aria-labelledby={progressId} sx={{ borderRadius: 99, mb: 0.75 }} />
            <Typography id={progressId} sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{t("transform.compare.running", { index: run.index, total: run.total, name: run.name })}</Typography>
          </Box>
        )}
        {results && (
          <Box sx={{ overflowX: "auto" }}>
            <Box data-testid="change-compare-table" sx={{ display: "grid", gridTemplateColumns: `minmax(170px, 1.3fr) repeat(${results.length}, minmax(140px, 1fr))`, alignItems: "stretch", minWidth: 170 + 140 * results.length }}>
              <Box />
              {results.map((r) => (
                <Box key={r.id} sx={{ px: 1, py: 0.75, fontWeight: 800, fontSize: "0.8rem" }} data-testid="change-compare-head">
                  {r.name}
                  {r.error && (
                    <Alert severity="error" sx={{ mt: 0.5, py: 0, fontSize: "0.7rem" }}>
                      {t("transform.compare.failed", { message: r.error })}
                    </Alert>
                  )}
                </Box>
              ))}
              {rows.map((row) => {
                const best = bestOf(row, kpis);
                return (
                  <React.Fragment key={row.key}>
                    <Box sx={{ px: 1, py: 0.75, fontSize: "0.76rem", color: "text.secondary", borderTop: `1px solid ${theme.palette.divider}` }}>{t(`transform.compare.row.${row.key}`)}</Box>
                    {results.map((r, i) => (
                      <Box
                        key={r.id}
                        data-testid={`change-compare-cell-${row.key}`}
                        data-best={best.includes(i) ? "true" : "false"}
                        sx={{ px: 1, py: 0.75, fontSize: "0.8rem", fontWeight: best.includes(i) ? 800 : 500, fontVariantNumeric: "tabular-nums", borderTop: `1px solid ${theme.palette.divider}`, background: best.includes(i) ? alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.16 : 0.09) : "transparent", color: best.includes(i) ? "success.main" : "text.primary" }}
                      >
                        {cell(r.kpis, row.key)}
                      </Box>
                    ))}
                  </React.Fragment>
                );
              })}
              <Box sx={{ borderTop: `1px solid ${theme.palette.divider}` }} />
              {results.map((r) => (
                <Box key={r.id} sx={{ px: 1, py: 1, borderTop: `1px solid ${theme.palette.divider}` }}>
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => {
                      onLoad(r.id === DRAFT ? null : r.id);
                      onClose();
                    }}
                    data-testid="change-compare-load"
                    sx={{ textTransform: "none", fontWeight: 700, borderRadius: 99 }}
                  >
                    {t("transform.compare.load")}
                  </Button>
                </Box>
              ))}
            </Box>
            <Typography sx={{ mt: 1, fontSize: "0.68rem", color: "text.secondary", lineHeight: 1.5 }}>
              {t("transform.compare.legend")}
              {windowOf ? ` ${t("transform.compare.window", { from: formatDate(windowOf.from, language), to: formatDate(windowOf.to, language), days: windowOf.days })}` : ""}
              {showTrips && trust ? ` ${trust.calibrated ? t("transform.compare.tripsCalibrated") : t("transform.compare.tripsUncalibrated", { uncertainty: trust.uncertainty || "±50 %" })}` : ""}
            </Typography>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        {results && (
          <Button onClick={exportCsv} data-testid="change-compare-export" sx={{ textTransform: "none" }}>
            {t("transform.compare.export")}
          </Button>
        )}
        {results && (
          <Button onClick={() => setResults(null)} sx={{ textTransform: "none" }}>
            {t("transform.compare.again")}
          </Button>
        )}
        <Button onClick={onClose} disabled={Boolean(run)} sx={{ textTransform: "none" }}>
          {t("app.close")}
        </Button>
        {!results && (
          <Button variant="contained" disableElevation disabled={Boolean(run) || selected.length < 2} onClick={compare} data-testid="change-compare-run" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("transform.compare.run")}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
