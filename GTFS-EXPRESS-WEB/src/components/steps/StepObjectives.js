/**
 * StepObjectives — ② Objectifs of a project that modifies a network (Lot H,
 * 2026-10-05): one page whatever the person came with. Nothing is asked
 * before it: what they dropped at ① says what ② holds first.
 *
 *   objectives-summary      the network as it is, measured (residents within
 *                           400 m of a stop, of a frequent stop, the
 *                           estimated trips a day, the offer's quality)
 *   objectives-contract     « Vos objectifs »: the contract said simply
 *                           (ObjectivesList — one sentence per objective, its
 *                           source, « Retenir » / « Écarter » / « Modifier »,
 *                           « Lire le cahier des charges »); « Vue détaillée »
 *                           (`objectives-detailed`) opens the whole contract
 *                           (ContractPanel, with « … avec le contrat supposé »)
 *                           for what the list sends there
 *   objectives-recommendations  « Suggestions mesurées sur votre réseau »:
 *                           the server's recommendations (transform/
 *                           recommendations, no model), each with what it
 *                           asks, what is measured today, its measured impact
 *                           and whether it rests on an estimate; « Ajouter »
 *                           puts its clauses in the contract under the
 *                           person's name (recommendationsApi), « Ajouté »
 *                           takes them away. With a brief (a document at ①,
 *                           or clauses already in the contract) they come
 *                           second, folded to one line; without one, they are
 *                           the page's offer. A row says what the suggestion
 *                           asks, today's figure, and its gain beside its cost
 *                           (the rest of its measures in its tooltip)
 *   objectives-decision     « Votre décision »: who decides (the name every
 *                           objective is kept under — never asked before the
 *                           first act that needs it: then once, in a small
 *                           dialog, `objectives-name-dialog`, and remembered;
 *                           no act waits greyed out for it) and
 *   objectives-dates        « Mise en service »: from when the change runs
 *                           (until when, optional), kept with the project
 *                           (`context.from_date`, `to_date`) and proposed to
 *                           every operation of ③ (framingDefaults); a date
 *                           the contract's clauses state is offered — and,
 *                           none typed, said kept by the step's act (the
 *                           objectives a sheet gave without a date take it)
 * The network's map is not repeated here (① and ③ hold it): a suggestion
 * names its line by its colour and its words.
 *
 * The figures are the server's, never computed here. The primary action
 * (`contract-proceed`) is the step's one act (2026-10-05): under the person's
 * name it keeps every objective proposed and not decided, records « à
 * vérifier à la main » what the brief states and no objective answers,
 * decides the contract — or records it empty, nothing asked of the change —
 * and opens ③, where the change is built by itself. With a brief, the
 * network's own measures (objectives-summary) leave the page: it is about
 * what the brief asks.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, TextField, Tooltip, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import SpeedOutlinedIcon from "@mui/icons-material/SpeedOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import EventAvailableOutlinedIcon from "@mui/icons-material/EventAvailableOutlined";
import PlaceOutlinedIcon from "@mui/icons-material/PlaceOutlined";
import SwapVertOutlinedIcon from "@mui/icons-material/SwapVertOutlined";
import TrainOutlinedIcon from "@mui/icons-material/TrainOutlined";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import AddRoundedIcon from "@mui/icons-material/AddRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatDate, formatNumber } from "../../utils/formatDate";
import { nameOk } from "../../utils/contract";
import { fetchRecommendations, isRetained, withRecommendation, withoutRecommendation } from "../../utils/recommendationsApi";
import ContractPanel from "../common/ContractPanel";
import ObjectivesList from "./ObjectivesList";
import RefusalNotice from "../common/RefusalNotice";
import StudioSheet, { KpiTiles, SheetCard, toneOf } from "../studio/StudioSheet";
import { tokensOf } from "../studio/studioTheme";
import { DateField } from "../transform/DateField";
import { toIso } from "../transform/localDates";
import { useStepActionsSlot } from "../AppShell";
import StepFrame, { useFillLayout } from "./StepFrame";

const KIND_ICON = { frequency: SpeedOutlinedIcon, span: ScheduleOutlinedIcon, weekend: EventAvailableOutlinedIcon, coverage: PlaceOutlinedIcon, reallocation: SwapVertOutlinedIcon, connection: TrainOutlinedIcon };
// The impacts a suggestion measures, in this order (the server's deltas; an absent one is not measured, never zero).
const IMPACTS = ["residents_frequent", "jobs_frequent", "residents_served", "riders_day", "veh_km_year", "fleet_peak", "cost_year"];
// Its row says one gain — the first of these it measures — beside what it costs; the rest is in its tooltip.
const GAINS = ["riders_day", "residents_frequent", "residents_served", "jobs_frequent"];
// The measure of a network is kept for this tab's life: coming back to ② shows it at once (« Mesurer à nouveau » asks again).
const CACHE = new Map();

// The cost is said in the network's currency (kpis.currency), its sign where it has a common one.
const currencySign = (c) => ({ EUR: "€", USD: "$", GBP: "£", CHF: "CHF", CAD: "$" })[String(c || "EUR").toUpperCase()] || String(c || "");
const signed = (n, language) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatNumber(Math.abs(Math.round(n)), language)}`;

/** The figures of a recommendation's sentences, formatted (numbers in the reader's language, times as given). */
const paramsOf = (r, language, t) => {
  // A coverage zone names no line of its own: the line its detour would leave.
  const out = { line: r.line?.label || r.facts?.nearest_line_label || "", ...(r.facts || {}) };
  for (const [key, v] of Object.entries(out)) {
    if (typeof v === "number") out[key] = formatNumber(Math.round(v * 10) / 10, language);
    // A day is a word of the reader's language; a list (the lines up, the lines down) their names.
    else if (key === "day" && typeof v === "string") out[key] = t(`reco.day.${v}`);
    else if (key === "window" && typeof v === "string") out[key] = v.replace("-", "–");
    else if (Array.isArray(v)) out[key] = v.length ? v.join(", ") : "—";
  }
  return out;
};

/**
 * The variant of a kind's sentences the facts call for: a span asks for the first departure, the last, or both;
 * a frequency says the residents near its stops only where they are counted (never a « {residents_400m} » left).
 */
const variantOf = (r, part) => {
  const f = r.facts || {};
  if (r.kind === "span") return f.first_target && f.last_target ? ".both" : f.first_target ? ".first" : "";
  if (r.kind === "frequency" && part === "facts" && f.residents_400m == null) return ".plain";
  return "";
};

/** A recommendation's title, in the reader's words: what it asks. */
export const recommendationTitle = (r, t, language) => t(`reco.${r.kind}.title${variantOf(r, "title")}`, paramsOf(r, language, t));

// The warnings the server sends with a code (transform/recommendations) that the person can act on or must know;
// the others (a recommendation dropped for an incomplete clause) are the engine's own bookkeeping.
const WARNINGS = ["population_proxy", "population_coarse", "population_default_density", "estimate_partial", "references_unreadable", "reallocation_failed", "reallocation_skipped", "no_weekday", "few_recommendations"];
const warningText = (w, t) => {
  if (typeof w === "string") return null;
  if (!w || !WARNINGS.includes(w.code)) return null;
  return t(`reco.warning.${w.code}${w.code === "few_recommendations" ? `.${w.params?.reason === "proxy" ? "proxy" : "good"}` : ""}`);
};

function ImpactChip({ id, value, pct = null, currency = "EUR", k, t, language }) {
  // Residents, jobs and riders gained read as good news; vehicle-km, vehicles and cost as what it costs.
  const cost = id === "veh_km_year" || id === "fleet_peak" || id === "cost_year";
  const tone = toneOf(k, cost ? (value > 0 ? "warn" : "ok") : value > 0 ? "ok" : "neutral");
  return (
    <Box component="span" data-testid={`reco-impact-${id}`} sx={{ display: "inline-flex", alignItems: "center", height: 22, px: 0.9, borderRadius: 999, fontSize: "0.72rem", fontWeight: 500, color: tone.ink, backgroundColor: tone.ground, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
      {t(id === "veh_km_year" && pct == null ? "reco.impact.veh_km_year_plain" : `reco.impact.${id}`, { n: signed(value, language), pct: pct != null ? signed(pct, language) : "", currency: currencySign(currency) })}
    </Box>
  );
}

function RecommendationCard({ r, retained, disabled, onToggle, currency, k, t, language }) {
  const Icon = KIND_ICON[r.kind] || SpeedOutlinedIcon;
  const measured = IMPACTS.filter((id) => Number.isFinite(r.impact?.[id]) && r.impact[id] !== 0);
  const gain = GAINS.find((id) => measured.includes(id) && r.impact[id] > 0) || null;
  const cost = measured.includes("cost_year") ? "cost_year" : measured.includes("veh_km_year") ? "veh_km_year" : null;
  const shown = [gain, cost].filter(Boolean);
  const chip = (id) => <ImpactChip key={id} id={id} value={r.impact[id]} pct={id === "veh_km_year" ? r.impact.veh_km_pct : null} currency={currency} k={k} t={t} language={language} />;
  // Every measure in words, for the tooltip: what the row leaves out is one hover away, never lost.
  const all = measured.map((id) => t(id === "veh_km_year" && r.impact.veh_km_pct == null ? "reco.impact.veh_km_year_plain" : `reco.impact.${id}`, { n: signed(r.impact[id], language), pct: r.impact.veh_km_pct != null ? signed(r.impact.veh_km_pct, language) : "", currency: currencySign(currency) })).join(" · ");
  return (
    <Box
      component="li"
      data-testid="recommendation-card"
      data-kind={r.kind}
      data-id={r.id}
      data-retained={retained ? "true" : "false"}
      sx={{ listStyle: "none", display: "flex", alignItems: "center", gap: 1.25, px: 1.5, py: 1.25, borderTop: `1px solid ${k.lineSoft}`, "&:first-of-type": { borderTop: "none" }, backgroundColor: retained ? k.accentSoft : "transparent", borderRadius: retained ? "10px" : 0, transition: "background-color .15s" }}
    >
      <Box aria-hidden sx={{ width: 30, height: 30, flexShrink: 0, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", backgroundColor: retained ? k.accent : k.subtle, color: retained ? k.onAccent : k.ink2 }}>
        <Icon sx={{ fontSize: 17 }} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 0.35 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0 }}>
          {r.line?.color && <Box component="span" aria-hidden sx={{ width: 9, height: 9, borderRadius: "3px", backgroundColor: `#${String(r.line.color).replace(/^#/, "")}`, flexShrink: 0 }} />}
          <Typography component="h3" sx={{ fontSize: "0.86rem", fontWeight: 600, color: k.ink, lineHeight: 1.35 }}>
            {recommendationTitle(r, t, language)}
          </Typography>
        </Box>
        <Typography sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.45 }}>{t(`reco.${r.kind}.facts${variantOf(r, "facts")}`, paramsOf(r, language, t))}</Typography>
        <Tooltip title={all || ""} placement="bottom-start">
          <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 0.5, mt: 0.25 }}>
            {shown.map(chip)}
            <Box component="span" data-testid="reco-confidence" data-confidence={r.confidence || "measured"} sx={{ fontSize: "0.7rem", color: k.ink3, ml: 0.25 }}>
              {r.confidence === "estimated" ? t("reco.confidence.estimated", { uncertainty: r.uncertainty || "" }) : t("reco.confidence.measured")}
            </Box>
          </Box>
        </Tooltip>
      </Box>
      <Button
        size="small"
        variant={retained ? "contained" : "outlined"}
        disableElevation
        disabled={disabled}
        onClick={() => onToggle(r)}
        aria-pressed={retained}
        startIcon={retained ? <CheckRoundedIcon sx={{ fontSize: "16px !important" }} /> : <AddRoundedIcon sx={{ fontSize: "16px !important" }} />}
        data-testid="recommendation-toggle"
        sx={{ flexShrink: 0, minWidth: 104, whiteSpace: "nowrap" }}
      >
        {retained ? t("reco.retained") : t("reco.retain")}
      </Button>
    </Box>
  );
}

/**
 * The date the contract's clauses state the change from, when they all state the same one (a brief « à partir du
 * 2 novembre 2026 »): offered at « Mise en service », never written behind the person.
 */
export const statedFromDate = (contract) => {
  const dates = new Set();
  for (const c of contract?.clauses || []) {
    const d = toIso(String(c?.params?.from_date || ""));
    if (d) dates.add(d);
  }
  return dates.size === 1 ? [...dates][0] : null;
};

/** « Votre décision »: who decides (every objective is kept under that name) and from when the change runs. */
function DecisionCard({ name = "", onName = null, context = {}, onContext = null, stated = null, k, t, language }) {
  const from = toIso(context.from_date || "");
  const to = toIso(context.to_date || "");
  const inverted = Boolean(from && to && to < from);
  const named = nameOk(name);
  const set = (change) => onContext?.({ ...context, ...change });
  return (
    <SheetCard title={t("objectives.decision.title")} testid="objectives-decision">
      <TextField size="small" fullWidth label={t("contract.decider")} value={name} onChange={(e) => onName?.(e.target.value)} disabled={!onName} helperText={named ? t("objectives.decision.nameHint") : t("objectives.decision.nameLater")} inputProps={{ "data-testid": "objectives-name", maxLength: 120, autoComplete: "name" }} />
      <Box data-testid="objectives-dates" sx={{ display: "flex", flexDirection: "column", gap: 0.75, pt: 0.5 }}>
        <Typography component="h3" sx={{ fontSize: "0.8rem", fontWeight: 600, color: k.ink }}>{t("objectives.dates.title")}</Typography>
        <Box sx={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 1 }}>
          <DateField label={t("change.from")} value={context.from_date || ""} onChange={(v) => set({ from_date: v || undefined })} testid="framing-from" disabled={!onContext} />
          <DateField label={`${t("change.to")} (${t("change.optional")})`} value={context.to_date || ""} onChange={(v) => set({ to_date: v || undefined })} testid="framing-to" disabled={!onContext} />
        </Box>
        {inverted && (
          <Typography role="alert" data-testid="framing-inverted" sx={{ fontSize: "0.74rem", color: "error.main" }}>
            {t("change.datesInverted")}
          </Typography>
        )}
        {stated && stated !== from && onContext && (
          <Box data-testid="objectives-dates-stated" sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1, p: 1, borderRadius: "8px", backgroundColor: k.accentSoft }}>
            <Typography sx={{ flex: 1, minWidth: 160, fontSize: "0.76rem", color: k.ink }}>{t(from ? "objectives.dates.stated" : "objectives.dates.statedKept", { date: formatDate(stated, language) })}</Typography>
            <Button size="small" onClick={() => set({ from_date: stated })} data-testid="objectives-dates-use">
              {t("objectives.dates.use")}
            </Button>
          </Box>
        )}
        <Typography sx={{ fontSize: "0.72rem", color: k.ink2, lineHeight: 1.45 }}>{t("objectives.dates.hint")}</Typography>
      </Box>
    </SheetCard>
  );
}

/** « Qui décide ? »: the decider's name, asked once at the first act that needs it, then remembered. */
function NameDialog({ open, onCancel, onConfirm, t }) {
  const [value, setValue] = useState("");
  const ok = nameOk(value);
  return (
    <Dialog open={open} onClose={onCancel} maxWidth="xs" fullWidth data-testid="objectives-name-dialog">
      <Box component="form" onSubmit={(e) => { e.preventDefault(); if (ok) onConfirm(value.trim()); }}>
        <DialogTitle sx={{ fontSize: "1rem", fontWeight: 600 }}>{t("objectives.name.title")}</DialogTitle>
        <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
          <Typography sx={{ fontSize: "0.84rem", color: "text.secondary", lineHeight: 1.5 }}>{t("objectives.name.body")}</Typography>
          <TextField autoFocus size="small" fullWidth label={t("contract.decider")} value={value} onChange={(e) => setValue(e.target.value)} inputProps={{ "data-testid": "objectives-name-dialog-input", maxLength: 120, autoComplete: "name" }} />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onCancel}>{t("app.cancel")}</Button>
          <Button type="submit" variant="contained" disableElevation disabled={!ok} data-testid="objectives-name-dialog-confirm">
            {t("objectives.name.confirm")}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

export default function StepObjectives({
  projectId = null,
  cacheKey = null,
  contract,
  onChange = null,
  conformance = null,
  coverage = null,
  coverageState = null,
  extract = null,
  brief = "",
  onBrief = null,
  onOffer = null,
  name = "",
  onName = null,
  readOnly = false,
  dataIds = [],
  context = {},
  onContext = null,
  hasBrief = false,
  proseDocuments = false,
  assistantLock = null,
  onPropose = null,
  sheets = [],
  readingSheets = [],
  onReadSheet = null,
  primary,
  assumed = null,
  onProceed = null,
  back,
  notice = null,
  // Inside ① (the owner's UX lot 2, 2026-10-11: « ① et ② fusionnés en un écran Cahier des charges »): the body alone,
  // stacked in ①'s brief column — the objectives, the suggestions, the decision (the name, the dates) — without a
  // page frame of its own; ①'s one primary action drives this step's act through `embedded.controlRef.current.proceed()`.
  embedded = null,
}) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const k = tokensOf(theme);
  const fill = useFillLayout();
  const inBar = Boolean(useStepActionsSlot()) && fill;
  const key = cacheKey || projectId || "network";
  const [state, setState] = useState(() => (CACHE.has(key) ? { status: "done", data: CACHE.get(key) } : { status: "loading", data: null }));
  // The act waiting for the decider's name (NameDialog), run under it once given.
  const pendingAct = useRef(null);
  const [asking, setAsking] = useState(false);
  // With a brief, the suggestions come second, folded to one line; without one, they are the page's offer. Read on
  // arrival: a clause written meanwhile never reorders the page under the person.
  const [briefFirst] = useState(Boolean(hasBrief));
  const [unfolded, setUnfolded] = useState(!hasBrief);
  const [seconds, setSeconds] = useState(0);
  // « Vue détaillée »: the whole contract (ContractPanel), for what the simple list sends there.
  const [detailed, setDetailed] = useState(false);
  const abortRef = useRef(null);
  const dataKey = (dataIds || []).join(",");

  const measure = useCallback(async () => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setState((s) => ({ status: "loading", data: s.data }));
    setSeconds(0);
    try {
      const data = await fetchRecommendations({ dataIds: dataKey ? dataKey.split(",") : [], lang: language, signal: abort.signal });
      if (abort.signal.aborted) return;
      CACHE.set(key, data);
      setState({ status: "done", data });
    } catch (err) {
      if (abort.signal.aborted || err?.name === "AbortError") return;
      setState({ status: "error", data: null, error: err });
    }
  }, [key, dataKey, language]);

  useEffect(() => {
    if (!CACHE.has(key)) measure();
    return () => abortRef.current?.abort();
    // On arrival and when the network (its key) changes; « Mesurer à nouveau » asks again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    if (state.status !== "loading") return undefined;
    const timer = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [state.status]);

  const data = state.data;
  const recommendations = useMemo(() => (Array.isArray(data?.recommendations) ? [...data.recommendations].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)) : []), [data]);
  const kpis = data?.diagnostic?.kpis || null;
  const quality = data?.diagnostic?.quality || null;
  const named = nameOk(name);
  const retainedList = recommendations.filter((r) => isRetained(contract, r.id));
  // Whether the suggestions are known at all (still measuring, or the measure failed: the act says nothing of them).
  const measured = Boolean(data);
  const retainedCount = retainedList.length;
  // Added together, the reallocation (at today's vehicle-km) and a suggestion adding service cannot both hold.
  const budgetConflict = retainedList.some((r) => r.kind === "reallocation") && retainedList.some((r) => r.kind !== "reallocation" && Number(r.impact?.veh_km_year) > 0);
  const warnings = (data?.warnings || []).map((w) => warningText(w, t)).filter(Boolean);
  const codes = new Set((data?.warnings || []).map((w) => w?.code).filter(Boolean));
  // Every act under the decider's name: run at once when it is known, else after the name is given (NameDialog).
  const withName = (act) => {
    if (named) {
      act(name.trim());
      return;
    }
    pendingAct.current = act;
    setAsking(true);
  };
  const nameGiven = (value) => {
    onName?.(value);
    setAsking(false);
    const act = pendingAct.current;
    pendingAct.current = null;
    act?.(value);
  };
  const toggle = (r) => {
    if (!onChange || readOnly) return;
    // Applied to the contract as it is when the act lands (a reading may land while the name is asked).
    if (isRetained(contract, r.id)) onChange((c) => withoutRecommendation(c || contract, r.id));
    else withName((who) => onChange((c) => withRecommendation(c || contract, r, { name: who })));
  };

  // Residents known per commune only (spread evenly): their shares are an order of magnitude, said « ≈ ».
  const pct = (v) => (Number.isFinite(v) ? `${codes.has("population_coarse") ? "≈ " : ""}${formatNumber(Math.round(v * 10) / 10, language)} %` : "—");
  const tiles = kpis
    ? [
        { id: "served", label: t("objectives.kpi.served"), value: pct(kpis.pop_400m_pct), tone: "accent", hint: codes.has("population_coarse") ? t("objectives.kpi.coarseHint") : t("objectives.kpi.servedHint") },
        { id: "frequent", label: t("objectives.kpi.frequent"), value: pct(kpis.pop_400m_frequent_pct), tone: Number.isFinite(kpis.pop_400m_frequent_pct) && kpis.pop_400m_frequent_pct < 50 ? "warn" : "ok", hint: codes.has("population_coarse") ? t("objectives.kpi.coarseHint") : t("objectives.kpi.frequentHint") },
        // An estimate cut short (the server busy) measures no trip: said unknown, never « ≈ 0 ».
        { id: "trips", label: t("objectives.kpi.trips"), value: Number(kpis.trips_day) > 0 ? `≈ ${formatNumber(Math.round(kpis.trips_day / 100) * 100, language)}` : "—", tone: "neutral", hint: !(Number(kpis.trips_day) > 0) ? t("objectives.kpi.tripsUnknown") : kpis.calibrated ? t("objectives.kpi.tripsCalibrated") : t("objectives.kpi.tripsEstimated", { uncertainty: kpis.uncertainty || "±50 %" }) },
        quality ? { id: "quality", label: t("objectives.kpi.quality"), value: `${quality.score}/100`, tone: quality.score >= 80 ? "ok" : quality.score >= 60 ? "warn" : "error", hint: quality.grade ? t(`network.quality.grade.${quality.grade}`) : null } : null,
      ]
    : [];
  const assumedButton = assumed ? (
    <Tooltip title={t("contract.assumed.body")}>
      <span>
        <Button size="small" onClick={assumed.onClick} disabled={Boolean(assumed.disabled)} data-testid="contract-proceed-assumed" sx={{ textTransform: "none", fontWeight: 600 }}>
          {t("contract.assumed.modify")}
        </Button>
      </span>
    </Tooltip>
  ) : null;
  const count = (contract?.clauses || []).filter((c) => !(c.keep_by_default && !c.decision) && c.status !== "waived").length;
  const mine = (
    <SheetCard
      title={t("objectives.mine.title")}
      testid="objectives-contract"
      status={count ? String(count) : null}
      statusTone={count ? "accent" : null}
      actions={
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {detailed && assumedButton}
          <Button size="small" onClick={() => setDetailed((v) => !v)} aria-pressed={detailed} data-testid="objectives-detailed" sx={{ color: k.ink2 }}>
            {detailed ? t("objectives.simple") : t("objectives.detailed")}
          </Button>
        </Box>
      }
    >
      {detailed ? (
        <ContractPanel job="modify" contract={contract} onChange={onChange} conformance={conformance} coverage={coverage} coverageState={coverageState} extract={extract} brief={brief} onBrief={onBrief} name={name} onName={onName} readOnly={readOnly || !onChange} onOffer={onOffer} />
      ) : (
        <ObjectivesList contract={contract} onChange={onChange} withName={withName} readOnly={readOnly} conformance={conformance} coverage={coverage} extract={extract} assistantLock={assistantLock} onPropose={onPropose} brief={brief} hasDocuments={proseDocuments} sheets={sheets} readingSheets={readingSheets} onReadSheet={onReadSheet} onDetailed={() => setDetailed(true)} />
      )}
    </SheetCard>
  );

  const folded = !unfolded && state.status === "done" && recommendations.length > 0;
  const suggestions = (
    <SheetCard
      title={t("objectives.list.title")}
      testid="objectives-recommendations"
      status={retainedCount ? t("objectives.decision.count", { count: retainedCount }) : null}
      statusTone={retainedCount ? "accent" : null}
      actions={
        state.status !== "loading" ? (
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            {recommendations.length > 0 && (
              <Button size="small" onClick={() => setUnfolded((v) => !v)} aria-expanded={!folded} data-testid="objectives-recommendations-toggle" sx={{ color: k.ink2 }}>
                {folded ? t("objectives.suggestions.show") : t("objectives.suggestions.hide")}
              </Button>
            )}
            <Button size="small" startIcon={<RefreshRoundedIcon />} onClick={measure} data-testid="objectives-remeasure" sx={{ color: k.ink2 }}>
              {t("objectives.remeasure")}
            </Button>
          </Box>
        ) : null
      }
    >
      {folded ? (
        <Typography data-testid="objectives-recommendations-folded" sx={{ fontSize: "0.8rem", color: k.ink2, lineHeight: 1.5 }}>
          {t("objectives.suggestions.folded", { count: recommendations.length })}
        </Typography>
      ) : (
        <Typography sx={{ fontSize: "0.8rem", color: k.ink2, lineHeight: 1.5 }}>{t("objectives.list.lead")}</Typography>
      )}
      {state.status === "loading" && (
        <Box data-testid="objectives-loading" role="status" sx={{ display: "flex", alignItems: "center", gap: 1, py: 1 }}>
          <CircularProgress size={18} />
          <Typography sx={{ fontSize: "0.82rem", color: k.ink2 }}>{t("objectives.loading", { seconds })}</Typography>
        </Box>
      )}
      {state.status === "error" && <RefusalNotice refusal={state.error} testid="objectives-refusal" supported={["retry"]} onAction={(id) => (id === "retry" ? measure() : null)} />}
      {state.status === "done" && recommendations.length === 0 && (
        <Typography data-testid="objectives-none" sx={{ fontSize: "0.82rem", color: k.ink2, py: 0.5 }}>
          {t("objectives.none")}
        </Typography>
      )}
      {!folded && budgetConflict && (
        <Typography role="status" data-testid="objectives-conflict" sx={{ fontSize: "0.76rem", lineHeight: 1.5, p: 1, borderRadius: "8px", color: k.ink, backgroundColor: k.warningSoft }}>
          {t("objectives.conflict.budget")}
        </Typography>
      )}
      {!folded && recommendations.length > 0 && (
        <Box component="ol" sx={{ m: 0, p: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
          {recommendations.map((r) => (
            <RecommendationCard key={r.id} r={r} retained={isRetained(contract, r.id)} disabled={readOnly || !onChange} onToggle={toggle} currency={kpis?.currency} k={k} t={t} language={language} />
          ))}
        </Box>
      )}
      {!folded && warnings.length > 0 && (
        <Box component="ul" data-testid="objectives-warnings" sx={{ m: 0, pl: 2.25, color: k.ink3, fontSize: "0.72rem", lineHeight: 1.5 }}>
          {warnings.slice(0, 4).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </Box>
      )}
    </SheetCard>
  );

  const intro = t("objectives.intro");
  // The step's one act, as the page's primary runs it (and as ①'s does when the body is embedded there).
  const proceed = () => (readOnly ? onProceed?.(measured ? retainedList : null, name) : withName((who) => onProceed?.(measured ? retainedList : null, who)));
  if (embedded) {
    if (embedded.controlRef) embedded.controlRef.current = { proceed };
    return (
      <Box data-testid="step-objectives" data-embedded="true" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
        {tiles.length && !briefFirst ? <KpiTiles tiles={tiles} testid="objectives-summary" /> : null}
        {briefFirst ? mine : suggestions}
        {briefFirst ? suggestions : mine}
        <DecisionCard name={name} onName={readOnly ? null : onName} context={context || {}} onContext={readOnly ? null : onContext} stated={statedFromDate(contract)} k={k} t={t} language={language} />
        <NameDialog key={asking ? "asking" : "idle"} open={asking} onCancel={() => { pendingAct.current = null; setAsking(false); }} onConfirm={nameGiven} t={t} />
      </Box>
    );
  }
  return (
    <StepFrame step={2} job="modify" intro={intro} notice={notice} primary={primary ? { ...primary, alias: "contract-proceed", onClick: () => (readOnly ? onProceed?.(measured ? retainedList : null, name) : withName((who) => onProceed?.(measured ? retainedList : null, who))) } : null} back={back} testid="step-objectives" headless>
      <StudioSheet
        testid="objectives-sheet"
        lead={inBar ? intro : null}
        tiles={tiles.length && !briefFirst ? <KpiTiles tiles={tiles} testid="objectives-summary" /> : null}
        aside={
          <>
            <DecisionCard name={name} onName={readOnly ? null : onName} context={context || {}} onContext={readOnly ? null : onContext} stated={statedFromDate(contract)} k={k} t={t} language={language} />
          </>
        }
        asideWidth={360}
      >
        {/* With a brief, its requirements first; without one, the suggestions are the offer, the objectives below. */}
        {briefFirst ? mine : suggestions}
        {briefFirst ? suggestions : mine}
      </StudioSheet>
      <NameDialog key={asking ? "asking" : "idle"} open={asking} onCancel={() => { pendingAct.current = null; setAsking(false); }} onConfirm={nameGiven} t={t} />
    </StepFrame>
  );
}
