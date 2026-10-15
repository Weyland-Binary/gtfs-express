/**
 * ChangeRecap — the delivery's simple, clear summary of the changes made to
 * the GTFS, read from the simulation the server returned — or, once applied,
 * from what the scenario kept of it:
 *
 *   change-recap             the block (`data-operations`: the operations that change the network)
 *   change-recap-fact        what was verified, one line each (`data-fact`: operations | objectives | desired |
 *                            guarantees | validator | decisions | skipped | covered; `data-state`: done | waiting |
 *                            problem): the operations simulated (applied, once the scenario is: `applied`, its
 *                            version), the objectives met and, apart, the desired clauses and the two default
 *                            guarantees (utils/objectiveCounts: the count ③ and the verdict say too), the canonical
 *                            validator's answer, the engine's own answers the person reads again below, the grids of
 *                            the brief the change does not take (`skipped`: their names — kept « à vérifier à la
 *                            main », accepted by name in the form below) and the ones the cell reader could not take
 *                            that an operation of the change builds from their cells (`covered`: [{ text, whole }],
 *                            their names and that operation — never said missing; waiting while one of them is only
 *                            partly covered)
 *   change-recap-operation   one per operation that changes the network: its name and the engine's own sentence
 *                            (past RECAP_FOLD, the first ones and « Voir les N », change-recap-toggle)
 *   change-recap-unchanged   the operations that found nothing to change, in one line
 *
 * Nothing is computed here but counts of what the simulation lists.
 */

import React, { useState } from "react";
import { Box, Button, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import RadioButtonUncheckedRoundedIcon from "@mui/icons-material/RadioButtonUncheckedRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { tokensOf } from "../studio/studioTheme";
import { autoAssumptionsOf, objectiveCounts } from "../../utils/autopilot";
import { guaranteesSaid } from "../../utils/objectiveCounts";
import { opTitle } from "./catalogueText";
import { gateBaselineErrors, gateNewErrors, gateOf, gateValidatorOff } from "./gate";

const RECAP_FOLD = 8;
const RECAP_PEEK = 6;

function Fact({ id, state, children, k }) {
  const Icon = state === "done" ? CheckCircleRoundedIcon : state === "problem" ? ErrorOutlineRoundedIcon : RadioButtonUncheckedRoundedIcon;
  return (
    <Box component="li" data-testid="change-recap-fact" data-fact={id} data-state={state} sx={{ display: "flex", gap: 0.75, alignItems: "flex-start" }}>
      <Icon aria-hidden sx={{ fontSize: 17, color: state === "done" ? k.success : state === "problem" ? k.error : k.ink3, mt: "1px", flexShrink: 0 }} />
      <Typography sx={{ minWidth: 0, fontSize: "0.82rem", color: k.ink, lineHeight: 1.45 }}>{children}</Typography>
    </Box>
  );
}

export default function ChangeRecap({ plan = null, preview = null, catalogue = [], validating = false, seconds = 0, applied: appliedIn = null, skipped = [], covered = [] }) {
  const { t } = useLanguage();
  const k = tokensOf(useTheme());
  const [open, setOpen] = useState(false);
  if (!preview || !(plan?.operations || []).length) return null;
  const steps = preview.steps || [];
  const opOf = (id) => (plan.operations || []).find((o) => o.id === id) || null;
  const titleOf = (s) => {
    const op = opOf(s.id);
    return op?.label || opTitle(t, s.type || op?.type, catalogue.find((c) => c.type === (s.type || op?.type)));
  };
  const applied = steps.filter((s) => s.status === "applied");
  const unchanged = steps.filter((s) => s.status === "skipped");
  // The one count of ③ and ④ (objectiveCounts): an objective the person set aside (waived) is neither met nor missed;
  // the desired clauses and the two default guarantees are counted apart from the person's objectives, as ② counts
  // them — a requirement of the brief that keeps something unchanged is an objective like any other.
  const counts = objectiveCounts(preview.conformance?.after?.results);
  const o = counts && counts.objectives.total ? counts.objectives : null;
  const d = counts ? counts.desired : null;
  const g = counts ? counts.guarantees : null;
  const held = guaranteesSaid(g);
  const coveredItems = (covered || []).map((c) => (typeof c === "string" ? { text: c, whole: true } : c)).filter((c) => c && c.text);
  const gate = gateOf(preview);
  const newErrors = gateNewErrors(gate).length;
  const validator = validating ? "running" : preview.validation?.error ? "failed" : gateValidatorOff(gate) ? "unavailable" : newErrors ? "new_errors" : gate?.validation === "passed" ? "passed" : "not_run";
  const decisions = autoAssumptionsOf(plan).length;
  // The errors the reference GTFS already carried: « valide » is never said over them.
  const baseline = validator === "passed" ? gateBaselineErrors(gate)?.errors || 0 : 0;
  const shown = open || applied.length <= RECAP_FOLD ? applied : applied.slice(0, RECAP_PEEK);
  return (
    <Box component="section" aria-labelledby="change-recap-title" data-testid="change-recap" data-operations={applied.length} sx={{ display: "flex", flexDirection: "column", gap: 1, p: 1.5, borderRadius: "12px", border: `1px solid ${k.line}`, backgroundColor: k.subtle }}>
      <Typography id="change-recap-title" component="h3" sx={{ fontSize: "0.9rem", fontWeight: 600, color: k.ink, letterSpacing: "-0.01em" }}>
        {t("recap.title")}
      </Typography>
      <Box component="ul" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", gap: 0.5 }}>
        <Fact id="operations" state={applied.length ? "done" : "waiting"} k={k}>
          {appliedIn != null ? t("recap.operations.applied", { count: applied.length, n: appliedIn }) : t("recap.operations", { count: applied.length })}
        </Fact>
        {o && (
          <Fact id="objectives" state={o.fail ? "problem" : o.pass === o.total ? "done" : "waiting"} k={k}>
            {t("autopilot.line.objectives", { pass: o.pass, total: o.total })}
            {o.fail > 0 ? ` · ${t("autopilot.line.objectives.fail", { count: o.fail })}` : ""}
            {o.unknown > 0 ? ` · ${t("autopilot.line.objectives.unknown", { count: o.unknown })}` : ""}
          </Fact>
        )}
        {d && (
          <Fact id="desired" state={d.pass === d.total ? "done" : "waiting"} k={k}>
            {t("autopilot.line.desired", { pass: d.pass, total: d.total })}
            {d.fail > 0 ? ` · ${t("autopilot.line.desired.fail", { count: d.fail })}` : ""}
            {d.unknown > 0 ? ` · ${t("autopilot.line.objectives.unknown", { count: d.unknown })}` : ""}
          </Fact>
        )}
        {/* Held, only the guarantees measured are named (the panel's sentence: guaranteesSaid). */}
        {g && (
          <Fact id="guarantees" state={g.fail ? "problem" : g.pass === g.total ? "done" : "waiting"} k={k}>
            {t(held.key, held.params)}
          </Fact>
        )}
        {preview.empty ? (
          <Fact id="validator" state="waiting" k={k}>
            {t("recap.nothing")}
          </Fact>
        ) : (
          // An applied version: the application only succeeds once the validator found no new error — what the
          // scenario kept of its simulation may not say it (never « pas encore lancé » over a version applied).
          <Fact id="validator" state={appliedIn != null && validator === "not_run" ? "done" : baseline ? "waiting" : validator === "passed" ? "done" : validator === "not_run" || validator === "running" ? "waiting" : "problem"} k={k}>
            {appliedIn != null && validator === "not_run" ? t("recap.validator.applied") : baseline ? t("autopilot.line.validator.passedBaseline", { count: baseline }) : t(`autopilot.line.validator.${validator}`, { count: newErrors, seconds })}
          </Fact>
        )}
        {skipped.length > 0 && (
          <Fact id="skipped" state="problem" k={k}>
            {t("recap.skipped", { count: skipped.length, names: skipped.slice(0, 12).join(" ; ") })}
            {skipped.length > 12 ? ` ${t("autopilot.line.more", { count: skipped.length - 12 })}` : ""}
          </Fact>
        )}
        {coveredItems.length > 0 && (
          <Fact id="covered" state={coveredItems.every((c) => c.whole) ? "done" : "waiting"} k={k}>
            {t("recap.covered", { count: coveredItems.length, names: coveredItems.slice(0, 12).map((c) => c.text).join(" ; ") })}
            {coveredItems.length > 12 ? ` ${t("autopilot.line.more", { count: coveredItems.length - 12 })}` : ""}
          </Fact>
        )}
        {decisions > 0 && (
          <Fact id="decisions" state="waiting" k={k}>
            {t("recap.decisions", { count: decisions })}
          </Fact>
        )}
      </Box>
      {applied.length > 0 && (
        <Box component="ol" sx={{ listStyle: "none", m: 0, p: 0, display: "flex", flexDirection: "column", borderTop: `1px solid ${k.lineSoft}` }}>
          {shown.map((s) => (
            <Box component="li" key={s.id} data-testid="change-recap-operation" data-operation={s.id} sx={{ py: 0.75, borderBottom: `1px solid ${k.lineSoft}` }}>
              <Typography sx={{ fontSize: "0.8rem", fontWeight: 600, color: k.ink, lineHeight: 1.4, overflowWrap: "anywhere" }}>{titleOf(s)}</Typography>
              {s.summary && <Typography sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.45, overflowWrap: "anywhere" }}>{s.summary}</Typography>}
            </Box>
          ))}
        </Box>
      )}
      {applied.length > RECAP_FOLD && (
        <Button size="small" onClick={() => setOpen((v) => !v)} aria-expanded={open} data-testid="change-recap-toggle" sx={{ alignSelf: "flex-start", color: k.ink2, mt: -0.5 }}>
          {open ? t("recap.less") : t("recap.more", { count: applied.length })}
        </Button>
      )}
      {unchanged.length > 0 && (
        <Typography data-testid="change-recap-unchanged" sx={{ fontSize: "0.76rem", color: k.ink2, lineHeight: 1.45 }}>
          {t("recap.unchanged", { count: unchanged.length })}
        </Typography>
      )}
    </Box>
  );
}
