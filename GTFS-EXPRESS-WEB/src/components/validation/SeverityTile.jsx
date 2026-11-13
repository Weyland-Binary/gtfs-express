import React from "react";
import { Box, alpha, useTheme } from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";

const ICONS = { error: ErrorOutlineIcon, warning: WarningAmberIcon, info: InfoOutlinedIcon, ok: CheckRoundedIcon };

export const severityTone = (theme, sev) => (sev === "ok" ? theme.palette.success.main : (theme.palette.severities[sev] || theme.palette.severities.error).main);

/** A severity's icon on its own tint, as the overview draws its figures. */
export default function SeverityTile({ severity, size = 32, radius = "9px", icon = null }) {
  const theme = useTheme();
  const tone = severityTone(theme, severity);
  const Icon = icon || ICONS[severity] || ErrorOutlineIcon;
  return (
    <Box aria-hidden sx={{ width: size, height: size, flexShrink: 0, borderRadius: radius, display: "flex", alignItems: "center", justifyContent: "center", color: tone, bgcolor: alpha(tone, theme.palette.mode === "dark" ? 0.2 : 0.1) }}>
      <Icon sx={{ fontSize: Math.round(size * 0.56) }} />
    </Box>
  );
}
