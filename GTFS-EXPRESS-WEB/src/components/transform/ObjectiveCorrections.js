/**
 * ObjectiveCorrections — the corrections of the person's objectives that the assistant PROPOSED (the Albi end-to-end
 * test of 2026-10-07: asked « voulez-vous les corriger ? » and told yes, the assistant said it had reformulated decided
 * objectives that no tool of its own can change, and the same false failures were signed at the delivery). The
 * objectives are the person's record: the change planner never changes one, it proposes (propose_clause_corrections →
 * the SSE `clause_corrections`, each replacement measured on the change of that turn, again whenever the change moved
 * within it), and the person applies the proposal here, in ONE act under their name — each wrong objective set aside
 * (waived) with the reason « corrigé : … », its replacement kept — through the contract's own machinery
 * (common/useContract: the waiver's acknowledgement and the journal). The change is then simulated again with the
 * contract as it now is (ChangeStudio simulates on every change of the contract it sends).
 *
 * The proposals are kept with the project too (context.corrections, withProposals): a reload, another visit, the
 * delivery's checks (④) still show the ones nobody applied, where the person signs — never a proposal lost with the
 * conversation. What is kept is the proposal, never its measure (taken on a change that may be another by then).
 *
 *   withCorrections(contract, corrections, { name, reasonOf, at }) → the contract once the pending corrections are
 *     applied under `name` (never anonymous: ACKNOWLEDGEMENT_UNNAMED otherwise); unchanged when their replacements
 *     do not fit in the contract (MAX_CONTRACT_CLAUSES: never one left out by the bound, roomFor)
 *   correctionState(contract, correction) → "pending" | "applied" | "stale": stale when the objective is gone, is
 *     another objective under its id (another kind, or other words than the proposal names: a new reading of the brief
 *     numbers its own c1, c2… again, and an objective nobody decided has no date to tell them apart), was decided
 *     again since the proposal (`decided_at`), or was corrected otherwise (another replacement recorded under that
 *     name: applied only when the recorded clause says what this replacement says) — a proposal never overrides the
 *     person's later decision, nor lands on an objective it was not written for
 *   roomFor(contract, corrections) → { needed, free }: the replacements the pending corrections add, the places left
 *   withProposals(held, incoming, contract) → the proposals a project keeps: the latest per objective, the stale ones
 *     dropped, MAX_KEPT_CORRECTIONS at most, without their measure
 *
 * One by one (owner's UX lot 2, 2026-10-11: « tout ou rien force à refuser une bonne correction pour en éviter une
 * mauvaise »): each pending correction is accepted or not in place — ticked by default, unticked it stays proposed
 * and is left out of the act —, or set aside for good (« Écarter », `onDismiss`: the host drops the proposal from
 * what the project keeps); the name is asked once for the lot accepted, and the act names how many it applies.
 *
 *   objective-corrections         the block (`data-state`: pending | applied | stale)
 *   objective-correction          one correction (`data-clause`, `data-state`, `data-action`: replace | dismiss;
 *                                 `data-accepted` while pending)
 *   objective-correction-accept   its tick (pending only)
 *   objective-correction-dismiss  « Écarter » (pending only, when the host can drop the proposal)
 *   objective-correction-measured the replacement measured on the change of the turn (`data-status`: pass | fail | unknown)
 *   objective-corrections-full    the contract has no room for the replacements: the act is closed, said why
 *   objective-corrections-name    the decider's name (every correction is recorded under it)
 *   objective-corrections-apply   « Appliquer n correction(s) sous mon nom » (the ticked ones)
 */

import React, { useState } from "react";
import { Box, Button, Checkbox, TextField, Typography, alpha } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useLanguage } from "../../contexts/LanguageContext";
import { MAX_CONTRACT_CLAUSES, addClause, decideClause, decisionOf, nameOk } from "../../utils/contract";

/** As many proposals as a project keeps (the latest per objective). */
export const MAX_KEPT_CORRECTIONS = 40;

const clauseOf = (contract, id) => (contract?.clauses || []).find((c) => c?.id === id) || null;
// Two clauses that say the same thing: one kind, the same params whatever the order of their keys.
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const sameStatement = (a, b) => Boolean(a && b && a.kind === b.kind && stable(a.params || {}) === stable(b.params || {}));
// The words the proposal names (the server's copy of the objective's: trimmed, cut at 200 characters with « … »).
const sameWords = (named, own) => {
  const a = String(named).trim();
  const b = String(own ?? "").trim();
  return a === b || (a.endsWith("…") && a.length > 1 && b.startsWith(a.slice(0, -1)));
};
// The objective the proposal was written for: its kind and, when the proposal carries them, its words.
const sameObjective = (clause, fix) => (typeof fix.kind !== "string" || !fix.kind || clause.kind === fix.kind) && (typeof fix.text !== "string" || !fix.text.trim() || sameWords(fix.text, clause.text));

/** Where a proposed correction stands against the contract as it now is (see the header). */
export const correctionState = (contract, fix) => {
  const clause = clauseOf(contract, fix?.clause);
  if (!clause || !sameObjective(clause, fix)) return "stale";
  const recorded = fix?.replacement ? clauseOf(contract, fix.replacement.id) : null;
  // Set aside: by this act (its very replacement kept beside it), or a dismissal the person made themself.
  if (decisionOf(clause) === "waive") return !fix.replacement || sameStatement(recorded, fix.replacement) ? "applied" : "stale";
  // A clause already under the replacement's name (another proposal applied since): never written over.
  if (recorded) return "stale";
  return (clause.decision?.at || null) === (fix.decided_at ?? null) ? "pending" : "stale";
};

/** The places the pending corrections' replacements take in the contract, and the places it has left. */
export const roomFor = (contract, corrections) => ({
  needed: (corrections || []).filter((f) => f?.replacement && correctionState(contract, f) === "pending").length,
  free: Math.max(0, MAX_CONTRACT_CLAUSES - (contract?.clauses || []).length),
});

// The replacement as the contract keeps it: the server's clause, with nothing else the event carries.
const replacementOf = (r) => ({ id: r.id, kind: r.kind, level: r.level === "should" ? "should" : "must", status: "stated", ...(r.text ? { text: r.text } : {}), params: r.params && typeof r.params === "object" ? r.params : {}, ...(r.quote ? { quote: r.quote } : {}), ...(Number.isInteger(r.page) ? { page: r.page } : {}), ...(r.document ? { document: r.document } : {}), ...(r.source ? { source: r.source } : {}) });

/**
 * The pending corrections applied under `name`: the objective set aside with `reasonOf(fix)` (« corrigé : … »), its
 * replacement kept (decided « keep ») — both named, both dated `at`. What is not pending any more is left as it is;
 * replacements the contract has no room for leave the whole act undone (one act: never half of it).
 */
export const withCorrections = (contract, corrections, { name, reasonOf = (fix) => fix.reason, at = new Date().toISOString() } = {}) => {
  if (!nameOk(name)) throw Object.assign(new Error("Corrections of the objectives are applied by a named person."), { code: "ACKNOWLEDGEMENT_UNNAMED" });
  const room = roomFor(contract, corrections);
  if (room.needed > room.free) return contract;
  return (corrections || []).reduce((c, fix) => {
    if (correctionState(c, fix) !== "pending") return c;
    const next = { ...c, clauses: (c.clauses || []).map((x) => (x.id === fix.clause ? decideClause(x, "waive", { name, at, reason: reasonOf(fix) }) : x)) };
    return fix.replacement ? addClause(next, replacementOf(fix.replacement), { name, at }) : next;
  }, contract);
};

/** The proposals a project keeps (see the header): the latest per objective first in time, the stale ones dropped. */
export const withProposals = (held, incoming, contract) => {
  const shape = (f) => {
    const { measured: _m, ...rest } = f; // eslint-disable-line no-unused-vars
    return rest;
  };
  const fresh = (incoming || []).filter((f) => f && typeof f.clause === "string").map(shape);
  const latest = new Set(fresh.map((f) => f.clause));
  const kept = (held || []).filter((f) => f && typeof f.clause === "string" && !latest.has(f.clause) && correctionState(contract, f) !== "stale");
  return [...kept, ...fresh].slice(-MAX_KEPT_CORRECTIONS);
};

const MEASURED_TONE = { pass: "success.main", fail: "error.main", unknown: "warning.main" };

export default function ObjectiveCorrections({ corrections = [], contract = null, name = "", onName = null, onApply = null, onDismiss = null, disabled = false, measures = true, hideStale = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  // The corrections the person unticked (by the objective's id): proposed still, left out of the act.
  const [refused, setRefused] = useState(() => new Set());
  const all = (corrections || []).filter((f) => f && typeof f.clause === "string");
  const list = hideStale ? all.filter((f) => correctionState(contract, f) !== "stale") : all;
  if (!list.length) return null;
  const states = list.map((f) => correctionState(contract, f));
  const pending = list.filter((_, i) => states[i] === "pending");
  const chosen = pending.filter((f) => !refused.has(f.clause));
  const named = nameOk(name);
  const room = roomFor(contract, chosen);
  const full = room.needed > room.free;
  const state = pending.length ? "pending" : states.includes("applied") ? "applied" : "stale";
  const toggle = (fix) =>
    setRefused((r) => {
      const next = new Set(r);
      if (next.has(fix.clause)) next.delete(fix.clause);
      else next.add(fix.clause);
      return next;
    });
  return (
    <Box component="section" aria-label={t("objectiveCorrections.title", { count: list.length })} data-testid="objective-corrections" data-state={state} sx={{ p: 1.25, borderRadius: "12px", background: alpha(theme.palette.primary.main, 0.06), display: "flex", flexDirection: "column", gap: 0.75 }}>
      <Typography component="h3" sx={{ fontSize: "0.8rem", fontWeight: 700 }}>
        {t("objectiveCorrections.title", { count: list.length })}
      </Typography>
      <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.5 }}>{t("objectiveCorrections.hint")}</Typography>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.75 }}>
        {list.map((f, i) => {
          const clause = clauseOf(contract, f.clause);
          const status = measures && f.replacement && f.measured && MEASURED_TONE[f.measured.status] ? f.measured.status : null;
          return (
            <Box component="li" key={f.clause} data-testid="objective-correction" data-clause={f.clause} data-state={states[i]} data-action={f.replacement ? "replace" : "dismiss"} data-accepted={states[i] === "pending" ? String(!refused.has(f.clause)) : undefined} sx={{ pl: 1, borderLeft: `3px solid ${states[i] === "pending" && !refused.has(f.clause) ? theme.palette.primary.main : theme.palette.divider}`, display: "flex", flexDirection: "column", gap: 0.25, opacity: states[i] === "pending" && refused.has(f.clause) ? 0.7 : 1 }}>
              {/* The objective as the person decided it: struck once the correction is applied. Pending, its tick says
                  whether this one goes with the act; « Écarter » drops the proposal for good. */}
              <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5 }}>
                {states[i] === "pending" && (
                  <Checkbox size="small" checked={!refused.has(f.clause)} onChange={() => toggle(f)} disabled={disabled} inputProps={{ "aria-label": t("objectiveCorrections.accept"), "data-testid": "objective-correction-accept" }} sx={{ p: 0, mt: "1px" }} />
                )}
                <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.76rem", fontWeight: 600, lineHeight: 1.45, textDecoration: states[i] === "applied" ? "line-through" : "none" }}>{clause?.text || f.text || f.clause}</Typography>
                {states[i] === "pending" && onDismiss && (
                  <Button size="small" onClick={() => onDismiss(f)} disabled={disabled} data-testid="objective-correction-dismiss" sx={{ flexShrink: 0, minWidth: 0, px: 0.75, py: 0, fontSize: "0.72rem", color: "text.secondary", textTransform: "none" }}>
                    {t("objectiveCorrections.dismissProposal")}
                  </Button>
                )}
              </Box>
              <Typography sx={{ fontSize: "0.74rem", lineHeight: 1.45 }}>{f.replacement ? t("objectiveCorrections.replace", { text: f.replacement.text || f.replacement.kind }) : t("objectiveCorrections.dismiss")}</Typography>
              {status && states[i] === "pending" && (
                <Typography data-testid="objective-correction-measured" data-status={status} sx={{ fontSize: "0.7rem", fontWeight: 600, color: MEASURED_TONE[status] }}>
                  {t(`objectiveCorrections.measured.${status}`)}
                </Typography>
              )}
              <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45 }}>{t("objectiveCorrections.why", { reason: f.reason || "" })}</Typography>
              {states[i] === "applied" && clause?.decision?.by?.name && <Typography sx={{ fontSize: "0.7rem", color: "success.main" }}>{t("objectiveCorrections.applied", { name: clause.decision.by.name })}</Typography>}
              {states[i] === "stale" && <Typography sx={{ fontSize: "0.7rem", color: "warning.main" }}>{t("objectiveCorrections.stale")}</Typography>}
            </Box>
          );
        })}
      </Box>
      {pending.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, pt: 0.25 }}>
          {/* No room for the replacements in the contract: the act would leave one out — closed, and said why: the places
              left beside the replacements (a contract short of its bound by a few is not « full »). */}
          {full && (
            <Typography data-testid="objective-corrections-full" sx={{ fontSize: "0.72rem", color: "warning.main", lineHeight: 1.5 }}>
              {t("objectiveCorrections.full", { free: room.free, max: MAX_CONTRACT_CLAUSES, count: room.needed })}
            </Typography>
          )}
          {/* Who applies them: every correction is recorded under this name (the one remembered, or typed here). */}
          <TextField size="small" label={t("contract.decider")} value={name} onChange={(e) => onName?.(e.target.value)} disabled={!onName || disabled} helperText={t("objectiveCorrections.nameHint")} inputProps={{ "data-testid": "objective-corrections-name", maxLength: 120, autoComplete: "name" }} />
          {/* The ticked corrections only; none ticked, the act waits and says so. */}
          <Button variant="contained" size="small" disableElevation disabled={disabled || full || !named || !onApply || !chosen.length} onClick={() => onApply(chosen, name.trim())} data-testid="objective-corrections-apply" data-count={chosen.length} sx={{ alignSelf: "flex-start", textTransform: "none", fontWeight: 700 }}>
            {t("objectiveCorrections.applyCount", { count: chosen.length })}
          </Button>
          {!chosen.length && (
            <Typography data-testid="objective-corrections-none" sx={{ fontSize: "0.72rem", color: "text.secondary", lineHeight: 1.5 }}>
              {t("objectiveCorrections.none")}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}
