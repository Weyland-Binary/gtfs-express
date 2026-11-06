import React from "react";
import { Box, ButtonBase, CircularProgress, IconButton, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import ErrorRoundedIcon from "@mui/icons-material/ErrorRounded";
import VerifiedRoundedIcon from "@mui/icons-material/VerifiedRounded";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useLanguage } from "../../contexts/LanguageContext";
import { countWords } from "../../utils/countWords";

const SEVERITIES = [
  { key: "error", icon: ErrorOutlineIcon, labelKey: "validation.severity.errors" },
  { key: "warning", icon: WarningAmberIcon, labelKey: "validation.severity.warnings" },
  { key: "info", icon: InfoOutlinedIcon, labelKey: "validation.severity.infos" },
];

/**
 * The report's head: the verdict, each severity's share, and one pill per severity that doubles as its filter
 * (a click hides its findings; an empty severity cannot be pressed). Colours from theme.palette (#19).
 */
export default function ValidationSummary({ severityCounts, ruleCounts = {}, severityFilter, onToggleSeverity, actions = null, onRevalidate = null, revalidating = false }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const isDark = theme.palette.mode === "dark";
  const errors = severityCounts.error || 0;
  const total = SEVERITIES.reduce((n, s) => n + (severityCounts[s.key] || 0), 0);
  const verdictTone = errors ? theme.palette.severities.error.main : theme.palette.success.main;
  const VerdictIcon = errors ? ErrorRoundedIcon : VerifiedRoundedIcon;
  const toneOf = (key) => (theme.palette.severities[key] || theme.palette.severities.error).main;
  return (
    <Box
      data-testid="validation-summary"
      data-verdict={errors ? "errors" : "clear"}
      sx={{
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: { xs: 2, md: 3 },
        px: { xs: 2, md: 3 },
        py: 2,
        borderRadius: "14px",
        border: `1px solid ${theme.palette.divider}`,
        backgroundColor: theme.palette.background.paper,
        boxShadow: `0 1px 2px ${alpha(theme.palette.common.black, isDark ? 0.4 : 0.05)}`,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1.75, minWidth: 0, flex: "1 1 320px" }}>
        <Box aria-hidden sx={{ width: 48, height: 48, flexShrink: 0, borderRadius: "14px", display: "flex", alignItems: "center", justifyContent: "center", color: verdictTone, backgroundColor: alpha(verdictTone, isDark ? 0.2 : 0.1) }}>
          <VerdictIcon sx={{ fontSize: 28 }} />
        </Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography component="h2" data-testid="validation-verdict" sx={{ fontSize: "1.12rem", fontWeight: 750, letterSpacing: "-0.01em", lineHeight: 1.3, color: errors ? verdictTone : "text.primary" }}>
            {errors ? countWords(t, "validation.verdict.errors", errors) : t("validation.verdict.clear")}
          </Typography>
          <Typography sx={{ mt: 0.25, fontSize: "0.8rem", color: "text.secondary" }}>{t("validation.verdict.by")}</Typography>
          {total > 0 && (
            <Box aria-hidden data-testid="validation-share" sx={{ mt: 1, display: "flex", height: 6, maxWidth: 420, borderRadius: 3, overflow: "hidden", backgroundColor: alpha(theme.palette.text.primary, 0.06) }}>
              {SEVERITIES.map(({ key }) => {
                const n = severityCounts[key] || 0;
                return n ? <Box key={key} sx={{ width: `${(n / total) * 100}%`, minWidth: 4, backgroundColor: toneOf(key), opacity: severityFilter.has(key) ? 1 : 0.3, transition: "opacity 200ms" }} /> : null;
              })}
            </Box>
          )}
        </Box>
      </Box>

      <Box role="group" aria-label={t("validation.verdict.filters")} sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        {SEVERITIES.map(({ key, icon: Icon, labelKey }) => {
          const count = severityCounts[key] || 0;
          const rules = ruleCounts[key] || 0;
          const none = count === 0;
          const on = !none && severityFilter.has(key);
          const tone = none ? theme.palette.success.main : toneOf(key);
          return (
            <ButtonBase
              key={key}
              data-testid={`validation-tile-${key}`}
              data-active={on ? "true" : "false"}
              aria-pressed={none ? undefined : on}
              aria-label={`${t(labelKey)} ${count}`}
              disabled={none}
              onClick={() => onToggleSeverity(key)}
              sx={{
                height: 52,
                pl: 1,
                pr: 1.75,
                gap: 1.1,
                borderRadius: "12px",
                textAlign: "left",
                border: `1px solid ${on ? alpha(tone, 0.4) : theme.palette.divider}`,
                backgroundColor: on ? alpha(tone, isDark ? 0.14 : 0.06) : "transparent",
                "& > *": { opacity: none || on ? 1 : 0.45, transition: "opacity 200ms" },
                transition: "background-color 150ms, border-color 150ms",
                "&:hover": none ? undefined : { backgroundColor: alpha(tone, isDark ? 0.2 : 0.1) },
                "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 2 },
              }}
            >
              <Box aria-hidden sx={{ width: 34, height: 34, borderRadius: "10px", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: tone, backgroundColor: alpha(tone, isDark ? 0.2 : 0.1) }}>
                {none ? <CheckRoundedIcon sx={{ fontSize: 19 }} /> : <Icon sx={{ fontSize: 19 }} />}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography noWrap sx={{ fontSize: "1.15rem", fontWeight: 750, letterSpacing: "-0.02em", lineHeight: 1.15, fontVariantNumeric: "tabular-nums", color: tone }}>
                  {count.toLocaleString()}
                </Typography>
                <Typography noWrap sx={{ fontSize: "0.72rem", color: "text.secondary" }}>
                  {t(labelKey)} · {none ? t("validation.summary.none") : countWords(t, "validation.summary.rules", rules)}
                </Typography>
              </Box>
            </ButtonBase>
          );
        })}
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 1, flexWrap: "wrap", ml: { lg: "auto" } }}>
        {onRevalidate && (
          <Tooltip title={t(revalidating ? "validation.revalidate.running" : "validation.revalidate.button")}>
            <span>
              <IconButton onClick={onRevalidate} disabled={revalidating} aria-label={t("validation.revalidate.button")} data-testid="validation-revalidate" sx={{ width: 34, height: 34, borderRadius: "8px", border: `1px solid ${theme.palette.divider}`, color: "text.secondary", "&:hover": { color: "text.primary", backgroundColor: theme.palette.action.hover } }}>
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
