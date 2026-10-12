/**
 * DiagnosticPanel — the network as it is, before any change: what works,
 * what is weak, in plain words, then the detailed yardstick every plan is
 * measured against (NetworkHealthCard).
 *
 * When the server estimates ridership (POST /transform/demand), a card
 * shows the estimated trips per day and per line with how far to trust
 * them ("not calibrated ±50 %" / "calibrated on your counts") — an
 * estimate of no trip at all (the model could assign none), or an answer
 * without a total, is said unavailable (no cause guessed), with what to give
 * it, never « environ 0 voyages » —, lets the
 * user bring their own counts (POST /network/demand/data, then the
 * estimate runs again with them) and asks the optimizer for a plan
 * (POST /transform/optimize: more riders at the same cost, N fewer
 * vehicles, or balanced) which the studio loads as a new scenario. A
 * server without these endpoints simply shows no card.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, Chip, CircularProgress, Collapse, FormControlLabel, Radio, RadioGroup, TextField, Typography, alpha, useTheme } from "@mui/material";
import UploadFileOutlinedIcon from "@mui/icons-material/UploadFileOutlined";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import { useLanguage } from "../../contexts/LanguageContext";
import { DEMAND_DATA_ACCEPT, deleteDemandData, fetchDemand, isUnavailable, optimizeChangePlan, uploadDemandData } from "../../utils/transformApi";
import { estimatedTrips } from "../../utils/ridership";
import { QuietButton, SectionHeader, Tag, compactNumber, soft } from "../network/StudioUI";
import { NetworkHealthCard } from "./ChangePlanParts";
import { tf } from "./catalogueText";

const GOOD = 80;
const WEAK = 65;
const LEVEL_RANK = { major: 0, minor: 1, info: 2 };

/** What the measured health says, as lists of plain sentences. */
export const readHealth = (health) => {
  if (!health || health.error || health.score == null) return null;
  const dims = (health.dimensions || []).filter((d) => d.score != null);
  const good = dims.filter((d) => d.score >= GOOD).sort((a, b) => b.score - a.score);
  const weak = dims.filter((d) => d.score < WEAK).sort((a, b) => a.score - b.score);
  const findings = weak.flatMap((d) => (d.findings || []).map((f) => ({ ...f, dimension: f.dimension || d.id }))).sort((a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3));
  const checks = (health.checks || []).filter((c) => c.count > 0 && c.code !== "error");
  return { grade: health.grade, score: Math.round(health.score), good, weak, findings: findings.slice(0, 5), checks, fleet: health.fleet || null };
};

function HealthReading({ health }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const r = readHealth(health);
  if (!r) return null;
  const phrase = (f) => {
    const p = { ...(f.params || {}) };
    if (p.tier) p.tier = tf(t, `transform.quality.tier.${p.tier}`, null, p.tier);
    for (const k of ["main_share", "same_path", "share", "target"]) if (typeof p[k] === "number" && p[k] <= 1) p[k] = `${Math.round(p[k] * 100)} %`;
    if (Array.isArray(p.lines)) p.lines = p.lines.join(", ");
    return `${f.label ? `${t("transform.line", { line: f.label })} — ` : ""}${tf(t, `transform.quality.finding.${f.code}`, p, f.code)}`;
  };
  const tone = r.grade === "A" || r.grade === "B" ? theme.palette.success.main : r.grade === "C" ? theme.palette.warning.main : theme.palette.error.main;
  return (
    <Box data-testid="change-diagnostic-reading" sx={{ p: 1.5, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}`, display: "flex", flexDirection: "column", gap: 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.25 }}>
        <Box sx={{ width: 44, height: 44, borderRadius: "12px", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: alpha(tone, 0.12), color: tone, fontWeight: 900, fontSize: "1.2rem" }}>{r.grade}</Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: "0.9rem", fontWeight: 800 }}>{t(`transform.diag.verdict.${["A", "B", "C", "D"].includes(r.grade) ? r.grade : "C"}`)}</Typography>
          <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("transform.diag.score", { score: r.score })}</Typography>
        </Box>
      </Box>
      {r.good.length > 0 && (
        <Box data-testid="change-diagnostic-good">
          <SectionHeader label={t("transform.diag.good")} />
          {r.good.map((d) => (
            <Box key={d.id} sx={{ display: "flex", gap: 0.75, alignItems: "flex-start", py: 0.25 }}>
              <CheckCircleOutlineIcon sx={{ fontSize: 16, color: "success.main", mt: 0.15, flexShrink: 0 }} />
              <Typography sx={{ fontSize: "0.78rem", lineHeight: 1.5 }}>{tf(t, `transform.diag.good.${d.id}`, null, t(`transform.quality.dim.${d.id}`))}</Typography>
            </Box>
          ))}
        </Box>
      )}
      <Box data-testid="change-diagnostic-weak">
        <SectionHeader label={t("transform.diag.weak")} />
        {!r.weak.length && <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{t("transform.diag.noWeak")}</Typography>}
        {r.weak.map((d) => (
          <Box key={d.id} sx={{ display: "flex", gap: 0.75, alignItems: "flex-start", py: 0.25 }}>
            <ErrorOutlineIcon sx={{ fontSize: 16, color: "warning.main", mt: 0.15, flexShrink: 0 }} />
            <Typography sx={{ fontSize: "0.78rem", lineHeight: 1.5 }}>{tf(t, `transform.diag.weak.${d.id}`, null, t(`transform.quality.dim.${d.id}`))}</Typography>
          </Box>
        ))}
        {r.findings.length > 0 && (
          <Box sx={{ mt: 0.5, pl: 3 }}>
            {r.findings.map((f, i) => (
              <Typography key={i} sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.5 }}>
                • {phrase(f)}
              </Typography>
            ))}
          </Box>
        )}
      </Box>
      {r.fleet && (
        <Typography sx={{ fontSize: "0.76rem", lineHeight: 1.5 }} data-testid="change-diagnostic-fleet">
          {t("transform.diag.fleet", { vehicles: compactNumber(r.fleet.vehicles_line_by_line ?? r.fleet.vehicles, language), interlined: compactNumber(r.fleet.vehicles, language) })}
        </Typography>
      )}
      <Typography sx={{ fontSize: "0.76rem", lineHeight: 1.5, color: r.checks.length ? "warning.main" : "success.main" }}>
        {r.checks.length ? t("transform.diag.checks", { list: r.checks.map((c) => tf(t, `transform.health.check.${c.code}`, { count: c.count }, `${c.code}: ${c.count}`)).join(", ") }) : t("transform.diag.checksOk")}
      </Typography>
    </Box>
  );
}

// ── Estimated ridership, the user's counts, the optimizer ─────────────────

const OBJECTIVES = ["ridership", "vehicles", "balanced"];
const num = (v) => {
  const n = Number(String(v ?? "").replace(",", ".").replace(/\s/g, ""));
  return String(v ?? "").trim() !== "" && Number.isFinite(n) ? n : null;
};

/** The optimizer's request for an objective chosen in the studio's words. */
export const optimizationRequest = ({ objective, saveVehicles, constraints = {}, kpis = null, health = null }) => {
  const c = {};
  for (const k of ["max_vehicles", "max_cost_year", "min_headway", "max_headway"]) if (num(constraints[k]) != null) c[k] = num(constraints[k]);
  const fleet = kpis?.fleet_peak ?? health?.fleet?.vehicles_line_by_line ?? health?.fleet?.vehicles ?? null;
  if (objective === "ridership") {
    if (kpis?.cost_year != null && c.max_cost_year == null) c.max_cost_year = kpis.cost_year;
    return { objective: "ridership", constraints: c };
  }
  if (objective === "vehicles") {
    const n = Math.max(1, Math.round(num(saveVehicles) || 1));
    if (fleet != null) c.max_vehicles = Math.min(c.max_vehicles ?? Infinity, Math.max(1, fleet - n));
    return { objective: "cost", constraints: c, save_vehicles: n };
  }
  return { objective: "balanced", constraints: c };
};

function DemandCard({ health, feedKey, busy, onOptimized, onDataChange = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  const [datasets, setDatasets] = useState([]); // [{ id, name, kind, rows, warnings }]
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [place, setPlace] = useState("");
  const [optOpen, setOptOpen] = useState(false);
  const [objective, setObjective] = useState("ridership");
  const [saveVehicles, setSaveVehicles] = useState("1");
  const [constraints, setConstraints] = useState({ max_vehicles: "", max_cost_year: "", min_headway: "", max_headway: "" });
  const [optimizing, setOptimizing] = useState(false);
  const [optError, setOptError] = useState(null);
  const fileRef = useRef(null);
  const dataIds = datasets.map((d) => d.id);
  // The planner calibrates its estimates on the same data (ChangeStudio passes them as dataIds).
  const idsKey = dataIds.join(",");
  useEffect(() => {
    onDataChange?.(idsKey ? idsKey.split(",") : []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const estimate = useCallback(
    async (ids, where) => {
      setState((s) => ({ ...s, status: s.data ? "refreshing" : "loading", error: null }));
      try {
        const data = await fetchDemand({ place: where || null, dataIds: ids });
        setState({ status: "ready", data, error: null });
      } catch (err) {
        setState((s) => (isUnavailable(err) ? { status: "hidden", data: null, error: null } : { status: s.data ? "ready" : "error", data: s.data, error: err.message }));
      }
    },
    [],
  );
  // Once the feed is known (and again when it changes): not before, not twice.
  useEffect(() => {
    if (!feedKey) return;
    setDatasets([]);
    estimate([], null);
  }, [feedKey, estimate]);

  if (state.status === "hidden") return null;
  const est = state.data?.estimate || null;
  const kpis = state.data?.kpis || null;
  // An estimate of no trip at all is none (utils/ridership): said unavailable, its lines (every one at 0) not drawn,
  // never « environ 0 voyages par jour » nor a trust label on a figure that is not there.
  const total = estimatedTrips(est, kpis);
  const perLine = total == null ? [] : [...(est?.per_line || [])].filter((l) => Number.isFinite(l.boardings_day)).sort((a, b) => b.boardings_day - a.boardings_day);
  const max = perLine[0]?.boardings_day || 1;
  const calibrated = Boolean(est?.calibrated ?? kpis?.calibrated);
  const uncertainty = est?.uncertainty || kpis?.uncertainty || "±50 %";

  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const d = await uploadDemandData(file);
      const next = [...datasets, { id: d.id, name: file.name, kind: d.kind, rows: d.rows, warnings: d.warnings || [] }];
      setDatasets(next);
      await estimate(next.map((x) => x.id), place.trim());
    } catch (err) {
      setUploadError(isUnavailable(err) && err.status !== 503 ? t("transform.demand.uploadUnavailable") : err.status === 413 || err.code === "FILE_TOO_LARGE" ? t("transform.demand.uploadTooLarge") : err.status === 415 ? t("transform.demand.uploadFormat") : t("transform.demand.uploadFailed", { message: err.message }));
    } finally {
      setUploading(false);
    }
  };
  const removeDataset = async (d) => {
    deleteDemandData(d.id);
    const next = datasets.filter((x) => x.id !== d.id);
    setDatasets(next);
    await estimate(next.map((x) => x.id), place.trim());
  };
  const optimize = async () => {
    setOptimizing(true);
    setOptError(null);
    const req = optimizationRequest({ objective, saveVehicles, constraints, kpis, health });
    try {
      const result = await optimizeChangePlan({ objective: req.objective, constraints: req.constraints, place: place.trim() || null, dataIds });
      if (!result?.plan || !Array.isArray(result.plan.operations) || !result.plan.operations.length) {
        setOptError(t("transform.optimize.nothing"));
        return;
      }
      const label = objective === "vehicles" ? t("transform.optimize.objective.vehicles", { count: req.save_vehicles }) : t(`transform.optimize.objective.${objective}`);
      onOptimized?.(result, t("transform.optimize.scenarioName", { objective: label }), { objective: req.objective, label });
      setOptOpen(false);
    } catch (err) {
      setOptError(isUnavailable(err) ? t("transform.optimize.unavailable") : t("transform.optimize.failed", { message: err.message }));
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <Box data-testid="change-demand" sx={{ p: 1.5, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}`, display: "flex", flexDirection: "column", gap: 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Typography sx={{ fontSize: "0.86rem", fontWeight: 800, flex: 1 }}>{t("transform.demand.title")}</Typography>
        {state.data && total != null && (
          <Box data-testid="change-demand-calibration">
            <Tag color={calibrated ? theme.palette.success.main : theme.palette.warning.main}>{calibrated ? t("transform.demand.calibrated") : t("transform.demand.uncalibrated", { uncertainty })}</Tag>
          </Box>
        )}
        {(state.status === "loading" || state.status === "refreshing") && <CircularProgress size={14} />}
      </Box>
      {state.status === "loading" && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("transform.demand.loading")}</Typography>}
      {state.error && <Alert severity="warning" sx={{ py: 0, fontSize: "0.74rem" }}>{t("transform.demand.failed", { message: state.error })}</Alert>}
      {state.data && (
        <>
          {total != null ? (
            <Typography sx={{ fontSize: "0.8rem" }} data-testid="change-demand-total">
              {t("transform.demand.total", { trips: compactNumber(Math.round(total), language) })}
            </Typography>
          ) : (
            <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", lineHeight: 1.5 }} data-testid="change-demand-unavailable">
              {t("transform.demand.unavailable")}
            </Typography>
          )}
          {perLine.length > 0 && (
            <Box data-testid="change-demand-lines" sx={{ display: "flex", flexDirection: "column", gap: 0.4 }}>
              {perLine.slice(0, 12).map((l) => (
                <Box key={l.line_id || l.short_name} data-testid="change-demand-line" sx={{ display: "grid", gridTemplateColumns: "64px 1fr 72px", alignItems: "center", gap: 1 }}>
                  <Typography sx={{ fontSize: "0.74rem", fontWeight: 700 }} noWrap title={l.short_name || l.line_id}>
                    {l.short_name || l.line_id}
                  </Typography>
                  <Box sx={{ height: 6, borderRadius: 99, background: soft(theme, 1.6), overflow: "hidden" }}>
                    <Box sx={{ width: `${Math.max(2, (100 * l.boardings_day) / max)}%`, height: "100%", borderRadius: 99, background: theme.palette.primary.main, opacity: 0.8 }} />
                  </Box>
                  <Typography sx={{ fontSize: "0.72rem", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{compactNumber(Math.round(l.boardings_day), language)}</Typography>
                </Box>
              ))}
              {perLine.length > 12 && <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{t("transform.demand.moreLines", { count: perLine.length - 12 })}</Typography>}
            </Box>
          )}
          <Typography sx={{ fontSize: "0.68rem", color: "text.secondary", lineHeight: 1.5 }}>{t("transform.demand.note")}</Typography>
          {/* The model's own remarks (in English, the engine's words): folded, for whoever wants to know what the estimate rests on. */}
          {(() => {
            const remarks = [...(est?.warnings || []), ...(state.data?.inputs?.warnings || [])].map((w) => (typeof w === "string" ? w : w?.message || JSON.stringify(w)));
            if (!remarks.length) return null;
            return (
              <Box component="details" data-testid="change-demand-remarks" sx={{ fontSize: "0.68rem", color: "text.secondary", "& summary": { cursor: "pointer", fontWeight: 700 } }}>
                <Box component="summary">{t("transform.demand.remarks", { count: remarks.length })}</Box>
                {remarks.slice(0, 8).map((w, i) => (
                  <Typography key={i} lang="en" sx={{ fontSize: "0.68rem", color: "text.secondary", lineHeight: 1.45, mt: 0.25 }}>
                    • {w}
                  </Typography>
                ))}
              </Box>
            );
          })()}
        </>
      )}
      {datasets.length > 0 && (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
          {datasets.map((d) => (
            <Chip key={d.id} size="small" label={t("transform.demand.dataset", { name: d.name, rows: d.rows ?? "?", kind: tf(t, `transform.demand.kind.${d.kind}`, null, d.kind || "") })} onDelete={() => removeDataset(d)} data-testid="change-demand-dataset" sx={{ maxWidth: 320, fontSize: "0.7rem" }} />
          ))}
        </Box>
      )}
      {uploadError && <Alert severity="warning" sx={{ py: 0, fontSize: "0.74rem" }} onClose={() => setUploadError(null)} data-testid="change-demand-upload-error">{uploadError}</Alert>}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, alignItems: "center" }}>
        <input ref={fileRef} type="file" hidden accept={DEMAND_DATA_ACCEPT} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ""; }} data-testid="change-demand-file" />
        <QuietButton startIcon={uploading ? <CircularProgress size={12} /> : <UploadFileOutlinedIcon sx={{ fontSize: 16 }} />} disabled={uploading} onClick={() => fileRef.current?.click()} data-testid="change-demand-import">
          {t("transform.demand.import")}
        </QuietButton>
        <QuietButton startIcon={<AutoAwesomeOutlinedIcon sx={{ fontSize: 16 }} />} disabled={busy || optimizing} onClick={() => setOptOpen((o) => !o)} data-testid="change-optimize-open">
          {t("transform.optimize.open")}
        </QuietButton>
        <Box sx={{ flex: 1 }} />
        <TextField size="small" value={place} onChange={(e) => setPlace(e.target.value)} onKeyDown={(e) => e.key === "Enter" && estimate(dataIds, place.trim())} placeholder={t("transform.demand.place")} inputProps={{ "data-testid": "change-demand-place", "aria-label": t("transform.demand.place") }} sx={{ width: 190, "& input": { fontSize: "0.74rem", py: 0.6 } }} />
        <QuietButton onClick={() => estimate(dataIds, place.trim())} disabled={state.status === "loading" || state.status === "refreshing"}>
          {t("transform.demand.refresh")}
        </QuietButton>
      </Box>
      <Typography sx={{ fontSize: "0.66rem", color: "text.disabled", lineHeight: 1.45 }}>{t("transform.demand.importHint")}</Typography>
      <Collapse in={optOpen} unmountOnExit>
        <Box data-testid="change-optimize-form" sx={{ p: 1.25, borderRadius: "12px", background: soft(theme), display: "flex", flexDirection: "column", gap: 1 }}>
          <Typography sx={{ fontSize: "0.8rem", fontWeight: 800 }}>{t("transform.optimize.title")}</Typography>
          <RadioGroup value={objective} onChange={(e) => setObjective(e.target.value)}>
            {OBJECTIVES.map((o) => (
              <Box key={o} sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
                <FormControlLabel value={o} control={<Radio size="small" inputProps={{ "data-testid": `change-optimize-objective-${o}` }} />} label={<Typography sx={{ fontSize: "0.78rem" }}>{o === "vehicles" ? t("transform.optimize.objective.vehiclesChoice") : t(`transform.optimize.objective.${o}`)}</Typography>} />
                {o === "vehicles" && objective === "vehicles" && (
                  <TextField size="small" type="number" value={saveVehicles} onChange={(e) => setSaveVehicles(e.target.value)} inputProps={{ min: 1, "data-testid": "change-optimize-save-vehicles", "aria-label": t("transform.optimize.saveVehicles") }} sx={{ width: 90, "& input": { fontSize: "0.76rem", py: 0.5 } }} />
                )}
              </Box>
            ))}
          </RadioGroup>
          <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t(`transform.optimize.hint.${objective}`)}</Typography>
          <SectionHeader label={t("transform.optimize.constraints")} />
          <Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 1 }}>
            {Object.keys(constraints).map((k) => (
              <TextField key={k} size="small" type="number" label={t(`transform.optimize.constraint.${k}`)} value={constraints[k]} onChange={(e) => setConstraints((c) => ({ ...c, [k]: e.target.value }))} inputProps={{ "data-testid": `change-optimize-${k}` }} InputLabelProps={{ sx: { fontSize: "0.76rem" } }} />
            ))}
          </Box>
          {optError && <Alert severity="warning" sx={{ py: 0, fontSize: "0.74rem" }} data-testid="change-optimize-error">{optError}</Alert>}
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Button variant="contained" disableElevation size="small" disabled={optimizing || busy} onClick={optimize} startIcon={optimizing ? <CircularProgress size={12} color="inherit" /> : null} data-testid="change-optimize-run" sx={{ textTransform: "none", fontWeight: 700, borderRadius: 99 }}>
              {t("transform.optimize.run")}
            </Button>
            {optimizing && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("transform.optimize.running")}</Typography>}
          </Box>
          <Typography sx={{ fontSize: "0.68rem", color: "text.secondary", lineHeight: 1.45 }}>{t("transform.optimize.note")}</Typography>
        </Box>
      </Collapse>
    </Box>
  );
}

export default function DiagnosticPanel({ health, feedKey = null, busy = false, onOptimized = null, onDataChange = null }) {
  const { t } = useLanguage();
  const [details, setDetails] = useState(false);
  return (
    <Box data-testid="change-diagnostic" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", lineHeight: 1.5 }}>{t("transform.diag.intro")}</Typography>
      {!health && <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{t("transform.diag.loading")}</Typography>}
      <HealthReading health={health} />
      <DemandCard health={health} feedKey={feedKey} busy={busy} onOptimized={onOptimized} onDataChange={onDataChange} />
      {health && !health.error && health.score != null && (
        <Box>
          <SectionHeader label={t("transform.diag.details")} open={details} onToggle={() => setDetails((d) => !d)} testid="change-diagnostic-details" />
          <Collapse in={details}>
            <Box sx={{ pt: 0.75 }}>
              <NetworkHealthCard health={health} />
            </Box>
          </Collapse>
        </Box>
      )}
    </Box>
  );
}
