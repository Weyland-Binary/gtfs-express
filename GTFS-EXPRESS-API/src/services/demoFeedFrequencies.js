"use strict";

// The demo runs B6 and N1 by frequency windows over timed trips of the same line, service and direction: opened as
// they are, those lines would run twice there and the stop sheets would show departures in double. The copy a person
// opens drops the timed trips leaving inside a window; the bundled demo keeps them, the engine's tests reading a
// window that holds both kinds.

const fsp = require("fs/promises");
const path = require("path");

const fieldsOf = (line) => {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
};
const secondsOf = (hms) => {
  const [h, m, s] = String(hms || "").split(":").map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 3600 + m * 60 + (s || 0) : null;
};

// A file's rows as objects, each with its line, so a rewrite keeps every row it does not drop as it was written.
const readRows = async (file) => {
  let text;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const header = fieldsOf(lines[0]).map((h) => h.trim());
  const rows = lines
    .slice(1)
    .filter((line) => line !== "")
    .map((line) => ({ line, row: Object.fromEntries(fieldsOf(line).map((v, i) => [header[i], v])) }));
  return { file, head: lines[0], rows, eol: text.includes("\r\n") ? "\r\n" : "\n" };
};
const keepRows = (table, keep) => {
  const kept = table.rows.filter(({ row }) => keep(row));
  if (kept.length === table.rows.length) return Promise.resolve();
  return fsp.writeFile(table.file, [table.head, ...kept.map((r) => r.line)].join(table.eol) + table.eol);
};

/** Drops from `dir`, a copy of the demo, the timed trips leaving inside a frequency window of their line, service and direction. */
const soloFrequencyWindows = async (dir) => {
  const frequencies = await readRows(path.join(dir, "frequencies.txt"));
  if (!frequencies || !frequencies.rows.length) return 0;
  const trips = await readRows(path.join(dir, "trips.txt"));
  const stopTimes = await readRows(path.join(dir, "stop_times.txt"));
  const tripOf = new Map(trips.rows.map(({ row }) => [row.trip_id, row]));
  const templates = new Set(frequencies.rows.map(({ row }) => row.trip_id));
  const first = new Map();
  for (const { row } of stopTimes.rows) {
    const seq = Number(row.stop_sequence);
    const prev = first.get(row.trip_id);
    if (!prev || seq < prev.seq) first.set(row.trip_id, { seq, at: secondsOf(row.departure_time || row.arrival_time) });
  }
  const windows = new Map();
  for (const { row } of frequencies.rows) {
    const template = tripOf.get(row.trip_id);
    const from = secondsOf(row.start_time);
    const to = secondsOf(row.end_time);
    if (!template || from == null || to == null) continue;
    const key = `${template.route_id}|${template.service_id}|${template.direction_id}`;
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key).push([from, to]);
  }
  const dropped = new Set();
  for (const t of tripOf.values()) {
    if (templates.has(t.trip_id)) continue;
    const at = first.get(t.trip_id)?.at;
    const inside = windows.get(`${t.route_id}|${t.service_id}|${t.direction_id}`);
    if (at != null && inside && inside.some(([from, to]) => at >= from && at < to)) dropped.add(t.trip_id);
  }
  if (!dropped.size) return 0;
  await keepRows(trips, (row) => !dropped.has(row.trip_id));
  await keepRows(stopTimes, (row) => !dropped.has(row.trip_id));
  const translations = await readRows(path.join(dir, "translations.txt"));
  if (translations) await keepRows(translations, (row) => !(["trips", "stop_times"].includes(row.table_name) && dropped.has(row.record_id)));
  const transfers = await readRows(path.join(dir, "transfers.txt"));
  if (transfers) await keepRows(transfers, (row) => !dropped.has(row.from_trip_id) && !dropped.has(row.to_trip_id));
  return dropped.size;
};

module.exports = { soloFrequencyWindows };
