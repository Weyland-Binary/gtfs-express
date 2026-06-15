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

/**
 * Single flat container listing one row per canonical rule (sorted by the
 * parent), separated by hairline dividers. ↑↓ moves focus between rows.
 *
 * When edit mode is ON, fetches the live Quick Fix availability map so each
 * row can surface a "Fix automatically on N" action.
 */
function RuleGroupList({
  sortedRuleGroups,
  expandedGroups,
  onToggleGroup,
  onClearFilters,
  isLoading,
  totalFindingsCount,
}) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { editing, dataVersion } = useEditMode();
  const cardRefs = useRef({});
  const [quickFixMap, setQuickFixMap] = useState(null); // Map<ruleCode, {count}>

  // Fetch live Quick Fix availability whenever edit mode is toggled or
  // the underlying data changes (applying a fix bumps dataVersion).
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

  return (
    <Paper
      role="list"
      elevation={0}
      sx={{
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 3,
        overflow: "hidden",
        bgcolor: "background.paper",
      }}
    >
      {sortedRuleGroups.map(({ ruleCode, occurrences }, idx) => {
        const qf = quickFixMap ? quickFixMap.get(ruleCode) : null;
        return (
          <Box
            key={ruleCode}
            role="listitem"
            onKeyDown={(e) => handleKeyDown(e, idx)}
          >
            <RuleGroupCard
              ruleCode={ruleCode}
              occurrences={occurrences}
              isExpanded={expandedGroups.has(ruleCode)}
              onToggle={() => onToggleGroup(ruleCode)}
              quickFixCount={qf ? qf.count : 0}
              isLast={idx === sortedRuleGroups.length - 1}
              cardRef={(el) => {
                if (el) {
                  const btn = el.querySelector("[role='button']");
                  cardRefs.current[ruleCode] = btn || el;
                }
              }}
            />
          </Box>
        );
      })}
    </Paper>
  );
}

export default RuleGroupList;
