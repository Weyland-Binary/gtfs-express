import React from "react";
import {
  Box,
  Typography,
  Button,
  IconButton,
  Tooltip,
  useTheme,
  alpha,
} from "@mui/material";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import CircularProgress from "@mui/material/CircularProgress";
import { useLanguage } from "../../contexts/LanguageContext";

/**
 * Slim report header: status + one-line summary on the left, the two
 * global actions (re-validate, re-upload) on the right. No view toggle —
 * the report has a single, rule-grouped organisation.
 */
function ValidationToolbar({
  onReupload,
  onBack,
  totalFindings,
  ruleCount,
  filteredTotal,
  severityCounts,
  statusColor,
  onRevalidate,
  revalidating,
}) {
  const theme = useTheme();
  const { t } = useLanguage();

  const StatusIcon =
    severityCounts.error > 0
      ? ErrorOutlineIcon
      : severityCounts.warning > 0
        ? WarningAmberIcon
        : CheckCircleOutlineIcon;

  const titleText =
    severityCounts.error > 0
      ? t("validation.status.failed")
      : severityCounts.warning > 0
        ? t("validation.status.warnings")
        : t("validation.status.ok");

  const actionSx = {
    textTransform: "none",
    fontWeight: 600,
    borderRadius: 5,
    px: 1.75,
    fontSize: "0.8rem",
    color: "text.secondary",
    "&:hover": {
      color: theme.palette.primary.main,
      bgcolor: alpha(theme.palette.primary.main, 0.05),
    },
  };

  return (
    <Box
      sx={{
        flexShrink: 0,
        px: 2,
        height: 52,
        display: "flex",
        alignItems: "center",
        gap: 1,
        borderBottom: `1px solid ${theme.palette.divider}`,
        bgcolor: "background.paper",
      }}
    >
      {onBack && (
        <Tooltip title={t("app.back")} arrow>
          <IconButton onClick={onBack} size="small" sx={{ color: "text.secondary" }}>
            <ArrowBackIcon sx={{ fontSize: 19 }} />
          </IconButton>
        </Tooltip>
      )}

      <StatusIcon sx={{ fontSize: 20, color: statusColor, flexShrink: 0 }} />
      <Box sx={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 1 }}>
        <Typography
          sx={{
            fontWeight: 600,
            fontSize: "0.95rem",
            letterSpacing: "-0.01em",
            whiteSpace: "nowrap",
          }}
        >
          {titleText}
        </Typography>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {t("validation.header.summary", {
            findings: totalFindings,
            rules: ruleCount,
          })}
          {filteredTotal !== totalFindings &&
            ` · ${t("validation.header.showing", { count: filteredTotal })}`}
        </Typography>
      </Box>

      {onRevalidate && (
        <Button
          variant="text"
          startIcon={
            revalidating ? (
              <CircularProgress size={14} color="inherit" />
            ) : (
              <RefreshIcon sx={{ fontSize: 16 }} />
            )
          }
          onClick={onRevalidate}
          disabled={revalidating}
          size="small"
          data-testid="validation-revalidate"
          sx={actionSx}
        >
          {revalidating
            ? t("validation.revalidate.running")
            : t("validation.revalidate.button")}
        </Button>
      )}

      <Button
        variant="text"
        startIcon={<CloudUploadOutlinedIcon sx={{ fontSize: 16 }} />}
        onClick={onReupload}
        size="small"
        sx={actionSx}
      >
        {t("validation.header.reupload")}
      </Button>
    </Box>
  );
}

export default ValidationToolbar;
