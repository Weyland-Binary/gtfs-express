/**
 * catalogueText — the engine's catalogue in the reader's words.
 *
 * The API describes each operation and parameter in English for the
 * planner (type names, parameter names, developer help). The studio shows
 * them through translation keys instead, falling back to what the server
 * says (localized by the server when it can, ?lang=) and last to the raw
 * name:
 *
 *   transform.op.<type> / .help                     an operation's title and what it does
 *   transform.category.<category>                   the catalogue's groups
 *   transform.opParam.<type>.<name> / .help         a parameter whose meaning depends on the operation
 *   transform.param.<name> / .help                  every other parameter
 *   transform.enum.<param>.<value>, transform.enumValue.<value>, transform.days.<v>,
 *   transform.periodName.<v>, transform.direction.<v>, transform.bool.<v>   values
 *
 * Parameters are grouped for the form: what the operation needs, which
 * trips (selection), when (scope: days, dates, periods, zones) and the
 * advanced options.
 *
 * Without the assistant the catalogue is where a change starts, so it is
 * also searched and listed by family here
 * (searchCatalogue, catalogueFamilies: the catalogue panel of ③ and of the
 * operation form), and the engine's questions are said in words: a question
 * the studio words itself by its code (`headway_min_missing` → « Toutes les
 * combien de minutes ? », operation.question.*), otherwise the engine's own
 * sentence, where only a parameter still named by the engine's name
 * (`start`) is replaced by its label in quotes — never the sentence, which
 * may offer a choice, a date or a case the label alone would lose — and
 * the answers offered as chips translated (`weekday` → « Semaine »,
 * `true` → « Oui »: optionLabel) — the value sent back stays the engine's.
 *
 * Some parameters stand in for each other: the engine takes one or the
 * other (`route` or `routes`, `end_date` or `start_date`, `direction` or
 * `pattern`, `days` or `dates`). The catalogue states these groups
 * (`requires_one_of: [["route", "routes"]]`, none of the members marked
 * required on its own), so the operation form asks for one of each group
 * (oneOfGroups, missingRequired) and says the group in words (« Ligne ou
 * Lignes »). An older server that does not send the groups marks the first
 * member required instead: PARAM_ALTERNATES rebuilds its groups from that.
 */

import { formatDate, toIso } from "./localDates";

/** A translation, or `fallback` when the key is unknown (codes the server may add later). */
export const tf = (t, key, params, fallback) => {
  const v = t(key, params || undefined);
  return v === key ? fallback : v;
};

export const CATEGORY_ORDER = ["service", "routes", "stops", "calendar", "network", "fares", "metadata", "generic"];
export const SCOPE_PARAMS = ["days", "from_date", "to_date", "dates", "period", "except", "region"];
export const SELECTION_PARAMS = ["direction", "from", "to", "times", "at_stop", "pattern", "every", "offset", "all", "bands"];
// The day picker offers these; "sat"/"sun" (same days as "saturday"/"sunday") are only read.
export const DAY_CHOICES = ["weekday", "saturday", "sunday", "weekend", "daily", "mon", "tue", "wed", "thu", "fri"];
export const DAY_VALUES = [...DAY_CHOICES, "sat", "sun"];
export const PERIOD_CHOICES = ["school_days", "school_holidays", "public_holidays"];
export const DIRECTION_CHOICES = ["both", "0", "1"];
// Numeric codes the enum also names in words: the words are offered, the codes hidden.
const ENUM_ALIASES = {
  wheelchair_boarding: { 0: "unknown", 1: "accessible", 2: "not_accessible" },
  wheelchair_accessible: { 0: "unknown", 1: "accessible", 2: "not_accessible" },
  bikes_allowed: { 0: "unknown", 1: "allowed", 2: "not_allowed" },
};

export const opTitle = (t, type, def = null) => tf(t, `transform.op.${type}`, null, def?.title || type || "");
export const opHelp = (t, type, def = null) => tf(t, `transform.op.${type}.help`, null, def?.description || "");
export const categoryLabel = (t, category) => tf(t, `transform.category.${category}`, null, category || "");

export const paramLabel = (t, type, p) => {
  const name = typeof p === "string" ? p : p?.name;
  return tf(t, `transform.opParam.${type}.${name}`, null, tf(t, `transform.param.${name}`, null, (typeof p === "object" && p?.label) || name));
};
export const paramHelp = (t, type, p) => {
  const name = typeof p === "string" ? p : p?.name;
  return tf(t, `transform.opParam.${type}.${name}.help`, null, tf(t, `transform.param.${name}.help`, null, (typeof p === "object" && p?.description) || ""));
};

export const dayLabel = (t, v) => tf(t, `transform.days.${v}`, null, v);
export const periodLabel = (t, v) => tf(t, `transform.periodName.${v}`, null, v);
export const directionLabel = (t, v) => tf(t, `transform.direction.${v}`, null, String(v));
export const boolLabel = (t, v) => tf(t, `transform.bool.${v ? "true" : "false"}`, null, String(v));

export const enumLabel = (t, param, value) => {
  const v = String(value);
  return tf(t, `transform.enum.${param}.${v}`, null, tf(t, `transform.enumValue.${v}`, null, DAY_VALUES.includes(v) ? dayLabel(t, v) : v));
};

/** The values a select offers for an enum parameter (codes with a word alias hidden). */
export const enumChoices = (p) => {
  const aliases = ENUM_ALIASES[p?.name] || {};
  const list = Array.isArray(p?.enum) ? p.enum.map(String) : [];
  return list.filter((v) => !(aliases[v] && list.includes(aliases[v])));
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

// ── Parameters that stand in for each other ───────────────────────────────

/**
 * Only for a server older than the catalogue's `requires_one_of`: a
 * parameter it marks required → the parameters the engine accepts instead
 * (`routes` for `route`: adjust_running_times, set_dwell; `start_date` for
 * `end_date`: extend_validity; `pattern` for `direction`: add_trips). Read
 * only for an operation that has the alternate and does not state groups.
 */
export const PARAM_ALTERNATES = Object.freeze({ route: ["routes"], end_date: ["start_date"], direction: ["pattern"] });

/**
 * The groups of parameters of `def` one of which is needed: the catalogue's
 * `requires_one_of` (its listed members only, two at least), else — an
 * older server — rebuilt from PARAM_ALTERNATES on its required parameters.
 * The first member is the one the form asks first.
 */
export const oneOfGroups = (def) => {
  const params = def?.params || [];
  const names = new Set(params.map((p) => p.name));
  if (Array.isArray(def?.requires_one_of)) return def.requires_one_of.map((g) => (Array.isArray(g) ? g.filter((n) => names.has(n)) : [])).filter((g) => g.length >= 2);
  return params.filter((p) => p.required && (PARAM_ALTERNATES[p.name] || []).some((a) => names.has(a))).map((p) => [p.name, ...PARAM_ALTERNATES[p.name].filter((a) => names.has(a))]);
};

/** The parameters of `def` that stand in for its parameter `name` (the others of its group). */
export const alternatesOf = (def, name) => {
  const group = oneOfGroups(def).find((g) => g.includes(name));
  return group ? group.filter((n) => n !== name) : [];
};

/** Whether `p` is the first of a group of `def` (the one the form asks for, and puts with what the operation needs). */
export const leadsGroup = (def, name) => oneOfGroups(def).some((g) => g[0] === name);

const filled = (v) => (Array.isArray(v) ? v.length > 0 : String(v ?? "").trim() !== "");

/**
 * What `def` still needs in `values`: each required parameter left empty,
 * and each group none of whose members has a value (said by its first
 * member, the others as its alternates) — [{ param, alternates: [param…] }]
 * in the catalogue's order. A parameter of a group is never needed on its
 * own, even from an older server that marks it required.
 */
export const missingRequired = (def, values = {}, isFilled = filled) => {
  const params = def?.params || [];
  const byName = new Map(params.map((p) => [p.name, p]));
  const groups = oneOfGroups(def);
  const inGroup = new Set(groups.flat());
  return params
    .flatMap((p) => {
      if (!inGroup.has(p.name)) return p.required && !isFilled(values[p.name]) ? [{ param: p, alternates: [] }] : [];
      const group = groups.find((g) => g[0] === p.name);
      if (!group || group.some((n) => isFilled(values[n]))) return [];
      return [{ param: p, alternates: group.slice(1).map((n) => byName.get(n)) }];
    });
};

/**
 * Whether the form says « requis » for `p` now: a required parameter outside
 * any group, or the first of a group none of whose others has a value.
 */
export const saysRequired = (def, p, values = {}, isFilled = filled) => {
  const group = oneOfGroups(def).find((g) => g.includes(p.name));
  if (!group) return Boolean(p.required);
  return group[0] === p.name && !group.slice(1).some((n) => isFilled(values[n]));
};

/** A missing parameter as the form says it: its label, or « its label ou its alternate's » (operation.missingEither). */
export const missingLabel = (t, opType, m) => {
  const own = paramLabel(t, opType, m.param);
  return m.alternates.reduce((s, a) => tf(t, "operation.missingEither", { first: s, second: paramLabel(t, opType, a) }, `${s} / ${paramLabel(t, opType, a)}`), own);
};

// ── The catalogue as a list: searched, by family ───────────────────────────

const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** The operations whose words (title, what it does, family, the engine's name) contain every word of `query`, sorted. */
export const searchCatalogue = (t, catalogue, query = "", lang = "en") => {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const sorted = sortCatalogue(t, catalogue, lang);
  if (!words.length) return sorted;
  return sorted.filter((o) => {
    const text = fold([opTitle(t, o.type, o), opHelp(t, o.type, o), categoryLabel(t, o.category), o.title, o.type].join(" "));
    return words.every((w) => text.includes(w));
  });
};

/** A sorted list of operations grouped by family: [{ category, label, operations }], in the studio's order. */
export const catalogueFamilies = (t, list) => {
  const out = [];
  for (const o of list || []) {
    const last = out[out.length - 1];
    if (last && last.category === o.category) last.operations.push(o);
    else out.push({ category: o.category, label: categoryLabel(t, o.category), operations: [o] });
  }
  return out;
};

/** The catalogue sorted by category (the studio's order), then by localized title. */
export const sortCatalogue = (t, catalogue, lang = "en") => {
  const rank = (c) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i < 0 ? CATEGORY_ORDER.length : i;
  };
  return [...(catalogue || [])].sort((a, b) => rank(a.category) - rank(b.category) || opTitle(t, a.type, a).localeCompare(opTitle(t, b.type, b), lang));
};

/**
 * The form's sections: `main` (what the operation needs — all its
 * parameters when none is required), `selection` (which trips), `scope`
 * (when), `advanced` (the rest).
 */
export const groupParams = (def) => {
  const params = def?.params || [];
  // What the operation needs: its required parameters and the first of each one-of group (the others of the
  // group stay in their own section: `pattern` with the trips, `dates` with the scope).
  const needed = (p) => (oneOfGroups(def).some((g) => g.includes(p.name)) ? leadsGroup(def, p.name) : p.required);
  const required = params.filter(needed);
  const optional = params.filter((p) => !needed(p));
  const selection = optional.filter((p) => SELECTION_PARAMS.includes(p.name));
  const scope = optional.filter((p) => SCOPE_PARAMS.includes(p.name));
  const rest = optional.filter((p) => !SELECTION_PARAMS.includes(p.name) && !SCOPE_PARAMS.includes(p.name));
  if (!required.length) return { main: rest, selection, scope, advanced: [] };
  return { main: required, selection, scope, advanced: rest };
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
