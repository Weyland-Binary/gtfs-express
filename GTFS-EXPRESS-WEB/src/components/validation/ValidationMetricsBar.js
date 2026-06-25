import React from "react";
import { Box, Typography, useTheme, alpha } from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { useLanguage } from "../../contexts/LanguageContext";

const SEVERITIES = [
  { key: "error", icon: ErrorOutlineIcon, labelKey: "validation.severity.errors" },
  { key: "warning", icon: WarningAmberIcon, labelKey: "validation.severity.warnings" },
  { key: "info", icon: InfoOutlinedIcon, labelKey: "validation.severity.infos" },
];

/**
 * Compact severity stats, doubling as filters: a row of pill toggles
 * (count + label, severity-tinted when active). Colours come from
 * theme.palette.severities — never hardcoded (rule #19).
 */
function ValidationMetricsBar({ severityCounts, severityFilter, onToggleSeverity }) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { t } = useLanguage();

  return (
    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
      {SEVERITIES.filter(({ key }) => severityCounts[key] > 0).map(
        ({ key, icon: Icon, labelKey }) => {
          const isActive = severityFilter.has(key);
          const color = (
            theme.palette.severities[key] || theme.palette.severities.error
          ).main;
          return (
            <Box
              key={key}
              role="button"
              tabIndex={0}
              aria-pressed={isActive}
              onClick={() => onToggleSeverity(key)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggleSeverity(key);
                }
              }}
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 0.75,
                px: 1.5,
                height: 34,
                borderRadius: 5,
                cursor: "pointer",
                userSelect: "none",
                outline: "none",
                border: `1px solid ${
                  isActive ? alpha(color, 0.45) : theme.palette.divider
                }`,
                bgcolor: isActive
                  ? alpha(color, isDark ? 0.12 : 0.06)
                  : "background.paper",
                opacity: isActive ? 1 : 0.55,
                transition: "all 0.15s ease",
                "&:hover": { opacity: 1, borderColor: alpha(color, 0.5) },
                "&:focus-visible": { outline: `2px solid ${color}`, outlineOffset: 1 },
              }}
            >
              <Icon sx={{ fontSize: 15, color }} />
              <Typography
                sx={{
                  fontWeight: 700,
                  fontSize: "0.85rem",
                  color: isActive ? color : "text.secondary",
                  lineHeight: 1,
                }}
              >
                {severityCounts[key]}
              </Typography>
              <Typography
                variant="caption"
                sx={{
                  fontWeight: 600,
                  fontSize: "0.74rem",
                  color: isActive ? "text.primary" : "text.secondary",
                  lineHeight: 1,
                }}
              >
                {t(labelKey)}
              </Typography>
            </Box>
          );
        },
      )}
    </Box>
  );
}

export default ValidationMetricsBar;
