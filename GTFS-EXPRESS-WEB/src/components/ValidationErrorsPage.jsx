import React, {
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  Typography,
  Box,
  useTheme,
  alpha,
  Snackbar,
  Alert,
  Button,
  CircularProgress,
} from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import { keyframes } from "@mui/system";
import { useLanguage } from "../contexts/LanguageContext";
import { fetchWithSession } from "../utils/sessionManager";
import API_BASE_URL from "../config";

import ValidationToolbar from "./validation/ValidationToolbar";
import ValidationSummary from "./validation/ValidationSummary";
import ValidationFilterBar from "./validation/ValidationFilterBar";
import RuleGroupList, { severityOfGroup } from "./validation/RuleGroupList";
import RescueBanner from "./validation/RescueBanner";
import FixQueueBar from "./validation/FixQueueBar";
import { isFixableFinding } from "./validation/useFixDialog";
import AutoFixedBanner from "./validation/AutoFixedBanner";
import QualityAuditPanel from "./validation/QualityAuditPanel";
import { licenceLockOf, openPaywall, useFeatures } from "../utils/featuresApi";
import { cardSx, groundOf } from "./common/ground";
import { CHAT_OPEN_EVENT } from "../utils/appEvents";

const getSeverityColor = (theme, sev) =>
  (theme.palette.severities[sev] || theme.palette.severities.error).main;

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
`;

function flattenErrors(groupedErrors) {
  const all = [];
  Object.entries(groupedErrors).forEach(([fileName, errors]) => {
    errors.forEach((err) => all.push({ ...err, fileName }));
  });
  return all;
}

/**
 * The validation report, grouped by rule like MobilityData's own report; an expanded rule shows exactly the
 * fields the canonical engine returned. The semantic Diagnostic sits beside it.
 */
function ValidationErrorsPage({
  report,
  onReupload,
  onBack,
  onReportRefreshed,
  baselineCounts,
  // Entities were edited since this report; the app re-runs the validator in the background.
  stale = false,
  backgroundValidating = false,
  // { table: droppedCount } from the tolerant import: keeps the "fixed at import" note after a
  // re-validation, whose fresh report carries no such rows.
  importAdjustments = null,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { t } = useLanguage();
  const { features } = useFeatures();
  const chatEnabled = Boolean(features?.chat?.enabled);
  const editLock = licenceLockOf(features?.access);
  const gated = (fn) => () => (editLock ? openPaywall("edit", editLock, fn) : fn());

  const [revalidating, setRevalidating] = useState(false);
  const [revalidateToast, setRevalidateToast] = useState(null);
  const [severityFilter, setSeverityFilter] = useState(
    new Set(["error", "warning", "info"]),
  );
  const [fileFilter, setFileFilter] = useState(new Set()); // empty = all files
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState(new Set());
  const [fixQueueOpen, setFixQueueOpen] = useState(false);

  const searchInputRef = useRef(null);

  const groupedErrors = report.errors; // { fileName: [finding, ...] }

  // Findings the tolerant import already resolved (duplicate rows dropped) are announced apart and
  // left out of every tally below.
  const { activeFindings, autoFixedFindings } = useMemo(() => {
    const all = flattenErrors(groupedErrors);
    return {
      activeFindings: all.filter((f) => !f.resolvedByImport),
      autoFixedFindings: all.filter((f) => f.resolvedByImport),
    };
  }, [groupedErrors]);

  // Weighted like utils/validationSummary.js: an aggregate "N more not sampled" marker counts N, not 1,
  // so these numbers agree with the header badge, the dashboard and the repair-progress baseline.
  const severityCounts = useMemo(() => {
    const counts = { error: 0, warning: 0, info: 0 };
    activeFindings.forEach((f) => {
      const s = f.severity || "error";
      const w = f.aggregate ? Math.max(0, Number(f.aggregateCount) || 0) : 1;
      if (counts[s] !== undefined) counts[s] += w;
    });
    return counts;
  }, [activeFindings]);

  // A rule counts under its worst finding's severity.
  const ruleCounts = useMemo(() => {
    const byRule = {};
    activeFindings.forEach((f) => {
      const key = f.ruleCode || "__ungrouped__";
      (byRule[key] = byRule[key] || []).push(f);
    });
    const counts = { error: 0, warning: 0, info: 0 };
    Object.values(byRule).forEach((occurrences) => {
      counts[severityOfGroup(occurrences)] += 1;
    });
    return counts;
  }, [activeFindings]);

  const weightOf = (f) =>
    f.aggregate ? Math.max(0, Number(f.aggregateCount) || 0) : 1;

  const fileCounts = useMemo(() => {
    const counts = {};
    activeFindings.forEach((f) => {
      if (f.fileName) counts[f.fileName] = (counts[f.fileName] || 0) + weightOf(f);
    });
    return counts;
  }, [activeFindings]);

  const filteredFindings = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return activeFindings.filter((f) => {
      if (!severityFilter.has(f.severity || "error")) return false;
      if (fileFilter.size > 0 && !fileFilter.has(f.fileName)) return false;
      if (q) {
        const inCode = (f.ruleCode || "").toLowerCase().includes(q);
        const inMsg = (f.message || "").toLowerCase().includes(q);
        if (!inCode && !inMsg) return false;
      }
      return true;
    });
  }, [activeFindings, severityFilter, fileFilter, searchQuery]);

  const sortedRuleGroups = useMemo(() => {
    const map = {};
    filteredFindings.forEach((f) => {
      const key = f.ruleCode || "__ungrouped__";
      if (!map[key]) map[key] = [];
      map[key].push(f);
    });
    const sevOrder = { error: 0, warning: 1, info: 2 };
    return Object.entries(map)
      .map(([ruleCode, occurrences]) => ({ ruleCode, occurrences }))
      .sort((a, b) => {
        const aWorst = a.occurrences.reduce(
          (w, o) => Math.min(w, sevOrder[o.severity || "error"] ?? 2),
          2,
        );
        const bWorst = b.occurrences.reduce(
          (w, o) => Math.min(w, sevOrder[o.severity || "error"] ?? 2),
          2,
        );
        if (aWorst !== bWorst) return aWorst - bWorst;
        const weight = (g) => g.occurrences.reduce((acc, o) => acc + weightOf(o), 0);
        return weight(b) - weight(a);
      });
  }, [filteredFindings]);

  const fixableFindings = useMemo(
    () =>
      sortedRuleGroups.flatMap((g) =>
        g.occurrences.filter((o) => isFixableFinding(o)),
      ),
    [sortedRuleGroups],
  );

  const importAdjustmentsTotal = useMemo(
    () =>
      Object.values(importAdjustments || {}).reduce(
        (acc, n) => acc + (Number(n) || 0),
        0,
      ),
    [importAdjustments],
  );

  const statusColor =
    severityCounts.error > 0
      ? getSeverityColor(theme, "error")
      : severityCounts.warning > 0
        ? getSeverityColor(theme, "warning")
        : theme.palette.success.main;

  const totalFindings = activeFindings.reduce((acc, f) => acc + weightOf(f), 0);
  const filteredTotal = filteredFindings.reduce((acc, f) => acc + weightOf(f), 0);
  const ruleCount = sortedRuleGroups.length;

  const toggleSeverity = useCallback((sev) => {
    setSeverityFilter((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) {
        if (next.size > 1) next.delete(sev);
      } else {
        next.add(sev);
      }
      return next;
    });
  }, []);

  const toggleFileFilter = useCallback(
    (fileName, solo) => {
      if (fileName === null) {
        setFileFilter(new Set());
        return;
      }
      setFileFilter((prev) => {
        if (solo) return new Set([fileName]);
        const next = new Set(prev);
        if (next.has(fileName)) next.delete(fileName);
        else next.add(fileName);
        if (next.size === Object.keys(fileCounts).length) return new Set();
        return next;
      });
    },
    [fileCounts],
  );

  const toggleGroup = useCallback((ruleCode) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(ruleCode)) next.delete(ruleCode);
      else next.add(ruleCode);
      return next;
    });
  }, []);

  const clearAllFilters = useCallback(() => {
    setSeverityFilter(new Set(["error", "warning", "info"]));
    setFileFilter(new Set());
    setSearchQuery("");
  }, []);

  // Validates the session's current database (read-only works too); the fresh report is lifted to GTFSApp
  // so every screen shows the same one.
  const handleRevalidate = useCallback(async () => {
    if (revalidating) return;
    setRevalidating(true);
    const startedAt = Date.now();
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/validate`, {
        method: "POST",
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const fresh = await res.json();
      if (onReportRefreshed) onReportRefreshed(fresh, startedAt);
      setRevalidateToast({
        severity: "success",
        message: t("validation.revalidate.toastDone"),
      });
    } catch (err) {
      setRevalidateToast({
        severity: "warning",
        message:
          err.isRateLimit || err.status === 429
            ? t("validation.revalidate.rateLimited")
            : t("validation.revalidate.failed"),
      });
    } finally {
      setRevalidating(false);
    }
  }, [revalidating, onReportRefreshed, t]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.ctrlKey && e.key === "f") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      const tag = document.activeElement?.tagName;
      const isInput =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        document.activeElement?.isContentEditable;
      if (!isInput) {
        if (e.key === "1") toggleSeverity("error");
        if (e.key === "2") toggleSeverity("warning");
        if (e.key === "3") toggleSeverity("info");
      }
      if (e.key === "Escape") {
        if (document.activeElement === searchInputRef.current) {
          setSearchQuery("");
        } else {
          setExpandedGroups(new Set());
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSeverity]);

  const allClear = totalFindings === 0;
  const scrollbarSx = {
    "&::-webkit-scrollbar": { width: 6 },
    "&::-webkit-scrollbar-thumb": { bgcolor: alpha(theme.palette.text.primary, isDark ? 0.18 : 0.12), borderRadius: 3 },
  };

  return (
    <Box
      data-testid="validation-page"
      sx={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        overflow: "hidden",
        animation: `${fadeIn} 0.3s ease-out`,
        bgcolor: groundOf(theme),
      }}
    >
      {/* Only a file refused at import gets this bar: re-uploading is then the one way on. */}
      {report?.structural && (
      <ValidationToolbar
        onReupload={onReupload}
        onBack={onBack}
        totalFindings={totalFindings}
        ruleCount={ruleCount}
        filteredTotal={filteredTotal}
        severityCounts={severityCounts}
        statusColor={statusColor}
        onRevalidate={handleRevalidate}
        revalidating={revalidating}
      />
      )}

      <RescueBanner
        severityCounts={severityCounts}
        baselineCounts={baselineCounts}
        revalidating={revalidating}
        onRevalidate={handleRevalidate}
      />

      {stale && (
        <Alert
          severity="info"
          icon={backgroundValidating ? <CircularProgress size={18} /> : undefined}
          data-testid="validation-stale-banner"
          action={
            !backgroundValidating && (
              <Button
                size="small"
                color="inherit"
                onClick={handleRevalidate}
                disabled={revalidating}
                sx={{ textTransform: "none", fontWeight: 700 }}
              >
                {t("validation.revalidate.button")}
              </Button>
            )
          }
          sx={{ borderRadius: 0, flexShrink: 0 }}
        >
          {backgroundValidating || revalidating
            ? t("validation.stale.checking")
            : t("validation.stale.banner")}
        </Alert>
      )}

      {!report?.structural && (
        <Box sx={{ px: 2, pt: 2, flexShrink: 0 }}>
        <ValidationSummary
          severityCounts={severityCounts}
          ruleCounts={ruleCounts}
          severityFilter={severityFilter}
          onToggleSeverity={toggleSeverity}
          onRevalidate={handleRevalidate}
          revalidating={revalidating}
          actions={
            (fixableFindings.length > 0 || chatEnabled) && !fixQueueOpen ? (
              <>
                {fixableFindings.length > 0 && (
                  <Button
                    variant="outlined"
                    color="inherit"
                    onClick={gated(() => setFixQueueOpen(true))}
                    data-testid="fix-queue-start"
                    data-locked={editLock ? "1" : undefined}
                    startIcon={editLock ? <LockOutlinedIcon sx={{ fontSize: 16 }} /> : <AutoFixHighIcon sx={{ fontSize: 16 }} />}
                    sx={{ textTransform: "none", fontWeight: 600, fontSize: "0.82rem", borderRadius: "8px", height: 34, px: 1.5, borderColor: theme.palette.divider, "&:hover": { borderColor: alpha(theme.palette.text.primary, 0.3), backgroundColor: theme.palette.action.hover } }}
                  >
                    {t("validation.fixQueue.start", { count: fixableFindings.length })}
                  </Button>
                )}
                {chatEnabled && (
                  <Button
                    variant="contained"
                    disableElevation
                    onClick={gated(() => window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail: { message: t("validation.aiRepairAll.prompt") } })))}
                    data-testid="ai-repair-all"
                    data-locked={editLock ? "1" : undefined}
                    startIcon={editLock ? <LockOutlinedIcon sx={{ fontSize: 16 }} /> : <AutoAwesomeIcon sx={{ fontSize: 16 }} />}
                    sx={{ textTransform: "none", fontWeight: 600, fontSize: "0.82rem", borderRadius: "8px", height: 34, px: 1.5, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})` }}
                  >
                    {t("validation.aiRepairAll.button")}
                  </Button>
                )}
              </>
            ) : null
          }
        />
        </Box>
      )}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: { xs: "flex", md: "grid" },
          flexDirection: "column",
          gridTemplateColumns: { md: "minmax(0, 1fr) clamp(360px, 30vw, 500px)" },
          gridTemplateRows: { md: "minmax(0, 1fr)" },
          gap: 2,
          p: 2,
          overflow: { xs: "auto", md: "hidden" },
        }}
      >
        <Box
          component="section"
          aria-label={t("validation.pane.validator")}
          data-testid="validation-rules-pane"
          sx={{ ...cardSx(theme), minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", ...scrollbarSx }}
        >
          <Box sx={{ position: "sticky", top: 0, zIndex: 2, backgroundColor: theme.palette.background.paper, borderBottom: `1px solid ${theme.palette.divider}`, px: { xs: 2, md: 3 }, py: 1.5, display: "flex", flexDirection: "column", gap: 1.25 }}>
            <Box sx={{ display: "flex", alignItems: "baseline", gap: 1.25, flexWrap: "wrap" }}>
              <Typography component="h2" sx={{ fontSize: "0.95rem", fontWeight: 650, letterSpacing: "-0.01em" }}>
                {t("validation.pane.validator")}
              </Typography>
              {!allClear && (
                <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", fontVariantNumeric: "tabular-nums" }}>
                  {t("validation.header.summary", { findings: filteredTotal, rules: sortedRuleGroups.length })}
                </Typography>
              )}
            </Box>
            {!allClear && (
              <ValidationFilterBar
                fileCounts={fileCounts}
                fileFilter={fileFilter}
                onToggleFile={toggleFileFilter}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                searchInputRef={searchInputRef}
              />
            )}
          </Box>

          {(autoFixedFindings.length > 0 || importAdjustmentsTotal > 0) && (
            <Box sx={{ px: { xs: 2, md: 3 }, pt: 1.5 }}>
              {autoFixedFindings.length > 0 ? (
                <AutoFixedBanner findings={autoFixedFindings} />
              ) : (
                <Alert severity="success" icon={<TaskAltIcon />} sx={{ borderRadius: 3 }}>
                  {t("validation.autoFixed.persist", { count: importAdjustmentsTotal })}
                </Alert>
              )}
            </Box>
          )}

          {allClear ? (
            <Box sx={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1.25, py: 8 }}>
              <CheckCircleOutlineIcon sx={{ fontSize: 56, color: theme.palette.success.main }} />
              <Typography variant="h6" sx={{ fontWeight: 650 }}>
                {t("validation.allClear.title")}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t("validation.allClear.body")}
              </Typography>
            </Box>
          ) : (
            <RuleGroupList
              flat
              sectioned
              sortedRuleGroups={sortedRuleGroups}
              expandedGroups={expandedGroups}
              onToggleGroup={toggleGroup}
              onClearFilters={clearAllFilters}
              isLoading={false}
              totalFindingsCount={totalFindings}
            />
          )}
        </Box>

        {/* The Diagnostic offers its own « repair all » only when the validator reports nothing. */}
        <Box
          component="aside"
          data-testid="validation-diagnostic-pane"
          sx={{ ...cardSx(theme), minHeight: 0, overflowY: "auto", px: { xs: 2, md: 3 }, py: 2, display: "flex", flexDirection: "column", ...scrollbarSx }}
        >
          <QualityAuditPanel dense pane repairAll={allClear} />
        </Box>
      </Box>

      {fixQueueOpen && (
        <FixQueueBar
          findings={fixableFindings}
          onClose={() => setFixQueueOpen(false)}
        />
      )}

      <Snackbar
        open={Boolean(revalidateToast)}
        autoHideDuration={4000}
        onClose={() => setRevalidateToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {revalidateToast ? (
          <Alert
            severity={revalidateToast.severity}
            onClose={() => setRevalidateToast(null)}
          >
            {revalidateToast.message}
          </Alert>
        ) : (
          <span />
        )}
      </Snackbar>
    </Box>
  );
}

export default ValidationErrorsPage;
