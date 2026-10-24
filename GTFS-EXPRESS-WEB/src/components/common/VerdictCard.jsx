/**
 * The engine's verdict on a simulated change, pinned at the head of the checks (G3): the server's
 * (services/verdict.verdictOf), never computed here. Each status is an icon and a word, never a colour alone; what
 * the engine measured, in its own English terms, is only a row's tooltip. Never "Deliverable" before the validator
 * passed (G1); "after acknowledgement" and "why not" are the gate's own words, never re-derived.
 */

import React from "react";
import { Box, Typography, alpha, useTheme } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import HighlightOffIcon from "@mui/icons-material/HighlightOff";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import { useLanguage } from "../../contexts/LanguageContext";
import { engineNote } from "../../utils/engineNotes";

const STATUS = {
  conforms: { key: "verdict.conforms", tone: "success", Icon: CheckCircleOutlineIcon },
  guaranteesOnly: { key: "verdict.guaranteesOnly", tone: "text", Icon: CheckCircleOutlineIcon },
  notConforms: { key: "verdict.notConforms", tone: "error", Icon: HighlightOffIcon },
  toConfirm: { key: "verdict.toConfirm", tone: "warning", Icon: HelpOutlineIcon },
  noContract: { key: "verdict.noContract", tone: "text", Icon: RemoveCircleOutlineIcon },
  none: { key: "verdict.none", tone: "text", Icon: HelpOutlineIcon },
};
const GATE_REASONS = new Set(["blocked_steps", "integrity", "validator_unavailable", "validation_new_errors"]);

/**
 * The verdict's status. Not conforming only because must clauses could not be measured reads "À confirmer", never a
 * red failure. A verdict holding only a modification's two default guarantees reads "guaranteesOnly" in a neutral
 * tone: « Conforme » in green would say that a brief is met.
 */
export const verdictStatus = (verdict, { measured = false } = {}) => {
  if (!verdict || !verdict.must) return measured ? "noContract" : "none";
  const should = verdict.should || {};
  if (!verdict.must.total && !should.total) return "noContract";
  if (verdict.conforms && verdict.objectives && !verdict.objectives.total && !should.total) return "guaranteesOnly";
  if (verdict.conforms) return "conforms";
  return !verdict.must.fail && verdict.must.unknown > 0 ? "toConfirm" : "notConforms";
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
 * The validator's line: the gate's run — "could not run" when the preview's own validation came back with an
 * error (the gate then still says not_run).
 */
const validatorLine = ({ gate, validation }) => {
  if (gate) {
    const errors = (gate.blocking || []).find((b) => b && b.code === "validation_new_errors")?.new_errors || [];
    if (gate.validation === "new_errors" || errors.length) return { key: "verdict.validator.newErrors", params: { count: errors.length || 1 }, tone: "error" };
    if (gate.validation === "passed") return { key: "verdict.validator.ok", tone: "success" };
    if (gate.validation === "unavailable") return { key: "verdict.validator.unavailable", tone: "error" };
    if (validation && validation.error) return { key: "gtfsCheck.failed", tone: "error" };
    return { key: "verdict.validator.pending", tone: "text" };
  }
  return null;
};

/**
 * Deliverable, deliverable once the validator passes, after a named acknowledgement, or not, with the server's first
 * reason. A gate whose validator has not passed is never "Deliverable": the delivery runs it and refuses on its answer.
 */
const deliverableLine = ({ verdict, gate }, t) => {
  const deliverable = typeof verdict?.deliverable === "boolean" ? verdict.deliverable : typeof gate?.deliverable === "boolean" ? gate.deliverable : null;
  if (deliverable === null) return null;
  if (deliverable && gate && gate.validation !== "passed") return { key: "verdict.deliverable.ifValidator", tone: "text" };
  if (deliverable) return { key: "verdict.deliverable.yes", tone: "success" };
  if (!gate) return { key: "verdict.deliverable.no", params: { reason: t("verdict.reason.other") }, tone: "error" };
  const blocking = (gate.blocking || []).filter(Boolean);
  if (!blocking.length && gate.can_commit && (gate.acknowledgeable || []).length) return { key: "verdict.deliverable.afterAck", tone: "warning" };
  const code = blocking[0]?.code;
  const reason = !blocking.length && !gate.can_commit ? t("verdict.reason.nothing") : t(GATE_REASONS.has(code) ? `verdict.reason.${code}` : "verdict.reason.other");
  return { key: "verdict.deliverable.no", params: { reason }, tone: "error" };
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

export default function VerdictCard({ payload = null, measured = false, steps = null, integrity = null, sx = null }) {
  const { t, language } = useLanguage();
  const theme = useTheme();
  const titleId = `verdict-title-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const verdict = payload?.verdict || null;
  // A preview (its gate) means a measurement ran: no verdict then is no contract.
  const status = verdictStatus(verdict, { measured: measured || Boolean(payload?.gate) });
  const S = STATUS[status];
  const color = toneColor(theme, S.tone);
  const conforms = verdict && verdict.must ? String(Boolean(verdict.conforms)) : "none";

  const must = verdict?.must;
  const mustParams = must ? { total: must.total, pass: must.pass, fail: must.fail, unknown: must.unknown } : null;
  const should = verdict?.should;
  const validator = validatorLine(payload || {});
  const deliverable = deliverableLine(payload || {}, t);
  const time = clockOf(verdict?.checked_at, language);
  const foot = [validator && { ...validator, text: t(validator.key, validator.params) }, deliverable && { ...deliverable, text: t(deliverable.key, deliverable.params) }, time && { tone: "text", text: t("verdict.measuredAt", { time }) }].filter(Boolean);
  const stepCounts = Array.isArray(steps) && steps.length ? { total: steps.length, done: steps.filter((s) => s.status === "applied" || s.status === "skipped").length, questions: steps.filter((s) => s.status === "blocked").length, failed: steps.filter((s) => s.status === "failed").length } : null;

  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      data-testid="verdict-card"
      data-status={status}
      data-conforms={conforms}
      sx={{ p: 1.25, borderRadius: "12px", display: "flex", flexDirection: "column", gap: 0.5, background: theme.palette.background.paper, boxShadow: `0 0 0 2px ${alpha(color, 0.55)}`, ...(sx || {}) }}
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
          {t("verdict.must", mustParams)}
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
