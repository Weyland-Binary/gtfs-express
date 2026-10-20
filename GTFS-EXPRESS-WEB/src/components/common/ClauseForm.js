/**
 * ClauseForm — one clause of the contract written by hand: what the engine
 * will measure, in the reader's words, with the words of the brief it comes
 * from.
 *
 *   Essentiel  a template in French first (the six basic ones — fréquence
 *              maximale · premier départ avant · dernier départ après ·
 *              arrêts desservis · budget annuel ≤ · véhicules ≤ — and the
 *              trip-level kinds of the clause vocabulary: temps de parcours,
 *              nombre de courses, départ à une heure, ordre des arrêts,
 *              comme un jour de référence, inchangé sauf; then the kinds that
 *              complete a brief's vocabulary: premier départ pas avant,
 *              dernier départ pas après, amplitude, correspondance garantie,
 *              accessibilité, identité d'une ligne, nom d'un arrêt, validité
 *              des données, population desservie, km commerciaux, heures de
 *              service), with the line, the direction, the day type, the
 *              window and the value it needs — every label visible, a
 *              required field said in text, a field of the wrong type (a
 *              time, a number, a date, a colour) refused in place;
 *   Expert     the engine's kind and its params as JSON (monospace, lang en).
 *
 * Both carry the level (impérative / souhaitée), the quote (« citation »,
 * the brief's own words: the coverage detector maps them onto its
 * sentences, G5) and its page — except `simple` (② of a modify project):
 * an objective written in plain words, the template only, its level must,
 * the quote it answers said as it is (never edited), no page, no expert view.
 * The engine measures a clause written here
 * exactly like an extracted one. A dialog (a short form); opened
 * with `initial` it corrects a clause (the same id), opened with `quote` it
 * answers a requirement sentence of the brief (« Exigences sans clause »).
 *
 *   clauseFromTemplate(template, values) → the clause, or { missing: [field] }
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, TextField, Typography, useMediaQuery, useTheme } from "@mui/material";
import { useLanguage } from "../../contexts/LanguageContext";

const DAYS = ["weekday", "saturday", "sunday"];
// The engine's kinds (judge.KINDS), for the Expert form.
const KINDS = ["line_exists", "termini", "via", "serves", "headway_max", "span", "days", "no_service", "mode", "lines_max", "lines_min", "fleet_max", "budget_max", "od_max_time", "running_time", "trips_count", "departure_at", "stop_pattern", "same_as", "unchanged_except", "transfer_max_wait", "accessibility", "line_identity", "stop_identity", "feed_validity", "population_coverage", "service_km_max", "vehicle_hours_max", "pickup_dropoff", "shape_follows", "changed_in_scope", "table_rows"];
const list = (s) =>
  String(s || "")
    .split(/\s*[,;\n]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
const clock = (s) => {
  const m = /^(\d{1,2})\s*[:h]\s*(\d{2})?$/i.exec(String(s || "").trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2] || "00"}` : null;
};
const num = (s) => {
  const n = Number(String(s ?? "").replace(",", ".").trim());
  return Number.isFinite(n) && String(s ?? "").trim() !== "" ? n : null;
};
const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim()) ? String(s).trim() : null);
const hex = (s) => {
  const v = String(s || "").trim().replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(v) ? v : null;
};
const some = (v, ...keys) => keys.some((k) => String(v[k] ?? "").trim() !== "");

/**
 * The templates: their i18n key, their fields (required ones first), and how their values become the kind's params.
 * `key` names the template in contract.kind.* (the six basic ones, then the trip-level and brief-vocabulary kinds).
 */
export const TEMPLATES = Object.freeze([
  { id: "headwayMax", kind: "headway_max", fields: ["line", "dayType", "from", "to", "value", "direction"], required: ["dayType", "from", "to", "value"], params: (v) => ({ ...(v.line ? { line: v.line } : {}), day: v.dayType, from: clock(v.from), to: clock(v.to), minutes: num(v.value), ...(v.direction ? { direction: v.direction } : {}) }) },
  { id: "firstBefore", kind: "span", fields: ["line", "dayType", "value", "direction"], required: ["dayType", "value"], params: (v) => ({ ...(v.line ? { line: v.line } : {}), day: v.dayType, first_before: clock(v.value), ...(v.direction ? { direction: v.direction } : {}) }) },
  { id: "lastAfter", kind: "span", fields: ["line", "dayType", "value", "direction"], required: ["dayType", "value"], params: (v) => ({ ...(v.line ? { line: v.line } : {}), day: v.dayType, last_after: clock(v.value), ...(v.direction ? { direction: v.direction } : {}) }) },
  { id: "stopsServed", kind: "via", fields: ["line", "stops"], required: ["line", "stops"], params: (v) => ({ line: v.line, stops: list(v.stops) }) },
  { id: "budgetMax", kind: "budget_max", fields: ["value"], required: ["value"], params: (v) => ({ amount: num(v.value) }) },
  { id: "vehiclesMax", kind: "fleet_max", fields: ["value"], required: ["value"], params: (v) => ({ vehicles: num(v.value) }) },
  { id: "runningTime", kind: "running_time", fields: ["line", "fromStop", "toStop", "value"], required: ["line", "fromStop", "toStop", "value"], params: (v) => ({ line: v.line, from_stop: v.fromStop, to_stop: v.toStop, minutes: num(v.value) }) },
  { id: "tripsCount", kind: "trips_count", fields: ["line", "dayType", "value", "direction"], required: ["line", "value"], params: (v) => ({ line: v.line, min: num(v.value), day: v.dayType || "weekday", ...(v.direction ? { direction: v.direction } : {}) }) },
  { id: "departureAt", kind: "departure_at", fields: ["line", "stop", "times", "towards", "dayType"], required: ["line", "stop", "times"], params: (v) => ({ line: v.line, stop: v.stop, times: list(v.times).map((x) => clock(x) || x), ...(v.towards ? { towards: v.towards } : {}), day: v.dayType || "weekday" }) },
  { id: "stopPattern", kind: "stop_pattern", fields: ["line", "stops", "dayType"], required: ["line", "stops"], params: (v) => ({ line: v.line, stops: list(v.stops), ...(v.dayType ? { day: v.dayType } : {}) }) },
  { id: "sameAs", kind: "same_as", fields: ["line", "likeDate", "dayType"], required: ["line", "likeDate", "dayType"], params: (v) => ({ line: v.line, like_date: v.likeDate, day: v.dayType }) },
  { id: "unchangedExcept", kind: "unchanged_except", fields: ["line", "from", "to"], required: [], params: (v) => ({ ...(v.line ? { line: v.line } : {}), ...(clock(v.from) && clock(v.to) ? { except: { from: clock(v.from), to: clock(v.to) } } : {}) }) },
  // The kinds that complete a brief's vocabulary. `check`: the fields of which one at least is needed.
  { id: "firstAfter", kind: "span", fields: ["line", "dayType", "value", "direction"], required: ["dayType", "value"], params: (v) => ({ ...(v.line ? { line: v.line } : {}), day: v.dayType, first_after: clock(v.value), ...(v.direction ? { direction: v.direction } : {}) }) },
  { id: "lastBefore", kind: "span", fields: ["line", "dayType", "value", "direction"], required: ["dayType", "value"], params: (v) => ({ ...(v.line ? { line: v.line } : {}), day: v.dayType, last_before: clock(v.value), ...(v.direction ? { direction: v.direction } : {}) }) },
  { id: "amplitude", kind: "span", fields: ["line", "dayType", "value"], required: ["dayType", "value"], params: (v) => ({ ...(v.line ? { line: v.line } : {}), day: v.dayType, amplitude_h: num(v.value) }) },
  {
    id: "transferMaxWait",
    kind: "transfer_max_wait",
    fields: ["stop", "fromLine", "fromTimes", "toLine", "toTimes", "maxWait", "minWait", "dayType"],
    required: ["stop", "maxWait"],
    check: (v) => [!some(v, "fromLine", "fromTimes") && "fromLine", !some(v, "toLine", "toTimes") && "toLine", !some(v, "fromLine", "toLine") && "fromLine"].filter(Boolean),
    params: (v) => ({ stop: v.stop, ...(v.fromLine ? { from_line: v.fromLine } : { from_times: list(v.fromTimes).map((x) => clock(x) || x) }), ...(v.toLine ? { to_line: v.toLine } : { to_times: list(v.toTimes).map((x) => clock(x) || x) }), max_wait: num(v.maxWait), ...(num(v.minWait) != null ? { min_wait: num(v.minWait) } : {}), day: v.dayType || "weekday", ...(!v.fromLine && v.toLine ? {} : !v.toLine ? { each: "departure" } : {}) }),
  },
  { id: "accessibility", kind: "accessibility", fields: ["stops", "line", "share"], required: [], params: (v) => ({ ...(list(v.stops).length ? { stops: list(v.stops) } : v.line ? { line: v.line } : {}), ...(num(v.share) != null ? { min_pct: num(v.share) } : {}) }) },
  { id: "lineIdentity", kind: "line_identity", fields: ["line", "shortName", "longName", "color", "textColor"], required: ["line"], check: (v) => (some(v, "shortName", "longName", "color", "textColor") ? [] : ["shortName"]), params: (v) => ({ line: v.line, ...(v.shortName ? { short_name: v.shortName.trim() } : {}), ...(v.longName ? { long_name: v.longName.trim() } : {}), ...(hex(v.color) ? { color: hex(v.color) } : {}), ...(hex(v.textColor) ? { text_color: hex(v.textColor) } : {}) }) },
  { id: "stopIdentity", kind: "stop_identity", fields: ["stop", "name", "code"], required: ["stop"], check: (v) => (some(v, "name", "code") ? [] : ["name"]), params: (v) => ({ stop: v.stop, ...(v.name ? { name: v.name.trim() } : {}), ...(v.code ? { code: v.code.trim() } : {}) }) },
  { id: "feedValidity", kind: "feed_validity", fields: ["fromDate", "toDate"], required: [], check: (v) => (some(v, "fromDate", "toDate") ? [] : ["toDate"]), params: (v) => ({ ...(isoDate(v.fromDate) ? { from: isoDate(v.fromDate) } : {}), ...(isoDate(v.toDate) ? { to: isoDate(v.toDate) } : {}) }) },
  { id: "populationCoverage", kind: "population_coverage", fields: ["share", "radius", "line"], required: ["share"], params: (v) => ({ min_pct: num(v.share), ...(num(v.radius) ? { radius_m: num(v.radius) } : {}), ...(v.line ? { line: v.line } : {}) }) },
  { id: "serviceKmMax", kind: "service_km_max", fields: ["value", "line"], required: ["value"], params: (v) => ({ km: num(v.value), ...(v.line ? { line: v.line } : {}) }) },
  { id: "vehicleHoursMax", kind: "vehicle_hours_max", fields: ["value", "line"], required: ["value"], params: (v) => ({ hours: num(v.value), ...(v.line ? { line: v.line } : {}) }) },
  // The calls' pickup and drop-off types: stops served on demand (booking), the brief's TAD.
  { id: "stopsOnDemand", kind: "pickup_dropoff", fields: ["line", "stops", "direction", "dayType"], required: ["line", "stops"], params: (v) => ({ line: v.line, stops: list(v.stops), on_demand: true, ...(v.direction ? { direction: v.direction } : {}), ...(v.dayType ? { day: v.dayType } : {}) }) },
]);

const TIME_FIELDS = new Set(["from", "to"]);
// The span templates whose value is a time; the fields read as a number, a date, a colour, a list of times.
const CLOCK_VALUE = new Set(["firstBefore", "lastAfter", "firstAfter", "lastBefore"]);
const NUMBER_FIELDS = new Set(["maxWait", "minWait", "share", "radius"]);
const DATE_FIELDS = new Set(["fromDate", "toDate"]);
const COLOR_FIELDS = new Set(["color", "textColor"]);
const TIMES_FIELDS = new Set(["fromTimes", "toTimes"]);
/** Whether a value the person typed reads as the field's type (an empty optional field is fine). */
const readable = (template, f, v) => {
  if (TIME_FIELDS.has(f) || (f === "value" && CLOCK_VALUE.has(template))) return Boolean(clock(v));
  if (f === "value" || NUMBER_FIELDS.has(f)) return num(v) != null;
  if (DATE_FIELDS.has(f)) return Boolean(isoDate(v));
  if (COLOR_FIELDS.has(f)) return Boolean(hex(v));
  if (TIMES_FIELDS.has(f)) return list(v).every((x) => clock(x));
  return true;
};

/** A template's values → the clause (without its id), or { missing } naming the required fields left empty or unreadable. */
export const clauseFromTemplate = (template, values = {}) => {
  const tpl = TEMPLATES.find((x) => x.id === template);
  if (!tpl) return { missing: ["template"] };
  const empty = (f) => values[f] == null || String(values[f]).trim() === "";
  // A required field empty or unreadable; an optional one given but unreadable; the template's own « one of » rule.
  const missing = [...new Set([...tpl.required.filter((f) => empty(f) || !readable(template, f, values[f])), ...tpl.fields.filter((f) => !tpl.required.includes(f) && !empty(f) && !readable(template, f, values[f])), ...(tpl.check ? tpl.check(values) : [])])];
  if (missing.length) return { missing };
  return { kind: tpl.kind, level: values.level === "should" ? "should" : "must", status: "stated", params: tpl.params(values), ...(String(values.quote || "").trim() ? { quote: String(values.quote).trim().slice(0, 400) } : {}), ...(num(values.page) ? { page: num(values.page) } : {}), template: tpl.id };
};

/**
 * The template a clause reads as (for « Corriger »), else null: the Expert form then — a span with
 * several bounds, an identity kept for every line or stop, a carve-out the template cannot show (a
 * template that cannot hold every param would drop some on save).
 */
const SPAN_TEMPLATES = { first_before: "firstBefore", last_after: "lastAfter", first_after: "firstAfter", last_before: "lastBefore", amplitude_h: "amplitude" };
const templateOf = (clause) => {
  if (!clause) return null;
  const p = clause.params || {};
  if (clause.kind === "span") {
    const bounds = Object.keys(SPAN_TEMPLATES).filter((k) => p[k] != null && p[k] !== "");
    return bounds.length === 1 ? SPAN_TEMPLATES[bounds[0]] : null;
  }
  if (["line_identity", "stop_identity", "feed_validity"].includes(clause.kind) && p.unchanged != null && p.unchanged !== false) return null;
  if ((clause.kind === "line_identity" && !p.line) || (clause.kind === "stop_identity" && !p.stop)) return null;
  if (clause.kind === "transfer_max_wait" && (p.radius_m || p.from_direction || p.to_direction || p.from || p.to || p.each === "arrival" || (p.each === "departure" && p.to_line))) return null;
  return TEMPLATES.find((x) => x.kind === clause.kind)?.id || null;
};
const joinList = (v) => (Array.isArray(v) ? v.join(", ") : v || "");
const valuesOf = (clause) => {
  const p = clause?.params || {};
  const validity = clause?.kind === "feed_validity";
  return {
    line: p.line || (Array.isArray(p.lines) ? p.lines[0] : "") || "",
    dayType: p.day || "",
    from: validity ? "" : p.from || p.except?.from || "",
    to: validity ? "" : p.to || p.except?.to || "",
    value: p.minutes ?? p.first_before ?? p.last_after ?? p.first_after ?? p.last_before ?? p.amplitude_h ?? p.amount ?? p.vehicles ?? p.min ?? p.km ?? p.hours ?? "",
    direction: p.direction || "",
    stops: joinList(p.stops),
    fromStop: p.from_stop || "",
    toStop: p.to_stop || "",
    stop: p.stop || "",
    times: joinList(p.times),
    towards: p.towards || "",
    likeDate: p.like_date || "",
    fromLine: p.from_line || "",
    toLine: p.to_line || "",
    fromTimes: joinList(p.from_times),
    toTimes: joinList(p.to_times),
    maxWait: p.max_wait ?? "",
    minWait: p.min_wait ?? "",
    share: p.min_pct ?? "",
    radius: p.radius_m ?? "",
    shortName: p.short_name || "",
    longName: p.long_name || "",
    color: p.color || "",
    textColor: p.text_color || "",
    name: p.name || "",
    code: p.code || "",
    fromDate: validity ? p.from || p.from_date || "" : "",
    toDate: validity ? p.to || p.to_date || "" : "",
    quote: clause?.quote || "",
    page: clause?.page ?? "",
    level: clause?.level || "must",
  };
};

export default function ClauseForm({ open, initial = null, quote = null, onClose, onSave, simple = false }) {
  const { t } = useLanguage();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down("sm"));
  const [mode, setMode] = useState("essential");
  const [template, setTemplate] = useState("headwayMax");
  const [values, setValues] = useState({ level: "must" });
  const [expert, setExpert] = useState({ kind: "headway_max", params: "{}" });
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    const tpl = templateOf(initial);
    // The simple form never shows the engine's kind and params: a clause no template reads is stated again in one.
    setMode(initial && !tpl && !simple ? "expert" : "essential");
    setTemplate(tpl || "headwayMax");
    setValues(initial ? valuesOf(initial) : { level: "must", ...(quote ? { quote } : {}) });
    setExpert({ kind: initial?.kind || "headway_max", params: JSON.stringify(initial?.params || {}, null, 2) });
    setTried(false);
  }, [open, initial, quote, simple]);

  const tpl = TEMPLATES.find((x) => x.id === template);
  const built = useMemo(() => {
    if (mode === "essential") return clauseFromTemplate(template, values);
    let params;
    try {
      params = JSON.parse(expert.params || "{}");
    } catch {
      return { missing: ["params"] };
    }
    if (!params || typeof params !== "object" || Array.isArray(params)) return { missing: ["params"] };
    return { kind: expert.kind, level: values.level === "should" ? "should" : "must", status: "stated", params, ...(String(values.quote || "").trim() ? { quote: String(values.quote).trim() } : {}), ...(num(values.page) ? { page: num(values.page) } : {}) };
  }, [mode, template, values, expert]);
  const missing = built.missing || [];
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }));
  const fieldLabel = (f) => t(`contract.kind.field.${f}`);
  const save = () => {
    setTried(true);
    if (missing.length) return;
    onSave?.({ ...built, ...(initial?.id ? { id: initial.id } : {}), text: undefined });
  };

  const field = (f) => {
    const required = tpl?.required.includes(f);
    const invalid = tried && missing.includes(f);
    const common = { size: "small", fullWidth: true, label: `${fieldLabel(f)}${required ? ` (${t("contract.form.required")})` : ""}`, value: values[f] ?? "", onChange: set(f), error: invalid, inputProps: { "data-testid": `clause-field-${f}` } };
    if (f === "dayType")
      return (
        <TextField key={f} select {...common} SelectProps={{ inputProps: { "data-testid": `clause-field-${f}` } }}>
          {DAYS.map((d) => (
            <MenuItem key={d} value={d}>
              {t(`operation.days.${d}`)}
            </MenuItem>
          ))}
        </TextField>
      );
    if (f === "direction")
      return (
        <TextField key={f} select {...common} SelectProps={{ inputProps: { "data-testid": `clause-field-${f}` } }}>
          <MenuItem value="">{t("contract.form.bothDirections")}</MenuItem>
          <MenuItem value="0">{t("contract.form.direction0")}</MenuItem>
          <MenuItem value="1">{t("contract.form.direction1")}</MenuItem>
        </TextField>
      );
    const help = TIME_FIELDS.has(f) || (f === "value" && CLOCK_VALUE.has(template)) ? t("contract.form.timeHint") : f === "stops" || f === "times" || TIMES_FIELDS.has(f) ? t("contract.form.listHint") : f === "likeDate" ? t("contract.form.dateHint") : DATE_FIELDS.has(f) ? t("contract.form.validityHint") : COLOR_FIELDS.has(f) ? t("contract.form.colorHint") : f === "fromLine" || f === "toLine" ? t("contract.form.transferHint") : null;
    return <TextField key={f} {...common} helperText={invalid ? t("contract.form.invalid") : help} />;
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth fullScreen={fullScreen} data-testid="clause-form">
      <DialogTitle sx={{ fontWeight: simple ? 600 : 800 }}>{simple ? t(initial ? "objectives.form.edit" : "objectives.form.title") : initial ? t("contract.decide.correct") : t("contract.add")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1.25, pt: "8px !important" }}>
        {simple && values.quote && (
          <Typography data-testid="clause-simple-quote" sx={{ fontSize: "0.8rem", color: "text.secondary", lineHeight: 1.5, overflowWrap: "anywhere" }}>
            {t("objectives.form.answers", { quote: String(values.quote).replace(/\s*\|\s*/g, " · ").replace(/^[·\s]+|[·\s]+$/g, "") })}
          </Typography>
        )}
        {mode === "essential" ? (
          <>
            <TextField select size="small" fullWidth label={simple ? t("objectives.form.kind") : t("contract.form.template")} value={template} onChange={(e) => setTemplate(e.target.value)} SelectProps={{ inputProps: { "data-testid": "clause-template" } }}>
              {TEMPLATES.map((x) => (
                <MenuItem key={x.id} value={x.id} data-testid={`clause-template-${x.id}`}>
                  {t(`contract.kind.${x.id}`)}
                </MenuItem>
              ))}
            </TextField>
            <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", sm: "1fr 1fr" }, gap: 1 }}>{tpl.fields.map(field)}</Box>
          </>
        ) : (
          <>
            <TextField select size="small" fullWidth label={t("contract.form.kind")} value={expert.kind} onChange={(e) => setExpert((x) => ({ ...x, kind: e.target.value }))} SelectProps={{ inputProps: { "data-testid": "clause-expert-kind", lang: "en" } }}>
              {KINDS.map((k) => (
                <MenuItem key={k} value={k} lang="en" sx={{ fontFamily: "monospace" }}>
                  {k}
                </MenuItem>
              ))}
            </TextField>
            <TextField size="small" fullWidth multiline minRows={4} label={t("contract.form.params")} value={expert.params} onChange={(e) => setExpert((x) => ({ ...x, params: e.target.value }))} error={tried && missing.includes("params")} helperText={tried && missing.includes("params") ? t("contract.form.invalid") : null} inputProps={{ "data-testid": "clause-expert-params", lang: "en", style: { fontFamily: "monospace", fontSize: "0.78rem" } }} />
          </>
        )}
        {!simple && (
          <>
            <TextField select size="small" label={t("contract.form.level")} value={values.level || "must"} onChange={set("level")} SelectProps={{ inputProps: { "data-testid": "clause-field-level" } }}>
              <MenuItem value="must">{t("contract.must")}</MenuItem>
              <MenuItem value="should">{t("contract.should")}</MenuItem>
            </TextField>
            <TextField size="small" fullWidth multiline minRows={2} label={fieldLabel("quote")} value={values.quote || ""} onChange={set("quote")} helperText={t("contract.form.quoteHint")} inputProps={{ "data-testid": "clause-field-quote" }} />
            <TextField size="small" label={fieldLabel("page")} value={values.page ?? ""} onChange={set("page")} inputProps={{ inputMode: "numeric", "data-testid": "clause-field-page" }} sx={{ maxWidth: 140 }} />
          </>
        )}
        {tried && missing.length > 0 && (
          <Typography role="alert" data-testid="clause-missing" sx={{ fontSize: "0.76rem", color: "error.main" }}>
            {t("operation.missingRequired", { fields: missing.map((f) => (f === "params" ? t("contract.form.params") : f === "template" ? t("contract.form.template") : fieldLabel(f))).join(", ") })}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} data-testid="clause-cancel" sx={{ textTransform: "none" }}>
          {t("app.cancel")}
        </Button>
        <Button variant="contained" disableElevation onClick={save} data-testid="clause-save" sx={{ textTransform: "none", fontWeight: simple ? 600 : 800 }}>
          {simple ? t(initial ? "objectives.form.saveEdit" : "objectives.form.save") : t("contract.form.save")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
