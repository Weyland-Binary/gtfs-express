import React, { useCallback, useId } from "react";
import {
  Box,
  Button,
  CircularProgress,
  LinearProgress,
  Typography,
  useTheme,
  alpha,
} from "@mui/material";
import BuildCircleOutlinedIcon from "@mui/icons-material/BuildCircleOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import EditIcon from "@mui/icons-material/Edit";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useFeatures } from "../../utils/featuresApi";
import { CHAT_OPEN_EVENT, OPEN_EXPORT_PREFLIGHT_EVENT } from "../../utils/appEvents";

/**
 * The validation page's repair banner: read-only with errors, the way into edit mode; editing, the progress against
 * the errors at load; none left after a rescue, the success. A refusal to enter edit mode is said by its context.
 */
function RescueBanner({
  severityCounts,
  baselineCounts,
  revalidating,
  onRevalidate,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { t } = useLanguage();
  // The progress sentence names the bar under it (a gauge, not "Loading").
  const progressId = useId();
  const { editing, entering, enterEditMode } = useEditMode();
  const { features } = useFeatures();

  const errorCount = severityCounts.error || 0;
  const baselineErrors = baselineCounts ? baselineCounts.errors || 0 : 0;
  const fixedCount = Math.max(0, baselineErrors - errorCount);

  // The chat's repair request is sent at once, the session context carrying the top findings.
  const aiEnabled = features?.chat?.enabled === true;
  const handleAiCta = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent(CHAT_OPEN_EVENT, {
        detail: { message: t("validation.rescue.aiPrompt") },
      }),
    );
  }, [t]);

  const handleFixCta = useCallback(async () => {
    await enterEditMode();
  }, [enterEditMode]);

  // Nothing to say: feed had no blocking errors and still has none.
  if (errorCount === 0 && baselineErrors === 0) return null;

  const revalidateButton = (
    <Button
      size="small"
      variant="text"
      onClick={onRevalidate}
      disabled={revalidating}
      data-testid="rescue-revalidate"
      startIcon={
        revalidating ? (
          <CircularProgress size={14} color="inherit" />
        ) : (
          <RefreshIcon sx={{ fontSize: 16 }} />
        )
      }
      sx={{
        textTransform: "none",
        fontWeight: 600,
        fontSize: "0.8rem",
        flexShrink: 0,
      }}
    >
      {revalidating
        ? t("validation.revalidate.running")
        : t("validation.revalidate.button")}
    </Button>
  );

  // ── Success: the feed became exportable in this session
  if (errorCount === 0) {
    const successColor = theme.palette.success.main;
    return (
      <Box
        data-testid="rescue-banner-success"
        sx={{
          flexShrink: 0,
          px: 2.5,
          py: 1.5,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          bgcolor: alpha(successColor, isDark ? 0.12 : 0.07),
          borderBottom: `1px solid ${alpha(successColor, 0.3)}`,
        }}
      >
        <CheckCircleOutlineIcon sx={{ fontSize: 22, color: successColor }} />
        <Typography
          variant="body2"
          sx={{ flex: 1, fontWeight: 600, color: "text.primary" }}
        >
          {t("validation.rescue.allFixed")}
        </Typography>
        {editing && (
          <Button
            size="small"
            variant="contained"
            color="success"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent(OPEN_EXPORT_PREFLIGHT_EVENT),
              )
            }
            sx={{
              textTransform: "none",
              fontWeight: 700,
              boxShadow: "none",
              "&:hover": { boxShadow: "none" },
            }}
          >
            {t("validation.rescue.exportCta")}
          </Button>
        )}
      </Box>
    );
  }

  const accent = theme.palette.severities
    ? theme.palette.severities.error.main
    : theme.palette.error.main;

  // ── Editing: the repair's progress
  if (editing) {
    const progress =
      baselineErrors > 0
        ? Math.min(100, Math.round((fixedCount / baselineErrors) * 100))
        : 0;
    return (
      <Box
        data-testid="rescue-banner-progress"
        sx={{
          flexShrink: 0,
          px: 2.5,
          py: 1.25,
          display: "flex",
          alignItems: "center",
          gap: 1.5,
          bgcolor: alpha(accent, isDark ? 0.08 : 0.04),
          borderBottom: `1px solid ${alpha(accent, 0.25)}`,
        }}
      >
        <BuildCircleOutlinedIcon sx={{ fontSize: 22, color: accent }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography id={progressId} variant="body2" sx={{ fontWeight: 600 }}>
            {baselineErrors > 0
              ? t("validation.rescue.progress", {
                  fixed: fixedCount,
                  total: baselineErrors,
                })
              : t("validation.rescue.remaining", { count: errorCount })}
          </Typography>
          {baselineErrors > 0 && (
            <LinearProgress
              variant="determinate"
              value={progress}
              aria-labelledby={progressId}
              color="success"
              sx={{
                mt: 0.5,
                height: 5,
                borderRadius: 3,
                bgcolor: alpha(accent, 0.15),
              }}
            />
          )}
        </Box>
        {aiEnabled && (
          <Button
            size="small"
            variant="contained"
            onClick={handleAiCta}
            data-testid="rescue-ai-cta"
            startIcon={<AutoAwesomeIcon sx={{ fontSize: 15 }} />}
            sx={{
              textTransform: "none",
              fontWeight: 700,
              borderRadius: 2,
              boxShadow: "none",
              flexShrink: 0,
              "&:hover": { boxShadow: "none" },
            }}
          >
            {t("validation.rescue.aiCta")}
          </Button>
        )}
        {revalidateButton}
      </Box>
    );
  }

  // ── Read-only: the way into edit mode
  return (
    <Box
      data-testid="rescue-banner-locked"
      sx={{
        flexShrink: 0,
        px: 2.5,
        py: 1.5,
        display: "flex",
        alignItems: "center",
        gap: 1.5,
        flexWrap: "wrap",
        bgcolor: alpha(accent, isDark ? 0.1 : 0.05),
        borderBottom: `1px solid ${alpha(accent, 0.3)}`,
      }}
    >
      <BuildCircleOutlinedIcon sx={{ fontSize: 24, color: accent }} />
      <Box sx={{ flex: 1, minWidth: 240 }}>
        <Typography variant="body2" sx={{ fontWeight: 700 }}>
          {t("validation.rescue.lockedTitle", { count: errorCount })}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t("validation.rescue.lockedBody2")}
        </Typography>
      </Box>
      <Button
        variant="contained"
        color="warning"
        onClick={handleFixCta}
        disabled={entering}
        data-testid="rescue-fix-cta"
        startIcon={
          entering ? (
            <CircularProgress size={14} color="inherit" />
          ) : (
            <EditIcon sx={{ fontSize: 16 }} />
          )
        }
        sx={{
          textTransform: "none",
          fontWeight: 700,
          borderRadius: 2,
          boxShadow: "none",
          flexShrink: 0,
          "&:hover": { boxShadow: "none" },
        }}
      >
        {t("validation.rescue.fixCta")}
      </Button>
      {/* No AI repair read-only: its prompt runs on the premium model and its apply would be blocked anyway. */}
    </Box>
  );
}

export default RescueBanner;
