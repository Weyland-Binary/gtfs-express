/**
 * transform/sheetGrid — a timetable grid of a brief's spreadsheet read by its cells: the direct mode's read_grid
 * (the agent reads the brief and puts it in a form the engine checks). The model says WHERE the grid is — the cells of the stop names, the cells of the times, which
 * way a trip runs — and this module copies what those cells say: a time is never retyped by the model (one wrong
 * digit among hundreds, and the output tokens of every time), and a cell that is neither a time, a « served » mark,
 * a « not served » mark nor empty stays in the grid AS WRITTEN (`unread`, with its reason): build_timetable asks the
 * person about it (time_invalid) — never a stop served, nor a stop passed, by guess.
 *
 *   readGrid(book, { sheet, stops, times, trips?, numbers?, empty?, skip? }) →
 *     { timetable: { stops, trips, numbers?, untimed? }, sheet, cells: ["Feuil1!A5:A12", …], positions: [the sheet
 *       position of each trip kept], size: { stops, trips, timed }, unread: [{ cell, text, reason }], unread_more?,
 *       without_time: [positions], left_out: [{ trip, cells }], left_out_cells: ["Feuil1!D5:E12", "Feuil1!D4:E4"],
 *       after_midnight: [positions] } | { error }
 *            `cells` cites the ranges as given (the stops, the times, the numbers); `left_out_cells` the cells of those
 *            ranges the grid does NOT copy — the times and the number of each trip left out (skip), consecutive trips
 *            in one range —, so that what an operation built from the grid is said to cover never includes a column
 *            it left out (the web's sheetCoverage: a remark « puis toutes les 15 min » in a skipped column stays the
 *            person's to check)
 *   book     readWorkbook's result (spreadsheet/workbook)
 *   sheet    the sheet's name (case and spaces aside)
 *   stops    the range of the stop names, in the order the trips run: one column (trips "columns": each column of
 *            `times` is one trip, the stops down the rows) or one row (trips "rows": each row of `times` is one trip);
 *            written backwards (« A20:A5 ») it is read backwards — the trips run up the sheet
 *   times    the range of the times: along the stops' axis exactly the rows (or columns) of `stops`
 *   numbers  the range of the trip numbers, one per trip, along the trips' axis (optional)
 *   empty    what an empty cell of `times` means: "pass" (default — a fiche horaire leaves blank the stops a trip does
 *            not serve) or "untimed" (served, its time placed by the running times: a grid timed at its timing
 *            points only)
 *   skip     the trips to leave out, by their position along the trips' axis (1: the first column, or row, of
 *            `times`): a column that is no trip (« puis toutes les 15 min », remarks) — said back with its cells
 * A served mark (« oui », « x », « ✓ ») is a stop served without its time (timetable.untimed "served"); a pass mark
 * (« | », « — », « … ») a stop the trip does not serve ("pass"); a band written over trips (« 7h-9h : 15 min ») is
 * no time of a trip (unread, reason "band": its column is left out with `skip`, the band written in
 * timetable.bands). A time before 06:00 read after one past 18:00 — in reading order, trip after trip and stop after
 * stop, as the cell reader reads (spreadsheet/parser) — is past midnight on the same service day (« 0:40 » → 24:40).
 * The bounds are build_timetable's: a grid past them is refused here, before any cell is read.
 */

"use strict";

const XLSX = require("xlsx");
const { cellAt } = require("../spreadsheet/workbook");
const V = require("../spreadsheet/values");
const { _internals: BT } = require("./operators/buildTimetable");

const RANGE = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})\s*(?::\s*\$?([A-Za-z]{1,3})\$?(\d{1,7}))?\s*$/;
// The unread cells listed at most (the rest counted).
const MAX_UNREAD = 40;
// What an unread cell keeps of its text in the grid (the engine's question quotes it).
const MAX_CELL_TEXT = 80;
// After midnight, as the cell reader reads it (spreadsheet/parser: NIGHT_BEFORE, EVENING_AFTER).
const NIGHT_BEFORE = 6 * 3600;
const EVENING_AFTER = 18 * 3600;

/**
 * A range as the model writes it (« B5:H12 », « A5 », « $A$5:$A$12 »): { s: { r, c }, e: { r, c }, back: { r, c } }
 * | null — `back`: the range was written from its last row (or column) to its first.
 */
const rangeOf = (text) => {
  const m = RANGE.exec(String(text ?? ""));
  if (!m) return null;
  const a = XLSX.utils.decode_cell(`${m[1].toUpperCase()}${m[2]}`);
  const b = m[3] ? XLSX.utils.decode_cell(`${m[3].toUpperCase()}${m[4]}`) : a;
  return { s: { r: Math.min(a.r, b.r), c: Math.min(a.c, b.c) }, e: { r: Math.max(a.r, b.r), c: Math.max(a.c, b.c) }, back: { r: a.r > b.r, c: a.c > b.c } };
};
const refOf = (range) => XLSX.utils.encode_range({ s: range.s, e: range.e });
const cellRef = (r, c) => XLSX.utils.encode_cell({ r, c });
const keyOf = (s) => String(s ?? "").normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");

/** What one cell of the times says: a time ({ sec }), "pass", "served", null (empty) — or why it cannot be read. */
const valueOf = (cell) => {
  if (!cell) return { value: null };
  const text = V.textOf(cell);
  // A band over trips first: « 7h-9h : 15 min » begins like a time.
  if (text && V.bandHeadwayOf(text)) return { unread: text, reason: "band" };
  const t = V.timeOf(cell);
  if (t && t.sec != null) return { sec: t.sec };
  if (t && t.error) return { unread: text, reason: t.error };
  if (!text) return { value: null };
  if (V.isPassMark(text)) return { value: "pass" };
  if (V.isServedMark(text)) return { value: "served" };
  return { unread: text, reason: "not_a_time" };
};

const readGrid = (book, { sheet, stops, times, trips = "columns", numbers = null, empty = "pass", skip = null } = {}) => {
  const sheets = Array.isArray(book?.sheets) ? book.sheets : [];
  const ws = sheets.find((s) => s.name === sheet) || sheets.find((s) => keyOf(s.name) === keyOf(sheet));
  if (!ws) return { error: `no sheet "${String(sheet ?? "")}" in the workbook (its sheets: ${sheets.map((s) => `"${s.name}"`).join(", ") || "none"})` };
  if (!["columns", "rows"].includes(trips)) return { error: `trips is "columns" (each column of times is one trip) or "rows" (each row is one trip), not "${String(trips)}"` };
  if (!["pass", "untimed"].includes(empty)) return { error: `empty is "pass" or "untimed", not "${String(empty)}"` };
  const S = rangeOf(stops);
  const T = rangeOf(times);
  if (!S) return { error: `stops "${String(stops ?? "")}" is not a range of cells (e.g. A5:A20)` };
  if (!T) return { error: `times "${String(times ?? "")}" is not a range of cells (e.g. B5:H20)` };
  const byColumn = trips === "columns";
  // The stops along one axis; the times aligned with them on that axis, one trip per line of the other.
  if (byColumn ? S.s.c !== S.e.c : S.s.r !== S.e.r) return { error: `stops ${refOf(S)} must be one ${byColumn ? "column" : "row"} (trips "${trips}")` };
  const aligned = byColumn ? T.s.r === S.s.r && T.e.r === S.e.r : T.s.c === S.s.c && T.e.c === S.e.c;
  if (!aligned) return { error: `times ${refOf(T)} must span exactly the ${byColumn ? "rows" : "columns"} of the stops ${refOf(S)}: one cell per stop for each trip` };
  const nStops = byColumn ? S.e.r - S.s.r + 1 : S.e.c - S.s.c + 1;
  const nTrips = byColumn ? T.e.c - T.s.c + 1 : T.e.r - T.s.r + 1;
  // The bounds of build_timetable, before any cell is read.
  if (nStops < 2) return { error: `a timetable runs between two stops at least: ${refOf(S)} holds ${nStops}` };
  if (nStops > BT.MAX_TIMETABLE_STOPS) return { error: `${nStops} stops: a timetable holds ${BT.MAX_TIMETABLE_STOPS} at most` };
  if (nTrips > BT.MAX_TRIPS) return { error: `${nTrips} trips: a timetable holds ${BT.MAX_TRIPS} at most` };
  let N = null;
  if (numbers != null && numbers !== "") {
    N = rangeOf(numbers);
    if (!N) return { error: `numbers "${String(numbers)}" is not a range of cells` };
    const ok = byColumn ? N.s.r === N.e.r && N.s.c === T.s.c && N.e.c === T.e.c : N.s.c === N.e.c && N.s.r === T.s.r && N.e.r === T.e.r;
    if (!ok) return { error: `numbers ${refOf(N)} must give one number per trip, along the ${byColumn ? "columns" : "rows"} of the times ${refOf(T)}` };
  }
  // The trips left out, by their position along the trips' axis: whole numbers within the grid, never all of them.
  const skipped = new Set();
  if (skip != null) {
    const list = Array.isArray(skip) ? skip : [skip];
    for (const x of list) {
      const n = Number(x);
      if (!Number.isInteger(n) || n < 1 || n > nTrips) return { error: `skip lists trip positions from 1 to ${nTrips} (the ${byColumn ? "columns" : "rows"} of the times ${refOf(T)}), not "${String(x)}"` };
      skipped.add(n);
    }
    if (skipped.size >= nTrips) return { error: `skip leaves no trip of the times ${refOf(T)}` };
  }
  // The stop at index i, in the order the stops range was written (backwards: the trips run up the sheet, or left).
  const back = byColumn ? S.back.r : S.back.c;
  const along = (i) => (back ? nStops - 1 - i : i);
  const at = (i, j) => (byColumn ? [S.s.r + along(i), T.s.c + j] : [T.s.r + j, S.s.c + along(i)]);
  const unread = [];
  let unreadMore = 0;
  const note = (r, c, text, reason) => {
    if (unread.length < MAX_UNREAD) unread.push({ cell: `${ws.name}!${cellRef(r, c)}`, text: String(text).slice(0, MAX_CELL_TEXT), reason });
    else unreadMore += 1;
  };
  // The stop names, as written (a name without text is no stop: refused, its cell named).
  const names = [];
  for (let i = 0; i < nStops; i++) {
    const r = byColumn ? S.s.r + along(i) : S.s.r;
    const c = byColumn ? S.s.c : S.s.c + along(i);
    const text = V.textOf(cellAt(ws, r, c));
    if (!text) return { error: `stop cell ${ws.name}!${cellRef(r, c)} is empty: give the range of the stop names only` };
    names.push(text.slice(0, 200));
  }
  let served = false;
  let latest = -Infinity;
  const rows = [];
  const positions = [];
  const without = [];
  const leftOut = [];
  const late = [];
  let timed = 0;
  for (let j = 0; j < nTrips; j++) {
    if (skipped.has(j + 1)) {
      const [r0, c0] = at(0, j);
      const [r1, c1] = at(nStops - 1, j);
      leftOut.push({ trip: j + 1, cells: `${ws.name}!${XLSX.utils.encode_range({ s: { r: Math.min(r0, r1), c: Math.min(c0, c1) }, e: { r: Math.max(r0, r1), c: Math.max(c0, c1) } })}` });
      continue;
    }
    const row = [];
    let any = false;
    let shifted = false;
    for (let i = 0; i < nStops; i++) {
      const [r, c] = at(i, j);
      const got = valueOf(cellAt(ws, r, c));
      if (got.unread != null) {
        // Kept as written: the engine asks the person about it (time_invalid) — never read as a stop served or passed.
        note(r, c, got.unread, got.reason);
        row.push(String(got.unread).slice(0, MAX_CELL_TEXT));
        continue;
      }
      if (got.sec != null) {
        const sec = got.sec < NIGHT_BEFORE && latest >= EVENING_AFTER ? got.sec + 86400 : got.sec;
        if (sec !== got.sec) shifted = true;
        latest = Math.max(latest, sec);
        row.push(V.hhmm(sec));
        any = true;
      } else if (got.value === "served") {
        served = true;
        row.push(null);
      } else if (got.value === null) row.push(empty === "pass" ? "pass" : null);
      else row.push(got.value);
    }
    if (any) timed += 1;
    else without.push(j + 1);
    if (shifted) late.push(j + 1);
    rows.push(row);
    positions.push(j + 1);
  }
  const nums = N
    ? positions.map((p) => {
        const j = p - 1;
        const text = V.textOf(cellAt(ws, byColumn ? N.s.r : N.s.r + j, byColumn ? N.s.c + j : N.s.c));
        return text ? text.slice(0, 30) : null;
      })
    : null;
  const timetable = { stops: names, trips: rows, ...(nums && nums.some(Boolean) ? { numbers: nums } : {}), ...(served || empty === "untimed" ? { untimed: "served" } : {}) };
  // The cells not copied: each run of consecutive trips left out, as one range of its times and one of its numbers.
  const runs = [];
  for (const p of [...skipped].sort((a, b) => a - b)) {
    const last = runs[runs.length - 1];
    if (last && last[1] === p - 1) last[1] = p;
    else runs.push([p, p]);
  }
  const notCopied = [];
  for (const [a, b] of runs) {
    const [j0, j1] = [a - 1, b - 1];
    notCopied.push(`${ws.name}!${XLSX.utils.encode_range(byColumn ? { s: { r: T.s.r, c: T.s.c + j0 }, e: { r: T.e.r, c: T.s.c + j1 } } : { s: { r: T.s.r + j0, c: T.s.c }, e: { r: T.s.r + j1, c: T.e.c } })}`);
    if (N) notCopied.push(`${ws.name}!${XLSX.utils.encode_range(byColumn ? { s: { r: N.s.r, c: N.s.c + j0 }, e: { r: N.s.r, c: N.s.c + j1 } } : { s: { r: N.s.r + j0, c: N.s.c }, e: { r: N.s.r + j1, c: N.s.c } })}`);
  }
  return {
    timetable,
    sheet: ws.name,
    cells: [`${ws.name}!${refOf(S)}`, `${ws.name}!${refOf(T)}`, ...(N ? [`${ws.name}!${refOf(N)}`] : [])],
    positions,
    size: { stops: nStops, trips: rows.length, timed },
    unread,
    ...(unreadMore ? { unread_more: unreadMore } : {}),
    without_time: without,
    left_out: leftOut,
    left_out_cells: notCopied,
    after_midnight: late,
  };
};

module.exports = { readGrid, _internals: { rangeOf, valueOf, MAX_UNREAD, MAX_CELL_TEXT } };
