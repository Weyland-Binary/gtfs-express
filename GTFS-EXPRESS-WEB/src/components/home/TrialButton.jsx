// Home's way to the licence beside the demo: shown under the paid offer to whoever does not hold the licence yet.

import React from "react";
import { ButtonBase } from "@mui/material";
import WorkspacePremiumOutlinedIcon from "@mui/icons-material/WorkspacePremiumOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { licenceLockOf, openPaywall, useFeatures } from "../../utils/featuresApi";
import { trackUi } from "../../utils/uiTelemetry";

export default function TrialButton({ sx }) {
  const { t } = useLanguage();
  const { features } = useFeatures();
  const lock = licenceLockOf(features?.access);
  if (lock !== "sign_in_required" && lock !== "subscription_required") return null;
  const days = features?.access?.billing?.trial_days || 0;
  return (
    <ButtonBase
      onClick={() => {
        trackUi("trial.click", "home");
        openPaywall("studio", lock);
      }}
      data-testid="home-trial"
      sx={sx}
    >
      <WorkspacePremiumOutlinedIcon sx={{ fontSize: 20 }} />
      {days > 0 ? t("home.trial", { days }) : t("home.trialNoDays")}
    </ButtonBase>
  );
}
