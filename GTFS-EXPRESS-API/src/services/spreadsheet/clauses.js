/**
 * spreadsheet/clauses — the offer a sheet states, as clauses of the step-2
 * vocabulary (conformanceService), deterministically: each clause's
 * `source` is the cell it comes from (« offre.xlsx · Offre!F5 ») and its
 * `quote` the cell's text, so ② shows where every promise was read.
 *
 *   clausesOf(model, { resolveDirection?, lang? }) → { clauses, not_converted: [{ sheet, cell, kind, reason, text }] }
 *
 * Per line, direction and day type of the model:
 *   departure_at  the first and the last departure, at the origin the sheet names, towards its destination (and in
 *                 the direction the feed resolved, when it did: a destination's name may recur on the way)
 *                 (no origin: not converted, origin_unknown)
 *   span          first departure no later than the first, last no earlier than the last
 *   headway_max   per band with a headway, measured between the first and the last departure (a band reaches
 *                 from max(band start, first) to min(band end, last): the headway holds there); a band the sheet
 *                 says has no service (« — ») has no clause of the vocabulary (no_service names days, not hours):
 *                 not converted, band_without_service — said, so ② records it to check by hand
 *   trips_count   when the sheet states the trips (a « Nb courses » column, or a timetable's trips): exactly
 *                 that many, towards the destination or in the direction the feed names; on a « les deux sens »
 *                 row only when the header says what the count is per (« par sens », « total »); otherwise
 *                 not converted (direction_unresolved) — never one row's count imposed on each direction. A
 *                 timetable whose trips carry notes the reader does not read (« (1) » in a « Renvois » row: such a
 *                 trip may not run every day) states between its other trips and all of them; those trips are
 *                 neither its first nor its last departure, nor among a grid's times below
 *   days          the day type runs (also when the sheet states only its count of trips); no_service where the
 *                 sheet says « pas de service » (« Di/JF »: Sundays, and the public holidays)
 * A desserte grid (an authority's specification: stops marked « oui », times at its timing stops) states its times
 * where it writes them: departure_at at each timing stop with every time given there (an arrival where a trip
 * ends: at the last stop, or at a timing stop a short working stops at), never as departures from the origin unless
 * the times are at the origin (then span too); its count of
 * trips is trips_count when every trip is written (a band's columns are no count of its trips); a band over untimed
 * trips is headway_max, measured at the stop the band is written at (`stop`: its row's — the grid's timing stop).
 * A short working (a trip of a timetable whose last stop timed or served is before its last row) goes towards the
 * stop it ends at, never the destination: its departures say so (towards that stop), its arrival there names no
 * destination (the direction the feed resolved), and a count towards the destination counts only the trips that
 * reach it — on a feed running exactly the timetable, every clause of it holds.
 * A summary table (per direction and day type: « Courses », « Amplitude », « Fréquence »):
 *   trips_count   « Courses » towards the direction it names
 *   span          « Amplitude 7:50 - 20:05 »: first_before / last_after; measured « at the timing stop » (the
 *                 label says so) it is an assumption (status « assumed »): the vocabulary's span measures the
 *                 departures at the terminus, which the person confirms or edits. Beside the sheet's own timetable
 *                 of that line and day type it is no clause: the timetable's times at each timing stop are
 *                 clauses and hold it, while the span, measured at the terminus, would fail a direction timed at
 *                 its arrival (the times at the timing stop are not departures from the terminus) — and a summary
 *                 that names its directions the other way round than its grids would fail both
 *   headway       « Fréquence 60 » states no hours: not converted (headway_without_window) — the sheet's own
 *                 timetables show longer gaps than its « fréquence » (a nominal interval, not a maximum over the
 *                 span), and a headway_max over a window the sheet does not give would be a guess; beside the
 *                 sheet's own timetable of that line and day type it is not even said (the timetable's times and
 *                 bands are the clauses: nothing is left « à vérifier à la main » for it)
 * The scope of each clause: the day type's day (« LàV » weekday, « Sa » saturday…), its period (« scolaire »
 * school_days, « vacances » school_holidays, with the zone a title names), the period's dates (from_date,
 * to_date). A day type read without its days (« Scolaire » alone: the weekdays assumed) gives clauses of
 * status « assumed ».
 *
 * Directions: span and headway_max measure one direction ("0" / "1"), which a sheet names in words (« Aller »,
 * a destination). `resolveDirection(line, { direction, destination })` — given when a feed is loaded — says which
 * direction of the feed it is; without it, or when it cannot tell, those clauses are not converted
 * (direction_unresolved) unless the sheet says « les deux sens » (each direction must hold: no direction).
 * Nothing is guessed.
 */

"use strict";

const conformance = require("../network/conformanceService");
const { nameKey } = require("../network/networkSpec")._internals;
const { clauseText } = require("../transform/clauseText");

const iso = (v) => (typeof v === "string" ? v : null);

/**
 * Which call of the stop a grid row means, when the grid names the same stop on several rows (a line crossing
 * several villages' « Centre Bourg », a loop back to its origin): "first", "last" or the row's rank among them.
 * Nothing when the name stands once — the measure reads the one call, and the clause keeps its id.
 */
const occurrenceOf = (stops, j) => {
  const key = nameKey(stops[j]?.value);
  const same = stops.map((s, k) => (nameKey(s?.value) === key ? k : -1)).filter((k) => k >= 0);
  if (same.length < 2) return {};
  return { occurrence: j === same[same.length - 1] ? "last" : j === same[0] ? "first" : same.indexOf(j) + 1 };
};

/** The scope params of a day type entry: day, period, region, from_date, to_date. */
const scopeOf = (d) => {
  const t = d.day_type?.value || null;
  const out = {};
  if (t) out.day = ["weekday", "saturday", "sunday", "daily", "weekend", "mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(t.day) ? t.day : t.days;
  const p = d.period?.value || {};
  const name = t?.period || p.name || null;
  if (name) out.period = name;
  if (name && d.region?.value) out.region = d.region.value;
  if (iso(p.from)) out.from_date = p.from;
  if (iso(p.to)) out.to_date = p.to;
  return out;
};

const sourceOf = (file, v) => `${file} · ${v.sheet}${v.cell ? `!${v.cell}` : ""}`.slice(0, 120);

/**
 * The clauses of a parsed offer (see the header). Ids are content ids (conformanceService): the same promise read
 * twice is one clause, kept with its first cell.
 */
const clausesOf = (model, { resolveDirection = null, lang = "fr" } = {}) => {
  const file = model.file?.name || "offre";
  const out = new Map();
  const notConverted = [];
  const skip = (v, kind, reason) => notConverted.push({ sheet: v?.sheet || null, cell: v?.cell || null, kind, reason, text: String(v?.text ?? "").slice(0, 120) });
  const add = (kind, params, from, { assumed = false } = {}) => {
    const c = conformance.normalizeClause({ kind, level: "must", status: assumed ? "assumed" : "stated", params, quote: from.text || String(from.value ?? ""), source: sourceOf(file, from), document: file });
    if (!c || out.has(c.id)) return;
    out.set(c.id, { ...c, text: clauseText(c, lang) });
  };
  // The line, direction and day types the sheet gives a timetable of (its own times: a summary's span at a timing stop
  // beside it is no clause of its own, see the header). The direction is the feed's when it resolves, else the
  // destination's words; a row for both directions stands beside any timetable of its line and day type.
  const dayOf = (line, scope) => JSON.stringify([String(line), Array.isArray(scope.day) ? scope.day.join(",") : scope.day || null, scope.period || null]);
  const sideOf = (l) => {
    if (l.direction?.value === "both") return "*";
    const towards = l.destination?.value || null;
    const dir = typeof resolveDirection === "function" ? resolveDirection(l.line.value, { direction: l.direction?.value || null, destination: towards }) : null;
    if (dir === "0" || dir === "1") return `d:${dir}`;
    const words = String(towards || l.direction?.value || "").trim().toLowerCase();
    return words ? `n:${words}` : "*";
  };
  const timetables = new Map();
  for (const l of model.lines) {
    if (!l.line?.value) continue;
    for (const d of l.day_types) {
      if (!d.day_type || !d.timetable) continue;
      const k = dayOf(l.line.value, scopeOf(d));
      if (!timetables.has(k)) timetables.set(k, new Set());
      timetables.get(k).add(sideOf(l));
    }
  }
  const timetabled = (l, scope) => {
    const sides = timetables.get(dayOf(l.line.value, scope));
    if (!sides) return false;
    const side = sideOf(l);
    return side === "*" || sides.has("*") || sides.has(side);
  };
  for (const l of model.lines) {
    const line = l.line?.value;
    if (!line) {
      for (const d of l.day_types) skip(d.first || d.day_type || l.destination, "line", "line_unknown");
      continue;
    }
    const towards = l.destination?.value || null;
    const both = l.direction?.value === "both";
    let direction = null;
    if (!both && typeof resolveDirection === "function") direction = resolveDirection(line, { direction: l.direction?.value || null, destination: towards });
    for (const d of l.day_types) {
      if (!d.day_type) {
        // Said by the title that names no day type (« FHD »), where the sheet has one: what the person reads there.
        const ref = String(d.day_title?.ref || "");
        skip(d.day_title ? { sheet: ref.slice(0, ref.lastIndexOf("!")), cell: ref.slice(ref.lastIndexOf("!") + 1), text: d.day_title.text } : d.first || l.line, "day_type", "day_type_unknown");
        continue;
      }
      const scope = scopeOf(d);
      const assumed = Boolean(d.day_type.value.assumed);
      if (d.no_service) {
        add("no_service", { line, days: Array.isArray(scope.day) ? scope.day : [scope.day], ...(scope.period ? { period: scope.period } : {}), ...(scope.region ? { region: scope.region } : {}), ...(scope.from_date ? { from_date: scope.from_date } : {}), ...(scope.to_date ? { to_date: scope.to_date } : {}) }, d.no_service, { assumed });
        if (d.day_type.value.holidays) add("no_service", { line, period: "public_holidays", ...(scope.from_date ? { from_date: scope.from_date } : {}), ...(scope.to_date ? { to_date: scope.to_date } : {}) }, d.no_service, { assumed });
        continue;
      }
      const trips = d.trips && Number.isInteger(d.trips.value) ? d.trips : null;
      if (!d.first && !d.last && !d.bands.length && !d.timetable && !trips && !d.span && !d.headway) continue;
      add("days", { line, days: Array.isArray(scope.day) ? scope.day : [scope.day], ...(scope.period ? { period: scope.period } : {}), ...(scope.region ? { region: scope.region } : {}), ...(scope.from_date ? { from_date: scope.from_date } : {}), ...(scope.to_date ? { to_date: scope.to_date } : {}) }, d.day_type, { assumed });
      const dir = both ? {} : direction ? { direction } : null;
      const tt = d.timetable || null;
      const lastRow = tt ? tt.stops.length - 1 : -1;
      // Where a trip of the timetable goes from row j: the destination when it reaches the last row, else the stop it
      // ends at (a short working: « 08:30 vers Gare » — never towards a terminus it does not reach).
      const goesTo = (t, j) => {
        const e = endOf(t);
        return e === lastRow || e <= j ? towards : tt.stops[e].value;
      };
      if (tt?.grid) {
        // A grid's times at each of its timing stops, all of them: what the specification requires there.
        // A trip marked by a note the reader does not read (« (1) ») may not run every day: none of its times.
        const kept = tt.trips.filter((t) => !t.note);
        tt.stops.forEach((s, j) => {
          // Per stop, the times grouped by what each is there: a departure towards where its trip goes, or the arrival
          // of a trip ending there — at the last row towards the destination it reaches, at a short working's end
          // without one (it goes no further: the measure reads the arrival in the direction the feed resolved).
          const groups = new Map();
          for (const t of kept) {
            const x = t.times[j];
            if (!x || x.value == null) continue;
            const arrival = endOf(t) === j;
            const to = arrival && j !== lastRow ? null : goesTo(t, j);
            const k = JSON.stringify([arrival, to]);
            if (!groups.has(k)) groups.set(k, { arrival, to, at: [] });
            groups.get(k).at.push(x);
          }
          for (const { arrival, to, at } of groups.values()) {
            at.sort((a, b) => a.sec - b.sec);
            const times = [...new Set(at.map((x) => x.value))];
            // The direction the feed resolved beside the destination's name: a recurring name (a terminus that is also
            // a village on the way) never counts the other direction's trips; the row's occurrence says which call.
            add("departure_at", { line, stop: s.value, ...occurrenceOf(tt.stops, j), times, ...(to ? { towards: to } : {}), ...(dir || {}), ...(arrival ? { event: "arrival" } : {}), ...scope }, at[0], { assumed });
          }
        });
      } else {
        // The first and the last departure, at the origin the sheet names, towards its destination — read from a
        // timetable, at the stop its trip leaves from and towards where that trip goes.
        for (const v of [d.first, d.last]) {
          if (!v) continue;
          const t = tt && v.cell ? tt.trips.find((x) => x.times.some((y) => y && y.cell === v.cell && y.sheet === v.sheet)) : null;
          const j = t ? t.times.findIndex((y) => y && y.cell === v.cell && y.sheet === v.sheet) : -1;
          const to = t ? goesTo(t, j) : towards;
          const at = j > 0 ? { stop: tt.stops[j].value, ...occurrenceOf(tt.stops, j) } : l.origin ? { stop: l.origin.value } : null;
          if (!at) skip(v, "departure_at", "origin_unknown");
          else add("departure_at", { line, ...at, times: [v.value], ...(to ? { towards: to } : {}), ...(dir || {}), ...scope }, v, { assumed });
        }
      }
      if (d.first || d.last) {
        if (!dir) skip(d.first || d.last, "span", "direction_unresolved");
        else add("span", { line, ...(d.first ? { first_before: d.first.value } : {}), ...(d.last ? { last_after: d.last.value } : {}), ...dir, ...scope }, d.first || d.last, { assumed });
      }
      // A summary's span: measured at a timing stop the row does not name, an assumption — none beside the timetable.
      if (d.span && !(d.span.at_stop && timetabled(l, scope))) {
        if (!dir) skip(d.span, "span", "direction_unresolved");
        else add("span", { line, first_before: d.span.value.first, last_after: d.span.value.last, ...dir, ...scope }, d.span, { assumed: assumed || Boolean(d.span.at_stop) });
      }
      // A summary's nominal frequency states no hours: beside the sheet's own timetable of that line, direction and
      // day type it adds nothing (the timetable's times and bands are the clauses); alone, it is said
      // (headway_without_window) — a direction the sheet gives no timetable of is alone.
      if (d.headway && !timetabled(l, scope)) skip(d.headway, "headway_max", "headway_without_window");
      for (const b of d.bands) {
        const hw = b.headway_min?.value;
        if (hw == null) {
          skip(b.headway_min, "headway_max", "band_without_service");
          continue;
        }
        // A grid's band is written on a stop's row (its timing stop): the headway is promised there, over the band's
        // own hours — a grid's first and last are those of its timed trips, never the bounds of its bands. An offer
        // table's band is held within the day's first and last departure; one wholly outside them has no service.
        const row = d.timetable?.grid ? bandRow(d.timetable, b) : -1;
        const from = row < 0 && d.first ? Math.max(b.from.sec, d.first.sec) : b.from.sec;
        const to = row < 0 && d.last ? Math.min(b.to.sec, d.last.sec) : b.to.sec;
        if (to <= from) {
          skip(b.headway_min, "headway_max", "band_without_service");
          continue;
        }
        if (!dir) {
          skip(b.headway_min, "headway_max", "direction_unresolved");
          continue;
        }
        add("headway_max", { line, from: hm(from), to: hm(to), minutes: hw, ...(row >= 0 ? { stop: d.timetable.stops[row].value, ...occurrenceOf(d.timetable.stops, row) } : {}), ...dir, ...scope }, b.headway_min, { assumed });
      }
      if (trips) {
        // The timetable's own count, towards its destination, counts the trips that reach it (its last row): a short
        // working ending before is no trip « vers » a terminus it does not reach (its times say where it goes) — none
        // reaching it, the count is the direction's alone.
        const own = tt && towards && trips.cell === tt.range && trips.value === tt.trips.length ? tt.trips.filter((t) => endOf(t) === lastRow) : null;
        const counted = own && own.length < trips.value ? { value: own.length, noted: own.filter((t) => t.note).length } : trips;
        const dest = towards && counted.value > 0 ? towards : null;
        // Whose count it is: towards the destination, the direction the feed names, or both directions as the
        // header says (« par sens », « total ») — else nobody can tell, and it is said.
        const whose = dest ? { towards: dest, ...(dir || {}), per: "total" } : dir?.direction ? { ...dir, per: "total" } : both && trips.per ? { per: trips.per } : null;
        const all = dest ? counted : trips;
        // Trips marked by a note the reader does not read (`noted`: « (1) ne circule pas pendant les vacances »): the
        // count holds between the trips without one and all of them (at most all of them when every trip has one) —
        // never « exactly » what a note may lower.
        const unmarked = all.value - (all.noted || 0);
        const count = !all.noted ? { exactly: all.value } : unmarked > 0 ? { min: unmarked, max: all.value } : { max: all.value };
        if (!whose) skip(trips, "trips_count", "direction_unresolved");
        else add("trips_count", { line, ...count, ...whose, ...scope }, trips, { assumed });
      }
    }
  }
  return { clauses: [...out.values()], not_converted: notConverted };
};

const hm = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`;

/** The row a trip of a timetable ends at: its last stop timed or marked served (-1 when it has none). */
const endOf = (t) => t.times.reduce((k, x, i) => (x && !x.pass && (x.value != null || x.served) ? i : k), -1);

/** The row of a grid a band is written on (the index of its stop), or -1 when the band is not the grid's. */
const bandRow = (tt, band) => {
  // Every cell the band was read from (the same band typed again on each of its columns is cited, not repeated).
  const cells = band.headway_min?.cells || (band.headway_min?.cell ? [band.headway_min.cell] : []);
  if (!cells.length) return -1;
  for (const t of tt.trips) {
    const j = t.times.findIndex((x) => x && x.band && cells.includes(x.cell) && x.sheet === band.headway_min.sheet);
    if (j >= 0) return j;
  }
  return -1;
};

module.exports = { clausesOf, scopeOf };
