import React, { useState } from "react";
import {
  Box,
  Typography,
  Chip,
  Tooltip,
  IconButton,
  Button,
  Collapse,
  useTheme,
  alpha,
} from "@mui/material";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import { useLanguage } from "../../contexts/LanguageContext";
import { getRuleTitle, getRuleDocUrl } from "./ruleCatalog";
import RuleOccurrenceTable from "./RuleOccurrenceTable";
import QuickFixDialog from "./QuickFixDialog";
import FixInSqlConsoleButton from "./FixInSqlConsoleButton";
import AskAiFixButton from "./AskAiFixButton";

const MONOSPACE = '"JetBrains Mono", "Fira Code", monospace';

/**
 * One flat row of the rule list (no card chrome — the parent owns the
 * border). Header: severity dot · rule code · title · actions · count ·
 * chevron. Expanded: the occurrence table showing exactly the fields the
 * canonical engine returned for this rule.
 */
function RuleGroupCard({
  ruleCode,
  occurrences,
  isExpanded,
  onToggle,
  cardRef,
  quickFixCount = 0,
  isLast = false,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { t } = useLanguage();
  const [quickFixOpen, setQuickFixOpen] = useState(false);

  // Dominant severity = worst severity present in occurrences
  const dominantSev = occurrences.some(
    (o) => (o.severity || "error") === "error",
  )
    ? "error"
    : occurrences.some((o) => o.severity === "warning")
      ? "warning"
      : "info";
  const accentColor = (
    theme.palette.severities[dominantSev] || theme.palette.severities.error
  ).main;

  const title = getRuleTitle(ruleCode);
  const docUrl = getRuleDocUrl(ruleCode);

  const handleDocClick = (e) => {
    e.stopPropagation();
    window.open(docUrl, "_blank", "noopener,noreferrer");
  };

  const handleQuickFixClick = (e) => {
    e.stopPropagation();
    setQuickFixOpen(true);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle();
    } else if (e.key === "ArrowRight" && !isExpanded) {
      onToggle();
    } else if (e.key === "ArrowLeft" && isExpanded) {
      onToggle();
    }
  };

  return (
    <>
      <Box
        ref={cardRef}
        sx={{
          borderBottom:
            isLast && !isExpanded
              ? "none"
              : `1px solid ${theme.palette.divider}`,
        }}
      >
        {/* Header row */}
        <Box
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onClick={onToggle}
          onKeyDown={handleKeyDown}
          sx={{
            px: 2,
            minHeight: 46,
            py: 0.5,
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 1.25,
            cursor: "pointer",
            userSelect: "none",
            outline: "none",
            bgcolor: isExpanded
              ? alpha(accentColor, isDark ? 0.07 : 0.035)
              : "transparent",
            transition: "background 0.15s",
            "&:hover": { bgcolor: alpha(accentColor, isDark ? 0.09 : 0.05) },
            "&:focus-visible": {
              outline: `2px solid ${accentColor}`,
              outlineOffset: -2,
            },
          }}
        >
          {/* Severity dot */}
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              bgcolor: accentColor,
              flexShrink: 0,
            }}
          />

          {/* ruleCode monospace */}
          {ruleCode !== "__ungrouped__" && (
            <Typography
              component="span"
              sx={{
                fontFamily: MONOSPACE,
                fontWeight: 700,
                fontSize: "0.78rem",
                color: "text.primary",
                flexShrink: 0,
              }}
            >
              {ruleCode}
            </Typography>
          )}

          {/* Human-readable title */}
          <Typography
            variant="body2"
            sx={{
              fontWeight: ruleCode === "__ungrouped__" ? 600 : 400,
              fontSize: "0.82rem",
              color:
                ruleCode === "__ungrouped__" ? "text.primary" : "text.secondary",
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {title}
          </Typography>

          {/* Quick Fix — only when edit mode is on AND the rule has
              auto-fixable rows */}
          {quickFixCount > 0 && ruleCode !== "__ungrouped__" && (
            <Tooltip title={t("quickFix.tooltip", { count: quickFixCount })} arrow>
              <Button
                size="small"
                variant="contained"
                color="success"
                startIcon={<AutoFixHighIcon sx={{ fontSize: 14 }} />}
                onClick={handleQuickFixClick}
                sx={{
                  flexShrink: 0,
                  height: 26,
                  px: 1.25,
                  fontSize: "0.72rem",
                  fontWeight: 700,
                  textTransform: "none",
                  borderRadius: 5,
                  boxShadow: "none",
                  "&:hover": { boxShadow: "none" },
                }}
              >
                {t("quickFix.button", { count: quickFixCount })}
              </Button>
            </Tooltip>
          )}

          {/* Bulk fix via SQL Console — only for editable rules with >=2 IDs */}
          {ruleCode !== "__ungrouped__" && (
            <FixInSqlConsoleButton ruleCode={ruleCode} occurrences={occurrences} />
          )}

          {/* AI fix-it — on every rule while editing (Quick Fix, when
              available, stays the first suggestion in the row) */}
          {ruleCode !== "__ungrouped__" && (
            <AskAiFixButton ruleCode={ruleCode} occurrences={occurrences} />
          )}

          {/* Count */}
          <Chip
            size="small"
            label={occurrences.length}
            sx={{
              minWidth: 36,
              height: 22,
              fontWeight: 700,
              fontSize: "0.72rem",
              bgcolor: alpha(accentColor, isDark ? 0.15 : 0.08),
              color: accentColor,
              flexShrink: 0,
            }}
          />

          {/* Doc link */}
          {ruleCode !== "__ungrouped__" && (
            <Tooltip title={t("validation.rule.openDoc")} arrow>
              <IconButton
                size="small"
                onClick={handleDocClick}
                sx={{
                  width: 26,
                  height: 26,
                  flexShrink: 0,
                  color: "text.disabled",
                  "&:hover": {
                    color: accentColor,
                    bgcolor: alpha(accentColor, 0.08),
                  },
                }}
              >
                <OpenInNewIcon sx={{ fontSize: 13 }} />
              </IconButton>
            </Tooltip>
          )}

          {/* Expand arrow */}
          <KeyboardArrowDownIcon
            sx={{
              fontSize: 19,
              color: "text.disabled",
              flexShrink: 0,
              transition: "transform 0.2s cubic-bezier(0.4,0,0.2,1)",
              transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
            }}
          />
        </Box>

        {/* Expanded occurrence table. unmountOnExit: with dozens of rules ×
            hundreds of rows, keeping collapsed tables mounted is pure cost. */}
        <Collapse in={isExpanded} timeout={200} unmountOnExit>
          <Box
            sx={{
              borderTop: `1px solid ${theme.palette.divider}`,
              bgcolor: isDark ? alpha("#000", 0.18) : alpha("#000", 0.012),
            }}
          >
            <RuleOccurrenceTable occurrences={occurrences} ruleCode={ruleCode} />
          </Box>
        </Collapse>
      </Box>
      {quickFixOpen && (
        <QuickFixDialog
          open={quickFixOpen}
          onClose={() => setQuickFixOpen(false)}
          ruleCode={ruleCode}
        />
      )}
    </>
  );
}

export default RuleGroupCard;
