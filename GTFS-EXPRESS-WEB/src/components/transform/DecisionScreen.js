/**
 * DecisionScreen — the draft's decision, one short screen in two times (⑤ in the draft's dialog). Before: what the
 * change does (its lines, its impact), the checks the person reads at a glance (the validator, the data's integrity),
 * the act under their name (the studio's apply section: by hand, the name and « Appliquer » — the points the gate
 * still lists, the reference GTFS's own errors for one, accepted with it); the whole report one click away. After:
 * the version applied, the GTFS to download first, the other documents under it, the way back (one undo reverts the
 * whole change). Every value and handler is the studio's, given as props.
 */

import React, { useState } from "react";
import { Box, Button, ButtonBase, CircularProgress, Typography, alpha, useTheme } from "@mui/material";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import StraightenRoundedIcon from "@mui/icons-material/StraightenRounded";
import EuroRoundedIcon from "@mui/icons-material/EuroRounded";
import DirectionsBusFilledOutlinedIcon from "@mui/icons-material/DirectionsBusFilledOutlined";
import VerifiedRoundedIcon from "@mui/icons-material/VerifiedRounded";
import DrawOutlinedIcon from "@mui/icons-material/DrawOutlined";
import SwapHorizRoundedIcon from "@mui/icons-material/SwapHorizRounded";
import CancelRoundedIcon from "@mui/icons-material/CancelRounded";
import ErrorRoundedIcon from "@mui/icons-material/ErrorRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { formatDateTime, formatNumber } from "../../utils/formatDate";
import { gateIntegrity, gateNewErrors, gateOf } from "./gate";
import { describeItem } from "./ChangePlanParts";
import { lineColorsOf } from "./lineColors";

/** After the act: the version applied, its download, the other documents, the undo. */
function AppliedDecision({ frozen, undoing = false, onUndo, onDownload, deliverables = null }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const card = { p: 2, borderRadius: "14px", border: `1px solid ${theme.palette.divider}`, backgroundColor: theme.palette.background.paper };
  const by = frozen.by?.name || (typeof frozen.by === "string" ? frozen.by : "");
  return (
    <Box data-testid="decision-applied" sx={{ display: "flex", flexDirection: "column", gap: 2.5, py: 2.5 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.75, p: 2.25, borderRadius: "16px", backgroundColor: alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.16 : 0.08), border: `1px solid ${alpha(theme.palette.success.main, 0.3)}` }}>
        <CheckCircleRoundedIcon aria-hidden sx={{ fontSize: 36, color: "success.main" }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography component="h3" sx={{ fontSize: "1.1rem", fontWeight: 800, letterSpacing: "-0.01em" }}>
            {t("decision.applied.title", { n: frozen.n })}
          </Typography>
          <Typography sx={{ fontSize: "0.84rem", color: "text.secondary", lineHeight: 1.5 }}>
            {by && frozen.at ? t("decision.applied.by", { name: by, date: formatDateTime(frozen.at, language) }) : t("decision.applied.body")}
          </Typography>
        </Box>
        <Button onClick={onUndo} disabled={undoing} data-testid="decision-undo" sx={{ textTransform: "none", fontWeight: 650, color: "text.secondary", flexShrink: 0 }}>
          {undoing ? <CircularProgress size={16} /> : t("decision.applied.undo")}
        </Button>
      </Box>
      <Button variant="contained" disableElevation size="large" startIcon={<FileDownloadOutlinedIcon />} onClick={onDownload} data-testid="decision-download" sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 800, borderRadius: "12px", px: 3, py: 1.25, fontSize: "0.95rem" }}>
        {t("decision.applied.download", { n: frozen.n })}
      </Button>
      <Box component="section" aria-labelledby="decision-documents" sx={card}>
        <Typography id="decision-documents" component="h3" sx={{ fontSize: "0.92rem", fontWeight: 700, mb: 1.25 }}>
          {t("decision.applied.documents")}
        </Typography>
        {deliverables}
      </Box>
    </Box>
  );
}

/** One check of the decision: its state (ok | fail | busy | none) and its sentence. */
const checksOf = (t, { validating, previewing, validateSeconds, validation, newErrors, integrity, preview }) =>
  [
    validating || previewing
      ? { id: "validator", state: "busy", text: t("decision.check.validating", { seconds: validateSeconds }) }
      : validation === "passed"
        ? { id: "validator", state: "ok", text: t("decision.check.validator") }
        : newErrors.length
          ? { id: "validator", state: "fail", text: t("decision.check.validatorErrors", { count: newErrors.length }) }
          : { id: "validator", state: "none", text: t("decision.check.validatorNotRun") },
    preview ? { id: "integrity", state: integrity.length ? "fail" : "ok", text: t(integrity.length ? "decision.check.integrityBroken" : "decision.check.integrity") } : null,
  ].filter(Boolean);

/** Before the act: what the change does, the checks, what the person accepts and the act. */
// `error`: the simulation or the validator refused (humanError's answer), said above the act with the way to run it
// again (`onResimulate`), never inside the folded report. `hand`: a change made by hand, said as the person's own act.
function Decision({ preview = null, validating = false, previewing = false, validateSeconds = 0, reviewLines = [], plan, routes = [], hand = false, nextN = 1, checksNode = null, applySection = null, error = null, onResimulate = null }) {
  const theme = useTheme();
  const { t, language } = useLanguage();
  const [checksDetail, setChecksDetail] = useState(false);
  const gateNow = gateOf(preview);
  const checks = checksOf(t, { validating, previewing, validateSeconds, validation: gateNow?.validation || "not_run", newErrors: gateNewErrors(gateNow), integrity: gateIntegrity(gateNow, preview), preview });
  const tone = { ok: theme.palette.success.main, fail: theme.palette.error.main, none: theme.palette.text.disabled, busy: theme.palette.primary.main };
  const icon = (state) =>
    state === "busy" ? <CircularProgress size={18} /> : state === "ok" ? <CheckCircleRoundedIcon sx={{ fontSize: 20, color: tone.ok }} /> : state === "fail" ? <CancelRoundedIcon sx={{ fontSize: 20, color: tone.fail }} /> : <RadioButtonUncheckedRoundedIcon sx={{ fontSize: 20, color: tone.none }} />;
  const lines = reviewLines.slice(0, 4);
  // Times said as the reader says them (« 21:40 », never « 21:40:00 »).
  const said = (text) => String(text || "").replace(/\b(\d{1,2}:\d{2}):00\b/g, "$1");
  const allOk = checks.every((c) => c.state === "ok");
  const impact = preview?.impact && !preview.impact.error ? preview.impact : null;
  const signed = (n, opts = {}) => (Number(n) > 0 ? "+" : Number(n) < 0 ? "−" : "±") + formatNumber(Math.abs(Number(n) || 0), language, { maximumFractionDigits: 0, ...opts });
  const money = (n) => `${signed(n)} ${impact?.currency === "EUR" || !impact?.currency ? "€" : impact.currency}`;
  const figures = impact && ["km", "cost", "fleet"].some((key) => Number(impact.totals?.[key]?.delta))
    ? [
        impact.totals.km ? { id: "km", icon: <StraightenRoundedIcon sx={{ fontSize: 18 }} />, value: `${signed(impact.totals.km.delta)} km`, label: t("decision.impact.km"), of: impact.totals.km.before ? t("decision.impact.of", { pct: formatNumber(impact.totals.km.pct ?? (100 * impact.totals.km.delta) / impact.totals.km.before, language, { maximumFractionDigits: 1, signDisplay: "always" }) }) : null } : null,
        impact.totals.cost ? { id: "cost", icon: <EuroRoundedIcon sx={{ fontSize: 18 }} />, value: money(impact.totals.cost.delta), label: t("decision.impact.cost"), of: null } : null,
        impact.totals.fleet ? { id: "fleet", icon: <DirectionsBusFilledOutlinedIcon sx={{ fontSize: 18 }} />, value: signed(impact.totals.fleet.delta), label: t("decision.impact.fleet"), of: null } : null,
      ].filter(Boolean)
    : [];
  // A section: a quiet overline with its icon, then its content — no card around it.
  const sectionHead = (headIcon, text, extra = null) => (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.25 }}>
      <Box aria-hidden sx={{ display: "inline-flex", color: "text.secondary" }}>{headIcon}</Box>
      <Typography component="h3" sx={{ flex: 1, fontSize: "0.72rem", fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: "text.secondary" }}>
        {text}
      </Typography>
      {extra}
    </Box>
  );
  return (
    <Box data-testid="decision" sx={{ display: "flex", flexDirection: "column", gap: 3, py: 2.5 }}>
      <Box component="section" aria-label={t("decision.what")} data-testid="decision-what">
        {sectionHead(<SwapHorizRoundedIcon sx={{ fontSize: 18 }} />, t("decision.what"))}
        {plan.title && <Typography sx={{ fontSize: "1.15rem", fontWeight: 800, letterSpacing: "-0.015em", lineHeight: 1.3, mb: 1.25 }}>{plan.title}</Typography>}
        {lines.length > 0 ? (
          <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 1 }}>
            {lines.map((line) => {
              const colors = lineColorsOf(routes, line.route || line.label, theme);
              return (
                <Box component="li" key={line.route || line.label} sx={{ display: "flex", alignItems: "flex-start", gap: 1.25 }}>
                  <Box component="span" sx={{ flexShrink: 0, minWidth: 36, px: 0.75, py: "2px", mt: "1px", borderRadius: "7px", textAlign: "center", fontSize: "0.82rem", fontWeight: 800, ...(colors ? { color: colors.fg, backgroundColor: colors.bg } : { color: "text.primary", backgroundColor: alpha(theme.palette.text.primary, 0.08) }) }}>
                    {line.label}
                  </Box>
                  <Box component="ul" sx={{ m: 0, p: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 0.25 }}>
                    {line.items.map((it, i) => (
                      <Typography component="li" key={i} sx={{ fontSize: "0.88rem", lineHeight: 1.5 }}>
                        {said(describeItem(t, it, language))}
                      </Typography>
                    ))}
                  </Box>
                </Box>
              );
            })}
            {reviewLines.length > lines.length && <Typography sx={{ fontSize: "0.8rem", color: "text.secondary" }}>{t("decision.moreLines", { count: reviewLines.length - lines.length })}</Typography>}
          </Box>
        ) : (
          <Typography sx={{ fontSize: "0.88rem", color: "text.secondary" }}>{t("decision.noLine")}</Typography>
        )}
        {figures.length > 0 && (
          <Box data-testid="decision-impact" sx={{ mt: 2 }}>
            <Box sx={{ display: "grid", gridTemplateColumns: `repeat(${figures.length}, minmax(0, 1fr))`, gap: 1.25 }}>
              {figures.map((f) => (
                <Box key={f.id} data-impact={f.id} sx={{ p: 1.5, borderRadius: "12px", backgroundColor: alpha(theme.palette.primary.main, theme.palette.mode === "dark" ? 0.12 : 0.05), display: "flex", flexDirection: "column", gap: 0.25 }}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, color: "primary.main" }}>
                    {f.icon}
                    <Typography sx={{ fontSize: "1.15rem", fontWeight: 800, color: "text.primary", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.01em" }}>{f.value}</Typography>
                  </Box>
                  <Typography sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.35 }}>{f.label}</Typography>
                  {f.of && <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>{f.of}</Typography>}
                </Box>
              ))}
            </Box>
            <Typography sx={{ mt: 0.75, fontSize: "0.72rem", color: "text.secondary" }}>{t("decision.impact.note")}</Typography>
          </Box>
        )}
      </Box>
      <Box component="section" aria-label={t("decision.checks")}>
        {sectionHead(
          <VerifiedRoundedIcon sx={{ fontSize: 18 }} />,
          t("decision.checks"),
          allOk ? <Box component="span" data-testid="decision-checks-ok" sx={{ px: 1, py: 0.25, borderRadius: 99, fontSize: "0.72rem", fontWeight: 750, color: "success.dark", backgroundColor: alpha(theme.palette.success.main, 0.12) }}>{t("decision.checks.ok")}</Box> : null,
        )}
        <Box component="ul" data-testid="decision-checks" sx={{ m: 0, p: 0.5, listStyle: "none", borderRadius: "12px", backgroundColor: allOk ? alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.1 : 0.05) : alpha(theme.palette.text.primary, 0.03), display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
          {checks.map((c) => (
            <Box component="li" key={c.id} data-testid={`decision-check-${c.id}`} data-state={c.state} sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 1.25, py: 1 }}>
              <Box sx={{ width: 20, mt: "1px", display: "flex", justifyContent: "center", flexShrink: 0 }}>{icon(c.state)}</Box>
              <Typography sx={{ fontSize: "0.84rem", lineHeight: 1.45, fontWeight: c.state === "fail" ? 700 : 500, color: c.state === "fail" ? "error.main" : "text.primary" }}>{c.text}</Typography>
            </Box>
          ))}
        </Box>
        <ButtonBase onClick={() => setChecksDetail((v) => !v)} aria-expanded={checksDetail ? "true" : "false"} data-testid="decision-detail-toggle" sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, mt: 0.75, px: 0.75, py: 0.5, borderRadius: "8px", fontSize: "0.8rem", fontWeight: 650, color: "primary.main", "&:hover": { backgroundColor: alpha(theme.palette.primary.main, 0.06) } }}>
          {t(checksDetail ? "decision.detail.hide" : "decision.detail.show")}
          <ExpandMoreIcon sx={{ fontSize: 18, transform: checksDetail ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
        </ButtonBase>
        {checksDetail && (
          <Box data-testid="decision-detail" sx={{ mt: 1.25, p: 2, borderRadius: "12px", border: `1px solid ${theme.palette.divider}` }}>
            {checksNode}
          </Box>
        )}
      </Box>
      <Box component="section" aria-label={t("decision.act")}>
        {sectionHead(<DrawOutlinedIcon sx={{ fontSize: 18 }} />, t("decision.yours"))}
        {error && (
          <Box role="alert" data-testid="decision-error" data-code={error.code || undefined} sx={{ mb: 1.5, p: 1.5, borderRadius: "12px", border: `1px solid ${alpha(theme.palette.error.main, 0.4)}`, backgroundColor: alpha(theme.palette.error.main, theme.palette.mode === "dark" ? 0.14 : 0.06), display: "flex", alignItems: "center", gap: 1.25, flexWrap: "wrap" }}>
            <ErrorRoundedIcon aria-hidden sx={{ fontSize: 22, color: "error.main", flexShrink: 0 }} />
            <Box sx={{ flex: 1, minWidth: 220 }}>
              {error.title && <Typography sx={{ fontSize: "0.88rem", fontWeight: 700 }}>{error.title}</Typography>}
              <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.5 }}>{t("decision.error.lead", { message: error.message || "" })}</Typography>
            </Box>
            {onResimulate && (
              <Button variant="contained" disableElevation onClick={onResimulate} disabled={validating || previewing} data-testid="decision-error-retry" sx={{ textTransform: "none", fontWeight: 750, borderRadius: "10px", flexShrink: 0 }}>
                {t("transform.previewAgain")}
              </Button>
            )}
          </Box>
        )}
        {/* By hand: the change is the person's own act, applied under their name once the validator answered. */}
        {hand && (
          <Box data-testid="decision-hand-act" sx={{ mb: 1.25 }}>
            <Typography component="h3" sx={{ fontSize: "0.95rem", fontWeight: 750 }}>
              {t("decision.hand.title")}
            </Typography>
            <Typography sx={{ fontSize: "0.82rem", color: "text.secondary", lineHeight: 1.5, mt: 0.25 }}>{t("decision.hand.body", { n: nextN })}</Typography>
          </Box>
        )}
        <Box component="section" aria-label={t("decision.act")} data-testid="decision-act">
          {applySection}
        </Box>
      </Box>
    </Box>
  );
}

/** The decision as the dialog shows it: applied (`frozen`) or to take. */
export default function DecisionScreen({ frozen = null, undoing, onUndo, onDownload, deliverables, ...decision }) {
  if (frozen) return <AppliedDecision frozen={frozen} undoing={undoing} onUndo={onUndo} onDownload={onDownload} deliverables={deliverables} />;
  return <Decision {...decision} />;
}
