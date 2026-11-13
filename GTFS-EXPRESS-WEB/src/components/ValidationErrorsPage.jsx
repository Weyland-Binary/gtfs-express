import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { Box, Button, ButtonBase, CircularProgress, IconButton, Snackbar, Alert, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import AutoAwesomeIcon from "@mui/icons-material/AutoAwesome";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import CleaningServicesRoundedIcon from "@mui/icons-material/CleaningServicesRounded";
import FileDownloadOutlinedIcon from "@mui/icons-material/FileDownloadOutlined";
import { keyframes } from "@mui/system";
import { useLanguage } from "../contexts/LanguageContext";
import { useEditMode } from "../contexts/EditModeContext";
import { fetchWithSession } from "../utils/sessionManager";
import API_BASE_URL from "../config";
import { licenceLockOf, openPaywall, useFeatures } from "../utils/featuresApi";
import { keepLoadedVersions, takeDuplicateCopies, useAsideSummary, useDuplicateGroups } from "../utils/asideApi";
import { safeRepairCountOf } from "../utils/safeRepairs";
import { refusalOf, refusalToAction } from "../utils/refusalToAction";
import { countWords } from "../utils/countWords";
import { CHAT_OPEN_EVENT, OPEN_EXPORT_PREFLIGHT_EVENT } from "../utils/appEvents";
import { takeAskedReport } from "../utils/reportAsk";
import { watchReport } from "../utils/reportWatch";
import { askActAfterMove, takeActAfterMove } from "../utils/actAfterMove";

import ValidationToolbar from "./validation/ValidationToolbar";
import ReportHead from "./validation/ReportHead";
import useReportCheck from "./validation/useReportCheck";
import ReportNotices from "./validation/ReportNotices";
import RuleList, { RuleFilters } from "./validation/RuleList";
import RuleDetail from "./validation/RuleDetail";
import DuplicatesCard from "./validation/DuplicatesCard";
import DuplicatesCompareDialog from "./validation/DuplicatesCompareDialog";
import { AuditDetail, AuditList } from "./validation/AuditPane";
import FixQueueBar from "./validation/FixQueueBar";
import { isFixableFinding } from "./validation/useFixDialog";
import useRuleTexts from "./validation/ruleTexts";
import useQuickFixes from "./validation/useQuickFixes";
import useQualityAudit from "./validation/useQualityAudit";
import { SEVERITIES, flattenErrors, groupByRule, searchTextOf, tallyOf, weightOf } from "./validation/reportModel";

const fadeIn = keyframes`
  from { opacity: 0; }
  to   { opacity: 1; }
`;

const TABS = ["validator", "diagnostic"];

/**
 * The validation report, edge to edge: the verdict and the report's acts, the notices of one line, then the rules
 * beside the selected one (its texts, what the report can do, its occurrences with exactly the fields the validator
 * returned). The Diagnostic, the checks beyond the validator, is the list's second tab.
 */
function ValidationErrorsPage({
  report,
  onReupload,
  onBack,
  onReportRefreshed,
  baselineCounts,
  // Entities were edited since this report; the app re-runs the validator in the background.
  stale = false,
  staleReason = null,
  backgroundValidating = false,
  // { table: droppedCount } from the tolerant import: keeps the "fixed at import" note after a re-validation, whose
  // fresh report carries no such rows.
  importAdjustments = null,
}) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { features } = useFeatures();
  const { editing, enterEditMode, recordEdit, dataVersion } = useEditMode();
  const chatEnabled = Boolean(features?.chat?.enabled);
  const editLock = licenceLockOf(features?.access);
  const gated = (fn) => () => (editLock ? openPaywall("edit", editLock, fn) : fn());
  const structural = Boolean(report?.structural);

  const { titleOf: catalogueTitleOf, descriptionOf } = useRuleTexts();
  const titleOf = useCallback((code) => (code === "__ungrouped__" ? t("validation.rule.ungrouped") : catalogueTitleOf(code)), [catalogueTitleOf, t]);
  const quickFixes = useQuickFixes();
  const audit = useQualityAudit({ enabled: !structural });
  // In sight, a correction is checked again within a moment: its figures follow it, the head saying the check.
  useEffect(() => watchReport(), []);
  const aside = useAsideSummary(report);
  const duplicates = useDuplicateGroups(aside.duplicates);

  const [asked] = useState(() => takeAskedReport());
  const [tab, setTab] = useState(asked?.tab === "diagnostic" && !structural ? "diagnostic" : "validator");
  const [selectedRule, setSelectedRule] = useState(asked?.rule || null);
  const [revealToken, setRevealToken] = useState(asked?.rule ? 1 : 0);
  const [selectedAudit, setSelectedAudit] = useState(null);
  // With an error, the report opens on the errors alone: warnings and infos stay one click away, their figures dimmed.
  // The filter follows the report (all once the last error is gone) until the person sets it, or asked for a rule.
  const filterChosenRef = useRef(Boolean(asked));
  const hasErrors = useMemo(() => flattenErrors(report.errors).some((f) => !f.resolvedByImport && (f.severity || "error") === "error"), [report.errors]);
  const [severityFilter, setSeverityFilter] = useState(() => new Set(!asked && hasErrors ? ["error"] : SEVERITIES));
  useEffect(() => {
    if (!filterChosenRef.current) setSeverityFilter(new Set(hasErrors ? ["error"] : SEVERITIES));
  }, [hasErrors]);
  const [fileFilter, setFileFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [revalidating, setRevalidating] = useState(false);
  const [toast, setToast] = useState(null);
  const [fixQueueOpen, setFixQueueOpen] = useState(false);
  const [safeBusy, setSafeBusy] = useState(false);
  const [keepBusy, setKeepBusy] = useState(false);
  const [compared, setCompared] = useState(null);
  const [safeSpentAt, setSafeSpentAt] = useState(null);
  const searchInputRef = useRef(null);

  const crashedChecks = [...new Set((report?.incomplete?.crashes || []).map((c) => c.validator).filter(Boolean))];

  // Findings the tolerant import already settled (exact duplicates folded) are said apart and left out of every tally.
  const { activeFindings, autoFixedFindings } = useMemo(() => {
    const all = flattenErrors(report.errors);
    return { activeFindings: all.filter((f) => !f.resolvedByImport), autoFixedFindings: all.filter((f) => f.resolvedByImport) };
  }, [report.errors]);
  const { findingCounts, ruleCounts } = useMemo(() => tallyOf(activeFindings), [activeFindings]);
  const check = useReportCheck({ stale, staleReason, checking: revalidating || backgroundValidating, errors: findingCounts.error || 0 });
  const totalFindings = useMemo(() => activeFindings.reduce((n, f) => n + weightOf(f), 0), [activeFindings]);
  const allClear = totalFindings === 0;
  const allGroups = useMemo(() => groupByRule(activeFindings), [activeFindings]);

  const fileCounts = useMemo(() => {
    const counts = {};
    activeFindings.forEach((f) => {
      if (f.fileName && f.fileName !== "(unknown)") counts[f.fileName] = (counts[f.fileName] || 0) + weightOf(f);
    });
    return counts;
  }, [activeFindings]);

  const groups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const kept = activeFindings.filter((f) => {
      if (!severityFilter.has(f.severity || "error")) return false;
      if (fileFilter && f.fileName !== fileFilter) return false;
      return !q || searchTextOf(f, titleOf(f.ruleCode)).includes(q);
    });
    return groupByRule(kept);
  }, [activeFindings, severityFilter, fileFilter, searchQuery, titleOf]);
  const current = groups.find((g) => g.ruleCode === selectedRule) || groups[0] || null;
  const currentAudit = audit.findings.find((f) => f.code === selectedAudit) || audit.findings[0] || null;

  // The findings the duplicates cause, settled with them: those that name a row of theirs.
  const duplicateErrors = useMemo(() => {
    const ids = new Set(duplicates.groups.flatMap((g) => g.ids));
    return ids.size ? activeFindings.filter((f) => !f.aggregate && (f.severity || "error") === "error" && ids.has(f.asideId)).length : 0;
  }, [duplicates.groups, activeFindings]);

  const queueFindings = useMemo(() => groups.flatMap((g) => g.occurrences.filter((o) => isFixableFinding(o))), [groups]);
  // A repair that settled nothing leaves the rest to the person: the button comes back with the next edit.
  const safeCount = useMemo(() => (safeSpentAt === dataVersion ? 0 : safeRepairCountOf(activeFindings)), [activeFindings, safeSpentAt, dataVersion]);

  const clearAllFilters = useCallback(() => {
    filterChosenRef.current = true;
    setSeverityFilter(new Set(SEVERITIES));
    setFileFilter("");
    setSearchQuery("");
  }, []);

  const toggleSeverity = useCallback((sev) => {
    filterChosenRef.current = true;
    setSeverityFilter((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) {
        if (next.size > 1) next.delete(sev);
      } else next.add(sev);
      return next;
    });
  }, []);

  const showRule = useCallback(
    (ruleCode) => {
      clearAllFilters();
      setTab("validator");
      setSelectedRule(ruleCode);
      setRevealToken((n) => n + 1);
    },
    [clearAllFilters],
  );

  // Edit mode first. On the reader it takes the person to the network's draft, where this report stands again and
  // carries the act out once edit mode is on there.
  const inEditMode = async (act) => {
    if (editing) return true;
    const entered = await enterEditMode();
    if (entered?.moved) askActAfterMove("report", act);
    return Boolean(entered?.ok);
  };

  // Every safe repair at once: one edit, undone like any other; the report is read again in the background.
  const applySafeRepairs = async () => {
    if (!(await inEditMode("safe"))) return;
    setSafeBusy(true);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/quickfix/apply-safe`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const action = refusalToAction(refusalOf(body, res.status), t);
        setToast({ severity: "warning", message: action.body || action.title });
        return;
      }
      const left = Object.values(body.distances?.skipped || {}).reduce((n, k) => n + (Number(k) || 0), 0);
      const leftWords = left > 0 ? countWords(t, "validation.safe.left", left, { count: left }) : null;
      if (body.applied > 0) {
        const done = countWords(t, "validation.safe.done", body.applied, { count: body.applied });
        recordEdit(leftWords ? `${done}. ${leftWords}` : done, body.validation);
      } else {
        setSafeSpentAt(dataVersion);
        setToast({ severity: "info", message: leftWords ? `${t("validation.safe.none")} ${leftWords}` : t("validation.safe.none") });
      }
    } catch (err) {
      setToast({ severity: "warning", message: err.message });
    } finally {
      setSafeBusy(false);
    }
  };

  // The duplicates settled: the copies the network shows kept (the others leave the GTFS), or the others used in their
  // place. Asked from the reader, the draft opens first and the act, its rows with it, is carried out there.
  const settleDuplicates = async (way, ids = null) => {
    if (!(await inEditMode(ids ? `${way}:${ids.join(",")}` : way))) return;
    setKeepBusy(true);
    const touched = (ids || duplicates.groups.flatMap((g) => g.ids)).map((id) => ({ entity: "aside", entityId: String(id) }));
    try {
      if (way === "useCopies") {
        const body = await takeDuplicateCopies(ids);
        if (body.admitted > 0) recordEdit(countWords(t, "duplicates.used", body.admitted, { count: body.admitted }), body.validation, { touched });
        else setToast({ severity: "info", message: t("validation.aside.keptNone") });
      } else {
        const body = await keepLoadedVersions(ids);
        if (body.discarded > 0) recordEdit(countWords(t, "validation.aside.keptLoadedAll", body.discarded, { count: body.discarded }), body.validation, { touched });
        else setToast({ severity: "info", message: t("validation.aside.keptNone") });
      }
      setCompared(null);
    } catch (err) {
      const action = refusalToAction(refusalOf(err), t);
      setToast({ severity: "warning", message: action.body || action.title });
    } finally {
      setKeepBusy(false);
    }
  };
  const rowsOf = (arg) => (arg ? arg.split(",").map(Number).filter(Number.isInteger) : null);

  const startQueue = async () => {
    if (await inEditMode("queue")) setFixQueueOpen(true);
  };

  const askAiAll = () =>
    window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail: { message: t(allClear ? "audit.aiRepairAllPrompt" : "validation.aiRepairAll.prompt") } }));

  // An act asked on the reader's report, carried out here once the draft's edit mode is on.
  const actsRef = useRef({});
  actsRef.current = {
    safe: applySafeRepairs,
    queue: startQueue,
    keepShown: (arg) => settleDuplicates("keepShown", rowsOf(arg)),
    useCopies: (arg) => settleDuplicates("useCopies", rowsOf(arg)),
  };
  useEffect(() => {
    if (!editing) return;
    const act = takeActAfterMove("report");
    if (!act) return;
    const [name, arg] = String(act).split(":");
    if (actsRef.current[name]) actsRef.current[name](arg);
  }, [editing]);

  // Validates the session's current database (read-only works too); the fresh report is lifted to GTFSApp so every
  // screen shows the same one.
  const handleRevalidate = useCallback(async () => {
    if (revalidating) return;
    setRevalidating(true);
    const startedAt = Date.now();
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/validate`, { method: "POST" });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const fresh = await res.json();
      if (onReportRefreshed) onReportRefreshed(fresh, startedAt);
      setToast({ severity: "success", message: t("validation.revalidate.toastDone") });
    } catch (err) {
      setToast({ severity: "warning", message: err.isRateLimit || err.status === 429 ? t("validation.revalidate.rateLimited") : t("validation.revalidate.failed") });
    } finally {
      setRevalidating(false);
    }
  }, [revalidating, onReportRefreshed, t]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setTab("validator");
        setTimeout(() => searchInputRef.current?.focus(), 0);
        return;
      }
      const el = document.activeElement;
      const typing = el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable;
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key === "1") toggleSeverity("error");
        if (e.key === "2") toggleSeverity("warning");
        if (e.key === "3") toggleSeverity("info");
      }
      if (e.key === "Escape" && el === searchInputRef.current) setSearchQuery("");
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSeverity]);

  const baselineErrors = baselineCounts ? baselineCounts.errors || 0 : 0;
  const fixedErrors = Math.max(0, baselineErrors - findingCounts.error);
  const progress = editing && findingCounts.error > 0 && fixedErrors > 0 ? { fixed: fixedErrors, total: baselineErrors } : null;
  const canExport = editing && findingCounts.error === 0 && baselineErrors > 0;
  const aiShown = chatEnabled && (!allClear || audit.active.length > 0);
  // « Les voir » opens the duplicates first: the one rule whose rows the report settles at once.
  const asideGroup = useMemo(() => {
    const duplicates = allGroups.find((g) => g.ruleCode === "duplicate_key");
    if (duplicates && (aside.duplicates > 0 || duplicates.occurrences.some((o) => o.asideId))) return duplicates;
    return allGroups.find((g) => g.occurrences.some((o) => o.asideId)) || null;
  }, [allGroups, aside.duplicates]);

  const lock = <LockOutlinedIcon sx={{ fontSize: 16 }} />;
  const act = (primary) => ({
    height: 40,
    px: primary ? 2 : 1.5,
    borderRadius: "8px",
    fontSize: primary ? "0.875rem" : "0.84rem",
    fontWeight: 600,
    textTransform: "none",
    whiteSpace: "nowrap",
    flexShrink: 0,
    ...(primary ? {} : { borderColor: theme.palette.divider, "&:hover": { borderColor: alpha(theme.palette.text.primary, 0.3), bgcolor: theme.palette.action.hover } }),
  });
  const queueButton = (primary) => (
    <Button
      variant={primary ? "contained" : "outlined"}
      color={primary ? "primary" : "inherit"}
      disableElevation
      onClick={gated(startQueue)}
      data-testid="fix-queue-start"
      data-locked={editLock ? "1" : undefined}
      startIcon={editLock ? lock : <AutoFixHighIcon sx={{ fontSize: 17 }} />}
      sx={act(primary)}
    >
      {t("validation.fixQueue.start", { count: queueFindings.length })}
    </Button>
  );
  const queueShown = queueFindings.length > 0 && !fixQueueOpen;
  const primary =
    safeCount > 0 ? (
      <Tooltip title={t("validation.safe.hint")}>
        <span>
          <Button
            variant="contained"
            disableElevation
            onClick={gated(applySafeRepairs)}
            disabled={safeBusy}
            data-testid="safe-repairs"
            data-locked={editLock ? "1" : undefined}
            startIcon={editLock ? lock : safeBusy ? <CircularProgress size={15} color="inherit" /> : <CleaningServicesRoundedIcon sx={{ fontSize: 17 }} />}
            sx={act(true)}
          >
            {countWords(t, "validation.safe.button", safeCount, { count: safeCount })}
          </Button>
        </span>
      </Tooltip>
    ) : queueShown ? (
      queueButton(true)
    ) : canExport ? (
      <Button variant="contained" disableElevation onClick={() => window.dispatchEvent(new CustomEvent(OPEN_EXPORT_PREFLIGHT_EVENT))} data-testid="report-export" startIcon={<FileDownloadOutlinedIcon sx={{ fontSize: 18 }} />} sx={act(true)}>
        {t("validation.rescue.exportCta")}
      </Button>
    ) : null;
  const actions =
    primary || aiShown ? (
      <>
        {safeCount > 0 && queueShown && queueButton(false)}
        {aiShown && (
          <Tooltip title={t("validation.aiRepairAll.button")}>
            <IconButton
              onClick={gated(askAiAll)}
              aria-label={t("validation.aiRepairAll.button")}
              data-testid="ai-repair-all"
              data-locked={editLock ? "1" : undefined}
              sx={{ width: 40, height: 40, borderRadius: "8px", border: `1px solid ${alpha(theme.palette.ai.main, 0.35)}`, color: theme.palette.ai.main, bgcolor: alpha(theme.palette.ai.main, theme.palette.mode === "dark" ? 0.14 : 0.08), "&:hover": { bgcolor: alpha(theme.palette.ai.main, theme.palette.mode === "dark" ? 0.2 : 0.14) } }}
            >
              {editLock ? lock : <AutoAwesomeIcon sx={{ fontSize: 19 }} />}
            </IconButton>
          </Tooltip>
        )}
        {primary}
      </>
    ) : null;

  const tabTone = (key) =>
    key === "diagnostic" ? theme.palette.ai.main : findingCounts.error ? theme.palette.severities.error.main : findingCounts.warning ? theme.palette.severities.warning.main : allClear ? theme.palette.success.main : theme.palette.severities.info.main;
  const tabButton = (key) => {
    const on = tab === key;
    const count = key === "validator" ? allGroups.length : audit.audit ? audit.active.length : null;
    return (
      <ButtonBase
        key={key}
        role="tab"
        id={`validation-tab-${key}`}
        aria-selected={on}
        aria-controls="validation-tab-panel"
        tabIndex={on ? 0 : -1}
        onClick={() => setTab(key)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          const next = TABS[(TABS.indexOf(key) + 1) % TABS.length];
          setTab(next);
          document.getElementById(`validation-tab-${next}`)?.focus();
        }}
        data-testid={`validation-tab-${key}`}
        sx={{ height: 42, px: 1.5, gap: 0.75, fontSize: "0.84rem", fontWeight: 600, color: on ? "text.primary" : "text.secondary", boxShadow: on ? `inset 0 -2px 0 ${theme.palette.primary.main}` : "none", "&:hover": { color: "text.primary" }, "&.Mui-focusVisible": { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: -2 } }}
      >
        {t(key === "validator" ? "validation.tab.validator" : "audit.title")}
        {count !== null && (
          <Box component="span" sx={{ minWidth: 22, height: 20, px: 0.75, borderRadius: 99, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: "0.72rem", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: tabTone(key), bgcolor: alpha(tabTone(key), theme.palette.mode === "dark" ? 0.2 : 0.11) }}>
            {count.toLocaleString()}
          </Box>
        )}
      </ButtonBase>
    );
  };

  const centred = { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1.25, px: 4, py: 6, textAlign: "center" };
  const clearState = (
    <Box data-testid="validation-all-clear" sx={centred}>
      <CheckCircleOutlineIcon sx={{ fontSize: 48, color: theme.palette.success.main }} />
      <Typography sx={{ fontSize: "1.05rem", fontWeight: 650 }}>{t("validation.allClear.title")}</Typography>
      <Typography sx={{ fontSize: "0.84rem", color: "text.secondary", maxWidth: 420 }}>{t("validation.allClear.body")}</Typography>
      {!structural && audit.active.length > 0 && (
        <Button size="small" onClick={() => setTab("diagnostic")} sx={{ mt: 0.5, textTransform: "none", fontWeight: 600 }}>
          {t("validation.allClear.toDiagnostic")}
        </Button>
      )}
    </Box>
  );

  return (
    <Box data-testid="validation-page" sx={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", bgcolor: "background.default", animation: `${fadeIn} 0.2s ease-out` }}>
      {/* Only a file refused at import gets this bar: re-uploading is then the one way on. */}
      {structural ? (
        <ValidationToolbar
          onReupload={onReupload}
          onBack={onBack}
          totalFindings={totalFindings}
          ruleCount={allGroups.length}
          filteredTotal={groups.reduce((n, g) => n + g.count, 0)}
          severityCounts={findingCounts}
          statusColor={findingCounts.error > 0 ? theme.palette.severities.error.main : theme.palette.success.main}
          onRevalidate={handleRevalidate}
          revalidating={revalidating}
        />
      ) : (
        <ReportHead
          findingCounts={findingCounts}
          ruleCounts={ruleCounts}
          severityFilter={severityFilter}
          onToggleSeverity={toggleSeverity}
          onRevalidate={handleRevalidate}
          revalidating={revalidating || backgroundValidating}
          engineVersion={report?.engine_version || null}
          progress={progress}
          actions={actions}
          check={check}
        />
      )}

      <DuplicatesCard
        groups={duplicates.groups}
        total={duplicates.total}
        errors={duplicateErrors}
        busy={keepBusy}
        onKeepAll={gated(() => settleDuplicates("keepShown"))}
        onCompare={setCompared}
      />
      {compared && (
        <DuplicatesCompareDialog
          group={compared}
          busy={keepBusy}
          onClose={() => setCompared(null)}
          onKeep={(ids) => gated(() => settleDuplicates("keepShown", ids))()}
          onUse={(ids) => gated(() => settleDuplicates("useCopies", ids))()}
        />
      )}

      <ReportNotices
        stale={structural ? stale : false}
        checking={backgroundValidating || revalidating}
        onRevalidate={handleRevalidate}
        asideTotal={Math.max(0, aside.total - aside.duplicates)}
        onShowAside={asideGroup ? () => showRule(asideGroup.ruleCode) : null}
        incomplete={report?.incomplete || null}
        crashedChecks={crashedChecks}
        autoFixedFindings={autoFixedFindings}
        importAdjustmentsTotal={Object.values(importAdjustments || {}).reduce((n, v) => n + (Number(v) || 0), 0)}
      />

      <Box sx={{ flex: 1, minHeight: 0, display: "flex" }}>
        <Box
          component="aside"
          aria-label={t("validation.list.label")}
          data-testid="validation-rules-pane"
          sx={{ width: "clamp(320px, 31vw, 440px)", flexShrink: 0, minHeight: 0, display: "flex", flexDirection: "column", bgcolor: "background.paper", borderRight: `1px solid ${theme.palette.divider}` }}
        >
          {!structural && (
            <Box role="tablist" aria-label={t("validation.tabs.label")} sx={{ flexShrink: 0, display: "flex", px: 1.5, borderBottom: `1px solid ${theme.palette.divider}` }}>
              {TABS.map(tabButton)}
            </Box>
          )}
          <Box id="validation-tab-panel" role={structural ? undefined : "tabpanel"} aria-labelledby={structural ? undefined : `validation-tab-${tab}`} sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {tab === "validator" ? (
              allClear ? (
                <Typography sx={{ px: 2.5, py: 2, fontSize: "0.84rem", color: "text.secondary" }}>{t("validation.list.none")}</Typography>
              ) : (
                <>
                  <RuleFilters searchQuery={searchQuery} onSearchChange={setSearchQuery} searchInputRef={searchInputRef} fileCounts={fileCounts} fileFilter={fileFilter} onFileChange={setFileFilter} />
                  <RuleList groups={groups} selected={current?.ruleCode || null} onSelect={setSelectedRule} titleOf={titleOf} quickFixes={quickFixes} onClearFilters={clearAllFilters} revealToken={revealToken} />
                </>
              )
            ) : (
              <AuditList audit={audit} selected={currentAudit?.code || null} onSelect={setSelectedAudit} />
            )}
          </Box>
        </Box>

        <Box component="section" aria-label={t("validation.detail.label")} sx={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
          {tab === "validator" ? (
            current ? (
              <RuleDetail key={current.ruleCode} group={current} titleOf={titleOf} descriptionOf={descriptionOf} quickFixCount={quickFixes?.get(current.ruleCode)?.count || 0} chatEnabled={chatEnabled} duplicatesPending={aside.duplicates > 0} />
            ) : allClear ? (
              clearState
            ) : (
              <Box sx={{ ...centred, color: "text.secondary" }}>
                <Typography sx={{ fontSize: "0.85rem" }}>{t("validation.empty.noMatches")}</Typography>
              </Box>
            )
          ) : currentAudit ? (
            <AuditDetail key={currentAudit.code} audit={audit} finding={currentAudit} />
          ) : audit.loading ? (
            <Box sx={centred}>
              <CircularProgress size={22} />
            </Box>
          ) : audit.clean ? (
            <Box sx={centred}>
              <CheckCircleOutlineIcon sx={{ fontSize: 48, color: theme.palette.success.main }} />
              <Typography sx={{ fontSize: "0.9rem", fontWeight: 600, maxWidth: 420 }}>{t("audit.clean")}</Typography>
            </Box>
          ) : null}
        </Box>
      </Box>

      {fixQueueOpen && <FixQueueBar findings={queueFindings} onClose={() => setFixQueueOpen(false)} />}

      <Snackbar open={Boolean(toast)} autoHideDuration={4000} onClose={() => setToast(null)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        {toast ? (
          <Alert severity={toast.severity} onClose={() => setToast(null)}>
            {toast.message}
          </Alert>
        ) : (
          <span />
        )}
      </Snackbar>
    </Box>
  );
}

export default ValidationErrorsPage;
