/**
 * ChangeRecap — the delivery's simple, clear summary of the changes made to
 * the GTFS, read from the simulation the server returned — or, once applied,
 * from what the scenario kept of it:
 *
 *   change-recap             the block (`data-operations`: the operations that change the network)
 *   change-recap-fact        what was verified, one line each (`data-fact`: operations | validator; `data-state`:
 *                            done | waiting | problem): the operations simulated (applied, once the scenario is:
 *                            `applied`, its version), the canonical validator's answer
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

export default function ChangeRecap({ plan = null, preview = null, catalogue = [], validating = false, seconds = 0, applied: appliedIn = null }) {
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
  const gate = gateOf(preview);
  const newErrors = gateNewErrors(gate).length;
  const validator = validating ? "running" : preview.validation?.error ? "failed" : gateValidatorOff(gate) ? "unavailable" : newErrors ? "new_errors" : gate?.validation === "passed" ? "passed" : "not_run";
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
