/**
 * RepairPlanBar — when the assistant proposed several SQL fixes in one
 * turn, apply them all with a single click: each statement runs through
 * POST /edit/sql (its own undo entry), then the feed is re-validated once
 * and the report broadcast to the app. Each card below still allows a
 * one-by-one review.
 */

import React, { useCallback, useMemo, useState } from "react";
import { Box, Button, CircularProgress, LinearProgress, Typography, alpha, useTheme } from "@mui/material";
import PlaylistAddCheckIcon from "@mui/icons-material/PlaylistAddCheck";
import EditIcon from "@mui/icons-material/Edit";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";

export default function RepairPlanBar({ proposals, batchState, onBatchApplied, currentErrorCount = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { editing, entering, enterEditMode, recordEdit } = useEditMode();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState(null);

  // Applicable = has rows and fits under the confirmed cap; the rest stays
  // for manual review.
  const applicable = useMemo(
    () =>
      proposals.filter(
        (p) =>
          p.preview &&
          p.preview.totalAffected > 0 &&
          !p.preview.exceedsConfirmedCap &&
          !p.outcome &&
          !(batchState && batchState[p.proposalId]),
      ),
    [proposals, batchState],
  );
  const totalRows = applicable.reduce((n, p) => n + (p.preview?.totalAffected || 0), 0);

  const applyAll = useCallback(async () => {
    if (running || applicable.length === 0) return;
    setRunning(true);
    setProgress(0);
    const results = {};
    let applied = 0;
    let failed = 0;
    let rows = 0;
    for (let i = 0; i < applicable.length; i++) {
      const p = applicable[i];
      try {
        const res = await fetchWithSession(`${API_BASE_URL}/edit/sql`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: p.sql,
            confirmedLargeMutation: Boolean(p.preview?.exceedsDefaultCap),
            source: "chat",
          }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        results[p.proposalId] = { ok: true, affected: body.affected ?? 0, undoEntryId: body.undoEntryId ?? null };
        applied += 1;
        rows += body.affected ?? 0;
        recordEdit("", body.validation, { entity: "sql", entityId: p.proposalId, noUndoAction: true });
      } catch (err) {
        results[p.proposalId] = { ok: false, error: err.message };
        failed += 1;
      }
      setProgress(i + 1);
    }
    // One re-validation for the whole plan.
    let after = null;
    try {
      const startedAt = Date.now();
      const res = await fetchWithSession(`${API_BASE_URL}/edit/validate`, { method: "POST" });
      if (res.ok) {
        const report = await res.json();
        after = report?.counts?.errors ?? null;
        window.dispatchEvent(new CustomEvent("gtfs:validation-refreshed", { detail: { report, startedAt } }));
      }
    } catch {
      /* best effort */
    }
    setSummary({ applied, failed, rows, after });
    setRunning(false);
    if (onBatchApplied) onBatchApplied(results, { applied, failed, rows, before: currentErrorCount, after });
  }, [running, applicable, recordEdit, onBatchApplied, currentErrorCount]);

  if (proposals.length < 2) return null;
  if (summary) {
    return (
      <Box
        data-testid="chat-repair-plan-done"
        sx={{ mt: 1, px: 1.5, py: 1, borderRadius: 1.5, border: `1px solid ${alpha(theme.palette.success.main, 0.4)}`, background: alpha(theme.palette.success.main, 0.06), fontSize: "0.78rem" }}
      >
        <Typography sx={{ fontSize: "0.8rem", fontWeight: 700, color: "success.dark" }}>
          {t("chat.plan.done", { applied: summary.applied, rows: summary.rows })}
          {summary.failed > 0 ? ` · ${t("chat.plan.failed", { count: summary.failed })}` : ""}
        </Typography>
        {summary.after != null && (
          <Typography sx={{ fontSize: "0.74rem", color: "text.secondary" }}>
            {currentErrorCount == null
              ? t("chat.repair.reportAfterOnly", { after: summary.after })
              : t("chat.repair.reportImproved", { before: currentErrorCount, after: summary.after })}
          </Typography>
        )}
      </Box>
    );
  }
  if (applicable.length === 0) return null;

  return (
    <Box
      data-testid="chat-repair-plan"
      sx={{
        mt: 1,
        px: 1.5,
        py: 1,
        borderRadius: 1.5,
        border: `1px solid ${alpha(theme.palette.ai.main, 0.45)}`,
        background: alpha(theme.palette.ai.main, 0.06),
        display: "flex",
        alignItems: "center",
        gap: 1,
        flexWrap: "wrap",
      }}
    >
      <PlaylistAddCheckIcon sx={{ fontSize: 20, color: theme.palette.ai.main }} />
      <Box sx={{ flex: 1, minWidth: 160 }}>
        <Typography sx={{ fontSize: "0.8rem", fontWeight: 700 }}>
          {t("chat.plan.title", { count: applicable.length, rows: totalRows })}
        </Typography>
        <Typography sx={{ fontSize: "0.72rem", color: "text.secondary" }}>{t("chat.plan.hint")}</Typography>
        {running && (
          <LinearProgress variant="determinate" value={(100 * progress) / applicable.length} sx={{ mt: 0.6, borderRadius: 1 }} />
        )}
      </Box>
      {editing ? (
        <Button
          size="small"
          variant="contained"
          disabled={running}
          onClick={applyAll}
          data-testid="chat-repair-plan-apply"
          startIcon={running ? <CircularProgress size={12} color="inherit" /> : <PlaylistAddCheckIcon sx={{ fontSize: 15 }} />}
          sx={{ textTransform: "none", fontWeight: 700, background: `linear-gradient(135deg, ${theme.palette.ai.gradientStart}, ${theme.palette.ai.gradientEnd})`, boxShadow: "none" }}
        >
          {running ? t("chat.plan.applying", { done: progress, total: applicable.length }) : t("chat.plan.applyAll", { count: applicable.length })}
        </Button>
      ) : (
        <Button
          size="small"
          variant="outlined"
          disabled={entering}
          onClick={() => enterEditMode()}
          startIcon={entering ? <CircularProgress size={12} color="inherit" /> : <EditIcon sx={{ fontSize: 14 }} />}
          sx={{ textTransform: "none", fontWeight: 600 }}
        >
          {t("chat.blocked.enterEditMode")}
        </Button>
      )}
    </Box>
  );
}
