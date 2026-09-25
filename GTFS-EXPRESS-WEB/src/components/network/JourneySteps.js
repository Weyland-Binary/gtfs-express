/**
 * JourneySteps — where the user is in creating a network: the territory,
 * the specification, the design, the projection into the application.
 * Each step says whether it is done, current or still ahead, and takes the
 * user to the place where it happens.
 */

import React from "react";
import { Box, ButtonBase, Typography, alpha, useTheme } from "@mui/material";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import { useLanguage } from "../../contexts/LanguageContext";

export const JOURNEY = ["territory", "brief", "design", "projection"];

export default function JourneySteps({ done = {}, onStep }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const current = JOURNEY.findIndex((s) => !done[s]);
  return (
    <Box component="nav" aria-label={t("network.journey.label")} data-testid="network-journey" sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
      {JOURNEY.map((s, i) => {
        const isDone = Boolean(done[s]);
        const isNow = i === current;
        const color = isDone ? theme.palette.success.main : isNow ? theme.palette.primary.main : theme.palette.text.disabled;
        return (
          <React.Fragment key={s}>
            {i > 0 && <Box sx={{ width: 18, height: 2, borderRadius: 1, background: isDone || isNow ? alpha(color, 0.45) : alpha(theme.palette.text.primary, 0.12) }} />}
            <ButtonBase
              onClick={() => onStep && onStep(s)}
              data-testid={`journey-${s}`}
              data-state={isDone ? "done" : isNow ? "current" : "todo"}
              aria-current={isNow ? "step" : undefined}
              sx={{ display: "flex", alignItems: "center", gap: 0.6, px: 0.9, py: 0.45, borderRadius: 99, background: isNow ? alpha(color, theme.palette.mode === "dark" ? 0.18 : 0.1) : "transparent", transition: "background 120ms", "&:hover": { background: alpha(color, 0.14) } }}
            >
              <Box sx={{ width: 18, height: 18, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.64rem", fontWeight: 800, color: isDone ? "#fff" : color, background: isDone ? color : "transparent", border: isDone ? "none" : `1.5px solid ${color}` }}>
                {isDone ? <CheckRoundedIcon sx={{ fontSize: 13 }} /> : i + 1}
              </Box>
              <Typography component="span" sx={{ fontSize: "0.74rem", fontWeight: isNow ? 700 : 600, color: isNow ? "text.primary" : "text.secondary", whiteSpace: "nowrap" }}>
                {t(`network.journey.${s}`)}
              </Typography>
            </ButtonBase>
          </React.Fragment>
        );
      })}
    </Box>
  );
}
