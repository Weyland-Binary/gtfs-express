/**
 * The report's Diagnostic tab: the checks beyond the validator (useQualityAudit) as a list beside the selected
 * finding, its examples opening their record and its acts in its head.
 */
import React, { useCallback, useRef, useState } from "react";
import { Box, Button, ButtonBase, CircularProgress, IconButton, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import SensorsOutlinedIcon from "@mui/icons-material/SensorsOutlined";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import EditLocationAltIcon from "@mui/icons-material/EditLocationAlt";
import MergeTypeIcon from "@mui/icons-material/MergeType";
import VisibilityOffOutlinedIcon from "@mui/icons-material/VisibilityOffOutlined";
import VisibilityOutlinedIcon from "@mui/icons-material/VisibilityOutlined";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import MergeStopsDialog from "./MergeStopsDialog";
import SeverityTile from "./SeverityTile";
import RealtimeCheckDialog from "./RealtimeCheckDialog";

const PANEL_TYPES = new Set(["stop", "route", "trip", "shape", "calendar"]);

export function AuditList({ audit, selected, onSelect }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const dark = theme.palette.mode === "dark";
  const [realtimeOpen, setRealtimeOpen] = useState(false);
  const rowRefs = useRef({});
  const { findings, loading, error, clean, warnings, infos, ignoredSet, ignoredCount, showIgnored, setShowIgnored, load } = audit;

  const move = useCallback(
    (e) => {
      const at = findings.findIndex((f) => f.code === selected);
      let next = null;
      if (e.key === "ArrowDown") next = findings[Math.min(findings.length - 1, at + 1)];
      else if (e.key === "ArrowUp") next = findings[Math.max(0, at - 1)];
      else if (e.key === "Home") next = findings[0];
      else if (e.key === "End") next = findings[findings.length - 1];
      if (!next) return;
      e.preventDefault();
      onSelect(next.code);
      rowRefs.current[next.code]?.focus();
    },
    [findings, selected, onSelect],
  );

  return (
    <Box data-testid="validation-diagnostic-pane" sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Box sx={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 0.5, pl: 2.5, pr: 1.5, py: 1, borderBottom: `1px solid ${alpha(theme.palette.divider, 0.6)}` }}>
        <Typography sx={{ flex: 1, minWidth: 0, fontSize: "0.78rem", color: "text.secondary", lineHeight: 1.4 }}>
          {loading && !audit.audit ? t("audit.running") : clean ? t("audit.cleanSubtitle") : t("audit.subtitle", { warnings, infos })}
        </Typography>
        <Tooltip title={t("realtime.title")}>
          <IconButton size="small" onClick={() => setRealtimeOpen(true)} aria-label={t("realtime.title")} data-testid="audit-realtime">
            <SensorsOutlinedIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        {loading ? (
          <Box sx={{ width: 34, display: "flex", justifyContent: "center" }}>
            <CircularProgress size={16} />
          </Box>
        ) : (
          <Tooltip title={t("audit.refresh")}>
            <IconButton size="small" onClick={load} aria-label={t("audit.refresh")}>
              <RefreshIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>
      <RealtimeCheckDialog open={realtimeOpen} onClose={() => setRealtimeOpen(false)} />

      <Box role="listbox" aria-label={t("audit.list.label")} onKeyDown={move} sx={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
        {error && <Typography sx={{ px: 2.5, py: 2, fontSize: "0.8rem", color: "error.main" }}>{t("audit.error")}</Typography>}
        {clean && !showIgnored && (
          <Box data-testid="audit-clean" sx={{ display: "flex", alignItems: "center", gap: 1, px: 2.5, py: 2.5, color: theme.palette.success.main }}>
            <CheckCircleOutlineIcon sx={{ fontSize: 20 }} />
            <Typography sx={{ fontSize: "0.84rem", fontWeight: 600 }}>{t("audit.clean")}</Typography>
          </Box>
        )}
        {findings.map((f) => {
          const isSel = f.code === selected;
          const warn = f.severity === "warning";
          const ignored = ignoredSet.has(f.code);
          return (
            <ButtonBase
              key={f.code}
              ref={(el) => {
                if (el) rowRefs.current[f.code] = el;
                else delete rowRefs.current[f.code];
              }}
              role="option"
              aria-selected={isSel}
              tabIndex={isSel ? 0 : -1}
              onClick={() => onSelect(f.code)}
              data-testid={`audit-finding-${f.code}`}
              sx={{
                width: "100%",
                display: "grid",
                gridTemplateColumns: "auto minmax(0, 1fr) auto",
                alignItems: "center",
                columnGap: 1.25,
                px: 2.5,
                py: 1.25,
                textAlign: "left",
                opacity: ignored ? 0.6 : 1,
                borderBottom: `1px solid ${alpha(theme.palette.divider, 0.6)}`,
                bgcolor: isSel ? alpha(theme.palette.primary.main, dark ? 0.14 : 0.07) : "transparent",
                boxShadow: isSel ? `inset 3px 0 0 ${warn ? theme.palette.severities.warning.main : theme.palette.severities.info.main}` : "none",
                "&:hover": { bgcolor: isSel ? alpha(theme.palette.primary.main, dark ? 0.18 : 0.09) : theme.palette.action.hover },
                "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 },
              }}
            >
              <SeverityTile severity={warn ? "warning" : "info"} size={28} radius="8px" />
              <Typography noWrap sx={{ fontSize: "0.84rem", fontWeight: isSel ? 600 : 500, lineHeight: 1.35 }}>
                {t(`audit.code.${f.code}.title`)}
              </Typography>
              <Typography component="span" sx={{ fontSize: "0.78rem", fontWeight: 600, color: isSel ? "text.primary" : "text.secondary", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                {t(`audit.unit.${f.unit}`, { count: f.count })}
              </Typography>
            </ButtonBase>
          );
        })}
      </Box>

      {(ignoredCount > 0 || audit.audit?.partial) && (
        <Box sx={{ flexShrink: 0, px: 2.5, py: 1, borderTop: `1px solid ${alpha(theme.palette.divider, 0.6)}`, display: "flex", flexDirection: "column", gap: 0.5 }}>
          {ignoredCount > 0 && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, fontSize: "0.75rem", color: "text.secondary" }}>
              <VisibilityOffOutlinedIcon sx={{ fontSize: 14 }} />
              {t("audit.ignoredCount", { count: ignoredCount })}
              <Button size="small" onClick={() => setShowIgnored((v) => !v)} data-testid="audit-toggle-ignored" sx={{ textTransform: "none", fontWeight: 600, minWidth: 0, py: 0, fontSize: "0.75rem" }}>
                {showIgnored ? t("audit.hideIgnored") : t("audit.showIgnored")}
              </Button>
            </Box>
          )}
          {audit.audit?.partial && <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("audit.partial")}</Typography>}
        </Box>
      )}
    </Box>
  );
}

export function AuditDetail({ audit, finding }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { openPanel } = useDetailPanel();
  const [mergePair, setMergePair] = useState(null);
  const dark = theme.palette.mode === "dark";
  const { ignoredSet, toggleIgnore, askAi, openStudio, chatEnabled } = audit;
  const warn = finding.severity === "warning";
  const tone = warn ? theme.palette.severities.warning.main : theme.palette.severities.info.main;
  const ignored = ignoredSet.has(finding.code);
  const act = { height: 36, borderRadius: "8px", fontSize: "0.84rem", fontWeight: 600, textTransform: "none", px: 1.5, flexShrink: 0 };

  return (
    <Box data-testid="audit-detail" data-code={finding.code} sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Box sx={{ flexShrink: 0, display: "flex", alignItems: "flex-start", gap: 2, px: 3.5, pt: 2.25, pb: 2, bgcolor: "background.paper", borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Box sx={{ pt: 0.25 }}>
          <SeverityTile severity={warn ? "warning" : "info"} size={46} radius="12px" />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.75 }}>
            <Box component="span" sx={{ fontSize: "0.72rem", fontWeight: 650, px: 1.1, py: 0.25, borderRadius: 99, color: tone, bgcolor: alpha(tone, dark ? 0.18 : 0.1) }}>
              {t(warn ? "audit.severity.warning" : "audit.severity.info")}
            </Box>
            <Typography sx={{ fontSize: "0.75rem", color: "text.secondary" }}>{t("audit.detail.by")}</Typography>
          </Box>
          <Typography component="h3" sx={{ fontSize: "1.25rem", fontWeight: 650, letterSpacing: "-0.01em", lineHeight: 1.3 }}>
            {t(`audit.code.${finding.code}.title`)}
          </Typography>
          <Typography sx={{ mt: 0.5, fontSize: "0.8125rem", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>{t(`audit.unit.${finding.unit}`, { count: finding.count })}</Typography>
        </Box>
        <Box sx={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 1, pt: 0.5, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Tooltip title={ignored ? "" : t("audit.action.ignoreHint")}>
            <Button
              color="inherit"
              onClick={() => toggleIgnore(finding.code, !ignored)}
              data-testid={ignored ? "audit-unignore" : "audit-ignore"}
              startIcon={ignored ? <VisibilityOutlinedIcon sx={{ fontSize: 16 }} /> : <VisibilityOffOutlinedIcon sx={{ fontSize: 16 }} />}
              sx={{ ...act, color: "text.secondary" }}
            >
              {ignored ? t("audit.action.unignore") : t("audit.action.ignore")}
            </Button>
          </Tooltip>
          {finding.fix === "studio" && (
            <Button variant="outlined" color="inherit" onClick={() => openStudio(finding)} startIcon={<EditLocationAltIcon sx={{ fontSize: 16 }} />} sx={{ ...act, borderColor: theme.palette.divider }}>
              {t("audit.action.openStudio")}
            </Button>
          )}
          {chatEnabled && (
            <Button
              variant="outlined"
              onClick={() => askAi(finding)}
              data-testid="audit-ask-ai"
              startIcon={<AutoAwesomeIcon sx={{ fontSize: 16 }} />}
              sx={{ ...act, color: theme.palette.ai.main, borderColor: alpha(theme.palette.ai.main, 0.4), bgcolor: alpha(theme.palette.ai.main, dark ? 0.12 : 0.06), "&:hover": { borderColor: theme.palette.ai.main, bgcolor: alpha(theme.palette.ai.main, dark ? 0.18 : 0.1) } }}
            >
              {finding.fix === "sql" ? t("audit.action.fixWithAi") : t("audit.action.explainWithAi")}
            </Button>
          )}
        </Box>
      </Box>

      <Box sx={{ flexShrink: 0, px: 3.5, py: 1.75, borderBottom: `1px solid ${theme.palette.divider}` }}>
        <Typography sx={{ maxWidth: 820, fontSize: "0.84rem", lineHeight: 1.55 }}>{t(`audit.code.${finding.code}.body`)}</Typography>
      </Box>

      <Box data-testid="audit-samples" sx={{ flex: 1, minHeight: 0, overflowY: "auto", bgcolor: "background.paper" }}>
        {finding.samples.map((s, i) => {
          const clickable = Boolean(s.id) && PANEL_TYPES.has(finding.entityType);
          const mergeable = finding.code === "duplicate_stops" && s.id && s.otherId;
          return (
            <Box key={`${s.id || "x"}-${i}`} sx={{ display: "flex", alignItems: "center", gap: 1.5, minHeight: 40, px: 3.5, borderBottom: `1px solid ${alpha(theme.palette.divider, 0.6)}` }}>
              <Box
                component={clickable ? ButtonBase : "div"}
                onClick={clickable ? () => openPanel(finding.entityType, s.id) : undefined}
                sx={{ flex: 1, minWidth: 0, display: "flex", alignItems: "baseline", gap: 1.5, py: 1, textAlign: "left", justifyContent: "flex-start", font: "inherit", borderRadius: "4px", "&:hover .audit-sample-label": clickable ? { textDecoration: "underline" } : {} }}
              >
                <Box component="span" className="audit-sample-label" sx={{ fontSize: "0.8125rem", fontWeight: 600, color: clickable ? "primary.main" : "text.primary", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "50%" }}>
                  {s.label}
                </Box>
                <Box component="span" sx={{ flex: 1, minWidth: 0, fontSize: "0.8rem", color: "text.secondary", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {s.detail}
                </Box>
                {clickable && <ChevronRightRoundedIcon aria-hidden sx={{ fontSize: 16, color: "text.secondary", alignSelf: "center" }} />}
              </Box>
              {mergeable && (
                <Button size="small" variant="outlined" color="inherit" onClick={() => setMergePair({ a: s.id, b: s.otherId })} data-testid="audit-merge" startIcon={<MergeTypeIcon sx={{ fontSize: 15 }} />} sx={{ height: 28, borderRadius: "6px", fontSize: "0.78rem", fontWeight: 600, textTransform: "none", borderColor: theme.palette.divider, flexShrink: 0 }}>
                  {t("audit.merge.action")}
                </Button>
              )}
            </Box>
          );
        })}
        {finding.count > finding.samples.length && (
          <Typography sx={{ px: 3.5, py: 1.5, fontSize: "0.78rem", color: "text.secondary" }}>{t("audit.moreSamples", { count: finding.count - finding.samples.length })}</Typography>
        )}
      </Box>
      <MergeStopsDialog open={Boolean(mergePair)} stopA={mergePair?.a} stopB={mergePair?.b} onClose={() => setMergePair(null)} />
    </Box>
  );
}
