import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Alert,
  CircularProgress,
  Chip,
  Collapse,
  Checkbox,
  FormControlLabel,
  Divider,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
} from "@mui/material";
import { alpha, useTheme } from "@mui/material/styles";
import Slide from "@mui/material/Slide";
import PublishIcon from "@mui/icons-material/Publish";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { requestAccessLink, useFeatures } from "../../utils/featuresApi";
import { getRuleTitle } from "../validation/ruleCatalog";
import AiSummaryCard from "../common/AiSummaryCard";
import RefusalNotice from "../common/RefusalNotice";
import { readRefusal, refusalOf } from "../../utils/refusalToAction";
import { resolveDelivery } from "../../utils/projectStore";
import { VALIDATION_REFRESHED_EVENT } from "../../utils/appEvents";

const SlideUp = React.forwardRef(function SlideUp(props, ref) {
  return <Slide direction="up" ref={ref} {...props} />;
});

/**
 * Counts per severity and the top rules grouped by ruleCode across files (`report.errors` is keyed by file name),
 * each with one sample finding. Info findings are advisories: never counted as errors, never blocking.
 * `errorRules` is every error rule; the new errors of a held delivery are picked from it.
 */
function parseReport(report, topN) {
  if (!report?.errors) {
    return {
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      topErrors: [],
      topWarnings: [],
      topInfos: [],
      errorRules: [],
    };
  }

  let eCount = 0;
  let wCount = 0;
  let iCount = 0;
  const errorsMap = new Map();
  const warningsMap = new Map();
  const infosMap = new Map();

  // Same weighting as utils/validationSummary.js: an aggregate tail marker counts for the occurrences it stands
  // for; findings resolved at import are not outstanding work.
  const weightOf = (f) =>
    f.aggregate ? Math.max(0, Number(f.aggregateCount) || 0) : 1;
  const addTo = (map, f, file) => {
    const rc = f.ruleCode || "unspecified";
    const existing = map.get(rc);
    if (existing) {
      existing.count += weightOf(f);
    } else {
      map.set(rc, {
        ruleCode: rc,
        count: weightOf(f),
        file,
        sampleMessage: f.message || "",
        sampleEntityId: f.entityId || null,
        sampleLineNumber: f.lineNumber || null,
      });
    }
  };

  Object.entries(report.errors).forEach(([fileName, findings]) => {
    if (!Array.isArray(findings)) return;
    findings.forEach((f) => {
      // A finding without a severity is an error.
      if (!f || f.resolvedByImport) return;
      const sev = (f.severity || "error").toLowerCase();
      if (sev === "info") {
        iCount += weightOf(f);
        addTo(infosMap, f, fileName);
      } else if (sev === "warning") {
        wCount += weightOf(f);
        addTo(warningsMap, f, fileName);
      } else {
        eCount += weightOf(f);
        addTo(errorsMap, f, fileName);
      }
    });
  });

  const sorted = (map) => Array.from(map.values()).sort((a, b) => b.count - a.count);
  const toTop = (map) => sorted(map).slice(0, topN);

  return {
    errorCount: eCount,
    warningCount: wCount,
    infoCount: iCount,
    topErrors: toTop(errorsMap),
    topWarnings: toTop(warningsMap),
    topInfos: toTop(infosMap),
    errorRules: sorted(errorsMap),
  };
}

/**
 * The delivery's preflight before any GTFS export: a fresh POST /edit/validate and the export gate's decision on
 * the same feed (the report's `delivery`). Clean → « Deliver »; only errors the feed already had → « Deliver » with
 * them stated, never the green "compliant" screen; warnings only → « Deliver despite N warning(s) »; new errors →
 * blocked, listed by rule (before → after) with the way to repair (an error is fixed, never accepted); no verified
 * report (503, a failure, no answer) → blocked in place. In a shared project a version is delivered only once
 * approved. The delivery runs with the dialog open: the host closes it on success, and a refusal of the export
 * (503 VALIDATOR_FAILED, 422 VALIDATION_NEW_ERRORS) is rendered here by RefusalNotice, never in a snackbar.
 */
function ExportPreflightDialog({ open, onClose, onConfirmExport, onReviewErrors }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { editing } = useEditMode();
  const { features } = useFeatures();
  // "Notify the administrator": the server's request link only (mailto: or https:), never an address written here.
  const adminLink = requestAccessLink(features?.access?.request_access_url || features?.request_access_url || null);

  const [validating, setValidating] = useState(false);
  const [report, setReport] = useState(null);
  const [validationError, setValidationError] = useState(null); // a refusal of /edit/validate (refusalOf): blocked
  const [isRateLimited, setIsRateLimited] = useState(false);
  const [validatedAt, setValidatedAt] = useState(null);
  const [elapsed, setElapsed] = useState(0); // Seconds since validatedAt.
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [showRiskConfirm, setShowRiskConfirm] = useState(false);
  // AI release notes: generated on demand, optionally shipped in the zip.
  const [changelogReady, setChangelogReady] = useState(false);
  const [includeChangelog, setIncludeChangelog] = useState(true);
  // The delivery in progress ("gtfs" | null) and its refusal, rendered in place.
  const [exporting, setExporting] = useState(null);
  const [exportRefusal, setExportRefusal] = useState(null);
  const lastExportRef = useRef(null);
  // A shared project's version is delivered only once approved: why the delivery waits, said in place.
  const [approvalBlock, setApprovalBlock] = useState(null);

  const elapsedTimerRef = useRef(null);

  const runValidation = useCallback(async () => {
    setValidating(true);
    setValidationError(null);
    setExportRefusal(null);
    setIsRateLimited(false);
    setReport(null);
    setRiskAccepted(false);
    setShowRiskConfirm(false);

    try {
      const startedAt = Date.now();
      const res = await fetchWithSession(`${API_BASE_URL}/edit/validate`, {
        method: "POST",
      });

      if (res.status === 429) {
        setIsRateLimited(true);
        setValidating(false);
        return;
      }

      if (!res.ok) {
        // 503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED, or anything else: blocked, said in place.
        setValidationError(await readRefusal(res));
        setValidating(false);
        return;
      }
      const body = await res.json();
      // An unverified report proves nothing, so nothing is delivered.
      if (body?.unverified || body?.valid == null) {
        setValidationError({ code: "VALIDATOR_UNAVAILABLE", status: 503, message: "", details: { reason: "unverified" } });
        setValidating(false);
        return;
      }

      setReport(body);
      setValidatedAt(Date.now());
      setElapsed(0);
      // The fresh report goes to the rest of the app (header badge, validation page, AI context),
      // so no other screen keeps showing the upload-time counts.
      window.dispatchEvent(
        new CustomEvent(VALIDATION_REFRESHED_EVENT, { detail: { report: body, startedAt } }),
      );
    } catch (err) {
      console.error("ExportPreflightDialog: validation fetch failed", err);
      setValidationError(refusalOf(err));
    } finally {
      setValidating(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      setReport(null);
      setValidationError(null);
      setIsRateLimited(false);
      setValidatedAt(null);
      setElapsed(0);
      setRiskAccepted(false);
      setShowRiskConfirm(false);
      setExportRefusal(null);
      setExporting(null);
      setApprovalBlock(null);
      return;
    }
    runValidation();
    let live = true;
    resolveDelivery().then((d) => live && setApprovalBlock(d?.blocked || null));
    return () => {
      live = false;
    };
  }, [open, runValidation]);

  useEffect(() => {
    if (!validatedAt) return;

    elapsedTimerRef.current = setInterval(() => {
      setElapsed(Math.round((Date.now() - validatedAt) / 1000));
    }, 1000);

    return () => clearInterval(elapsedTimerRef.current);
  }, [validatedAt]);

  // The report is flagged stale after 30 s (`isStale`) but never re-run by itself: a re-run would wipe the report
  // and the risk checkbox while the person reads them. Re-validation is explicit or on reopen.

  // Info findings (advisories) never block, but are listed with the warnings so they are seen at a glance.
  const parsed = report
    ? parseReport(report, 10)
    : { errorCount: 0, warningCount: 0, infoCount: 0, topErrors: [], topWarnings: [], topInfos: [] };
  const { errorCount, warningCount, infoCount } = parsed;
  const top3Warnings = parsed.topWarnings.slice(0, 3);
  const top3Infos = parsed.topInfos.slice(0, 3);

  const isStale = editing && elapsed > 30;
  // What the export gate will decide (the server's `delivery`): with a baseline only new errors hold the export;
  // without one, any error does.
  const delivery = report?.delivery && typeof report.delivery === "object" ? report.delivery : null;
  const newErrorRules = Array.isArray(delivery?.new_errors) ? delivery.new_errors : [];
  const hasErrors = Boolean(report) && (delivery ? delivery.exportable === false : errorCount > 0);
  // Held by new errors against the baseline of ingest: only those are the person's (after − before per rule).
  const heldByNew = hasErrors && delivery?.baseline === true && newErrorRules.length > 0;
  const addedOf = (e) => Math.max(0, (Number(e.after) || 0) - (Number(e.before) || 0));
  const newCount = newErrorRules.reduce((n, e) => n + addedOf(e), 0);
  const headlineCount = heldByNew ? newCount : errorCount;
  // The errors the feed already had: the info line, never imputed.
  const preexisting = !hasErrors && errorCount > 0 ? Number(delivery?.preexisting) || errorCount : heldByNew ? Number(delivery?.preexisting) || 0 : 0;
  // The rules listed under the headline: with a baseline, the new errors only (their added count).
  const top5Errors = heldByNew
    ? newErrorRules.slice(0, 5).map((e) => {
        const rule = parsed.errorRules.find((r) => r.ruleCode === e.code);
        return { ...(rule || { ruleCode: e.code, file: "", sampleMessage: "", sampleEntityId: null, sampleLineNumber: null }), count: addedOf(e) || rule?.count || 0 };
      })
    : parsed.topErrors.slice(0, 5);
  // Clean: no error and no warning; info findings alone are advisory. Errors the feed already had are not the
  // person's, but not "compliant" either: their own case below.
  const isClean = Boolean(report) && !hasErrors && errorCount === 0 && warningCount === 0;
  const preexistingOnly = Boolean(report) && !hasErrors && errorCount > 0 && warningCount === 0;
  const hasWarningsOnly = Boolean(report) && !hasErrors && warningCount > 0;
  const busy = validating || Boolean(exporting);

  const exportOptions = () => ({ changelog: changelogReady && includeChangelog });

  const deliver = async (format, options) => {
    if (exporting) return;
    lastExportRef.current = { format, options };
    setExportRefusal(null);
    setExporting(format);
    try {
      const result = await onConfirmExport(format, options);
      if (result && result.ok === false) setExportRefusal(result.refusal || refusalOf(null));
    } catch (err) {
      setExportRefusal(refusalOf(err));
    } finally {
      setExporting(null);
    }
  };

  const handleExportNow = () => deliver("gtfs", exportOptions());

  const handleReviewClick = () => {
    onReviewErrors();
  };

  // The actions of a refused delivery: try the same delivery again (a refusal of the validator's
  // report is re-checked by a fresh validation), notify the administrator, or go and fix the errors.
  const onExportRefusalAction = (id) => {
    const code = exportRefusal?.code;
    if (id === "retry") {
      if (code === "VALIDATION_NEW_ERRORS" || code === "VALIDATION_ERRORS") runValidation();
      else if (lastExportRef.current) deliver(lastExportRef.current.format, lastExportRef.current.options);
    } else if (id === "notifyAdmin" && adminLink) window.open(adminLink, "_blank", "noopener");
    else if (id === "repair" || id === "backToChange") handleReviewClick();
  };

  const spinner = (format) => (exporting === format ? <CircularProgress size={14} color="inherit" /> : null);

  const tReplace = (key, vars) => {
    let str = t(key);
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        str = str.replace(`{${k}}`, v);
      });
    }
    return str;
  };

  const renderRuleList = (rules, color) => (
    <List dense disablePadding sx={{ mt: 1 }}>
      {rules.map(({ ruleCode, count, file, sampleMessage, sampleEntityId, sampleLineNumber }) => {
        const title = getRuleTitle(ruleCode) || ruleCode;
        const excerpt = sampleMessage
          ? sampleMessage.split(/[.!]\s/)[0].slice(0, 140)
          : "";
        return (
          <ListItem key={ruleCode} disableGutters alignItems="flex-start" sx={{ py: 0.5 }}>
            <ListItemIcon sx={{ minWidth: 18, mt: 0.75 }}>
              <FiberManualRecordIcon sx={{ fontSize: 8, color }} />
            </ListItemIcon>
            <ListItemText
              primary={
                <Box display="flex" alignItems="center" gap={1}>
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: 600,
                      color: theme.palette.text.primary,
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={title}
                  >
                    {title}
                  </Typography>
                  {/* The file the notice is about; « (unknown) » (a notice of the whole feed) says nothing: no chip. */}
                  {file && !/^\(?unknown\)?$/i.test(file) ? (
                    <Chip
                      label={file}
                      size="small"
                      variant="outlined"
                      sx={{
                        height: 18,
                        fontSize: "0.6rem",
                        fontFamily: "monospace",
                        color: theme.palette.text.secondary,
                        borderColor: alpha(color, 0.3),
                      }}
                    />
                  ) : null}
                  <Chip
                    label={count}
                    size="small"
                    sx={{
                      height: 18,
                      fontSize: "0.65rem",
                      fontWeight: 700,
                      backgroundColor: alpha(color, 0.15),
                      color,
                    }}
                  />
                </Box>
              }
              secondary={
                excerpt ? (
                  <Typography
                    variant="caption"
                    component="span"
                    sx={{
                      display: "block",
                      color: theme.palette.text.secondary,
                      fontSize: "0.72rem",
                      mt: 0.25,
                      lineHeight: 1.35,
                    }}
                  >
                    {excerpt}
                    {sampleEntityId && (
                      <Box
                        component="span"
                        sx={{
                          fontFamily: "monospace",
                          ml: 0.5,
                          color: theme.palette.text.disabled,
                        }}
                      >
                        {" "}({sampleEntityId}
                        {sampleLineNumber ? `:L${sampleLineNumber}` : ""})
                      </Box>
                    )}
                  </Typography>
                ) : null
              }
              secondaryTypographyProps={{ component: "div" }}
            />
          </ListItem>
        );
      })}
    </List>
  );

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown={busy}
      TransitionComponent={SlideUp}
      PaperProps={{
        sx: {
          borderRadius: 2.5,
          borderTop: `3px solid ${
            hasErrors
              ? theme.palette.error.main
              : hasWarningsOnly
                ? theme.palette.warning.main
                : preexistingOnly
                  ? theme.palette.info.main
                  : theme.palette.success.main
          }`,
          transition: "border-color 0.3s ease",
        },
      }}
    >
      <DialogTitle
        sx={{
          display: "flex",
          alignItems: "flex-start",
          gap: 1.5,
          pb: 0.5,
        }}
      >
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: 2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            background: alpha(theme.palette.primary.main, 0.12),
            color: theme.palette.primary.main,
          }}
        >
          <PublishIcon sx={{ fontSize: 22 }} />
        </Box>
        <Box>
          <Typography variant="h6" fontWeight={700} lineHeight={1.2}>
            {t("export.preflight.title")}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {t("export.preflight.subtitle")}
          </Typography>
        </Box>

        {report && !validating && (
          <Box sx={{ ml: "auto", display: "flex", alignItems: "center" }}>
            {isStale ? (
              <Chip
                label={t("export.preflight.staleValidation")}
                size="small"
                icon={<RefreshIcon sx={{ fontSize: 12 }} />}
                onClick={runValidation}
                data-testid="export-revalidate"
                sx={{
                  cursor: "pointer",
                  height: 20,
                  fontSize: "0.65rem",
                  backgroundColor: alpha(theme.palette.warning.main, 0.12),
                  color: theme.palette.warning.main,
                }}
              />
            ) : (
              <Chip
                label={t("export.preflight.freshValidation")}
                size="small"
                sx={{
                  height: 20,
                  fontSize: "0.65rem",
                  backgroundColor: alpha(theme.palette.success.main, 0.1),
                  color: theme.palette.success.main,
                }}
              />
            )}
          </Box>
        )}
      </DialogTitle>

      <Divider sx={{ mx: 3, mt: 1, opacity: 0.5 }} />

      <DialogContent sx={{ pt: 2 }}>

        {validating && (
          <Box
            display="flex"
            flexDirection="column"
            alignItems="center"
            py={3}
            gap={2}
          >
            <CircularProgress size={40} thickness={3} />
            <Typography variant="body2" color="text.secondary">
              {t("export.preflight.validating")}
            </Typography>
          </Box>
        )}

        {isRateLimited && !validating && (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            action={
              <Button
                size="small"
                color="warning"
                variant="outlined"
                onClick={runValidation}
              >
                {t("refusal.default.action")}
              </Button>
            }
          >
            {t("export.preflight.rateLimitHit")}
          </Alert>
        )}

        {validationError && !validating && (
          <RefusalNotice refusal={validationError} onAction={(id) => (id === "retry" ? runValidation() : id === "notifyAdmin" && adminLink ? window.open(adminLink, "_blank", "noopener") : null)} supported={adminLink ? ["retry", "notifyAdmin"] : ["retry"]} sx={{ mb: 2 }} />
        )}

        {/* Errors the feed already had: not imputed, not blocking. */}
        {preexisting > 0 && !validating && (
          <Alert severity="info" sx={{ mb: 1.5 }} data-testid="export-preexisting">
            {t("network.reference.preexisting", { count: preexisting })}
          </Alert>
        )}

        {/* Case 1: clean. */}
        {isClean && !validating && (
          <Box
            display="flex"
            flexDirection="column"
            alignItems="center"
            py={2}
            gap={1.5}
          >
            <CheckCircleIcon
              sx={{ fontSize: 56, color: theme.palette.success.main }}
            />
            <Typography variant="h6" fontWeight={700} textAlign="center">
              {t("export.preflight.cleanTitle")}
            </Typography>
            <Typography
              variant="body2"
              color="text.secondary"
              textAlign="center"
            >
              {t("export.preflight.cleanBody")}
            </Typography>
          </Box>
        )}

        {/* Case 1b: only errors the feed already had: no new error, yet not "compliant". */}
        {preexistingOnly && !validating && (
          <Box display="flex" alignItems="center" gap={1.5} py={1} data-testid="export-no-new-errors">
            <InfoOutlinedIcon sx={{ fontSize: 32, color: theme.palette.info.main }} />
            <Box>
              <Typography variant="subtitle1" fontWeight={700}>
                {t("delivery.noNewErrors.title", { count: preexisting })}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {t("delivery.noNewErrors.body")}
              </Typography>
            </Box>
          </Box>
        )}

        {/* Advisories (info), in any case, never blocking. */}
        {infoCount > 0 && !validating && (
          <Box mt={isClean ? 2 : 1.5}>
            <Box display="flex" alignItems="center" gap={1} mb={0.75}>
              <Typography
                variant="caption"
                sx={{
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: theme.palette.text.secondary,
                  fontSize: "0.68rem",
                }}
              >
                {tReplace("export.preflight.infosTitle", { n: infoCount })}
              </Typography>
              <Chip
                label={infoCount}
                size="small"
                sx={{
                  height: 16,
                  fontSize: "0.6rem",
                  fontWeight: 700,
                  backgroundColor: alpha(theme.palette.info.main, 0.12),
                  color: theme.palette.info.main,
                }}
              />
            </Box>
            {top3Infos.length > 0 && (
              <Box
                sx={{
                  borderRadius: 1.5,
                  backgroundColor: alpha(theme.palette.info.main, 0.04),
                  border: `1px solid ${alpha(theme.palette.info.main, 0.18)}`,
                  px: 1.5,
                  py: 0.75,
                }}
              >
                {renderRuleList(top3Infos, theme.palette.info.main)}
              </Box>
            )}
          </Box>
        )}

        {/* Case 2: warnings only. */}
        {hasWarningsOnly && !validating && (
          <Box py={1}>
            <Box display="flex" alignItems="center" gap={1.5} mb={1.5}>
              <WarningAmberIcon
                sx={{ fontSize: 32, color: theme.palette.warning.main }}
              />
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  {tReplace(
                    warningCount === 1
                      ? "export.preflight.warningsTitle.singular"
                      : "export.preflight.warningsTitle.plural",
                    { n: warningCount },
                  )}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {t("export.preflight.warningsBody")}
                </Typography>
              </Box>
            </Box>
            {top3Warnings.length > 0 && (
              <Box
                sx={{
                  borderRadius: 1.5,
                  backgroundColor: alpha(theme.palette.warning.main, 0.05),
                  border: `1px solid ${alpha(theme.palette.warning.main, 0.2)}`,
                  px: 1.5,
                  py: 1,
                }}
              >
                {renderRuleList(top3Warnings, theme.palette.warning.main)}
              </Box>
            )}
          </Box>
        )}

        {/* Case 3: errors. */}
        {hasErrors && !validating && (
          <Box py={1}>
            <Box display="flex" alignItems="center" gap={1.5} mb={1.5}>
              <ErrorOutlineIcon
                sx={{ fontSize: 32, color: theme.palette.error.main }}
              />
              <Box>
                {/* With a baseline, the headline counts the new errors only. */}
                <Typography variant="subtitle1" fontWeight={700} data-testid="export-errors-title">
                  {heldByNew
                    ? t("delivery.newErrorsTitle", { count: newCount })
                    : tReplace(
                        errorCount === 1
                          ? "export.preflight.errorsTitle.singular"
                          : "export.preflight.errorsTitle.plural",
                        { n: errorCount },
                      )}
                </Typography>
                <Typography
                  variant="body2"
                  color="error.main"
                  fontWeight={500}
                >
                  {heldByNew ? t("delivery.newErrorsBody") : t("export.preflight.errorsBody")}
                </Typography>
              </Box>
            </Box>
            {top5Errors.length > 0 && (
              <Box
                sx={{
                  borderRadius: 1.5,
                  backgroundColor: alpha(theme.palette.error.main, 0.05),
                  border: `1px solid ${alpha(theme.palette.error.main, 0.2)}`,
                  px: 1.5,
                  py: 1,
                  mb: 2,
                }}
              >
                {renderRuleList(top5Errors, theme.palette.error.main)}
              </Box>
            )}
            {newErrorRules.length > 0 && (
              <Box data-testid="export-new-errors" sx={{ mb: 1.5 }}>
                <Typography variant="body2" fontWeight={600}>
                  {t("gtfsCheck.newErrors", { count: newErrorRules.length })}
                </Typography>
                {newErrorRules.slice(0, 10).map((e) => (
                  <Typography key={e.code} variant="caption" component="p" lang="en" sx={{ fontFamily: "monospace", color: "text.secondary" }}>
                    {e.code} ({e.before} → {e.after})
                  </Typography>
                ))}
              </Box>
            )}

            <Collapse in={showRiskConfirm}>
              <Alert
                severity="error"
                variant="outlined"
                icon={false}
                sx={{ mt: 1 }}
              >
                <FormControlLabel
                  control={
                    <Checkbox
                      size="small"
                      checked={riskAccepted}
                      onChange={(e) => setRiskAccepted(e.target.checked)}
                      inputProps={{ "data-testid": "export-risk-checkbox" }}
                      sx={{ color: theme.palette.error.main }}
                      color="error"
                    />
                  }
                  label={
                    <Typography variant="body2" fontWeight={500}>
                      {tReplace("export.preflight.acceptRisk", {
                        n: headlineCount,
                      })}
                    </Typography>
                  }
                  sx={{ m: 0, alignItems: "flex-start" }}
                />
              </Alert>
            </Collapse>
          </Box>
        )}

        {!validating && report && (
          <Box pt={1.5} data-testid="export-changelog">
            <AiSummaryCard
              kind="changelog"
              dense
              testId="export-changelog-card"
              title={t("export.changelog.title")}
              description={t("export.changelog.description")}
              generateLabel={t("export.changelog.generate")}
              onGenerated={() => setChangelogReady(true)}
            />
            <Collapse in={changelogReady}>
              <FormControlLabel
                control={
                  <Checkbox
                    size="small"
                    checked={includeChangelog}
                    onChange={(e) => setIncludeChangelog(e.target.checked)}
                    inputProps={{ "data-testid": "export-changelog-include" }}
                  />
                }
                label={
                  <Typography variant="body2">{t("export.changelog.include")}</Typography>
                }
                sx={{ m: 0, mt: 0.5 }}
              />
            </Collapse>
          </Box>
        )}

        {/* The delivery itself refused (503 VALIDATOR_FAILED, 422 VALIDATION_NEW_ERRORS…), in place. */}
        {exportRefusal && (
          <Box pt={1.5} data-testid="export-refusal">
            <RefusalNotice refusal={exportRefusal} onAction={onExportRefusalAction} supported={adminLink ? ["retry", "notifyAdmin", "repair", "backToChange"] : ["retry", "repair", "backToChange"]} />
          </Box>
        )}
      </DialogContent>

      {validatedAt && !validating && (
        <Box px={3} pb={0.5}>
          <Typography variant="caption" color="text.disabled">
            {tReplace("export.preflight.validatedAgo", { seconds: elapsed })}
          </Typography>
        </Box>
      )}

      <DialogActions sx={{ px: 3, py: 1.5, gap: 1, flexWrap: "wrap" }}>
        <Button onClick={onClose} color="inherit" disabled={busy}>
          {t("app.cancel")}
        </Button>

        {/* A shared project's version not approved yet: the delivery waits and says why. */}
        {approvalBlock && (
          <Typography id="export-approval-reason" data-testid="export-approval-reason" variant="caption" color="text.secondary" sx={{ width: "100%" }}>
            {t("delivery.package.needsApproval", { n: approvalBlock.n })}
          </Typography>
        )}

        {/* No verified report (503, a failure, the rate limit): nothing to deliver. */}

        {/* Case 1 clean (green) · case 1b no new error, pre-existing ones (not green). */}
        {(isClean || preexistingOnly) && !validating && (
          <Box sx={{ width: "100%", display: "flex", flexDirection: "column", gap: 1, mt: 0.5 }}>
            <Button
              variant="contained"
              color={isClean ? "success" : "primary"}
              autoFocus
              onClick={handleExportNow}
              fullWidth
              disabled={Boolean(exporting) || Boolean(approvalBlock)}
              aria-describedby={approvalBlock ? "export-approval-reason" : undefined}
              aria-busy={exporting === "gtfs"}
              startIcon={spinner("gtfs")}
              data-testid="export-confirm"
            >
              {t("delivery.deliver")}
            </Button>
          </Box>
        )}

        {/* Case 2: warnings only. */}
        {hasWarningsOnly && !validating && (
          <>
            <Box sx={{ flex: 1 }} />
            <Button
              variant="outlined"
              color="warning"
              onClick={handleReviewClick}
              disabled={Boolean(exporting)}
            >
              {t("export.preflight.reviewWarnings")}
            </Button>
            <Button
              variant="contained"
              color="primary"
              autoFocus
              onClick={handleExportNow}
              disabled={Boolean(exporting) || Boolean(approvalBlock)}
              aria-describedby={approvalBlock ? "export-approval-reason" : undefined}
              aria-busy={exporting === "gtfs"}
              startIcon={spinner("gtfs")}
              data-testid="export-confirm"
            >
              {t("delivery.deliverAnyway", { count: warningCount })}
            </Button>
          </>
        )}

        {/* Case 3: the server refuses the export (422) until the errors are fixed; a forced export needs the admin
            token, so it is not offered here: lead to the repair. */}
        {hasErrors && !validating && (
          <>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ flex: 1, minWidth: 0 }}
              data-testid="export-locked-hint"
            >
              {t("export.preflight.lockedHint", { count: newErrorRules.length ? newCount : errorCount })}
            </Typography>
            <Button
              variant="contained"
              color="primary"
              autoFocus
              onClick={handleReviewClick}
              data-testid="export-review-errors"
            >
              {t("gtfsCheck.fix")}
            </Button>
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default ExportPreflightDialog;
