/**
 * contract/intentSheet — the intent sheet: what the brief asks, one DEMAND per requirement, said completely enough
 * for the engine to derive the tests of the change by itself (contract/derivedChecks), before any plan.
 *
 * A demand carries its scope (lines, direction, day types, dates or period), the FORM of the change (what it does
 * to what exists), its references (« comme le samedi », « l'itinéraire de la ligne N4 »), the window of the day it
 * touches, the count a full timetable states, and what the brief says stays as it is. The sheet is written by the
 * reading (the extractor) or by hand (the bank's replays), validated by the person, and read by the engine; nothing
 * in it is decided by the engine: a value the reading cannot establish is null, and null is a question for the
 * person, never a default.
 *
 *   {
 *     effective_date: "YYYY-MM-DD" | null,          the date the brief's changes take effect, when it states one
 *     demands: [{
 *       id, quote?, document?,
 *       scope: { lines: [names], direction?: "0" | "1" | "both" | { towards: name } | null,
 *                days?: [weekday | saturday | sunday | mon…sun] | null, period?: school_days | school_holidays | … | null,
 *                from_date?, to_date?, dates?: [YYYY-MM-DD], stops?: [names] },
 *       shape: extend | replace | add | modify | remove | attribute | reroute | create | delete | keep,
 *       replaces_existing?: true | false | null,     a full timetable: replaces the existing trips, or adds to them
 *       window?: { from?: "HH:MM", to?: "HH:MM" },    the part of the day the demand changes (the rest is kept)
 *       counts?: [{ day, trips, per: direction | total, period? }],   what a full timetable states (replace)
 *       references?: [{ kind: like_day, day, what: running_times | timetable, from_stop?, to_stop?, like_date? }
 *                     | { kind: like_line, line, what: shape | stops, from_stop, to_stop, direction? }],
 *       keeps?: [{ quote?, scope }],                 what the brief says stays as it is
 *       clauses?: [vocabulary clauses]               the measurable promises the reading wrote (the contract's)
 *     }],
 *     keeps?: [{ quote?, scope }],                   sheet-level keeps (« aucune autre ligne ne change »)
 *     questions?: [{ demand, kind, text, options }]  what the reading could not establish
 *   }
 *
 *   normalizeSheet(raw) → the sheet with every field in its shape (unknown values null, lists as lists), or null
 *   SHAPES, DAY_WORDS
 */

"use strict";

const SHAPES = Object.freeze(["extend", "replace", "add", "modify", "remove", "attribute", "reroute", "create", "delete", "keep"]);
const DAY_WORDS = Object.freeze(["weekday", "saturday", "sunday", "daily", "mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const REFERENCE_KINDS = Object.freeze(["like_day", "like_line"]);

const str = (v, n = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
const ymd = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null);
const hhmm = (v) => (typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v.trim()) ? v.trim().padStart(5, "0") : null);
const list = (v, n = 60) => (Array.isArray(v) ? v.filter((x) => str(x)).map((x) => str(x)).slice(0, n) : []);
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

const dayWord = (w) => {
  const s = String(w || "").toLowerCase().trim();
  if (["weekdays", "workday", "workdays"].includes(s)) return "weekday";
  if (["saturdays", "sat."].includes(s)) return "saturday";
  if (["sundays", "sun."].includes(s)) return "sunday";
  return DAY_WORDS.includes(s) ? s : null;
};

// A count is per day type: a weekday name is a weekday, sat a saturday, sun a sunday.
const dayTypeWord = (w) => {
  const d = dayWord(w);
  if (!d || d === "daily") return "weekday";
  if (d === "sat" || d === "saturday") return "saturday";
  if (d === "sun" || d === "sunday") return "sunday";
  return "weekday";
};

const directionOf = (v) => (v == null ? null : isObject(v) && str(v.towards) ? { towards: str(v.towards) } : ["0", "1", "both"].includes(String(v)) ? String(v) : null);

const scopeOf = (raw) => {
  const s = isObject(raw) ? raw : {};
  const direction = directionOf(s.direction);
  const days = Array.isArray(s.days) ? s.days.map(dayWord).filter(Boolean) : typeof s.days === "string" && dayWord(s.days) ? [dayWord(s.days)] : null;
  return {
    lines: list(s.lines),
    direction,
    days: days && days.length ? [...new Set(days)] : null,
    period: str(s.period, 40),
    from_date: ymd(s.from_date),
    to_date: ymd(s.to_date),
    dates: Array.isArray(s.dates) ? s.dates.map(ymd).filter(Boolean).slice(0, 100) : [],
    stops: list(s.stops),
    // What the scope leaves out (a keep of « every other line »): lines.
    except: isObject(s.except) && list(s.except.lines).length ? { lines: list(s.except.lines) } : null,
  };
};

const referenceOf = (raw) => {
  if (!isObject(raw) || !REFERENCE_KINDS.includes(raw.kind)) return null;
  if (raw.kind === "like_day") {
    const day = dayWord(raw.day) || ymd(raw.day);
    if (!day) return null;
    return { kind: "like_day", day, what: ["running_times", "timetable"].includes(raw.what) ? raw.what : "timetable", from_stop: str(raw.from_stop), to_stop: str(raw.to_stop), like_date: ymd(raw.like_date), direction: directionOf(raw.direction) };
  }
  if (!str(raw.line)) return null;
  return { kind: "like_line", line: str(raw.line), what: ["shape", "stops"].includes(raw.what) ? raw.what : "shape", from_stop: str(raw.from_stop), to_stop: str(raw.to_stop), direction: directionOf(raw.direction), like_direction: directionOf(raw.like_direction) };
};

const demandOf = (raw, i) => {
  if (!isObject(raw)) return null;
  const shape = SHAPES.includes(raw.shape) ? raw.shape : null;
  const window = isObject(raw.window) ? { from: hhmm(raw.window.from), to: hhmm(raw.window.to) } : null;
  return {
    id: str(raw.id, 20) || `d${i + 1}`,
    quote: str(raw.quote, 400),
    document: str(raw.document, 160),
    scope: scopeOf(raw.scope),
    shape,
    replaces_existing: raw.replaces_existing === true ? true : raw.replaces_existing === false ? false : null,
    window: window && (window.from || window.to) ? window : null,
    counts: (Array.isArray(raw.counts) ? raw.counts : []).filter((c) => isObject(c) && Number.isInteger(c.trips) && c.trips >= 0).map((c) => ({ day: dayTypeWord(c.day), trips: c.trips, per: c.per === "total" ? "total" : "direction", period: str(c.period, 40), direction: c.direction == null ? null : String(c.direction) })).slice(0, 12),
    references: (Array.isArray(raw.references) ? raw.references : []).map(referenceOf).filter(Boolean).slice(0, 12),
    keeps: (Array.isArray(raw.keeps) ? raw.keeps : []).filter(isObject).map((k) => ({ quote: str(k.quote, 400), scope: scopeOf(k.scope) })).slice(0, 12),
    clauses: Array.isArray(raw.clauses) ? raw.clauses.filter(isObject).slice(0, 60) : [],
  };
};

/** The sheet as the engine reads it; null for nothing. */
const normalizeSheet = (raw) => {
  if (!isObject(raw)) return null;
  const demands = (Array.isArray(raw.demands) ? raw.demands : []).map(demandOf).filter(Boolean).slice(0, 60);
  return {
    effective_date: ymd(raw.effective_date),
    demands,
    keeps: (Array.isArray(raw.keeps) ? raw.keeps : []).filter(isObject).map((k) => ({ quote: str(k.quote, 400), scope: scopeOf(k.scope) })).slice(0, 20),
    questions: (Array.isArray(raw.questions) ? raw.questions : []).filter(isObject).map((q) => ({ demand: str(q.demand, 20), kind: str(q.kind, 40), text: str(q.text, 400), options: list(q.options, 8) })).slice(0, 20),
  };
};

// ── Two readings of one brief ────────────────────────────────────────────────

/**
 * The fields of a demand two readings are compared on, each read into one comparable value: the scope resolved to
 * day types, dates, a direction, a period, stops; the form; the window of the day; the counts; the references; what a
 * replacing timetable replaces. Never the quote nor the text: two readings that say the same thing in other words agree.
 */
const DEMAND_FIELDS = Object.freeze(["shape", "effective_date", "to_date", "days", "direction", "period", "dates", "stops", "window", "counts", "references", "replaces_existing"]);
const sorted = (xs) => [...new Set(xs.map(String))].sort();
// A name by its letters: accents, the two apostrophes, case and spacing aside (« Pôle d’Échanges » and « Pole d'Echanges » are one name).
const nameKey = (v) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’'`]/g, "'").toLowerCase().replace(/\s+/g, " ").trim();
// The same name, or one the other contains: a stop read in the feed (« Gare du Nord quai F ») is the brief's word (« Gare du Nord ») in full.
const sameName = (a, b) => {
  const x = nameKey(a);
  const y = nameKey(b);
  return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x));
};
const directionValue = (d) => (d == null ? null : isObject(d) ? `towards:${d.towards}` : String(d));
const DAY_TYPES_ALL = ["saturday", "sunday", "weekday"];
// Two values of a field read the same: names by their letters and containment, stop lists as one set holding the other,
// anything else as written.
const sameValue = (field, a, b) => {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (field === "direction") return String(a).startsWith("towards:") && String(b).startsWith("towards:") && sameName(String(a).slice(8), String(b).slice(8));
  if (field === "stops") {
    const xs = String(a).split(",");
    const ys = String(b).split(",");
    const within = (s, t) => s.every((n) => t.some((m) => sameName(n, m)));
    return within(xs, ys) || within(ys, xs);
  }
  if (field === "counts") {
    const parts = (v) => String(v).split(";").map((c) => c.split("/")).sort((x, y) => x.join("/").localeCompare(y.join("/")));
    const xs = parts(a);
    const ys = parts(b);
    return xs.length === ys.length && xs.every((x, i) => x.every((p, j) => (j === 3 ? sameName(p.replace(/^towards:/, ""), ys[i][j].replace(/^towards:/, "")) || p === ys[i][j] : p === ys[i][j])));
  }
  return false;
};
const fieldValue = (demand, sheet, field) => {
  const S = demand.scope;
  switch (field) {
    case "shape": return demand.shape;
    case "effective_date": return S.from_date || (S.dates.length ? null : sheet.effective_date) || null;
    case "to_date": return S.to_date;
    case "days": return S.days ? (DAY_TYPES_ALL.every((t) => S.days.includes(t)) ? "daily" : sorted(S.days).join(",")) : null;
    case "direction": return directionValue(S.direction);
    case "period": return S.period;
    case "dates": return S.dates.length ? sorted(S.dates).join(",") : null;
    case "stops": return S.stops.length ? sorted(S.stops).join(",") : null;
    case "window": return demand.window ? `${demand.window.from || ""}–${demand.window.to || ""}` : null;
    case "counts": return demand.counts.length ? sorted(demand.counts.map((c) => `${c.trips}/${c.per || ""}/${c.day || ""}/${directionValue(c.direction) || ""}/${c.period || ""}`)).join(";") : null;
    case "references": return demand.references.length ? sorted(demand.references.map((r) => `${r.kind}:${r.what || ""}:${r.day || r.like_date || r.line || ""}`)).join(";") : null;
    case "replaces_existing": return demand.replaces_existing;
    default: return null;
  }
};

// Two demands are the same demand of the brief when they name a line in common and the same form (ids differ between
// readings); failing that, a line in common alone (the form is then one of the divergences).
const matchDemands = (a, b) => {
  const pairs = [];
  const taken = new Set();
  const shares = (x, y) => x.scope.lines.some((l) => y.scope.lines.includes(l));
  for (const strict of [true, false]) {
    for (const da of a) {
      if (pairs.some(([x]) => x === da)) continue;
      const db = b.find((d) => !taken.has(d) && shares(da, d) && (!strict || d.shape === da.shape));
      if (db) {
        pairs.push([da, db]);
        taken.add(db);
      }
    }
  }
  return { pairs, onlyA: a.filter((d) => !pairs.some(([x]) => x === d)), onlyB: b.filter((d) => !taken.has(d)) };
};

/**
 * The divergences of two readings of one brief (reading A the brief alone, reading B the brief with the feed), on
 * their normalised content: a demand one reading has and the other not; a field of a demand both have that reads
 * differently. Each is a question for the person — A or B — with the two values; nothing is settled here.
 *   → [{ id: "r1", kind: "field" | "demand", demand: { a, b }, field, a, b, quote }]
 */
const reconcileSheets = (rawA, rawB) => {
  const A = normalizeSheet(rawA);
  const B = normalizeSheet(rawB);
  if (!A || !B) return [];
  // A keep written as a demand is a keep (derivedChecks reads it so), never a demand one reading has and the other not.
  const changing = (d) => d.shape !== "keep";
  const { pairs, onlyA, onlyB } = matchDemands(A.demands.filter(changing), B.demands.filter(changing));
  const out = [];
  let n = 1;
  const push = (d) => out.push({ id: `r${n++}`, ...d });
  if (A.effective_date !== B.effective_date && !(A.effective_date && B.effective_date === null && A.demands.every((d) => d.scope.from_date))) push({ kind: "field", demand: { a: null, b: null }, field: "effective_date", a: A.effective_date, b: B.effective_date, quote: null });
  for (const [da, db] of pairs) {
    for (const field of DEMAND_FIELDS) {
      const va = fieldValue(da, A, field);
      const vb = fieldValue(db, B, field);
      if (sameValue(field, va, vb) || (va == null && vb == null)) continue;
      // A value one reading leaves out is not a divergence of its own: the reading that read it is the fuller one, and
      // the derived tests measure what it says; two values stated and different are the question.
      if (va == null || vb == null) continue;
      push({ kind: "field", demand: { a: da.id, b: db.id }, field, a: va, b: vb, quote: da.quote || db.quote || null });
    }
  }
  for (const d of onlyA) push({ kind: "demand", demand: { a: d.id, b: null }, field: "demand", a: `${d.shape} ${d.scope.lines.join(", ")}`, b: null, quote: d.quote });
  for (const d of onlyB) push({ kind: "demand", demand: { a: null, b: d.id }, field: "demand", a: null, b: `${d.shape} ${d.scope.lines.join(", ")}`, quote: d.quote });
  return out;
};

/**
 * Sheet A with the person's choices applied: a field read as B takes B's value on that demand; a demand only B has,
 * chosen, joins the sheet; a demand only A has, read as B (absent), leaves it. Choices: { [divergenceId]: "A" | "B" }.
 */
const withChoices = (rawA, rawB, divergences, choices = {}) => {
  const A = normalizeSheet(rawA);
  const B = normalizeSheet(rawB);
  if (!A) return null;
  if (!B) return A;
  const demands = A.demands.map((d) => ({ ...d, scope: { ...d.scope } }));
  let effective = A.effective_date;
  for (const dv of divergences || []) {
    if (choices[dv.id] !== "B") continue;
    if (dv.kind === "demand" && dv.demand.b && !dv.demand.a) {
      const db = B.demands.find((d) => d.id === dv.demand.b);
      if (db) demands.push({ ...db, id: `${db.id}_b` });
      continue;
    }
    if (dv.kind === "demand" && dv.demand.a && !dv.demand.b) {
      const i = demands.findIndex((d) => d.id === dv.demand.a);
      if (i >= 0) demands.splice(i, 1);
      continue;
    }
    if (dv.field === "effective_date" && !dv.demand.a) {
      effective = B.effective_date;
      continue;
    }
    const target = demands.find((d) => d.id === dv.demand.a);
    const source = B.demands.find((d) => d.id === dv.demand.b);
    if (!target || !source) continue;
    switch (dv.field) {
      case "shape": target.shape = source.shape; break;
      case "effective_date": target.scope.from_date = source.scope.from_date; break;
      case "to_date": target.scope.to_date = source.scope.to_date; break;
      case "days": target.scope.days = source.scope.days; break;
      case "direction": target.scope.direction = source.scope.direction; break;
      case "period": target.scope.period = source.scope.period; break;
      case "dates": target.scope.dates = source.scope.dates; break;
      case "stops": target.scope.stops = source.scope.stops; break;
      case "window": target.window = source.window; break;
      case "counts": target.counts = source.counts; break;
      case "references": target.references = source.references; break;
      case "replaces_existing": target.replaces_existing = source.replaces_existing; break;
      default: break;
    }
  }
  return { ...A, effective_date: effective, demands };
};

module.exports = { SHAPES, DAY_WORDS, REFERENCE_KINDS, DEMAND_FIELDS, normalizeSheet, reconcileSheets, withChoices, _internals: { dayWord, scopeOf, demandOf, referenceOf, fieldValue, matchDemands, nameKey, sameName, sameValue } };
