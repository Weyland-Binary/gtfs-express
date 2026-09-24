/**
 * OperationProposalCard — an edit the assistant proposed as an OPERATION
 * (not SQL): create trips from a template, shift trips. The server already
 * planned it; the user applies it in one click (edit mode), can undo it,
 * and the outcome is reported back to the assistant.
 */

import React, { useCallback, useState } from "react";
import { Box, Button, Chip, CircularProgress, Typography, alpha, useTheme } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import UndoIcon from "@mui/icons-material/Undo";
import EditIcon from "@mui/icons-material/Edit";
import AddRoadIcon from "@mui/icons-material/AddRoad";
import UpdateIcon from "@mui/icons-material/Update";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";

const ENDPOINTS = {
  create_trips: "/edit/trips/create_from_template",
  shift_trips: "/edit/trips/shift",
};

const fmtOffset = (secs) => {
  const m = secs / 60;
  return `${m > 0 ? "+" : ""}${Number.isInteger(m) ? m : m.toFixed(1)} min`;
};

export default function OperationProposalCard({ proposal, index, onOutcome }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { editing, entering, enterEditMode, recordEdit, undoLast } = useEditMode();
  const [phase, setPhase] = useState("idle"); // idle | applying | applied | undone
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const { operation, params, preview } = proposal;
  const isCreate = operation === "create_trips";
  const Icon = isCreate ? AddRoadIcon : UpdateIcon;

  const summary = isCreate
    ? t("chat.op.createSummary", {
        count: preview?.trips?.length ?? params?.departures?.length ?? 0,
        route: preview?.route_id || "",
        stops: preview?.stop_times_per_trip ?? "?",
      })
    : t("chat.op.shiftSummary", {
        count: preview?.trips ?? params?.trip_ids?.length ?? 0,
        offset: fmtOffset(params?.offset_secs || 0),
        stopTimes: preview?.stop_times ?? "?",
      });

  const apply = useCallback(async () => {
    if (phase === "applying") return;
    setPhase("applying");
    setError(null);
    try {
      const res = await fetchWithSession(`${API_BASE_URL}${ENDPOINTS[operation]}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setResult(body);
      setPhase("applied");
      const message = isCreate
        ? t("chat.op.createdToast", { count: body.created_trips ?? 0 })
        : t("chat.op.shiftedToast", { count: body.shifted_trips ?? 0 });
      recordEdit(message, body.validation, { entity: "trip", entityId: body.trips?.[0]?.trip_id || params.trip_ids?.[0], noUndoAction: true });
      if (onOutcome) {
        onOutcome(
          isCreate
            ? `Applied: ${body.created_trips} trip(s) created (${(body.trips || []).map((x) => x.trip_id).slice(0, 10).join(", ")}).`
            : `Applied: ${body.shifted_trips} trip(s) shifted by ${fmtOffset(params.offset_secs)}.`,
        );
      }
    } catch (err) {
      setError(err.message || t("chat.repair.networkError"));
      setPhase("idle");
    }
  }, [phase, operation, params, isCreate, recordEdit, onOutcome, t]);

  const undo = useCallback(async () => {
    const ok = await undoLast(result?.undoEntryId ?? null);
    if (ok === false) return;
    setPhase("undone");
    if (onOutcome) onOutcome("Applied then undone by the user.");
  }, [undoLast, result, onOutcome]);

  const applied = phase === "applied";

  return (
    <Box
      data-testid="chat-operation"
      sx={{
        mt: 1,
        borderRadius: 1.5,
        overflow: "hidden",
        border: `1px solid ${alpha(applied ? theme.palette.success.main : theme.palette.primary.main, 0.45)}`,
        background: alpha(applied ? theme.palette.success.main : theme.palette.primary.main, 0.05),
      }}
    >
      <Box sx={{ px: 1.5, py: 1, display: "flex", alignItems: "flex-start", gap: 1 }}>
        <Icon sx={{ fontSize: 18, color: applied ? "success.main" : "primary.main", mt: 0.1 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ fontSize: "0.8rem", fontWeight: 700, lineHeight: 1.35 }}>
            {index != null ? `${index + 1}. ` : ""}
            {proposal.title}
          </Box>
          <Typography sx={{ fontSize: "0.74rem", color: "text.secondary", mt: 0.35, lineHeight: 1.5 }}>{summary}</Typography>
          {isCreate && Array.isArray(preview?.trips) && (
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.6 }}>
              {preview.trips.slice(0, 12).map((tr) => (
                <Chip key={tr.trip_id} size="small" label={`${tr.first_departure} → ${tr.last_arrival}`} sx={{ height: 20, fontSize: "0.64rem", fontFamily: "monospace" }} />
              ))}
              {preview.trips.length > 12 && (
                <Chip size="small" label={`+${preview.trips.length - 12}`} sx={{ height: 20, fontSize: "0.64rem" }} />
              )}
            </Box>
          )}
          {!isCreate && preview?.first_departure && (
            <Typography sx={{ fontSize: "0.7rem", color: "text.disabled", mt: 0.4, fontFamily: "monospace" }}>
              {preview.first_departure} → {preview.last_arrival}
            </Typography>
          )}
        </Box>
      </Box>
      <Box sx={{ px: 1.5, pb: 1.1, display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
        {phase === "idle" || phase === "applying" ? (
          editing ? (
            <Button
              size="small"
              variant="contained"
              startIcon={phase === "applying" ? <CircularProgress size={12} color="inherit" /> : <PlayArrowIcon sx={{ fontSize: 14 }} />}
              disabled={phase === "applying"}
              onClick={apply}
              data-testid="chat-operation-apply"
              sx={{ textTransform: "none", fontWeight: 700, height: 26, fontSize: "0.74rem", boxShadow: "none" }}
            >
              {t("chat.op.apply")}
            </Button>
          ) : (
            <Button
              size="small"
              variant="outlined"
              startIcon={entering ? <CircularProgress size={12} color="inherit" /> : <EditIcon sx={{ fontSize: 14 }} />}
              disabled={entering}
              onClick={() => enterEditMode()}
              sx={{ textTransform: "none", fontWeight: 600, height: 26, fontSize: "0.74rem" }}
            >
              {t("chat.blocked.enterEditMode")}
            </Button>
          )
        ) : null}
        {applied && (
          <>
            <CheckCircleOutlineIcon sx={{ fontSize: 15, color: "success.main" }} />
            <Typography sx={{ fontSize: "0.74rem", fontWeight: 600, color: "success.main" }}>
              {isCreate
                ? t("chat.op.createdToast", { count: result?.created_trips ?? 0 })
                : t("chat.op.shiftedToast", { count: result?.shifted_trips ?? 0 })}
            </Typography>
            <Chip size="small" icon={<UndoIcon sx={{ fontSize: 12 }} />} label={t("chat.repair.undo")} onClick={undo} data-testid="chat-operation-undo" sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700 }} />
          </>
        )}
        {phase === "undone" && <Chip size="small" label={t("chat.repair.undone")} sx={{ height: 20, fontSize: "0.66rem" }} />}
        {error && <Typography sx={{ fontSize: "0.72rem", color: "error.main" }}>{error}</Typography>}
      </Box>
    </Box>
  );
}
