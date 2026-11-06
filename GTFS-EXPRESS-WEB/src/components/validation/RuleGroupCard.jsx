import React, { useState } from "react";
import {
  Box,
  Typography,
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
import useRuleDescriptions from "./useRuleDescriptions";

const MONOSPACE = '"JetBrains Mono", "Fira Code", monospace';

/** One row of the rule list; expanded, the occurrences with exactly the fields the canonical engine returned. */
function RuleGroupCard({
  ruleCode,
  occurrences,
  isExpanded,
  onToggle,
  cardRef,
  quickFixCount = 0,
  isLast = false,
  // In a list that fills its pane: the rows aligned on its headings.
  inset = false,
}) {
  const theme = useTheme();
  const { t } = useLanguage();
  const [quickFixOpen, setQuickFixOpen] = useState(false);

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
  const describe = useRuleDescriptions();
  const description = ruleCode !== "__ungrouped__" ? describe(ruleCode) : "";

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
        <Box
          role="button"
          tabIndex={0}
          aria-expanded={isExpanded}
          onClick={onToggle}
          onKeyDown={handleKeyDown}
          sx={{
            px: inset ? { xs: 2, md: 3 } : 2,
            minHeight: inset ? 58 : 50,
            py: 0.75,
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: 1.25,
            cursor: "pointer",
            userSelect: "none",
            outline: "none",
            bgcolor: isExpanded ? alpha(accentColor, theme.palette.mode === "dark" ? 0.08 : 0.04) : "transparent",
            // The severity's edge, always: the gravity read at a glance down the list.
            boxShadow: `inset ${isExpanded ? 4 : 3}px 0 0 ${accentColor}`,
            transition: "background 0.15s, box-shadow 0.15s",
            "&:hover": { bgcolor: alpha(accentColor, theme.palette.mode === "dark" ? 0.08 : 0.04) },
            "&:focus-visible": {
              outline: `2px solid ${accentColor}`,
              outlineOffset: -2,
            },
          }}
        >
          <Box sx={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <Box sx={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: 1.25, overflow: "hidden" }}>
            <Typography
              variant="body2"
              sx={{
                fontWeight: 650,
                fontSize: "0.875rem",
                color: "text.primary",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {title}
            </Typography>
            {ruleCode !== "__ungrouped__" && (
              <Typography
                component="span"
                sx={{
                  fontFamily: MONOSPACE,
                  fontWeight: 400,
                  fontSize: "0.72rem",
                  color: "text.secondary",
                  flexShrink: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {ruleCode}
              </Typography>
            )}
          </Box>
          {description && (
            <Typography data-testid="rule-description" title={description} sx={{ fontSize: "0.76rem", color: "text.secondary", lineHeight: 1.4, mt: 0.15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {description}
            </Typography>
          )}
          </Box>

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

          {ruleCode !== "__ungrouped__" && (
            <FixInSqlConsoleButton ruleCode={ruleCode} occurrences={occurrences} />
          )}

          {ruleCode !== "__ungrouped__" && (
            <AskAiFixButton ruleCode={ruleCode} occurrences={occurrences} />
          )}

          <Typography
            component="span"
            data-testid="rule-count"
            sx={{
              minWidth: 34,
              height: 24,
              px: 1,
              borderRadius: 99,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: "0.78rem",
              color: accentColor,
              backgroundColor: alpha(accentColor, theme.palette.mode === "dark" ? 0.18 : 0.1),
              fontVariantNumeric: "tabular-nums",
              flexShrink: 0,
            }}
          >
            {occurrences
              .reduce(
                (acc, o) =>
                  acc + (o.aggregate ? Math.max(0, Number(o.aggregateCount) || 0) : 1),
                0,
              )
              .toLocaleString()}
          </Typography>

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
                    color: "text.primary",
                    bgcolor: theme.palette.action.hover,
                  },
                }}
              >
                <OpenInNewIcon sx={{ fontSize: 13 }} />
              </IconButton>
            </Tooltip>
          )}

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

        {/* unmountOnExit: dozens of rules × hundreds of rows would stay mounted for nothing. */}
        <Collapse in={isExpanded} timeout={200} unmountOnExit>
          <Box
            sx={{
              borderTop: `1px solid ${theme.palette.divider}`,
              bgcolor: theme.palette.background.default,
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
