/**
 * The departures at a stop, or at a station's platforms, on one service day: the calls of the trips whose service
 * runs that date, a frequency template repeated over its windows, in the order of the clock. A trip's last call is
 * an arrival, never a departure; a call left untimed between two timed ones takes its estimated time.
 */

"use strict";

const { getServiceIdsForDate } = require("./calendarService");
const { parseFeedTime, formatTime, fillUntimed } = require("../utils/time");
const { MAX_FREQ_DEPARTURES } = require("./transform/feedModel");

// What one answer lists; the total is counted whole.
const MAX_LISTED = 1000;

// One bound value whatever the number of ids: a stop may be served by thousands of trips and services.
const IN_LIST = "(SELECT value FROM json_each(?))";
const listOf = (ids) => JSON.stringify(ids.map(String));

/** Whether `value` is a day written YYYYMMDD that exists. */
const isServiceDay = (value) => {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) return false;
  const [y, m, d] = [Number(value.slice(0, 4)), Number(value.slice(4, 6)), Number(value.slice(6, 8))];
  const day = new Date(Date.UTC(y, m - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
};

const writtenTime = (call) => parseFeedTime(call.departure_time) ?? parseFeedTime(call.arrival_time);

/** Each trip's departures on its own clock, its untimed calls estimated: trip_id → { first, at: stop_sequence → seconds }. */
const clocksOf = (db, tripIds) => {
  const calls = new Map();
  const rows = db
    .prepare(`SELECT trip_id, stop_sequence, arrival_time, departure_time, shape_dist_traveled FROM stop_times WHERE trip_id IN ${IN_LIST} ORDER BY trip_id, stop_sequence`)
    .all(listOf(tripIds));
  for (const row of rows) {
    if (!calls.has(row.trip_id)) calls.set(row.trip_id, []);
    calls.get(row.trip_id).push(row);
  }
  const clocks = new Map();
  for (const [tripId, list] of calls) {
    const arr = list.map((c) => parseFeedTime(c.arrival_time) ?? parseFeedTime(c.departure_time));
    const dep = list.map(writtenTime);
    const dist = list.map((c) => (c.shape_dist_traveled == null || c.shape_dist_traveled === "" ? null : Number(c.shape_dist_traveled)));
    fillUntimed(arr, dep, dist);
    clocks.set(tripId, { first: dep.find((x) => x != null) ?? null, at: new Map(list.map((c, i) => [c.stop_sequence, dep[i]])) });
  }
  return clocks;
};

/**
 * → { rows, total }: the day's departures at `stopIds` in the order of the clock, `rows` the first MAX_LISTED of
 * them, `total` their true number; a row of a trip without a headsign carries `last_stop_name`. `date` is a real day
 * written YYYYMMDD (isServiceDay).
 */
const departuresOn = (db, stopIds, date) => {
  const stopList = stopIds.map(() => "?").join(", ");
  const calls = db
    .prepare(
      `SELECT st.trip_id, st.stop_sequence, st.stop_id, st.arrival_time, st.departure_time,
              t.service_id, t.route_id, t.trip_headsign
         FROM stop_times st
         JOIN trips t ON t.trip_id = st.trip_id
        WHERE st.stop_id IN (${stopList})`,
    )
    .all(...stopIds);
  const services = [...new Set(calls.map((c) => c.service_id).filter((id) => id != null && id !== ""))];
  if (!services.length) return { rows: [], total: 0 };

  // The date's services as every reader of the calendar resolves them, read for the stop's services alone.
  const calendar = db.prepare(`SELECT * FROM calendar WHERE service_id IN ${IN_LIST}`).all(listOf(services));
  const calendarDates = db
    .prepare(`SELECT service_id, date, exception_type FROM calendar_dates WHERE service_id IN ${IN_LIST} AND CAST(date AS INTEGER) = ?`)
    .all(listOf(services), Number(date));
  const running = new Set(getServiceIdsForDate(date, calendar, calendarDates));
  const ofTheDay = calls.filter((c) => running.has(c.service_id));
  if (!ofTheDay.length) return { rows: [], total: 0 };

  const tripIds = [...new Set(ofTheDay.map((c) => c.trip_id))];
  // One seek a trip on the primary key, where a GROUP BY reads every call of every trip.
  const lastCall = new Map(
    db
      .prepare("SELECT j.value AS trip_id, (SELECT MAX(stop_sequence) FROM stop_times WHERE trip_id = j.value) AS last FROM json_each(?) j")
      .all(listOf(tripIds))
      .map((r) => [r.trip_id, r.last]),
  );
  const windows = new Map();
  for (const f of db.prepare(`SELECT trip_id, start_time, end_time, headway_secs FROM frequencies WHERE trip_id IN ${IN_LIST}`).all(listOf(tripIds))) {
    const start = parseFeedTime(f.start_time);
    const end = parseFeedTime(f.end_time);
    const headway = parseInt(f.headway_secs, 10);
    if (start == null || end == null || !(headway > 0)) continue;
    if (!windows.has(f.trip_id)) windows.set(f.trip_id, []);
    windows.get(f.trip_id).push({ start, end, headway });
  }
  for (const list of windows.values()) list.sort((a, b) => a.start - b.start);

  // Only a template and a trip untimed here need their whole clock.
  const needClock = [...new Set(ofTheDay.filter((c) => windows.has(c.trip_id) || writtenTime(c) == null).map((c) => c.trip_id))];
  const clocks = needClock.length ? clocksOf(db, needClock) : new Map();

  const departures = [];
  for (const call of ofTheDay) {
    if (call.stop_sequence === lastCall.get(call.trip_id)) continue;
    const written = writtenTime(call);
    const clock = clocks.get(call.trip_id);
    const sec = written ?? clock?.at.get(call.stop_sequence) ?? null;
    // Untimed before the trip's first timed call or after its last: no time can be said.
    if (sec == null) continue;
    const estimated = written == null;
    const template = windows.get(call.trip_id);
    if (!template) {
      departures.push({ call, sec, estimated });
      continue;
    }
    // A template's own times are offsets from its first departure; it stands for at most the shared cap.
    const offset = sec - (clock?.first ?? sec);
    let n = 0;
    for (const w of template) {
      for (let start = w.start; start < w.end && n < MAX_FREQ_DEPARTURES; start += w.headway, n++) departures.push({ call, sec: start + offset, estimated });
    }
  }
  departures.sort((a, b) => a.sec - b.sec || (a.call.trip_id < b.call.trip_id ? -1 : a.call.trip_id > b.call.trip_id ? 1 : 0));

  const listed = departures.slice(0, MAX_LISTED);
  const routeIds = [...new Set(listed.map((d) => d.call.route_id).filter((id) => id != null))];
  const routes = new Map(
    db
      .prepare(`SELECT route_id, route_short_name, route_color, route_text_color FROM routes WHERE route_id IN ${IN_LIST}`)
      .all(listOf(routeIds))
      .map((r) => [r.route_id, r]),
  );
  const stops = new Map(
    db
      .prepare(`SELECT stop_id, stop_name, platform_code FROM stops WHERE stop_id IN (${stopList})`)
      .all(...stopIds)
      .map((s) => [s.stop_id, s]),
  );
  // A trip without a headsign is named by where it ends.
  const unsigned = [...new Set(listed.filter((d) => !d.call.trip_headsign).map((d) => d.call.trip_id))];
  const lastStop = new Map(
    unsigned.length
      ? db
          .prepare(
            `SELECT j.value AS trip_id,
                    (SELECT s.stop_name FROM stop_times st LEFT JOIN stops s ON s.stop_id = st.stop_id
                      WHERE st.trip_id = j.value ORDER BY st.stop_sequence DESC LIMIT 1) AS stop_name
               FROM json_each(?) j`,
          )
          .all(listOf(unsigned))
          .map((r) => [r.trip_id, r.stop_name])
      : [],
  );
  const rows = listed.map(({ call, sec, estimated }) => {
    const route = routes.get(call.route_id);
    const stop = stops.get(call.stop_id);
    return {
      trip_id: call.trip_id,
      departure_time: formatTime(sec),
      stop_sequence: call.stop_sequence,
      stop_id: call.stop_id,
      stop_name: stop?.stop_name ?? null,
      platform_code: stop?.platform_code ?? null,
      route_id: call.route_id,
      trip_headsign: call.trip_headsign,
      ...(call.trip_headsign ? {} : { last_stop_name: lastStop.get(call.trip_id) ?? null }),
      route_short_name: route?.route_short_name ?? null,
      route_color: route?.route_color ?? null,
      route_text_color: route?.route_text_color ?? null,
      ...(estimated ? { estimated: true } : {}),
    };
  });
  return { rows, total: departures.length };
};

module.exports = { departuresOn, isServiceDay, MAX_LISTED };
