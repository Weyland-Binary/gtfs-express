/**
 * VerdictCard — the engine's verdict, shown before the model's prose and in
 * its place (target design §6.1, M-2; D25).
 *
 * The verdict is the server's (services/verdict.verdictOf), never computed
 * here: the card renders the SSE `verdict` event AS EMITTED — `{ verdict,
 * readiness, prose }` by the network planner, `{ verdict, gate, prose }` by
 * the change planner — or the same fields of a response (POST
 * /transform/preview: `{ verdict, gate }`, with the preview's `validation`
 * when the studio has it; POST /network/evaluate: `{ verdict }`). It reads,
 * in this order:
 *
 *   status        Conforms / Does not conform (the server's `conforms` as
 *                 it is: a desired clause not met stays on its own line) /
 *                 To confirm (no must clause failing, some not measured) /
 *                 No contract (measured, no clause) / Not measured yet — an
 *                 icon and a word, never a colour alone
 *   verdict-must      mandatory clauses: met · not met · not measured
 *   verdict-should    desired clauses (when there are some)
 *   verdict-failing   one row per must clause not met: its words and « non
 *                 tenue » in the person's language; what the engine
 *                 measured, in its own terms (English), only as the row's
 *                 tooltip (the owner's test of 2026-10-07 read « non tenue :
 *                 mesuré 24 on 2027-01-09 (expected exactly 10) » as text)
 *   verdict-unknown   one row per must clause the engine could not measure
 *   verdict-coverage  the brief's requirement sentences and what answers
 *                 them (G5, the server's detector): covered by a clause,
 *                 « à vérifier à la main », dismissed by name, without any
 *   verdict-over-limit  a design over the offer's lines (D9): said by the
 *                 verdict, never discovered at the build
 *   verdict-unread  the documents the detector could not read that nobody
 *                 acknowledged by name: their requirements were not checked
 *   verdict-contract-empty  an empty contract (D15): how many requirement
 *                 sentences no clause answers (said, never holding)
 *   verdict-kept-by-default  the « inchangé » clauses kept by default that
 *                 nobody decided yet (B2): measured from the draft on
 *   verdict-deliverable  the validator (the gate's run, "could not run"
 *                 when the preview's validation failed, or "waiting for the
 *                 build" before a network is built), deliverable or why not,
 *                 and when it was measured. Never "Deliverable" before the
 *                 validator passed: a gate whose validation is not "passed"
 *                 reads "deliverable if the validator passes" (§6, M-4).
 *                 "After acknowledgement" is the server's word — the gate's
 *                 acknowledgeable list, the planner's
 *                 readiness.ready_once_acknowledged — and "why not" is the
 *                 gate's first blocking reason or the planner's first HARD
 *                 reason — or the verdict's own `not_deliverable` (requirements
 *                 without a clause, the offer's line limit); nothing is
 *                 re-derived here (D25)
 *
 * Not a word of the model inside. Three renderings of one datum:
 * `variant="turn"` at the head of an assistant turn, `"pinned"` at the head
 * of the checks (with the simulation's steps and integrity when given), and
 * `"compact"` — one inline line (testid verdict-compact) for a status line.
 * `measured` says a measurement ran without clauses (verdict null → "No
 * contract" rather than "Not measured yet"); a gate, or a planner readiness
 * on a plan, without a verdict implies it. `design` marks a network design
 * measured before its build (the validator runs at the build).
 *
 * `counts` (the change flow's: utils/objectiveCounts over the simulation's
 * results — the very results the server's verdict is counted from) says
 * the objectives as ③'s panel and ④'s recap count them: the person's
 * mandatory objectives (`verdict-must`), and apart their desired clauses
 * (`verdict-should`) and the two default guarantees (`verdict-guarantees`)
 * — never « 14 objectifs tenus sur 22 » on the page that says « 13 sur 20 »
 * and the guarantees beside them (the owner's test of 2026-10-07). The
 * status itself stays the server's. `split` (the change flow's turn cards)
 * without `counts` — a turn measured on other results than the page's
 * (an earlier plan, a simulation the page did not see) — says the server's
 * count as what it is: every mandatory requirement together
 * (`verdict.must.all`), never « N objectifs » beside the page's own count
 * of the objectives and, apart, of the default guarantees.
 *
 * `verdictStatus` is exported for tests and for the status lines;
 * `countsLine(t, counts)` is the compact line of that count (the tiles).
 */

import React from "react";
import { Box, Typography, alpha, useTheme } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import HighlightOffIcon from "@mui/icons-material/HighlightOff";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import { useLanguage } from "../../contexts/LanguageContext";
import { readinessLines } from "../network/PlanCards";
import { engineNote } from "../../utils/engineNotes";

const STATUS = {
  conforms: { key: "verdict.conforms", tone: "success", Icon: CheckCircleOutlineIcon },
  guaranteesOnly: { key: "verdict.guaranteesOnly", tone: "text", Icon: CheckCircleOutlineIcon },
  notConforms: { key: "verdict.notConforms", tone: "error", Icon: HighlightOffIcon },
  toConfirm: { key: "verdict.toConfirm", tone: "warning", Icon: HelpOutlineIcon },
  noContract: { key: "verdict.noContract", tone: "text", Icon: RemoveCircleOutlineIcon },
  none: { key: "verdict.none", tone: "text", Icon: HelpOutlineIcon },
};
// The planner's reasons that are NOT hard (they only keep a plan from being clean): never the reason a
// plan is not deliverable. The hard ones are the server's (networkPlannerService HARD_REASONS).
const SOFT_REASONS = new Set(["major_finding", "fleet_over", "budget_over", "direction_unserved", "accessibility"]);
const GATE_REASONS = new Set(["blocked_steps", "integrity", "assumptions_too_many", "validator_unavailable", "validation_new_errors", "requirements_uncovered"]);
// The verdict's own reasons (services/verdict: not_deliverable): G5's uncovered requirements, D9's offer.
const VERDICT_REASONS = new Set(["requirements_uncovered", "offer"]);
const reasonParams = (verdict) => ({ count: (verdict?.coverage?.uncovered || []).length, lines: verdict?.over_plan_limit?.count ?? 0, max: verdict?.over_plan_limit?.max ?? 0 });

/**
 * What the verdict says, as one of the statuses above: the server's
 * `conforms` read as it is (§6.1: "Conforme" / "Non conforme"), "noContract"
 * when something was measured without a clause. A verdict that does not
 * conform only because must clauses could not be measured (none failing, the
 * server's own counts) reads "À confirmer": nothing was found wrong, a named
 * acknowledgement or a measure is still due — never a red failure. A
 * verdict that holds only the two default guarantees of a modification (the
 * server's `objectives` split counts no objective of the person) reads
 * "guaranteesOnly", in a neutral tone: the rest of the network and of the day
 * are unchanged, no brief is met — « Conforme au contrat » in green said more,
 * beside « Contrat à décider » (the review of 2026-10-08).
 */
export const verdictStatus = (verdict, { measured = false } = {}) => {
  if (!verdict || !verdict.must) return measured ? "noContract" : "none";
  const should = verdict.should || {};
  if (!verdict.must.total && !should.total) return "noContract";
  if (verdict.conforms && verdict.objectives && !verdict.objectives.total && !should.total) return "guaranteesOnly";
  if (verdict.conforms) return "conforms";
  return !verdict.must.fail && verdict.must.unknown > 0 ? "toConfirm" : "notConforms";
};

/**
 * The change flow's count in one short line: the objectives met of how many and the ones to measure — and the default
 * guarantees once one of them is not met. → the line, or null when there is nothing to count.
 */
export const countsLine = (t, counts) => {
  const o = counts?.objectives;
  const g = counts?.guarantees;
  const parts = [o && o.total > 0 ? t("status.verdict", { pass: o.pass, total: o.total, unknown: o.unknown }) : null, g && g.pass < g.total ? t("verdict.guarantees", { pass: g.pass, total: g.total, fail: g.fail, unknown: g.unknown }) : null];
  return parts.filter(Boolean).join(" · ") || null;
};

const clockOf = (iso, language) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(`${String(language || "en").slice(0, 2)}-u-nu-latn`, { hour: "2-digit", minute: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(11, 16);
  }
};

/**
 * The validator's line: the gate's run (change plan) — "could not run" when
 * the preview's own validation came back with an error (the gate then still
 * says not_run) — or "waiting for the build" (a design not built yet).
 */
const validatorLine = ({ gate, readiness, validation }, design) => {
  if (gate) {
    const errors = (gate.blocking || []).find((b) => b && b.code === "validation_new_errors")?.new_errors || [];
    if (gate.validation === "new_errors" || errors.length) return { key: "verdict.validator.newErrors", params: { count: errors.length || 1 }, tone: "error" };
    if (gate.validation === "passed") return { key: "verdict.validator.ok", tone: "success" };
    if (gate.validation === "unavailable") return { key: "verdict.validator.unavailable", tone: "error" };
    if (validation && validation.error) return { key: "gtfsCheck.failed", tone: "error" };
    return { key: "verdict.validator.pending", tone: "text" };
  }
  if (readiness || design) return { key: "verdict.validator.notBuilt", tone: "text" };
  return null;
};

/**
 * Deliverable, deliverable once the validator passes, deliverable after a
 * named acknowledgement, or not — with the server's first reason. A gate
 * whose validator has not passed (not run yet, or its run failed) is never
 * "Deliverable": the delivery runs the validator and refuses on its answer.
 */
const deliverableLine = ({ verdict, gate, readiness }, t, language) => {
  const deliverable = typeof verdict?.deliverable === "boolean" ? verdict.deliverable : typeof gate?.deliverable === "boolean" ? gate.deliverable : readiness ? Boolean(readiness.ready) : null;
  if (deliverable === null) return null;
  if (deliverable && gate && gate.validation !== "passed") return { key: "verdict.deliverable.ifValidator", tone: "text" };
  if (deliverable) return { key: "verdict.deliverable.yes", tone: "success" };
  const own = (verdict?.not_deliverable || []).find((r) => VERDICT_REASONS.has(r));
  if (own) return { key: "verdict.deliverable.no", params: { reason: t(`verdict.reason.${own}`, reasonParams(verdict)) }, tone: "error" };
  if (gate) {
    const blocking = (gate.blocking || []).filter(Boolean);
    if (!blocking.length && gate.can_commit && (gate.acknowledgeable || []).length) return { key: "verdict.deliverable.afterAck", tone: "warning" };
    const code = blocking[0]?.code;
    const reason = !blocking.length && !gate.can_commit ? t("verdict.reason.nothing") : t(GATE_REASONS.has(code) ? `verdict.reason.${code}` : "verdict.reason.other", { count: (blocking[0]?.sentences || []).length });
    return { key: "verdict.deliverable.no", params: { reason }, tone: "error" };
  }
  // The planner said whether a named acceptance of its clauses makes the plan deliverable: shown as said.
  if (readiness?.ready_once_acknowledged === true) return { key: "verdict.deliverable.afterAck", tone: "warning" };
  const reasons = (readiness?.reasons || []).filter(Boolean);
  const first = reasons.find((r) => !SOFT_REASONS.has(r.code)) || reasons[0];
  return { key: "verdict.deliverable.no", params: { reason: first ? readinessLines([first], t, language)[0] : t("verdict.reason.other") }, tone: "error" };
};

/**
 * The verdict in one word and a tone, for an indicator (StepChecks's tiles): the same status the card says, read the
 * same way (a gate or a readiness implies a measurement). → { status, key, tone: "ok" | "error" | "warn" | "neutral" }.
 */
export const verdictSummary = (payload, { measured = false } = {}) => {
  const implied = Boolean(payload?.gate) || Boolean(payload?.readiness && !(payload.readiness.reasons || []).some((r) => r && r.code === "no_plan"));
  const status = verdictStatus(payload?.verdict || null, { measured: measured || implied });
  const tone = { success: "ok", error: "error", warning: "warn" }[STATUS[status].tone] || "neutral";
  return { status, key: STATUS[status].key, tone, must: payload?.verdict?.must || null };
};

const toneColor = (theme, tone) => (tone === "text" ? theme.palette.text.secondary : theme.palette[tone]?.main || theme.palette.text.secondary);

/**
 * One clause row: the mark, the clause's words, what the engine found. Its id (a key of the engine, in
 * English) is shown only when the clause has no words of its own; it stays the row's title.
 */
// `hint`: the engine's own explanation (its terms), the row's tooltip rather than its text.
function ClauseRow({ testid, mark, tone, clause, detail, hint = null }) {
  const theme = useTheme();
  return (
    <Box data-testid={testid} data-clause={clause.id} title={hint || clause.id} sx={{ display: "flex", gap: 0.75, alignItems: "baseline", fontSize: "0.74rem", lineHeight: 1.45 }}>
      <Box component="span" aria-hidden="true" sx={{ fontWeight: 800, color: toneColor(theme, tone), flexShrink: 0 }}>
        {mark}
      </Box>
      <Box component="span" sx={{ minWidth: 0, overflowWrap: "anywhere" }}>
        {!clause.text && (
          <Box component="span" sx={{ fontWeight: 700, fontFamily: "monospace", mr: 0.5 }} lang="en">
            {clause.id}
          </Box>
        )}
        {clause.text || clause.expected || clause.kind || ""}
        <Box component="span" sx={{ color: "text.secondary" }}>{` — ${detail}`}</Box>
      </Box>
    </Box>
  );
}

export default function VerdictCard({ payload = null, variant = "turn", measured = false, design = false, steps = null, integrity = null, counts = null, split = false, sx = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const titleId = `verdict-title-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const verdict = payload?.verdict || null;
  // A preview (its gate) or a planner's readiness on a plan means a measurement ran: no verdict then is no contract.
  const implied = Boolean(payload?.gate) || Boolean(payload?.readiness && !(payload.readiness.reasons || []).some((r) => r && r.code === "no_plan"));
  const status = verdictStatus(verdict, { measured: measured || implied });
  const S = STATUS[status];
  const color = toneColor(theme, S.tone);
  const conforms = verdict && verdict.must ? String(Boolean(verdict.conforms)) : "none";
  const contradicts = payload?.prose?.contradicts ? "true" : "false";

  if (variant === "compact") {
    const line = counts ? countsLine(t, counts) : verdict && verdict.must && status !== "noContract" ? t("status.verdict", { pass: verdict.must.pass, total: verdict.must.total, unknown: verdict.must.unknown }) : null;
    return (
      <Box component="span" data-testid="verdict-compact" data-status={status} data-conforms={conforms} sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, fontWeight: 700, color, ...(sx || {}) }}>
        <S.Icon aria-hidden="true" sx={{ fontSize: 16 }} />
        <span>{line ? `${t(S.key)} · ${line}` : t(S.key)}</span>
      </Box>
    );
  }

  // The change flow counts the person's objectives apart from their desired clauses and the default guarantees
  // (`counts`), as its other places do — and, split without them, says the server's count as every mandatory
  // requirement together, never as « objectifs ».
  const must = counts ? counts.objectives : verdict?.must;
  const mustParams = must ? { total: must.total, pass: must.pass, fail: must.fail, unknown: must.unknown } : null;
  const guarantees = counts ? counts.guarantees : null;
  const should = counts ? counts.desired : verdict?.should;
  const unreadDocuments = (verdict?.coverage?.unread || []).filter((u) => u && !u.acknowledged_by);
  const keptByDefault = Array.isArray(verdict?.contract?.kept_by_default) ? verdict.contract.kept_by_default : [];
  const validator = validatorLine(payload || {}, design);
  const deliverable = deliverableLine(payload || {}, t, language);
  const time = clockOf(verdict?.checked_at, language);
  const foot = [validator && { ...validator, text: t(validator.key, validator.params) }, deliverable && { ...deliverable, text: t(deliverable.key, deliverable.params) }, time && { tone: "text", text: t("verdict.measuredAt", { time }) }].filter(Boolean);
  const stepCounts = Array.isArray(steps) && steps.length ? { total: steps.length, done: steps.filter((s) => s.status === "applied" || s.status === "skipped").length, questions: steps.filter((s) => s.status === "blocked").length, failed: steps.filter((s) => s.status === "failed").length } : null;

  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      data-testid="verdict-card"
      data-variant={variant}
      data-status={status}
      data-conforms={conforms}
      data-contradicts={contradicts}
      sx={{ p: 1.25, borderRadius: "12px", display: "flex", flexDirection: "column", gap: 0.5, background: theme.palette.background.paper, boxShadow: `0 0 0 ${variant === "pinned" ? 2 : 1}px ${alpha(color, variant === "pinned" ? 0.55 : 0.35)}`, ...(sx || {}) }}
    >
      <Typography id={titleId} component="h3" sx={{ m: 0, fontSize: "0.64rem", fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase", color: "text.secondary" }}>
        {t("verdict.title")}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.6, color }}>
        <S.Icon aria-hidden="true" sx={{ fontSize: 18 }} />
        <Typography component="span" sx={{ fontSize: "0.86rem", fontWeight: 800, color: "inherit" }}>
          {t(S.key)}
        </Typography>
      </Box>
      {must && must.total > 0 && (
        <Typography data-testid="verdict-must" sx={{ fontSize: "0.76rem", lineHeight: 1.45 }}>
          {!counts && split ? t("verdict.must.all", mustParams) : t("verdict.must", mustParams)}
        </Typography>
      )}
      {guarantees && (
        <Typography data-testid="verdict-guarantees" sx={{ fontSize: "0.76rem", lineHeight: 1.45, color: guarantees.pass < guarantees.total ? "warning.main" : "text.secondary" }}>
          {t("verdict.guarantees", { total: guarantees.total, pass: guarantees.pass, fail: guarantees.fail, unknown: guarantees.unknown })}
        </Typography>
      )}
      {should && should.total > 0 && (
        <Typography data-testid="verdict-should" sx={{ fontSize: "0.76rem", lineHeight: 1.45, color: "text.secondary" }}>
          {t("verdict.should", { total: should.total, pass: should.pass })}
        </Typography>
      )}
      {(verdict?.failing || []).map((c) => (
        // Its status in the person's words; what the engine measured, in its own terms, is the row's tooltip.
        <ClauseRow key={`f-${c.id}`} testid="verdict-failing" mark="✗" tone="error" clause={c} detail={t("ack.clause.failed")} hint={c.measured == null || c.measured === "" ? null : t("verdict.failing", { measured: String(c.measured) })} />
      ))}
      {(verdict?.unknown || []).map((c) => (
        <ClauseRow key={`u-${c.id}`} testid="verdict-unknown" mark="?" tone="warning" clause={c} detail={t("verdict.unknown")} hint={c.note ? engineNote(c.note, t) : null} />
      ))}
      {verdict?.coverage && verdict.coverage.sentences > 0 && (
        <Typography data-testid="verdict-coverage" data-uncovered={(verdict.coverage.uncovered || []).length} sx={{ fontSize: "0.74rem", lineHeight: 1.45, color: (verdict.coverage.uncovered || []).length ? "warning.main" : "text.secondary" }}>
          {t("verdict.coverage", { sentences: verdict.coverage.sentences, covered: verdict.coverage.covered, notMeasurable: verdict.coverage.not_measurable, dismissed: verdict.coverage.dismissed, uncovered: (verdict.coverage.uncovered || []).length })}
        </Typography>
      )}
      {/* A document the detector could not read and nobody acknowledged: its requirements were not checked (G5). */}
      {unreadDocuments.length > 0 && (
        <Typography data-testid="verdict-unread" data-count={unreadDocuments.length} sx={{ fontSize: "0.74rem", lineHeight: 1.45, color: "warning.main", fontWeight: 700 }}>
          {t("verdict.unread", { names: unreadDocuments.map((u) => `« ${u.name || u.id} »`).join(", ") })}
        </Typography>
      )}
      {/* An empty contract (D15): how many requirement sentences no clause answers — said, never holding. */}
      {verdict?.contract?.status === "empty" && Number(verdict.contract.uncovered) > 0 && (
        <Typography data-testid="verdict-contract-empty" data-uncovered={verdict.contract.uncovered} sx={{ fontSize: "0.74rem", lineHeight: 1.45, color: "warning.main" }}>
          {t("verdict.contractEmpty", { count: verdict.contract.uncovered })}
        </Typography>
      )}
      {/* The « inchangé » clauses kept by default nobody decided yet (B2): measured, and said to be so. */}
      {keptByDefault.length > 0 && (
        <Typography data-testid="verdict-kept-by-default" data-clauses={keptByDefault.map((c) => c.id).join(" ")} sx={{ fontSize: "0.74rem", lineHeight: 1.45, color: "text.secondary" }}>
          {t("verdict.keptByDefault", { clauses: keptByDefault.map((c) => c.text || c.id).join(" · ") })}
        </Typography>
      )}
      {verdict?.over_plan_limit && (
        <Typography data-testid="verdict-over-limit" sx={{ fontSize: "0.74rem", lineHeight: 1.45, color: "error.main", fontWeight: 700 }}>
          {t("verdict.overLimit", { lines: verdict.over_plan_limit.count, max: verdict.over_plan_limit.max })}
        </Typography>
      )}
      {stepCounts && (
        <Typography data-testid="verdict-steps" sx={{ fontSize: "0.74rem", color: stepCounts.questions || stepCounts.failed ? "warning.main" : "text.secondary" }}>
          {t("verdict.steps", stepCounts)}
        </Typography>
      )}
      {Array.isArray(integrity) && !integrity.length && (
        <Typography data-testid="verdict-integrity" sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
          {t("verdict.integrity")}
        </Typography>
      )}
      {payload?.prose?.contradicts && (
        <Typography data-testid="verdict-prose-flag" sx={{ fontSize: "0.72rem", fontWeight: 700, color: "error.main" }}>
          {t("verdict.struck")}
        </Typography>
      )}
      {foot.length > 0 && (
        <Typography data-testid="verdict-deliverable" data-deliverable={deliverable ? deliverable.key.split(".").pop() : "unknown"} sx={{ fontSize: "0.72rem", lineHeight: 1.45, mt: 0.25 }}>
          {foot.map((f, i) => (
            <React.Fragment key={i}>
              {i > 0 && <Box component="span" sx={{ color: "text.disabled" }}>{" · "}</Box>}
              <Box component="span" sx={{ color: toneColor(theme, f.tone), fontWeight: f.tone === "text" ? 400 : 700 }}>
                {f.text}
              </Box>
            </React.Fragment>
          ))}
        </Typography>
      )}
    </Box>
  );
}
