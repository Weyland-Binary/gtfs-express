/**
 * referenceFeeds — the timetables of other operators a change must fit
 * (the trains at the station, the regional coach at the hub), loaded
 * read-only next to the session's feed: never edited, never exported with
 * it, only read to align on them.
 *
 *   addReference(sessionId, { url | tables, name, clipTo })  → meta
 *     A public GTFS url or the tables already read. The download is https
 *     only (redirects included), public internet only, 80 MB at most within
 *     three minutes; each file decompresses to 400 MB at most; stop_times
 *     are streamed twice (the trips calling near the network, then their
 *     calls) so only what is kept is held in memory. clipTo (the session's
 *     feed model): only the trips calling within 10 km of that network are
 *     kept, with all their calls (a national rail feed shrinks to the
 *     trains that matter here). One add at a time per session.
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
const LIMITS = { zipBytes: 80 * 1024 * 1024, entryBytes: 400 * 1024 * 1024, totalBytes: 700 * 1024 * 1024, rows: 600000, deadlineMs: 180000, idleMs: 30000 };
const CACHE = { max: 3, idleMs: 10 * 60 * 1000 };
// Test seam: a fetch that replaces the guarded download (tests only).
const transport = { fetchImpl: null };

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

// One add at a time per session (the index is read, the feed downloaded, the index written).
const _locks = new Map();
const withLock = (key, fn) => {
  const run = (_locks.get(key) || Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  _locks.set(key, tail);
  tail.then(() => {
    if (_locks.get(key) === tail) _locks.delete(key);
  });
  return run;
};

// Open reference databases, their models and lookup indexes: a few, released when idle.
const _open = new Map();
const evict = () => {
  const now = Date.now();
  for (const [k, v] of _open) if (now - v.used > CACHE.idleMs) close(k);
  while (_open.size > CACHE.max) close([..._open.entries()].sort((a, b) => a[1].used - b[1].used)[0][0]);
};
const close = (key) => {
  const v = _open.get(key);
  if (!v) return;
  try {
    v.db.close();
  } catch {
    /* already closed */
  }
  _open.delete(key);
};
const openReference = (sessionId, id) => {
  const key = `${sessionId}|${id}`;
  if (!_open.has(key)) {
    if (!/^[a-f0-9]{12}$/.test(String(id))) return null;
    const file = path.join(dirOf(sessionId), `${id}.sqlite`);
    if (!fs.existsSync(file)) return null;
    const db = new Database(file, { readonly: true });
    const model = buildFeedModel(db);
    // Lookups built once: stops by name key, platforms by station.
    const byKey = new Map();
    const children = new Map();
    for (const s of model.stops.values()) {
      const k = nameKey(s.name);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(s);
      if (s.parent) {
        if (!children.has(s.parent)) children.set(s.parent, []);
        children.get(s.parent).push(s.id);
      }
    }
    _open.set(key, { db, model, byKey, children, used: Date.now() });
  }
  const v = _open.get(key);
  v.used = Date.now();
  evict();
  return _open.get(key) || null;
};

// ── Download and read, bounded ─────────────────────────────────────────────

const NEEDED = new Set(TABLES.map((t) => `${t}.txt`));
const tooLarge = (what) => Object.assign(new Error(`This feed is too large to be used as a reference (${what}).`), { status: 413, code: "FEED_TOO_LARGE" });

const download = async (url, { fetchImpl = null } = {}) => {
  const f = fetchImpl || transport.fetchImpl;
  const res = f ? await f(url) : await require("../../utils/safeFetch").safeFetch(url, { timeoutMs: LIMITS.idleMs, deadlineMs: LIMITS.deadlineMs, maxBytes: LIMITS.zipBytes, httpsOnly: true });
  if (!res.ok) throw Object.assign(new Error(`Feed download: HTTP ${res.status}`), { status: 502, code: "FEED_UNAVAILABLE" });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > LIMITS.zipBytes) throw tooLarge("zip over 80 MB");
  return buf;
};

const unzipBounded = async (buf, dir) => {
  const unzipper = require("unzipper");
  const zip = await unzipper.Open.buffer(buf);
  let total = 0;
  for (const entry of zip.files) {
    const name = path.basename(entry.path);
    if (entry.type !== "File" || !NEEDED.has(name)) continue;
    await new Promise((resolve, reject) => {
      let n = 0;
      const out = fs.createWriteStream(path.join(dir, name));
      const src = entry.stream();
      src.on("data", (c) => {
        n += c.length;
        total += c.length;
        if (n > LIMITS.entryBytes || total > LIMITS.totalBytes) src.destroy(tooLarge(`${name} decompresses beyond the limit`));
      });
      src.on("error", (err) => {
        out.destroy();
        reject(err);
      });
      out.on("error", reject);
      out.on("finish", resolve);
      src.pipe(out);
    });
  }
};

/** Each row of a CSV file, streamed (headers trimmed, BOM dropped). Resolves to the row count. */
const eachRow = (file, onRow) =>
  new Promise((resolve, reject) => {
    if (!fs.existsSync(file)) return resolve(0);
    const csv = require("csv-parser");
    let n = 0;
    const src = fs.createReadStream(file);
    const parser = csv({ mapHeaders: ({ header }) => header.replace(/^\uFEFF/, "").trim() });
    parser.on("data", (r) => {
      n += 1;
      try {
        onRow(r);
      } catch (err) {
        src.destroy();
        reject(err);
      }
    });
    parser.on("end", () => resolve(n));
    parser.on("error", reject);
    src.on("error", reject);
    src.pipe(parser);
  });

const readTablesBounded = async (dir, { clipTo = null } = {}) => {
  const t = {};
  const capped = (name) => (row, list) => {
    if (list.length >= LIMITS.rows) throw tooLarge(`${name} over ${LIMITS.rows} rows`);
    list.push(row);
  };
  for (const name of ["agency", "routes", "stops", "calendar", "calendar_dates", "trips", "frequencies"]) {
    const list = [];
    const push = capped(name);
    await eachRow(path.join(dir, `${name}.txt`), (r) => push(r, list));
    t[name] = list;
  }
  const file = path.join(dir, "stop_times.txt");
  const stopTimes = [];
  const push = capped("stop_times kept");
  if (clipTo) {
    const near = nearStops(t.stops, clipTo);
    const keep = new Set();
    await eachRow(file, (r) => {
      if (near.has(r.stop_id)) keep.add(r.trip_id);
    });
    await eachRow(file, (r) => {
      if (keep.has(r.trip_id)) push(r, stopTimes);
    });
  } else await eachRow(file, (r) => push(r, stopTimes));
  t.stop_times = stopTimes;
  return t;
};

const nearStops = (stops, clipTo) => {
  const box = bboxOf(clipTo);
  const near = new Set();
  if (!box) return near;
  const pad = CLIP_KM / 111;
  for (const s of stops || []) {
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (lat >= box[0] - pad && lat <= box[2] + pad && lon >= box[1] - pad * 1.5 && lon <= box[3] + pad * 1.5) near.add(s.stop_id);
  }
  return near;
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
    const near = nearStops(tables.stops, clipTo);
    keepTrips = new Set((tables.stop_times || []).filter((r) => near.has(r.stop_id)).map((r) => r.trip_id));
    keepStops = new Set((tables.stop_times || []).filter((r) => keepTrips.has(r.trip_id)).map((r) => r.stop_id));
    const parents = new Set((tables.stops || []).filter((x) => keepStops.has(x.stop_id) && x.parent_station).map((x) => x.parent_station));
    for (const p of parents) keepStops.add(p);
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
  const validity = counts.trips ? buildFeedModel(db).range : null;
  fs.writeFileSync(file, db.serialize());
  db.close();
  return { counts, agencies, validity };
};

const addReference = (sessionId, { url = null, tables = null, name = null, clipTo = null, fetchImpl = null } = {}) =>
  withLock(`add|${sessionId}`, async () => {
    if (indexOf(sessionId).length >= MAX_REFERENCES) throw Object.assign(new Error(`At most ${MAX_REFERENCES} reference feeds per session.`), { status: 400, code: "TOO_MANY_REFERENCES" });
    let t = tables;
    if (!t) {
      if (!url || !/^https:\/\//i.test(String(url))) throw Object.assign(new Error("A public https URL of a GTFS zip is required."), { status: 400, code: "INVALID_INPUT" });
      const buf = await download(String(url), { fetchImpl });
      const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "gtfs-reference-"));
      try {
        await unzipBounded(buf, tmp);
        t = await readTablesBounded(tmp, { clipTo });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    const id = crypto.randomBytes(6).toString("hex");
    fs.mkdirSync(dirOf(sessionId), { recursive: true });
    const file = path.join(dirOf(sessionId), `${id}.sqlite`);
    const { counts, agencies, validity } = writeTables(file, t, { clipTo });
    if (!counts.trips) {
      fs.rmSync(file, { force: true });
      throw Object.assign(new Error(clipTo ? "No trip of this feed calls near the network." : "This feed has no trips."), { status: 422, code: "REFERENCE_EMPTY" });
    }
    const meta = { id, name: String(name || agencies[0] || "Reference").slice(0, 80), url: url || null, agencies: agencies.slice(0, 5), counts, validity, clipped: Boolean(clipTo), added_at: new Date().toISOString() };
    // Read again: a removal may have happened during the download.
    writeIndex(sessionId, [...indexOf(sessionId), meta]);
    return meta;
  });

const listReferences = (sessionId) => indexOf(sessionId);

const removeReference = (sessionId, id) => {
  const list = indexOf(sessionId);
  if (!list.some((r) => r.id === id)) return false;
  close(`${sessionId}|${id}`);
  fs.rmSync(path.join(dirOf(sessionId), `${id}.sqlite`), { force: true });
  writeIndex(sessionId, indexOf(sessionId).filter((r) => r.id !== id));
  return true;
};

const DAY_DOWS = { weekday: ["tue", "mon", "wed", "thu", "fri"], saturday: ["sat"], sunday: ["sun"] };
const badInput = (message, extra = {}) => Object.assign(new Error(message), { status: 400, code: "INVALID_INPUT", ...extra });

const referenceDepartures = (sessionId, id, { stop, towards = null, event = "depart", day = "weekday", date = null, dates = null, from = null, to = null } = {}) => {
  const ref = openReference(sessionId, id);
  if (!ref) throw Object.assign(new Error("No such reference feed."), { status: 404, code: "REFERENCE_NOT_FOUND" });
  const m = ref.model;
  const warnings = [];
  const k = nameKey(String(stop || ""));
  if (!k) throw badInput("Which station?");
  const lo = from ? fm.timeToSec(from) : 0;
  const hi = to ? fm.timeToSec(to) : 48 * 3600;
  if (lo == null || hi == null) throw badInput(`"${lo == null ? from : to}" is not a time (HH:MM).`, { code: "TIME_INVALID" });
  // The station: an exact name (its platforms count), else one name containing the words.
  let hits = ref.byKey.get(k) || [];
  if (!hits.length && k.length >= 4) {
    const names = [...ref.byKey.keys()].filter((x) => x.includes(k));
    if (names.length > 1) {
      const options = names.slice(0, 12).map((x) => ref.byKey.get(x)[0].name);
      throw Object.assign(new Error(`"${stop}" matches several stations: ${options.join(", ")}.`), { status: 409, code: "STOP_AMBIGUOUS", options });
    }
    hits = names.length ? ref.byKey.get(names[0]) : [];
  }
  if (!hits.length) {
    const near = [...ref.byKey.keys()].filter((x) => x.slice(0, 3) === k.slice(0, 3)).slice(0, 8).map((x) => ref.byKey.get(x)[0].name);
    throw Object.assign(new Error(`No stop "${stop}" in this reference feed.${near.length ? ` Close: ${near.join(", ")}.` : ""}`), { status: 404, code: "STOP_NOT_FOUND", options: near });
  }
  const ids = new Set(hits.flatMap((h) => [h.id, ...(ref.children.get(h.id) || [])]));
  const tk = towards ? nameKey(String(towards)) : null;
  const towardIds = tk ? new Set([...ref.byKey.entries()].filter(([x]) => x.includes(tk)).flatMap(([, list]) => list.map((st) => st.id))) : null;
  if (towardIds && !towardIds.size) warnings.push(`No stop named like "${towards}" in the reference feed: every direction is kept.`);
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
        const i = t.stops.findIndex((x) => ids.has(x));
        if (i < 0) continue;
        if (towardIds && towardIds.size) {
          const rest = event === "arrive" ? t.stops.slice(0, i) : t.stops.slice(i + 1);
          if (!rest.some((x) => towardIds.has(x))) continue;
        } else if (event !== "arrive" && i === t.stops.length - 1) continue;
        else if (event === "arrive" && i === 0) continue;
        const x = event === "arrive" ? t.arr[i] ?? t.dep[i] : t.dep[i] ?? t.arr[i];
        if (x == null) continue;
        // Frequency-based trips: every departure, each tested against the window.
        let kept = 0;
        for (const off of require("./feedModel").tripStarts(m, t)) {
          const v = x + off;
          if (v < lo || v >= hi) continue;
          times.push(v);
          kept += 1;
        }
        if (kept) trips += 1;
      }
    }
    out.push({ day: a ? fm.dowOf(String(a).replace(/-/g, "")) : day, asked: a ? String(a).replace(/-/g, "") : null, date: d, times: [...new Set(times)].sort((x, y) => x - y).map((x) => fm.secToTime(x).slice(0, 5)), trips });
  }
  const covers = out.every((x) => x.asked == null || x.asked === x.date);
  if (!asked[0]) warnings.push(`Typical ${day} of the reference (${out[0]?.date || "none"}); give the dates of the change to check they are covered (validity ${range ? `${range.start}–${range.end}` : "none"}).`);
  return { stop: [...new Set(hits.map((h) => h.name))], towards: towards || null, event, days: out, validity: range, covers, warnings };
};

module.exports = { addReference, listReferences, removeReference, referenceDepartures, openReference, _internals: { writeTables, bboxOf, _open, CLIP_KM, LIMITS, CACHE, transport, readTablesBounded } };
