/**
 * How a table_rows clause names rows and values, shared by the clause model and checks/tables so that a clause
 * the lint calls well formed is one the check measures. Tables and columns are those transform/fieldWays edits.
 */

"use strict";

const { WAYS } = require("../transform/fieldWays");
const { str, num, given, clockOf } = require("./values");

const own = (o, k) => Boolean(o) && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const MAX_VALUES = 500;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

const tableOf = (p) =>
  str(p?.table)
    .toLowerCase()
    .replace(/\.txt$/, "");
const columnsOfTable = (table) => (own(WAYS, table) ? Object.keys(WAYS[table]) : []);
const isDateColumn = (col) => col === "date" || /_date$/.test(col);
const isTimeColumn = (col) => /_time$/.test(col) || /_window$/.test(col);
// Ids are compared as text: « 012 » and « 12 » are two stops.
const isIdColumn = (col) => /(^|_)id$/.test(col);
const listed = (v) => (Array.isArray(v) ? v : [v]);
const scalar = (v) => v == null || ["string", "number", "boolean"].includes(typeof v);

// Trimmed, empty and NULL alike, numbers as numbers (not in id columns), dates as YYYYMMDD, times in seconds.
const cellKey = (col, v) => {
  const s = str(v);
  if (!s) return "";
  if (isDateColumn(col) && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s.replace(/-/g, "");
  if (isTimeColumn(col) && clockOf(s) != null) return `t:${clockOf(s)}`;
  if (!isIdColumn(col) && !isDateColumn(col) && NUMBER.test(s)) return `n:${Number(s)}`;
  return s;
};

const sameCell = (col, cell, wanted) => {
  const k = cellKey(col, cell);
  return listed(wanted).some((w) => cellKey(col, w) === k);
};

const pad = (n) => String(n).padStart(2, "0");
// The texts and numbers a SELECT may prefilter on: a superset of what sameCell matches.
const variantsOf = (col, values) => {
  const out = { column: col, texts: new Set(), numbers: new Set(), empty: false };
  for (const v of listed(values)) {
    const s = str(v);
    const k = cellKey(col, v);
    if (!k) {
      out.empty = true;
      continue;
    }
    out.texts.add(s);
    if (isDateColumn(col) && /^\d{8}$/.test(k)) [k, `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6)}`].forEach((x) => out.texts.add(x));
    if (k.startsWith("t:")) {
      const sec = Number(k.slice(2));
      const [h, m, x] = [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60];
      [`${pad(h)}:${pad(m)}:${pad(x)}`, `${h}:${pad(m)}:${pad(x)}`, ...(x ? [] : [`${pad(h)}:${pad(m)}`, `${h}:${pad(m)}`])].forEach((y) => out.texts.add(y));
    }
    if (k.startsWith("n:")) out.numbers.add(Number(k.slice(2)));
  }
  return { column: col, texts: [...out.texts], numbers: [...out.numbers], empty: out.empty };
};

const labelColumns = (table) => {
  const cols = columnsOfTable(table);
  const ids = cols.filter((c) => WAYS[table][c].op === "rename_id");
  const order = cols.filter((c) => /_sequence$/.test(c) || c === "date" || (table === "frequencies" && c === "start_time"));
  const label = [...ids, ...order];
  return label.length ? label : cols.slice(0, 2);
};

/** What a table_rows clause lacks or names wrong, as phrases (empty when sound). */
const paramProblems = (p) => {
  const out = [];
  const table = tableOf(p);
  if (!table) return ["table (a GTFS table the product edits: trips, stops, fare_attributes…)"];
  if (!own(WAYS, table)) return [`table: « ${table.slice(0, 60)} » is not a GTFS table the product edits`];
  const cols = columnsOfTable(table);
  const unknown = [];
  for (const k of ["where", "expect"]) {
    if (!given(p[k])) continue;
    if (!isPlain(p[k])) {
      out.push(`${k} as { column: value | [values] }`);
      continue;
    }
    for (const [col, v] of Object.entries(p[k])) {
      if (!own(WAYS[table], col)) unknown.push(col);
      else if (!listed(v).every(scalar) || (Array.isArray(v) && !v.length)) out.push(`${k}.${col} as a value or a list of values`);
      else if (listed(v).length > MAX_VALUES) out.push(`${k}.${col} with at most ${MAX_VALUES} values (select the rows by another column)`);
    }
  }
  if (unknown.length) out.push(`columns of ${table}: ${unknown.map((c) => `« ${String(c).slice(0, 40)} »`).join(", ")} ${unknown.length === 1 ? "is not one" : "are not"} (its columns: ${cols.join(", ")})`);
  if (given(p.line) && !cols.includes("route_id") && !cols.includes("trip_id")) out.push(`line only on a table with route_id or trip_id (${table} has neither)`);
  const lo = num(p.min);
  const hi = num(p.max);
  for (const k of ["min", "max"]) if (given(p[k]) && (num(p[k]) == null || num(p[k]) < 0)) out.push(`${k} as a number of rows`);
  if (lo != null && hi != null && lo > hi) out.push("min no greater than max");
  if (given(p.changed) && typeof p.changed !== "boolean") out.push("changed as true or false");
  const asks = (isPlain(p.expect) && Object.keys(p.expect).length) || lo != null || hi != null || num(p.exactly) != null || p.absent === true || typeof p.changed === "boolean";
  if (!asks) out.push("expect, min / max / exactly, absent or changed");
  return out;
};

module.exports = { MAX_VALUES, tableOf, columnsOfTable, paramProblems, cellKey, sameCell, variantsOf, labelColumns, isPlain };
