/**
 * StepDesign — ③ Conception, the create job's design step.
 *
 * The Network Studio as a routed page: the same workbench as at
 * ① — the assistant's conversation (each turn opening with the engine's
 * verdict) or the work by hand on the left, the map, the lines, the stops
 * and, in expert mode, the JSON on the right — with `network-studio` on its
 * container. No full-screen dialog, no welcome card over the map, no
 * "ready" strips: the state is the rail's and the status bar's.
 *
 * Without the assistant (the server's chat off, or no Studio access) the
 * workbench's left column is the work by hand, not a disabled
 * composer: transform/ManualSidebar — the design's sub-tasks with their
 * states, the contract, the verdict re-measured on each edit, « Ouvrir
 * l'éditeur de lignes » (`plan-manual-start`) — while the right pane keeps
 * the map, the lines (the network's settings folded, their three required
 * fields labelled) and the stops. The flow builds that column
 * (NetworkStudio) and says it with `manual`; this page frames it.
 *
 * The primary action is "Vérifier la conception" (→ ④, the checks run on
 * arrival); `network-build` stays in the foot (the flow passes it), with its
 * one rule: it goes to ⑤, where the checks run by themselves and the build
 * follows when nothing is left to accept.
 */

import React from "react";
import { Box } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import StepFrame, { useFillLayout } from "./StepFrame";

export default function StepDesign({ workbench, manual = false, primary, back, footer = null, notice = null, frozen = null }) {
  const { t } = useLanguage();
  // On a desktop screen the workbench takes the step's height — never less than a usable map: below that, the body scrolls.
  const fill = useFillLayout();
  return (
    <StepFrame step={3} job="create" intro={t(manual ? "step.3.intro.createManual" : "step.3.intro.create")} notice={notice || frozen} primary={primary} back={back} footer={footer} testid="step-design" headless bodySx={fill ? { overflowY: "hidden" } : {}}>
      <Box sx={{ flex: 1, minHeight: fill ? 0 : "auto", display: "flex", flexDirection: "column" }}>{workbench}</Box>
    </StepFrame>
  );
}
