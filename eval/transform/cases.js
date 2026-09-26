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
  return { hhmm, datesOf, every, depsAt, sameDay, windowGaps, stopNamesOf, changedRoutes, onlyChanged };
};

const T = (h, m = 0) => h * 3600 + m * 60;

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
  },
];

/** Weekdays on which the Albi feed runs its school-holiday service (service 7) — the feed's own holidays. */
const holidayWeekdays = (model, L) => {
  const S = require("../../GTFS-EXPRESS-API/src/services/transform/scope");
  return S.activeDates(model, "7").filter((d) => WEEKDAYS.includes(S.dayTypeOf(model, "7", d)));
};

module.exports = { CASES, lib, holidayWeekdays, FEED: "albi", WEEKDAYS };
