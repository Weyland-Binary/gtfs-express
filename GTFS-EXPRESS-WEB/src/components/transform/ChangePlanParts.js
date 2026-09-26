/**
 * ChangePlanParts — the pieces of the Change Studio's review side:
 *
 *   OperationCard     one step of the plan: what it does (the engine's
 *                     summary), where the brief asks it (the quote), its
 *                     parameters, and — when the engine blocked it — the
 *                     questions, answered with one click on an option
 *   OperationDialog   add or edit an operation with a form generated from
 *                     the catalogue (lines picked from the feed)
 *   ChangesPanel      the semantic diff, phrased in the reader's language,
 *                     grouped by line, with when each change applies
 *   ChecksPanel       the brief's clauses before → after, integrity, and
 *                     the canonical validator's new errors
 */

import React, { useEffect, useMemo, useState } from "react";
import { Alert, Autocomplete, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, MenuItem, TextField, Tooltip, Typography, alpha, useTheme } from "@mui/material";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import FormatQuoteIcon from "@mui/icons-material/FormatQuote";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { useLanguage } from "../../contexts/LanguageContext";
import { soft } from "../network/StudioUI";

export const STATUS = {
  applied: { color: "success", Icon: CheckCircleOutlineIcon },
  skipped: { color: "default", Icon: RemoveCircleOutlineIcon },
  blocked: { color: "warning", Icon: HelpOutlineIcon },
  failed: { color: "error", Icon: ErrorOutlineIcon },
  pending: { color: "default", Icon: HelpOutlineIcon },
};

// A translation with a fallback when the key is unknown (codes the server may add later).
const tf = (t, key, params, fallback) => {
  const v = t(key, params || undefined);
  return v === key ? fallback : v;
};

const fmtValue = (v) => (v == null ? "—" : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v));

/** One answer field for a blocked parameter: the options as chips, else a text field. */
function Answer({ ambiguity, onAnswer }) {
  const { t } = useLanguage();
  const [value, setValue] = useState("");
  if (Array.isArray(ambiguity.options) && ambiguity.options.length) {
    return (
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.5 }}>
        {ambiguity.options.slice(0, 12).map((o) => (
          <Chip key={o} size="small" label={o} onClick={() => onAnswer(ambiguity.param, o)} data-testid="change-answer-option" sx={{ fontWeight: 600, fontSize: "0.72rem" }} />
        ))}
      </Box>
    );
  }
  return (
    <Box component="form" onSubmit={(e) => { e.preventDefault(); if (value.trim()) onAnswer(ambiguity.param, value.trim()); }} sx={{ display: "flex", gap: 0.5, mt: 0.5 }}>
      <TextField size="small" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("transform.answerPlaceholder", { param: ambiguity.param })} inputProps={{ "data-testid": "change-answer-input" }} sx={{ flex: 1, "& input": { fontSize: "0.78rem", py: 0.6 } }} />
      <Button type="submit" size="small" variant="outlined" disabled={!value.trim()} sx={{ textTransform: "none" }}>
        {t("transform.answer")}
      </Button>
    </Box>
  );
}

export function OperationCard({ op, step, def, index, count, onAnswer, onRemove, onMove, onEdit, busy }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const status = step?.status || "pending";
  const S = STATUS[status] || STATUS.pending;
  const tone = S.color === "default" ? theme.palette.text.secondary : theme.palette[S.color].main;
  return (
    <Box data-testid="change-operation" data-status={status} sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${status === "blocked" || status === "failed" ? alpha(tone, 0.5) : theme.palette.divider}` }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography sx={{ fontSize: "0.7rem", fontWeight: 800, color: "text.secondary", width: 18, flexShrink: 0 }}>{index + 1}</Typography>
        <S.Icon sx={{ fontSize: 18, color: tone }} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography sx={{ fontSize: "0.84rem", fontWeight: 700, lineHeight: 1.3 }} noWrap title={def?.title || op.type}>
            {def?.title || op.type}
          </Typography>
          <Typography sx={{ fontSize: "0.66rem", color: "text.secondary", fontFamily: "monospace" }}>{op.type} · {op.id}</Typography>
        </Box>
        <Chip size="small" label={t(`transform.status.${status}`)} color={S.color === "default" ? undefined : S.color} variant="outlined" sx={{ height: 20, fontSize: "0.64rem", fontWeight: 700 }} />
        <Tooltip title={t("transform.moveUp")}>
          <span>
            <IconButton size="small" disabled={busy || index === 0} onClick={() => onMove(op.id, -1)} aria-label={t("transform.moveUp")}>
              <ArrowUpwardIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("transform.moveDown")}>
          <span>
            <IconButton size="small" disabled={busy || index === count - 1} onClick={() => onMove(op.id, 1)} aria-label={t("transform.moveDown")}>
              <ArrowDownwardIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("transform.edit")}>
          <span>
            <IconButton size="small" disabled={busy} onClick={() => onEdit(op)} aria-label={t("transform.edit")} data-testid="change-edit">
              <EditOutlinedIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("transform.remove")}>
          <span>
            <IconButton size="small" disabled={busy} onClick={() => onRemove(op.id)} aria-label={t("transform.remove")} data-testid="change-remove">
              <DeleteOutlineIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
      </Box>
      {step?.summary && <Typography sx={{ fontSize: "0.78rem", mt: 0.75, lineHeight: 1.45 }}>{step.summary}</Typography>}
      {step?.error && (
        <Alert severity="error" sx={{ mt: 0.75, py: 0, fontSize: "0.74rem" }}>
          {step.error}
        </Alert>
      )}
      {op.source?.quote && (
        <Box sx={{ display: "flex", gap: 0.5, mt: 0.75, p: 0.75, borderRadius: "8px", background: soft(theme) }}>
          <FormatQuoteIcon sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0, mt: 0.1 }} />
          <Typography sx={{ fontSize: "0.72rem", fontStyle: "italic", color: "text.secondary", lineHeight: 1.45 }}>
            {op.source.quote}
            {op.source.page ? ` — ${t("transform.page", { page: op.source.page })}` : ""}
          </Typography>
        </Box>
      )}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mt: 0.75 }}>
        {Object.entries(op.params || {}).map(([k, v]) => (
          <Chip key={k} size="small" variant="outlined" label={`${k}: ${fmtValue(v)}`} sx={{ height: 20, fontSize: "0.66rem", maxWidth: "100%" }} title={`${k}: ${fmtValue(v)}`} />
        ))}
      </Box>
      {(step?.ambiguities || []).map((a, i) => (
        <Box key={`${a.param}-${i}`} data-testid="change-question" sx={{ mt: 1, p: 1, borderRadius: "8px", background: alpha(theme.palette.warning.main, 0.08) }}>
          <Typography sx={{ fontSize: "0.76rem", fontWeight: 600, lineHeight: 1.4 }}>{a.message}</Typography>
          <Answer ambiguity={a} onAnswer={(param, value) => onAnswer(op.id, param, value)} />
        </Box>
      ))}
      {(step?.warnings || []).length > 0 && (
        <Box sx={{ mt: 0.75, display: "flex", flexDirection: "column", gap: 0.25 }}>
          {step.warnings.slice(0, 6).map((w, i) => (
            <Box key={i} sx={{ display: "flex", gap: 0.5, alignItems: "flex-start" }}>
              <WarningAmberIcon sx={{ fontSize: 13, color: "warning.main", mt: 0.2, flexShrink: 0 }} />
              <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.4 }}>{w}</Typography>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

// ── Add / edit an operation ─────────────────────────────────────────────────

const DAY_CHOICES = ["weekday", "saturday", "sunday", "weekend", "daily", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const parseInput = (type, raw) => {
  if (raw === "" || raw == null) return undefined;
  if (type === "number") {
    const n = Number(String(raw).replace(",", "."));
    return Number.isFinite(n) ? n : raw;
  }
  const s = String(raw).trim();
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  }
  if (["times", "dates", "stops"].includes(type) && s.includes(",")) return s.split(",").map((x) => x.trim()).filter(Boolean);
  return s;
};
const toInput = (v) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

export function OperationDialog({ open, catalogue, routes, initial, onClose, onSave }) {
  const { t } = useLanguage();
  const [type, setType] = useState(initial?.type || null);
  const [values, setValues] = useState({});
  const [quote, setQuote] = useState("");
  useEffect(() => {
    if (!open) return;
    setType(initial?.type || null);
    setValues(Object.fromEntries(Object.entries(initial?.params || {}).map(([k, v]) => [k, toInput(v)])));
    setQuote(initial?.source?.quote || "");
  }, [open, initial]);
  const def = useMemo(() => (catalogue || []).find((o) => o.type === type) || null, [catalogue, type]);
  const missing = (def?.params || []).filter((p) => p.required && !String(values[p.name] ?? "").trim()).map((p) => p.name);
  const save = () => {
    const params = {};
    for (const p of def.params || []) {
      const v = parseInput(p.type, values[p.name]);
      if (v !== undefined) params[p.name] = v;
    }
    // Parameters the catalogue does not list (kept from the planner) stay as they were.
    for (const [k, v] of Object.entries(initial?.params || {})) if (!(def.params || []).some((p) => p.name === k) && !(k in params)) params[k] = v;
    onSave({ ...(initial || {}), type, params, source: quote.trim() ? { ...(initial?.source || {}), quote: quote.trim() } : initial?.source });
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth data-testid="change-operation-dialog">
      <DialogTitle sx={{ fontWeight: 800 }}>{initial?.id ? t("transform.editOperation") : t("transform.addOperation")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1.5, pt: "8px !important" }}>
        <Autocomplete
          options={catalogue || []}
          value={def}
          onChange={(_, v) => setType(v?.type || null)}
          getOptionLabel={(o) => `${o.title} (${o.type})`}
          groupBy={(o) => o.category}
          isOptionEqualToValue={(a, b) => a.type === b.type}
          disabled={Boolean(initial?.id)}
          renderInput={(p) => <TextField {...p} size="small" label={t("transform.operationType")} inputProps={{ ...p.inputProps, "data-testid": "change-type" }} />}
        />
        {def?.description && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{def.description}</Typography>}
        {(def?.params || []).map((p) => {
          const common = { size: "small", fullWidth: true, label: `${p.name}${p.required ? " *" : ""}`, helperText: p.description, value: values[p.name] ?? "", onChange: (e) => setValues((s) => ({ ...s, [p.name]: e.target.value })), inputProps: { "data-testid": `change-param-${p.name}` } };
          if (p.type === "route" && routes?.length) {
            return (
              <TextField key={p.name} {...common} select>
                <MenuItem value="">—</MenuItem>
                {routes.map((r) => (
                  <MenuItem key={r.id} value={r.short_name || r.id}>
                    {r.short_name || r.id} {r.long_name ? `— ${r.long_name}` : ""}
                  </MenuItem>
                ))}
              </TextField>
            );
          }
          if (p.type === "enum" && Array.isArray(p.enum)) {
            return (
              <TextField key={p.name} {...common} select>
                <MenuItem value="">—</MenuItem>
                {p.enum.map((v) => (
                  <MenuItem key={v} value={v}>
                    {v}
                  </MenuItem>
                ))}
              </TextField>
            );
          }
          if (p.type === "days") {
            return (
              <Autocomplete key={p.name} freeSolo options={DAY_CHOICES} value={values[p.name] ?? ""} onInputChange={(_, v) => setValues((s) => ({ ...s, [p.name]: v }))} renderInput={(params) => <TextField {...params} size="small" label={common.label} helperText={p.description} />} />
            );
          }
          if (p.type === "date") return <TextField key={p.name} {...common} type="date" InputLabelProps={{ shrink: true }} />;
          if (p.type === "time") return <TextField key={p.name} {...common} placeholder="HH:MM" />;
          if (p.type === "number") return <TextField key={p.name} {...common} type="number" />;
          return <TextField key={p.name} {...common} />;
        })}
        {def && <TextField size="small" label={t("transform.sourceQuote")} helperText={t("transform.sourceQuoteHint")} value={quote} onChange={(e) => setQuote(e.target.value)} multiline minRows={1} />}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: "none" }}>
          {t("app.cancel")}
        </Button>
        <Tooltip title={missing.length ? t("transform.missingParams", { params: missing.join(", ") }) : ""}>
          <span>
            <Button variant="contained" disableElevation disabled={!def} onClick={save} data-testid="change-operation-save" sx={{ textTransform: "none", fontWeight: 700 }}>
              {t("transform.saveOperation")}
            </Button>
          </span>
        </Tooltip>
      </DialogActions>
    </Dialog>
  );
}

// ── The changes, in the reader's language ───────────────────────────────────

/** One diff item as a sentence (the server's codes, phrased here). */
export const describeItem = (t, it) => {
  const when = it.dates ? ` (${it.dates.count === 1 ? it.dates.from : t("transform.diff.period", { from: it.dates.from, to: it.dates.to, count: it.dates.count })})` : "";
  const day = it.day ? `${tf(t, `transform.day.${it.day}`, null, it.day)}${when}` : "";
  const v = (x) => (x == null ? t("transform.diff.none") : x);
  switch (it.code) {
    case "route_added": return t("transform.diff.routeAdded");
    case "route_removed": return t("transform.diff.routeRemoved");
    case "route_attribute": return t("transform.diff.attribute", { field: it.field, before: v(it.before), after: v(it.after) });
    case "route_stops_added": return t("transform.diff.stopsAdded", { stops: it.stops.join(", ") });
    case "route_stops_removed": return t("transform.diff.stopsRemoved", { stops: it.stops.join(", ") });
    case "service_trips": return t("transform.diff.trips", { day, dir: it.direction, before: it.before, after: it.after });
    case "service_first": return t("transform.diff.first", { day, dir: it.direction, before: v(it.before), after: v(it.after) });
    case "service_last": return t("transform.diff.last", { day, dir: it.direction, before: v(it.before), after: v(it.after) });
    case "service_headway": return t("transform.diff.headway", { day, period: tf(t, `transform.period.${it.period}`, null, it.period), dir: it.direction, before: v(it.before), after: v(it.after) });
    case "service_running": return t("transform.diff.running", { day, dir: it.direction, before: it.before, after: it.after });
    case "service_retimed": return t("transform.diff.retimed", { day });
    case "vehicles_peak": return t("transform.diff.vehicles", { day, before: it.before, after: it.after });
    case "stop_added": return t("transform.diff.stopAdded", { name: it.name });
    case "stop_removed": return t("transform.diff.stopRemoved", { name: it.name });
    case "stop_renamed": return t("transform.diff.stopRenamed", { before: it.before, after: it.after });
    case "stop_moved": return t("transform.diff.stopMoved", { name: it.name, meters: it.meters });
    case "validity": return t("transform.diff.validity", { before: it.before ? `${it.before.start}–${it.before.end}` : t("transform.diff.none"), after: it.after ? `${it.after.start}–${it.after.end}` : t("transform.diff.none") });
    case "services_changed": return t("transform.diff.services", { count: it.count });
    default: return it.code;
  }
};

export function ChangesPanel({ preview }) {
  const { t } = useLanguage();
  const theme = useTheme();
  if (!preview) return <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", p: 2 }}>{t("transform.noPreview")}</Typography>;
  const items = preview.diff?.items || [];
  if (!items.length) return <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", p: 2 }} data-testid="change-diff-empty">{t("transform.noChanges")}</Typography>;
  const byLine = new Map();
  const other = [];
  for (const it of items) {
    if (it.label) {
      if (!byLine.has(it.label)) byLine.set(it.label, []);
      byLine.get(it.label).push(it);
    } else other.push(it);
  }
  const totals = preview.diff?.totals;
  return (
    <Box data-testid="change-diff" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      {totals && (
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
          {[["trips", totals.trips_weekday], ["vehicles", totals.vehicles_peak_weekday], ["routes", totals.routes], ["stops", totals.stops]].map(([k, x]) => (
            <Box key={k} sx={{ px: 1.25, py: 0.75, borderRadius: "10px", background: soft(theme) }}>
              <Typography sx={{ fontSize: "0.66rem", color: "text.secondary", fontWeight: 600 }}>{t(`transform.totals.${k}`)}</Typography>
              <Typography sx={{ fontSize: "0.9rem", fontWeight: 800 }}>
                {x.before} → {x.after}
              </Typography>
            </Box>
          ))}
        </Box>
      )}
      {[...byLine.entries()].map(([label, list]) => (
        <Box key={label} sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
          <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, mb: 0.5 }}>{t("transform.line", { line: label })}</Typography>
          {list.map((it, i) => (
            <Typography key={i} sx={{ fontSize: "0.76rem", lineHeight: 1.5 }} data-testid="change-diff-line">
              {describeItem(t, it)}
            </Typography>
          ))}
        </Box>
      ))}
      {other.length > 0 && (
        <Box sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
          {other.map((it, i) => (
            <Typography key={i} sx={{ fontSize: "0.76rem", lineHeight: 1.5 }} data-testid="change-diff-line">
              {describeItem(t, it)}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

export function ChecksPanel({ preview, validating, onValidate }) {
  const { t } = useLanguage();
  const theme = useTheme();
  if (!preview) return <Typography sx={{ fontSize: "0.8rem", color: "text.secondary", p: 2 }}>{t("transform.noPreview")}</Typography>;
  const before = new Map((preview.conformance?.before?.results || []).map((r) => [r.id, r]));
  const after = preview.conformance?.after?.results || [];
  const statusChip = (s) => <Chip size="small" label={tf(t, `transform.clause.${s}`, null, s)} color={s === "pass" ? "success" : s === "fail" ? "error" : "default"} variant="outlined" sx={{ height: 20, fontSize: "0.64rem", fontWeight: 700 }} />;
  const v = preview.validation;
  return (
    <Box data-testid="change-checks" sx={{ display: "flex", flexDirection: "column", gap: 1.25 }}>
      <Box sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
        <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, mb: 0.75 }}>{t("transform.checks.clauses")}</Typography>
        {!after.length && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("transform.checks.noClauses")}</Typography>}
        {after.map((r) => (
          <Box key={r.id} data-testid="change-clause" data-status={r.status} sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.4 }}>
            <Typography sx={{ fontSize: "0.76rem", flex: 1, minWidth: 0 }} title={JSON.stringify(r.params)}>
              {r.text || `${r.kind} ${JSON.stringify(r.params)}`}
              {r.status !== "pass" && r.measured != null ? ` — ${t("transform.checks.measured", { expected: r.expected ?? "?", measured: r.measured })}` : ""}
            </Typography>
            {before.get(r.id) && statusChip(before.get(r.id).status)}
            <Typography sx={{ fontSize: "0.7rem", color: "text.secondary" }}>→</Typography>
            {statusChip(r.status)}
          </Box>
        ))}
      </Box>
      <Box sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
        <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, mb: 0.75 }}>{t("transform.checks.integrity")}</Typography>
        {(preview.integrity || []).length ? (
          preview.integrity.map((i) => (
            <Typography key={i.code} sx={{ fontSize: "0.76rem", color: "error.main" }}>
              {tf(t, `transform.integrity.${i.code}`, { count: i.count }, `${i.code} ×${i.count}`)}
            </Typography>
          ))
        ) : (
          <Typography sx={{ fontSize: "0.76rem", color: "success.main" }} data-testid="change-integrity-ok">
            {t("transform.checks.integrityOk")}
          </Typography>
        )}
      </Box>
      <Box sx={{ p: 1.25, borderRadius: "12px", background: theme.palette.background.paper, boxShadow: `0 0 0 1px ${theme.palette.divider}` }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.75 }}>
          <Typography sx={{ fontSize: "0.82rem", fontWeight: 800, flex: 1 }}>{t("transform.checks.validator")}</Typography>
          <Button size="small" variant="outlined" disabled={validating || !preview.id} onClick={onValidate} data-testid="change-validate" sx={{ textTransform: "none" }}>
            {validating ? t("transform.checks.validating") : t("transform.checks.runValidator")}
          </Button>
        </Box>
        {!v && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("transform.checks.validatorHint")}</Typography>}
        {v?.error && <Alert severity="warning" sx={{ py: 0 }}>{v.error}</Alert>}
        {v && !v.error && (
          <Typography sx={{ fontSize: "0.76rem", color: v.new_errors?.length ? "error.main" : "success.main" }} data-testid="change-validator-result">
            {v.new_errors?.length ? t("transform.checks.newErrors", { list: v.new_errors.map((e) => `${e.code} (${e.before} → ${e.after})`).join(", ") }) : t("transform.checks.noNewErrors")}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
