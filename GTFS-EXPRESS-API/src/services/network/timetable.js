/**
 * timetable — pure scheduling arithmetic for the compiler:
 *   • running times along a direction from leg distances, a commercial speed
 *     and a dwell time (rounded to a timetable-friendly granularity);
 *   • departures of a service (headway periods and/or explicit departures);
 *   • the trips of one line/direction/service with their stop_times.
 * Nothing here touches the network or the database.
 */

"use strict";

const { departuresOf, _internals } = require("./networkSpec");

const { secToTime } = _internals;
const MIN_LEG_S = 30;
const GRANULARITY_S = 30;

/**
 * Cumulative arrival/departure offsets (seconds from the trip start) for
 * each stop of a direction.
 * @param {number[]} legDistancesM distance of each leg (stops - 1 entries)
 * @param {{ speedKmh: number, dwellS: number, legDurationsS?: (number|null)[] }} opts
 */
const runningTimes = (legDistancesM, { speedKmh, dwellS = 0, legDurationsS = null } = {}) => {
  const mps = Math.max(1, speedKmh) / 3.6;
  const out = [{ arrival: 0, departure: 0 }];
  let t = 0;
  for (let i = 0; i < legDistancesM.length; i++) {
    // OSRM's car duration is a floor for the leg; commercial speed usually
    // gives a longer, more realistic time on a bus. Take the slower one.
    const bySpeed = legDistancesM[i] / mps;
    const byRoad = legDurationsS && Number.isFinite(legDurationsS[i]) ? legDurationsS[i] * 1.15 : 0;
    let leg = Math.max(MIN_LEG_S, bySpeed, byRoad);
    leg = Math.ceil(leg / GRANULARITY_S) * GRANULARITY_S;
    t += leg;
    const isLast = i === legDistancesM.length - 1;
    const arrival = t;
    const departure = isLast ? t : t + Math.round(dwellS);
    out.push({ arrival, departure });
    t = departure;
  }
  return out;
};

/**
 * The trips of one direction for one service.
 * @returns {{ trip_id, departure, stop_times: [{ stop_id, stop_sequence, arrival_time, departure_time, timepoint }] }[]}
 */
const buildTrips = ({ lineId, directionId, serviceId, stopIds, offsets, departuresSec, tripPrefix = null, startIndex = 1 }) => {
  const trips = [];
  let n = startIndex;
  for (const dep of departuresSec) {
    const tripId = `${tripPrefix || `${lineId}_${serviceId}_${directionId}`}_${String(n).padStart(3, "0")}`;
    n += 1;
    const stopTimes = stopIds.map((stopId, i) => ({
      stop_id: stopId,
      stop_sequence: i + 1,
      arrival_time: secToTime(dep + offsets[i].arrival),
      departure_time: secToTime(dep + offsets[i].departure),
      timepoint: i === 0 || i === stopIds.length - 1 ? "1" : "0",
    }));
    trips.push({ trip_id: tripId, departure: secToTime(dep), stop_times: stopTimes });
  }
  return trips;
};

module.exports = { runningTimes, buildTrips, departuresOf, GRANULARITY_S, MIN_LEG_S };
