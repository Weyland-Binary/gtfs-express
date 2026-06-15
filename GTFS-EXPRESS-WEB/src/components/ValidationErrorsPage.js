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
} from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import { keyframes } from "@mui/system";
import { useLanguage } from "../contexts/LanguageContext";
import { fetchWithSession } from "../utils/sessionManager";
import API_BASE_URL from "../config";

// Validation sub-components
import ValidationToolbar from "./validation/ValidationToolbar";
import ValidationMetricsBar from "./validation/ValidationMetricsBar";
import ValidationFilterBar from "./validation/ValidationFilterBar";
import RuleGroupList from "./validation/RuleGroupList";
import RescueBanner from "./validation/RescueBanner";
import AutoFixedBanner from "./validation/AutoFixedBanner";

const getSeverityColor = (theme, sev) =>
  (theme.palette.severities[sev] || theme.palette.severities.error).main;

const fadeIn = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
`;

/**
 * Flatten the report.errors object (fileName → array) into a flat array
 * where each finding carries its fileName.
 */
function flattenErrors(groupedErrors) {
  const all = [];
  Object.entries(groupedErrors).forEach(([fileName, errors]) => {
    errors.forEach((err) => all.push({ ...err, fileName }));
  });
  return all;
}

/**
 * Validation report — single rule-grouped view, faithful to the canonical
 * engine's output.
 *
 * Layout (top → bottom):
 *   header        title + status, re-validate / re-upload actions
 *   rescue banner export-lock CTA / repair progress / success
 *   auto-fixed    findings the tolerant import already resolved
 *                 (duplicate rows dropped) — announced, never listed as
 *                 outstanding work, no re-validation required
 *   summary       clickable severity stats (filters)
 *   filters       free-text search + per-file chips
 *   rule list     one row per canonical rule; expanding shows EXACTLY the
 *                 fields the engine returned for that rule
 *
 * The grouped-by-file and grouped-by-entity views were removed on purpose:
 * one canonical organisation (by rule, like MobilityData's own report) is
 * lighter to scan and removes a 3-way toggle nobody needed.
 */
function ValidationErrorsPage({
  report,
  onReupload,
  onBack,
  onReportRefreshed,
  baselineCounts,
}) {
  const theme = useTheme();
  const isDark = theme.palette.mode === "dark";
  const { t } = useLanguage();

  // ── State ──
  const [revalidating, setRevalidating] = useState(false);
  const [revalidateToast, setRevalidateToast] = useState(null);
  const [severityFilter, setSeverityFilter] = useState(
    new Set(["error", "warning", "info"]),
  );
  const [fileFilter, setFileFilter] = useState(new Set()); // empty = all files
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  const searchInputRef = useRef(null);

  // ── Derived data ──
  const groupedErrors = report.errors; // { fileName: [finding, ...] }

  // Split once: findings the tolerant import already resolved (duplicate
  // rows dropped at load time) are announced separately and excluded from
  // every "work to do" tally below.
  const { activeFindings, autoFixedFindings } = useMemo(() => {
    const all = flattenErrors(groupedErrors);
    return {
      activeFindings: all.filter((f) => !f.resolvedByImport),
      autoFixedFindings: all.filter((f) => f.resolvedByImport),
    };
  }, [groupedErrors]);

  // Unfiltered counts (always stable — do not depend on filters)
  const severityCounts = useMemo(() => {
    const counts = { error: 0, warning: 0, info: 0 };
    activeFindings.forEach((f) => {
      const s = f.severity || "error";
      if (counts[s] !== undefined) counts[s]++;
    });
    return counts;
  }, [activeFindings]);

  const fileCounts = useMemo(() => {
    const counts = {};
    activeFindings.forEach((f) => {
      if (f.fileName) counts[f.fileName] = (counts[f.fileName] || 0) + 1;
    });
    return counts;
  }, [activeFindings]);

  // Filtered findings (severity + file + search)
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

  // Rule groups from filtered findings, errors first then by volume.
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
        return b.occurrences.length - a.occurrences.length;
      });
  }, [filteredFindings]);

  // ── Derived UI values ──
  const statusColor =
    severityCounts.error > 0
      ? getSeverityColor(theme, "error")
      : severityCounts.warning > 0
        ? getSeverityColor(theme, "warning")
        : theme.palette.success.main;

  const totalFindings = activeFindings.length;
  const filteredTotal = filteredFindings.length;
  const ruleCount = sortedRuleGroups.length;

  // ── Handlers ──
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

  // Re-validate the LIVE session state (works read-only — the backend dumps
  // the current SQLite DB and runs the canonical engine on it). The fresh
  // report is lifted to GTFSApp so every consumer (header badge, home cards,
  // this page) sees the same truth.
  const handleRevalidate = useCallback(async () => {
    if (revalidating) return;
    setRevalidating(true);
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
      if (onReportRefreshed) onReportRefreshed(fresh);
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

  // ── Keyboard shortcuts ──
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

  // ─── Render ───────────────────────────────────────────────────────────────
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
        bgcolor: isDark ? alpha("#000", 0.12) : alpha("#000", 0.012),
      }}
    >
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

      {/* Repair-station banner: locked / progress / success states */}
      <RescueBanner
        severityCounts={severityCounts}
        baselineCounts={baselineCounts}
        revalidating={revalidating}
        onRevalidate={handleRevalidate}
      />

      {/* Scrollable content, centered column for readability */}
      <Box
        sx={{
          flex: 1,
          overflow: "auto",
          minHeight: 0,
          "&::-webkit-scrollbar": { width: 6 },
          "&::-webkit-scrollbar-thumb": {
            bgcolor: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.1)",
            borderRadius: 3,
          },
        }}
      >
        <Box
          sx={{
            maxWidth: 1240,
            mx: "auto",
            px: { xs: 2, md: 3 },
            py: 2,
            display: "flex",
            flexDirection: "column",
            gap: 1.5,
          }}
        >
          {/* Findings the import already fixed — announce, don't alarm. */}
          {autoFixedFindings.length > 0 && (
            <AutoFixedBanner findings={autoFixedFindings} />
          )}

          {allClear ? (
            <Box
              sx={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 1.25,
                py: 8,
              }}
            >
              <CheckCircleOutlineIcon
                sx={{ fontSize: 52, color: theme.palette.success.main }}
              />
              <Typography variant="h6" sx={{ fontWeight: 600 }}>
                {t("validation.allClear.title")}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t("validation.allClear.body")}
              </Typography>
            </Box>
          ) : (
            <>
              <ValidationMetricsBar
                severityCounts={severityCounts}
                severityFilter={severityFilter}
                onToggleSeverity={toggleSeverity}
              />

              <ValidationFilterBar
                fileCounts={fileCounts}
                fileFilter={fileFilter}
                onToggleFile={toggleFileFilter}
                searchQuery={searchQuery}
                onSearchChange={setSearchQuery}
                searchInputRef={searchInputRef}
              />

              <RuleGroupList
                sortedRuleGroups={sortedRuleGroups}
                expandedGroups={expandedGroups}
                onToggleGroup={toggleGroup}
                onClearFilters={clearAllFilters}
                isLoading={false}
                totalFindingsCount={totalFindings}
              />
            </>
          )}
        </Box>
      </Box>

      {/* Revalidation feedback */}
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
