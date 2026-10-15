/**
 * StepChecks — ④ Contrôles: the engine judges, the person reads (G3).
 *
 * Nothing is decided here. The engine's verdict is pinned first
 * (VerdictCard, from the server's verdict — never computed in the browser;
 * `verdict = { payload, measured, design }`, or null when the panel below
 * pins it itself, as the Change Studio's ChecksPanel does),
 * then what the job has to read: the design's quality (QualityCard) when
 * creating; the checks of the simulation (ChecksPanel: the clauses before →
 * after, the integrity, the canonical validator) and the changes
 * (ChangesPanel) when modifying — and the coherence report (`coherence`, a
 * CoherenceReport: by line, direction and day type, before → after for a
 * change, its anomalies first), right after the verdict. The
 * canonical validator's own section (`validation-panel`) says where it
 * stands, in words: running (`validation-running`, with the time elapsed),
 * passed with its counts, errors by rule, or unavailable on this server
 * (then ⑤ is locked, with that reason). The checks run by themselves on
 * arrival — ④ is a state, never a gate to click through.
 *
 * In the Network Studio the page is a dashboard (StudioSheet): the
 * indicators first (`checks-summary`: the verdict, the canonical validator,
 * what the job adds — the design's quality, the changes — as the host
 * measured them, `tiles`), then the coherence report as the main reading
 * and, beside it, the verdict, the validator and the job's panels.
 *
 * The primary action is "Passer à la livraison" (→ ⑤).
 */

import React from "react";
import { Box, Typography, alpha, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import VerdictCard, { countsLine, verdictSummary } from "../common/VerdictCard";
import StudioSheet, { KpiTiles } from "../studio/StudioSheet";
import { useStepActionsSlot } from "../AppShell";
import StepFrame, { useFillLayout } from "./StepFrame";

/** The canonical validator's section of the checks: { state: running|ok|errors|unavailable|atBuild|none, text }; running, the text is the `validation-running` banner. */
export function ValidatorSection({ state = "none", text = null, children = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const color = state === "ok" ? theme.palette.success.main : state === "errors" || state === "unavailable" ? theme.palette.error.main : theme.palette.text.secondary;
  return (
    <Box component="section" aria-label={t("gtfsCheck.title")} data-testid="checks-validator" data-state={state} sx={{ p: 1.5, borderRadius: "12px", background: alpha(color, theme.palette.mode === "dark" ? 0.12 : 0.06), display: "flex", flexDirection: "column", gap: 0.5 }}>
      <Typography component="h2" sx={{ fontSize: "0.86rem", fontWeight: 800 }}>
        {t("gtfsCheck.title")}
      </Typography>
      {text && (
        <Typography data-testid={state === "running" ? "validation-running" : undefined} sx={{ fontSize: "0.8rem", color: state === "none" || state === "atBuild" || state === "running" ? "text.secondary" : color, lineHeight: 1.5 }}>
          {text}
        </Typography>
      )}
      {children}
    </Box>
  );
}

/** The canonical validator's state as an indicator (its section's own `state`). */
export const validatorTile = (state, t, hint = null) => ({
  id: "validator",
  label: t("checks.kpi.validator"),
  value: t(`checks.kpi.validator.${["ok", "errors", "running", "unavailable", "atBuild"].includes(state) ? state : "none"}`),
  tone: state === "ok" ? "ok" : state === "errors" || state === "unavailable" ? "error" : state === "running" ? "accent" : "neutral",
  hint,
});

/**
 * The engine's verdict as an indicator (VerdictCard's own reading of the server's payload). `verdict.counts`: the
 * change flow's count (utils/objectiveCounts), said as its card and its recap say it (VerdictCard.countsLine).
 */
export const verdictTile = (verdict, t) => {
  if (!verdict) return null;
  const s = verdictSummary(verdict.payload, { measured: Boolean(verdict.measured) });
  const must = verdict.counts ? countsLine(t, verdict.counts) : s.must && s.status !== "noContract" ? t("status.verdict", { pass: s.must.pass, total: s.must.total, unknown: s.must.unknown }) : null;
  return { id: "verdict", label: t("checks.kpi.verdict"), value: t(s.key), tone: s.tone, hint: must };
};

export default function StepChecks({ job = "create", verdict = null, coherence = null, tabs = null, children, validator = null, tiles = null, primary, back, footer = null, notice = null }) {
  const { t } = useLanguage();
  const fill = useFillLayout();
  const inBar = Boolean(useStepActionsSlot()) && fill;
  const indicators = [verdictTile(verdict, t), ...(tiles || [])].filter(Boolean);
  const verdictNode = verdict ? (
    <Box data-testid="checks-verdict">
      <VerdictCard payload={verdict.payload} measured={Boolean(verdict.measured)} design={Boolean(verdict.design)} variant="pinned" />
    </Box>
  ) : null;
  const validatorNode = validator ? <Box data-testid="validation-panel">{validator}</Box> : null;
  // Creating: the report is the reading, the verdict, the validator and the quality beside it. Modifying: the
  // report, then the checks and the changes of the simulation in their tabs, the whole width.
  const besideReport = job === "create";
  return (
    <StepFrame step={4} job={job} intro={t("step.4.intro")} notice={notice} primary={primary} back={back} footer={footer} testid="step-checks" headless>
      <StudioSheet
        testid="checks-sheet"
        lead={inBar ? t("step.4.intro") : null}
        tiles={<KpiTiles tiles={indicators} testid="checks-summary" />}
        aside={
          besideReport ? (
            <>
              {verdictNode}
              {validatorNode}
              {children}
            </>
          ) : null
        }
      >
        {!besideReport && verdictNode}
        {coherence}
        {!besideReport && validatorNode}
        {!besideReport && tabs}
        {!besideReport && children}
        {besideReport && tabs}
      </StudioSheet>
    </StepFrame>
  );
}
