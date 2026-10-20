/**
 * catalogueText — the engine's catalogue in the reader's words.
 *
 * The API describes each operation and parameter in English for the
 * planner (type names, parameter names, developer help). The studio shows
 * them through translation keys instead, falling back to what the server
 * says (localized by the server when it can, ?lang=) and last to the raw
 * name:
 *
 *   transform.op.<type>                             an operation's title
 *   transform.opParam.<type>.<name>                 a parameter whose meaning depends on the operation
 *   transform.param.<name>                          every other parameter
 *   transform.enum.<param>.<value>, transform.enumValue.<value>, transform.days.<v>,
 *   transform.periodName.<v>, transform.direction.<v>, transform.bool.<v>   values
 *
 * An operation's card (ChangePlanParts) says its parameters this way, and
 * the engine's questions in words: a question
 * the studio words itself by its code (`headway_min_missing` → « Toutes les
 * combien de minutes ? », operation.question.*), otherwise the engine's own
 * sentence, where only a parameter still named by the engine's name
 * (`start`) is replaced by its label in quotes — never the sentence, which
 * may offer a choice, a date or a case the label alone would lose — and
 * the answers offered as chips translated (`weekday` → « Semaine »,
 * `true` → « Oui »: optionLabel) — the value sent back stays the engine's.
 */

import { formatDate, toIso } from "./localDates";

/** A translation, or `fallback` when the key is unknown (codes the server may add later). */
export const tf = (t, key, params, fallback) => {
  const v = t(key, params || undefined);
  return v === key ? fallback : v;
};

// The days, periods and directions said in words; any other value is shown as the engine wrote it.
const DAY_VALUES = ["weekday", "saturday", "sunday", "weekend", "daily", "mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const PERIOD_CHOICES = ["school_days", "school_holidays", "public_holidays"];
const DIRECTION_CHOICES = ["both", "0", "1"];

export const opTitle = (t, type, def = null) => tf(t, `transform.op.${type}`, null, def?.title || type || "");

export const paramLabel = (t, type, p) => {
  const name = typeof p === "string" ? p : p?.name;
  return tf(t, `transform.opParam.${type}.${name}`, null, tf(t, `transform.param.${name}`, null, (typeof p === "object" && p?.label) || name));
};

const dayLabel = (t, v) => tf(t, `transform.days.${v}`, null, v);
const periodLabel = (t, v) => tf(t, `transform.periodName.${v}`, null, v);
const directionLabel = (t, v) => tf(t, `transform.direction.${v}`, null, String(v));
const boolLabel = (t, v) => tf(t, `transform.bool.${v ? "true" : "false"}`, null, String(v));

const enumLabel = (t, param, value) => {
  const v = String(value);
  return tf(t, `transform.enum.${param}.${v}`, null, tf(t, `transform.enumValue.${v}`, null, DAY_VALUES.includes(v) ? dayLabel(t, v) : v));
};

// ── The engine's questions and their answers, in the reader's words ───────

// The day choices a question offers (resolve.days: weekday · saturday · sunday · daily), said as short chips.
const ANSWER_DAYS = ["weekday", "saturday", "sunday", "daily"];
// Questions the studio words itself, by the ambiguity's code: the same question in every language of the app.
const QUESTION_KEYS = Object.freeze({ headway_min_missing: "operation.question.headway" });
// A parameter named by the engine's name inside a question: `start`, `min_transfer_min` (never `one_way: true`, a value).
const TECHNICAL_NAME_RE = /`([a-z_][a-z0-9_]*)`/g;

/** A parameter's name and type, whether it comes as a catalogue entry or a name. */
const nameAndType = (p) => (typeof p === "string" ? { name: p, type: null } : { name: p?.name || null, type: p?.type || null });

/**
 * An answer the engine offers for a parameter, as the chip says it: days
 * (« Semaine », « Samedi »…), yes / no, a direction, a period, an enum
 * value in words; anything else (a line, a stop) as the engine wrote it.
 */
export const optionLabel = (t, opType, p, option) => {
  const s = String(option);
  const { name, type } = nameAndType(p);
  if (type === "boolean" || ((s === "true" || s === "false") && (!type || type === "string"))) return boolLabel(t, s === "true");
  if (type === "days" || name === "days" || name === "to_days" || name === "from_day") {
    if (ANSWER_DAYS.includes(s)) return tf(t, `operation.days.${s}`, null, dayLabel(t, s));
    return DAY_VALUES.includes(s) ? dayLabel(t, s) : s;
  }
  if (type === "direction" || name === "direction") return DIRECTION_CHOICES.includes(s) ? directionLabel(t, s) : s;
  if (type === "period" || name === "period" || name === "except") return PERIOD_CHOICES.includes(s) ? periodLabel(t, s) : s;
  if (type === "enum") return enumLabel(t, name, s);
  return s;
};

/** The label of a parameter the studio words (a translation key), or null: a name without one is left as the engine wrote it. */
const knownLabel = (t, opType, name) => tf(t, `transform.opParam.${opType}.${name}`, null, tf(t, `transform.param.${name}`, null, null));

/**
 * An engine's question as the person reads it: the studio's own words for
 * the questions it knows by code; otherwise the engine's message (already
 * in the reader's language when the engine speaks it), each parameter it
 * still names by the engine's name (`start`) replaced by the parameter's
 * label in quotes (« Premier départ de la série ») — only the name, never
 * the sentence: « Qu'est-ce qui change : `price`, `percent`… ? » stays a
 * choice between four ways.
 */
export const questionText = (t, ambiguity, opType = null) => {
  const own = QUESTION_KEYS[ambiguity?.code];
  if (own) {
    const v = tf(t, own, null, null);
    if (v) return v;
  }
  const message = String(ambiguity?.message || "");
  return message.replace(TECHNICAL_NAME_RE, (whole, name) => {
    const label = knownLabel(t, opType, name);
    return label ? tf(t, "operation.question.label", { label }, `“${label}”`) : whole;
  });
};

const isDateParam = (name, type) => type === "date" || /(^|_)date$/.test(name);

/** A parameter's value as the reader says it (chips of an operation card). */
export const formatParamValue = (t, lang, name, type, value) => {
  if (value == null || value === "") return "—";
  if (Array.isArray(value)) return value.map((v) => formatParamValue(t, lang, name, type === "dates" ? "date" : type === "days" ? "days" : type, v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  const s = String(value);
  if ((isDateParam(name, type) || type === "dates") && toIso(s)) return formatDate(s, lang, "short");
  if (type === "days" || name === "days" || name === "to_days") return DAY_VALUES.includes(s) ? dayLabel(t, s) : s;
  if (type === "period" || name === "period" || name === "except") return PERIOD_CHOICES.includes(s) ? periodLabel(t, s) : s;
  if (type === "direction" || name === "direction" || name === "direction_b") return DIRECTION_CHOICES.includes(s) ? directionLabel(t, s) : s;
  if (typeof value === "boolean" || type === "boolean") return s === "true" ? boolLabel(t, true) : s === "false" ? boolLabel(t, false) : s;
  if (type === "enum") return enumLabel(t, name, s);
  return s;
};
