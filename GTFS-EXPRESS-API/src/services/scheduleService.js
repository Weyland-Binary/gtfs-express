const { validateSessionId } = require("./sessionManager");
const { ensureDbHandle } = require("./db/connection");
const { getServiceIdsForDate } = require("./calendarService");

// ── Helpers ───────────────────────────────────────────────────────────────────

// Convert minutes to HH:MM:SS format
const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = Math.floor(minutes % 60);
  const secs = Math.floor((minutes * 60) % 60);
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

// Convert a "HH:MM:SS" time to minutes since midnight
const timeToMinutes = (timeStr) => {
  if (!timeStr) return 0;
  const parts = timeStr.split(":").map(Number);
  return parts[0] * 60 + parts[1] + (parts[2] ? parts[2] / 60 : 0);
};

/**
 * Compares a GTFS trip direction_id against the value passed as a URL parameter.
 * Handles the "null" case (direction_id absent from GTFS data).
 */
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
 * Generates consolidated schedules from frequencies.txt.
 * Consolidates all frequency trips that share the same frequency.
 */
const generateConsolidatedFrequencyStopTimes = (
  freqTripIds,
  frequencies,
  baseStopTimes,
) => {
  if (freqTripIds.length === 0) {
    return { generated: [], frequencyInfo: null };
  }

  const tripFrequencies = frequencies.filter((f) =>
    freqTripIds.includes(f.trip_id),
  );

  if (tripFrequencies.length === 0) {
    return { generated: [], frequencyInfo: null };
  }

  // Group frequencies by unique key (start_time, end_time, headway_secs)
  // to avoid duplicates when multiple trips share the same frequency
  const frequencyGroups = new Map();
  tripFrequencies.forEach((freq) => {
    const key = `${freq.start_time}-${freq.end_time}-${freq.headway_secs}`;
    if (!frequencyGroups.has(key)) {
      frequencyGroups.set(key, {
        start_time: freq.start_time,
        end_time: freq.end_time,
        headway_secs: parseInt(freq.headway_secs, 10),
        exact_times: parseInt(freq.exact_times || "0", 10),
        tripIds: [],
      });
    }
    frequencyGroups.get(key).tripIds.push(freq.trip_id);
  });

  // Collect all unique stops from all frequency trips
  // and calculate their offsets relative to the first stop
  const allStopsMap = new Map(); // stop_id -> { stop_sequence, offset, pickup_type, ... }

  freqTripIds.forEach((tripId) => {
    const tripStopTimes = baseStopTimes
      .filter((st) => st.trip_id === tripId)
      .sort(
        (a, b) => parseInt(a.stop_sequence, 10) - parseInt(b.stop_sequence, 10),
      );

    if (tripStopTimes.length > 0) {
      const firstStopTime = timeToMinutes(tripStopTimes[0].arrival_time);

      tripStopTimes.forEach((st) => {
        const stopId = st.stop_id;
        const offset = timeToMinutes(st.arrival_time) - firstStopTime;
        const sequence = parseInt(st.stop_sequence, 10);

        // Keep only the first occurrence of each stop (or the one with the smallest sequence)
        if (
          !allStopsMap.has(stopId) ||
          allStopsMap.get(stopId).stop_sequence > sequence
        ) {
          allStopsMap.set(stopId, {
            stop_id: stopId,
            stop_sequence: sequence,
            offset: offset,
            pickup_type: st.pickup_type,
            drop_off_type: st.drop_off_type,
            start_pickup_drop_off_window: st.start_pickup_drop_off_window,
            end_pickup_drop_off_window: st.end_pickup_drop_off_window,
          });
        }
      });
    }
  });

  const consolidatedStops = Array.from(allStopsMap.values()).sort(
    (a, b) => a.stop_sequence - b.stop_sequence,
  );

  if (consolidatedStops.length === 0) {
    return { generated: [], frequencyInfo: null };
  }

  const generatedStopTimes = [];
  const frequencyInfoList = [];
  let globalTripCounter = 0;

  for (const [, freqGroup] of frequencyGroups.entries()) {
    const startTime = timeToMinutes(freqGroup.start_time);
    const endTime = timeToMinutes(freqGroup.end_time);
    const headwayMins = freqGroup.headway_secs / 60;

    frequencyInfoList.push({
      start_time: freqGroup.start_time,
      end_time: freqGroup.end_time,
      headway_secs: freqGroup.headway_secs,
      headway_mins: headwayMins,
      exact_times: freqGroup.exact_times,
    });

    for (
      let currentTime = startTime;
      currentTime < endTime;
      currentTime += headwayMins
    ) {
      globalTripCounter++;
      const generatedTripId = `freq_${globalTripCounter}`;

      consolidatedStops.forEach((stopInfo) => {
        generatedStopTimes.push({
          trip_id: generatedTripId,
          arrival_time: minutesToTime(currentTime + stopInfo.offset),
          departure_time: minutesToTime(currentTime + stopInfo.offset),
          stop_id: stopInfo.stop_id,
          stop_sequence: stopInfo.stop_sequence,
          pickup_type: stopInfo.pickup_type,
          drop_off_type: stopInfo.drop_off_type,
          start_pickup_drop_off_window: stopInfo.start_pickup_drop_off_window,
          end_pickup_drop_off_window: stopInfo.end_pickup_drop_off_window,
          is_frequency_based: true,
          headway_mins: headwayMins,
        });
      });
    }
  }

  return {
    generated: generatedStopTimes,
    frequencyInfo: frequencyInfoList.length > 0 ? frequencyInfoList : null,
  };
};

// ── Handler HTTP ──────────────────────────────────────────────────────────────

const getStopsAndTimes = async (req, res) => {
  try {
    const { route_id, direction_id, date } = req.params;
    const sessionId = req.headers["x-session-id"];
    if (!sessionId || !validateSessionId(sessionId)) {
      return res.status(400).send("Session ID invalide ou manquant.");
    }
    const db = ensureDbHandle(sessionId);
    if (!db) {
      return res.status(404).json({
        error: "No feed loaded for this session. Upload a GTFS file first.",
      });
    }

    const calendar = db.prepare("SELECT * FROM calendar").all();
    const calendarDates = db.prepare("SELECT * FROM calendar_dates").all();
    const serviceIds = getServiceIdsForDate(date, calendar, calendarDates);

    if (!serviceIds.length) {
      return res.status(404).send("No service for this date.");
    }

    // Pull trips on this route active on this date.
    const placeholders = serviceIds.map(() => "?").join(",");
    const allRouteTripsOnDate = db
      .prepare(
        `SELECT * FROM trips
          WHERE route_id = ?
            AND service_id IN (${placeholders})`,
      )
      .all(route_id, ...serviceIds);

    // direction_id filter is applied in JS: the URL param "null" means "no
    // direction_id at all" — easier to express via the existing helper.
    const tripsForRoute = allRouteTripsOnDate.filter((trip) =>
      matchesDirectionId(trip.direction_id, direction_id),
    );

    const tripIds = tripsForRoute.map((trip) => trip.trip_id);

    // Identify which of those trips are frequency-based.
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

    // Classic stop_times for trips not driven by frequencies.txt.
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

    // For frequency consolidation we need the underlying stop_times of the
    // frequency trips too. Project only the columns that
    // generateConsolidatedFrequencyStopTimes actually reads.
    let freqBaseStopTimes = [];
    if (freqTripIds.length > 0) {
      const tripPh = freqTripIds.map(() => "?").join(",");
      freqBaseStopTimes = db
        .prepare(
          `SELECT trip_id, arrival_time, departure_time, stop_id, stop_sequence,
                  pickup_type, drop_off_type,
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

    // Build a stop_id -> first stop_sequence map in a single linear pass.
    // This replaces a former O(n²) sort whose comparator did two
    // Array.find() lookups inside allStopTimes for every comparison
    // (1.35M iterations on a 1500-trip route).
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

    // Deduplicate frequency info
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
