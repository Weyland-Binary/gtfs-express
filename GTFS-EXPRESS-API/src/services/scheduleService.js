const { validateSessionId } = require("./sessionManager");
const { refuseInvalidSession, refuseSessionNotFound } = require("./sessionManager");
const { getServiceIdsForDate } = require("./calendarService");
const { readDbFor } = require("./transform/previewLens");
const { parseTime, formatTime, fillUntimed } = require("../utils/time");

const minutesToTime = (minutes) => formatTime(Math.floor(minutes * 60), { round: false, clamp: false });
const timeToMinutes = (timeStr) => (timeStr ? (parseTime(timeStr, { lenient: true }) ?? NaN) / 60 : 0);
// A stop time in seconds; null when empty or unreadable (GTFS allows empty times between timepoints).
const secOf = (t) => {
  const v = t ? parseTime(t, { lenient: true }) : null;
  return Number.isFinite(v) ? v : null;
};

// The URL parameter "null" matches trips without a direction_id.
const matchesDirectionId = (tripDirectionId, paramDirectionId) => {
  if (paramDirectionId === "null") {
    return (
      tripDirectionId === undefined ||
      tripDirectionId === null ||
      tripDirectionId === ""
    );
  }
  return tripDirectionId === paramDirectionId;
};

/**
 * Expands frequencies.txt into stop times: each template trip's own calls, by stop_sequence (a loop's return call
 * kept), its untimed calls interpolated (fillUntimed), repeated from each window's start every headway.
 */
const generateConsolidatedFrequencyStopTimes = (
  freqTripIds,
  frequencies,
  baseStopTimes,
) => {
  if (freqTripIds.length === 0) {
    return { generated: [], frequencyInfo: null };
  }
  const callsOf = new Map();
  for (const st of baseStopTimes) {
    if (!callsOf.has(st.trip_id)) callsOf.set(st.trip_id, []);
    callsOf.get(st.trip_id).push(st);
  }
  const generated = [];
  const frequencyInfo = [];
  let counter = 0;
  for (const tripId of freqTripIds) {
    const calls = (callsOf.get(tripId) || [])
      .slice()
      .sort((a, b) => parseInt(a.stop_sequence, 10) - parseInt(b.stop_sequence, 10));
    const windows = frequencies.filter((f) => f.trip_id === tripId);
    if (!calls.length || !windows.length) continue;
    const arr = calls.map((st) => secOf(st.arrival_time) ?? secOf(st.departure_time));
    const dep = calls.map((st) => secOf(st.departure_time) ?? secOf(st.arrival_time));
    const dist = calls.map((st) => (st.shape_dist_traveled === null || st.shape_dist_traveled === undefined || st.shape_dist_traveled === "" ? null : Number(st.shape_dist_traveled)));
    fillUntimed(arr, dep, dist);
    const first = dep.find((x) => x != null);
    if (first == null) continue;
    for (const w of windows) {
      const start = secOf(w.start_time);
      const end = secOf(w.end_time);
      const headway = parseInt(w.headway_secs, 10);
      if (start == null || end == null || !(headway > 0)) continue;
      const headwayMins = headway / 60;
      frequencyInfo.push({
        start_time: w.start_time,
        end_time: w.end_time,
        headway_secs: headway,
        headway_mins: headwayMins,
        exact_times: parseInt(w.exact_times || "0", 10),
      });
      for (let at = start; at < end; at += headway) {
        counter++;
        const generatedTripId = `freq_${counter}`;
        // A call still untimed (before the first or after the last timed call) stays empty, as in the template.
        const timeOf = (v) => (v == null ? "" : formatTime(at + v - first, { round: false, clamp: false }));
        calls.forEach((st, i) => {
          generated.push({
            trip_id: generatedTripId,
            arrival_time: timeOf(arr[i]),
            departure_time: timeOf(dep[i]),
            stop_id: st.stop_id,
            stop_sequence: parseInt(st.stop_sequence, 10),
            pickup_type: st.pickup_type,
            drop_off_type: st.drop_off_type,
            start_pickup_drop_off_window: st.start_pickup_drop_off_window,
            end_pickup_drop_off_window: st.end_pickup_drop_off_window,
            is_frequency_based: true,
            headway_mins: headwayMins,
          });
        });
      }
    }
  }
  return {
    generated,
    frequencyInfo: frequencyInfo.length > 0 ? frequencyInfo : null,
  };
};

const getStopsAndTimes = async (req, res) => {
  try {
    const { route_id, direction_id, date } = req.params;
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return refuseInvalidSession(res);
    }
    const db = readDbFor(req, res, sessionId);
    if (db === false) return;
    if (!db) {
      return refuseSessionNotFound(res);
    }

    const calendar = db.prepare("SELECT * FROM calendar").all();
    const calendarDates = db.prepare("SELECT * FROM calendar_dates").all();
    const serviceIds = getServiceIdsForDate(date, calendar, calendarDates);

    if (!serviceIds.length) {
      return res.status(404).send("No service for this date.");
    }

    const placeholders = serviceIds.map(() => "?").join(",");
    const allRouteTripsOnDate = db
      .prepare(
        `SELECT * FROM trips
          WHERE route_id = ?
            AND service_id IN (${placeholders})`,
      )
      .all(route_id, ...serviceIds);

    const tripsForRoute = allRouteTripsOnDate.filter((trip) =>
      matchesDirectionId(trip.direction_id, direction_id),
    );

    const tripIds = tripsForRoute.map((trip) => trip.trip_id);

    let frequencies = [];
    if (tripIds.length > 0) {
      const tripPh = tripIds.map(() => "?").join(",");
      frequencies = db
        .prepare(
          `SELECT * FROM frequencies WHERE trip_id IN (${tripPh})`,
        )
        .all(...tripIds);
    }
    const frequencyTripIds = new Set(frequencies.map((f) => f.trip_id));

    const normalTripIds = tripIds.filter((id) => !frequencyTripIds.has(id));
    const freqTripIds = tripIds.filter((id) => frequencyTripIds.has(id));

    let normalStopTimes = [];
    if (normalTripIds.length > 0) {
      const tripPh = normalTripIds.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT trip_id, arrival_time, departure_time, stop_id, stop_sequence,
                  pickup_type, drop_off_type,
                  start_pickup_drop_off_window, end_pickup_drop_off_window
             FROM stop_times
            WHERE trip_id IN (${tripPh})`,
        )
        .all(...normalTripIds);
      normalStopTimes = rows.map((stopTime) => ({
        trip_id: stopTime.trip_id,
        arrival_time: stopTime.arrival_time,
        departure_time: stopTime.departure_time,
        stop_id: stopTime.stop_id,
        stop_sequence: parseInt(stopTime.stop_sequence, 10),
        pickup_type: stopTime.pickup_type,
        drop_off_type: stopTime.drop_off_type,
        start_pickup_drop_off_window: stopTime.start_pickup_drop_off_window,
        end_pickup_drop_off_window: stopTime.end_pickup_drop_off_window,
        is_frequency_based: false,
      }));
    }

    let freqBaseStopTimes = [];
    if (freqTripIds.length > 0) {
      const tripPh = freqTripIds.map(() => "?").join(",");
      freqBaseStopTimes = db
        .prepare(
          `SELECT trip_id, arrival_time, departure_time, stop_id, stop_sequence,
                  shape_dist_traveled, pickup_type, drop_off_type,
                  start_pickup_drop_off_window, end_pickup_drop_off_window
             FROM stop_times
            WHERE trip_id IN (${tripPh})`,
        )
        .all(...freqTripIds);
    }

    const { generated: frequencyStopTimes, frequencyInfo } =
      generateConsolidatedFrequencyStopTimes(
        freqTripIds,
        frequencies,
        freqBaseStopTimes,
      );

    const allStopTimes = [...normalStopTimes, ...frequencyStopTimes];
    allStopTimes.sort((a, b) => a.stop_sequence - b.stop_sequence);

    // One linear pass: a lookup from inside the sort comparator is quadratic on a large route.
    const firstSeqByStopId = new Map();
    for (const st of allStopTimes) {
      if (!firstSeqByStopId.has(st.stop_id)) {
        firstSeqByStopId.set(st.stop_id, st.stop_sequence);
      }
    }
    const stopIds = Array.from(firstSeqByStopId.keys());
    let stopsForRoute = [];
    if (stopIds.length > 0) {
      const stopPh = stopIds.map(() => "?").join(",");
      stopsForRoute = db
        .prepare(`SELECT * FROM stops WHERE stop_id IN (${stopPh})`)
        .all(...stopIds);
    }

    stopsForRoute.sort(
      (a, b) =>
        (firstSeqByStopId.get(a.stop_id) ?? 0) -
        (firstSeqByStopId.get(b.stop_id) ?? 0),
    );

    const hasFrequencies = frequencyStopTimes.length > 0;
    const hasNormalTimes = normalStopTimes.length > 0;

    const uniqueFrequencyInfo = frequencyInfo
      ? frequencyInfo.reduce((acc, info) => {
          const key = `${info.start_time}-${info.end_time}-${info.headway_secs}`;
          if (
            !acc.find(
              (i) => `${i.start_time}-${i.end_time}-${i.headway_secs}` === key,
            )
          ) {
            acc.push(info);
          }
          return acc;
        }, [])
      : [];

    res.json({
      stops: stopsForRoute,
      stop_times: allStopTimes,
      has_frequencies: hasFrequencies,
      has_normal_times: hasNormalTimes,
      frequency_info: uniqueFrequencyInfo,
      frequency_trip_count: freqTripIds.length,
      normal_trip_count: normalTripIds.length,
      wheelchair_accessible_trips: tripsForRoute.filter(
        (t) => t.wheelchair_accessible === "1",
      ).length,
      total_trips: tripsForRoute.length,
    });
  } catch (err) {
    console.error("getStopsAndTimes error:", err.message);
    res.status(500).json({ error: "Error fetching schedules." });
  }
};

module.exports = {
  minutesToTime,
  timeToMinutes,
  matchesDirectionId,
  generateConsolidatedFrequencyStopTimes,
  getStopsAndTimes,
};
