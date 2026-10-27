/**
 * The rows of a direction's timetable: the longest trip's stops in its order, then every other stop pattern merged in,
 * each stop it alone serves placed where it calls (after the last stop it shares with the order so far, or before the
 * first one when it starts elsewhere). One row per stop_id: the grid's rows are keyed by it.
 */
export const mergeStopOrder = (stopTimes) => {
  const byTrip = new Map();
  for (const st of stopTimes || []) {
    const seq = parseInt(st.stop_sequence, 10);
    if (Number.isNaN(seq)) continue;
    if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
    byTrip.get(st.trip_id).push({ stop_id: st.stop_id, seq });
  }
  const patterns = new Map();
  for (const calls of byTrip.values()) {
    const ids = calls.sort((a, b) => a.seq - b.seq).map((c) => c.stop_id);
    const key = ids.join("\u0000");
    if (!patterns.has(key)) patterns.set(key, ids);
  }
  // Longest first, the first met on a tie, so the reference is the one the grid always showed.
  const ordered = [...patterns.values()].map((ids, i) => ({ ids, i })).sort((a, b) => b.ids.length - a.ids.length || a.i - b.i);

  const order = [];
  for (const { ids } of ordered) {
    let prev = -1;
    let pending = [];
    const flush = (at) => {
      order.splice(at, 0, ...pending);
      const placed = pending.length;
      pending = [];
      return placed;
    };
    for (const id of ids) {
      const at = order.indexOf(id);
      if (at === -1) {
        if (!pending.includes(id)) pending.push(id);
        continue;
      }
      // A stop met again earlier in the order (a loop) leaves the place reached as it is.
      if (at <= prev) continue;
      const placed = flush(prev === -1 ? at : prev + 1);
      prev = at + placed;
    }
    flush(prev === -1 ? order.length : prev + 1);
  }

  for (const st of stopTimes || []) if (!order.includes(st.stop_id)) order.push(st.stop_id);
  return order;
};
