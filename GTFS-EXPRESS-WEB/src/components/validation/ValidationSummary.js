import React from "react";
import { Box, ButtonBase, CircularProgress, IconButton, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useLanguage } from "../../contexts/LanguageContext";
import { countWords } from "../../utils/countWords";

const SEVERITIES = [
  { key: "error", icon: ErrorOutlineIcon, labelKey: "validation.severity.errors" },
  { key: "warning", icon: WarningAmberIcon, labelKey: "validation.severity.warnings" },
  { key: "info", icon: InfoOutlinedIcon, labelKey: "validation.severity.infos" },
];

/**
 * The report's head, in the overview's figures strip: equal cells edge to edge, a hairline between them, each
 * severity's icon on a light tint of its colour, its count of findings in its colour above its name and its rules.
 * A cell doubles as the severity filter (every severity shown at first; a click leaves its findings out, its cell
 * faded); a severity with nothing says so in green. The last cell holds « Revalider » (a quiet icon, `onRevalidate`)
 * and the report's acts (`actions`). Colours from theme.palette (rule #19).
 */
export default function ValidationSummary({ severityCounts, ruleCounts = {}, severityFilter, onToggleSeverity, actions = null, onRevalidate = null, revalidating = false }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const isDark = theme.palette.mode === "dark";
  const hairline = `1px solid ${theme.palette.divider}`;
  return (
    <Box
      data-testid="validation-summary"
      sx={{
        backgroundColor: theme.palette.background.paper,
        borderBottom: hairline,
        flexShrink: 0,
        display: "grid",
        gridTemplateColumns: { xs: "repeat(3, minmax(0, 1fr))", lg: "repeat(3, minmax(0, 1fr)) minmax(max-content, 1.4fr)" },
        "& > *": { px: { xs: 2, md: 3 }, py: 1.25, minWidth: 0 },
        "& > * + *": { borderLeft: hairline },
      }}
    >
      {SEVERITIES.map(({ key, icon: Icon, labelKey }, i) => {
        const count = severityCounts[key] || 0;
        const rules = ruleCounts[key] || 0;
        const none = count === 0;
        const on = !none && severityFilter.has(key);
        const tone = none ? theme.palette.success.main : (theme.palette.severities[key] || theme.palette.severities.error).main;
        return (
          <ButtonBase
            key={key}
            data-testid={`validation-tile-${key}`}
            data-active={on ? "true" : "false"}
            aria-pressed={none ? undefined : on}
            aria-label={`${t(labelKey)} ${count}`}
            disabled={none}
            onClick={() => onToggleSeverity(key)}
            // ButtonBase resets its border and padding: the strip's hairline and spacing are set on the cell itself.
            sx={{
              px: { xs: 2, md: 3 },
              py: 1.25,
              borderLeft: i > 0 ? hairline : "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              gap: 1.5,
              textAlign: "left",
              borderRadius: 0,
              "& > *": { opacity: none || on ? 1 : 0.4, transition: "opacity 200ms" },
              transition: "background-color 150ms",
              "&:hover": none ? undefined : { backgroundColor: alpha(tone, isDark ? 0.08 : 0.04) },
              "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
            }}
          >
            <Box aria-hidden sx={{ width: 36, height: 36, borderRadius: "10px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: tone, backgroundColor: alpha(tone, isDark ? 0.18 : 0.08) }}>
              {none ? <CheckRoundedIcon sx={{ fontSize: 19 }} /> : <Icon sx={{ fontSize: 19 }} />}
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography noWrap sx={{ fontSize: "1.45rem", fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.2, fontVariantNumeric: "tabular-nums", color: tone }}>
                {count.toLocaleString()}
              </Typography>
              <Typography noWrap sx={{ fontSize: "0.76rem", color: "text.secondary", mt: 0.25 }}>
                {t(labelKey)} · {none ? t("validation.summary.none") : countWords(t, "validation.summary.rules", rules)}
              </Typography>
            </Box>
          </ButtonBase>
        );
      })}
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 1, flexWrap: "wrap", gridColumn: { xs: "1 / -1", lg: "auto" }, borderTop: { xs: hairline, lg: "none" } }}>
        {onRevalidate && (
          <Tooltip title={t(revalidating ? "validation.revalidate.running" : "validation.revalidate.button")}>
            <span>
              <IconButton onClick={onRevalidate} disabled={revalidating} aria-label={t("validation.revalidate.button")} data-testid="validation-revalidate" sx={{ width: 34, height: 34, borderRadius: "8px", border: hairline, color: "text.secondary", "&:hover": { color: "text.primary", backgroundColor: theme.palette.action.hover } }}>
                {revalidating ? <CircularProgress size={15} thickness={5} /> : <RefreshIcon sx={{ fontSize: 18 }} />}
              </IconButton>
            </span>
          </Tooltip>
        )}
        {actions}
      </Box>
    </Box>
  );
}
