/**
 * QualityAuditPanel — the "Diagnostic": what the validator cannot see.
 *
 * Fetches GET /quality_audit (memoised server-side per data version) and
 * lists the semantic findings: impossible speeds, duplicate stops,
 * inconsistent names, shapes far from their stops, dead services, unused
 * objects, unreadable colours… Each finding opens its sample entities,
 * hands the problem to the assistant ("Fix with AI") or jumps to the
 * Shape Studio. `compact` renders the dashboard card (top findings only).
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from "@mui/material";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import RefreshIcon from "@mui/icons-material/Refresh";
import EditLocationAltIcon from "@mui/icons-material/EditLocationAlt";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useDetailPanel } from "../../contexts/DetailPanelContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useFeatures } from "../../utils/featuresApi";
import { CHAT_OPEN_EVENT } from "../chat/ChatAssistantFAB";

const PANEL_TYPES = new Set(["stop", "route", "trip", "shape", "calendar"]);

function FindingRow({ finding, onAskAi, onOpenStudio, chatEnabled }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { openPanel } = useDetailPanel();
  const [open, setOpen] = useState(false);
  const warn = finding.severity === "warning";
  const accent = warn ? theme.palette.warning.main : theme.palette.info.main;
  const title = t(`audit.code.${finding.code}.title`);
  const body = t(`audit.code.${finding.code}.body`);

  return (
    <Box
      data-testid={`audit-finding-${finding.code}`}
      sx={{
        borderRadius: 2,
        border: `1px solid ${alpha(accent, 0.35)}`,
        background: alpha(accent, 0.05),
        overflow: "hidden",
      }}
    >
      <Box
        component="button"
        type="button"
        onClick={() => setOpen((o) => !o)}
        sx={{
          all: "unset",
          cursor: "pointer",
          width: "100%",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          gap: 1,
          px: 1.5,
          py: 1,
          "&:hover": { background: alpha(accent, 0.08) },
        }}
      >
        {warn ? (
          <WarningAmberIcon sx={{ fontSize: 18, color: theme.palette.warning.dark, flexShrink: 0 }} />
        ) : (
          <InfoOutlinedIcon sx={{ fontSize: 18, color: theme.palette.info.main, flexShrink: 0 }} />
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontSize: "0.84rem", fontWeight: 700, lineHeight: 1.3 }} noWrap>
            {title}
          </Typography>
          <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", lineHeight: 1.4 }} noWrap>
            {body}
          </Typography>
        </Box>
        <Chip
          size="small"
          label={t(`audit.unit.${finding.unit}`, { count: finding.count })}
          sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700, bgcolor: alpha(accent, 0.15), color: warn ? theme.palette.warning.dark : theme.palette.info.dark }}
        />
        <ExpandMoreIcon sx={{ fontSize: 18, color: "text.secondary", transform: open ? "rotate(180deg)" : "none", transition: "transform 160ms" }} />
      </Box>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 1.5, pb: 1.25, display: "flex", flexDirection: "column", gap: 0.75 }}>
          {finding.samples.length > 0 && (
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.3 }}>
              {finding.samples.map((s, i) => {
                const clickable = s.id && PANEL_TYPES.has(finding.entityType);
                return (
                  <Box
                    key={`${s.id || "x"}-${i}`}
                    component={clickable ? "button" : "div"}
                    type={clickable ? "button" : undefined}
                    onClick={clickable ? () => openPanel(finding.entityType, s.id) : undefined}
                    sx={{
                      all: "unset",
                      display: "flex",
                      alignItems: "baseline",
                      gap: 1,
                      fontSize: "0.74rem",
                      px: 0.75,
                      py: 0.35,
                      borderRadius: 1,
                      cursor: clickable ? "pointer" : "default",
                      "&:hover": clickable ? { background: alpha(theme.palette.primary.main, 0.08) } : {},
                    }}
                  >
                    <Box component="span" sx={{ fontWeight: 600, color: clickable ? "primary.main" : "text.primary", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "55%" }}>
                      {s.label}
                    </Box>
                    <Box component="span" sx={{ color: "text.secondary", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.detail}
                    </Box>
                    {clickable && <OpenInNewIcon sx={{ fontSize: 12, color: "text.disabled" }} />}
                  </Box>
                );
              })}
              {finding.count > finding.samples.length && (
                <Typography sx={{ fontSize: "0.7rem", color: "text.disabled", px: 0.75 }}>
                  {t("audit.moreSamples", { count: finding.count - finding.samples.length })}
                </Typography>
              )}
            </Box>
          )}
          <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap" }}>
            {chatEnabled && (
              <Button
                size="small"
                variant="contained"
                disableElevation
                startIcon={<AutoAwesomeIcon sx={{ fontSize: 15 }} />}
                onClick={() => onAskAi(finding)}
                data-testid="audit-ask-ai"
                sx={{ textTransform: "none", fontWeight: 700, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})` }}
              >
                {finding.fix === "sql" ? t("audit.action.fixWithAi") : t("audit.action.explainWithAi")}
              </Button>
            )}
            {finding.fix === "studio" && (
              <Button
                size="small"
                variant="outlined"
                startIcon={<EditLocationAltIcon sx={{ fontSize: 15 }} />}
                onClick={() => onOpenStudio(finding)}
                sx={{ textTransform: "none", fontWeight: 600 }}
              >
                {t("audit.action.openStudio")}
              </Button>
            )}
          </Box>
        </Box>
      </Collapse>
    </Box>
  );
}

export default function QualityAuditPanel({ compact = false, onSeeAll = null, maxItems = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { dataVersion } = useEditMode();
  const { features } = useFeatures();
  const chatEnabled = Boolean(features?.chat?.enabled);
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/quality_audit`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAudit(await res.json());
    } catch (err) {
      setError(err.message || "error");
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh after edits (debounced: several edits in a row = one audit).
  useEffect(() => {
    const id = setTimeout(load, dataVersion ? 1200 : 0);
    return () => clearTimeout(id);
  }, [load, dataVersion]);

  const findings = useMemo(() => {
    const list = audit?.findings || [];
    return maxItems ? list.slice(0, maxItems) : list;
  }, [audit, maxItems]);
  const warnings = audit?.counts?.warning || 0;
  const infos = audit?.counts?.info || 0;
  const clean = audit && audit.findings.length === 0;

  const askAi = useCallback(
    (finding) => {
      const samples = finding.samples
        .slice(0, 5)
        .map((s) => `- ${s.label}${s.detail ? ` — ${s.detail}` : ""}`)
        .join("\n");
      const message = t("audit.aiPrompt", {
        code: finding.code,
        title: t(`audit.code.${finding.code}.title`),
        count: finding.count,
        samples,
      });
      window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail: { message } }));
    },
    [t],
  );

  const askAiAll = useCallback(() => {
    window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail: { message: t("audit.aiRepairAllPrompt") } }));
  }, [t]);

  const openStudio = useCallback((finding) => {
    const routeId = finding.samples.find((s) => s.routeId)?.routeId || null;
    window.dispatchEvent(new CustomEvent("gtfs:navigate", { detail: { target: "shape_studio", routeId } }));
  }, []);

  return (
    <Box
      data-testid="quality-audit-panel"
      sx={{
        borderRadius: 3,
        border: `1px solid ${alpha(theme.palette.ai.main, 0.3)}`,
        background: `linear-gradient(160deg, ${alpha(theme.palette.ai.main, 0.07)} 0%, ${alpha(theme.palette.background.paper, 0.6)} 60%)`,
        p: compact ? 2 : 2.25,
        display: "flex",
        flexDirection: "column",
        gap: 1.25,
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box
          sx={{
            width: 34,
            height: 34,
            borderRadius: "10px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart} 0%, ${theme.palette.ai.gradientEnd} 100%)`,
            color: theme.palette.ai.contrastText,
            flexShrink: 0,
          }}
        >
          <AutoAwesomeIcon sx={{ fontSize: 19 }} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 800, fontSize: "0.98rem", lineHeight: 1.2 }}>{t("audit.title")}</Typography>
          <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>
            {loading && !audit
              ? t("audit.running")
              : clean
                ? t("audit.cleanSubtitle")
                : t("audit.subtitle", { warnings, infos })}
          </Typography>
        </Box>
        {loading ? (
          <CircularProgress size={18} />
        ) : (
          <Tooltip title={t("audit.refresh")}>
            <IconButton size="small" onClick={load} aria-label={t("audit.refresh")}>
              <RefreshIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {error && (
        <Typography sx={{ fontSize: "0.78rem", color: "error.main" }}>{t("audit.error")}</Typography>
      )}

      {clean && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: theme.palette.success.main, py: 0.5 }}>
          <CheckCircleOutlineIcon sx={{ fontSize: 22 }} />
          <Typography sx={{ fontSize: "0.84rem", fontWeight: 600 }}>{t("audit.clean")}</Typography>
        </Box>
      )}

      {findings.length > 0 && (
        <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75 }}>
          {findings.map((f) => (
            <FindingRow key={f.code} finding={f} onAskAi={askAi} onOpenStudio={openStudio} chatEnabled={chatEnabled} />
          ))}
        </Box>
      )}

      {audit && audit.partial && (
        <Typography sx={{ fontSize: "0.7rem", color: "text.disabled" }}>{t("audit.partial")}</Typography>
      )}

      {(compact || (chatEnabled && findings.length > 0)) && (
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
          {chatEnabled && findings.length > 0 && (
            <Button
              size="small"
              variant="contained"
              disableElevation
              startIcon={<AutoAwesomeIcon sx={{ fontSize: 15 }} />}
              onClick={askAiAll}
              data-testid="audit-repair-all"
              sx={{ textTransform: "none", fontWeight: 700, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})` }}
            >
              {t("audit.action.repairAll")}
            </Button>
          )}
          {compact && onSeeAll && audit && audit.findings.length > findings.length && (
            <Button size="small" onClick={onSeeAll} sx={{ textTransform: "none", fontWeight: 600 }}>
              {t("audit.action.seeAll", { count: audit.findings.length })}
            </Button>
          )}
        </Box>
      )}
    </Box>
  );
}
