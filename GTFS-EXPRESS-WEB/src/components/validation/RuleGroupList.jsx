import React, { useEffect, useRef, useCallback, useState } from "react";
import {
  Box,
  Paper,
  Typography,
  Button,
  CircularProgress,
  useTheme,
} from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { fetchWithSession } from "../../utils/sessionManager";
import API_BASE_URL from "../../config";
import RuleGroupCard from "./RuleGroupCard";
import { countWords } from "../../utils/countWords";

const SECTION_LABELS = { error: "validation.severity.errors", warning: "validation.severity.warnings", info: "validation.severity.infos" };
/** A rule's severity: the worst of its findings (the order the list is sorted in). */
export const severityOfGroup = (occurrences) =>
  occurrences.some((o) => (o.severity || "error") === "error") ? "error" : occurrences.some((o) => o.severity === "warning") ? "warning" : "info";
/** A rule's findings, an aggregated one counting its own. */
const findingsOf = (occurrences) => occurrences.reduce((n, o) => n + (o.aggregate ? Math.max(0, Number(o.aggregateCount) || 0) : 1), 0);

/**
 * One row per canonical rule, ↑↓ moving between rows. `flat`: no frame of its own; `sectioned`: a heading before each
 * severity. In edit mode, the Quick Fix availability is fetched for every row.
 */
function RuleGroupList({
  sortedRuleGroups,
  expandedGroups,
  onToggleGroup,
  onClearFilters,
  isLoading,
  totalFindingsCount,
  flat = false,
  sectioned = false,
}) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { editing, dataVersion } = useEditMode();
  const cardRefs = useRef({});
  const [quickFixMap, setQuickFixMap] = useState(null); // Map<ruleCode, {count}>

  useEffect(() => {
    if (!editing) {
      setQuickFixMap(null);
      return;
    }
    let cancelled = false;
    fetchWithSession(`${API_BASE_URL}/edit/quickfix`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const map = new Map();
        for (const r of data.rules || []) {
          map.set(r.ruleCode, { count: r.count, titleKey: r.titleKey });
        }
        setQuickFixMap(map);
      })
      .catch(() => {
        if (!cancelled) setQuickFixMap(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [editing, dataVersion]);

  const handleKeyDown = useCallback(
    (e, currentIndex) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = sortedRuleGroups[currentIndex + 1];
        if (next) cardRefs.current[next.ruleCode]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = sortedRuleGroups[currentIndex - 1];
        if (prev) cardRefs.current[prev.ruleCode]?.focus();
      }
    },
    [sortedRuleGroups],
  );

  if (isLoading) {
    return (
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 1.5,
          color: "text.secondary",
          py: 6,
        }}
      >
        <CircularProgress size={18} thickness={4} />
        <Typography variant="body2" sx={{ fontSize: "0.85rem" }}>
          {t("validation.loading.grouping", { count: totalFindingsCount })}
        </Typography>
      </Box>
    );
  }

  if (sortedRuleGroups.length === 0) {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 1.5,
          color: "text.secondary",
          py: 6,
        }}
      >
        <Typography variant="body2" sx={{ fontSize: "0.875rem" }}>
          {t("validation.empty.noMatches")}
        </Typography>
        <Button
          size="small"
          variant="outlined"
          onClick={onClearFilters}
          sx={{
            textTransform: "none",
            borderRadius: 5,
            fontWeight: 600,
            fontSize: "0.8rem",
            borderColor: theme.palette.divider,
          }}
        >
          {t("validation.empty.clearFilters")}
        </Button>
      </Box>
    );
  }

  // The severities' headings: each with its rules and findings, before its first rule.
  const sections = {};
  if (sectioned) {
    for (const g of sortedRuleGroups) {
      const sev = severityOfGroup(g.occurrences);
      sections[sev] = sections[sev] || { rules: 0, findings: 0, first: g.ruleCode };
      sections[sev].rules += 1;
      sections[sev].findings += findingsOf(g.occurrences);
    }
  }
  // A heading: the severity's dot and its name in its colour, its rules and findings in the text's tone.
  const heading = (sev) => {
    const tone = (theme.palette.severities[sev] || theme.palette.severities.error).main;
    const sec = sections[sev];
    return (
      <Box
        role="presentation"
        data-testid={`validation-section-${sev}`}
        sx={{ display: "flex", alignItems: "center", gap: 1, px: { xs: 2, md: 3 }, pt: 2.5, pb: 1, borderBottom: `1px solid ${theme.palette.divider}` }}
      >
        <Box aria-hidden sx={{ width: 6, height: 6, borderRadius: "50%", backgroundColor: tone, flexShrink: 0 }} />
        <Typography component="h3" sx={{ fontSize: "0.8rem", fontWeight: 650, color: tone }}>
          {t(SECTION_LABELS[sev])}
        </Typography>
        <Typography component="span" sx={{ fontSize: "0.8rem", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
          {countWords(t, "validation.summary.rules", sec.rules)} · {sec.findings.toLocaleString()}
        </Typography>
      </Box>
    );
  };

  return (
    <Paper
      role="list"
      elevation={0}
      sx={
        flat
          ? { border: "none", borderRadius: 0, bgcolor: "background.paper" }
          : {
              border: `1px solid ${theme.palette.divider}`,
              borderRadius: 3,
              overflow: "hidden",
              bgcolor: "background.paper",
            }
      }
    >
      {sortedRuleGroups.map(({ ruleCode, occurrences }, idx) => {
        const qf = quickFixMap ? quickFixMap.get(ruleCode) : null;
        const sev = sectioned ? severityOfGroup(occurrences) : null;
        return (
          <React.Fragment key={ruleCode}>
          {sectioned && sections[sev].first === ruleCode && heading(sev)}
          <Box
            role="listitem"
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            <RuleGroupCard
              ruleCode={ruleCode}
              occurrences={occurrences}
              isExpanded={expandedGroups.has(ruleCode)}
              onToggle={() => onToggleGroup(ruleCode)}
              quickFixCount={qf ? qf.count : 0}
              isLast={idx === sortedRuleGroups.length - 1 && !flat}
              inset={flat}
              cardRef={(el) => {
                if (el) {
                  const btn = el.querySelector("[role='button']");
                  cardRefs.current[ruleCode] = btn || el;
                }
              }}
            />
          </Box>
          </React.Fragment>
        );
      })}
    </Paper>
  );
}

export default RuleGroupList;
