/**
 * referenceFeeds — the timetables of other operators a change must fit
 * (the trains at the station, the regional coach at the hub), loaded
 * read-only next to the session's feed: never edited, never exported with
 * it, only read to align on them.
 *
 *   addReference(sessionId, { url | tables, name, clipTo })  → meta
 *     A public GTFS url (downloaded bounded, public internet only) or the
 *     tables already read. clipTo (the session's feed model): only the trips
 *     calling within 10 km of that network are kept, with all their calls
 *     (a national rail feed shrinks to the trains that matter here).
 *   listReferences(sessionId)                                 → [meta]
 *   removeReference(sessionId, id)                            → bool
 *   referenceDepartures(sessionId, id, { stop, towards, event, day, date, dates, from, to })
 *     → { stop: [names], towards, event, days: [{ day, date, asked, times: [HH:MM], trips }],
 *         validity: { start, end }, covers, warnings }
 *     The calls at a station (a name; its platforms count) of the trips
 *     going on to `towards` (a stop they serve later; for arrivals, one they
 *     served before), departures or arrivals, on each date asked — or, when
 *     the reference's validity does not cover it, on its own typical date of
 *     that weekday, and the answer says so.
 *
 * Stored under <upload dir>/<session>/references/<id>.sqlite with an index.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { applySchema } = require("../db/schema");
const { buildFeedModel, _internals: fm } = require("./feedModel");
const { nameKey } = require("../network/networkSpec")._internals;
const { haversineMeters } = require("../../utils/geoUtils");

const MAX_REFERENCES = 5;
const CLIP_KM = 10;
const TABLES = ["agency", "routes", "trips", "stops", "stop_times", "calendar", "calendar_dates", "frequencies"];

const dirOf = (sessionId) => {
  const { GTFS_UPLOAD_DIR } = require("../../config");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(String(sessionId || ""))) throw Object.assign(new Error("Invalid session."), { status: 400, code: "INVALID_SESSION" });
  return path.join(GTFS_UPLOAD_DIR, sessionId, "references");
};
const indexOf = (sessionId) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(sessionId), "index.json"), "utf8"));
  } catch {
    return [];
  }
};
const writeIndex = (sessionId, list) => {
  fs.mkdirSync(dirOf(sessionId), { recursive: true });
  fs.writeFileSync(path.join(dirOf(sessionId), "index.json"), JSON.stringify(list, null, 1));
};

// Open reference databases and their models, per session and id.
const _open = new Map();
const openReference = (sessionId, id) => {
  const key = `${sessionId}|${id}`;
  if (!_open.has(key)) {
    const file = path.join(dirOf(sessionId), `${id}.sqlite`);
    if (!/^[a-f0-9]{12}$/.test(id) || !fs.existsSync(file)) return null;
    const db = new Database(file, { readonly: true });
    _open.set(key, { db, model: buildFeedModel(db) });
    while (_open.size > 8) {
      const [k, v] = _open.entries().next().value;
      v.db.close();
      _open.delete(k);
    }
  }
  return _open.get(key);
};

const bboxOf = (model) => {
  let box = null;
  for (const s of model.stops.values()) {
    if (s.lat == null || s.lon == null) continue;
    if (!box) box = [s.lat, s.lon, s.lat, s.lon];
    else box = [Math.min(box[0], s.lat), Math.min(box[1], s.lon), Math.max(box[2], s.lat), Math.max(box[3], s.lon)];
  }
  return box;
};

/** Load GTFS tables (rows as objects) into a new reference database. */
const writeTables = (file, tables, { clipTo = null } = {}) => {
  const db = new Database(":memory:");
  applySchema(db);
  db.pragma("foreign_keys = OFF");
  let keepTrips = null;
  let keepStops = null;
  if (clipTo) {
    const box = bboxOf(clipTo);
    if (box) {
      const pad = CLIP_KM / 111;
      const near = new Set();
      for (const s of tables.stops || []) {
        const lat = Number(s.stop_lat);
        const lon = Number(s.stop_lon);
        if (lat >= box[0] - pad && lat <= box[2] + pad && lon >= box[1] - pad * 1.5 && lon <= box[3] + pad * 1.5) near.add(s.stop_id);
      }
      keepTrips = new Set((tables.stop_times || []).filter((r) => near.has(r.stop_id)).map((r) => r.trip_id));
      keepStops = new Set((tables.stop_times || []).filter((r) => keepTrips.has(r.trip_id)).map((r) => r.stop_id));
      const parents = new Set((tables.stops || []).filter((s) => keepStops.has(s.stop_id) && s.parent_station).map((s) => s.parent_station));
      for (const p of parents) keepStops.add(p);
    }
  }
  const trips = (tables.trips || []).filter((t) => !keepTrips || keepTrips.has(t.trip_id));
  const routeIds = new Set(trips.map((t) => t.route_id));
  const serviceIds = new Set(trips.map((t) => t.service_id));
  const keep = {
    agency: tables.agency || [],
    routes: (tables.routes || []).filter((r) => !keepTrips || routeIds.has(r.route_id)),
    trips,
    stops: (tables.stops || []).filter((s) => !keepStops || keepStops.has(s.stop_id)),
    stop_times: (tables.stop_times || []).filter((r) => !keepTrips || keepTrips.has(r.trip_id)),
    calendar: (tables.calendar || []).filter((c) => !keepTrips || serviceIds.has(c.service_id)),
    calendar_dates: (tables.calendar_dates || []).filter((c) => !keepTrips || serviceIds.has(c.service_id)),
    frequencies: (tables.frequencies || []).filter((f) => !keepTrips || keepTrips.has(f.trip_id)),
  };
  for (const t of TABLES) {
    const rows = keep[t];
    if (!rows.length) continue;
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const use = cols.filter((c) => rows.some((r) => r[c] !== undefined));
    if (!use.length) continue;
    const ins = db.prepare(`INSERT OR IGNORE INTO ${t} (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`);
    db.transaction(() => {
      for (const r of rows) ins.run(use.map((c) => (r[c] === undefined || r[c] === "" ? null : String(r[c]))));
    })();
  }
  const counts = Object.fromEntries(["routes", "trips", "stops", "stop_times"].map((t) => [t, keep[t].length]));
  const agencyIds = new Set(keep.routes.map((r) => r.agency_id));
  const agencies = keep.agency.filter((a) => agencyIds.has(a.agency_id) || keep.agency.length === 1).map((a) => a.agency_name).filter(Boolean);
  fs.writeFileSync(file, db.serialize());
  db.close();
  return { counts, agencies };
};

const addReference = async (sessionId, { url = null, tables = null, name = null, clipTo = null, fetchImpl = null } = {}) => {
  const list = indexOf(sessionId);
  if (list.length >= MAX_REFERENCES) throw Object.assign(new Error(`At most ${MAX_REFERENCES} reference feeds per session.`), { status: 400, code: "TOO_MANY_REFERENCES" });
  let t = tables;
  if (!t) {
    if (!url || !/^https:\/\//i.test(String(url))) throw Object.assign(new Error("A public https URL of a GTFS zip is required."), { status: 400, code: "INVALID_INPUT" });
    t = await require("../network/catalogService").downloadTables(String(url), { fetchImpl });
    if (t._truncated) throw Object.assign(new Error("This feed is too large to be used as a reference."), { status: 413, code: "FEED_TOO_LARGE" });
  }
  const id = crypto.randomBytes(6).toString("hex");
  fs.mkdirSync(dirOf(sessionId), { recursive: true });
  const { counts, agencies } = writeTables(path.join(dirOf(sessionId), `${id}.sqlite`), t, { clipTo });
  if (!counts.trips) {
    fs.rmSync(path.join(dirOf(sessionId), `${id}.sqlite`), { force: true });
    throw Object.assign(new Error(clipTo ? "No trip of this feed calls near the network." : "This feed has no trips."), { status: 422, code: "REFERENCE_EMPTY" });
  }
  const ref = openReference(sessionId, id);
  const meta = { id, name: String(name || agencies[0] || "Reference").slice(0, 80), url: url || null, agencies: agencies.slice(0, 5), counts, validity: ref.model.range, clipped: Boolean(clipTo), added_at: new Date().toISOString() };
  writeIndex(sessionId, [...list, meta]);
  return meta;
};

const listReferences = (sessionId) => indexOf(sessionId);

const removeReference = (sessionId, id) => {
  const list = indexOf(sessionId);
  if (!list.some((r) => r.id === id)) return false;
  const key = `${sessionId}|${id}`;
  if (_open.has(key)) {
    _open.get(key).db.close();
    _open.delete(key);
  }
  fs.rmSync(path.join(dirOf(sessionId), `${id}.sqlite`), { force: true });
  writeIndex(sessionId, list.filter((r) => r.id !== id));
  return true;
};

const DAY_DOWS = { weekday: ["tue", "mon", "wed", "thu", "fri"], saturday: ["sat"], sunday: ["sun"] };

const referenceDepartures = (sessionId, id, { stop, towards = null, event = "depart", day = "weekday", date = null, dates = null, from = null, to = null } = {}) => {
  const ref = openReference(sessionId, id);
  if (!ref) throw Object.assign(new Error("No such reference feed."), { status: 404, code: "REFERENCE_NOT_FOUND" });
  const m = ref.model;
  const warnings = [];
  const k = nameKey(String(stop || ""));
  if (!k) throw Object.assign(new Error("Which station?"), { status: 400, code: "INVALID_INPUT" });
  const all = [...m.stops.values()];
  let hits = all.filter((s) => nameKey(s.name) === k);
  if (!hits.length) hits = all.filter((s) => k.length >= 4 && nameKey(s.name).includes(k));
  if (!hits.length) {
    const near = all.filter((s) => s.location_type !== "1").map((s) => s.name).filter((n, i, a) => a.indexOf(n) === i && nameKey(n).slice(0, 3) === k.slice(0, 3)).slice(0, 8);
    throw Object.assign(new Error(`No stop "${stop}" in this reference feed.${near.length ? ` Close: ${near.join(", ")}.` : ""}`), { status: 404, code: "STOP_NOT_FOUND", options: near });
  }
  const ids = new Set(hits.flatMap((h) => [h.id, ...all.filter((x) => x.parent === h.id).map((x) => x.id)]));
  const tk = towards ? nameKey(String(towards)) : null;
  const towardIds = tk ? new Set(all.filter((s) => nameKey(s.name).includes(tk)).map((s) => s.id)) : null;
  if (towardIds && !towardIds.size) warnings.push(`No stop named like "${towards}" in the reference feed: every direction is kept.`);
  const lo = from ? fm.timeToSec(from) : 0;
  const hi = to ? fm.timeToSec(to) : 48 * 3600;
  // The dates asked, or the reference's own typical date of that weekday when it does not run then.
  const asked = dates && dates.length ? dates : date ? [date] : [null];
  const range = m.range;
  const out = [];
  for (const a of asked) {
    let d = a ? String(a).replace(/-/g, "") : null;
    const inRange = d && range && d >= range.start && d <= range.end;
    const dow = d ? fm.dowOf(d) : null;
    if (!inRange) {
      const dows = dow ? [dow] : DAY_DOWS[day] || DAY_DOWS.weekday;
      const typical = dows.map((w) => m.representative[w]).find(Boolean) || null;
      if (d) warnings.push(`The reference runs ${range ? `${range.start}–${range.end}` : "no dates"}: ${d} is not covered; the times are those of ${typical || "no date"}, its typical ${dow}.`);
      d = typical;
    }
    const times = [];
    let trips = 0;
    if (d) {
      for (const t of m.trips.values()) {
        if (!m.runsOn(t.service_id, d)) continue;
        const i = t.stops.findIndex((s) => ids.has(s));
        if (i < 0) continue;
        if (towardIds && towardIds.size) {
          const rest = event === "arrive" ? t.stops.slice(0, i) : t.stops.slice(i + 1);
          if (!rest.some((s) => towardIds.has(s))) continue;
        } else if (event !== "arrive" && i === t.stops.length - 1) continue;
        else if (event === "arrive" && i === 0) continue;
        const x = event === "arrive" ? t.arr[i] ?? t.dep[i] : t.dep[i] ?? t.arr[i];
        if (x == null || x < lo || x >= hi) continue;
        for (const off of require("./feedModel").tripStarts(m, t)) times.push(x + off);
        trips += 1;
      }
    }
    out.push({ day: a ? fm.dowOf(String(a).replace(/-/g, "")) : day, asked: a ? String(a).replace(/-/g, "") : null, date: d, times: [...new Set(times)].sort((x, y) => x - y).map((x) => fm.secToTime(x).slice(0, 5)), trips });
  }
  const covers = out.every((x) => x.asked == null || x.asked === x.date);
  if (!asked[0]) warnings.push(`Typical ${day} of the reference (${out[0]?.date || "none"}); give the dates of the change to check they are covered (validity ${range ? `${range.start}–${range.end}` : "none"}).`);
  return { stop: [...new Set(hits.map((h) => h.name))], towards: towards || null, event, days: out, validity: range, covers, warnings };
};

module.exports = { addReference, listReferences, removeReference, referenceDepartures, openReference, _internals: { writeTables, bboxOf, _open, CLIP_KM } };
