/**
 * What a named person accepts knowingly before a commit (G4): one item per must clause not met or not measurable, one
 * for the unverified quotes, one for the reference feed's own errors, one for the changes not asked, then the name and
 * an optional note. A NEW validator error is never offered. `bodyOf` is exactly the server's acknowledgement body
 * (services/acknowledgement.parse). Items are said in the person's language; the engine's English measure is only the
 * row's folded detail and tooltip. The list is shown whole: what a person accepts by name is never behind a scroll.
 */

import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { Box, Button, Checkbox, FormControlLabel, TextField, Typography, alpha, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { engineNote } from "../../utils/engineNotes";

const NAME_KEY = "gtfs:ack-name";

export const NAME_OK = (s) => typeof s === "string" && s.trim().length >= 2 && s.trim().length <= 120 && /\p{L}/u.test(s);

export const rememberedName = () => {
  try {
    return localStorage.getItem(NAME_KEY) || "";
  } catch {
    return "";
  }
};
export const rememberName = (name) => {
  try {
    if (NAME_OK(name)) localStorage.setItem(NAME_KEY, name.trim());
  } catch {
    /* storage unavailable: the name is typed again next time */
  }
};

const clauseItem = (c, status) => ({ key: `clause:${c.id}`, kind: "clause", id: c.id, status: c.status || status, text: c.text || c.kind || "", expected: c.expected ?? null, measured: c.measured ?? null, note: c.note ?? null });
const sourcesItem = (operations) => ({ key: "sources", kind: "sources", operations: (operations || []).map((o) => ({ id: o.id, reason: o.reason || null })) });
const baselineItem = (b) => ({ key: "baseline_errors", kind: "baseline_errors", errors: Number(b?.errors) || 0, rules: b?.rules && typeof b.rules === "object" ? b.rules : {} });
// The errors the working copy carries that the reference GTFS did not (an edit by hand since it was opened): named apart from the reference's own.
const currentItem = (c) => ({ key: "current_errors", kind: "current_errors", errors: Number(c?.errors) || 0, rules: c?.rules && typeof c.rules === "object" ? c.rules : {} });
// The validator's leftover errors, of either origin: never a deviation of the change itself.
const ERROR_KINDS = new Set(["baseline_errors", "current_errors"]);
// The changes no decided objective asks for (the engine's change accounting), or an accounting that could not run:
// one item, accepted by name as a whole.
const ROW_CHANGES = ["added", "removed", "changed"];
const changesItem = (c) => {
  const list = Array.isArray(c?.changes) ? c.changes : [];
  const tables = list.filter((n) => n && n.table).map((n) => ({ table: String(n.table), what: ROW_CHANGES.includes(n.what) ? n.what : "changed", rows: Number(n.rows) || 0, columns: Array.isArray(n.columns) ? n.columns.map(String) : [], examples: Array.isArray(n.examples) ? n.examples.map(String) : [] }));
  return { key: "changes_not_asked", kind: "changes_not_asked", changes: list.filter((n) => n && !n.table).map((n) => ({ route: n.route, label: n.label || n.route, count: Number(n.count) || 0, from: n.from || null, to: n.to || null })), ...(tables.length ? { tables } : {}), error: c?.error || null };
};
const rowsText = (tables, t) => tables.map((x) => (x.what === "added" ? t("ack.rowsChange.added", { table: x.table, count: x.rows }) : x.what === "removed" ? t("ack.rowsChange.removed", { table: x.table, count: x.rows }) : t("ack.rowsChange.changed", { table: x.table, count: x.rows, columns: x.columns.join(", ") || "—" }))).join(" · ");

const listOf = (gate, code) => (gate?.acknowledgeable || []).find((x) => x && x.code === code) || null;

/** The items of a preview's gate (engine.gateOf's `acknowledgeable`). */
export const itemsOf = (gate) => {
  const failing = (listOf(gate, "clauses_failing")?.clauses || []).map((c) => clauseItem(c, "fail"));
  const unknown = (listOf(gate, "clauses_unknown")?.clauses || []).map((c) => clauseItem(c, "unknown"));
  const ops = listOf(gate, "sources_unverified")?.operations || [];
  const baseline = listOf(gate, "baseline_errors");
  const current = listOf(gate, "current_errors");
  const changes = listOf(gate, "changes_not_asked");
  return [...failing, ...unknown, ...(ops.length ? [sourcesItem(ops)] : []), ...(baseline ? [baselineItem(baseline)] : []), ...(current ? [currentItem(current)] : []), ...(changes ? [changesItem(changes)] : [])];
};

/** The items a 409 names ({ clauses, unacknowledged } / { operations } / { errors, rules } / { changes }). */
export const itemsFromRefusal = (code, details = {}) => {
  const d = details || {};
  if (code === "CLAUSES_FAILING" || code === "CLAUSES_UNKNOWN") return (Array.isArray(d.clauses) ? d.clauses : []).map((c) => clauseItem(c, c.status || (code === "CLAUSES_FAILING" ? "fail" : "unknown")));
  if (code === "SOURCES_UNVERIFIED") return Array.isArray(d.operations) && d.operations.length ? [sourcesItem(d.operations)] : [];
  if (code === "BASELINE_ERRORS") return [baselineItem(d)];
  if (code === "CURRENT_ERRORS") return [currentItem(d)];
  if (code === "CHANGES_NOT_ASKED") return [changesItem(d)];
  return [];
};

/** The keys a 409 says are still to accept (`unacknowledged`, or every item it names). */
export const missingKeys = (code, details = {}) => {
  const d = details || {};
  if (code === "SOURCES_UNVERIFIED") return ["sources"];
  if (code === "BASELINE_ERRORS") return ["baseline_errors"];
  if (code === "CURRENT_ERRORS") return ["current_errors"];
  if (code === "CHANGES_NOT_ASKED") return ["changes_not_asked"];
  const ids = Array.isArray(d.unacknowledged) ? d.unacknowledged : itemsFromRefusal(code, d).map((i) => i.id);
  return ids.map((id) => `clause:${id}`);
};

export const mergeItems = (items, extra) => {
  const out = [...(items || [])];
  for (const x of extra || []) {
    const i = out.findIndex((y) => y.key === x.key);
    if (i >= 0) out[i] = { ...out[i], ...x };
    else out.push(x);
  }
  return out;
};

export const allTicked = (items, value) => (items || []).every((i) => (value?.checked || []).includes(i.key));

/** The server's acknowledgement body for what is ticked, or null when nothing is. */
export const bodyOf = (items, value = {}) => {
  const checked = new Set(value.checked || []);
  const ticked = (items || []).filter((i) => checked.has(i.key));
  if (!ticked.length) return null;
  const clauses = ticked.filter((i) => i.kind === "clause").map((i) => i.id);
  const sources = ticked.some((i) => i.kind === "sources");
  const baseline = ticked.some((i) => i.kind === "baseline_errors");
  const current = ticked.some((i) => i.kind === "current_errors");
  const changes = ticked.some((i) => i.kind === "changes_not_asked");
  const note = typeof value.note === "string" && value.note.trim() ? value.note.trim().slice(0, 400) : null;
  return { by: { name: String(value.name || "").trim() }, clauses, ...(sources ? { sources: true } : {}), ...(baseline ? { baseline_errors: true } : {}), ...(current ? { current_errors: true } : {}), ...(changes ? { changes: true } : {}), ...(note ? { note } : {}) };
};

/**
 * What the engine measured of a clause, in its own English terms: the row's detail and tooltip, never its text.
 * A note the person's words already say is not repeated.
 */
const measureOf = (i, t) => {
  if (i.kind !== "clause") return null;
  const said = (v) => (v == null || v === "" ? null : String(v));
  const note = i.status === "unknown" && said(i.note) && engineNote(i.note, t) === i.note ? said(i.note) : null;
  const out = { measured: i.status === "unknown" ? null : said(i.measured), expected: i.status === "unknown" ? null : said(i.expected), note };
  if (!out.measured && !out.expected && !out.note) return null;
  return { ...out, tip: note ? t("ack.clause.unknown", { note }) : t("ack.clause.fail", { measured: out.measured ?? "?", expected: out.expected ?? "?" }) };
};

const AcknowledgementForm = forwardRef(function AcknowledgementForm({ items = [], value, onChange, highlight = [], nameInvalid = false, disabled = false, opNumber = null, onBack = null, backLabel = null, testid = "ack-form", variant = "box" }, ref) {
  // "box": a tinted box of its own; "decision": a plain list inside the draft's decision, each point tagged with its kind.
  const plain = variant === "decision";
  const { t } = useLanguage();
  const theme = useTheme();
  const nameRef = useRef(null);
  const itemRefs = useRef({});
  const checked = new Set(value?.checked || []);

  useImperativeHandle(ref, () => ({
    focusName: () => nameRef.current?.focus(),
    focusItems: (keys = []) => {
      // The first one as the list shows them.
      const order = items.map((i) => i.key);
      const first = (keys.length ? [...order.filter((k) => keys.includes(k)), ...keys] : order).find((k) => itemRefs.current[k]);
      itemRefs.current[first]?.focus();
    },
  }));

  const set = (patch) => onChange?.({ checked: [...checked], name: value?.name || "", note: value?.note || "", ...patch });
  const toggle = (key, on) => set({ checked: on ? [...new Set([...checked, key])] : [...checked].filter((k) => k !== key) });

  const labelOf = (i) => {
    if (i.kind === "sources") {
      const numbers = i.operations.map((o) => (opNumber ? opNumber(o.id) : null) || o.id).join(", ");
      return t("ack.sources", { n: numbers });
    }
    if (i.kind === "baseline_errors") return t("ack.baselineErrors", { count: i.errors, rules: Object.entries(i.rules || {}).map(([code, n]) => `${code} ×${n}`).join(", ") || "—" });
    if (i.kind === "current_errors") return t("ack.currentErrors", { count: i.errors, rules: Object.entries(i.rules || {}).map(([code, n]) => `${code} ×${n}`).join(", ") || "—" });
    if (i.kind === "changes_not_asked" && i.error) return t("ack.changesUnaccounted");
    if (i.kind === "changes_not_asked" && i.tables?.length) {
      const rows = rowsText(i.tables, t);
      return i.changes.length ? t("ack.changesAndRowsNotAsked", { count: i.changes.length, lines: i.changes.map((n) => `${n.label} (${n.count})`).join(", "), rows }) : t("ack.rowsNotAsked", { rows });
    }
    if (i.kind === "changes_not_asked") return t("ack.changesNotAsked", { count: i.changes.length, lines: i.changes.map((n) => `${n.label} (${n.count})`).join(", ") || "—" });
    // The engine's note only when engineNote has words for it; what it measured is the row's detail, never the text.
    const note = i.status === "unknown" && i.note ? engineNote(i.note, t) : null;
    const what = i.status === "unknown" ? (note && note !== i.note ? t("ack.clause.unknown", { note }) : t("ack.clause.unmeasured")) : t("ack.clause.failed");
    return `${i.text || i.id} — ${what}`;
  };
  // A <details>, so keyboard and touch open it too.
  const measureDetail = (i) => {
    const m = measureOf(i, t);
    if (!m) return null;
    const part = (label, text) => (
      <Box component="span" sx={{ display: "block" }}>
        {label ? `${label} ` : ""}
        <Box component="span" lang="en">
          {text}
        </Box>
      </Box>
    );
    return (
      <Box component="details" data-testid="ack-measure" sx={{ pl: 4.25, fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45, overflowWrap: "anywhere", "& summary": { cursor: "pointer", fontWeight: 600 } }}>
        <summary>{t("ack.clause.measure")}</summary>
        {m.measured && part(t("ack.clause.measured"), m.measured)}
        {m.expected && part(t("ack.clause.expected"), m.expected)}
        {m.note && part(null, m.note)}
      </Box>
    );
  };

  const warn = theme.palette.warning.main;
  // In the decision each point says its kind in a tag, then its words (the label without its kind's prefix).
  const kindOf = (i) =>
    i.kind === "clause"
      ? { tag: t(i.status === "unknown" ? "ack.kind.unmeasured" : "ack.kind.failed"), tone: i.status === "unknown" ? warn : theme.palette.error.main, text: i.text || i.id }
      : null;
  return (
    <Box component="section" aria-labelledby={`${testid}-title`} data-testid={testid} data-variant={variant} sx={plain ? { display: "flex", flexDirection: "column", gap: 1.25 } : { display: "flex", flexDirection: "column", gap: 0.75, p: 1.25, borderRadius: "12px", background: alpha(warn, theme.palette.mode === "dark" ? 0.12 : 0.06), border: `1px solid ${alpha(warn, 0.3)}` }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      <Typography id={`${testid}-title`} component="h3" sx={plain ? { flex: 1, fontSize: "0.86rem", fontWeight: 600, color: "text.secondary", lineHeight: 1.5 } : { flex: 1, fontSize: "0.82rem", fontWeight: 800 }}>
        {plain ? t("ack.decision.lead", { count: items.length }) : t("ack.title")}
      </Typography>
      {items.length > 1 && plain && (
        <Button size="small" onClick={() => set({ checked: items.every((i) => checked.has(i.key)) ? [...checked].filter((key) => !items.some((i) => i.key === key)) : [...new Set([...checked, ...items.map((i) => i.key)])] })} disabled={disabled} data-testid="ack-all" sx={{ flexShrink: 0, textTransform: "none", fontWeight: 650 }}>
          {items.every((i) => checked.has(i.key)) ? t("ack.none.all") : t("ack.all.accept", { count: items.length })}
        </Button>
      )}
      </Box>
      {items.length === 0 && <Typography sx={{ fontSize: "0.76rem", color: "text.secondary" }}>{t("ack.none")}</Typography>}
      {items.length > 1 && !plain && (
        <FormControlLabel
          sx={{ m: 0, alignSelf: "flex-start", "& .MuiFormControlLabel-label": { fontSize: "0.76rem", fontWeight: 700 } }}
          control={<Checkbox size="small" checked={items.every((i) => checked.has(i.key))} indeterminate={items.some((i) => checked.has(i.key)) && !items.every((i) => checked.has(i.key))} onChange={(e) => set({ checked: e.target.checked ? [...new Set([...checked, ...items.map((i) => i.key)])] : [...checked].filter((key) => !items.some((i) => i.key === key)) })} disabled={disabled} inputProps={{ "data-testid": "ack-all" }} />}
          label={t("ack.all", { count: items.length })}
        />
      )}
      <Box data-testid="ack-items" sx={plain ? { display: "flex", flexDirection: "column", borderRadius: "12px", border: `1px solid ${theme.palette.divider}`, overflow: "hidden" } : { display: "flex", flexDirection: "column", gap: 0.75 }}>
      {items.map((i) => {
        const hot = highlight.includes(i.key);
        const m = measureOf(i, t);
        return (
          <React.Fragment key={i.key}>
            <Box data-testid={i.kind === "sources" ? "ack-sources" : i.kind === "baseline_errors" ? "ack-baseline-errors" : i.kind === "current_errors" ? "ack-current-errors" : i.kind === "changes_not_asked" ? "ack-changes-not-asked" : "ack-item"} data-item={i.key} data-highlight={hot ? "true" : "false"} title={m ? m.tip : undefined} sx={plain ? { display: "flex", flexDirection: "column", px: 1, py: 0.5, borderTop: items[0]?.key === i.key ? "none" : `1px solid ${theme.palette.divider}`, outline: hot ? `2px solid ${warn}` : "none", outlineOffset: -2, background: hot ? alpha(warn, 0.12) : checked.has(i.key) ? alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.1 : 0.05) : "transparent", transition: "background-color .15s" } : { display: "flex", flexDirection: "column", borderRadius: "8px", pr: 0.5, outline: hot ? `2px solid ${warn}` : "none", background: hot ? alpha(warn, 0.12) : "transparent" }}>
              <FormControlLabel
                sx={{ m: 0, flex: 1, alignItems: "flex-start", "& .MuiFormControlLabel-label": { fontSize: plain ? "0.84rem" : "0.76rem", lineHeight: 1.5, pt: 0.9 } }}
                control={<Checkbox size="small" checked={checked.has(i.key)} onChange={(e) => toggle(i.key, e.target.checked)} disabled={disabled} inputRef={(el) => { itemRefs.current[i.key] = el; }} inputProps={{ "aria-invalid": hot ? "true" : "false" }} />}
                label={
                  plain && kindOf(i) ? (
                    <Box component="span" sx={{ display: "flex", flexDirection: "column", gap: 0.4 }}>
                      <Box component="span" data-testid="ack-kind" sx={{ alignSelf: "flex-start", px: 0.75, py: "1px", borderRadius: 99, fontSize: "0.68rem", fontWeight: 750, letterSpacing: "0.02em", color: kindOf(i).tone, backgroundColor: alpha(kindOf(i).tone, 0.12) }}>
                        {kindOf(i).tag}
                      </Box>
                      <Box component="span">{kindOf(i).text}</Box>
                    </Box>
                  ) : (
                    labelOf(i)
                  )
                }
              />
              {measureDetail(i)}
            </Box>
          </React.Fragment>
        );
      })}
      </Box>
      {onBack && (
        <Box>
          <Button size="small" onClick={onBack} disabled={disabled} sx={{ textTransform: "none", fontWeight: 700, fontSize: "0.74rem", px: 0.75 }}>
            {backLabel || t("ack.backToChange")}
          </Button>
        </Box>
      )}
      {items.length > 0 && (
        <>
          <Box sx={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 1 }}>
            <TextField
              size="small"
              label={t("ack.name")}
              value={value?.name || ""}
              onChange={(e) => set({ name: e.target.value })}
              disabled={disabled}
              required
              error={nameInvalid}
              helperText={t("ack.nameHint")}
              inputRef={nameRef}
              inputProps={{ "data-testid": "ack-name", maxLength: 120, autoComplete: "name", "aria-invalid": nameInvalid ? "true" : "false" }}
              sx={{ flex: "1 1 220px" }}
            />
            {/* A list made only of the reference's own errors holds no deviation of this change: said as choices. */}
            <Typography sx={{ fontSize: "0.76rem", flex: "1 1 160px", pb: 2.5 }}>{t(items.length && items.every((i) => ERROR_KINDS.has(i.kind)) ? "ack.accept.choices" : "ack.accept")}</Typography>
          </Box>
          <TextField size="small" label={t("ack.note")} value={value?.note || ""} onChange={(e) => set({ note: e.target.value })} disabled={disabled} multiline maxRows={3} inputProps={{ "data-testid": "ack-note", maxLength: 400 }} />
          {!plain && <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45 }}>{t("ack.recorded")}</Typography>}
        </>
      )}
      {/* A NEW error is never accepted; the reference GTFS's own errors are, by name: the sentence says which. */}
      <Typography data-testid="ack-validator-never" sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45 }}>
        {plain && items.length > 0 ? `${t("ack.recorded")} ` : ""}
        {t(items.some((i) => ERROR_KINDS.has(i.kind)) ? "ack.validatorNewNever" : "ack.validatorNever")}
      </Typography>
    </Box>
  );
});

export default AcknowledgementForm;
