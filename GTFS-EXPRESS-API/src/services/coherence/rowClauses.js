/**
 * coherence/rowClauses — « chaque ligne cochée devient une clause » (mission
 * step 7): the rows of the coherence report a person ticks at ④ (or single
 * measures of them) become clauses of the step-2 vocabulary, built by the
 * server from the report it computed itself on the version — never from a
 * value the browser sends: the request names rows by their key, nothing
 * else.
 *
 * A row is one line × direction × day type (× period) of the VERSION: the
 * session's feed for the network's report, the feed a previewed plan starts
 * from for a simulation's (its `before` side — the version the person
 * keeps; the simulation is not a version). Its measures are those of its
 * representative date; the clauses hold on every date that runs the same
 * timetable of that line (the dates of the row whose services of the line
 * are the representative date's), listed in the clause (`dates`, at most
 * 400: the checker's bound), so a clause is exactly what the row showed,
 * measured on the dates it showed it for — and never a guess about the
 * other timetables of the day type (school weeks with a Wednesday variant
 * are their own dates).
 *
 *   measure          clause (conformanceService)
 *   first, last      departure_at { line, stop: the trip's first stop, times: [HH:MM], towards: its last stop (unless
 *                    the trip has no later stop), direction } — the first (last) departure of the direction that day
 *   span             span { line, direction, first_before, last_after } — the first departure rounded up to the
 *                    minute, the last one down: no later, no earlier
 *   headway_peak     headway_max { line, direction, from, to, minutes } per band window (07–09, 16–19), the
 *   headway_offpeak  longest wait of the window as the checker reads it (the edges count), rounded up; off-peak
 *                    09–16 and 19:00 → the last departure; a window without any departure gives no clause
 *   trips            trips_count { line, direction, per: total, exactly } — the trips of the direction that day
 *   running_time     running_time { line, direction, from_stop, to_stop, min_minutes, max_minutes } — from the
 *                    first to the last stop of the direction's main pattern, on every trip running both
 *   keep             unchanged_except { lines: [line], direction } over every date of the row — « garder cette
 *                    ligne telle quelle »: compared with the feed before each next change. Only where a next
 *                    change HAS a feed before it (a network opened or applied, a simulation): a network designed
 *                    here (`keep: false`, the create journey) is measured on its design at the next build, with no
 *                    reference to compare with — the clause would be « not measurable » at every build, so it is
 *                    refused (keep_not_measurable) and the row's own figures are what keeps it.
 * Default measures: all but keep (asked on its own).
 *
 * Each clause carries its provenance — `source` (the report, the version and its date, the version's
 * fingerprint, the row: a short line) and `origin` ({ kind: "coherence_row", key, fingerprint, version, date,
 * figures }: the row's figures as the report showed them, for the screens that say where the clause comes
 * from) — never a `quote`: a quote is the words of the brief a clause comes from, and a report row is not a
 * brief. And the decision of the named person (decided_by "user", decision { by: { name }, at: the server's
 * clock, action: keep }).
 *
 * Every clause built is then MEASURED on the version it came from, by the conformance engine itself
 * (checkConformance on the feed's view, the version as its own baseline): one that does not pass is not
 * returned — it is listed in `refused` (self_check_failed, with what was measured). That would be a bug of
 * this module: the tests hold it at zero.
 *
 *   buildRowClauses({ model, report, picks, by, at, lang, version, keep }) →
 *     { clauses, refused: [{ key, measure, reason, measured? }], rows: [{ key, clauses: [id], dates, dates_total }] }
 *   picks: [{ key, measures? }] — `key` a row of `report` (rowKey), `measures` a subset of MEASURES
 *   keep: whether « garder telle quelle » can be measured at the next change (false for a network designed here)
 *   refusals (reason): no_service (the direction runs no trip on the row's timetable), line_absent (the line is
 *   not in the version — a line a plan adds), line_ambiguous (no name of the line finds it alone), no_trip
 *   (no trip runs the main pattern's ends), band_without_service (a band window without departure),
 *   keep_not_measurable (« garder telle quelle » on a network designed here), self_check_failed
 */

"use strict";

const conformance = require("../network/conformanceService");
const { specViewOfFeed } = require("../transform/feedView");
const { departures, tripsOfRoute } = require("../transform/feedModel");
const { stopKeys, indexIn } = require("../network/clauseTrips");
const { rowDatesOf } = require("./coherenceService");
const { wordsOf, say } = require("./sheetWords");

const MEASURES = ["first", "last", "span", "headway_peak", "headway_offpeak", "trips", "running_time", "keep"];
const DEFAULT_MEASURES = MEASURES.filter((m) => m !== "keep");
const MAX_DATES = 400;
const ORIGIN_KIND = "coherence_row";
const H = 3600;
const BANDS = { headway_peak: [[7 * H, 9 * H], [16 * H, 19 * H]], headway_offpeak: [[9 * H, 16 * H], [19 * H, null]] };

const pad = (n) => String(n).padStart(2, "0");
/** Seconds → "HH:MM" (GTFS's clock: 25:10 stays 25:10), rounded down or up to the minute. */
const hm = (sec, up = false) => {
  const m = up ? Math.ceil(sec / 60) : Math.floor(sec / 60);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
const isoOf = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
const ymdOf = (iso) => String(iso || "").replace(/-/g, "");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The longest wait of [from, to] on sorted departures, the edges counted (conformanceService.gapOf). */
const longestWait = (deps, from, to) => {
  const inWin = deps.filter((t) => t >= from && t <= to);
  if (!inWin.length) return null;
  const pts = [from, ...inWin, to];
  let gap = 0;
  for (let i = 1; i < pts.length; i++) gap = Math.max(gap, pts[i] - pts[i - 1]);
  return gap;
};

/** The services of a line running on a date: what makes two dates the same timetable of that line. */
const lineSignature = (model, routeId, date) => [...new Set(tripsOfRoute(model, routeId).filter((t) => model.runsOn(t.service_id, date)).map((t) => t.service_id))].sort().join(",");

/** The name of the line a clause gives: its number, else its id, else its long name — the first the checker finds alone. */
const lineRefOf = (view, route) => {
  for (const ref of [route.short_name, route.id, route.long_name]) {
    if (!ref) continue;
    const found = conformance._internals.findLine(view, ref);
    if (found && found.id === route.id) return ref;
  }
  return null;
};

/**
 * The clauses of the picked rows (see the header). `model`: the version's feed model; `report`: the report the
 * server computed on it (its rows and, out of sight, their dates); `by`: { name } (checked by the caller).
 */
const buildRowClauses = ({ model, report, picks = [], by, at = new Date().toISOString(), lang = "fr", version = {}, keep = true } = {}) => {
  const words = wordsOf(lang);
  const view = specViewOfFeed(model);
  const ctx = { spec: view };
  const compare = report.mode === "compare";
  const allDates = rowDatesOf(report) || new Map();
  const fingerprint = report.version?.fingerprint || "";
  const versionText = version.label ? (version.date ? say(words, "source.version", { label: version.label, date: version.date }) : version.label) : report.computed_at?.slice(0, 10) || "";
  const built = [];
  const refused = [];
  const rows = [];
  const decision = { by: { name: by.name.trim() }, at, action: "keep" };

  for (const pick of picks) {
    const row = report.rows.find((r) => r.key === pick.key);
    const measures = (Array.isArray(pick.measures) && pick.measures.length ? pick.measures : DEFAULT_MEASURES).filter((m) => MEASURES.includes(m));
    const refuse = (measure, reason, extra = {}) => refused.push({ key: pick.key, measure, reason, ...extra });
    const route = model.routes.get(row.route_id);
    const dir = String(row.direction_id);
    const rowDates = (allDates.get(row.key) || []).slice().sort();
    const own = { key: row.key, clauses: [], dates: 0, dates_total: rowDates.length };
    rows.push(own);
    if (!route) {
      for (const m of measures) refuse(m, "line_absent");
      continue;
    }
    const lineRef = lineRefOf(view, route);
    if (!lineRef) {
      for (const m of measures) refuse(m, "line_ambiguous");
      continue;
    }
    const lineObj = conformance._internals.findLine(view, lineRef);
    // The version's measures of the row: its own (a network), its `before` (a simulation starts from the version).
    const seen = compare ? row.before || {} : row;
    const rep = ymdOf(row.date);
    const sig = lineSignature(model, route.id, rep);
    const same = rowDates.filter((d) => d === rep || lineSignature(model, route.id, d) === sig);
    const dates = same.slice(0, MAX_DATES);
    own.dates = dates.length;
    const label = lineRef;
    const towardsName = row.direction_name || `${dir}`;
    const direction = `→ ${towardsName}`;
    const scopeOf = (list) => say(words, "scope", { dayType: say(words, `dayType.${row.day_type}`), days: list.length, from: list.length ? isoOf(list[0]) : "—", to: list.length ? isoOf(list[list.length - 1]) : "—" });
    const source = clip(say(words, "source", { version: versionText, fp: fingerprint.slice(0, 12), line: label, direction, dayType: say(words, `dayType.${row.day_type}`) + (row.period ? ` ${row.period.name === "rest" ? say(words, "period.restShort") : row.period.from}` : "") }), 120);
    // Where the clause comes from, for the screens that say it (never a `quote`: a row of a report is not the brief).
    const origin = {
      kind: ORIGIN_KIND,
      key: row.key,
      fingerprint,
      version: version.label || null,
      date: version.date || (report.computed_at ? String(report.computed_at).slice(0, 10) : null),
      figures: clip(say(words, "figures", { line: label, direction, dayType: say(words, `dayType.${row.day_type}`), days: dates.length, date: row.date, first: seen.first_departure || "—", last: seen.last_departure || "—", peak: seen.headway?.peak ?? "—", offpeak: seen.headway?.offpeak ?? "—", trips: seen.trips ?? 0, run: seen.running_time ? `${seen.running_time.min}–${seen.running_time.max} min` : "—" }), 400),
    };
    const add = (measure, kind, params, textKey, textParams, list = dates) => {
      const c = conformance.normalizeClause({ kind, level: "must", status: "confirmed", decided_by: "user", decision, params: { ...params, dates: list.map(isoOf) }, source });
      c.text = clip(say(words, textKey, { line: label, direction, scope: scopeOf(list), ...textParams }), 200);
      c.origin = { ...origin };
      built.push({ clause: c, key: row.key, measure });
      own.clauses.push(c.id);
    };

    // « Garder telle quelle » needs a feed before the next change to compare with: none on a network designed here.
    if (measures.includes("keep")) {
      if (keep) add("keep", "unchanged_except", { lines: [lineRef], direction: dir }, "text.keep", {}, rowDates.slice(0, MAX_DATES));
      else refuse("keep", "keep_not_measurable");
    }
    const timed = measures.filter((m) => m !== "keep");
    if (!timed.length) continue;
    const trips = view.tripsOnDate(route.id, rep).filter((t) => String(t.direction) === dir);
    if (!trips.length) {
      for (const m of timed) refuse(m, "no_service");
      continue;
    }

    for (const which of ["first", "last"]) {
      if (!timed.includes(which)) continue;
      const withStart = trips.filter((t) => t.dep.some((x) => x != null));
      const t = withStart.reduce((best, x) => (!best || (which === "first" ? x.first < best.first : x.first > best.first) ? x : best), null);
      const i0 = t.dep.findIndex((x) => x != null);
      const stop = t.names[i0];
      // Towards its last stop — when the checker finds that stop after this one (a trip of a single stop, as some
      // feeds carry, goes towards nothing: the clause then names the stop and the time only).
      const last = t.names[t.names.length - 1];
      const T = stopKeys(ctx, last);
      const towards = T && indexIn(t, T.keys, i0 + 1) >= 0 ? { towards: last } : {};
      add(which, "departure_at", { line: lineRef, stop, times: [hm(t.dep[i0])], ...towards, direction: dir }, which === "first" ? "text.first" : "text.last", { time: hm(t.dep[i0]), stop });
    }

    if (timed.includes("span")) {
      const deps = departures(model, route.id, rep, { at: "first" }).get(dir) || [];
      if (!deps.length) refuse("span", "no_service");
      else add("span", "span", { line: lineRef, direction: dir, first_before: hm(deps[0], true), last_after: hm(deps[deps.length - 1]) }, "text.span", { first: hm(deps[0], true), last: hm(deps[deps.length - 1]) });
    }

    for (const band of ["headway_peak", "headway_offpeak"]) {
      if (!timed.includes(band)) continue;
      const deps = departures(model, route.id, rep, { at: "reference" }).get(dir) || [];
      for (const [from, end] of BANDS[band]) {
        const to = end == null ? Math.floor((deps[deps.length - 1] ?? 0) / 60) * 60 : end;
        if (!(to > from)) continue;
        const gap = longestWait(deps, from, to);
        if (gap == null) {
          refuse(band, "band_without_service", { window: `${hm(from)}–${hm(to)}` });
          continue;
        }
        const minutes = Math.max(1, Math.ceil(gap / 60));
        add(band, "headway_max", { line: lineRef, direction: dir, from: hm(from), to: hm(to), minutes }, "text.headway", { minutes, from: hm(from), to: hm(to) });
      }
    }

    if (timed.includes("trips")) {
      // As the checker counts them: the direction's trips whose first stop has a departure time.
      const n = trips.filter((t) => t.dep[0] != null).length;
      add("trips", "trips_count", { line: lineRef, direction: dir, per: "total", exactly: n }, "text.trips", { n });
    }

    if (timed.includes("running_time")) {
      // The direction's main pattern (most trips), from its first stop to its last, on every trip running both.
      const count = new Map();
      for (const t of trips) count.set(t.keys.join(">"), (count.get(t.keys.join(">")) || 0) + 1);
      const main = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      const sample = trips.find((t) => t.keys.join(">") === main);
      const from = sample.names[0];
      const to = sample.names[sample.names.length - 1];
      const A = stopKeys(ctx, from);
      const B = stopKeys(ctx, to);
      const runs = [];
      for (const t of trips) {
        if (!A || !B) break;
        const i = indexIn(t, A.keys);
        const j = i < 0 ? -1 : indexIn(t, B.keys, i + 1);
        if (j < 0 || t.dep[i] == null || t.arr[j] == null) continue;
        runs.push(Math.round((t.arr[j] - t.dep[i]) / 60));
      }
      if (!runs.length || sample.names.length < 2) refuse("running_time", "no_trip");
      else add("running_time", "running_time", { line: lineRef, direction: dir, from_stop: from, to_stop: to, min_minutes: Math.min(...runs), max_minutes: Math.max(...runs) }, "text.running", { from, to, min: Math.min(...runs), max: Math.max(...runs) });
    }
  }

  // Every clause measured on the version it came from, by the engine itself: one that fails there is not returned.
  const unique = new Map();
  for (const b of built) if (!unique.has(b.clause.id)) unique.set(b.clause.id, b);
  const list = [...unique.values()];
  const checked = list.length ? conformance.checkConformance(view, { clauses: list.map((b) => b.clause) }, { stopsAuthority: "feed", baseline: { spec: view, model, self: true } }) : null;
  const status = new Map((checked?.results || []).map((r) => [r.id, r]));
  const clauses = [];
  for (const b of list) {
    const r = status.get(b.clause.id);
    if (r && r.status === "pass") clauses.push(b.clause);
    else {
      refused.push({ key: b.key, measure: b.measure, reason: "self_check_failed", measured: r ? `${r.status}: ${r.measured || r.note || ""}`.slice(0, 300) : "not measured" });
      for (const row of rows) row.clauses = row.clauses.filter((id) => id !== b.clause.id);
    }
  }
  for (const row of rows) row.clauses = [...new Set(row.clauses)];
  return { clauses, refused, rows };
};

module.exports = { buildRowClauses, MEASURES, DEFAULT_MEASURES, MAX_DATES, ORIGIN_KIND, _internals: { longestWait, lineSignature, lineRefOf, hm } };
