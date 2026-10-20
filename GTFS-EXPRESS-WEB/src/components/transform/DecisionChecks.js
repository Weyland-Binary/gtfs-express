/**
 * DecisionChecks — the checks folded under the draft's decision (ChangeStudio → DecisionScreen `checksNode`): the
 * notices, the recap of the change, the coherence report of the simulation (before → after, or the comparison kept
 * with the frozen scenario), then two tabs — the canonical validator's run on the simulation, and the changes it
 * makes with the working copy's own edits since the version (DraftRetouches). A frozen scenario is never simulated
 * again: the validator's re-run and the report's « simulate again » are closed on it.
 */

import React, { useState } from "react";
import { Box, Tab, Tabs, Typography, useTheme } from "@mui/material";
import CompareArrowsIcon from "@mui/icons-material/CompareArrows";
import FactCheckOutlinedIcon from "@mui/icons-material/FactCheckOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import CoherenceReport from "../common/CoherenceReport";
import { ChangesPanel, ChecksPanel } from "./ChangePlanParts";
import DraftRetouches from "./DraftRetouches";
import ChangeRecap from "./ChangeRecap";

const tabSx = { minHeight: 40, textTransform: "none", fontWeight: 600, fontSize: "0.8rem", px: 1.25 };

/**
 * `coherence`: { source, note, exportSource, labels } (CoherenceReport's); `recapPreview`: the simulation the recap
 * reads (once applied, the one the scenario kept); `onSimulate(validate)`: simulate again (null once frozen).
 */
export default function DecisionChecks({ notices = null, plan, preview, recapPreview, catalogue, validating, seconds, frozen, coherence, onRecover, retouchEdit, onSimulate }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const [tab, setTab] = useState("checks");
  return (
    <Box data-testid="delivery-checks-body" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      {/* The applied scenario is said once, by the act's result (change-applied). */}
      {notices}
      <ChangeRecap plan={plan} preview={recapPreview} catalogue={catalogue} validating={validating} seconds={seconds} applied={frozen ? frozen.n : null} />
      <CoherenceReport source={coherence.source} pending={t("coherence.waiting.modify")} note={coherence.note} onResimulate={frozen || !onSimulate ? null : () => onSimulate(false)} onResume={onRecover} exportSource={coherence.exportSource} labels={coherence.labels} />
      <Tabs value={tab} onChange={(_, value) => setTab(value)} sx={{ minHeight: 40, borderBottom: `1px solid ${theme.palette.divider}`, "& .MuiTab-root": tabSx }}>
        <Tab value="checks" icon={<FactCheckOutlinedIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={t("step.4.tab.validator")} data-testid="change-tab-checks" />
        <Tab value="changes" icon={<CompareArrowsIcon sx={{ fontSize: 16 }} />} iconPosition="start" label={`${t("transform.tab.changes")}${preview?.diff?.items?.length ? ` (${preview.diff.items.length})` : ""}`} data-testid="change-tab-changes" />
      </Tabs>
      {tab === "changes" ? (
        <>
          <ChangesPanel preview={preview} plan={plan} />
          <DraftRetouches testid="delivery-retouches" edit={retouchEdit} />
        </>
      ) : (
        <Box data-testid="validation-panel">
          {validating && (
            <Typography data-testid="validation-running" sx={{ fontSize: "0.8rem", color: "text.secondary", mb: 0.5 }}>
              {t("gtfsCheck.running", { seconds })}
            </Typography>
          )}
          <ChecksPanel preview={preview} validating={validating} frozen={Boolean(frozen)} onValidate={() => (frozen || !onSimulate ? null : onSimulate(true))} />
        </Box>
      )}
    </Box>
  );
}
