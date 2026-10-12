/**
 * tripHeader — what the timetable grid's column header says of a trip (owner's UX lot 1, 2026-10-11): its first
 * departure, the time a person reads a timetable by, never the trip id alone (an id says nothing of when the trip
 * runs; it stays on the header's second line and in the tooltip, where the machine's handle belongs).
 *
 * The grid is the reader's: grid[stop_id].times[trip_id] = [{ arrival_time, departure_time, stop_sequence }], the
 * stops in the master order (the longest trip's). The first departure is the time of the trip's lowest stop_sequence
 * wherever that stop sits in the master order (a loop line serves the stops in another order than the reference).
 */

/** The trip's first departure on the grid (its lowest stop_sequence with a time), or null without any time. */
export function firstDepartureOf(grid, stopIds, tripId) {
  let best = null;
  for (const stopId of stopIds || []) {
    const infos = grid?.[stopId]?.times?.[tripId];
    if (!infos || !infos.length) continue;
    for (const info of infos) {
      const time = info.departure_time || info.arrival_time;
      if (!time) continue;
      const sequence = info.stop_sequence == null ? Number.POSITIVE_INFINITY : Number(info.stop_sequence);
      if (!best || sequence < best.sequence) best = { sequence, time };
    }
  }
  return best ? best.time : null;
}

/** HH:MM of a GTFS time (the seconds kept only when they are not :00), "" without a time. */
export function shortTime(time) {
  if (!time) return "";
  const parts = String(time).split(":");
  if (parts.length === 3 && parts[2] === "00") return `${parts[0]}:${parts[1]}`;
  return String(time);
}
