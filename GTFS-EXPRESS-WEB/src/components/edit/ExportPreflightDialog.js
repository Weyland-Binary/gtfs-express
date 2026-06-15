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
import RefreshIcon from "@mui/icons-material/Refresh";
import FiberManualRecordIcon from "@mui/icons-material/FiberManualRecord";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { useFeatures } from "../../utils/featuresApi";
import { getRuleTitle } from "../validation/ruleCatalog";

// MUI Slide transition — direction up (like edit mode toasts)
const SlideUp = React.forwardRef(function SlideUp(props, ref) {
  return <Slide direction="up" ref={ref} {...props} />;
});

/**
 * Parses the validation report into aggregated counts per severity plus
 * top-N lists grouped by RULE CODE (not by file).
 *
 * Backend shape: `report.errors` is keyed by filename (e.g. "stops.txt") and
 * each value is an array of findings that carry their own `ruleCode` and
 * `severity` (error | warning | info). We flatten across files and group by
 * `ruleCode`, keeping one representative finding per rule so the dialog can
 * surface a human-readable message and example entity.
 *
 * INFO-level findings are advisories (e.g. `stop_too_close_to_other_stop`) —
 * they must NOT be counted as errors and must NOT block export. They are
 * surfaced as a separate "info" bucket so the UI can list them non-blockingly.
 *
 * Returns { errorCount, warningCount, infoCount, topErrors, topWarnings, topInfos }
 * where each top entry is { ruleCode, count, file, sampleMessage, sampleEntityId }.
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
    };
  }

  let eCount = 0;
  let wCount = 0;
  let iCount = 0;
  // Group by ruleCode → { count, file, sampleMessage, sampleEntityId }
  const errorsMap = new Map();
  const warningsMap = new Map();
  const infosMap = new Map();

  const addTo = (map, f, file) => {
    const rc = f.ruleCode || "unspecified";
    const existing = map.get(rc);
    if (existing) {
      existing.count++;
    } else {
      map.set(rc, {
        ruleCode: rc,
        count: 1,
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
      // Normalise severity: default "error" only if absent; explicit "info"
      // and "warning" routes cleanly. This mirrors the backend validator
      // convention (SEVERITY.INFO / WARNING / ERROR).
      const sev = (f.severity || "error").toLowerCase();
      if (sev === "info") {
        iCount++;
        addTo(infosMap, f, fileName);
      } else if (sev === "warning") {
        wCount++;
        addTo(warningsMap, f, fileName);
      } else {
        eCount++;
        addTo(errorsMap, f, fileName);
      }
    });
  });

  const toTop = (map) =>
    Array.from(map.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, topN);

  return {
    errorCount: eCount,
    warningCount: wCount,
    infoCount: iCount,
    topErrors: toTop(errorsMap),
    topWarnings: toTop(warningsMap),
    topInfos: toTop(infosMap),
  };
}

/**
 * ExportPreflightDialog
 *
 * Shown before any GTFS export. Runs a fresh POST /edit/validate,
 * then displays a summary (clean / warnings only / errors) with
 * appropriate CTAs and a risk-acknowledgment step when errors exist.
 *
 * Props:
 *   open             — bool
 *   onClose          — fn()
 *   onConfirmExport  — fn() — called when user confirms export
 *   onReviewErrors   — fn() — called when user wants to review errors
 */
function ExportPreflightDialog({ open, onClose, onConfirmExport, onReviewErrors }) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { editing } = useEditMode();
  // NeTEx France export is an optional server capability (embedded
  // gtfs2netexfr converter) — the extra button only renders when the
  // server advertises it. Errors-state exports never offer NeTEx: the
  // endpoint has no force bypass by design.
  const { features } = useFeatures();
  const netexEnabled = features?.netex?.enabled === true;

  // ── State ────────────────────────────────────────────────────────────────────
  const [validating, setValidating] = useState(false);
  const [report, setReport] = useState(null);
  const [validationError, setValidationError] = useState(null);
  const [isRateLimited, setIsRateLimited] = useState(false);
  const [validatedAt, setValidatedAt] = useState(null); // Date.now() when report was fetched
  const [elapsed, setElapsed] = useState(0); // seconds since validatedAt
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [showRiskConfirm, setShowRiskConfirm] = useState(false);

  const elapsedTimerRef = useRef(null);
  const staleTimerRef = useRef(null);

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const pluralKey = useCallback(
    (singular, plural, n) => {
      // Check if translations use pipe-separated plural format
      const singularStr = t(singular, { n });
      if (singularStr !== singular) return singularStr; // key found
      return n === 1 ? t(singular, { n }) : t(plural, { n });
    },
    [t],
  );

  // ── Validation fetch ─────────────────────────────────────────────────────────
  const runValidation = useCallback(async () => {
    setValidating(true);
    setValidationError(null);
    setIsRateLimited(false);
    setReport(null);
    setRiskAccepted(false);
    setShowRiskConfirm(false);

    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/validate`, {
        method: "POST",
      });

      if (res.status === 429) {
        setIsRateLimited(true);
        setValidating(false);
        return;
      }

      const body = await res.json();
      if (!res.ok) {
        setValidationError(body.error || "Validation failed");
        setValidating(false);
        return;
      }

      setReport(body);
      setValidatedAt(Date.now());
      setElapsed(0);
    } catch (err) {
      console.error("ExportPreflightDialog: validation fetch failed", err);
      setValidationError(err.message || "Network error");
    } finally {
      setValidating(false);
    }
  }, []);

  // ── Trigger validation when dialog opens ─────────────────────────────────────
  useEffect(() => {
    if (!open) {
      // Reset state on close
      setReport(null);
      setValidationError(null);
      setIsRateLimited(false);
      setValidatedAt(null);
      setElapsed(0);
      setRiskAccepted(false);
      setShowRiskConfirm(false);
      return;
    }
    runValidation();
  }, [open, runValidation]);

  // ── Elapsed time ticker ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!validatedAt) return;

    elapsedTimerRef.current = setInterval(() => {
      setElapsed(Math.round((Date.now() - validatedAt) / 1000));
    }, 1000);

    return () => clearInterval(elapsedTimerRef.current);
  }, [validatedAt]);

  // ── Stale re-validation (30s in edit mode) ────────────────────────────────────
  useEffect(() => {
    if (!validatedAt || !editing) return;

    staleTimerRef.current = setTimeout(() => {
      runValidation();
    }, 30_000);

    return () => clearTimeout(staleTimerRef.current);
  }, [validatedAt, editing, runValidation]);

  // ── Derived state ────────────────────────────────────────────────────────────
  // Parse once with a generous topN — we slice per-case below. INFO-level
  // findings (advisories like stop_too_close_to_other_stop) live in a separate
  // bucket; they never block export but we surface them in the warnings list
  // so the user still sees them at a glance.
  const parsed = report
    ? parseReport(report, 10)
    : { errorCount: 0, warningCount: 0, infoCount: 0, topErrors: [], topWarnings: [], topInfos: [] };
  const { errorCount, warningCount, infoCount } = parsed;
  const top5Errors = parsed.topErrors.slice(0, 5);
  const top3Warnings = parsed.topWarnings.slice(0, 3);
  const top3Infos = parsed.topInfos.slice(0, 3);

  const isStale = editing && elapsed > 30;
  // "Clean" means no blocking findings (errors) and no actionable findings
  // (warnings). INFO findings alone still qualify as clean — they are
  // purely advisory per the MobilityData Canonical Validator spec.
  const isClean = report && errorCount === 0 && warningCount === 0;
  const hasWarningsOnly = report && errorCount === 0 && warningCount > 0;
  const hasErrors = report && errorCount > 0;

  // ── Handlers ──────────────────────────────────────────────────────────────────
  const handleExportNow = () => {
    onConfirmExport("gtfs");
  };

  const handleExportNetex = () => {
    onConfirmExport("netex");
  };

  const handleExportAnywayClick = () => {
    setShowRiskConfirm(true);
  };

  const handleConfirmRiskyExport = () => {
    if (!riskAccepted) return;
    onConfirmExport("gtfs");
  };

  const handleReviewClick = () => {
    onReviewErrors();
  };

  // ── Interpolation helper (fallback if t() doesn't support vars) ───────────────
  const tReplace = (key, vars) => {
    let str = t(key);
    if (vars) {
      Object.entries(vars).forEach(([k, v]) => {
        str = str.replace(`{${k}}`, v);
      });
    }
    return str;
  };

  // ── Render a top-rules list ───────────────────────────────────────────────────
  const renderRuleList = (rules, color) => (
    <List dense disablePadding sx={{ mt: 1 }}>
      {rules.map(({ ruleCode, count, file, sampleMessage, sampleEntityId, sampleLineNumber }) => {
        const title = getRuleTitle(ruleCode) || ruleCode;
        // Short excerpt of the sample message (first sentence / 140 chars).
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

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <Dialog
      open={open}
      onClose={validating ? undefined : onClose}
      maxWidth="sm"
      fullWidth
      disableEscapeKeyDown={validating}
      TransitionComponent={SlideUp}
      PaperProps={{
        sx: {
          borderRadius: 2.5,
          borderTop: `3px solid ${
            hasErrors
              ? theme.palette.error.main
              : hasWarningsOnly
                ? theme.palette.warning.main
                : theme.palette.success.main
          }`,
          transition: "border-color 0.3s ease",
        },
      }}
    >
      {/* ── Title ─────────────────────────────────────────────────────────────── */}
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

        {/* Freshness chip — top right */}
        {report && !validating && (
          <Box sx={{ ml: "auto", display: "flex", alignItems: "center" }}>
            {isStale ? (
              <Chip
                label={t("export.preflight.staleValidation")}
                size="small"
                icon={<RefreshIcon sx={{ fontSize: 12 }} />}
                sx={{
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

      {/* ── Content ───────────────────────────────────────────────────────────── */}
      <DialogContent sx={{ pt: 2 }}>

        {/* ── Loading state ────────────────────────────────────────────────── */}
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

        {/* ── Rate limit error ─────────────────────────────────────────────── */}
        {isRateLimited && !validating && (
          <Alert
            severity="warning"
            sx={{ mb: 2 }}
            action={
              <Button
                size="small"
                color="warning"
                variant="outlined"
                onClick={handleExportNow}
              >
                {t("export.preflight.exportAnyway")}
              </Button>
            }
          >
            {t("export.preflight.rateLimitHit")}
          </Alert>
        )}

        {/* ── Generic validation error ──────────────────────────────────────── */}
        {validationError && !validating && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {validationError}
          </Alert>
        )}

        {/* ── CASE 1: Feed clean ───────────────────────────────────────────── */}
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

        {/* ── Non-blocking advisories (INFO severity, any case) ─────────────── */}
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

        {/* ── CASE 2: Warnings only ─────────────────────────────────────────── */}
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

        {/* ── CASE 3: Errors ────────────────────────────────────────────────── */}
        {hasErrors && !validating && (
          <Box py={1}>
            <Box display="flex" alignItems="center" gap={1.5} mb={1.5}>
              <ErrorOutlineIcon
                sx={{ fontSize: 32, color: theme.palette.error.main }}
              />
              <Box>
                <Typography variant="subtitle1" fontWeight={700}>
                  {tReplace(
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
                  {t("export.preflight.errorsBody")}
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

            {/* Risk confirmation step */}
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
                        n: errorCount,
                      })}
                    </Typography>
                  }
                  sx={{ m: 0, alignItems: "flex-start" }}
                />
              </Alert>
            </Collapse>
          </Box>
        )}
      </DialogContent>

      {/* ── Timestamp footer ──────────────────────────────────────────────────── */}
      {validatedAt && !validating && (
        <Box px={3} pb={0.5}>
          <Typography variant="caption" color="text.disabled">
            {tReplace("export.preflight.validatedAgo", { seconds: elapsed })}
          </Typography>
        </Box>
      )}

      {/* ── Actions ───────────────────────────────────────────────────────────── */}
      <DialogActions sx={{ px: 3, py: 1.5, gap: 1, flexWrap: "wrap" }}>
        {/* Cancel always visible */}
        <Button onClick={onClose} color="inherit" disabled={validating}>
          {t("app.cancel")}
        </Button>

        {/* ── Actions for rate limit or error state (no report) ── */}
        {!report && !validating && !isRateLimited && validationError && (
          <Button
            variant="contained"
            onClick={handleExportNow}
            data-testid="export-confirm"
          >
            {t("export.preflight.exportAnyway")}
          </Button>
        )}

        {/* ── CASE 1: Clean ── */}
        {isClean && !validating && (
          <Box sx={{ width: "100%", display: "flex", flexDirection: "column", gap: 1, mt: 0.5 }}>
            <Button
              variant="contained"
              color="success"
              autoFocus
              onClick={handleExportNow}
              fullWidth
              data-testid="export-confirm"
            >
              {t("export.preflight.exportNow")}
            </Button>
            {netexEnabled && (
              <Button
                variant="outlined"
                color="success"
                onClick={handleExportNetex}
                fullWidth
                data-testid="export-netex"
                sx={{ textTransform: "none", fontWeight: 600 }}
              >
                {t("export.preflight.exportNetex")}
              </Button>
            )}
          </Box>
        )}

        {/* ── CASE 2: Warnings only ── */}
        {hasWarningsOnly && !validating && (
          <>
            <Box sx={{ flex: 1 }} />
            <Button
              variant="outlined"
              color="warning"
              onClick={handleReviewClick}
            >
              {t("export.preflight.reviewWarnings")}
            </Button>
            {netexEnabled && (
              <Button
                variant="outlined"
                onClick={handleExportNetex}
                data-testid="export-netex"
                sx={{ textTransform: "none", fontWeight: 600 }}
              >
                {t("export.preflight.exportNetex")}
              </Button>
            )}
            <Button
              variant="contained"
              color="primary"
              autoFocus
              onClick={handleExportNow}
              data-testid="export-confirm"
            >
              {t("export.preflight.exportAnyway")}
            </Button>
          </>
        )}

        {/* ── CASE 3: Errors ── */}
        {hasErrors && !validating && (
          <>
            <Box sx={{ flex: 1 }} />
            {!showRiskConfirm ? (
              <>
                <Button
                  variant="text"
                  color="error"
                  onClick={handleExportAnywayClick}
                  data-testid="export-anyway"
                  sx={{ opacity: 0.7, fontSize: "0.8rem" }}
                >
                  {t("export.preflight.exportAnyway")}
                </Button>
                <Button
                  variant="contained"
                  color="primary"
                  autoFocus
                  onClick={handleReviewClick}
                >
                  {t("export.preflight.reviewErrors")}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outlined"
                  onClick={() => {
                    setShowRiskConfirm(false);
                    setRiskAccepted(false);
                  }}
                >
                  {t("app.cancel")}
                </Button>
                <Button
                  variant="contained"
                  color="error"
                  onClick={handleConfirmRiskyExport}
                  disabled={!riskAccepted}
                  data-testid="export-risky-confirm"
                >
                  {t("export.preflight.confirmExport")}
                </Button>
              </>
            )}
          </>
        )}
      </DialogActions>
    </Dialog>
  );
}

export default ExportPreflightDialog;
