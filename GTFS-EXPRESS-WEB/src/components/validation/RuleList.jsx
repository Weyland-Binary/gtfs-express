import React, { useCallback, useEffect, useRef } from "react";
import { Box, Button, ButtonBase, IconButton, InputBase, MenuItem, Select, Typography, alpha, useTheme } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import ClearIcon from "@mui/icons-material/Clear";
import { useLanguage } from "../../contexts/LanguageContext";
import { SAFE_REPAIR_RULES } from "../../utils/safeRepairs";
import { SEVERITIES, findingsOf } from "./reportModel";
import SeverityTile, { severityTone } from "./SeverityTile";

const MONOSPACE = '"JetBrains Mono", "Fira Code", monospace';
const SECTION_LABELS = { error: "validation.severity.errors", warning: "validation.severity.warnings", info: "validation.severity.infos" };
const SAFE = new Set(SAFE_REPAIR_RULES);

/** The search over rules, identifiers and values, and the file the list keeps to. */
export function RuleFilters({ searchQuery, onSearchChange, searchInputRef, fileCounts, fileFilter, onFileChange }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const files = Object.keys(fileCounts).sort();
  const field = {
    height: 34,
    borderRadius: "8px",
    border: `1px solid ${theme.palette.divider}`,
    bgcolor: "background.paper",
    fontSize: "0.8125rem",
    "&:focus-within": { borderColor: theme.palette.primary.main, boxShadow: `0 0 0 3px ${alpha(theme.palette.primary.main, 0.12)}` },
  };
  return (
    <Box sx={{ flexShrink: 0, display: "flex", gap: 1, px: 2, py: 1.25, borderBottom: `1px solid ${alpha(theme.palette.divider, 0.6)}` }}>
      <Box sx={{ ...field, flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 0.75, px: 1.25 }}>
        <SearchIcon aria-hidden sx={{ fontSize: 16, color: "text.secondary", flexShrink: 0 }} />
        <InputBase
          inputRef={searchInputRef}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("validation.search.placeholder")}
          inputProps={{ "aria-label": t("validation.search.label"), "data-testid": "validation-search", type: "search" }}
          sx={{ flex: 1, minWidth: 0, fontSize: "inherit", "& input": { p: 0 }, "& input::-webkit-search-cancel-button": { display: "none" } }}
        />
        {searchQuery && (
          <IconButton size="small" onClick={() => onSearchChange("")} aria-label={t("validation.search.clear")} sx={{ p: 0.25, color: "text.secondary" }}>
            <ClearIcon sx={{ fontSize: 14 }} />
          </IconButton>
        )}
      </Box>
      {files.length > 1 && (
        <Select
          value={fileFilter}
          onChange={(e) => onFileChange(e.target.value)}
          displayEmpty
          size="small"
          input={<InputBase />}
          SelectDisplayProps={{ "aria-label": t("validation.filter.file.label"), "data-testid": "validation-file-filter" }}
          MenuProps={{ PaperProps: { sx: { maxHeight: 360 } } }}
          renderValue={(v) => (v ? <Box component="span" sx={{ fontFamily: MONOSPACE, fontSize: "0.78rem" }}>{v}</Box> : t("validation.filter.file.any"))}
          sx={{ ...field, flexShrink: 0, maxWidth: 190, "& .MuiSelect-select": { py: 0, pl: 1.25, pr: "28px !important", display: "flex", alignItems: "center", height: 34 } }}
        >
          <MenuItem value="">{t("validation.filter.file.any")}</MenuItem>
          {files.map((name) => (
            <MenuItem key={name} value={name} sx={{ display: "flex", gap: 2, justifyContent: "space-between" }}>
              <Box component="span" sx={{ fontFamily: MONOSPACE, fontSize: "0.8rem" }}>{name}</Box>
              <Box component="span" sx={{ fontSize: "0.75rem", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>{fileCounts[name].toLocaleString()}</Box>
            </MenuItem>
          ))}
        </Select>
      )}
    </Box>
  );
}

/**
 * The rules, one row each under its severity's heading (held at the top while its rules scroll), the selected one
 * shown beside the list. ↑ ↓ Début Fin move the selection.
 */
export default function RuleList({ groups, selected, onSelect, titleOf, quickFixes, onClearFilters, revealToken = 0 }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const dark = theme.palette.mode === "dark";
  const rowRefs = useRef({});

  const move = useCallback(
    (e) => {
      const at = groups.findIndex((g) => g.ruleCode === selected);
      let next = null;
      if (e.key === "ArrowDown") next = groups[Math.min(groups.length - 1, at + 1)];
      else if (e.key === "ArrowUp") next = groups[Math.max(0, at - 1)];
      else if (e.key === "Home") next = groups[0];
      else if (e.key === "End") next = groups[groups.length - 1];
      if (!next) return;
      e.preventDefault();
      onSelect(next.ruleCode);
      rowRefs.current[next.ruleCode]?.focus();
    },
    [groups, selected, onSelect],
  );

  // A rule chosen from elsewhere (the overview, a notice) is brought into view.
  useEffect(() => {
    if (revealToken && selected) rowRefs.current[selected]?.scrollIntoView?.({ block: "nearest" });
  }, [revealToken, selected]);

  if (groups.length === 0) {
    return (
      <Box sx={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1.25, px: 3, py: 6, textAlign: "center", color: "text.secondary" }}>
        <Typography sx={{ fontSize: "0.85rem" }}>{t("validation.empty.noMatches")}</Typography>
        <Button size="small" onClick={onClearFilters} sx={{ textTransform: "none", fontWeight: 600 }}>
          {t("validation.empty.clearFilters")}
        </Button>
      </Box>
    );
  }

  const sections = SEVERITIES.map((sev) => ({ sev, groups: groups.filter((g) => g.severity === sev) })).filter((s) => s.groups.length > 0);
  const tagOf = (g) => {
    if (SAFE.has(g.ruleCode) && g.occurrences.some((o) => !o.asideId)) return { label: t("validation.tag.safe"), hint: t("validation.tag.safeHint"), tone: theme.palette.success.main };
    if (quickFixes?.get(g.ruleCode)?.count > 0) return { label: t("validation.tag.quick"), hint: t("validation.tag.quickHint"), tone: theme.palette.primary.main };
    return null;
  };

  return (
    <Box role="listbox" aria-label={t("validation.list.label")} onKeyDown={move} data-testid="validation-rule-list" sx={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
      {sections.map(({ sev, groups: rows }) => {
        const tone = (theme.palette.severities[sev] || theme.palette.severities.error).main;
        const headingId = `validation-section-label-${sev}`;
        return (
          <Box key={sev} role="group" aria-labelledby={headingId}>
            <Box
              id={headingId}
              data-testid={`validation-section-${sev}`}
              sx={{ position: "sticky", top: 0, zIndex: 1, display: "flex", alignItems: "center", gap: 1, height: 30, px: 2.5, bgcolor: "background.paper", borderBottom: `1px solid ${alpha(theme.palette.divider, 0.6)}`, fontSize: "0.7rem", fontWeight: 650, letterSpacing: "0.05em", textTransform: "uppercase", color: "text.secondary" }}
            >
              <Box aria-hidden sx={{ width: 7, height: 7, borderRadius: "50%", bgcolor: tone, flexShrink: 0 }} />
              {t(SECTION_LABELS[sev])}
              <Box component="span" sx={{ ml: "auto", fontVariantNumeric: "tabular-nums" }}>
                {rows.reduce((n, g) => n + findingsOf(g.occurrences), 0).toLocaleString()}
              </Box>
            </Box>
            {rows.map((g) => {
              const isSel = g.ruleCode === selected;
              const tag = tagOf(g);
              const rowTone = severityTone(theme, g.severity);
              return (
                <ButtonBase
                  key={g.ruleCode}
                  ref={(el) => {
                    if (el) rowRefs.current[g.ruleCode] = el;
                    else delete rowRefs.current[g.ruleCode];
                  }}
                  role="option"
                  aria-selected={isSel}
                  tabIndex={isSel ? 0 : -1}
                  onClick={() => onSelect(g.ruleCode)}
                  data-testid="validation-rule-row"
                  data-rule={g.ruleCode}
                  sx={{
                    width: "100%",
                    display: "grid",
                    gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
                    alignItems: "center",
                    columnGap: 1.5,
                    pl: 2,
                    pr: 2.5,
                    py: 1.1,
                    textAlign: "left",
                    borderBottom: `1px solid ${alpha(theme.palette.divider, 0.6)}`,
                    bgcolor: isSel ? alpha(theme.palette.primary.main, dark ? 0.14 : 0.07) : "transparent",
                    boxShadow: isSel ? `inset 3px 0 0 ${rowTone}` : "none",
                    "&:hover": { bgcolor: isSel ? alpha(theme.palette.primary.main, dark ? 0.18 : 0.09) : theme.palette.action.hover },
                    "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
                  }}
                >
                  <SeverityTile severity={g.severity} size={28} radius="8px" />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography noWrap sx={{ fontSize: "0.84rem", fontWeight: isSel ? 600 : 500, color: "text.primary", lineHeight: 1.35 }}>
                      {titleOf(g.ruleCode)}
                    </Typography>
                    {g.ruleCode !== "__ungrouped__" && (
                      <Typography noWrap sx={{ mt: 0.15, fontFamily: MONOSPACE, fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.35 }}>
                        {g.ruleCode}
                      </Typography>
                    )}
                  </Box>
                  {tag ? (
                    <Box component="span" title={tag.hint} sx={{ fontSize: "0.68rem", fontWeight: 650, px: 1, py: 0.25, borderRadius: 99, whiteSpace: "nowrap", color: tag.tone, bgcolor: alpha(tag.tone, dark ? 0.18 : 0.1) }}>
                      {tag.label}
                    </Box>
                  ) : (
                    <span />
                  )}
                  <Typography component="span" data-testid="rule-count" sx={{ minWidth: 34, height: 22, px: 1, borderRadius: 99, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.75rem", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: rowTone, bgcolor: alpha(rowTone, dark ? 0.18 : 0.1) }}>
                    {g.count.toLocaleString()}
                  </Typography>
                </ButtonBase>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}
