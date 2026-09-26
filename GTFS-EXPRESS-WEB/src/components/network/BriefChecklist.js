/**
 * BriefChecklist — what the user asked, clause by clause, and whether the
 * plan does it: pass, fail, cannot be measured, or waived by the user. Each
 * clause shows what was expected and what the plan gives; the user confirms
 * a clause, lifts it (with a reason), sets it back, or changes it from
 * required to wished. Their decision is final: the assistant never
 * overturns it, and the next turn and the build are measured against it.
 *
 *   BriefBadge     the compact "Brief 9/11" chip of the Studio's footer
 *   BriefChecklist the list (editable in the Studio, read-only in a report)
 */

import React, { useState } from "react";
import { Box, Chip, InputBase, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import HighlightOffIcon from "@mui/icons-material/HighlightOff";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import DoNotDisturbOnOutlinedIcon from "@mui/icons-material/DoNotDisturbOnOutlined";
import AssignmentTurnedInOutlinedIcon from "@mui/icons-material/AssignmentTurnedInOutlined";
import { useLanguage } from "../../contexts/LanguageContext";
import { QuietButton, soft } from "./StudioUI";

const STATUS_ICON = { pass: CheckCircleOutlineIcon, fail: HighlightOffIcon, unknown: HelpOutlineIcon, waived: DoNotDisturbOnOutlinedIcon };
const statusColor = (status, theme) => ({ pass: theme.palette.success.main, fail: theme.palette.error.main, unknown: theme.palette.text.disabled, waived: theme.palette.text.disabled })[status] || theme.palette.text.disabled;

/** A clause in words: its own text, else its kind and parameters. */
export const clauseLabel = (clause, t) => {
  if (clause?.text) return clause.text;
  const key = `network.clause.kind.${clause?.kind}`;
  const kind = t(key);
  const params = clause?.params || {};
  const bits = [params.line, params.place, params.from && params.to ? `${params.from?.name ?? params.from} → ${params.to?.name ?? params.to}` : null, params.minutes != null ? `${params.minutes} min` : null, params.max_minutes != null ? `≤ ${params.max_minutes} min` : null, params.count, params.vehicles, params.amount, Array.isArray(params.days) ? params.days.join(", ") : params.day].filter((x) => x != null && x !== "");
  return `${kind === key ? clause?.kind : kind}${bits.length ? ` · ${bits.join(" · ")}` : ""}`;
};

export function BriefBadge({ conformance, onClick = null }) {
  const { t } = useLanguage();
  const theme = useTheme();
  if (!conformance?.summary) return null;
  const { must } = conformance.summary;
  const color = must.fail ? theme.palette.error.main : must.unknown ? theme.palette.warning.dark : theme.palette.success.main;
  return (
    <Tooltip title={t("network.contract.open")}>
      <Chip size="small" icon={<AssignmentTurnedInOutlinedIcon sx={{ fontSize: 14, color: `${color} !important` }} />} label={t("network.contract.badge", { pass: must.pass, total: must.total })} onClick={onClick || undefined} data-testid="brief-badge" data-state={must.fail ? "fail" : must.unknown ? "unknown" : "pass"} sx={{ height: 24, fontSize: "0.7rem", fontWeight: 800, color, background: alpha(color, theme.palette.mode === "dark" ? 0.18 : 0.1), "&:hover": { background: alpha(color, theme.palette.mode === "dark" ? 0.26 : 0.16) } }} />
    </Tooltip>
  );
}

function ClauseRow({ clause, verdict, onChange }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState("");
  const status = clause.status === "waived" ? "waived" : verdict?.status || "unknown";
  const Icon = STATUS_ICON[status];
  const color = statusColor(status, theme);
  const decide = (patch) => onChange({ ...clause, ...patch, decided_by: "user" });
  return (
    <Box component="li" data-testid="brief-clause" data-status={status} data-clause={clause.id} sx={{ display: "flex", gap: 1, py: 0.75, borderTop: `1px solid ${alpha(theme.palette.divider, 0.6)}`, "&:first-of-type": { borderTop: "none" } }}>
      <Icon sx={{ fontSize: 17, color, mt: 0.1, flexShrink: 0 }} aria-label={t(`network.contract.status.${status}`)} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.75, flexWrap: "wrap" }}>
          <Typography component="span" sx={{ fontSize: "0.8rem", fontWeight: 700, textDecoration: status === "waived" ? "line-through" : "none", color: status === "waived" ? "text.secondary" : "text.primary", overflowWrap: "anywhere" }}>
            {clauseLabel(clause, t)}
          </Typography>
          <Typography component="span" sx={{ fontSize: "0.64rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: clause.level === "must" ? "text.secondary" : "text.disabled" }}>
            {t(`network.contract.level.${clause.level}`)}
            {clause.decided_by === "user" ? ` · ${t("network.contract.byUser")}` : clause.status === "assumed" ? ` · ${t("network.contract.assumed")}` : ""}
          </Typography>
        </Box>
        {verdict && status !== "waived" && (verdict.expected || verdict.measured) && (
          <Typography sx={{ fontSize: "0.72rem", color: "text.secondary", overflowWrap: "anywhere" }}>
            {verdict.expected ? `${t("network.contract.expected")} ${verdict.expected}` : ""}
            {verdict.expected && verdict.measured ? " · " : ""}
            {verdict.measured ? `${t("network.contract.measured")} ${verdict.measured}` : ""}
          </Typography>
        )}
        {status === "unknown" && verdict?.note && <Typography sx={{ fontSize: "0.7rem", color: "text.disabled" }}>{verdict.note}</Typography>}
        {status === "waived" && clause.reason && <Typography sx={{ fontSize: "0.7rem", color: "text.disabled" }}>{clause.reason}</Typography>}
        {clause.source && <Typography sx={{ fontSize: "0.64rem", color: "text.disabled" }}>{t("network.contract.source", { source: clause.source })}</Typography>}
        {onChange && (
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mt: 0.4 }}>
            {waiving ? (
              <>
                <InputBase autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("network.contract.waiveReason")} inputProps={{ "aria-label": t("network.contract.waiveReason"), "data-testid": "brief-waive-reason" }} sx={{ flex: 1, minWidth: 160, fontSize: "0.74rem", px: 1, borderRadius: "8px", background: soft(theme) }} onKeyDown={(e) => e.key === "Enter" && (decide({ status: "waived", reason: reason.trim() || undefined }), setWaiving(false))} />
                <QuietButton onClick={() => { decide({ status: "waived", reason: reason.trim() || undefined }); setWaiving(false); }} data-testid="brief-waive-ok">{t("network.contract.waive")}</QuietButton>
                <QuietButton onClick={() => setWaiving(false)}>{t("app.cancel")}</QuietButton>
              </>
            ) : status === "waived" ? (
              <QuietButton onClick={() => decide({ status: "confirmed", reason: undefined })} data-testid="brief-restore">{t("network.contract.restore")}</QuietButton>
            ) : (
              <>
                {clause.status !== "confirmed" && <QuietButton onClick={() => decide({ status: "confirmed" })} data-testid="brief-confirm">{t("network.contract.confirm")}</QuietButton>}
                <QuietButton onClick={() => setWaiving(true)} data-testid="brief-waive">{t("network.contract.waive")}</QuietButton>
                <QuietButton onClick={() => decide({ level: clause.level === "must" ? "should" : "must" })} data-testid="brief-level">{t(clause.level === "must" ? "network.contract.makeShould" : "network.contract.makeMust")}</QuietButton>
              </>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/**
 * @param {{ clauses: object[], conformance?: object, onChange?: (clauses) => void }} props
 * `clauses` are the recorded clauses (editable); without them (a report),
 * the verdicts alone are listed.
 */
export function BriefChecklist({ clauses = [], conformance = null, onChange = null }) {
  const { t } = useLanguage();
  const verdicts = new Map((conformance?.results || []).map((r) => [r.id, r]));
  // Clauses implied by the brief (lines requested) have a verdict but no record.
  const rows = [...clauses];
  for (const r of conformance?.results || []) if (!rows.some((c) => c.id === r.id)) rows.push({ id: r.id, kind: r.kind, level: r.level, status: r.status === "waived" ? "waived" : "stated", text: r.text, params: r.params || {}, source: "brief", derived: true });
  if (!rows.length) return <Typography sx={{ fontSize: "0.78rem", color: "text.secondary" }}>{t("network.contract.empty")}</Typography>;
  const order = { fail: 0, unknown: 1, pass: 2, waived: 3 };
  const sorted = rows.map((c) => ({ c, v: verdicts.get(c.id) })).sort((a, b) => (order[a.c.status === "waived" ? "waived" : a.v?.status || "unknown"] ?? 1) - (order[b.c.status === "waived" ? "waived" : b.v?.status || "unknown"] ?? 1));
  return (
    <Box component="ul" data-testid="brief-checklist" sx={{ listStyle: "none", m: 0, p: 0 }}>
      {sorted.map(({ c, v }) => (
        <ClauseRow
          key={c.id}
          clause={c}
          verdict={v}
          onChange={
            onChange
              ? (next) => {
                  // A clause implied by the brief becomes a recorded one when the user decides on it.
                  const { derived, ...rec } = next; // eslint-disable-line no-unused-vars
                  onChange(clauses.some((x) => x.id === rec.id) ? clauses.map((x) => (x.id === rec.id ? rec : x)) : [...clauses, rec]);
                }
              : null
          }
        />
      ))}
    </Box>
  );
}

export default BriefChecklist;
