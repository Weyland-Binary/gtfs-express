/**
 * spreadsheet/operations — the offer a sheet states, as build_timetable
 * operations (transform/operators/buildTimetable), one per line, direction
 * and day type: the timetables a sheet states, built by the engine
 * (the build_timetable suites read sheets through it; eval/tools/spreadsheet-check
 * counts them).
 *
 *   offerOperations(model) → { operations: [{ type: "build_timetable", params, source, label, incomplete? }],
 *                              skipped: [{ label, reason, sheet, cell, times?, times_more?, title?, pending? }] }
 *                              (`title` + `pending`: a grid under a title naming no day type — the title as written and
 *                              its operation, whole but for its days: built once the person says which days it runs;
 *                              `times`: a grid's own trips, the ranges of their time cells — see timesOf)
 *   operationsOf(model)    → offerOperations(model).operations
 *
 * The params say only what the sheet says: the line, the direction (its destination, or a GTFS direction_id a
 * « direction_id » column states: the engine resolves it, or asks), the day type and its period (days, period,
 * region, from_date, to_date), and either first / last / bands, or the timetable (stops × trips, with the trip
 * numbers; a stop a trip does not serve — « | », « — » in the sheet — is "pass", a cell left empty null). Never a
 * pattern, never the running times, never what to do with other patterns or dates without service: the engine
 * asks each of them when the feed makes it a question (« never guessing silently »). `source` cites the sheet:
 * { document, cells, quote, generated_by: "spreadsheet" } — the person who adds the operation makes it theirs
 * (author "user").
 *
 * A desserte grid (stops marked « oui », times at its timing stops) is a timetable too: « oui » null (served, the
 * time placed by the running times around the timing stop's), an empty cell or « … » "pass" (not served), its
 * times where the sheet writes them — at the first stop, the last or any between: the engine places the others.
 * Its timetable says so (`untimed: "served"`: a trip spans every stop it serves, timed or not), and nothing else:
 * the running times (the line's own: the grid gives none) and the trips of the direction's other stop patterns on
 * those dates are the questions the grid leaves (buildTimetable's running_times_missing and others_missing), never
 * a parameter written here.
 *
 * Nothing the sheet states is hidden:
 *   incomplete  a day type with a first or last departure but no band (bands_missing), or bands without its first
 *               and last departure (first_or_last_missing): the operation carries what the sheet gives, and the
 *               engine asks the rest (first_missing, last_missing, bands_missing) — never a row dropped; a grid's
 *               trips under a band cell (« 7h-9h : 15 min ») are the band's: the operation's timetable carries the
 *               band as the sheet states it (`timetable.bands`: its window, its headway, the stop it is written
 *               at, the stop patterns of its columns) and the engine places its departures (band_times: asked, or
 *               settled and said) — the day is never built without them; only a column of marks no band stands
 *               for has nothing to build it from (trips_without_time)
 *   skipped     a day type that gives no operation, and why: line_unknown, direction_unresolved (no destination
 *               nor direction_id: « Aller », « Sens 1 » or « les deux sens » name no direction of the feed),
 *               day_type_unknown, trips_without_time (a grid none of whose trips has a time)
 * A day type without service, or one stating nothing to build (no departure, no band, no timetable — a summary
 * table's counts, span and frequency are clauses, not a timetable), gives none and is not listed (its clauses say
 * what it states).
 */

"use strict";

const { scopeOf } = require("./clauses");

const hm = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`;
const at = (v) => (v && v.cell ? `${v.sheet}!${v.cell}` : null);

/** A timetable cell as the operation's params carry it: its time, "pass" (not served), or null (no time given). */
const stopTime = (x) => (x && x.value != null ? x.value : x && x.pass ? "pass" : null);

/**
 * The bands a desserte grid states over trips it gives no time (« 7h – 19h : 12 min » merged over columns), as the
 * operation's timetable carries them: [{ from, to, headway_min, stop (the index of the row the band is written on:
 * the departures are read there), trips: [[null | "pass" per stop]] (the stop patterns of the columns the band
 * covers, each once, in the sheet's order: the band's trips serve them in turn), columns (how many it covers) }].
 * A band no column stands under (an offer table's, beside the grid) is none of the grid's. A column of marks left
 * without a time right after a band's column (the band's cell written once, not merged over the columns it stands
 * for) is that band's too.
 */
const gridBands = (d) => {
  const tt = d.timetable;
  // The columns under each band cell (a merged cell reads as itself on each column it covers), in the sheet's order.
  const byCell = new Map();
  let current = null;
  for (const t of tt.trips) {
    if (!t.untimed) {
      current = null;
      continue;
    }
    const j = t.times.findIndex((x) => x && x.band);
    if (j >= 0) {
      const key = `${t.times[j].sheet}!${t.times[j].cell}`;
      if (!byCell.has(key)) byCell.set(key, { stop: j, cols: [] });
      current = byCell.get(key);
    }
    if (current) current.cols.push(t);
  }
  const out = [];
  for (const b of d.bands || []) {
    const hw = b.headway_min?.value;
    // Every cell the band was read from: typed once (merged or not), or again on each of its columns (cited).
    const found = (b.headway_min?.cells || (b.headway_min?.cell ? [b.headway_min.cell] : [])).map((cell) => byCell.get(`${b.headway_min.sheet}!${cell}`)).filter(Boolean);
    const under = found.length ? { stop: found[0].stop, cols: found.flatMap((x) => x.cols) } : null;
    if (hw == null || !under) continue;
    const rows = [];
    for (const t of under.cols) {
      const row = t.times.map((x, j) => (j !== under.stop && x && x.pass ? "pass" : null));
      if (!rows.some((r) => JSON.stringify(r) === JSON.stringify(row))) rows.push(row);
    }
    out.push({ from: b.from.value, to: b.to.value, headway_min: hw, stop: under.stop, trips: rows, columns: under.cols.length });
  }
  return out;
};

/**
 * The cells of a grid set aside that are its own trips' times, as ranges of its sheet: the columns of its trips, each
 * run of adjacent ones as one range over the rows of their block (the rows their cells span, a day continued in a
 * second block below the first apart) — never the stops' column, nor the columns of another day type beside it in
 * the same block; written across (its stops on one row), the rows of its trips over the columns their cells span. A
 * grid the change does not take is said covered by an operation of the change only where that operation copied those
 * very cells (the web's sheetCoverage: its anchor alone — a stop's name, a title — is shared with the block's other
 * day types). → { times: [ranges], times_more? } ({} without a grid; past MAX_SKIPPED_TIMES
 * ranges the rest is counted, and the web never says such a grid wholly covered).
 */
const MAX_SKIPPED_TIMES = 40;
const ADDRESS = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/;
const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colLetters = (n) => (n > 0 ? `${colLetters(Math.floor((n - 1) / 26))}${String.fromCharCode(65 + ((n - 1) % 26))}` : "");
const timesOf = (d) => {
  const tt = d.timetable;
  const sheet = tt?.stops?.[0]?.sheet;
  if (!tt || !sheet) return {};
  // Which way its trips run: down their columns, or — a timetable written across, its stops on one row — along their
  // rows. Each trip is then a line of cells on that axis (`line`: its column, or its row) over a stretch of the other
  // (`lo`…`hi`: its rows, or its columns): « B4:E4 » is one trip of a timetable written across, never « B4 » alone.
  const stopAt = tt.stops.map((s) => (s?.cell ? ADDRESS.exec(s.cell) : null));
  const across = stopAt.length > 1 && stopAt.every((m) => m && m[2] === stopAt[0][2]) && new Set(stopAt.map((m) => m[1])).size === stopAt.length;
  const axis = (m) => (across ? { line: Number(m[2]), at: colIndex(m[1]) } : { line: colIndex(m[1]), at: Number(m[2]) });
  // Each trip: its line and the stretch of its cells (a band's cell merged over several columns is cited at its first
  // one: the trip's own column is that of its other cells).
  const spans = [];
  for (const t of tt.trips) {
    const cells = (t.times || []).filter((x) => x && x.cell && x.sheet === sheet);
    const own = cells.filter((x) => !x.band);
    const at = (own.length ? own : cells).map((x) => ADDRESS.exec(x.cell)).filter(Boolean).map(axis);
    if (!at.length) continue;
    const stretch = at.filter((x) => x.line === at[0].line).map((x) => x.at);
    spans.push({ line: at[0].line, lo: Math.min(...stretch), hi: Math.max(...stretch) });
  }
  // The blocks: the trips whose stretches meet, together (a second block of the same day type, below, is another).
  spans.sort((a, b) => a.lo - b.lo);
  const blocks = [];
  for (const s of spans) {
    const last = blocks[blocks.length - 1];
    if (last && s.lo <= last.hi) {
      last.hi = Math.max(last.hi, s.hi);
      last.lines.add(s.line);
    } else blocks.push({ lo: s.lo, hi: s.hi, lines: new Set([s.line]) });
  }
  // A range of adjacent trips: down, their columns over their rows; across, their stretch of columns over their rows.
  const rangeOf = (i, j, lo, hi) => {
    const [c0, r0, c1, r1] = across ? [lo, i, hi, j] : [i, lo, j, hi];
    return `${sheet}!${colLetters(c0)}${r0}${c0 === c1 && r0 === r1 ? "" : `:${colLetters(c1)}${r1}`}`;
  };
  const ranges = [];
  for (const b of blocks) {
    const lines = [...b.lines].sort((x, y) => x - y);
    for (let i = 0; i < lines.length; i += 1) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j += 1;
      ranges.push(rangeOf(lines[i], lines[j], b.lo, b.hi));
      i = j;
    }
  }
  return ranges.length ? { times: ranges.slice(0, MAX_SKIPPED_TIMES), ...(ranges.length > MAX_SKIPPED_TIMES ? { times_more: ranges.length - MAX_SKIPPED_TIMES } : {}) } : {};
};

const offerOperations = (model) => {
  const file = model.file?.name || "offre";
  const operations = [];
  const skipped = [];
  for (const l of model.lines) {
    const line = l.line?.value;
    const dirWord = l.direction?.value;
    const direction = dirWord === "0" || dirWord === "1" ? dirWord : dirWord === "both" ? null : l.destination?.value || null;
    for (const d of l.day_types) {
      if (d.no_service) continue;
      const stated = d.timetable || d.first || d.last || d.bands.length;
      if (!stated) continue;
      const label = `${line || "?"} · ${l.destination?.value || dirWord || (l.sens ? `${l.sens.text || l.sens.value}` : "?")} · ${d.day_type?.value?.label || d.day_type?.value?.day || d.day_title?.text || "?"}`;
      const first = d.first || d.last || d.timetable?.stops?.[0] || d.bands[0]?.headway_min || d.day_type;
      const timed = d.timetable ? d.timetable.trips.filter((t) => !t.untimed) : null;
      const bands = d.timetable?.grid ? gridBands(d) : [];
      const reason = !line ? "line_unknown" : !direction ? "direction_unresolved" : timed && !timed.length && !bands.length ? "trips_without_time" : !d.day_type ? "day_type_unknown" : null;
      // A grid whose only gap is its day type, under a title the reader kept (« FHD »): its timetable is built all the
      // same, without its days, and waits with the skipped block (`pending`, `title`) for the person to say them.
      const waits = reason === "day_type_unknown" && Boolean(d.day_title && d.timetable);
      if (reason && !waits) {
        skipped.push({ label, reason, sheet: first?.sheet || null, cell: first?.cell || null, ...timesOf(d) });
        continue;
      }
      const scope = d.day_type ? scopeOf(d) : {};
      const days = scope.day;
      const { day: _d, ...dates } = scope; // eslint-disable-line no-unused-vars
      const params = { route: line, direction, days, ...dates };
      const cells = [];
      let incomplete = null;
      if (d.timetable) {
        params.timetable = { stops: d.timetable.stops.map((s) => s.value), trips: timed.map((t) => t.times.map(stopTime)), ...(d.timetable.grid ? { untimed: "served" } : {}), ...(bands.length ? { bands: bands.map(({ columns: _c, ...b }) => b) } : {}) };
        if (timed.some((t) => t.number)) params.timetable.numbers = timed.map((t) => (t.number ? t.number.value : null));
        cells.push(`${d.timetable.stops[0].sheet}!${d.timetable.range}`);
        // Trips without a time that no band stands for (« oui » marks alone): nothing to build them from, said.
        const underBand = bands.reduce((n, b) => n + b.columns, 0);
        if (timed.length + underBand < d.timetable.trips.length) incomplete = "trips_without_time";
      } else {
        // What the sheet gives, all of it: the engine asks what is missing (first_missing, last_missing, bands_missing).
        if (d.first) params.first = d.first.value;
        if (d.last) params.last = d.last.value;
        if (d.bands.length) params.bands = d.bands.map((b) => ({ from: hm(b.from.sec), to: hm(b.to.sec), headway_min: b.headway_min?.value ?? null }));
        cells.push(at(d.first), at(d.last), ...d.bands.map((b) => at(b.headway_min)));
        if (!d.bands.length) incomplete = "bands_missing";
        else if (!d.first || !d.last) incomplete = "first_or_last_missing";
      }
      const operation = { type: "build_timetable", params, label, ...(incomplete ? { incomplete } : {}), source: { document: file, cells: [...new Set(cells.filter(Boolean))].slice(0, 40), quote: d.day_type ? d.day_type.text || d.day_type.value.label || "" : d.day_title.text, generated_by: "spreadsheet" } };
      if (waits) {
        const ref = String(d.day_title.ref || "");
        skipped.push({ label, reason, sheet: ref.slice(0, ref.lastIndexOf("!")) || null, cell: ref.slice(ref.lastIndexOf("!") + 1) || null, ...timesOf(d), title: String(d.day_title.text).slice(0, 60), pending: operation });
      }
      else operations.push(operation);
    }
  }
  return { operations, skipped };
};

const operationsOf = (model) => offerOperations(model).operations;

module.exports = { offerOperations, operationsOf };
