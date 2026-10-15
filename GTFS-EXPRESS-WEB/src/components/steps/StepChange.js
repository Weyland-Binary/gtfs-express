/**
 * StepChange — ③ Changement, the modify job's change step.
 *
 * The Change Studio as a routed page (`change-studio` on its container): the brief and the conversation with the change planner on the
 * left (or the catalogue by hand), the operations on the right — the
 * scenario switcher on top (ScenarioSwitcher), the tabs Operations · Map —
 * and the status line `change-status` in the foot, the compact verdict then
 * the next thing to do. The primary action is "Simuler et vérifier" (→ ④):
 * disabled, with its reason, while an operation waits for an answer or
 * failed.
 *
 * Without the assistant (the server's chat off, or no Studio access) the
 * left column is not a disabled composer but the work by hand
 * (`sidebar`: transform/ManualSidebar — the catalogue of operations as the
 * column itself, the verdict, the contract, the documents to cite); the
 * operations, the switcher and the primary action stay the same.
 *
 * Once the scenario is applied it is frozen "applied in vN": a
 * banner says it (`change-applied`), its operations are read only, and the
 * step offers "Nouveau scénario sur vN" (`scenario-new-from-version`, the
 * primary action then) and "Annuler l'application" — never a second
 * simulation of the same operations on vN, which would apply them twice.
 */

import React from "react";
import { Alert, Box, Button, useMediaQuery, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import StepFrame, { useFillLayout } from "./StepFrame";

/** The frozen scenario's banner (also shown in ⑤'s result). */
export function AppliedBanner({ n, onUndo = null, undoing = false, sx = {} }) {
  const { t } = useLanguage();
  return (
    <Alert
      severity="success"
      data-testid="change-applied"
      data-version={n}
      action={
        onUndo ? (
          <Button color="inherit" size="small" onClick={onUndo} disabled={undoing} data-testid="change-apply-undo-action" sx={{ textTransform: "none", fontWeight: 700 }}>
            {t("delivery.undoApply")}
          </Button>
        ) : null
      }
      sx={{ fontSize: "0.8rem", alignItems: "center", ...sx }}
    >
      {t("scenario.applied.banner", { n })}
    </Alert>
  );
}

/** `bench`: the desktop workbench (the Change Studio builds it: its column, the map, the plan) in place of the two panes. */
export default function StepChange({ conversation, sidebar = null, pane, primary, back, footer = null, notice = null, frozen = null, bench = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const narrow = useMediaQuery(theme.breakpoints.down("md"));
  // On a desktop screen the studio fills the step's height: its column and its pane scroll on their own.
  const fill = useFillLayout();
  if (bench) {
    return (
      <StepFrame step={3} job="modify" intro={t("step.3.intro.modify")} notice={notice || (frozen ? <AppliedBanner n={frozen.n} onUndo={frozen.onUndo} undoing={frozen.undoing} /> : null)} primary={primary} back={back} footer={footer} testid="step-change" headless bodySx={fill ? { overflowY: "hidden" } : {}}>
        <Box sx={{ flex: 1, minHeight: fill ? 0 : "auto", display: "flex", flexDirection: "column" }}>{bench}</Box>
      </StepFrame>
    );
  }
  return (
    <StepFrame step={3} job="modify" intro={t("step.3.intro.modify")} notice={notice} primary={primary} back={back} footer={footer} testid="step-change">
      {frozen && <AppliedBanner n={frozen.n} onUndo={frozen.onUndo} undoing={frozen.undoing} sx={{ mb: 1 }} />}
      <Box data-testid="change-studio" data-frozen={frozen ? "true" : "false"} sx={{ flex: 1, minHeight: narrow ? "auto" : fill ? 420 : 520, display: "flex", flexDirection: narrow ? "column" : "row", border: `1px solid ${theme.palette.divider}`, borderRadius: "12px", overflow: "hidden", background: theme.palette.background.default }}>
        <Box sx={{ width: narrow ? "100%" : { md: 330, lg: 360, xl: 400 }, flexShrink: 0, borderRight: narrow ? "none" : `1px solid ${theme.palette.divider}`, borderBottom: narrow ? `1px solid ${theme.palette.divider}` : "none", background: theme.palette.background.paper, minHeight: narrow ? 320 : 0, maxHeight: narrow ? "60vh" : "none", display: "flex", flexDirection: "column" }} data-manual={sidebar ? "true" : "false"}>{sidebar || conversation}</Box>
        <Box sx={{ flex: 1, minWidth: 0, minHeight: narrow ? 480 : 0, display: "flex", flexDirection: "column" }}>{pane}</Box>
      </Box>
    </StepFrame>
  );
}
