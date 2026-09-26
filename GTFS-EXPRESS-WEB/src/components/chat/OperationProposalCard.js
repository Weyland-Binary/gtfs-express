/**
 * OperationProposalCard — an edit the assistant proposed as an OPERATION
 * (not SQL): create trips from a template, shift trips, insert a stop in a
 * pattern, merge duplicate stops, rename stops in batch, extend calendars.
 * The server already planned it; the user reviews the plan (and, for
 * renames, unticks lines), applies it in one click (edit mode), can undo
 * it, and the outcome is reported back to the assistant.
 */

import React, { useCallback, useMemo, useState } from "react";
import { Box, Button, Checkbox, Chip, CircularProgress, Typography, alpha, useTheme } from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import UndoIcon from "@mui/icons-material/Undo";
import EditIcon from "@mui/icons-material/Edit";
import AddRoadIcon from "@mui/icons-material/AddRoad";
import UpdateIcon from "@mui/icons-material/Update";
import AddLocationAltIcon from "@mui/icons-material/AddLocationAlt";
import MergeTypeIcon from "@mui/icons-material/MergeType";
import DriveFileRenameOutlineIcon from "@mui/icons-material/DriveFileRenameOutline";
import EventRepeatIcon from "@mui/icons-material/EventRepeat";
import EditLocationAltIcon from "@mui/icons-material/EditLocationAlt";
import AutoFixHighOutlinedIcon from "@mui/icons-material/AutoFixHighOutlined";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";
import { useLanguage } from "../../contexts/LanguageContext";
import { useEditMode } from "../../contexts/EditModeContext";
import { previewChangePlan, commitChangePlan } from "../../utils/transformApi";

const fmtOffset = (secs) => {
  const m = secs / 60;
  return `${m > 0 ? "+" : ""}${Number.isInteger(m) ? m : m.toFixed(1)} min`;
};
const fmtDate = (ymd) => (ymd && ymd.length === 8 ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : ymd || "—");

// Per-operation presentation: endpoint, icon, summary, applied toast, the
// text handed back to the assistant, and the entity recorded for undo.
const OPERATIONS = {
  create_trips: {
    endpoint: "/edit/trips/create_from_template",
    Icon: AddRoadIcon,
    entity: "trip",
    summary: (t, { preview, params }) =>
      t("chat.op.createSummary", {
        count: preview?.trips?.length ?? params?.departures?.length ?? 0,
        route: preview?.route_id || "",
        stops: preview?.stop_times_per_trip ?? "?",
      }),
    toast: (t, body) => t("chat.op.createdToast", { count: body.created_trips ?? 0 }),
    outcome: (body) => `Applied: ${body.created_trips} trip(s) created (${(body.trips || []).map((x) => x.trip_id).slice(0, 10).join(", ")}).`,
    entityId: (body, params) => body.trips?.[0]?.trip_id || params.template_trip_id,
  },
  shift_trips: {
    endpoint: "/edit/trips/shift",
    Icon: UpdateIcon,
    entity: "trip",
    summary: (t, { preview, params }) =>
      t("chat.op.shiftSummary", {
        count: preview?.trips ?? params?.trip_ids?.length ?? 0,
        offset: fmtOffset(params?.offset_secs || 0),
        stopTimes: preview?.stop_times ?? "?",
      }),
    toast: (t, body) => t("chat.op.shiftedToast", { count: body.shifted_trips ?? 0 }),
    outcome: (body, params) => `Applied: ${body.shifted_trips} trip(s) shifted by ${fmtOffset(params.offset_secs)}.`,
    entityId: (body, params) => params.trip_ids?.[0],
  },
  insert_stop: {
    endpoint: "/edit/stop_times/insert_pattern",
    Icon: AddLocationAltIcon,
    entity: "trip",
    summary: (t, { preview }) =>
      t("chat.op.insertSummary", {
        stop: preview?.stop?.stop_name || preview?.stop?.stop_id || "",
        count: preview?.trip_count ?? preview?.trips?.length ?? 0,
        route: preview?.route_id || "",
      }),
    toast: (t, body) => t("chat.op.insertedToast", { count: body.inserted ?? 0 }),
    outcome: (body) =>
      `Applied: stop ${body.stop?.stop_id} inserted in ${body.inserted} trip(s)` +
      (body.shapes_to_review?.length ? `; ${body.shapes_to_review.length} shape(s) to re-fit in the Shape Studio.` : "."),
    entityId: (body) => body.trips?.[0]?.trip_id,
  },
  merge_stops: {
    endpoint: "/edit/stops/merge",
    Icon: MergeTypeIcon,
    entity: "stop",
    summary: (t, { preview }) =>
      t("chat.op.mergeSummary", {
        count: preview?.duplicates?.length ?? 0,
        survivor: preview?.survivor?.stop_name || preview?.survivor?.stop_id || "",
        refs: Object.values(preview?.by_table || {}).reduce((a, b) => a + b, 0),
      }),
    toast: (t, body) => t("chat.op.mergedToast", { count: body.merged ?? 0 }),
    outcome: (body) => `Applied: ${body.merged} stop(s) merged into ${body.survivor?.stop_id}.`,
    entityId: (body, params) => params.survivor_id,
  },
  rename_stops: {
    endpoint: "/edit/stops/rename_batch",
    Icon: DriveFileRenameOutlineIcon,
    entity: "stop",
    summary: (t, { preview }) => t("chat.op.renameSummary", { count: preview?.renames?.length ?? 0 }),
    toast: (t, body) => t("chat.op.renamedToast", { count: body.renamed ?? 0 }),
    outcome: (body) => `Applied: ${body.renamed} stop(s) renamed.`,
    entityId: (body) => body.renames?.[0]?.stop_id,
  },
  // A change plan of the transformation engine: previewed again on the feed
  // as it is now, then committed as ONE edit.
  change_plan: {
    Icon: AutoFixHighOutlinedIcon,
    entity: "transform",
    run: async (params) => {
      const p = await previewChangePlan(params.plan);
      if (!p.id || p.blocked || (p.integrity || []).length) throw new Error(p.blocked ? "blocked" : "not applicable");
      const out = await commitChangePlan(p.id);
      return { ...out, applied: p.steps.filter((s) => s.status === "applied").length };
    },
    summary: (t, { preview, params }) => t("chat.op.changePlanSummary", { count: params?.plan?.operations?.length ?? 0, changes: preview?.lines?.length ?? 0 }),
    toast: (t, body) => t("chat.op.changePlanToast", { count: body.applied ?? 0 }),
    outcome: (body) => `Applied: the change plan (${body.applied} step(s)) as one edit.`,
    entityId: (body) => (body.tables || []).join(","),
  },
  extend_calendar: {
    endpoint: "/edit/calendar/extend",
    Icon: EventRepeatIcon,
    entity: "calendar",
    summary: (t, { preview }) => t("chat.op.extendSummary", { count: preview?.services?.length ?? 0, date: fmtDate(preview?.end_date) }),
    toast: (t, body) => t("chat.op.extendedToast", { count: body.extended ?? 0 }),
    outcome: (body) => `Applied: ${body.extended} service(s) extended to ${body.end_date}.`,
    entityId: (body) => body.services?.[0]?.service_id,
  },
};

const Mono = ({ children, sx }) => (
  <Typography component="span" sx={{ fontFamily: "monospace", fontSize: "0.68rem", ...sx }}>
    {children}
  </Typography>
);

const Note = ({ warn = false, Icon = null, children }) => (
  <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, mt: 0.5, fontSize: "0.7rem", color: warn ? "warning.dark" : "text.secondary", lineHeight: 1.45 }}>
    {Icon && <Icon sx={{ fontSize: 13, mt: 0.15, flexShrink: 0 }} />}
    <span>{children}</span>
  </Box>
);

// The plan's detail, per operation.
function Details({ operation, preview, params, selected, onToggle, applied }) {
  const { t } = useLanguage();
  const theme = useTheme();
  if (operation === "create_trips" && Array.isArray(preview?.trips)) {
    return (
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.6 }}>
        {preview.trips.slice(0, 12).map((tr) => (
          <Chip key={tr.trip_id} size="small" label={`${tr.first_departure} → ${tr.last_arrival}`} sx={{ height: 20, fontSize: "0.64rem", fontFamily: "monospace" }} />
        ))}
        {preview.trips.length > 12 && <Chip size="small" label={`+${preview.trips.length - 12}`} sx={{ height: 20, fontSize: "0.64rem" }} />}
      </Box>
    );
  }
  if (operation === "shift_trips" && preview?.first_departure) {
    return (
      <Typography sx={{ fontSize: "0.7rem", color: "text.disabled", mt: 0.4, fontFamily: "monospace" }}>
        {preview.first_departure} → {preview.last_arrival}
      </Typography>
    );
  }
  if (operation === "insert_stop") {
    const trips = preview?.trips || [];
    const sk = preview?.skipped || {};
    return (
      <Box sx={{ mt: 0.5 }}>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
          {trips.slice(0, 10).map((tr) => (
            <Chip key={tr.trip_id} size="small" label={`${tr.trip_id} · ${tr.arrival_time || "—"}`} sx={{ height: 20, fontSize: "0.64rem", fontFamily: "monospace" }} />
          ))}
          {trips.length > 10 && <Chip size="small" label={`+${(preview.trip_count || trips.length) - 10}`} sx={{ height: 20, fontSize: "0.64rem" }} />}
        </Box>
        {(sk.already_present > 0 || sk.no_anchor > 0) && (
          <Note>{t("chat.op.insertSkipped", { present: sk.already_present || 0, noAnchor: (sk.no_anchor || 0) + (sk.not_consecutive || 0) })}</Note>
        )}
        {Array.isArray(preview?.shapes_to_review) && preview.shapes_to_review.length > 0 && (
          <Note warn Icon={WarningAmberIcon}>
            {t("chat.op.insertShapes", { count: preview.shapes_to_review.length })}{" "}
            <Mono>{preview.shapes_to_review.slice(0, 4).map((s) => `${s.shape_id} (${s.distance_m} m)`).join(", ")}</Mono>
          </Note>
        )}
      </Box>
    );
  }
  if (operation === "merge_stops") {
    const dups = preview?.duplicates || [];
    return (
      <Box sx={{ mt: 0.5, display: "flex", flexDirection: "column", gap: 0.3 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.6, fontSize: "0.72rem" }}>
          <CheckCircleOutlineIcon sx={{ fontSize: 13, color: "success.main" }} />
          <b>{preview?.survivor?.stop_name || preview?.survivor?.stop_id}</b>
          <Mono sx={{ color: "text.disabled" }}>{preview?.survivor?.stop_id}</Mono>
        </Box>
        {dups.map((d) => (
          <Box key={d.stop_id} sx={{ display: "flex", alignItems: "center", gap: 0.6, fontSize: "0.72rem", pl: 2.3, color: "text.secondary" }}>
            <MergeTypeIcon sx={{ fontSize: 13 }} />
            <span style={{ textDecoration: "line-through" }}>{d.stop_name || d.stop_id}</span>
            <Mono sx={{ color: "text.disabled" }}>{d.stop_id}</Mono>
            <Chip size="small" label={`${d.distance_m ?? "?"} m · ${t("chat.op.stopTimes", { count: d.stop_times ?? 0 })}`} sx={{ height: 18, fontSize: "0.6rem" }} />
          </Box>
        ))}
        {preview?.trips_with_both > 0 && <Note warn Icon={WarningAmberIcon}>{t("chat.op.mergeBoth", { count: preview.trips_with_both })}</Note>}
        {preview?.filled && Object.keys(preview.filled).length > 0 && (
          <Note>{t("chat.op.mergeFilled", { fields: Object.keys(preview.filled).join(", ") })}</Note>
        )}
      </Box>
    );
  }
  if (operation === "rename_stops") {
    const rows = preview?.renames || params?.renames || [];
    return (
      <Box sx={{ mt: 0.5, borderRadius: 1, border: `1px solid ${alpha(theme.palette.divider, 0.8)}`, overflow: "hidden" }} data-testid="chat-rename-table">
        <Box sx={{ maxHeight: 220, overflowY: "auto" }}>
          {rows.map((r) => {
            const on = selected.has(r.stop_id);
            return (
              <Box
                key={r.stop_id}
                component="label"
                sx={{
                  display: "grid",
                  gridTemplateColumns: "auto minmax(0, 1fr) auto minmax(0, 1fr)",
                  alignItems: "center",
                  gap: 0.5,
                  px: 0.5,
                  py: 0.1,
                  fontSize: "0.72rem",
                  cursor: applied ? "default" : "pointer",
                  opacity: on ? 1 : 0.5,
                  "&:nth-of-type(even)": { background: alpha(theme.palette.text.primary, 0.03) },
                }}
              >
                <Checkbox size="small" checked={on} disabled={applied} onChange={() => onToggle(r.stop_id)} sx={{ p: 0.4 }} />
                <Box sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "text.secondary" }} title={r.stop_id}>
                  {r.old_name}
                </Box>
                <Box sx={{ color: "text.disabled" }}>→</Box>
                <Box sx={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>{r.stop_name}</Box>
              </Box>
            );
          })}
        </Box>
        <Box sx={{ px: 1, py: 0.4, fontSize: "0.66rem", color: "text.secondary", borderTop: `1px solid ${alpha(theme.palette.divider, 0.8)}` }}>
          {t("chat.op.renameSelected", { selected: selected.size, total: rows.length })}
        </Box>
      </Box>
    );
  }
  if (operation === "change_plan") {
    const steps = preview?.steps || [];
    const Status = { applied: CheckCircleOutlineIcon, blocked: HelpOutlineIcon, failed: ErrorOutlineIcon };
    return (
      <Box sx={{ mt: 0.5, display: "flex", flexDirection: "column", gap: 0.4 }} data-testid="chat-change-plan">
        {steps.map((st) => {
          const I = Status[st.status] || CheckCircleOutlineIcon;
          const color = st.status === "applied" ? "success.main" : st.status === "blocked" ? "warning.main" : st.status === "failed" ? "error.main" : "text.disabled";
          return (
            <Box key={st.id} sx={{ fontSize: "0.72rem", lineHeight: 1.45 }}>
              <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5 }}>
                <I sx={{ fontSize: 13, color, mt: 0.2, flexShrink: 0 }} />
                <span>{st.summary || st.error || st.type}</span>
              </Box>
              {(st.ambiguities || []).map((a, i) => (
                <Note key={i} warn>
                  {a.message}
                  {a.options?.length ? ` (${a.options.join(" · ")})` : ""}
                </Note>
              ))}
            </Box>
          );
        })}
        {(preview?.lines || []).length > 0 && (
          <Box sx={{ mt: 0.25, pl: 2.2 }}>
            {preview.lines.slice(0, 6).map((l, i) => (
              <Typography key={i} sx={{ fontSize: "0.68rem", color: "text.secondary", lineHeight: 1.45 }}>
                {l}
              </Typography>
            ))}
            {preview.lines.length > 6 && <Note>+{preview.lines.length - 6}</Note>}
          </Box>
        )}
        {(preview?.integrity || []).length > 0 && <Note warn Icon={WarningAmberIcon}>{t("chat.op.changePlanIntegrity")}</Note>}
        <Chip size="small" variant="outlined" icon={<AutoFixHighOutlinedIcon sx={{ fontSize: 12 }} />} label={t("chat.op.openChangeStudio")} onClick={() => window.dispatchEvent(new CustomEvent("gtfs:open-change-studio", { detail: { plan: params?.plan || null } }))} data-testid="chat-open-change-studio" sx={{ alignSelf: "flex-start", height: 22, fontSize: "0.66rem", fontWeight: 700, mt: 0.25 }} />
      </Box>
    );
  }
  if (operation === "extend_calendar") {
    const services = preview?.services || [];
    return (
      <Box sx={{ mt: 0.5, display: "flex", flexDirection: "column", gap: 0.25 }}>
        {services.slice(0, 8).map((s) => (
          <Box key={s.service_id} sx={{ display: "flex", alignItems: "center", gap: 0.6, fontSize: "0.72rem", flexWrap: "wrap" }}>
            <Mono sx={{ fontWeight: 700 }}>{s.service_id}</Mono>
            <Mono sx={{ color: "text.secondary" }}>
              {fmtDate(s.old_end_date)} → {fmtDate(s.end_date)}
            </Mono>
            <Chip size="small" label={t("chat.op.trips", { count: s.trips })} sx={{ height: 18, fontSize: "0.6rem" }} />
            {s.exceptions_in_window > 0 && <Chip size="small" color="warning" variant="outlined" label={t("chat.op.extendExceptions", { count: s.exceptions_in_window })} sx={{ height: 18, fontSize: "0.6rem" }} />}
          </Box>
        ))}
        {services.length > 8 && <Note>+{services.length - 8}</Note>}
        {preview?.feed_info && <Note>{t("chat.op.extendFeedInfo", { old: fmtDate(preview.feed_info.old_end_date), new: fmtDate(preview.feed_info.end_date) })}</Note>}
      </Box>
    );
  }
  return null;
}

export default function OperationProposalCard({ proposal, index, onOutcome }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const { editing, entering, enterEditMode, recordEdit, undoLast } = useEditMode();
  const [phase, setPhase] = useState("idle"); // idle | applying | applied | undone
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const { operation, params, preview } = proposal;
  const op = OPERATIONS[operation] || OPERATIONS.shift_trips;
  const Icon = op.Icon;

  // Rename proposals are reviewable line by line.
  const renameRows = useMemo(() => (operation === "rename_stops" ? preview?.renames || params?.renames || [] : []), [operation, preview, params]);
  const [selected, setSelected] = useState(() => new Set(renameRows.map((r) => r.stop_id)));
  const toggle = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const summary = op.summary(t, { preview, params });
  const applied = phase === "applied";
  const nothingSelected = (operation === "rename_stops" && selected.size === 0) || (operation === "change_plan" && Boolean(preview?.blocked || preview?.empty || (preview?.integrity || []).length));

  const apply = useCallback(async () => {
    if (phase === "applying" || nothingSelected) return;
    setPhase("applying");
    setError(null);
    const body = operation === "rename_stops" ? { renames: (params?.renames || []).filter((r) => selected.has(r.stop_id)) } : params;
    try {
      let data;
      if (op.run) data = await op.run(body);
      else {
        const res = await fetchWithSession(`${API_BASE_URL}${op.endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      }
      setResult(data);
      setPhase("applied");
      recordEdit(op.toast(t, data), data.validation, { entity: op.entity, entityId: op.entityId(data, params), noUndoAction: true });
      if (onOutcome) onOutcome(op.outcome(data, params));
    } catch (err) {
      setError(err.message || t("chat.repair.networkError"));
      setPhase("idle");
    }
  }, [phase, nothingSelected, operation, params, selected, op, recordEdit, onOutcome, t]);

  const undo = useCallback(async () => {
    const ok = await undoLast(result?.undoEntryId ?? null);
    if (ok === false) return;
    setPhase("undone");
    if (onOutcome) onOutcome("Applied then undone by the user.");
  }, [undoLast, result, onOutcome]);

  const openStudio = useCallback(() => {
    window.dispatchEvent(new CustomEvent("gtfs:navigate", { detail: { target: "shape_studio", routeId: preview?.route_id || result?.route_id || null } }));
  }, [preview, result]);

  return (
    <Box
      data-testid="chat-operation"
      data-operation={operation}
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
          {proposal.rationale && (
            <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", mt: 0.2, lineHeight: 1.45, fontStyle: "italic" }}>{proposal.rationale}</Typography>
          )}
          <Details operation={operation} preview={preview} params={params} selected={selected} onToggle={toggle} applied={applied || phase === "undone"} />
        </Box>
      </Box>
      <Box sx={{ px: 1.5, pb: 1.1, display: "flex", alignItems: "center", gap: 0.75, flexWrap: "wrap" }}>
        {phase === "idle" || phase === "applying" ? (
          editing ? (
            <Button
              size="small"
              variant="contained"
              startIcon={phase === "applying" ? <CircularProgress size={12} color="inherit" /> : <PlayArrowIcon sx={{ fontSize: 14 }} />}
              disabled={phase === "applying" || nothingSelected}
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
            <Typography sx={{ fontSize: "0.74rem", fontWeight: 600, color: "success.main" }}>{op.toast(t, result || {})}</Typography>
            <Chip size="small" icon={<UndoIcon sx={{ fontSize: 12 }} />} label={t("chat.repair.undo")} onClick={undo} data-testid="chat-operation-undo" sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700 }} />
            {operation === "insert_stop" && Array.isArray(result?.shapes_to_review) && result.shapes_to_review.length > 0 && (
              <Chip
                size="small"
                color="warning"
                variant="outlined"
                icon={<EditLocationAltIcon sx={{ fontSize: 12 }} />}
                label={t("audit.action.openStudio")}
                onClick={openStudio}
                sx={{ height: 20, fontSize: "0.66rem", fontWeight: 700 }}
              />
            )}
          </>
        )}
        {phase === "undone" && <Chip size="small" label={t("chat.repair.undone")} sx={{ height: 20, fontSize: "0.66rem" }} />}
        {error && <Typography sx={{ fontSize: "0.72rem", color: "error.main" }}>{error}</Typography>}
      </Box>
    </Box>
  );
}
