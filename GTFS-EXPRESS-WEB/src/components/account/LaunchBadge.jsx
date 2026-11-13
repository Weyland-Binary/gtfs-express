/** The launch price's badge on the licence's card: the offer, Home and the phone's Home show the same one. */

import React from "react";
import { Box, alpha, useTheme } from "@mui/material";
import RocketLaunchOutlinedIcon from "@mui/icons-material/RocketLaunchOutlined";
import { useLanguage } from "../../contexts/LanguageContext";

export default function LaunchBadge({ testId, sx }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const dark = theme.palette.mode === "dark";
  const green = theme.palette.success.main;
  // The dark theme's green reads under 4.5:1 on its own tint: its lighter one does (5:1 on the cards).
  const ink = dark ? theme.palette.success.light : green;
  return (
    <Box
      component="span"
      data-testid={testId}
      sx={{ display: "inline-flex", alignItems: "center", gap: 0.6, flexShrink: 0, height: 26, px: 1.1, borderRadius: 999, fontSize: "0.78rem", fontWeight: 700, lineHeight: 1, whiteSpace: "nowrap", color: ink, backgroundColor: alpha(green, dark ? 0.14 : 0.1), border: `1px solid ${alpha(green, dark ? 0.45 : 0.3)}`, ...sx }}
    >
      <RocketLaunchOutlinedIcon aria-hidden sx={{ fontSize: 15 }} />
      {t("licence.launchBadge")}
    </Box>
  );
}
