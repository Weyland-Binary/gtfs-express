/**
 * The direct mode's read_grid: the model says WHERE a timetable grid is in a brief's spreadsheet (the stop names'
 * range, the times' range, which way a trip runs) and this module copies what the cells say. A time is never retyped
 * by the model (one wrong digit among hundreds); a cell that is neither a time, a served or pass mark nor empty stays
 * AS WRITTEN (`unread`) for build_timetable to ask about, never a stop served or passed by guess.
 * A stops range written backwards (« A20:A5 ») is read backwards. A time before 06:00 read after one past 18:00, in
 * reading order, is past midnight on the same service day (« 0:40 » → 24:40). `left_out_cells` names the skipped
 * columns' cells, so what the grid is said to cover never includes a column it left out.
 * `empty`: an empty time cell is a stop passed ("pass", as a printed timetable leaves it blank) or served
 * untimed ("untimed", a grid timed at its timing points only).
 */

"use strict";

const XLSX = require("xlsx");
const { cellAt } = require("../spreadsheet/workbook");
const { DAY_S, EARLY_MORNING_S } = require("../../utils/time");
const V = require("../spreadsheet/values");
const { _internals: BT } = require("./operators/buildTimetable");

const RANGE = /^\s*\$?([A-Za-z]{1,3})\$?(\d{1,7})\s*(?::\s*\$?([A-Za-z]{1,3})\$?(\d{1,7}))?\s*$/;
// Unread cells listed at most; the rest are counted.
const MAX_UNREAD = 40;
// The engine's question quotes an unread cell's text.
const MAX_CELL_TEXT = 80;
const EVENING_AFTER = 18 * 3600;

/** `back`: the range was written from its last row (or column) to its first. */
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
  if (byColumn ? S.s.c !== S.e.c : S.s.r !== S.e.r) return { error: `stops ${refOf(S)} must be one ${byColumn ? "column" : "row"} (trips "${trips}")` };
  const aligned = byColumn ? T.s.r === S.s.r && T.e.r === S.e.r : T.s.c === S.s.c && T.e.c === S.e.c;
  if (!aligned) return { error: `times ${refOf(T)} must span exactly the ${byColumn ? "rows" : "columns"} of the stops ${refOf(S)}: one cell per stop for each trip` };
  const nStops = byColumn ? S.e.r - S.s.r + 1 : S.e.c - S.s.c + 1;
  const nTrips = byColumn ? T.e.c - T.s.c + 1 : T.e.r - T.s.r + 1;
  // build_timetable's bounds, checked before any cell is read.
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
  const back = byColumn ? S.back.r : S.back.c;
  const along = (i) => (back ? nStops - 1 - i : i);
  const at = (i, j) => (byColumn ? [S.s.r + along(i), T.s.c + j] : [T.s.r + j, S.s.c + along(i)]);
  const unread = [];
  let unreadMore = 0;
  const note = (r, c, text, reason) => {
    if (unread.length < MAX_UNREAD) unread.push({ cell: `${ws.name}!${cellRef(r, c)}`, text: String(text).slice(0, MAX_CELL_TEXT), reason });
    else unreadMore += 1;
  };
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
        // Kept as written: the engine asks the person about it (time_invalid).
        note(r, c, got.unread, got.reason);
        row.push(String(got.unread).slice(0, MAX_CELL_TEXT));
        continue;
      }
      if (got.sec != null) {
        const sec = got.sec < EARLY_MORNING_S && latest >= EVENING_AFTER ? got.sec + DAY_S : got.sec;
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
  // Each run of consecutive skipped trips: one range of its times and one of its numbers.
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
