/**
 * AcknowledgementForm — what a named person accepts, knowingly, before a
 * delivery (« Ce que vous acceptez sous votre nom », G4).
 *
 * One item per must clause not met or not measurable, one for the
 * operations whose quotes the engine could not find in the document, one
 * per assumption of the plan — a requirement declared « à vérifier à la
 * main » that nobody checked by hand among them, said as such (`wish:
 * true`, its quote) — and one for the errors the client's reference GTFS
 * already carried (`baseline_errors`: accepted by name, never silently);
 * the person's name ("I, the undersigned
 * … accept these deviations knowingly") and an optional note. It never
 * offers to accept a NEW validator error: those are said to be fixed, never
 * accepted (`ack-validator-never`). What it produces is exactly the
 * server's acknowledgement body (services/acknowledgement.parse):
 *
 *   { by: { name }, clauses: [ids], sources?: true, assumptions?: [ids], baseline_errors?: true, changes?: true, note? }
 *
 * The same form serves the Change Studio's "Apply" (scope commit) and the
 * Network Studio's build (scope compile: clauses and assumptions).
 *
 *   itemsOf(gate)                      → [{ key, kind: "clause"|"sources"|"assumption"|"baseline_errors"|"changes_not_asked", id, status, text, expected, measured, note, operations, wish?, quote?, errors?, rules? }]
 *   itemsFromRefusal(code, details)    → the items a 409 CLAUSES_* / SOURCES_UNVERIFIED / ASSUMPTIONS_UNVALIDATED / BASELINE_ERRORS names
 *   mergeItems(items, extra)           → items with the server's list folded in (by key)
 *   bodyOf(items, value)               → the acknowledgement body, or null when nothing is ticked
 *   allTicked(items, value)            → every item ticked
 *   NAME_OK(name)                      → 2–120 characters with a letter (the server's rule)
 *   rememberName(name) / rememberedName()   the name kept in this browser (gtfs:ack-name)
 *
 * Several items: « Tout cocher » (`ack-all`) ticks them all at once, and unticks them. The list is shown whole,
 * however long: what a person accepts under their name is never behind a scroll of its own.
 *
 * Every item is said in the person's language, never in the engine's English: a clause by its own words and its
 * status (« non tenue », « non mesurable » — with the engine's note when it has words for it); what the engine measured, in its
 * own terms, is the row's detail (`ack-measure`, opened on demand, `lang="en"`) and its tooltip (« non tenue :
 * mesuré …, attendu … »), never its text.
 * A point of the brief's spreadsheets kept « à vérifier à la main » that an operation of the change builds from its
 * cells (`coveredOf(item)` → { operations: [{ n, title, cells }], whole }, the host's: utils/sheetCoverage.coverageOfItem)
 * is said covered by that operation, with the cells it cites — still accepted by name like every item. One wholly
 * covered is listed after the decisions (`ack-covered`, under `ack-covered-title`); one only partly covered stays
 * among them (`ack-wish`, `data-covered="partly"`): what it names beside the cited cells — often the footnote that
 * matters — is still the person's to check by hand, said so, and keeps the list « des écarts » (ack.accept): only a
 * list of the engine's choices and of points wholly covered is said « des choix ».
 *
 *   <AcknowledgementForm ref items value onChange highlight={[keys]} nameInvalid disabled opNumber={(id) => n} coveredOf={(item) => …} onBack={…} backLabel testid />
 *   ref.focusName() / ref.focusItems(keys) — the refusal's focus (400 on the name, 409 on the items)
 */

import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { Box, Button, Checkbox, FormControlLabel, TextField, Typography, alpha, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";
import { engineNote } from "../../utils/engineNotes";
import { assumptionSaid } from "../../utils/assumptionWords";

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
// What an assumption is, told as the note tells it (utils/assumptionWords): its kind, else the server's own sentence —
// a change plan renames the contract's pending items a1…an and keeps only their text, so the text says what it is
// when the kind did not travel (a wish nobody checked, an assumption of the contract nobody confirmed, a contract
// assumed by a name), never printed in the server's English.
const assumptionItem = (a) => {
  const s = assumptionSaid(a);
  // A wish is still an assumption for the server (acknowledge.assumptions carries its id): only its words differ.
  // `why`: what a sheet's reading says of a value it could not turn into a clause (« type de jour illisible »).
  // What else the server names: a choice the engine made by itself (`engine`), an assumption of the
  // contract nobody confirmed (its own words), a contract assumed (`by`).
  const said = s.said === "engine" ? { said: "engine" } : s.said === "contract_assumption" ? { said: "contract_assumption", words: s.words } : s.said === "contract_assumed" ? { said: "contract_assumed", by: s.by } : {};
  return { key: `assumption:${a.id}`, kind: "assumption", id: a.id, text: a.text || "", ...said, ...(s.said === "wish" && s.quote ? { wish: true, quote: s.quote, ...(s.why ? { why: s.why } : {}) } : {}) };
};
const sourcesItem = (operations) => ({ key: "sources", kind: "sources", operations: (operations || []).map((o) => ({ id: o.id, reason: o.reason || null })) });
const baselineItem = (b) => ({ key: "baseline_errors", kind: "baseline_errors", errors: Number(b?.errors) || 0, rules: b?.rules && typeof b.rules === "object" ? b.rules : {} });
// The lines and dates the plan changes that no decided objective asks for (the engine's change accounting), or an
// accounting that could not run: one item, accepted by name as a whole.
const changesItem = (c) => ({ key: "changes_not_asked", kind: "changes_not_asked", changes: (Array.isArray(c?.changes) ? c.changes : []).map((n) => ({ route: n.route, label: n.label || n.route, count: Number(n.count) || 0, from: n.from || null, to: n.to || null })), error: c?.error || null });

const listOf = (gate, code) => (gate?.acknowledgeable || []).find((x) => x && x.code === code) || null;

/** The items of a preview's gate (engine.gateOf's `acknowledgeable`). */
export const itemsOf = (gate) => {
  const failing = (listOf(gate, "clauses_failing")?.clauses || []).map((c) => clauseItem(c, "fail"));
  const unknown = (listOf(gate, "clauses_unknown")?.clauses || []).map((c) => clauseItem(c, "unknown"));
  const ops = listOf(gate, "sources_unverified")?.operations || [];
  const assumptions = (listOf(gate, "assumptions_unvalidated")?.assumptions || []).map(assumptionItem);
  const baseline = listOf(gate, "baseline_errors");
  const changes = listOf(gate, "changes_not_asked");
  return [...failing, ...unknown, ...(ops.length ? [sourcesItem(ops)] : []), ...assumptions, ...(baseline ? [baselineItem(baseline)] : []), ...(changes ? [changesItem(changes)] : [])];
};

/** The items a 409 names ({ clauses, unacknowledged } / { operations } / { assumptions, unacknowledged } / { errors, rules }). */
export const itemsFromRefusal = (code, details = {}) => {
  const d = details || {};
  if (code === "CLAUSES_FAILING" || code === "CLAUSES_UNKNOWN") return (Array.isArray(d.clauses) ? d.clauses : []).map((c) => clauseItem(c, c.status || (code === "CLAUSES_FAILING" ? "fail" : "unknown")));
  if (code === "SOURCES_UNVERIFIED") return Array.isArray(d.operations) && d.operations.length ? [sourcesItem(d.operations)] : [];
  if (code === "ASSUMPTIONS_UNVALIDATED") return (Array.isArray(d.assumptions) ? d.assumptions : []).map(assumptionItem);
  if (code === "BASELINE_ERRORS") return [baselineItem(d)];
  if (code === "CHANGES_NOT_ASKED") return [changesItem(d)];
  return [];
};

/** The keys a 409 says are still to accept (`unacknowledged`, or every item it names). */
export const missingKeys = (code, details = {}) => {
  const d = details || {};
  if (code === "SOURCES_UNVERIFIED") return ["sources"];
  if (code === "BASELINE_ERRORS") return ["baseline_errors"];
  if (code === "CHANGES_NOT_ASKED") return ["changes_not_asked"];
  const prefix = code === "ASSUMPTIONS_UNVALIDATED" ? "assumption" : "clause";
  const ids = Array.isArray(d.unacknowledged) ? d.unacknowledged : itemsFromRefusal(code, d).map((i) => i.id);
  return ids.map((id) => `${prefix}:${id}`);
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
  const assumptions = ticked.filter((i) => i.kind === "assumption").map((i) => i.id);
  const sources = ticked.some((i) => i.kind === "sources");
  const baseline = ticked.some((i) => i.kind === "baseline_errors");
  const changes = ticked.some((i) => i.kind === "changes_not_asked");
  const note = typeof value.note === "string" && value.note.trim() ? value.note.trim().slice(0, 400) : null;
  return { by: { name: String(value.name || "").trim() }, clauses, ...(sources ? { sources: true } : {}), ...(assumptions.length ? { assumptions } : {}), ...(baseline ? { baseline_errors: true } : {}), ...(changes ? { changes: true } : {}), ...(note ? { note } : {}) };
};

/**
 * A point of the brief's sheets an operation of the change builds from its cells, in one sentence: its words, the
 * operations (their place in the plan and their title) and the cells they cite — and, when they cite only part of it,
 * what is left to check by hand. The delivery's list and its note (transform/synthesis) say it alike.
 */
export const coveredSentence = (t, quote, covered) => {
  const ops = (covered?.operations || []).map((o) => (o.title ? `${o.n} (${o.title})` : String(o.n))).join(", ");
  const cells = [...new Set((covered?.operations || []).flatMap((o) => o.cells || []))].join(", ");
  return `${t("ack.covered", { quote, ops, cells })}${covered?.whole ? "" : ` — ${t("ack.covered.partly")}`}`;
};

/**
 * What the engine measured of a clause, in its own terms (English): the row's detail and tooltip, never its text.
 * → { measured, expected, note, tip } (the parts it gives; `tip`: the tooltip, the status in the person's words around
 * them) | null. A note the person's words already say is not repeated.
 */
const measureOf = (i, t) => {
  if (i.kind !== "clause") return null;
  const said = (v) => (v == null || v === "" ? null : String(v));
  const note = i.status === "unknown" && said(i.note) && engineNote(i.note, t) === i.note ? said(i.note) : null;
  const out = { measured: i.status === "unknown" ? null : said(i.measured), expected: i.status === "unknown" ? null : said(i.expected), note };
  if (!out.measured && !out.expected && !out.note) return null;
  return { ...out, tip: note ? t("ack.clause.unknown", { note }) : t("ack.clause.fail", { measured: out.measured ?? "?", expected: out.expected ?? "?" }) };
};

const AcknowledgementForm = forwardRef(function AcknowledgementForm({ items = [], value, onChange, highlight = [], nameInvalid = false, disabled = false, opNumber = null, coveredOf = null, onBack = null, backLabel = null, testid = "ack-form", variant = "box" }, ref) {
  // `variant`: "box" (its own tinted box, the step's page) or "decision" (inside the draft's decision: a list whose
  // points each say their kind, without a box of their own).
  const plain = variant === "decision";
  const { t } = useLanguage();
  const theme = useTheme();
  const nameRef = useRef(null);
  const itemRefs = useRef({});
  const checked = new Set(value?.checked || []);
  // The points an operation of the change covers by their cells: said so — after the decisions when it covers them
  // wholly, among the decisions when part of the point is still the person's to check by hand.
  const coverage = new Map(items.map((i) => [i.key, coveredOf ? coveredOf(i) || null : null]));
  const wholly = (i) => Boolean(coverage.get(i.key)?.whole);
  const shownItems = [...items.filter((i) => !wholly(i)), ...items.filter(wholly)];
  const firstCovered = shownItems.find(wholly)?.key || null;

  useImperativeHandle(ref, () => ({
    focusName: () => nameRef.current?.focus(),
    focusItems: (keys = []) => {
      // The first one as the list shows them (the points an operation wholly covers come last).
      const order = shownItems.map((i) => i.key);
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
    // A point of a sheet an operation of the change builds from its cells: covered by that operation, with the cells
    // it cites — part of it still the person's when it cites only some of them.
    const covered = coverage.get(i.key);
    if (covered) return coveredSentence(t, i.quote, covered);
    // A requirement declared not measurable that nobody checked by hand: said with its words, accepted by name.
    if (i.kind === "assumption" && i.wish) return `${t("ack.wish", { quote: i.quote })}${i.why ? ` (${i.why})` : ""}`;
    if (i.kind === "assumption" && i.said === "engine") return t("ack.engineChoice", { text: i.text });
    if (i.kind === "assumption" && i.said === "contract_assumption") return t("ack.contractAssumption", { text: i.words });
    if (i.kind === "assumption" && i.said === "contract_assumed") return t("ack.contractAssumed", { name: i.by });
    if (i.kind === "assumption") return t("ack.engineChoice", { text: i.text });
    // A contract nobody decided at ②, recorded empty under the name given here (never an unnamed empty contract).
    if (i.kind === "contract_empty") return t("ack.contractEmpty");
    if (i.kind === "baseline_errors") return t("ack.baselineErrors", { count: i.errors, rules: Object.entries(i.rules || {}).map(([code, n]) => `${code} ×${n}`).join(", ") || "—" });
    if (i.kind === "changes_not_asked") return i.error ? t("ack.changesUnaccounted") : t("ack.changesNotAsked", { count: i.changes.length, lines: i.changes.map((n) => `${n.label} (${n.count})`).join(", ") || "—" });
    // A clause: its own words and its status in the person's language — the engine's note only when it has words
    // for it (engineNote); what it measured is the row's detail (measureOf), never the text.
    const note = i.status === "unknown" && i.note ? engineNote(i.note, t) : null;
    const what = i.status === "unknown" ? (note && note !== i.note ? t("ack.clause.unknown", { note }) : t("ack.clause.unmeasured")) : t("ack.clause.failed");
    return `${i.text || i.id} — ${what}`;
  };
  // The engine's measure, in its own terms: opened on demand under the row (keyboard and touch read it too).
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
    i.kind === "assumption" && i.wish
      ? { tag: t("ack.kind.wish"), tone: warn, text: `« ${i.quote} »${i.why ? ` — ${i.why}` : ""}` }
      : i.kind === "assumption" && i.said === "contract_assumption"
        ? { tag: t("ack.kind.assumed"), tone: theme.palette.info.main, text: i.words }
        : i.kind === "assumption" && (i.said === "engine" || !i.said)
          ? { tag: t("ack.kind.engine"), tone: theme.palette.info.main, text: i.text }
          : i.kind === "clause"
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
      {shownItems.map((i) => {
        const hot = highlight.includes(i.key);
        const covered = wholly(i);
        const partly = !covered && Boolean(coverage.get(i.key));
        const m = measureOf(i, t);
        return (
          <React.Fragment key={i.key}>
            {i.key === firstCovered && (
              <Typography data-testid="ack-covered-title" sx={{ fontSize: "0.72rem", fontWeight: 700, color: "text.secondary", mt: 0.25 }}>
                {t("ack.covered.title", { count: shownItems.filter(wholly).length })}
              </Typography>
            )}
            <Box data-testid={covered ? "ack-covered" : i.kind === "sources" ? "ack-sources" : i.kind === "baseline_errors" ? "ack-baseline-errors" : i.kind === "changes_not_asked" ? "ack-changes-not-asked" : i.wish ? "ack-wish" : "ack-item"} data-item={i.key} data-covered={covered ? "whole" : partly ? "partly" : undefined} data-highlight={hot ? "true" : "false"} title={m ? m.tip : undefined} sx={plain ? { display: "flex", flexDirection: "column", px: 1, py: 0.5, borderTop: shownItems[0]?.key === i.key ? "none" : `1px solid ${theme.palette.divider}`, outline: hot ? `2px solid ${warn}` : "none", outlineOffset: -2, background: hot ? alpha(warn, 0.12) : checked.has(i.key) ? alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.1 : 0.05) : "transparent", transition: "background-color .15s" } : { display: "flex", flexDirection: "column", borderRadius: "8px", pr: 0.5, outline: hot ? `2px solid ${warn}` : "none", background: hot ? alpha(warn, 0.12) : "transparent" }}>
              <FormControlLabel
                sx={{ m: 0, flex: 1, alignItems: "flex-start", "& .MuiFormControlLabel-label": { fontSize: plain ? "0.84rem" : "0.76rem", lineHeight: 1.5, pt: 0.9 } }}
                control={<Checkbox size="small" checked={checked.has(i.key)} onChange={(e) => toggle(i.key, e.target.checked)} disabled={disabled} inputRef={(el) => { itemRefs.current[i.key] = el; }} inputProps={{ "aria-invalid": hot ? "true" : "false" }} />}
                label={
                  plain && kindOf(i) && !coverage.get(i.key) ? (
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
            {/* A list made only of the engine's own choices (and the reference's errors, and the points an operation
                wholly covers) holds no deviation: said as choices — a point only partly covered is still one. */}
            <Typography sx={{ fontSize: "0.76rem", flex: "1 1 160px", pb: 2.5 }}>{t(items.length && items.every((i) => (i.kind === "assumption" && i.said === "engine") || i.kind === "baseline_errors" || coverage.get(i.key)?.whole) ? "ack.accept.choices" : "ack.accept")}</Typography>
          </Box>
          <TextField size="small" label={t("ack.note")} value={value?.note || ""} onChange={(e) => set({ note: e.target.value })} disabled={disabled} multiline maxRows={3} inputProps={{ "data-testid": "ack-note", maxLength: 400 }} />
          {!plain && <Typography sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45 }}>{t("ack.recorded")}</Typography>}
        </>
      )}
      {/* A NEW error is never accepted; the reference GTFS's own errors are, by name: the sentence says which. */}
      <Typography data-testid="ack-validator-never" sx={{ fontSize: "0.7rem", color: "text.secondary", lineHeight: 1.45 }}>
        {plain && items.length > 0 ? `${t("ack.recorded")} ` : ""}
        {t(items.some((i) => i.kind === "baseline_errors") ? "ack.validatorNewNever" : "ack.validatorNever")}
      </Typography>
    </Box>
  );
});

export default AcknowledgementForm;
