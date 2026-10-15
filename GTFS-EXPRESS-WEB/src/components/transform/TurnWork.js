/**
 * TurnWork — what the assistant's turn did under the hood, said in one quiet line in a brief draft: how many
 * simulations, the engine's corrections, the independent audit. A colour only where the person has something to
 * look at (a demand of the brief not found, a change nobody asked for, a correction the engine gave up on); an
 * uncertain point the engine then settled is no alarm. The detail (each step, the audit's findings) unfolds on demand.
 */

import React, { useState } from "react";
import { Box, ButtonBase, Typography, alpha, useTheme } from "@mui/material";
import TaskAltRoundedIcon from "@mui/icons-material/TaskAltRounded";
import ErrorOutlineRoundedIcon from "@mui/icons-material/ErrorOutlineRounded";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useLanguage } from "../../contexts/LanguageContext";

/** The turn's steps summed up: { simulations, corrections, resolved, escalated, audit, alarm }. */
export const turnWorkOf = (steps = []) => {
  const out = { simulations: 0, corrections: 0, resolved: false, escalated: false, audit: null, alarm: false };
  for (const s of steps || []) {
    if (s?.kind === "plan") out.simulations += 1;
    else if (s?.kind === "correction") out.corrections += 1;
    else if (s?.kind === "correctionResolved") out.resolved = true;
    else if (s?.kind === "correctionEscalated" || s?.kind === "budget") out.escalated = true;
    else if (s?.kind === "audit" && !s.skipped) out.audit = s;
  }
  out.alarm = out.escalated || Boolean(out.audit && (out.audit.not_met || out.audit.collateral));
  return out;
};

export default function TurnWork({ steps = [], detail = null }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const work = turnWorkOf(steps);
  if (!work.simulations && !work.corrections && !work.audit && !work.escalated) return null;
  const parts = [
    work.simulations ? t("turnWork.simulations", { count: work.simulations }) : null,
    work.corrections ? t(work.resolved ? "turnWork.corrected" : "turnWork.corrections", { count: work.corrections }) : null,
    work.audit
      ? work.audit.not_met || work.audit.collateral
        ? t("turnWork.audit.problems", { not_met: work.audit.not_met || 0, collateral: work.audit.collateral || 0 })
        : work.audit.unclear
          ? t("turnWork.audit.unclear", { count: work.audit.unclear })
          : t("turnWork.audit.clean")
      : null,
    work.escalated ? t("turnWork.escalated") : null,
  ].filter(Boolean);
  const tone = work.alarm ? theme.palette.warning.main : theme.palette.text.secondary;
  const Icon = work.alarm ? ErrorOutlineRoundedIcon : TaskAltRoundedIcon;
  return (
    <Box data-testid="turn-work" data-alarm={work.alarm ? "true" : "false"} sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
      <ButtonBase onClick={() => setOpen((v) => !v)} aria-expanded={open ? "true" : "false"} data-testid="turn-work-toggle" sx={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 0.75, px: 1, py: 0.5, borderRadius: "8px", textAlign: "left", color: tone, backgroundColor: work.alarm ? alpha(theme.palette.warning.main, 0.1) : alpha(theme.palette.text.primary, 0.04), "&:hover": { backgroundColor: work.alarm ? alpha(theme.palette.warning.main, 0.16) : alpha(theme.palette.text.primary, 0.08) } }}>
        <Icon aria-hidden sx={{ fontSize: 16, color: work.alarm ? tone : theme.palette.success.main }} />
        <Typography component="span" sx={{ fontSize: "0.74rem", fontWeight: 600, color: "inherit" }}>
          {parts.join(" · ")}
        </Typography>
        <ExpandMoreIcon aria-hidden sx={{ fontSize: 16, transform: open ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
      </ButtonBase>
      {open && detail}
    </Box>
  );
}
