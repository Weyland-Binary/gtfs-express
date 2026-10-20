/**
 * build_timetable — "Line 1, towards ZA Méquinenza, Monday to Friday: first
 * departure 05:45, last 21:15, every 30 min until 07:00, every 10 min until
 * 09:00…" — or the full timetable of an offer sheet (stops × trips): the
 * trips the order states, built on the line's existing stop patterns, and
 * nothing else.
 *
 * An operator's offer order is often a spreadsheet (spreadsheet/parser):
 * per line, direction and day type, the first and last departures and the
 * headway by band, or every trip of a timetable. This operation builds
 * exactly the trips it states, on the scope's dates, in place of the
 * direction's trips there, and asks for anything the order does not say:
 *
 *   • What: `first` + `last` + `bands` [{ from, to, headway_min }] (the
 *     departures run from `first`, each the previous one plus the headway of
 *     the band holding it, until `last` — always a departure, the last gap
 *     shorter when it is off the grid, said; a more frequent band starts
 *     with a departure at its start when the previous headway would pass it,
 *     so each band's headway holds from its start — what a headway_max
 *     clause of that band measures; a band whose headway is null or "none"
 *     has no departure: a departure that would fall in it is not run, the
 *     next one is the start of the next band that has a headway (or the
 *     last departure, which the order states: said when it lies inside the
 *     band without service)), or `times` (the departures themselves), or
 *     `timetable` { stops: [names], trips: [[time | null | "pass" per
 *     stop]], numbers?: [trip numbers] } — one of them, never two. In a
 *     timetable, null is a stop the order gives no time for (placed by the
 *     running times), "pass" a stop the trip does NOT serve (« | » in the
 *     sheet): never given a time. Departures are read at `at_stop` (default: the
 *     pattern's first stop). A departure outside every band (the order says
 *     no headway there) is a question (`gaps`: band_start — the next
 *     departure is the next band's start).
 *   • Which stop pattern (GTFS has no pattern entity: the line's distinct
 *     stop sequences): the direction's only one, else `pattern` — "main",
 *     "Origin → Terminus" (with its stop count when two share their ends) or
 *     a stop the pattern ends at — else asked. A timetable's trip runs the
 *     pattern whose stops hold the trip's stops in order, from the first one
 *     it serves to the last: one such pattern is taken, several are asked
 *     (`pattern`), none is a question too (a new route of the line is
 *     another operation: add_route_variant, create_route). A trip's "pass"
 *     stops rule out every pattern calling there; when each pattern holding
 *     the trip calls at one, it is asked (`pass_stops` serve: the trip
 *     serves them after all, a time placed by the running times) — never a
 *     stop served that the order says the trip does not serve. A timetable
 *     may also state BANDS over trips it gives no time (the timetable's `bands`
 *     [{ from, to, headway_min, stop: the index of the stop the departures
 *     are read at, trips: [[null | "pass" per stop]] the stop patterns its
 *     trips serve, in turn }] — « 7h – 19h : 12 min » merged over columns of
 *     a desserte grid): their departures are placed every headway from each
 *     band's start, before its end (`band_times` "grid", the only answer —
 *     asked unless said: the order gives a headway, not the times); the
 *     departure at a band's start is left out when one already runs within
 *     a headway before it (the timetable's own trip, or the previous
 *     band's), a time the timetable states itself is the timetable's.
 *   • Bounds, each refused with its own sentence before anything is looked
 *     up or placed (one preview body must never hold the process): a
 *     timetable of at most MAX_TIMETABLE_STOPS stops and MAX_TRIPS trips —
 *     its rows, or what its bands would place: the placing stops at the
 *     bound and the answer says the count —, twelve bands of at most eight
 *     stop patterns each, a headway of one to 240 minutes, a band's `stop`
 *     an index written as a number (null or "" would read as the first
 *     stop), two bands of one stop never overlapping (asked, as in the bands
 *     mode).
 *   • Which running times: the order rarely states them. `running_times`
 *     "existing" (the only answer) copies, for each new trip, the pattern's
 *     trip nearest in time on that day timetable (peak running times stay
 *     peak) — asked unless the order says so; a timetable that gives a time
 *     at every stop of its pattern needs none (its own times are written),
 *     one that skips stops places them by the existing running times
 *     between its own times (running_times "existing", else asked): the
 *     template's profile scaled between two of the order's times, its dwells
 *     kept, to the line's own precision (the second where its times carry
 *     seconds, the minute where it writes minutes) — never two stops at the
 *     same instant where the trip it copies runs between them while the
 *     order's interval leaves room (rounding to the minute on a line timed
 *     to the second would make hundreds), two stops it reaches in the same
 *     minute kept so —, the order's own times exactly as written.
 *   • Which dates: the scope's dates on which the direction runs (grouped by
 *     its day timetables, scope.dayGroups); the direction's trips there are
 *     withdrawn (they keep their id on their other dates) and the new trips
 *     run there, on services running exactly those dates. Dates of the scope
 *     on which the direction runs nothing at all (a public holiday without
 *     service, a day type not run yet) are asked (`new_dates`: add | skip | new_days),
 *     never served silently. A weekday change meeting the Monday–Friday dates
 *     the line runs as Saturdays asks holiday_weekdays (scope.weekdayHole).
 *   • The other patterns: when the direction's trips on those dates run
 *     other patterns than the ones built, `others` says whether they go
 *     (replace: the order states the whole timetable) or stay (keep) —
 *     asked otherwise; a desserte grid carries the answer (replace) for the
 *     engine to take when asked to, recorded, and the step says what went.
 *   • New trips: ids <route>_<dir>_<service>_<hhmm>, no block_id — the
 *     vehicle schedules are the operator's scheduling tool's, never
 *     re-chained here: the new trips in no block and the blocks a withdrawn
 *     trip leaves with a hole are counted in the step's words (blocking.
 *     unchained) —,
 *     trip_short_name the order's trip number when the timetable gives one
 *     and the line's trips carry theirs (a rider reads it: on a line that
 *     never fills it the order's numbers stay the order's, said; else none:
 *     the template's number belongs to another trip), headsign and shape
 *     from the template (same pattern, same terminus).
 * Messages in ctx.lang (i18n.js).
 */

"use strict";

const R = require("../resolve");
const G = require("../gtfsOps");
const S = require("../scope");
const blocking = require("../blocking");
const runtime = require("../runtime");
const { tripsOfRoute, memo, _internals: fm } = require("../feedModel");
const { tr } = require("../i18n");
const { MAX_RANGE_DAYS } = require("../calendars");

const { secToTime } = fm;
const RUNNING_TIMES = ["existing"];
const OTHERS = ["replace", "keep"];
// new_days: only on the weekdays the direction runs on no date of the feed (a day type new to it), the other dates
// without service (a public holiday) left as they are.
const NEW_DATES = ["skip", "add", "new_days"];
const GAPS = ["band_start"];
const PASS_STOPS = ["serve"];
const BAND_TIMES = ["grid"];
const MAX_TRIPS = 400;
const MAX_TIMETABLE_STOPS = 300; // a stop pattern of a line has far fewer rows
const MAX_TIMETABLE_BANDS = 12;
const MAX_BAND_ROWS = 8; // the stop profiles a band's trips take in turn
// A headway is written in minutes: one at least (seconds would place thousands of departures), four hours at most.
const MIN_HEADWAY_MIN = 1;
const MAX_HEADWAY_MIN = 240;
const MAX_TIME = 100 * 3600; // no time of an order passes what "99:59:59" reads as (a number given as seconds included)
const ARROW = /^(.+?)\s*(?:→|->|>)\s*(.+?)(?:\s*\((\d+)\s*(?:stops?|arrêts?)\))?$/i;

const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
const hhmm = (s) => secToTime(s).slice(0, 5);
const nameOf = (model, id) => model.stops.get(id)?.name || id;
const timeOf = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : R.timeToSec(v));
const isNone = (v) => v == null || v === "" || v === 0 || v === "0" || (typeof v === "string" && ["none", "no_service", "-", "—"].includes(v.trim().toLowerCase()));
// A timetable cell saying the trip does not serve that stop.
const isPass = (v) => typeof v === "string" && ["pass", "|"].includes(v.trim().toLowerCase());

/**
 * The departures `first` … `last` by bands (see the header): → { deps: [sec], notes } | { gap: { at, next } } |
 * { overlap: [a, b] }. A band's `to` is excluded (the catalogue's bound rule): a departure at a band's end runs in
 * the next band. A pure function, exported for the spreadsheet's clauses and the tests.
 */
const bandSeries = ({ first, last, bands, gaps = null }) => {
  const list = bands.map((b) => ({ from: b.from, to: b.to, headway: b.headway })).sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < list.length; i++) if (list[i].from < list[i - 1].to) return { overlap: [list[i - 1], list[i]] };
  const deps = [first];
  const notes = [];
  let t = first;
  for (let guard = 0; t < last && guard < MAX_TRIPS * 4; guard++) {
    const band = list.find((b) => b.from <= t && t < b.to);
    let next;
    if (band && band.headway) {
      next = t + band.headway;
      const after = list.find((b) => b.from === band.to);
      if (after && !after.headway && next >= band.to) {
        // The next departure would fall in a band without service: none there. The next one is the start of the next
        // band with a headway, else the last departure (the order states it — said when the band holds it).
        const resume = list.find((b) => b.from >= after.to && b.headway);
        if (resume && resume.from < last) next = resume.from;
        else {
          next = last;
          if (last > after.from && last < after.to) notes.push({ code: "last_in_band_without_service", at: last });
        }
      } else if (after && after.headway && next > band.to && after.headway < band.headway) {
        // A more frequent band right after this one starts with a departure at its start (its headway holds from there).
        next = band.to;
      }
    } else {
      // No headway where t stands: a band without service runs to the next band that has one; else the order says nothing.
      const after = list.find((b) => b.from > t && b.headway);
      if (band && !band.headway) next = after ? after.from : last;
      else if (gaps === "band_start") next = after ? after.from : last;
      else return { gap: { at: t, next: after ? after.from : last } };
    }
    if (next >= last) {
      if (next > last) notes.push({ code: "last_off_grid", gap: last - t });
      deps.push(last);
      break;
    }
    deps.push(next);
    t = next;
  }
  return { deps: [...new Set(deps)], notes };
};

/**
 * The trips a timetable's bands stand for (see the header: the timetable's `bands`, band_times "grid"). `bands` as the
 * order gives them, `trips` the timetable's own ([{ times: [sec | null] }]), `nStops` its number of stops.
 *   → { error: true } (a band that cannot be read: its shape) |
 *     { error: { code, …words } } (a bound passed — too_many_bands, too_many_band_rows, too_many_trips —, a window
 *       or a headway that is none — band_invalid, timetable_band_headway_invalid —, two bands of one stop overlapping
 *       — bands_overlap: the question's code, with the figures its sentence says) |
 *     { trips: [{ times, passes }], facts: [{ from, to, headway (s), stop, count, first, last }] }
 * Every headway from the band's start, before its end (the catalogue's bound rule); the departure at the start is
 * left out when one already runs within a headway before it — the timetable's last trip before the band, or the
 * previous band's: the headway already holds from there, and an authority's count of trips counts none there —; a
 * time the timetable states itself is the timetable's trip. Nothing is built past MAX_TRIPS: the count goes on,
 * for the answer to say it, but no trip is allocated. A pure function, exported for the tests.
 */
const timetableBands = (bands, trips, nStops) => {
  if (!Array.isArray(bands)) return { error: true };
  if (bands.length > MAX_TIMETABLE_BANDS) return { error: { code: "too_many_bands", count: bands.length, max: MAX_TIMETABLE_BANDS } };
  const list = [];
  for (const [i, b] of bands.entries()) {
    const from = timeOf(b?.from);
    const to = timeOf(b?.to);
    const hw = Number(String(b?.headway_min ?? "").replace(",", "."));
    const rows = Array.isArray(b?.trips) && b.trips.length ? b.trips : [new Array(nStops).fill(null)];
    if (rows.length > MAX_BAND_ROWS) return { error: { code: "too_many_band_rows", n: i + 1, count: rows.length, max: MAX_BAND_ROWS } };
    if (from == null || to == null || from < 0 || to <= from || to > MAX_TIME) return { error: { code: "band_invalid", n: i + 1, from: String(b?.from ?? "?"), to: String(b?.to ?? "?") } };
    if (!(hw >= MIN_HEADWAY_MIN && hw <= MAX_HEADWAY_MIN)) return { error: { code: "timetable_band_headway_invalid", n: i + 1, value: String(b?.headway_min ?? "") } };
    // The stop is an index written as a number: null, "" or false would read as the first stop.
    const stop = b?.stop;
    if (typeof stop !== "number" || !Number.isInteger(stop) || stop < 0 || stop >= nStops || rows.some((r) => !Array.isArray(r) || r.length !== nStops)) return { error: true };
    list.push({ from, to, headway: Math.round(hw * 60), stop, rows: rows.map((r) => r.map(isPass)) });
  }
  list.sort((a, b) => a.from - b.from || a.to - b.to);
  // Two bands of one stop overlapping: which headway holds between them is a question (as in the bands mode).
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (list[i].stop === list[j].stop && list[j].from < list[i].to) return { error: { code: "bands_overlap", a: list[i], b: list[j] } };
  // The departures at each stop so far: the timetable's own, then the ones the bands place (one Set per stop, looked
  // up at each grid point, never rebuilt).
  const at = new Map();
  const there = (stop) => {
    if (!at.has(stop)) at.set(stop, new Set(trips.map((t) => t.times[stop]).filter((x) => x != null)));
    return at.get(stop);
  };
  const made = [];
  const facts = [];
  let count = trips.length;
  for (const b of list) {
    const all = there(b.stop);
    const mine = { count: 0, first: null, last: null };
    for (let t = b.from; t < b.to; t += b.headway) {
      if (all.has(t)) continue;
      if (t === b.from && [...all].some((d) => d > b.from - b.headway && d < b.from)) continue;
      count += 1;
      // Past the bound of trips in one step nothing more is built: the count goes on, for the answer to say it.
      if (count <= MAX_TRIPS) made.push({ stop: b.stop, t, row: b.rows[mine.count % b.rows.length] });
      all.add(t);
      mine.count += 1;
      if (mine.first == null) mine.first = t;
      mine.last = t;
    }
    facts.push({ from: b.from, to: b.to, headway: b.headway, stop: b.stop, count: mine.count, first: mine.first, last: mine.last });
  }
  if (count > MAX_TRIPS) return { error: { code: "too_many_trips", count, max: MAX_TRIPS } };
  // A band's trip serves its stop, whatever the row marks there (an unmerged band cell leaves its columns empty).
  return { trips: made.map((m) => ({ times: m.row.map((_, j) => (j === m.stop ? m.t : null)), passes: m.row.map((x, j) => (j === m.stop ? false : x)) })), facts };
};

/**
 * The question a timetable's bands ask when they cannot be read (timetableBands → error): a bound passed, two bands
 * of one stop overlapping, a window or a headway that is none, each in its own words — else the timetable's shape.
 */
const bandQuestion = (error, lang) => {
  const e = error && typeof error === "object" ? error : { code: "timetable_invalid" };
  const span = (b) => `${hhmm(b.from)}–${hhmm(b.to)}`;
  const message =
    e.code === "too_many_bands" ? tr(lang, "build_timetable.too_many_bands", { count: e.count, max: e.max })
    : e.code === "too_many_band_rows" ? tr(lang, "build_timetable.too_many_band_rows", { n: e.n, count: e.count, max: e.max })
    : e.code === "too_many_trips" ? tr(lang, "build_timetable.too_many_trips", { count: e.count, max: e.max })
    : e.code === "bands_overlap" ? tr(lang, "build_timetable.bands_overlap", { a: span(e.a), b: span(e.b) })
    : e.code === "band_invalid" ? tr(lang, "build_timetable.band_invalid", { n: e.n, from: e.from, to: e.to })
    : e.code === "timetable_band_headway_invalid" ? tr(lang, "build_timetable.timetable_band_headway_invalid", { n: e.n, value: e.value })
    : tr(lang, "build_timetable.timetable_invalid");
  return { param: "timetable", code: e.code, message };
};

// ── Patterns ────────────────────────────────────────────────────────────────

const patternLabel = (model, key, withCount) => {
  const p = model.patterns.get(key);
  return `${nameOf(model, p.stops[0])} → ${nameOf(model, p.stops[p.stops.length - 1])}${withCount ? ` (${p.stops.length} stops)` : ""}`;
};
/** Unique labels for these patterns: "A → B", with the stop count where two share their ends. */
const labelsOf = (model, keys) => {
  const plain = keys.map((k) => patternLabel(model, k, false));
  return keys.map((k, i) => (plain.filter((x) => x === plain[i]).length > 1 ? patternLabel(model, k, true) : plain[i]));
};

/** A stop name of the line, its namesakes on the line and their platforms. */
const stopIds = (model, ref, routeId, lang) => {
  const r = R.stop(model, ref, { routeId, allowMany: true, lang });
  if (r.ambiguity) return { ambiguity: r.ambiguity };
  // Several stops under one reference are one name's namesakes (a stop per direction, the platforms) — never stops
  // of different names that a part of the reference happens to match (« BOURG »: « Centre Bourg » and « Terves
  // Centre Bourg »): which one is then asked, never the first taken.
  const names = [...new Map((r.many || [r.value]).map((s) => [R.looseKey(s.name), s.name])).values()];
  if (names.length > 1) return { ambiguity: { code: "stop_ambiguous", message: tr(lang, "resolve.stop_ambiguous", { ref: String(ref), count: names.length }), options: names.slice(0, 12) } };
  const ids = new Set();
  for (const s of r.many || [r.value]) {
    if (!s.id) continue;
    ids.add(s.id);
    // …and its platforms, from the resolver's per-model index (never a walk over every stop per hit).
    for (const y of R.childrenOf(model, s.id)) ids.add(y);
  }
  return { name: r.value.name, ids };
};

/**
 * The stops a grid's unknown stop may be, closest first: the line's own stops (else the feed's), ranked by
 * the words their names share with the grid's (« SAINT-FIACRE QUAI B » → « Saint-Fiacre » before « Fiacre Moulin »),
 * then by a shared beginning — at most five, none without a word or a beginning in common. Words that say where on
 * a stop rather than which one count for nothing: « arrêt » and the articles anywhere, « quai », « voie » or
 * « côté » with the letter or number that follows them (« quai B », « voie 2 ») — « Gare quai B » is no choice for
 * « Saint-Fiacre quai B ». A digit or a letter standing alone tells stops apart (« Collège 2 » is not « Collège
 * 1 », « Porte B » not « Porte A »), and « quai », « voie », « côte » without such a suffix are words of the name
 * (« Quai de la Gare » is not « Gare »). One choice per name, the name as its value: a name covers the line's stops
 * that bear it (one per direction, often), and the trip's order picks the one it calls at — a choice of one stop id
 * would hold one direction only. Choices only: the person picks, the engine never guesses; a name whose words are
 * exactly one stop name's is marked (`exact`, « Collège 2 » is not « Collège 1 »: a digit or a letter of its own
 * tells stops apart). Several names that
 * read as the grid's leave no room for a name that only shares a word with it (« Place Jean-Jaurès »: its two quays,
 * never « Jean-Rostand »); one alone keeps the near names after it (the person may still pick another stop); between
 * names as close, the ones the `direction` serves come first (`onDirection`: one of the stops bearing the name is on
 * that direction's patterns — two quays of one place, one per direction).
 */
const STOP_CHOICES = 5;
const ARTICLES = new Set(["de", "du", "des", "la", "le", "les", "et", "l", "d"]);
const STOP_WORDS = new Set(["arret", "arrets", "stop", "stops"]);
const PLATFORM_WORDS = new Set(["quai", "quais", "voie", "voies", "platform", "plateforme", "cote"]);
const PLATFORM_SUFFIX = /^(?:[a-z]|\d+)$/;
const wordsOf = (name) => {
  const raw = String(name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const w = raw[i];
    if (ARTICLES.has(w) || STOP_WORDS.has(w)) continue;
    // « quai B », « voie 2 »: where on the stop, not which — dropped with its suffix only.
    if (PLATFORM_WORDS.has(w) && i + 1 < raw.length && PLATFORM_SUFFIX.test(raw[i + 1])) {
      i += 1;
      continue;
    }
    out.push(w);
  }
  return out;
};
// The place a name says (« quai B », « voie 2 »), as one token per platform word and its letter or number: two names
// of the same words are one stop unless both say a place and the places differ (« Gare Quai 2 » is not « Gare Quai
// 1 »); a name saying none reads as either (« SAINT-FIACRE QUAI B » is « Saint Fiacre »).
const PLATFORM_OF = { quais: "quai", voies: "voie", plateforme: "platform" };
const placesOf = (name) => {
  const raw = String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < raw.length; i++) {
    if (!PLATFORM_WORDS.has(raw[i]) || !PLATFORM_SUFFIX.test(raw[i + 1])) continue;
    out.push(`${PLATFORM_OF[raw[i]] || raw[i]} ${raw[i + 1]}`);
    i += 1;
  }
  return out;
};
const placesAgree = (a, b) => !a.length || !b.length || (a.length === b.length && a.every((x) => b.includes(x)));
// The words of the feed's stops, read once per model's stops (a grid of 300 names over a feed of 20 000 stops reads
// each stop's name once, not once per name): the stops bearing each word, and each first word.
const CHOICE_INDEX = new WeakMap();
const choiceIndex = (model) => {
  const hit = CHOICE_INDEX.get(model.stops);
  if (hit) return hit;
  const byWord = new Map();
  const byFirst = new Map();
  for (const x of model.stops.values()) {
    if (!(x.location_type === "0" || !x.location_type)) continue;
    const e = { x, have: wordsOf(x.name), places: placesOf(x.name) };
    for (const w of new Set(e.have)) {
      if (!byWord.has(w)) byWord.set(w, []);
      byWord.get(w).push(e);
    }
    if (e.have.length) {
      if (!byFirst.has(e.have[0])) byFirst.set(e.have[0], []);
      byFirst.get(e.have[0]).push(e);
    }
  }
  const idx = { byWord, byFirst, firsts: [...byFirst.keys()].sort() };
  CHOICE_INDEX.set(model.stops, idx);
  return idx;
};
const stopChoices = (model, raw, routeId, direction = null) => {
  const want = wordsOf(raw);
  if (!want.length) return [];
  const wantPlaces = placesOf(raw);
  const served = routeId ? R.stopsOfRoute(model, routeId) : null;
  const inPool = (x) => !served || !served.size || served.has(x.id);
  const ways = routeId && direction != null && direction !== "both" ? R.stopsOfRoute(model, routeId, direction) : null;
  // The stops that may score: a word in common, or a first word beginning like the name's (either way) — every
  // other stop scores nothing.
  const idx = choiceIndex(model);
  const cands = new Set();
  for (const w of new Set(want)) for (const e of idx.byWord.get(w) || []) cands.add(e);
  for (let n = 1; n <= want[0].length; n++) for (const e of idx.byFirst.get(want[0].slice(0, n)) || []) cands.add(e);
  let lo = 0;
  let hi = idx.firsts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (idx.firsts[mid] < want[0]) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < idx.firsts.length && idx.firsts[i].startsWith(want[0]); i++) for (const e of idx.byFirst.get(idx.firsts[i])) cands.add(e);
  const scored = [...cands]
    .filter((e) => inPool(e.x))
    .map(({ x, have, places }) => {
      const shared = want.filter((w) => have.includes(w)).length;
      const prefix = have.length && (have[0].startsWith(want[0]) || want[0].startsWith(have[0])) ? 0.5 : 0;
      // The same words, the place words aside (« SAINT-FIACRE QUAI B » and « Saint Fiacre »): the name reads as
      // this one — unless both say a place and not the same.
      const exact = have.length === want.length && have.every((w) => want.includes(w)) && want.every((w) => have.includes(w)) && placesAgree(places, wantPlaces);
      return { x, score: shared + prefix + (exact ? 10 : 0), exact, onDirection: Boolean(ways && ways.has(x.id)) };
    })
    .filter((c) => c.score > 0)
    // Closest first; between stops as close, the direction's — a name's first stop says whether the direction serves it.
    .sort((a, b) => b.score - a.score || Number(b.onDirection) - Number(a.onDirection) || String(a.x.name).localeCompare(String(b.x.name)));
  // Several names that read as the grid's: they alone are offered. One alone: the near names follow it, so that the
  // person who reads the question can still pick another stop (a question offers its options, nothing else).
  const exactNames = new Set(scored.filter((c) => c.exact).map((c) => String(c.x.name || c.x.id).trim().toLowerCase()));
  const pool = exactNames.size > 1 ? scored.filter((c) => c.exact) : scored;
  const seen = new Set();
  const out = [];
  for (const c of pool) {
    const key = String(c.x.name || c.x.id).trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: String(c.x.name || c.x.id).trim(), label: String(c.x.name || c.x.id).trim(), exact: c.exact, onDirection: c.onDirection });
    if (out.length >= STOP_CHOICES) break;
  }
  return out;
};

/** The pattern a reference names among \`keys\`: "main" (the most trips), a label "A → B (n stops)", or a terminus. */
const patternByRef = (model, keys, ref, routeId, lang) => {
  const raw = String(ref).trim();
  if (raw.toLowerCase() === "main") return { keys: [[...keys].sort((a, b) => model.patterns.get(b).trips.length - model.patterns.get(a).trips.length)[0]] };
  const labels = labelsOf(model, keys);
  const exact = keys.filter((k, i) => labels[i] === raw);
  if (exact.length) return { keys: exact };
  const m = ARROW.exec(raw);
  if (m) {
    const a = stopIds(model, m[1], routeId, lang);
    const b = stopIds(model, m[2], routeId, lang);
    if (a.ambiguity || b.ambiguity) return { ambiguity: a.ambiguity || b.ambiguity };
    const whole = keys.filter((k) => { const p = model.patterns.get(k); return a.ids.has(p.stops[0]) && b.ids.has(p.stops[p.stops.length - 1]) && (!m[3] || p.stops.length === Number(m[3])); });
    if (whole.length || m[3]) return { keys: whole };
    // A section of one route: A before B on it, not its two ends — the trips run those stops only (a line cut in two
    // at a closed stretch: its far half runs from a middle stop to the terminus). The route with
    // the most trips holding the section lends its running times.
    const holding = keys
      .map((k) => {
        const st = model.patterns.get(k).stops;
        const from = st.findIndex((s) => a.ids.has(s));
        const to = from < 0 ? -1 : st.findIndex((s, q) => q > from && b.ids.has(s));
        return from >= 0 && to > from && !(from === 0 && to === st.length - 1) ? { k, from, to } : null;
      })
      .filter(Boolean)
      .sort((x, y) => model.patterns.get(y.k).trips.length - model.patterns.get(x.k).trips.length);
    return holding.length ? { keys: [holding[0].k], section: holding[0] } : { keys: [] };
  }
  const x = stopIds(model, raw, routeId, lang);
  if (x.ambiguity) return { ambiguity: x.ambiguity };
  const ending = keys.filter((k) => x.ids.has(model.patterns.get(k).stops.slice(-1)[0]));
  return { keys: ending.length ? ending : keys.filter((k) => model.patterns.get(k).stops.some((s) => x.ids.has(s))) };
};

/** Indexes of `groups` (sets of stop ids) in a pattern's stops, in order (-1 when not all). */
const matchInOrder = (stops, groups) => {
  const out = [];
  let from = 0;
  for (const g of groups) {
    let i = from;
    while (i < stops.length && !g.has(stops[i])) i += 1;
    if (i >= stops.length) return null;
    out.push(i);
    from = i + 1;
  }
  return out;
};

/**
 * The plan's later build_timetable operations of the same line, direction and day type (their ids, a few): a
 * specification gives one grid per origin and the reader makes one operation of each — together they state the
 * direction's timetable. The line and the direction as the engine reads them, the days and dates as written.
 */
const SCOPE_KEYS = ["from_date", "to_date", "dates", "period", "except", "region", "holiday_weekdays"];
const LATER_NAMED = 5;
const scopeKeyOf = (p, lang) => {
  const d = p.days == null || p.days === "" || p.days === "all" ? null : R.days(p.days, { lang });
  const days = !d || (!d.ambiguity && d.value.length >= 7) ? "all" : d.ambiguity ? `?${JSON.stringify(p.days)}` : [...d.value].sort().join(",");
  return JSON.stringify([days, ...SCOPE_KEYS.map((k) => (p[k] == null || p[k] === "" ? null : p[k]))]);
};
const laterGrids = (model, p, ctx, routeId, direction) => {
  const lang = ctx?.lang;
  const key = scopeKeyOf(p, lang);
  const out = [];
  for (const o of Array.isArray(ctx?.later) ? ctx.later : []) {
    if (o?.type !== "build_timetable" || !o.params || scopeKeyOf(o.params, lang) !== key) continue;
    const r = R.route(model, o.params.route, { lang });
    if (!r.value || r.value.id !== routeId) continue;
    const d = R.direction(model, routeId, o.params.direction, { lang });
    if (!d.ambiguity && d.value === direction) out.push(o.id);
  }
  return out;
};

// ── resolve ─────────────────────────────────────────────────────────────────

const resolve = async (model, p, ctx) => {
  const lang = ctx?.lang;
  const ambiguities = [];
  const warnings = [];
  const route = R.route(model, p.route, { lang });
  if (route.ambiguity) ambiguities.push({ param: "route", ...route.ambiguity });
  const sc = await S.resolveScope(model, p, ctx, { daysRequired: true });
  ambiguities.push(...sc.ambiguities);
  warnings.push(...sc.warnings);
  const scope = sc.value;
  let direction = null;
  if (route.value) {
    const d = R.direction(model, route.value.id, p.direction, { lang });
    if (d.ambiguity) ambiguities.push({ param: "direction", ...d.ambiguity });
    else if (d.value === "both") ambiguities.push({ param: "direction", code: "direction_required", message: tr(lang, "build_timetable.direction_required", { line: route.value.short_name || route.value.id }), options: ["0", "1"] });
    else direction = d.value;
  }
  // What the order states: bands, departures, or a timetable — one of them.
  const modes = [given(p.bands) || given(p.first) || given(p.last) ? "bands" : null, given(p.times) ? "times" : null, given(p.timetable) ? "timetable" : null].filter(Boolean);
  if (!modes.length) ambiguities.push({ param: "bands", code: "what_missing", message: tr(lang, "build_timetable.what_missing"), options: ["bands", "times", "timetable"] });
  if (modes.length > 1) ambiguities.push({ param: modes[1], code: "modes_mixed", message: tr(lang, "build_timetable.modes_mixed", { modes: modes.join(", ") }), options: modes });
  for (const k of ["running_times", "others", "new_dates", "gaps", "pass_stops", "band_times"]) {
    const allowed = { running_times: RUNNING_TIMES, others: OTHERS, new_dates: NEW_DATES, gaps: GAPS, pass_stops: PASS_STOPS, band_times: BAND_TIMES }[k];
    if (given(p[k]) && !allowed.includes(String(p[k]))) ambiguities.push({ param: k, code: `${k}_invalid`, message: tr(lang, "build_timetable.value_invalid", { param: k, values: allowed.join(", ") }), options: allowed });
  }
  if (ambiguities.length) return { ambiguities, warnings };
  const routeId = route.value.id;
  const label = route.value.short_name || routeId;
  const mode = modes[0];

  // The departures (bands, times) or the trips (timetable) the order states.
  let deps = null;
  let sheet = null;
  let bandNotes = [];
  if (mode === "bands") {
    const first = timeOf(p.first);
    const last = timeOf(p.last);
    if (!given(p.first) || first == null) ambiguities.push({ param: "first", code: given(p.first) ? "time_invalid" : "first_missing", message: given(p.first) ? tr(lang, "resolve.time_invalid", { value: String(p.first) }) : tr(lang, "build_timetable.first_missing") });
    if (!given(p.last) || last == null) ambiguities.push({ param: "last", code: given(p.last) ? "time_invalid" : "last_missing", message: given(p.last) ? tr(lang, "resolve.time_invalid", { value: String(p.last) }) : tr(lang, "build_timetable.last_missing") });
    const bands = [];
    for (const [i, b] of (Array.isArray(p.bands) ? p.bands : []).entries()) {
      const from = timeOf(b?.from);
      const to = timeOf(b?.to);
      const hw = isNone(b?.headway_min) ? null : Number(String(b.headway_min).replace(",", "."));
      if (from == null || to == null || to <= from) ambiguities.push({ param: "bands", code: "band_invalid", message: tr(lang, "build_timetable.band_invalid", { n: i + 1, from: String(b?.from ?? "?"), to: String(b?.to ?? "?") }) });
      else if (hw != null && !(hw >= MIN_HEADWAY_MIN && hw <= MAX_HEADWAY_MIN)) ambiguities.push({ param: "bands", code: "band_headway_invalid", message: tr(lang, "build_timetable.band_headway_invalid", { n: i + 1, value: String(b.headway_min) }) });
      else bands.push({ from, to, headway: hw == null ? null : Math.round(hw * 60) });
    }
    if (!Array.isArray(p.bands) || !p.bands.length) ambiguities.push({ param: "bands", code: "bands_missing", message: tr(lang, "build_timetable.bands_missing") });
    if (!ambiguities.length && last < first) ambiguities.push({ param: "last", code: "last_before_first", message: tr(lang, "build_timetable.last_before_first", { first: hhmm(first), last: hhmm(last) }) });
    if (!ambiguities.length) {
      const series = bandSeries({ first, last, bands, gaps: p.gaps || null });
      if (series.overlap) ambiguities.push({ param: "bands", code: "bands_overlap", message: tr(lang, "build_timetable.bands_overlap", { a: `${hhmm(series.overlap[0].from)}–${hhmm(series.overlap[0].to)}`, b: `${hhmm(series.overlap[1].from)}–${hhmm(series.overlap[1].to)}` }) });
      // A departure between two bands: asked (the one answer offered is the next departure at the next band's start).
      else if (series.gap) ambiguities.push({ param: "gaps", code: "band_gap", message: tr(lang, "build_timetable.band_gap", { at: hhmm(series.gap.at), next: hhmm(series.gap.next) }), options: GAPS });
      else {
        deps = series.deps;
        bandNotes = series.notes;
      }
    }
  } else if (mode === "times") {
    const list = (Array.isArray(p.times) ? p.times : String(p.times).split(/[,;\s]+/)).filter(given);
    const secs = [];
    for (const x of list) {
      const s = timeOf(x);
      if (s == null) ambiguities.push({ param: "times", code: "time_invalid", message: tr(lang, "resolve.time_invalid", { value: String(x) }) });
      else secs.push(s);
    }
    deps = [...new Set(secs)].sort((a, b) => a - b);
  } else {
    const tt = p.timetable;
    const stopsRaw = Array.isArray(tt?.stops) ? tt.stops : null;
    const tripsRaw = Array.isArray(tt?.trips) ? tt.trips : null;
    // The bands the timetable states over trips it gives no time: a timetable of bands alone has no trip of its own.
    const hasBands = Array.isArray(tt?.bands) && tt.bands.length > 0;
    if (!stopsRaw || stopsRaw.length < 2 || !tripsRaw || (!tripsRaw.length && !hasBands) || tripsRaw.some((t) => !Array.isArray(t) || t.length !== stopsRaw.length)) ambiguities.push({ param: "timetable", code: "timetable_invalid", message: tr(lang, "build_timetable.timetable_invalid") });
    // The bounds first, before a stop is looked up or a trip read: a timetable of thousands of rows or columns is no
    // order, and each of its names would cost a pass over the feed's stops.
    else if (stopsRaw.length > MAX_TIMETABLE_STOPS) ambiguities.push({ param: "timetable", code: "too_many_stops", message: tr(lang, "build_timetable.too_many_stops", { count: stopsRaw.length, max: MAX_TIMETABLE_STOPS }) });
    else if (tripsRaw.length > MAX_TRIPS) ambiguities.push({ param: "timetable", code: "too_many_trips", message: tr(lang, "build_timetable.too_many_trips", { count: tripsRaw.length, max: MAX_TRIPS }) });
    else {
      const groups = [];
      for (const s of stopsRaw) {
        const g = stopIds(model, s, routeId, lang);
        // The grid's stop asked by its own name (`stop`, what the answer replaces in the grid), with the stops it may be.
        if (g.ambiguity) {
          const choices = stopChoices(model, s, routeId, direction);
          ambiguities.push({ param: "timetable", code: "timetable_stop", stop: String(s), message: tr(lang, "build_timetable.timetable_stop", { stop: String(s), why: g.ambiguity.message }), ...(choices.length ? { options: choices.map((c) => c.value), labels: Object.fromEntries(choices.map((c) => [c.value, c.label])) } : g.ambiguity.options ? { options: g.ambiguity.options } : {}) });
        }
        groups.push(g);
      }
      const trips = tripsRaw.map((row, i) => ({ n: i + 1, number: Array.isArray(tt.numbers) && given(tt.numbers[i]) ? String(tt.numbers[i]).slice(0, 30) : null, times: row.map((x) => (given(x) && !isPass(x) ? timeOf(x) : null)), passes: row.map(isPass) }));
      for (const t of trips) {
        const bad = tripsRaw[t.n - 1].findIndex((x, j) => given(x) && !isPass(x) && t.times[j] == null);
        if (bad >= 0) ambiguities.push({ param: "timetable", code: "time_invalid", message: tr(lang, "resolve.time_invalid", { value: String(tripsRaw[t.n - 1][bad]) }) });
        else if (t.times.filter((x) => x != null).length < 1) ambiguities.push({ param: "timetable", code: "trip_empty", message: tr(lang, "build_timetable.trip_empty", { n: t.n }) });
        else {
          const served = t.times.filter((x) => x != null);
          for (let j = 1; j < served.length; j++) if (served[j] < served[j - 1]) {
            ambiguities.push({ param: "timetable", code: "times_backwards", message: tr(lang, "build_timetable.times_backwards", { n: t.n }) });
            break;
          }
        }
      }
      // The bands over trips without times: their departures placed on each band's grid (band_times "grid") — the
      // order gives a headway, not the times, so the placing is asked unless said.
      if (hasBands) {
        const made = timetableBands(tt.bands, trips, stopsRaw.length);
        // A bound passed, an overlap, a window or a headway that is none: each said in its own words (bandQuestion).
        if (made.error) ambiguities.push(bandQuestion(made.error, lang));
        else {
          const count = made.facts.reduce((n, f) => n + f.count, 0);
          const detail = made.facts.filter((f) => f.count).map((f) => tr(lang, "build_timetable.band_detail", { minutes: Math.round(f.headway / 60), first: hhmm(f.first), last: hhmm(f.last) })).join(tr(lang, "common.semicolon"));
          const stops = [...new Set(made.facts.map((f) => String(stopsRaw[f.stop])))].join(tr(lang, "common.semicolon"));
          // Bands that place no departure (the timetable's own trips already hold their headway) ask nothing.
          if (count && p.band_times !== "grid") ambiguities.push({ param: "band_times", code: "band_times_missing", message: tr(lang, "build_timetable.band_times_missing", { count, stop: stops, detail }), options: BAND_TIMES });
          else if (count) warnings.push(tr(lang, "build_timetable.band_times_placed", { count, stop: stops, detail }));
          made.trips.forEach((m) => trips.push({ n: trips.length + 1, number: null, times: m.times, passes: m.passes, placed: true }));
          // Bands that place no departure over a timetable without trips: nothing to build.
          if (!trips.length) ambiguities.push({ param: "timetable", code: "timetable_invalid", message: tr(lang, "build_timetable.timetable_invalid") });
        }
      }
      // A desserte grid (timetable.untimed "served"): a stop without a time is served all the same (« oui »).
      sheet = { names: stopsRaw.map(String), groups, trips, untimedServed: tt.untimed === "served" };
    }
  }
  if (ambiguities.length) return { ambiguities, warnings };
  const nTrips = deps ? deps.length : sheet.trips.length;
  if (nTrips > MAX_TRIPS) return { ambiguities: [{ param: mode === "timetable" ? "timetable" : "bands", code: "too_many_trips", message: tr(lang, "build_timetable.too_many_trips", { count: nTrips, max: MAX_TRIPS }) }], warnings };

  // The stop the departures are read at.
  let at = null;
  if (mode !== "timetable" && given(p.at_stop)) {
    const g = stopIds(model, p.at_stop, routeId, lang);
    if (g.ambiguity) return { ambiguities: [{ param: "at_stop", ...g.ambiguity }], warnings };
    at = g;
  }

  // The direction's patterns, and which one(s) the new trips run.
  const keys = (model.routes.get(routeId).patterns || []).filter((x) => x.direction_id === direction).map((x) => x.key);
  if (!keys.length) return { ambiguities: [{ param: "direction", code: "no_pattern", message: tr(lang, "build_timetable.no_pattern", { line: label, direction }) }], warnings };
  let pool = keys;
  // A section of a route (patternByRef): its stops stand for the route's below; a grid names its own stops and is
  // built on whole routes only.
  let section = null;
  if (given(p.pattern)) {
    const r = patternByRef(model, keys, p.pattern, routeId, lang);
    if (r.ambiguity) return { ambiguities: [{ param: "pattern", ...r.ambiguity }], warnings };
    if (!r.keys.length || (r.section && mode === "timetable")) return { ambiguities: [{ param: "pattern", code: "pattern_none", message: tr(lang, "build_timetable.pattern_none", { pattern: String(p.pattern), line: label, direction }), options: labelsOf(model, keys) }], warnings };
    pool = r.keys;
    section = r.section || null;
  }
  const stopsOf = (k) => (section && k === section.k ? model.patterns.get(k).stops.slice(section.from, section.to + 1) : model.patterns.get(k).stops);
  if (at) pool = pool.filter((k) => stopsOf(k).some((s) => at.ids.has(s)));
  if (at && !pool.length) return { ambiguities: [{ param: "at_stop", code: "at_stop_not_served", message: tr(lang, "build_timetable.at_stop_not_served", { stop: at.name, direction }) }], warnings };

  let plan; // [{ key, ref (index in the pattern), times: [sec per pattern stop | null] | null, dep, number, own (a trip of the grid, not of its bands) }]
  let needRunning = false;
  if (mode === "timetable") {
    plan = [];
    const asked = new Map();
    for (const t of sheet.trips) {
      // The trip's stops: its timed ones — or, in a desserte grid, every stop it serves (a time placed by the running times).
      const idx = sheet.untimedServed ? t.passes.map((x, j) => (x ? -1 : j)).filter((j) => j >= 0) : t.times.map((x, j) => (x == null ? -1 : j)).filter((j) => j >= 0);
      const holding = pool.map((k) => ({ k, pos: matchInOrder(model.patterns.get(k).stops, idx.map((j) => sheet.groups[j].ids)) })).filter((c) => c.pos && c.pos[0] === 0 && c.pos[c.pos.length - 1] === model.patterns.get(c.k).stops.length - 1);
      const route = idx.map((j) => sheet.names[j]);
      const sig = `${route[0]} → ${route[route.length - 1]} (${route.length})`;
      // The stops the trip does not serve (« | »): a pattern calling at one of them is not the trip's.
      const passIdx = t.passes.map((x, j) => (x ? j : -1)).filter((j) => j >= 0);
      const passIds = new Set(passIdx.flatMap((j) => [...sheet.groups[j].ids]));
      let cands = passIds.size ? holding.filter((c) => !model.patterns.get(c.k).stops.some((x) => passIds.has(x))) : holding;
      if (holding.length && !cands.length) {
        if (p.pass_stops === "serve") cands = holding;
        else {
          const key = `${sig}|pass`;
          if (!asked.has(key)) asked.set(key, { param: "pass_stops", code: "pass_stop_served", message: tr(lang, "build_timetable.pass_stop_served", { n: t.n, stops: passIdx.map((j) => sheet.names[j]).join(tr(lang, "common.semicolon")), line: label, direction }), options: PASS_STOPS });
          continue;
        }
      }
      if (!cands.length) {
        // No choice of route can make the trip hold in one it does not follow: said, with no options.
        if (!asked.has(sig)) asked.set(sig, { param: "pattern", code: "timetable_no_pattern", message: tr(lang, "build_timetable.timetable_no_pattern", { n: t.n, from: route[0], to: route[route.length - 1], count: route.length, line: label, direction }) });
        continue;
      }
      if (cands.length > 1) {
        if (!asked.has(sig)) asked.set(sig, { param: "pattern", code: "pattern_choice", message: tr(lang, "build_timetable.pattern_choice_trip", { n: t.n, from: route[0], to: route[route.length - 1], count: cands.length }), options: labelsOf(model, cands.map((c) => c.k)) });
        continue;
      }
      const { k, pos } = cands[0];
      const n = model.patterns.get(k).stops.length;
      const times = new Array(n).fill(null);
      pos.forEach((pi, q) => (times[pi] = t.times[idx[q]]));
      if (times.some((x) => x == null)) needRunning = true;
      // Anchored at its first timed stop: in a desserte grid the first stop served may have no time (« oui »), and
      // a missing time read as a departure would be midnight (a wrong template, trip id and summary).
      const ref = times.findIndex((x) => x != null);
      plan.push({ key: k, ref, dep: times[ref], times, number: t.number, own: !t.placed });
    }
    if (asked.size) return { ambiguities: [...asked.values()], warnings };
  } else {
    if (pool.length > 1) return { ambiguities: [{ param: "pattern", code: "pattern_choice", message: tr(lang, "build_timetable.pattern_choice", { line: label, direction, count: pool.length, routes: labelsOf(model, pool).join(tr(lang, "common.semicolon")) }), options: [...labelsOf(model, pool), "main"] }], warnings };
    const key = pool[0];
    const stops = stopsOf(key);
    const cut = section && key === section.k ? { from: section.from, to: section.to } : null;
    // `ref` indexes the route's stops (the template's times): the section's offset is added to it.
    const ref = (at ? stops.findIndex((s) => at.ids.has(s)) : 0) + (cut ? cut.from : 0);
    plan = deps.map((d) => ({ key, ref, dep: d, times: null, number: null, ...(cut ? { section: cut } : {}) }));
    if (cut) warnings.push(tr(lang, "build_timetable.section", { count: plan.length, from: nameOf(model, stops[0]), to: nameOf(model, stops[stops.length - 1]), pattern: patternLabel(model, key, false), n: stops.length, total: model.patterns.get(key).stops.length }));
    needRunning = true;
  }
  if (needRunning && p.running_times !== "existing") {
    const missing = mode === "timetable" ? plan.filter((x) => x.times.some((y) => y == null)).length : plan.length;
    return { ambiguities: [{ param: "running_times", code: "running_times_missing", message: tr(lang, mode === "timetable" ? "build_timetable.running_times_partial" : "build_timetable.running_times_missing", { count: missing, line: label }), options: RUNNING_TIMES }], warnings };
  }

  // The dates: the scope's dates the direction runs (its day timetables), and those it runs nothing on.
  const lineTrips = tripsOfRoute(model, routeId).filter((t) => t.direction_id === direction);
  const holeDates = S.weekdayHole(model, [...new Set(lineTrips.map((t) => t.service_id))], scope);
  const hole = S.holidayWeekdaysStep(holeDates, scope, { line: label, lang });
  if (hole.ambiguity) return { ambiguities: [hole.ambiguity], warnings };
  if (hole.warning) warnings.push(hole.warning);
  const inScope = S.tripsInScope(model, { routeId, direction }, scope);
  const groups = S.dayGroups(model, inScope.map((t) => t.id), scope);
  const served = new Set(groups.flatMap((g) => g.dates));
  const runsAny = new Set();
  for (const t of lineTrips) for (const d of S.activeDates(model, t.service_id)) runsAny.add(d);
  const empty = [];
  if (model.range) for (let d = model.range.start, i = 0; d <= model.range.end && i < MAX_RANGE_DAYS; d = fm.addDays(d, 1), i++) if (S.inScope(scope, d) && !served.has(d) && !runsAny.has(d)) empty.push(d);
  // Of those dates, the ones on a weekday the direction runs on no date of the feed (the Sundays of a « daily » order
  // on a line that runs none): a day type new to it — the others (a public holiday) are exceptions of a day it runs.
  // Read on the whole feed, not the scope: a scope of one week would make its one holiday Wednesday a « new » day.
  const servedDows = new Set([...runsAny].map((d) => fm.dowOf(d)));
  const newDays = empty.filter((d) => !servedDows.has(fm.dowOf(d)));
  const holes = empty.filter((d) => servedDows.has(fm.dowOf(d)));
  // new_days means something only beside other dates: alone, the new days are all the dates (add).
  const mixed = newDays.length > 0 && holes.length > 0;
  if (empty.length && !p.new_dates) {
    const message = mixed
      ? tr(lang, "build_timetable.new_dates_missing_mixed", { line: label, direction, count: empty.length, dates: datesText(empty, lang), days: newDays.length })
      : tr(lang, "build_timetable.new_dates_missing", { line: label, direction, count: empty.length, dates: datesText(empty, lang) });
    return { ambiguities: [{ param: "new_dates", code: "new_dates_missing", message, options: mixed ? NEW_DATES : NEW_DATES.filter((x) => x !== "new_days") }], warnings };
  }
  const extra = p.new_dates === "add" ? empty : p.new_dates === "new_days" ? newDays : [];
  if (!served.size && !extra.length) return { ambiguities: [{ param: "days", code: "no_dates", message: tr(lang, "build_timetable.no_dates", { line: label, direction }) }], warnings };
  const left = p.new_dates === "skip" ? empty : p.new_dates === "new_days" ? holes : [];
  if (left.length) warnings.push(tr(lang, "build_timetable.new_dates_skipped", { count: left.length, dates: datesText(left, lang) }));
  if (extra.length) warnings.push(tr(lang, "build_timetable.new_dates_added", { count: extra.length, dates: datesText(extra, lang) }));

  // The other patterns the direction runs on those dates: replaced or kept, as the order says. The trips an earlier
  // operation of the plan made on another pattern (another grid of the line, from another origin) are the order's
  // own, never « other patterns »: spared, whatever the answer.
  const used = new Set(plan.map((x) => x.key));
  const made = ctx?.before?.trips ? (t) => !ctx.before.trips.has(t.id) : () => false;
  const spare = inScope.filter((t) => !used.has(t.pattern) && made(t)).map((t) => t.id);
  const spared = new Set(spare);
  const otherTrips = inScope.filter((t) => !used.has(t.pattern) && !spared.has(t.id));
  // A later grid of the same line, direction and day type: the other patterns are its to replace or keep — this one
  // replacing them would withdraw the next grid's own pattern. This grid withdraws its own patterns' trips only, said.
  const later = otherTrips.length ? laterGrids(model, p, ctx, routeId, direction) : [];
  if (otherTrips.length && later.length) warnings.push(tr(lang, "build_timetable.others_deferred", { count: otherTrips.length, operations: later.length > LATER_NAMED ? `${later.slice(0, LATER_NAMED).join(", ")}…` : later.join(", ") }));
  else if (otherTrips.length) {
    const routes = labelsOf(model, [...new Set(otherTrips.map((t) => t.pattern))]).join(tr(lang, "common.semicolon"));
    if (!p.others) return { ambiguities: [{ param: "others", code: "others_missing", message: tr(lang, "build_timetable.others_missing", { line: label, direction, count: otherTrips.length, routes }), options: OTHERS }], warnings };
    // Replaced: the step says which trips of other patterns go with the direction's (the figures of the answer).
    if (p.others === "replace") warnings.push(tr(lang, "build_timetable.others_replaced", { count: otherTrips.length, routes }));
  }
  // A section's trips are the order's own beside the route's (they run the whole route, the order states a part of
  // it): with others kept, nothing of the route is withdrawn.
  const withdrawPatterns = section && p.others !== "replace" ? new Set() : p.others === "keep" || later.length ? used : null;
  const value = { routeId, label, direction, scope, mode, plan, groups: groups.map((g) => ({ dates: g.dates, trips: g.trips })), extra, withdrawPatterns, spare, notes: bandNotes, at: at ? at.name : null };
  return { value, ambiguities: [], warnings };
};

// Dates as the reader writes them: 25/12/2026 in French, 2026-12-25 otherwise.
const datesText = (dates, lang) => {
  const iso = (d) => (String(lang || "").startsWith("fr") ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`);
  return dates.length <= 4 ? dates.map(iso).join(", ") : `${iso(dates[0])} … ${iso(dates[dates.length - 1])}`;
};

// ── apply ───────────────────────────────────────────────────────────────────

/** The template of a new trip: the pattern's trip nearest in time at the reference stop, among `pool` first. */
const templateOf = (model, x, pool) => {
  const near = (list) => list.slice().sort((a, b) => Math.abs((a.dep[x.ref] ?? a.first) - x.dep) - Math.abs((b.dep[x.ref] ?? b.first) - x.dep) || (a.id < b.id ? -1 : 1))[0] || null;
  return near(pool.filter((t) => t.pattern === x.key)) || near(model.patterns.get(x.key).trips.map((id) => model.trips.get(id)).filter(Boolean));
};

/**
 * The precision a line writes its stops at: to the second where more than 5 % of its own times carry seconds, else
 * to the minute: a minute timetable stays one. Read once per model and line.
 * Two precisions, on purpose. runtime.timePrecision is the one the feed publishes what a rider reads at — its
 * timing points and trip ends —, so a time the engine makes up (set_headway's series, a shifted trip, a new leg's
 * times) is written to it: often a whole minute. This one is how the line writes the stops between those, so the
 * stops build_timetable places between an order's times follow the line's own (to the second on a feed that
 * interpolates its stops between whole-minute timing points: rounded to the minute, they would put hundreds of
 * pairs of stops in one minute). The order's own times are written as it gives them, whichever.
 */
const SECONDS_SHARE = 0.05;
const lineStep = (model, routeId) =>
  memo(model, `line_step|${routeId}`, () => {
    let all = 0;
    let seconds = 0;
    for (const t of tripsOfRoute(model, routeId)) {
      for (const v of [...t.arr, ...t.dep]) {
        if (v == null) continue;
        all += 1;
        if (v % 60) seconds += 1;
      }
    }
    return all && seconds > all * SECONDS_SHARE ? 1 : 60;
  });

/**
 * The stop times of a timetable trip on its pattern, { arr, dep } in seconds per stop: the order's times where it
 * gives them, as written (arrival and departure alike); between two of them the template's profile scaled to the
 * order's interval, its dwells kept, each time rounded once to the line's `step` — and never two stops at the same
 * instant where the template runs between them while the interval leaves a step per such hop (rounding to the
 * minute on a line timed to the second would make hundreds of such hops in one run). A hop the template itself runs
 * in no time (two stops in the same minute of a minute timetable: up to a fifth of a line's hops) keeps none: forcing a step there
 * would push the next stops off the line's own times. Before the first and after the last, the template's own
 * running times (running_times "existing").
 */
const timesOnPattern = (x, tpl, precision = 1) => {
  const n = x.times.length;
  const arr = x.times.slice();
  const dep = x.times.slice();
  const known = x.times.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
  // Whole minutes only between the order's own whole minutes: an order timed to the second is placed to the second.
  const step = precision > 1 && known.every((i) => x.times[i] % precision === 0) ? precision : 1;
  // Whether the template runs the hop into stop i (it leaves the stop before earlier than it reaches this one).
  const runs = (i) => tpl.arr[i] > tpl.dep[i - 1];
  for (let q = 0; q < known.length - 1; q++) {
    const a = known[q];
    const b = known[q + 1];
    const ta = tpl.dep[a];
    const tb = tpl.arr[b];
    // A template time between the two, at the same share of the order's interval (evenly where the template takes none).
    const scaled = (v, i) => runtime.roundTo(x.times[a] + (tb > ta ? (v - ta) / (tb - ta) : (i - a) / (b - a)) * (x.times[b] - x.times[a]), step);
    // Each stop's arrival (after a hop the template runs: a step at least) then its departure (after its dwell).
    const events = [];
    for (let i = a + 1; i < b; i++) events.push({ i, run: true, gap: runs(i) ? step : 0, t: scaled(tpl.arr[i], i) }, { i, run: false, gap: 0, t: scaled(tpl.dep[i], i) });
    let hops = 0;
    for (let i = a + 1; i <= b; i++) if (runs(i)) hops += 1;
    if (x.times[b] - x.times[a] >= step * hops) {
      // Clamped forward from the earlier time of the order, then back from the later one: each hop the template runs
      // keeps its step, the others none.
      let prev = x.times[a];
      for (const e of events) {
        e.t = Math.max(e.t, prev + e.gap);
        prev = e.t;
      }
      let next = x.times[b];
      let gap = runs(b) ? step : 0;
      for (const e of [...events].reverse()) {
        e.t = Math.min(e.t, next - gap);
        next = e.t;
        gap = e.gap;
      }
    }
    for (const e of events) (e.run ? arr : dep)[e.i] = e.t;
  }
  const first = known[0];
  const last = known[known.length - 1];
  for (let i = first - 1; i >= 0; i--) {
    arr[i] = x.times[first] - (tpl.dep[first] - tpl.arr[i]);
    dep[i] = x.times[first] - (tpl.dep[first] - tpl.dep[i]);
  }
  for (let i = last + 1; i < n; i++) {
    arr[i] = x.times[last] + (tpl.arr[i] - tpl.arr[last]);
    dep[i] = x.times[last] + (tpl.dep[i] - tpl.arr[last]);
  }
  return { arr, dep };
};

const apply = (db, v, { model, lang } = {}) => {
  const warnings = [];
  const existing = new Map();
  for (const sid of model.services.keys()) existing.set(S.activeDates(model, sid).join(","), sid);
  // One plan per day timetable (its trips give the running times); identical plans share their trips.
  const groups = [...v.groups];
  if (v.extra.length) groups.push({ dates: v.extra, trips: [] });
  // The trips another grid of the plan made: never withdrawn here.
  const spare = new Set(v.spare || []);
  const plans = new Map();
  for (const g of groups) {
    const pool = g.trips.map((id) => model.trips.get(id)).filter(Boolean);
    const templates = v.plan.map((x) => templateOf(model, x, pool));
    const k = templates.map((t) => t?.id || "").join("|");
    if (!plans.has(k)) plans.set(k, { dates: [], templates, withdraw: [] });
    const pl = plans.get(k);
    pl.dates.push(...g.dates);
    pl.withdraw.push(...pool.filter((t) => !spare.has(t.id) && (!v.withdrawPatterns || v.withdrawPatterns.has(t.pattern))).map((t) => t.id));
    if (!pool.some((t) => v.plan.some((x) => x.key === t.pattern)) && pool.length) warnings.push(tr(lang, "build_timetable.template_elsewhere", { count: g.dates.length }));
  }
  // The order's trip numbers are what a rider reads (trip_short_name): written where the line's trips carry theirs —
  // on a line that never fills it they stay the order's, said (read before a trip of this step is written).
  const numbers = v.plan.some((x) => x.number);
  const numbered = numbers && Boolean(db.prepare("SELECT 1 FROM trips WHERE route_id = ? AND TRIM(COALESCE(trip_short_name, '')) <> '' LIMIT 1").get(v.routeId));
  if (numbers && !numbered) warnings.push(tr(lang, "build_timetable.numbers_not_written", { line: v.label }));
  let created = 0;
  const withdraw = new Map();
  const createdTimes = [];
  const step = lineStep(model, v.routeId);
  for (const pl of plans.values()) {
    const dates = [...new Set(pl.dates)].sort();
    const base = pl.templates.find(Boolean);
    const serviceId = S.serviceForDates(db, model, base.service_id, dates, { existing });
    v.plan.forEach((x, i) => {
      const tpl = pl.templates[i];
      const id = G.uniqueId(db, "trips", "trip_id", `${v.routeId}_${v.direction}_${serviceId}_${hhmm(x.dep).replace(":", "")}`);
      const shift = x.dep - (tpl.dep[x.ref] ?? tpl.first);
      G.cloneTrip(db, tpl.id, { newId: id, serviceId, shiftSec: x.times ? 0 : shift, patch: { block_id: null, trip_short_name: numbered ? x.number || null : null } });
      if (x.section) {
        // A section of the template's route: the rows outside it go, and with them the whole route's headsigns and shape.
        const rows = G.stopTimesOf(db, id).slice(x.section.from, x.section.to + 1).map((r) => ({ ...r, stop_headsign: null }));
        G.rewriteTrip(db, id, rows);
        db.prepare("UPDATE trips SET trip_headsign = ?, shape_id = NULL WHERE trip_id = ?").run(nameOf(model, rows[rows.length - 1].stop_id), id);
      }
      let start = x.dep;
      if (x.times) {
        const times = timesOnPattern(x, tpl, step);
        const rows = G.stopTimesOf(db, id).map((r, j) => ({ ...r, arr: times.arr[j], dep: times.dep[j] }));
        G.rewriteTrip(db, id, rows);
        start = times.dep[0];
      }
      created += 1;
      createdTimes.push(start);
    });
    for (const id of pl.withdraw) {
      if (!withdraw.has(id)) withdraw.set(id, new Set());
      dates.forEach((d) => withdraw.get(id).add(d));
    }
  }
  // What the step leaves to the operator's scheduling tool, never re-chained here: its new trips in no vehicle block,
  // the blocks its withdrawn trips leave with a hole — said, counted, and noted for the engine's own list.
  const chain = blocking.unchained(model, { routeId: v.routeId, label: v.label, created, withdrawn: withdraw, lang });
  if (chain.warning) warnings.push(chain.warning);
  const buckets = new Map();
  for (const [id, dates] of withdraw) {
    const k = [...dates].sort().join(",");
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(id);
  }
  // Withdrawn on those dates: a trip running other dates too keeps its id there (kept), the others go.
  let kept = 0;
  for (const [k, ids] of buckets) kept += S.withdrawOnDates(db, model, ids, k.split(",")).restricted;
  for (const n of v.notes || []) {
    if (n.code === "last_off_grid") warnings.push(tr(lang, "build_timetable.last_off_grid", { minutes: Math.round(n.gap / 60) }));
    if (n.code === "last_in_band_without_service") warnings.push(tr(lang, "build_timetable.last_in_band_without_service", { last: hhmm(n.at) }));
  }
  if (plans.size > 1) warnings.push(tr(lang, "build_timetable.series", { line: v.label, count: plans.size }));
  // A timetable's trips said from their first stop, as they were written (the order's times, the others placed).
  const deps = v.mode === "timetable" && createdTimes.length ? createdTimes : v.plan.map((x) => x.dep);
  // Where the trips go: the terminus of the first one's pattern (« vers Beaulieu »), said where a number would be.
  const head = v.plan.length ? model.patterns.get(v.plan[0].key) : null;
  const headStops = head ? (v.plan[0].section ? head.stops.slice(v.plan[0].section.from, v.plan[0].section.to + 1) : head.stops) : null;
  const towards = headStops ? nameOf(model, headStops[headStops.length - 1]) : String(v.direction);
  const words = { line: v.label, direction: v.direction, towards, scope: S.describeScope(v.scope, lang), trips: v.plan.length, first: hhmm(Math.min(...deps)), last: hhmm(Math.max(...deps)), created, withdrawn: withdraw.size, kept };
  return { summary: tr(lang, v.mode === "timetable" ? "build_timetable.summary_timetable" : "build_timetable.summary", words), warnings: [...new Set(warnings)], notes: chain.note ? [chain.note] : [], noop: created === 0 && withdraw.size === 0 };
};

module.exports = {
  type: "build_timetable",
  title: "Build a line's timetable from an offer order",
  category: "service",
  tables: ["trips", "stop_times", "calendar", "calendar_dates", "transfers"],
  description: "Build exactly the trips an offer order states for one line, one direction and one day type — the first and last departures and the headway by band, the departures, or a full timetable (stops × trips) — on the line's existing stop patterns, in place of the direction's trips on the scope's dates. Asks whatever the order does not say: which pattern, which running times (the existing ones only when the order says so), the dates the direction does not run yet, the other patterns.",
  params: [
    { name: "route", type: "route", required: true, description: "The line (short name, id or long name)." },
    { name: "direction", type: "direction", required: true, description: "0, 1 or a destination: one direction (an offer order states each direction)." },
    { name: "days", type: "days", required: true, description: "weekday | saturday | sunday | daily | mon…sun, or a list: the day type the order states." },
    ...S.SCOPE_PARAMS,
    { name: "first", type: "time", required: false, description: "First departure (HH:MM), with last and bands." },
    { name: "last", type: "time", required: false, description: "Last departure (HH:MM), always a departure." },
    { name: "bands", type: "object", required: false, description: "[{ from, to, headway_min }]: the headway by time band (to excluded; headway_min null or none: no departure in that band)." },
    { name: "times", type: "times", required: false, description: "The departures themselves (HH:MM), instead of bands." },
    { name: "timetable", type: "object", required: false, description: "{ stops: [names], trips: [[HH:MM, null or \"pass\" per stop]], numbers?: [trip numbers], bands?: [{ from, to, headway_min, stop: index of the stop the departures are read at, trips: [[null or \"pass\" per stop]] }] }: every trip of a full timetable, instead of bands (null: no time given, placed by the running times; \"pass\": the trip does not serve that stop); its own bands stand for trips it gives no time (a headway over a time window, read at one of its stops)." },
    { name: "at_stop", type: "stop", required: false, description: "The stop first, last, bands and times are read at (default: the pattern's first stop)." },
    { name: "pattern", type: "string", required: false, description: "The stop pattern the trips run: main, \"Origin → Terminus\" (with \"(n stops)\" when two share their ends) or a terminus. Asked when the direction runs several. \"A → B\" with A before B on one of the direction's routes, not its two ends, builds the trips on that section alone (a line cut in two at a closed stretch: its far half from a middle stop to the terminus), with the running times of that route's trips; departures and bands only, not a timetable." },
    { name: "running_times", type: "enum", enum: RUNNING_TIMES, required: false, description: "existing: each new trip runs like the pattern's trip nearest in time (the order rarely states running times). Asked unless a timetable gives a time at every stop." },
    { name: "others", type: "enum", enum: OTHERS, required: false, description: "The direction's trips of other patterns on those dates: replace (the order states the whole timetable) or keep. Asked when there are some (a desserte grid carries the answer replace, taken by the engine when asked to, and said)." },
    { name: "new_dates", type: "enum", enum: NEW_DATES, required: false, description: "Dates of the scope on which the direction runs nothing yet (a public holiday, a day type not run): add the timetable there, skip them, or new_days — only on the weekdays the direction runs on no date of the feed (a day type new to it), the others (a public holiday) left without service. Asked when there are some." },
    { name: "gaps", type: "enum", enum: GAPS, required: false, description: "A departure outside every band (the order states no headway there): band_start runs the next departure at the next band's start. Asked otherwise." },
    { name: "pass_stops", type: "enum", enum: PASS_STOPS, required: false, description: "A timetable trip marks stops it does not serve (\"pass\") and every stop pattern holding it calls there: serve runs it on such a pattern anyway, those stops given a time by the running times. Asked otherwise." },
    { name: "band_times", type: "enum", enum: BAND_TIMES, required: false, description: "Where the departures of a timetable's own bands are placed (the order gives a headway, not the times): grid runs one every headway from each band's start, before its end — none at the start when a departure already runs within a headway before it. Asked when the timetable has bands." },
  ],
  example: { route: "1", direction: "0", days: "weekday", first: "06:15", last: "19:15", bands: [{ from: "06:00", to: "09:00", headway_min: 30 }, { from: "09:00", to: "20:00", headway_min: 60 }], running_times: "existing" },
  resolve,
  apply,
  _internals: { bandSeries, timetableBands, stopChoices, wordsOf, placesOf, matchInOrder, timesOnPattern, lineStep, labelsOf, MAX_TRIPS, MAX_TIMETABLE_STOPS, MAX_TIMETABLE_BANDS, MAX_BAND_ROWS },
};
