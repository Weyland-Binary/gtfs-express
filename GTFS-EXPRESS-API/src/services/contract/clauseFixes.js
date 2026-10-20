/**
 * contract/clauseFixes — the corrections of a clause the engine can propose by itself, from the clause's own shape.
 *
 * A reading writes a clause the checker cannot measure as written, for a reason the clause's params show without any
 * feed: the lines it names are all excepted from its own comparison, a window of the day given as dates, a day filter
 * on listed dates. The engine proposes the one correction that shape calls for, as a replacement clause the person
 * applies in one act at the objectives step, under their name (the wrong clause set aside with the reason, the
 * replacement kept): the model proposes nothing here, and nothing is applied for the person. Each fix is a shape of
 * params, never a reading of the brief's words; a clause whose fault needs the brief (a count in the wrong direction, a
 * bound on every line) has no fix here and stays the person's to correct by hand. One fix reads the intent sheet
 * beside the clause's shape: a timetable copied from a reference day the brief itself changes (a demand of the sheet
 * changes that day type on those lines, in effect on or before the reference date) is read as the change leaves that
 * day, not as it is today — « les vacances d'hiver suivent le samedi, prolongements compris ».
 *
 *   fixOf(clause, { intent }) → { code, params } | null — the replacement's params and why (code), or null when sound
 *   withFixes(clauses, { intent }) → the clauses, each with `fix` when one applies
 *   FIX_CODES   every_line_excepted | window_given_as_dates | day_filter_on_dates | reference_day_changed
 */

"use strict";

const FIX_CODES = Object.freeze(["every_line_excepted", "window_given_as_dates", "day_filter_on_dates", "reference_day_changed"]);

const list = (v) => (Array.isArray(v) ? v.map((x) => String(x)) : v == null || v === "" ? [] : [String(v)]);
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const withoutEmptyExcept = (params) => {
  if (!isObject(params.except)) return params;
  const except = Object.fromEntries(Object.entries(params.except).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length)));
  const { except: _e, ...rest } = params; // eslint-disable-line no-unused-vars
  return Object.keys(except).length ? { ...rest, except } : rest;
};

/** Every line the clause names is also excepted from its comparison: nothing is left to measure. */
const everyLineExcepted = (p) => {
  const lines = [...list(p.lines), ...list(p.line)];
  const excepted = isObject(p.except) ? list(p.except.lines) : [];
  if (!lines.length || !excepted.length || !lines.every((l) => excepted.includes(l))) return null;
  const { lines: _l, ...except } = p.except; // eslint-disable-line no-unused-vars
  return { code: "every_line_excepted", params: withoutEmptyExcept({ ...p, except }) };
};

/** A window of the day (except.from / except.to, HH:MM) written as dates: they are the clause's dates of effect. */
const windowGivenAsDates = (p) => {
  if (!isObject(p.except) || !(isDate(p.except.from) || isDate(p.except.to))) return null;
  const { from, to, ...except } = p.except;
  const out = { ...p, except };
  if (isDate(from)) out.from_date = p.from_date || from.trim();
  if (isDate(to)) out.to_date = p.to_date || to.trim();
  return { code: "window_given_as_dates", params: withoutEmptyExcept(out) };
};

// The day type of an ISO date, and of a day word (weekday | saturday | sunday | daily | mon…sun).
const DAY_TYPE_OF_DOW = ["sunday", "weekday", "weekday", "weekday", "weekday", "weekday", "saturday"];
const dayTypeOfDate = (iso) => DAY_TYPE_OF_DOW[new Date(`${iso.trim()}T12:00:00Z`).getUTCDay()];
const dayTypesOfWords = (words) => {
  const out = new Set();
  for (const w of words.map((x) => String(x).toLowerCase().trim())) {
    if (w === "daily") return new Set(["weekday", "saturday", "sunday"]);
    if (w === "saturday" || w === "sat") out.add("saturday");
    else if (w === "sunday" || w === "sun") out.add("sunday");
    else out.add("weekday");
  }
  return out;
};

/** Listed dates with a day filter beside them that none of the dates falls in: the measure is empty, the dates say which days. */
const dayFilterOnDates = (p) => {
  const dates = list(p.dates).filter(isDate);
  const words = [...list(p.day), ...list(p.days)];
  if (!dates.length || !words.length) return null;
  const types = dayTypesOfWords(words);
  if (dates.some((d) => types.has(dayTypeOfDate(d)))) return null;
  const { day: _d, days: _ds, ...rest } = p; // eslint-disable-line no-unused-vars
  return { code: "day_filter_on_dates", params: rest };
};

/**
 * A timetable copied from a reference date (same_as like_date) of a day type a demand of the sheet changes on the
 * clause's lines, in effect on or before that date, and not said read after the change: the reference is the day as
 * the change leaves it (like_in after), else the clause would hold the plan to a timetable the brief withdraws.
 */
const referenceDayChanged = (p, intent) => {
  const like = isDate(p.like_date) ? p.like_date.trim() : null;
  if (!like || p.like_in === "after" || !isObject(intent)) return null;
  const lines = [...list(p.lines), ...list(p.line)];
  const type = dayTypeOfDate(like);
  const effectOf = (d) => (isDate(d.scope?.from_date) ? d.scope.from_date.trim() : isDate(intent.effective_date) ? intent.effective_date.trim() : null);
  const changes = (Array.isArray(intent.demands) ? intent.demands : []).some((d) => {
    if (!isObject(d) || !isObject(d.scope) || ["keep", "attribute"].includes(d.shape)) return false;
    if (!list(d.scope.lines).some((l) => lines.includes(l)) || list(d.scope.dates).length) return false;
    const types = dayTypesOfWords(list(d.scope.days).length ? list(d.scope.days) : ["daily"]);
    const effect = effectOf(d);
    return types.has(type) && (!effect || effect <= like);
  });
  return changes ? { code: "reference_day_changed", params: { ...p, like_in: "after" } } : null;
};

const fixOf = (clause, { intent = null } = {}) => {
  const p = clause && isObject(clause.params) ? clause.params : null;
  if (!p) return null;
  return everyLineExcepted(p) || windowGivenAsDates(p) || dayFilterOnDates(p) || (clause.kind === "same_as" ? referenceDayChanged(p, intent) : null) || null;
};

const withFixes = (clauses, context = {}) => (Array.isArray(clauses) ? clauses : []).map((c) => {
  const fix = c && c.kind ? fixOf(c, context) : null;
  return fix ? { ...c, fix } : c;
});

module.exports = { FIX_CODES, fixOf, withFixes, _internals: { dayTypeOfDate, dayTypesOfWords } };
