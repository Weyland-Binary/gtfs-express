/**
 * eval/transform/cases.js — golden briefs for the change planner, on a REAL
 * feed: libéA Urbain, Albi (GTFS-EXPRESS-API/src/__tests__/fixtures/real,
 * ODbL). Each case is what an authority writes in a service-change notice,
 * the ORACLE (checks measured on the resulting feed — any correct plan
 * passes, whatever operations it uses), a REFERENCE plan that meets it, and
 * MUTANTS: plausible wrong plans the oracle must reject.
 *
 * Level 0 (CI, no tokens — src/__tests__/transformGolden.test.js): the
 *   reference passes every check, each mutant fails at least one, previews
 *   are unblocked with integrity intact. Cases whose operators are not in
 *   the catalogue yet (`requires`) are skipped there.
 * Level 1 (eval/transform/run.mjs, real tokens): the planner reads each
 *   brief on the Albi feed; the oracle scores what it delivered.
 *
 * CommonJS so both Jest and the ESM runner can load it.
 */

"use strict";

// ── Measures on feed models (feedModel.buildFeedModel) ─────────────────────

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];

const lib = (fm, S) => {
  const hhmm = (s) => (s == null ? null : fm._internals.secToTime(s).slice(0, 5));
  /** Dates (of the validity) on which a route runs, whose day type is in dows, within [from, to]. */
  const datesOf = (model, routeId, dows, { from = null, to = null } = {}) => {
    const out = new Set();
    const svcs = new Set([...model.trips.values()].filter((t) => t.route_id === routeId).map((t) => t.service_id));
    for (const sid of svcs) for (const d of S.activeDates(model, sid)) if (dows.includes(S.dayTypeOf(model, sid, d)) && (!from || d >= from) && (!to || d <= to)) out.add(d);
    return [...out].sort();
  };
  const every = (list, n) => list.filter((_, i) => i % n === 0);
  const depsAt = (model, routeId, date) => fm.departures(model, routeId, date, { at: "first" });
  const sameDay = (before, after, routeId, date) => {
    const a = depsAt(before, routeId, date);
    const b = depsAt(after, routeId, date);
    const key = (m) => JSON.stringify([...m.entries()].sort());
    return key(a) === key(b);
  };
  /** Max gap between departures in [from, to) of each direction, and the first one. */
  const windowGaps = (model, routeId, date, from, to) => {
    const out = {};
    for (const [dir, times] of depsAt(model, routeId, date)) {
      const w = times.filter((x) => x >= from && x < to);
      let inner = 0;
      for (let i = 1; i < w.length; i++) inner = Math.max(inner, w[i] - w[i - 1]);
      out[dir] = { n: w.length, innerMaxGap: w.length >= 2 ? inner : null, first: w[0] ?? null, last: w[w.length - 1] ?? null };
    }
    return out;
  };
  const stopNamesOf = (model, routeId) => new Set([...model.patterns.values()].filter((p) => p.route_id === routeId).flatMap((p) => p.stops.map((s) => model.stops.get(s)?.name)));
  /** Routes whose timetable or stops differ between the two models (semantic diff). */
  const changedRoutes = (before, after) => {
    const { semanticDiff } = require("../../GTFS-EXPRESS-API/src/services/transform/semanticDiff");
    return new Set(semanticDiff(before, after).routes.filter((r) => r.status !== "same").map((r) => r.id));
  };
  const onlyChanged = (before, after, allowed) => {
    const extra = [...changedRoutes(before, after)].filter((r) => !allowed.includes(r));
    return { ok: extra.length === 0, detail: extra.length ? `other lines changed: ${extra.join(", ")}` : "no other line changed" };
  };
  /** The trips of a route running on a date. */
  const tripsOn = (model, routeId, date) => [...model.trips.values()].filter((t) => t.route_id === routeId && model.runsOn(t.service_id, date));
  /** Every passing of a route's trips on a date, "dir|stop name|time", sorted (a multiset), leaving out the stops named in skip. */
  const passings = (model, routeId, date, skip = []) => {
    const out = [];
    for (const t of tripsOn(model, routeId, date)) t.stops.forEach((s, i) => {
      const name = model.stops.get(s)?.name;
      if (!skip.includes(name)) out.push(`${t.direction_id}|${name}|${t.dep[i]}`);
    });
    return out.sort();
  };
  /** The entries of multiset a missing from multiset b. */
  const missing = (a, b) => {
    const left = new Map();
    for (const x of b) left.set(x, (left.get(x) || 0) + 1);
    const out = [];
    for (const x of a) {
      if (left.get(x)) left.set(x, left.get(x) - 1);
      else out.push(x);
    }
    return out;
  };
  /** A sample of a date list that always keeps its first and last dates. */
  const pick = (list, n = 6) => (list.length <= n ? list : [...new Set([list[0], ...list.filter((_, i) => i % Math.ceil(list.length / n) === 0), list[list.length - 1]])]);
  const nameAt = (model, t, i) => model.stops.get(t.stops[i < 0 ? t.stops.length + i : i])?.name;
  return { hhmm, datesOf, every, depsAt, sameDay, windowGaps, stopNamesOf, changedRoutes, onlyChanged, tripsOn, passings, missing, pick, nameAt };
};

const T = (h, m = 0) => h * 3600 + m * 60;
const [A, B, C, D, E, F, G, R, H, J] = ["113", "114", "112", "117", "118", "115", "141", "116", "124", "121"];

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const dowOf = (ymd) => DOW[new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay()];
/** The calendar dates from → to (YYYYMMDD) whose weekday is in dows. */
const between = (from, to, dows) => {
  const out = [];
  for (let t = Date.UTC(+from.slice(0, 4), +from.slice(4, 6) - 1, +from.slice(6, 8)); ; t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
    if (d > to) return out;
    if (dows.includes(dowOf(d))) out.push(d);
  }
};
/** The routes run the same departures on a sample of the dates. */
const sameOn = (L, before, after, routes, dates, n = 6) => {
  const bad = [];
  for (const d of L.pick(dates, n)) for (const r of routes) if (!L.sameDay(before, after, r, d)) bad.push(`${r} ${d}`);
  return { ok: !bad.length, detail: bad.length ? `changed: ${bad.slice(0, 4).join(", ")}` : `${Math.min(dates.length, n + 2)} date(s) unchanged` };
};
/** Weekdays of a route that are not the feed's school-holiday weekdays. */
const schoolWeekdays = (model, L, routeId, opts = {}) => {
  const hol = new Set(holidayWeekdays(model, L));
  return L.datesOf(model, routeId, WEEKDAYS, opts).filter((d) => !hol.has(d));
};

// ── The cases ───────────────────────────────────────────────────────────────
//
// Albi route ids: A 113, B 114, C 112, D 117, E 118, F 115, G 141, H 124, J 121, R 116.

const CASES = [
  {
    id: "headway_from_date",
    title: "A frequency increase from an effective date",
    brief: "Ligne A : à partir du lundi 2 novembre 2026, un bus toutes les 10 minutes entre 7h et 9h, du lundi au vendredi, dans les deux sens.",
    answers: { patterns: "main", direction: "both" },
    reference: { title: "Ligne A renforcée le matin", operations: [{ id: "op1", type: "set_headway", params: { route: "A", days: "weekday", from_date: "2026-11-02", from: "07:00", to: "09:00", headway_min: 10 }, source: { quote: "à partir du lundi 2 novembre 2026, un bus toutes les 10 minutes entre 7h et 9h" } }] },
    checks: (L) => [
      {
        id: "every_10_min_after_2_nov",
        run: (before, after) => {
          const bad = [];
          for (const d of L.every(L.datesOf(after, "113", WEEKDAYS, { from: "20261102" }), 6)) {
            for (const [dir, g] of Object.entries(L.windowGaps(after, "113", d, T(7), T(9)))) {
              // The series may start at the first departure the line had in the window (kept).
              if (g.n < 9 || g.innerMaxGap == null || g.innerMaxGap > 10 * 60 || g.last < T(8, 45)) bad.push(`${d} dir ${dir}: ${g.n} departures, max gap ${g.innerMaxGap / 60} min`);
            }
          }
          return { ok: !bad.length, detail: bad.slice(0, 3).join("; ") || "every ≤ 10 min on every weekday checked" };
        },
      },
      {
        id: "unchanged_before_2_nov",
        run: (before, after) => {
          const bad = L.datesOf(before, "113", WEEKDAYS, { to: "20261101" }).filter((d) => !L.sameDay(before, after, "113", d));
          return { ok: !bad.length, detail: bad.length ? `changed before the effective date: ${bad.slice(0, 3).join(", ")}` : "October unchanged" };
        },
      },
      { id: "saturdays_unchanged", run: (before, after) => ({ ok: L.every(L.datesOf(before, "113", ["sat"]), 4).every((d) => L.sameDay(before, after, "113", d)), detail: "Saturdays" }) },
      { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, ["113"]) },
    ],
    mutants: [
      { id: "no_effective_date", plan: { operations: [{ id: "m", type: "set_headway", params: { route: "A", days: "weekday", from: "07:00", to: "09:00", headway_min: 10 } }] } },
      { id: "every_15", plan: { operations: [{ id: "m", type: "set_headway", params: { route: "A", days: "weekday", from_date: "2026-11-02", from: "07:00", to: "09:00", headway_min: 15 } }] } },
      { id: "wrong_line", plan: { operations: [{ id: "m", type: "set_headway", params: { route: "C", days: "weekday", from_date: "2026-11-02", from: "07:00", to: "09:00", headway_min: 10 } }] } },
    ],
  },
  {
    id: "stop_both_sides",
    title: "A stop no longer served (both sides of the road)",
    brief: "La ligne H ne dessert plus l'arrêt Rayssac, dans les deux sens. Les horaires des autres arrêts sont inchangés.",
    reference: { title: "Rayssac non desservi par H", operations: [{ id: "op1", type: "remove_stop", params: { route: "H", stop: "Rayssac" }, source: { quote: "La ligne H ne dessert plus l'arrêt Rayssac" } }] },
    checks: (L) => [
      { id: "rayssac_not_served_by_H", run: (before, after) => ({ ok: !L.stopNamesOf(after, "124").has("Rayssac"), detail: "H patterns" }) },
      {
        id: "other_stops_keep_times",
        run: (before, after) => {
          const bad = [];
          for (const t of [...before.trips.values()].filter((x) => x.route_id === "124")) {
            const n = after.trips.get(t.id);
            if (!n) continue;
            const keep = (tr) => tr.stops.map((s, i) => [after.stops.get(s)?.name || before.stops.get(s)?.name, tr.dep[i]]).filter(([name]) => name !== "Rayssac");
            if (JSON.stringify(keep(t)) !== JSON.stringify(keep(n))) bad.push(t.id);
          }
          return { ok: !bad.length, detail: bad.length ? `times moved on ${bad.length} trip(s)` : "times kept" };
        },
      },
      { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, ["124"]) },
    ],
    mutants: [
      { id: "one_side_only", plan: { operations: [{ id: "m", type: "remove_stop", params: { route: "H", stop: "Rayssac", direction: "0" } }] } },
      { id: "times_shifted", plan: { operations: [{ id: "m", type: "remove_stop", params: { route: "H", stop: "Rayssac", mode: "shift" } }] } },
    ],
  },
  {
    id: "new_stop_both_ways",
    title: "A new stop on a line, both directions",
    brief: "Création d'un nouvel arrêt « Clinique Claude Bernard » (43.94230, 2.15225), entre Majesté et Provence, desservi par la ligne C dans les deux sens.",
    reference: { title: "Nouvel arrêt Clinique Claude Bernard sur C", operations: [{ id: "op1", type: "add_stop", params: { route: "C", stop: { name: "Clinique Claude Bernard", lat: 43.9423, lon: 2.15225 }, after: "Majesté", before: "Provence" }, source: { quote: "nouvel arrêt « Clinique Claude Bernard » … desservi par la ligne C dans les deux sens" } }] },
    checks: (L) => [
      {
        id: "served_both_directions",
        run: (before, after) => {
          const dirs = new Set([...after.patterns.values()].filter((p) => p.route_id === "112" && p.stops.some((s) => after.stops.get(s)?.name === "Clinique Claude Bernard")).map((p) => p.direction_id));
          return { ok: dirs.has("0") && dirs.has("1"), detail: `directions ${[...dirs].join(",") || "none"}` };
        },
      },
      {
        // Direction 0 passes Majesté then Provence; the return runs a one-way
        // street that skips Provence: there the stop sits next to Majesté.
        id: "between_majeste_and_provence",
        run: (before, after) => {
          const bad = [];
          for (const p of [...after.patterns.values()].filter((x) => x.route_id === "112")) {
            const names = p.stops.map((s) => after.stops.get(s)?.name);
            const i = names.indexOf("Clinique Claude Bernard");
            if (i < 0) continue;
            const around = [names[i - 1], names[i + 1]];
            const ok = p.direction_id === "0" ? around.join("|") === "Majesté|Provence" : around.includes("Majesté");
            if (!ok) bad.push(`dir ${p.direction_id}: between ${around[0]} and ${around[1]}`);
          }
          return { ok: !bad.length, detail: bad.join("; ") || "placed between Majesté and Provence (next to Majesté on the return)" };
        },
      },
      {
        id: "located",
        run: (before, after) => {
          const s = [...after.stops.values()].find((x) => x.name === "Clinique Claude Bernard");
          const d = s ? Math.hypot((s.lat - 43.9423) * 111320, (s.lon - 2.15225) * 80000) : Infinity;
          return { ok: d < 60, detail: s ? `${Math.round(d)} m from the given point` : "no such stop" };
        },
      },
      {
        id: "running_time_plausible",
        run: (before, after) => {
          const wd = before.representative.tue;
          const r0 = require("../../GTFS-EXPRESS-API/src/services/transform/feedModel").routeStats(before, "112", wd);
          const r1 = require("../../GTFS-EXPRESS-API/src/services/transform/feedModel").routeStats(after, "112", wd);
          const deltas = Object.keys(r0.directions).map((d) => (r1.directions[d]?.running_min ?? 0) - (r0.directions[d]?.running_min ?? 0));
          return { ok: deltas.every((x) => x >= 0 && x <= 3), detail: `running time +${deltas.join(" / +")} min` };
        },
      },
      { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, ["112"]) },
    ],
    mutants: [
      { id: "one_direction", plan: { operations: [{ id: "m", type: "add_stop", params: { route: "C", direction: "0", stop: { name: "Clinique Claude Bernard", lat: 43.9423, lon: 2.15225 } } }] } },
      { id: "wrong_line", plan: { operations: [{ id: "m", type: "add_stop", params: { route: "B", stop: { name: "Clinique Claude Bernard", lat: 43.9423, lon: 2.15225 } } }] } },
    ],
  },
  {
    id: "withdraw_one_trip",
    title: "One departure withdrawn on some days",
    requires: ["remove_trips"],
    brief: "Ligne J : la course de 13h27 au départ de Cantepau est supprimée (lundi, mardi, jeudi et vendredi).",
    reference: { title: "J : suppression de la course de 13h27", operations: [{ id: "op1", type: "remove_trips", params: { route: "J", direction: "0", days: ["mon", "tue", "thu", "fri"], times: ["13:27"] }, source: { quote: "la course de 13h27 au départ de Cantepau est supprimée" } }] },
    checks: (L) => [
      {
        id: "no_1327_from_cantepau",
        run: (before, after) => {
          const left = L.datesOf(after, "121", ["mon", "tue", "thu", "fri"]).filter((d) => (L.depsAt(after, "121", d).get("0") || []).includes(T(13, 27)));
          return { ok: !left.length, detail: left.length ? `still on ${left.slice(0, 3).join(", ")}` : "gone" };
        },
      },
      {
        id: "other_J_trips_kept",
        run: (before, after) => {
          const d = L.datesOf(before, "121", ["tue"])[5];
          const a = (L.depsAt(before, "121", d).get("0") || []).filter((x) => x !== T(13, 27));
          const b = L.depsAt(after, "121", d).get("0") || [];
          return { ok: JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(L.depsAt(before, "121", d).get("1")) === JSON.stringify(L.depsAt(after, "121", d).get("1")), detail: `J on ${d}` };
        },
      },
      { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, ["121"]) },
    ],
    mutants: [{ id: "wrong_time", plan: { operations: [{ id: "m", type: "remove_trips", params: { route: "J", direction: "0", days: ["mon", "tue", "thu", "fri"], times: ["07:40"] } }] } }],
  },
  {
    id: "holidays_like_saturday",
    title: "A line runs its Saturday timetable during the school holidays",
    requires: ["run_like"],
    brief: "Pendant les vacances scolaires (zone C), la ligne E circule en semaine selon ses horaires du samedi.",
    answers: { region: "C" },
    reference: { title: "E : horaires du samedi pendant les vacances", calendars: { vacances: { dates: "__HOLIDAY_WEEKDAYS__" } }, operations: [{ id: "op1", type: "run_like", params: { routes: ["E"], like: "saturday", days: "weekday", period: "vacances" }, source: { quote: "Pendant les vacances scolaires (zone C), la ligne E circule en semaine selon ses horaires du samedi" } }] },
    checks: (L) => [
      {
        id: "holiday_weekdays_like_saturday",
        run: (before, after) => {
          const sat = before.representative.sat;
          const ref = JSON.stringify([...L.depsAt(before, "118", sat).entries()].sort());
          const hol = holidayWeekdays(before, L).slice(0, 12);
          const bad = hol.filter((d) => JSON.stringify([...L.depsAt(after, "118", d).entries()].sort()) !== ref);
          return { ok: hol.length > 0 && !bad.length, detail: bad.length ? `not the Saturday timetable on ${bad.slice(0, 3).join(", ")}` : `${hol.length} holiday weekdays checked` };
        },
      },
      {
        id: "school_weekdays_unchanged",
        run: (before, after) => {
          const hol = new Set(holidayWeekdays(before, L));
          const bad = L.every(L.datesOf(before, "118", WEEKDAYS).filter((d) => !hol.has(d)), 7).filter((d) => !L.sameDay(before, after, "118", d));
          return { ok: !bad.length, detail: bad.length ? `changed on ${bad.slice(0, 3).join(", ")}` : "school days unchanged" };
        },
      },
      { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, ["118"]) },
    ],
    mutants: [],
  },
  {
    id: "line_ends_on_date",
    title: "A line withdrawn from a date",
    requires: ["discontinue_route"],
    brief: "La ligne J est supprimée à compter du lundi 4 janvier 2027.",
    reference: { title: "Fin de la ligne J", operations: [{ id: "op1", type: "discontinue_route", params: { route: "J", from_date: "2027-01-04" }, source: { quote: "La ligne J est supprimée à compter du lundi 4 janvier 2027" } }] },
    checks: (L) => [
      { id: "no_J_from_4_jan", run: (before, after) => ({ ok: L.datesOf(after, "121", [...WEEKDAYS, "sat", "sun"], { from: "20270104" }).length === 0, detail: "J after 3 Jan" }) },
      { id: "J_unchanged_before", run: (before, after) => ({ ok: L.every(L.datesOf(before, "121", WEEKDAYS, { to: "20270103" }), 5).every((d) => L.sameDay(before, after, "121", d)), detail: "J before" }) },
      { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, ["121"]) },
    ],
    mutants: [{ id: "removed_now", plan: { operations: [{ id: "m", type: "discontinue_route", params: { route: "J" } }] } }],
  },
  {
    id: "earlier_saturday_start",
    title: "An earlier first departure on Saturdays",
    requires: ["set_span"],
    brief: "Le samedi, la ligne C commence plus tôt : premier départ à 6h30 de chaque terminus, puis toutes les 30 minutes jusqu'au premier départ actuel.",
    reference: { title: "C : premier départ à 6h30 le samedi", operations: [{ id: "op1", type: "set_span", params: { route: "C", days: "saturday", first: "06:30", headway_min: 30 }, source: { quote: "premier départ à 6h30 de chaque terminus" } }] },
    checks: (L) => [
      {
        id: "first_at_0630",
        run: (before, after) => {
          const bad = [];
          for (const d of L.every(L.datesOf(after, "112", ["sat"]), 5)) for (const [dir, times] of L.depsAt(after, "112", d)) if (times[0] !== T(6, 30)) bad.push(`${d} dir ${dir}: ${L.hhmm(times[0])}`);
          return { ok: !bad.length, detail: bad.slice(0, 3).join("; ") || "06:30 both ways" };
        },
      },
      { id: "weekdays_unchanged", run: (before, after) => ({ ok: L.every(L.datesOf(before, "112", WEEKDAYS), 9).every((d) => L.sameDay(before, after, "112", d)), detail: "weekdays" }) },
      { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, ["112"]) },
    ],
    mutants: [{ id: "weekdays_too", plan: { operations: [{ id: "m", type: "set_span", params: { route: "C", days: "daily", first: "06:30", headway_min: 30 } }] } }],
  },
  {
    id: "renumbering",
    title: "A line renumbered",
    requires: ["set_route_attributes"],
    brief: "À la rentrée, la ligne R devient la ligne 5 (même couleur, même itinéraire).",
    reference: { title: "R devient 5", operations: [{ id: "op1", type: "set_route_attributes", params: { route: "R", short_name: "5" }, source: { quote: "la ligne R devient la ligne 5" } }] },
    checks: (L) => [
      { id: "R_is_5", run: (before, after) => ({ ok: after.routes.get("116")?.short_name === "5" && after.routes.get("116")?.color === before.routes.get("116")?.color, detail: `short_name ${after.routes.get("116")?.short_name}` }) },
      { id: "timetable_same", run: (before, after) => ({ ok: L.every(L.datesOf(before, "116", WEEKDAYS), 20).every((d) => L.sameDay(before, after, "116", d)), detail: "timetable" }) },
    ],
    mutants: [{ id: "wrong_line", plan: { operations: [{ id: "m", type: "set_route_attributes", params: { route: "B", short_name: "5" } }] } }],
  },  // ── The service-change notices of a year (research: what French authorities
  //    and operators actually write; expected properties worked out on the feed).
  {
    id: "alb01_amendment_headway",
    title: "A contract amendment: every 10 minutes on school days from a date, the old value stated",
    brief: "Avenant n°1 – article 3 : à compter du lundi 2 novembre 2026, la fréquence de la ligne C est portée à un bus toutes les 10 minutes entre 7h et 9h, dans les deux sens, du lundi au vendredi en période scolaire (contre un bus toutes les 15 minutes aujourd'hui).",
    answers: { region: "C", patterns: "main", direction: "both" },
    reference: {
      title: "Avenant n°1 art. 3 — ligne C toutes les 10 min en période scolaire",
      operations: [{ id: "op1", type: "set_headway", params: { route: "C", days: "weekday", period: "school_days", region: "C", from_date: "2026-11-02", from: "07:00", to: "09:00", headway_min: 10 }, source: { clause: "Art. 3", quote: "à compter du lundi 2 novembre 2026, la fréquence de la ligne C est portée à un bus toutes les 10 minutes entre 7h et 9h" } }],
    },
    checks: (L) => [
      {
        id: "every_10_min_on_school_days",
        run: (before, after) => {
          const bad = [];
          for (const d of L.pick(schoolWeekdays(after, L, C, { from: "20261102" }), 8)) for (const [dir, g] of Object.entries(L.windowGaps(after, C, d, T(7), T(9)))) if (g.n < 11 || g.innerMaxGap == null || g.innerMaxGap > 600) bad.push(`${d} dir ${dir}: ${g.n} departures, max gap ${g.innerMaxGap / 60} min`);
          return { ok: !bad.length, detail: bad.slice(0, 3).join("; ") || "≤ 10 min in 07:00–09:00 on every school weekday checked" };
        },
      },
      { id: "holiday_weekdays_unchanged", run: (before, after) => sameOn(L, before, after, [C], holidayWeekdays(before, L).filter((d) => d >= "20261102" && L.datesOf(before, C, WEEKDAYS).includes(d))) },
      { id: "unchanged_before_2_nov", run: (before, after) => sameOn(L, before, after, [C], L.datesOf(before, C, WEEKDAYS, { to: "20261101" })) },
      {
        id: "rest_of_the_day_unchanged",
        run: (before, after) => {
          const bad = [];
          for (const d of L.pick(schoolWeekdays(before, L, C, { from: "20261102" }), 3)) {
            const out = (m) => JSON.stringify([...L.depsAt(m, C, d).entries()].sort().map(([dir, ts]) => [dir, ts.filter((x) => x < T(7) || x >= T(9))]));
            if (out(before) !== out(after)) bad.push(d);
          }
          return { ok: !bad.length, detail: bad.length ? `departures outside 07:00–09:00 changed on ${bad.join(", ")}` : "outside the window unchanged" };
        },
      },
      { id: "saturdays_unchanged", run: (before, after) => sameOn(L, before, after, [C], L.datesOf(before, C, ["sat"])) },
      { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, [C]) },
    ],
    mutants: [
      { id: "holidays_too", plan: { operations: [{ id: "m", type: "set_headway", params: { route: "C", days: "weekday", from_date: "2026-11-02", from: "07:00", to: "09:00", headway_min: 10 } }] } },
      { id: "every_15", plan: { operations: [{ id: "m", type: "set_headway", params: { route: "C", days: "weekday", period: "school_days", region: "C", from_date: "2026-11-02", from: "07:00", to: "09:00", headway_min: 15 } }] } },
      { id: "a_week_late", plan: { operations: [{ id: "m", type: "set_headway", params: { route: "C", days: "weekday", period: "school_days", region: "C", from_date: "2026-11-09", from: "07:00", to: "09:00", headway_min: 10 } }] } },
    ],
  },
  {
    id: "alb02_extension",
    title: "Short trips extended to the far terminus, times kept at the stops already served",
    requires: ["extend_route"],
    brief: "À partir du lundi 4 janvier 2027, toutes les courses de la ligne E sont prolongées jusqu'à Saint-Juéry, tous les jours de circulation : les services limités à Renaudié sont supprimés. Les horaires de passage aux arrêts actuellement desservis sont conservés.",
    answers: { direction: "both" },
    reference: {
      title: "Ligne E prolongée à Saint-Juéry",
      operations: [{ id: "op1", type: "extend_route", params: { route: "E", beyond: "Renaudié", stops: ["Chardonnet", "Ronsard", "Les Crozes", "René-Rouquier", "Albaret", "Mouyssetié", "Pacifique", "Saint-Juéry"], from_date: "2027-01-04" }, source: { quote: "toutes les courses de la ligne E sont prolongées jusqu'à Saint-Juéry" } }],
    },
    checks: (L) => {
      // A school weekday, a holiday weekday and a Saturday from 4 January.
      const days = (m) => [schoolWeekdays(m, L, E, { from: "20270104" })[3], holidayWeekdays(m, L).find((d) => d >= "20270104"), L.datesOf(m, E, ["sat"], { from: "20270104" })[2]].filter(Boolean);
      return [
        {
          id: "every_trip_to_saint_juery",
          run: (before, after) => {
            const bad = [];
            for (const d of days(before)) for (const t of L.tripsOn(after, E, d)) {
              const end = t.direction_id === "1" ? L.nameAt(after, t, -1) : L.nameAt(after, t, 0);
              if (end !== "Saint-Juéry") bad.push(`${d} trip ${t.id} dir ${t.direction_id}: ${end}`);
            }
            return { ok: !bad.length, detail: bad.slice(0, 3).join("; ") || "every trip starts or ends at Saint-Juéry" };
          },
        },
        {
          id: "same_trips_same_times",
          run: (before, after) => {
            const bad = [];
            for (const d of days(before)) {
              const lost = L.missing(L.passings(before, E, d), L.passings(after, E, d));
              if (lost.length || L.tripsOn(before, E, d).length !== L.tripsOn(after, E, d).length) bad.push(`${d}: ${lost.length} passing(s) moved or lost, ${L.tripsOn(before, E, d).length} → ${L.tripsOn(after, E, d).length} trips`);
            }
            return { ok: !bad.length, detail: bad.join("; ") || "the stops already served keep their times" };
          },
        },
        {
          id: "new_section_timed",
          run: (before, after) => {
            const bad = [];
            const d = days(before)[0];
            for (const t of L.tripsOn(after, E, d)) {
              const names = t.stops.map((s) => after.stops.get(s)?.name);
              const a = names.indexOf("Renaudié");
              const b = names.indexOf("Saint-Juéry");
              const min = Math.abs(t.dep[b] - t.dep[a]) / 60;
              if (a < 0 || b < 0 || min < 5 || min > 16) bad.push(`trip ${t.id}: ${a < 0 || b < 0 ? "section missing" : `${min} min`}`);
            }
            return { ok: !bad.length, detail: bad.slice(0, 3).join("; ") || "Renaudié ↔ Saint-Juéry in 5–16 min" };
          },
        },
        { id: "unchanged_before_4_jan", run: (before, after) => sameOn(L, before, after, [E], L.datesOf(before, E, [...WEEKDAYS, "sat"], { to: "20270103" })) },
        { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, [E]) },
      ];
    },
    mutants: [
      { id: "no_effective_date", plan: { operations: [{ id: "m", type: "extend_route", params: { route: "E", beyond: "Renaudié", stops: ["Chardonnet", "Ronsard", "Les Crozes", "René-Rouquier", "Albaret", "Mouyssetié", "Pacifique", "Saint-Juéry"] } }] } },
      { id: "stops_short", plan: { operations: [{ id: "m", type: "extend_route", params: { route: "E", beyond: "Renaudié", stops: ["Chardonnet", "Ronsard", "Les Crozes"], from_date: "2027-01-04" } }] } },
      { id: "one_direction", plan: { operations: [{ id: "m", type: "extend_route", params: { route: "E", direction: "1", beyond: "Renaudié", stops: ["Chardonnet", "Ronsard", "Les Crozes", "René-Rouquier", "Albaret", "Mouyssetié", "Pacifique", "Saint-Juéry"], from_date: "2027-01-04" } }] } },
    ],
  },
  {
    id: "alb03_sundays_and_holidays",
    title: "Sunday service created on four lines, public holidays like Sunday except 1 May",
    requires: ["copy_day_service", "apply_holiday_rules", "set_span"],
    brief: "À compter du dimanche 3 janvier 2027, les lignes B, C, E et R circulent le dimanche, de 9h à 19h, avec un départ par heure dans chaque sens sur leur itinéraire principal. Les jours fériés, ces lignes circulent selon l'offre du dimanche, à l'exception du 1er mai (aucune circulation).",
    answers: { patterns: "main", route: "R: Portes d'Albi ↔ Innoprod" },
    reference: {
      title: "Dimanches et fériés sur B, C, E et R",
      operations: [
        { id: "copy", type: "copy_day_service", params: { routes: ["B", "C", "E", "R"], from_day: "saturday", to_days: "sunday", from_date: "2027-01-03" }, source: { quote: "les lignes B, C, E et R circulent le dimanche" } },
        ...["B", "C", "E", "R"].flatMap((r) => [
          { id: `hourly_${r}`, type: "set_headway", params: { route: r, days: "sunday", from_date: "2027-01-03", from: "09:00", to: "19:00", start: "09:00", headway_min: 60, patterns: "main_only" }, source: { quote: "de 9h à 19h, avec un départ par heure dans chaque sens sur leur itinéraire principal" } },
          { id: `span_${r}`, type: "set_span", params: { route: r, days: "sunday", from_date: "2027-01-03", first: "09:00", last: "18:00" }, source: { quote: "de 9h à 19h" } },
        ]),
        { id: "holidays", type: "apply_holiday_rules", params: { routes: ["B", "C", "E", "R"], rule: "sunday", period: "public_holidays", from_date: "2027-01-03", except: ["2027-05-01"] }, source: { quote: "Les jours fériés, ces lignes circulent selon l'offre du dimanche, à l'exception du 1er mai" } },
      ],
    },
    checks: (L) => {
      const lines = [B, C, E, R];
      const sundays = between("20270103", "20270627", ["sun"]);
      return [
        {
          id: "hourly_from_9_to_19_every_sunday",
          run: (before, after) => {
            const bad = [];
            for (const d of L.pick(sundays, 5)) for (const r of lines) {
              const deps = L.depsAt(after, r, d);
              if (deps.size !== 2) bad.push(`${d} ${r}: ${deps.size} direction(s)`);
              for (const [dir, ts] of deps) {
                let gap = 0;
                for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
                if (ts.length < 9 || ts.length > 11 || ts[0] < T(9) || ts[0] > T(9, 30) || ts[ts.length - 1] >= T(19) || gap > 3600) bad.push(`${d} ${r} dir ${dir}: ${ts.length} departures ${L.hhmm(ts[0])}–${L.hhmm(ts[ts.length - 1])}, max gap ${gap / 60} min`);
              }
            }
            return { ok: !bad.length, detail: bad.slice(0, 3).join("; ") || "hourly 09:00–18:xx both ways on every Sunday checked" };
          },
        },
        {
          id: "main_pattern_only",
          run: (before, after) => {
            const bad = [];
            for (const r of lines) {
              const seqs = new Map();
              for (const t of L.tripsOn(after, r, sundays[1])) {
                if (!seqs.has(t.direction_id)) seqs.set(t.direction_id, new Set());
                seqs.get(t.direction_id).add(t.stops.join(">"));
              }
              for (const [dir, s] of seqs) if (s.size !== 1) bad.push(`${r} dir ${dir}: ${s.size} itineraries`);
            }
            const r = L.tripsOn(after, R, sundays[1]).some((t) => L.nameAt(after, t, 0) === "Saint-Juéry" || L.nameAt(after, t, -1) === "Saint-Juéry");
            if (r) bad.push("R runs its Saint-Juéry branch (the main itinerary is Portes d'Albi ↔ Innoprod)");
            return { ok: !bad.length, detail: bad.join("; ") || "one itinerary per direction" };
          },
        },
        {
          id: "public_holidays_like_sunday",
          run: (before, after) => {
            const key = (d) => JSON.stringify(lines.map((r) => [...L.depsAt(after, r, d).entries()].sort()));
            const ref = key(sundays[1]);
            const bad = ["20270329", "20270506", "20270508", "20270517"].filter((d) => key(d) !== ref);
            return { ok: !bad.length, detail: bad.length ? `not the Sunday timetable on ${bad.join(", ")}` : "Easter Monday, Ascension, 8 May and Whit Monday run the Sunday timetable" };
          },
        },
        {
          id: "no_service_1_may_nor_before_3_jan",
          run: (before, after) => {
            const bad = ["20270501", "20270101", "20261227"].filter((d) => lines.some((r) => L.tripsOn(after, r, d).length));
            return { ok: !bad.length, detail: bad.length ? `service on ${bad.join(", ")}` : "no service on 1 May, 1 January and the Sundays before" };
          },
        },
        { id: "weekdays_and_saturdays_unchanged", run: (before, after) => sameOn(L, before, after, lines, [...L.datesOf(before, B, WEEKDAYS), ...L.datesOf(before, B, ["sat"])].filter((d) => !["20270508"].includes(d)).sort()) },
        { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, lines) },
      ];
    },
    mutants: [
      { id: "saturday_copy_only", plan: { operations: [{ id: "m", type: "copy_day_service", params: { routes: ["B", "C", "E", "R"], from_day: "saturday", to_days: "sunday", from_date: "2027-01-03" } }] } },
      {
        id: "no_holidays",
        plan: {
          operations: [
            { id: "copy", type: "copy_day_service", params: { routes: ["B", "C", "E", "R"], from_day: "saturday", to_days: "sunday", from_date: "2027-01-03" } },
            ...["B", "C", "E", "R"].flatMap((r) => [
              { id: `h_${r}`, type: "set_headway", params: { route: r, days: "sunday", from_date: "2027-01-03", from: "09:00", to: "19:00", headway_min: 60, patterns: "main_only" } },
              { id: `s_${r}`, type: "set_span", params: { route: r, days: "sunday", from_date: "2027-01-03", first: "09:00", last: "18:00" } },
            ]),
          ],
        },
      },
    ],
  },
  {
    id: "alb04_evening_span",
    title: "An evening extension, Monday to Saturday, from a date",
    requires: ["set_span"],
    brief: "Ligne C : à partir du 2 novembre 2026, le service est prolongé en soirée du lundi au samedi, toute l'année. Dernier départ à 21h30 de Cantepau et de Parking Mézard, avec un bus toutes les 30 minutes après 19h30.",
    reference: {
      title: "Ligne C prolongée en soirée",
      operations: [{ id: "op1", type: "set_span", params: { route: "C", days: ["mon", "tue", "wed", "thu", "fri", "sat"], from_date: "2026-11-02", last: "21:30", headway_min: 30 }, source: { quote: "Dernier départ à 21h30 de Cantepau et de Parking Mézard, avec un bus toutes les 30 minutes après 19h30" } }],
    },
    checks: (L) => {
      const days = (m) => L.pick(L.datesOf(m, C, [...WEEKDAYS, "sat"], { from: "20261102" }), 8);
      return [
        {
          id: "last_departure_2130_evening_every_30",
          run: (before, after) => {
            const bad = [];
            for (const d of days(before)) {
              const old = L.depsAt(before, C, d);
              for (const [dir, ts] of L.depsAt(after, C, d)) {
                const oldLast = (old.get(dir) || []).at(-1) ?? T(19);
                const evening = ts.filter((x) => x >= oldLast);
                let gap = 0;
                for (let i = 1; i < evening.length; i++) gap = Math.max(gap, evening[i] - evening[i - 1]);
                if (ts.at(-1) !== T(21, 30) || gap > 31 * 60) bad.push(`${d} dir ${dir}: last ${L.hhmm(ts.at(-1))}, evening max gap ${gap / 60} min`);
              }
            }
            return { ok: !bad.length, detail: bad.slice(0, 3).join("; ") || "last at 21:30, ≤ 30 min after the old last departure" };
          },
        },
        {
          id: "day_unchanged",
          run: (before, after) => {
            const bad = [];
            for (const d of days(before)) {
              const old = L.depsAt(before, C, d);
              for (const [dir, ts] of old) {
                const now = (L.depsAt(after, C, d).get(dir) || []).filter((x) => x <= ts.at(-1));
                if (JSON.stringify(now) !== JSON.stringify(ts)) bad.push(`${d} dir ${dir}`);
              }
            }
            return { ok: !bad.length, detail: bad.length ? `day timetable changed: ${bad.slice(0, 3).join(", ")}` : "the day timetable is kept" };
          },
        },
        { id: "unchanged_before_2_nov", run: (before, after) => sameOn(L, before, after, [C], L.datesOf(before, C, [...WEEKDAYS, "sat"], { to: "20261101" })) },
        { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, [C]) },
      ];
    },
    mutants: [
      { id: "weekdays_only", plan: { operations: [{ id: "m", type: "set_span", params: { route: "C", days: "weekday", from_date: "2026-11-02", last: "21:30", headway_min: 30 } }] } },
      { id: "last_at_21", plan: { operations: [{ id: "m", type: "set_span", params: { route: "C", days: ["mon", "tue", "wed", "thu", "fri", "sat"], from_date: "2026-11-02", last: "21:00", headway_min: 30 } }] } },
      { id: "no_effective_date", plan: { operations: [{ id: "m", type: "set_span", params: { route: "C", days: ["mon", "tue", "wed", "thu", "fri", "sat"], last: "21:30", headway_min: 30 } }] } },
    ],
  },
  {
    id: "alb05_truncation",
    title: "A branch no longer served: trips cut back to a stop, other times kept",
    requires: ["truncate_route"],
    brief: "Ligne R : à compter du 4 janvier 2027, la desserte du Lycée Fonlabour est supprimée. Les courses qui partaient du Lycée Fonlabour ou s'y terminaient sont limitées à Portes d'Albi, aux mêmes horaires aux autres arrêts.",
    reference: {
      title: "Ligne R limitée à Portes d'Albi",
      operations: [{ id: "op1", type: "truncate_route", params: { route: "R", at: "Portes d'Albi", drop: "Lycée Fonlabour", from_date: "2027-01-04" }, source: { quote: "Les courses qui partaient du Lycée Fonlabour ou s'y terminaient sont limitées à Portes d'Albi" } }],
    },
    checks: (L) => {
      const cut = ["Lycée Fonlabour", "Stade Fonlabour"];
      const days = (m) => L.pick(schoolWeekdays(m, L, R, { from: "20270104" }), 4);
      return [
        {
          id: "fonlabour_not_served",
          run: (before, after) => {
            const bad = days(before).filter((d) => L.passings(after, R, d).some((p) => cut.includes(p.split("|")[1])));
            return { ok: !bad.length, detail: bad.length ? `still served on ${bad.join(", ")}` : "Lycée and Stade Fonlabour no longer served" };
          },
        },
        {
          id: "other_stops_same_times",
          run: (before, after) => {
            const bad = [];
            for (const d of days(before)) {
              const a = L.passings(before, R, d, cut);
              const b = L.passings(after, R, d, cut);
              if (JSON.stringify(a) !== JSON.stringify(b) || L.tripsOn(before, R, d).length !== L.tripsOn(after, R, d).length) bad.push(`${d}: ${L.missing(a, b).length} passing(s) lost, ${L.missing(b, a).length} added`);
            }
            return { ok: !bad.length, detail: bad.join("; ") || "every trip kept, same times at the other stops" };
          },
        },
        {
          id: "headsigns_follow",
          run: (before, after) => {
            const d = days(before)[0];
            const bad = L.tripsOn(after, R, d).filter((t) => /Fonlabour/.test(t.headsign));
            return { ok: !bad.length, detail: bad.length ? `${bad.length} trip(s) still signed Lycée Fonlabour` : "headsigns follow the new terminus" };
          },
        },
        { id: "unchanged_before_4_jan", run: (before, after) => sameOn(L, before, after, [R], L.datesOf(before, R, WEEKDAYS, { to: "20270103" })) },
        { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, [R]) },
      ];
    },
    mutants: [
      { id: "no_effective_date", plan: { operations: [{ id: "m", type: "truncate_route", params: { route: "R", at: "Portes d'Albi", drop: "Lycée Fonlabour" } }] } },
      { id: "cut_one_stop_too_far", plan: { operations: [{ id: "m", type: "truncate_route", params: { route: "R", at: "Rond-Point du Séquestre", drop: "Lycée Fonlabour", from_date: "2027-01-04" } }] } },
    ],
  },
  {
    id: "alb06_works_detour",
    title: "Works: two stops closed for three weeks, a temporary stop, running times unchanged",
    requires: ["reroute"],
    brief: "Travaux dans le secteur de la cathédrale du lundi 2 au vendredi 20 novembre 2026 : les arrêts Sainte-Cécile et Soulages ne sont pas desservis par les lignes B et C, dans les deux sens. Un arrêt provisoire « Sainte-Cécile provisoire » est créé aux coordonnées 43.9405, 2.1486. Les temps de parcours sont inchangés.",
    answers: { mode: "absorb" },
    reference: {
      title: "Travaux secteur cathédrale — déviation B et C",
      operations: [
        { id: "B", type: "reroute", params: { route: "B", from_stop: "Place Perret", to_stop: "Les Mines", via: [{ name: "Sainte-Cécile provisoire", lat: 43.9405, lon: 2.1486 }], from_date: "2026-11-02", to_date: "2026-11-20", mode: "absorb" }, source: { quote: "les arrêts Sainte-Cécile et Soulages ne sont pas desservis par les lignes B et C" } },
        // C runs a one-way street there: Provence → … → Les Mines one way, Les Mines → … → Majesté the other.
        { id: "C0", type: "reroute", params: { route: "C", direction: "0", from_stop: "Provence", to_stop: "Les Mines", via: [{ name: "Sainte-Cécile provisoire", lat: 43.9405, lon: 2.1486 }], from_date: "2026-11-02", to_date: "2026-11-20", mode: "absorb" }, source: { quote: "les arrêts Sainte-Cécile et Soulages ne sont pas desservis par les lignes B et C" } },
        { id: "C1", type: "reroute", params: { route: "C", direction: "1", from_stop: "Les Mines", to_stop: "Majesté", via: [{ name: "Sainte-Cécile provisoire", lat: 43.9405, lon: 2.1486 }], from_date: "2026-11-02", to_date: "2026-11-20", mode: "absorb" }, source: { quote: "dans les deux sens" } },
      ],
    },
    checks: (L) => {
      const closed = ["Sainte-Cécile", "Soulages"];
      const temp = "Sainte-Cécile provisoire";
      const works = (m, r) => L.datesOf(m, r, [...WEEKDAYS, "sat", "sun"], { from: "20261102", to: "20261120" });
      return [
        {
          id: "closed_stops_not_served_temporary_once",
          run: (before, after) => {
            const bad = [];
            for (const r of [B, C]) for (const d of L.pick(works(before, r), 4)) for (const t of L.tripsOn(after, r, d)) {
              const names = t.stops.map((s) => after.stops.get(s)?.name);
              if (names.some((n) => closed.includes(n)) || names.filter((n) => n === temp).length !== 1) bad.push(`${d} ${r} trip ${t.id}`);
            }
            return { ok: !bad.length, detail: bad.slice(0, 3).join("; ") || "the temporary stop replaces both, once per trip" };
          },
        },
        {
          id: "other_stops_same_times",
          run: (before, after) => {
            const bad = [];
            for (const r of [B, C]) for (const d of L.pick(works(before, r), 3)) if (JSON.stringify(L.passings(before, r, d, [...closed, temp])) !== JSON.stringify(L.passings(after, r, d, [...closed, temp]))) bad.push(`${r} ${d}`);
            return { ok: !bad.length, detail: bad.length ? `times moved: ${bad.join(", ")}` : "running times unchanged" };
          },
        },
        {
          id: "unchanged_outside_the_works",
          run: (before, after) => {
            const bad = [];
            for (const r of [B, C]) for (const d of ["20261030", "20261031", "20261121", "20261123"]) if (JSON.stringify(L.passings(before, r, d)) !== JSON.stringify(L.passings(after, r, d))) bad.push(`${r} ${d}`);
            return { ok: !bad.length, detail: bad.length ? `changed: ${bad.join(", ")}` : "the day before and after unchanged" };
          },
        },
        {
          id: "temporary_stop_located",
          run: (before, after) => {
            const s = [...after.stops.values()].filter((x) => x.name === temp);
            const far = s.filter((x) => Math.hypot((x.lat - 43.9405) * 111320, (x.lon - 2.1486) * 80000) > 60);
            return { ok: s.length > 0 && !far.length, detail: s.length ? `${s.length} stop(s), ${far.length} more than 60 m away` : "no temporary stop" };
          },
        },
        { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, [B, C]) },
      ];
    },
    mutants: [
      { id: "for_good", plan: { operations: [{ id: "m", type: "reroute", params: { route: "B", from_stop: "Place Perret", to_stop: "Les Mines", via: [{ name: "Sainte-Cécile provisoire", lat: 43.9405, lon: 2.1486 }], mode: "absorb" } }] } },
      { id: "B_only", plan: { operations: [{ id: "m", type: "reroute", params: { route: "B", from_stop: "Place Perret", to_stop: "Les Mines", via: [{ name: "Sainte-Cécile provisoire", lat: 43.9405, lon: 2.1486 }], from_date: "2026-11-02", to_date: "2026-11-20", mode: "absorb" } }] } },
    ],
  },
  {
    id: "alb07_identity",
    title: "Lines renumbered and recoloured, a stop renamed, stations made accessible",
    requires: ["set_route_attributes", "rename_stop", "set_accessibility"],
    brief: "À la rentrée de janvier 2027 : les lignes H et J, qui ne circulent qu'en période scolaire, deviennent respectivement S1 et S2, en gris (#6E6E6E, texte blanc). L'arrêt « Hôpital - Médiathèque » est renommé « Hôpital – Pôle Santé ». Les arrêts Gare Albi-Ville, Place Jean-Jaurès et Lices Pompidou deviennent accessibles aux usagers en fauteuil roulant.",
    answers: { stops: "les deux stations Place Jean-Jaurès", whole_feed: "oui, dès maintenant" },
    reference: {
      title: "Identité des lignes scolaires, Pôle Santé, accessibilité",
      operations: [
        { id: "lines", type: "set_route_attributes", params: { changes: [{ route: "H", short_name: "S1", color: "6E6E6E", text_color: "FFFFFF" }, { route: "J", short_name: "S2", color: "6E6E6E", text_color: "FFFFFF" }], whole_feed: true }, source: { quote: "les lignes H et J … deviennent respectivement S1 et S2, en gris (#6E6E6E, texte blanc)" } },
        { id: "rename", type: "rename_stop", params: { stop: "Hôpital - Médiathèque", name: "Hôpital – Pôle Santé" }, source: { quote: "L'arrêt « Hôpital - Médiathèque » est renommé « Hôpital – Pôle Santé »" } },
        { id: "access", type: "set_accessibility", params: { stops: ["Gare Albi-Ville", "10833", "11505", "Lices Pompidou"], wheelchair_boarding: 1 }, source: { quote: "Les arrêts Gare Albi-Ville, Place Jean-Jaurès et Lices Pompidou deviennent accessibles" } },
      ],
    },
    checks: (L) => {
      const ACCESSIBLE = ["10740", "21270", "21271", "22423", "10833", "21434", "22554", "11505", "22555", "10796", "21367", "21368"];
      return [
        {
          id: "H_S1_J_S2_grey",
          run: (before, after) => {
            const bad = [];
            for (const [id, short] of [[H, "S1"], [J, "S2"]]) {
              const r = after.routes.get(id);
              if (!r || r.short_name !== short || String(r.color).toUpperCase() !== "6E6E6E" || String(r.text_color).toUpperCase() !== "FFFFFF" || r.long_name !== before.routes.get(id).long_name) bad.push(`${id}: ${r ? `${r.short_name} ${r.color}/${r.text_color}` : "gone"}`);
            }
            return { ok: !bad.length, detail: bad.join("; ") || "H is S1, J is S2, grey with white text" };
          },
        },
        {
          id: "stop_renamed",
          run: (before, after) => {
            const ok = ["10752", "21288", "21289"].every((id) => after.stops.get(id)?.name === "Hôpital – Pôle Santé") && ![...after.stops.values()].some((s) => s.name === "Hôpital - Médiathèque");
            return { ok, detail: ok ? "station and both platforms renamed, en dash kept" : `names: ${["10752", "21288", "21289"].map((id) => after.stops.get(id)?.name).join(", ")}` };
          },
        },
        {
          id: "stations_accessible_others_not",
          run: (before, after) => {
            const off = ACCESSIBLE.filter((id) => String(after.stops.get(id)?.wheelchair) !== "1");
            const extra = [...after.stops.values()].filter((s) => !ACCESSIBLE.includes(s.id) && String(s.wheelchair ?? "") !== String(before.stops.get(s.id)?.wheelchair ?? ""));
            return { ok: !off.length && !extra.length, detail: `${off.length} listed stop(s) not accessible (${off.join(", ")}), ${extra.length} other stop(s) changed` };
          },
        },
        { id: "timetables_unchanged", run: (before, after) => sameOn(L, before, after, [...before.routes.keys()], [before.representative.tue, before.representative.sat].filter(Boolean)) },
      ];
    },
    mutants: [
      { id: "one_jean_jaures_station", plan: { operations: [{ id: "m", type: "set_accessibility", params: { stops: ["Gare Albi-Ville", "10833", "Lices Pompidou"], wheelchair_boarding: 1 } }] } },
      { id: "wrong_grey", plan: { operations: [{ id: "m", type: "set_route_attributes", params: { changes: [{ route: "H", short_name: "S1", color: "666666", text_color: "FFFFFF" }, { route: "J", short_name: "S2", color: "666666", text_color: "FFFFFF" }], whole_feed: true } }] } },
    ],
  },
  {
    id: "alb08_summer_and_cleanup",
    title: "The validity extended over the summer with the holiday timetable, a public holiday off, expired services pruned",
    requires: ["extend_validity", "run_like", "delete_rows"],
    brief: "Prolonger la validité des horaires jusqu'au 31 août 2027 : du lundi 5 juillet au mardi 31 août 2027, les lignes circulent selon l'offre « vacances scolaires » du lundi au vendredi et selon l'offre du samedi le samedi ; aucune circulation le mercredi 14 juillet. Supprimer les services de début septembre 2026 qui ont expiré.",
    answers: { like_date: "2027-04-12" },
    reference: {
      title: "Été 2027 et nettoyage",
      operations: [
        { id: "validity", type: "extend_validity", params: { end_date: "2027-08-31" }, source: { quote: "Prolonger la validité des horaires jusqu'au 31 août 2027" } },
        { id: "weekdays", type: "run_like", params: { routes: "all", like: "weekday", like_date: "2027-04-12", days: "weekday", from_date: "2027-07-05", to_date: "2027-08-31" }, source: { quote: "du lundi au vendredi selon l'offre « vacances scolaires »" } },
        { id: "july14", type: "run_like", params: { routes: "all", like: "none", dates: ["2027-07-14"] }, source: { quote: "aucune circulation le mercredi 14 juillet" } },
        { id: "prune", type: "delete_rows", params: { table: "calendar", where: { service_id: ["1", "2", "3", "4"] }, cascade: "cascade" }, source: { quote: "Supprimer les services de début septembre 2026 qui ont expiré" } },
      ],
    },
    checks: (L) => {
      const LINES = [A, B, C, D, E, F, G, R];
      const summer = between("20270705", "20270831", WEEKDAYS).filter((d) => d !== "20270714");
      // The holiday timetable of the same weekday (the feed's own school-holiday service).
      const refOf = (before, d) => holidayWeekdays(before, L).filter((x) => dowOf(x) === dowOf(d)).pop();
      return [
        {
          id: "summer_weekdays_run_the_holiday_timetable",
          run: (before, after) => {
            const bad = [];
            for (const d of L.pick(summer, 6)) for (const r of LINES) if (JSON.stringify([...L.depsAt(after, r, d).entries()].sort()) !== JSON.stringify([...L.depsAt(before, r, refOf(before, d)).entries()].sort())) bad.push(`${r} ${d}`);
            return { ok: !bad.length, detail: bad.length ? `not the holiday timetable: ${bad.slice(0, 4).join(", ")}` : "the holiday timetable all summer" };
          },
        },
        {
          id: "summer_saturdays_run_the_saturday_timetable",
          run: (before, after) => {
            const ref = "20270612";
            const bad = [];
            for (const d of between("20270710", "20270828", ["sat"])) for (const r of LINES) if (JSON.stringify([...L.depsAt(after, r, d).entries()].sort()) !== JSON.stringify([...L.depsAt(before, r, ref).entries()].sort())) bad.push(`${r} ${d}`);
            return { ok: !bad.length, detail: bad.length ? `not the Saturday timetable: ${bad.slice(0, 4).join(", ")}` : "Saturdays as usual" };
          },
        },
        {
          id: "no_service_14_july_sundays_school_lines",
          run: (before, after) => {
            const bad = [];
            for (const r of [...after.routes.keys()]) {
              if (L.tripsOn(after, r, "20270714").length) bad.push(`${r} on 14 July`);
              if (L.tripsOn(after, r, "20270815").length) bad.push(`${r} on Sunday 15 August`);
            }
            for (const r of [H, J]) if (summer.some((d) => L.tripsOn(after, r, d).length)) bad.push(`${r} in the summer`);
            return { ok: !bad.length, detail: bad.join(", ") || "none on 14 July, Sundays, nor the school lines" };
          },
        },
        {
          id: "validity_ends_31_august",
          run: (before, after) => {
            const end = after.range?.end;
            const info = String(after.feedInfo?.feed_end_date || "");
            const late = [...after.routes.keys()].some((r) => L.tripsOn(after, r, "20270901").length);
            return { ok: end === "20270831" && info === "20270831" && !late, detail: `range ends ${end}, feed_info ${info || "—"}${late ? ", service on 1 September" : ""}` };
          },
        },
        { id: "school_year_unchanged", run: (before, after) => sameOn(L, before, after, LINES, L.datesOf(before, B, WEEKDAYS, { from: "20260914", to: "20270702" }), 8) },
        {
          id: "expired_services_pruned",
          run: (before, after) => {
            const left = [...after.trips.values()].filter((t) => ["1", "2", "3", "4"].includes(t.service_id)).length;
            const early = [...after.routes.keys()].some((r) => L.tripsOn(after, r, "20260902").length);
            return { ok: !left && !early && after.trips.size <= before.trips.size - 700, detail: `${left} trip(s) left on services 1–4; ${before.trips.size} → ${after.trips.size} trips` };
          },
        },
      ];
    },
    mutants: [
      { id: "extend_only", plan: { operations: [{ id: "m", type: "extend_validity", params: { end_date: "2027-08-31" } }] } },
      {
        id: "no_prune",
        plan: {
          operations: [
            { id: "v", type: "extend_validity", params: { end_date: "2027-08-31" } },
            { id: "w", type: "run_like", params: { routes: "all", like: "weekday", like_date: "2027-04-12", days: "weekday", from_date: "2027-07-05", to_date: "2027-08-31" } },
            { id: "n", type: "run_like", params: { routes: "all", like: "none", dates: ["2027-07-14"] } },
          ],
        },
      },
    ],
  },
  {
    id: "alb09_school_adjustments",
    title: "Four school-day adjustments in one notice: a trip moved to a bell time, two withdrawn, one added",
    requires: ["shift_trips", "remove_trips", "add_trips"],
    brief: "Ajustements scolaires au 4 janvier 2027 : (1) ligne J, la course de 7h40 au départ de Cantepau doit arriver au Collège Jean-Jaurès à 7h50 (au lieu de 7h56) ; (2) ligne D, suppression des courses partielles de 7h17 (Maison de Quartier → Place Jean-Jaurès) et de 13h45 (Lices Jean-Moulin → Pélissier) ; (3) ligne B, ajout d'un départ à 7h37 de Najac vers Parking Mézard les jours scolaires.",
    answers: { region: "C" },
    reference: {
      title: "Ajustements scolaires au 4 janvier 2027",
      operations: [
        { id: "J", type: "shift_trips", params: { route: "J", direction: "Collège Jean-Jaurès", period: "school_days", region: "C", from_date: "2027-01-04", at_stop: "Cantepau", times: ["07:40"], target: { stop: "Collège Jean-Jaurès", time: "07:50", event: "arrive", was: "07:56" } }, source: { quote: "la course de 7h40 au départ de Cantepau doit arriver au Collège Jean-Jaurès à 7h50 (au lieu de 7h56)" } },
        { id: "D1", type: "remove_trips", params: { route: "D", period: "school_days", region: "C", from_date: "2027-01-04", at_stop: "Maison de Quartier", times: ["07:17"] }, source: { quote: "suppression des courses partielles de 7h17 (Maison de Quartier → Place Jean-Jaurès)" } },
        { id: "D2", type: "remove_trips", params: { route: "D", period: "school_days", region: "C", from_date: "2027-01-04", at_stop: "Lices Jean-Moulin", times: ["13:45"] }, source: { quote: "et de 13h45 (Lices Jean-Moulin → Pélissier)" } },
        { id: "B", type: "add_trips", params: { route: "B", direction: "Parking Mézard", days: "weekday", period: "school_days", region: "C", from_date: "2027-01-04", at_stop: "Najac", times: ["07:37"] }, source: { quote: "ajout d'un départ à 7h37 de Najac vers Parking Mézard les jours scolaires" } },
      ],
    },
    checks: (L) => {
      const days = (m, r) => L.pick(schoolWeekdays(m, L, r, { from: "20270104" }), 4);
      return [
        {
          id: "J_arrives_at_0750",
          run: (before, after) => {
            const bad = [];
            const old = [...before.trips.values()].find((t) => t.id === "284348");
            const hops = (t) => t.dep.map((x, i) => (i ? x - t.dep[i - 1] : 0)).join(",");
            for (const d of days(before, J)) {
              const t = L.tripsOn(after, J, d).find((x) => x.direction_id === "0" && x.dep[0] < T(8));
              if (!t || t.dep[0] !== T(7, 34) || t.arr.at(-1) !== T(7, 50) || hops(t) !== hops(old)) bad.push(`${d}: ${t ? `${L.hhmm(t.dep[0])} → ${L.hhmm(t.arr.at(-1))}` : "no morning trip"}`);
            }
            return { ok: !bad.length, detail: bad.slice(0, 3).join("; ") || "leaves Cantepau 07:34, arrives 07:50, same running times" };
          },
        },
        {
          id: "D_trips_withdrawn",
          run: (before, after) => {
            const bad = [];
            for (const d of days(before, D)) {
              const firsts = L.tripsOn(after, D, d).map((t) => `${L.nameAt(after, t, 0)}@${L.hhmm(t.dep[0])}`);
              if (firsts.includes("Maison de Quartier@07:17") || firsts.includes("Lices Jean-Moulin (Quai 5)@13:45") || !firsts.includes("Lices Jean-Moulin (Quai 5)@07:45")) bad.push(d);
            }
            return { ok: !bad.length, detail: bad.length ? `wrong D trips on ${bad.join(", ")}` : "07:17 and 13:45 gone, 07:45 kept" };
          },
        },
        {
          id: "B_departure_0737",
          run: (before, after) => {
            const bad = [];
            for (const d of days(before, B)) {
              const ts = (L.depsAt(after, B, d).get("0") || []).filter((x) => x >= T(7, 25) && x <= T(7, 45));
              const t = L.tripsOn(after, B, d).find((x) => x.direction_id === "0" && x.dep[0] === T(7, 37));
              if (JSON.stringify(ts) !== JSON.stringify([T(7, 30), T(7, 37), T(7, 43)]) || !t || L.nameAt(after, t, -1) !== "Parking Mézard" || L.nameAt(after, t, 0) !== "Najac") bad.push(`${d}: ${ts.map(L.hhmm).join(" ")}`);
            }
            return { ok: !bad.length, detail: bad.slice(0, 3).join("; ") || "07:30, 07:37, 07:43 from Najac" };
          },
        },
        { id: "unchanged_before_4_jan", run: (before, after) => sameOn(L, before, after, [J, D, B], L.datesOf(before, B, WEEKDAYS, { to: "20270103" })) },
        { id: "holiday_weekdays_unchanged", run: (before, after) => sameOn(L, before, after, [J, D, B], holidayWeekdays(before, L).filter((d) => d >= "20270104" && L.datesOf(before, B, WEEKDAYS).includes(d))) },
        { id: "other_lines_unchanged", run: (before, after) => L.onlyChanged(before, after, [J, D, B]) },
      ];
    },
    mutants: [
      { id: "B_every_weekday", plan: { operations: [{ id: "m", type: "add_trips", params: { route: "B", direction: "Parking Mézard", days: "weekday", from_date: "2027-01-04", at_stop: "Najac", times: ["07:37"] } }] } },
      { id: "J_leaves_at_0750", plan: { operations: [{ id: "m", type: "shift_trips", params: { route: "J", direction: "Collège Jean-Jaurès", period: "school_days", region: "C", from_date: "2027-01-04", at_stop: "Cantepau", times: ["07:40"], minutes: 10 } }] } },
      { id: "D_wrong_trip", plan: { operations: [{ id: "m", type: "remove_trips", params: { route: "D", period: "school_days", region: "C", from_date: "2027-01-04", at_stop: "Lices Jean-Moulin", times: ["07:45"] } }] } },
    ],
  },
  {
    id: "alb10_external_timetable",
    title: "Connections with another operator's trains: the data is missing — ask, change nothing",
    expect: "ask",
    requires: ["shift_trips"], // the mutant's operator
    brief: "Ligne E : garantir, du lundi au vendredi, une correspondance de 5 à 12 minutes en gare d'Albi-Ville avec chaque TER au départ vers Toulouse entre 6h30 et 9h00, en décalant les courses de la ligne E de 5 minutes au plus.",
    reference: { title: "Correspondances TER à Albi-Ville — horaires TER nécessaires", operations: [] },
    checks: (L) => [{ id: "feed_unchanged", run: (before, after) => L.onlyChanged(before, after, []) }],
    mutants: [{ id: "blind_shift", plan: { operations: [{ id: "m", type: "shift_trips", params: { route: "E", direction: "Gare Albi-Ville", days: "weekday", from: "06:00", to: "09:00", minutes: 5 } }] } }],
  },
];

/** Weekdays on which the Albi feed runs its school-holiday service (service 7) — the feed's own holidays. */
const holidayWeekdays = (model, L) => {
  const S = require("../../GTFS-EXPRESS-API/src/services/transform/scope");
  return S.activeDates(model, "7").filter((d) => WEEKDAYS.includes(S.dayTypeOf(model, "7", d)));
};

/**
 * The frozen calendar service both levels use (no network): public holidays
 * of France (Nager.Date's shape) and, as the school holidays of zone C
 * (OpenHolidays' shape), the Albi feed's own holiday service dates.
 */
const frozenFetch = (model, S, fm) => {
  const periods = [];
  for (const d of S.activeDates(model, "7")) {
    const last = periods[periods.length - 1];
    if (last && fm._internals.addDays(last.end, 1) >= d && d <= fm._internals.addDays(last.end, 3)) last.end = d;
    else periods.push({ start: d, end: d });
  }
  const iso = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
  const holidays = [
    ["2026-11-01", "Toussaint", "All Saints"],
    ["2026-11-11", "Armistice", "Armistice"],
    ["2026-12-25", "Noël", "Christmas"],
    ["2027-01-01", "Jour de l'an", "New Year"],
    ["2027-03-29", "Lundi de Pâques", "Easter Monday"],
    ["2027-05-01", "Fête du Travail", "Labour Day"],
    ["2027-05-06", "Ascension", "Ascension"],
    ["2027-05-08", "Victoire 1945", "Victory"],
    ["2027-05-17", "Lundi de Pentecôte", "Whit Monday"],
    ["2027-07-14", "Fête nationale", "Bastille Day"],
    ["2027-08-15", "Assomption", "Assumption"],
  ].map(([date, localName, name]) => ({ date, localName, name, global: true }));
  return async (url) => {
    const body = String(url).includes("SchoolHolidays") ? periods.map((p) => ({ startDate: iso(p.start), endDate: iso(p.end), name: [{ language: "FR", text: "Vacances" }], nationwide: false, subdivisions: [{ shortName: "FR-C" }] })) : holidays;
    return { ok: true, json: async () => body };
  };
};

module.exports = { CASES, lib, holidayWeekdays, frozenFetch, FEED: "albi", WEEKDAYS };
