/**
 * RepairFlow — the guided in-chat repair loop (draft → preview → confirm →
 * apply → revalidate). Rendered inside an assistant bubble when the model
 * drafts a mutation (`sql_blocked`, reason `mutation_in_read_mode`).
 *
 * Architecture: pure frontend orchestration over the SAME endpoints the SQL
 * Console uses — POST /edit/sql/preview (dry-run, cascade breakdown, caps),
 * POST /edit/sql (transactional apply, single undo entry), POST
 * /edit/validate (canonical revalidation). No AI-specific mutation path
 * exists server-side: every guarantee of the console (statement whitelist,
 * row caps, in-transaction field validation, batch undo) applies verbatim,
 * and nothing executes without an explicit user click.
 *
 * State machine (single `phase` value):
 *   idle → previewing → previewed → applying → applied → revalidating →
 *   done | revalidateDeferred       (+ error / undone side-states)
 *
 * The final outcome is reported to the parent via `onOutcome(summaryText)`
 * so ChatDrawer can persist it on the turn (`resultSummary`) — the flattened
 * history then tells the model what actually happened on the next turn.
 */

import React, { useCallback, useRef, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  Typography,
  useTheme,
  alpha,
} from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PreviewOutlinedIcon from "@mui/icons-material/PreviewOutlined";
import ReplayIcon from "@mui/icons-material/Replay";
import UndoIcon from "@mui/icons-material/Undo";
import EditIcon from "@mui/icons-material/Edit";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import BetaGateDialog from "../edit/BetaGateDialog";

const BETA_GATE_ERROR_CODES = new Set([
  "BETA_CODE_REQUIRED",
  "INVALID_BETA_CODE",
  "BETA_REVOKED",
  "BETA_CONFIG_ERROR",
]);

// One row of the vertical timeline. `state`: pending | active | done | error.
function Step({ label, state, children, theme }) {
  const color =
    state === "done"
      ? theme.palette.success.main
      : state === "error"
        ? theme.palette.error.main
        : state === "active"
          ? theme.palette.primary.main
          : theme.palette.text.disabled;
  return (
    <Box sx={{ display: "flex", gap: 1, alignItems: "flex-start" }}>
      <Box
        sx={{
          mt: 0.4,
          width: 16,
          height: 16,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {state === "done" ? (
          <CheckCircleOutlineIcon sx={{ fontSize: 15, color }} />
        ) : state === "error" ? (
          <ErrorOutlineIcon sx={{ fontSize: 15, color }} />
        ) : state === "active" ? (
          <CircularProgress size={12} thickness={5} />
        ) : (
          <Box
            sx={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              border: `2px solid ${color}`,
            }}
          />
        )}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant="caption"
          sx={{ fontWeight: 700, color: state === "pending" ? "text.disabled" : "text.primary" }}
        >
          {label}
        </Typography>
        {children}
      </Box>
    </Box>
  );
}

// `onApplied(bool)` lets the parent bubble know the draft has been applied
// (true) or rolled back (false): the "Open in SQL Console" escape hatch is
// hidden once applied so the user is not invited to run the same statement
// a second time (prod bug: re-running an applied INSERT INTO feed_info
// tripped the at-most-one-row guard and read like a failure).
function RepairFlow({
  draftSql,
  currentErrorCount = null,
  onOutcome,
  onApplied = null,
}) {
  const theme = useTheme();
  const { t } = useLanguage();
  const { editing, entering, enterEditMode, recordEdit, undoLast } =
    useEditMode();

  const [phase, setPhase] = useState("idle");
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [applied, setApplied] = useState(null); // { affected }
  const [revalidation, setRevalidation] = useState(null); // { before, after }
  const [errorMsg, setErrorMsg] = useState(null);
  const [violations, setViolations] = useState(null);
  const [undone, setUndone] = useState(false);
  const [betaGateOpen, setBetaGateOpen] = useState(false);
  const [betaGateInitialError, setBetaGateInitialError] = useState(null);
  // Guards against double-clicks racing the async transitions.
  const busyRef = useRef(false);

  const needsConfirm =
    preview && preview.totalAffected > (preview.previewThreshold ?? 50);
  const needsLargeCap = preview && preview.exceedsDefaultCap;
  const hardBlocked = preview && preview.exceedsConfirmedCap;
  // Nothing matches the draft: most often the issue was already fixed —
  // duplicates are dropped by the tolerant import, or an earlier edit got
  // there first — and the validation report is simply stale. Applying a
  // no-op would let the flow claim credit it does not deserve; offer a
  // plain re-validation instead.
  const zeroRows = preview && preview.totalAffected === 0;
  const previewSamples = preview
    ? (preview.statements || []).flatMap((s) => s.sampleRows || []).slice(0, 5)
    : [];

  const handlePreview = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase("previewing");
    setErrorMsg(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/sql/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: draftSql, source: "chat" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(body.error || `HTTP ${res.status}`);
        setPhase("idle");
        return;
      }
      setPreview(body);
      setConfirmed(false);
      setPhase("previewed");
    } catch (err) {
      setErrorMsg(err.message || t("chat.repair.networkError"));
      setPhase("idle");
    } finally {
      busyRef.current = false;
    }
  }, [draftSql, t]);

  const handleRevalidate = useCallback(
    // `affectedCount === null` means the zero-rows path: nothing was
    // applied, we are only refreshing a stale report — the outcome wording
    // must not claim a repair that never happened.
    async (affectedCount) => {
      setPhase("revalidating");
      try {
        const res = await fetchWithSession(`${API_BASE_URL}/edit/validate`, {
          method: "POST",
        });
        if (res.status === 429) {
          setPhase("revalidateDeferred");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const report = await res.json();
        const after = report?.counts?.errors ?? 0;
        const before = currentErrorCount;
        setRevalidation({ before, after });
        setPhase("done");
        // Sync the whole app (header badge, validation page, chat context).
        window.dispatchEvent(
          new CustomEvent("gtfs:validation-refreshed", { detail: { report } }),
        );
        if (onOutcome) {
          const delta =
            before == null
              ? `${after} validation error(s) remain`
              : `validation errors ${before} -> ${after}`;
          onOutcome(
            affectedCount == null
              ? `No rows matched the draft (already fixed earlier, e.g. duplicates dropped at import); report re-validated: ${delta}.`
              : `Mutation applied (${affectedCount} row(s)); ${delta}.`,
          );
        }
      } catch {
        // Revalidation is best-effort — the mutation itself succeeded.
        setPhase("revalidateDeferred");
      }
    },
    [currentErrorCount, onOutcome],
  );

  const handleApply = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setPhase("applying");
    setErrorMsg(null);
    setViolations(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}/edit/sql`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: draftSql,
          confirmedLargeMutation: Boolean(needsLargeCap && confirmed),
          source: "chat",
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErrorMsg(body.error || `HTTP ${res.status}`);
        if (Array.isArray(body.violations)) setViolations(body.violations);
        setPhase("previewed");
        return;
      }
      setApplied({ affected: body.affected ?? 0 });
      if (onApplied) onApplied(true);
      // Rule #17: every client-side mutation must call recordEdit() so the
      // pending-edits counter / dataVersion / auto-save stay in sync.
      recordEdit(t("chat.repair.appliedToast", { count: body.affected ?? 0 }));
      busyRef.current = false;
      await handleRevalidate(body.affected ?? 0);
      return;
    } catch (err) {
      setErrorMsg(err.message || t("chat.repair.networkError"));
      setPhase("previewed");
    } finally {
      busyRef.current = false;
    }
  }, [draftSql, needsLargeCap, confirmed, recordEdit, t, handleRevalidate, onApplied]);

  const handleEnterEditMode = useCallback(async () => {
    const result = await enterEditMode();
    if (
      result &&
      result.ok === false &&
      BETA_GATE_ERROR_CODES.has(result.errorCode)
    ) {
      setBetaGateInitialError({
        code: result.errorCode,
        message: result.message,
      });
      setBetaGateOpen(true);
    }
  }, [enterEditMode]);

  const handleBetaSubmit = useCallback(
    async (code) => {
      const result = await enterEditMode(code);
      if (result?.ok) {
        setBetaGateInitialError(null);
        return { ok: true };
      }
      return {
        ok: false,
        errorCode: result?.errorCode || "INVALID_BETA_CODE",
        message: result?.message,
      };
    },
    [enterEditMode],
  );

  const handleUndo = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await undoLast();
      setUndone(true);
      if (onApplied) onApplied(false);
      if (onOutcome) {
        onOutcome("Mutation applied then undone by the user.");
      }
    } finally {
      busyRef.current = false;
    }
  }, [undoLast, onOutcome, onApplied]);

  // ── Step states derived from the phase ────────────────────────────────────
  const previewState =
    phase === "previewing"
      ? "active"
      : preview
        ? "done"
        : "pending";
  const applyState =
    phase === "applying"
      ? "active"
      : applied || zeroRows
        ? "done"
        : errorMsg && phase === "previewed"
          ? "error"
          : "pending";
  const revalidateState =
    phase === "revalidating"
      ? "active"
      : phase === "done"
        ? "done"
        : phase === "revalidateDeferred"
          ? "error"
          : "pending";

  const after = revalidation?.after;
  const cleanAfter = phase === "done" && after === 0;

  return (
    <Box
      sx={{
        mt: 1,
        p: 1.25,
        borderRadius: 1.5,
        border: `1px solid ${alpha(theme.palette.primary.main, 0.25)}`,
        bgcolor: alpha(theme.palette.primary.main, 0.03),
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}
      data-testid="repair-flow"
    >
      <Typography variant="caption" sx={{ fontWeight: 700, color: "text.secondary" }}>
        {t("chat.repair.title")}
      </Typography>

      {/* Step 1 — Draft (always done: the SQL sits in the accordion above) */}
      <Step label={t("chat.repair.stepDraft")} state="done" theme={theme} />

      {/* Step 2 — Preview */}
      <Step label={t("chat.repair.stepPreview")} state={previewState} theme={theme}>
        {!preview && phase !== "previewing" && (
          <Button
            size="small"
            variant="outlined"
            startIcon={<PreviewOutlinedIcon sx={{ fontSize: 14 }} />}
            onClick={handlePreview}
            data-testid="repair-preview"
            sx={{ mt: 0.5, textTransform: "none", fontWeight: 600, height: 26, fontSize: "0.74rem" }}
          >
            {t("chat.repair.previewButton")}
          </Button>
        )}
        {preview && (
          <Box sx={{ mt: 0.25 }}>
            <Typography variant="caption" color="text.secondary" component="div">
              {t("chat.repair.previewSummary", {
                rows: preview.totalAffected,
                statements: preview.statements?.filter((s) => s.table).length || 1,
              })}
            </Typography>
            <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.25 }}>
              {(preview.statements || [])
                .filter((s) => s.table)
                .map((s, i) => (
                  <Chip
                    key={i}
                    size="small"
                    label={`${s.verb} ${s.table}: ${s.affected}`}
                    sx={{ height: 18, fontSize: "0.62rem", fontWeight: 600 }}
                  />
                ))}
              {(preview.statements || [])
                .flatMap((s) => s.cascade || [])
                .map((c, i) => (
                  <Chip
                    key={`c${i}`}
                    size="small"
                    color="warning"
                    variant="outlined"
                    label={t("chat.repair.cascadeChip", {
                      count: c.count,
                      table: c.table,
                    })}
                    sx={{ height: 18, fontSize: "0.62rem", fontWeight: 600 }}
                  />
                ))}
            </Box>
            {previewSamples.length > 0 && (
              <Box
                sx={{
                  mt: 0.5,
                  p: 0.75,
                  borderRadius: 1,
                  bgcolor: alpha(theme.palette.text.primary, 0.04),
                  overflow: "hidden",
                }}
                data-testid="repair-sample-rows"
              >
                <Typography
                  variant="caption"
                  component="div"
                  sx={{ fontWeight: 700, color: "text.secondary", mb: 0.25 }}
                >
                  {t("chat.repair.sampleTitle")}
                </Typography>
                {previewSamples.map((row, i) => (
                  <Typography
                    key={i}
                    variant="caption"
                    component="div"
                    sx={{
                      fontFamily: "monospace",
                      fontSize: "0.64rem",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      color: "text.secondary",
                    }}
                  >
                    {Object.entries(row)
                      .map(([k, v]) => `${k}=${v}`)
                      .join("  ")}
                  </Typography>
                ))}
              </Box>
            )}
            {zeroRows && (
              <Typography
                variant="caption"
                component="div"
                color="text.secondary"
                sx={{ mt: 0.5, fontStyle: "italic" }}
                data-testid="repair-zero-rows"
              >
                {t("chat.repair.zeroRows")}
              </Typography>
            )}
            {hardBlocked && (
              <Typography variant="caption" color="error.main" component="div" sx={{ mt: 0.5 }}>
                {t("chat.repair.tooLarge", { cap: preview.confirmedCap })}
              </Typography>
            )}
            {!hardBlocked && needsConfirm && !applied && (
              <FormControlLabel
                sx={{ mt: 0.25, mr: 0 }}
                control={
                  <Checkbox
                    size="small"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    data-testid="repair-confirm"
                  />
                }
                label={
                  <Typography variant="caption">
                    {t("chat.repair.confirmLabel", {
                      count: preview.totalAffected,
                    })}
                  </Typography>
                }
              />
            )}
          </Box>
        )}
      </Step>

      {/* Step 3 — Apply */}
      <Step label={t("chat.repair.stepApply")} state={applyState} theme={theme}>
        {zeroRows && !applied && (
          <Box sx={{ mt: 0.25, display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
            <Typography variant="caption" color="text.secondary">
              {t("chat.repair.nothingToApply")}
            </Typography>
            {phase === "previewed" && (
              <Chip
                size="small"
                icon={<ReplayIcon sx={{ fontSize: 12 }} />}
                label={t("chat.repair.revalidateNow")}
                onClick={() => handleRevalidate(null)}
                data-testid="repair-revalidate-zero"
                sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700 }}
              />
            )}
          </Box>
        )}
        {!zeroRows && preview && !applied && !hardBlocked && (
          <Box sx={{ mt: 0.5, display: "flex", gap: 0.75, flexWrap: "wrap" }}>
            {editing ? (
              <Button
                size="small"
                variant="contained"
                color="warning"
                startIcon={
                  phase === "applying" ? (
                    <CircularProgress size={12} color="inherit" />
                  ) : (
                    <PlayArrowIcon sx={{ fontSize: 14 }} />
                  )
                }
                disabled={phase === "applying" || (needsConfirm && !confirmed)}
                onClick={handleApply}
                data-testid="repair-apply"
                sx={{
                  textTransform: "none",
                  fontWeight: 700,
                  height: 26,
                  fontSize: "0.74rem",
                  boxShadow: "none",
                  "&:hover": { boxShadow: "none" },
                }}
              >
                {phase === "applying"
                  ? t("chat.repair.applying")
                  : t("chat.repair.applyButton")}
              </Button>
            ) : (
              <Button
                size="small"
                variant="outlined"
                color="warning"
                startIcon={
                  entering ? (
                    <CircularProgress size={12} color="inherit" />
                  ) : (
                    <EditIcon sx={{ fontSize: 14 }} />
                  )
                }
                disabled={entering}
                onClick={handleEnterEditMode}
                sx={{ textTransform: "none", fontWeight: 600, height: 26, fontSize: "0.74rem" }}
              >
                {t("chat.blocked.enterEditMode")}
              </Button>
            )}
          </Box>
        )}
        {applied && (
          <Box sx={{ mt: 0.25, display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
            <Typography variant="caption" color="text.secondary">
              {t("chat.repair.appliedSummary", { count: applied.affected })}
            </Typography>
            {!undone && (
              <Chip
                size="small"
                icon={<UndoIcon sx={{ fontSize: 12 }} />}
                label={t("chat.repair.undo")}
                onClick={handleUndo}
                data-testid="repair-undo"
                sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700 }}
              />
            )}
            {undone && (
              <Chip
                size="small"
                label={t("chat.repair.undone")}
                sx={{ height: 20, fontSize: "0.66rem" }}
              />
            )}
          </Box>
        )}
        {errorMsg && (
          <Typography variant="caption" color="error.main" component="div" sx={{ mt: 0.5 }}>
            {errorMsg}
          </Typography>
        )}
        {violations && violations.length > 0 && (
          <Box component="ul" sx={{ m: 0, mt: 0.25, pl: 2 }}>
            {violations.slice(0, 5).map((v, i) => (
              <Typography key={i} component="li" variant="caption" color="error.main">
                {typeof v === "string" ? v : JSON.stringify(v)}
              </Typography>
            ))}
          </Box>
        )}
      </Step>

      {/* Step 4 — Revalidate */}
      <Step
        label={t("chat.repair.stepRevalidate")}
        state={revalidateState}
        theme={theme}
      >
        {phase === "done" && revalidation && (
          <Typography
            variant="caption"
            component="div"
            sx={{
              mt: 0.25,
              fontWeight: 700,
              color: cleanAfter ? theme.palette.success.main : "text.secondary",
            }}
            data-testid="repair-report"
          >
            {!applied
              ? t("chat.repair.reportRefreshed", { after })
              : revalidation.before == null
                ? t("chat.repair.reportAfterOnly", { after })
                : cleanAfter
                  ? t("chat.repair.reportClean", { before: revalidation.before })
                  : t("chat.repair.reportImproved", {
                      before: revalidation.before,
                      after,
                    })}
          </Typography>
        )}
        {phase === "revalidateDeferred" && (
          <Box sx={{ mt: 0.25, display: "flex", alignItems: "center", gap: 0.75 }}>
            <Typography variant="caption" color="text.secondary">
              {t("chat.repair.revalidateDeferred")}
            </Typography>
            <Chip
              size="small"
              icon={<ReplayIcon sx={{ fontSize: 12 }} />}
              label={t("chat.repair.revalidateRetry")}
              onClick={() => handleRevalidate(applied ? applied.affected : null)}
              sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700 }}
            />
          </Box>
        )}
      </Step>

      <BetaGateDialog
        open={betaGateOpen}
        onClose={() => setBetaGateOpen(false)}
        onSubmit={handleBetaSubmit}
        initialError={betaGateInitialError}
      />
    </Box>
  );
}

export default RepairFlow;
