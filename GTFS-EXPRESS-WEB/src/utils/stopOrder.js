/**
 * The rows of a direction's timetable: the longest trip's stops in its order, then every other stop pattern merged in,
 * each stop it alone serves placed where it calls (after the last stop it shares with the order so far, or before the
 * first one when it starts elsewhere). A stop has one row, and one more wherever a trip calls at it again (a loop, a
 * way out and back): that trip reads down the rows, a row for each of its calls, and a trip calling once at the stop
 * takes the row of the way it runs. A row holds the call each trip makes there, so no two calls share a cell.
 */

// Past this many cells (16 MB of them) a pattern is lined up by a walk down the rows instead of the whole table.
const ALIGN_MAX_CELLS = 4_000_000;

/** Each call on the first row of its stop below the row of the call before it (-1 where there is none). */
const walk = (ids, rows) => {
  const rowsAt = new Map();
  rows.forEach((row, j) => {
    if (!rowsAt.has(row.stop_id)) rowsAt.set(row.stop_id, []);
    rowsAt.get(row.stop_id).push(j);
  });
  const next = new Map();
  let prev = -1;
  return ids.map((id) => {
    const at = rowsAt.get(id) || [];
    let k = next.get(id) || 0;
    while (k < at.length && at[k] <= prev) k += 1;
    next.set(id, k);
    if (k === at.length) return -1;
    prev = at[k];
    return prev;
  });
};

// A chain of calls matched down the rows beats another by its length, then by starting on a later row (for one end,
// the closest together), then from an earlier call.
const beats = (count, from, first, thanCount, thanFrom, thanFirst) => count > thanCount || (count === thanCount && (from > thanFrom || (from === thanFrom && first < thanFirst)));

/**
 * The row each call of a pattern lines up with (-1 for none), reading down `rows`: the most calls on a row of their
 * stop, then those rows the closest together, then from the pattern's earliest call, then on the earliest rows.
 */
const align = (ids, rows) => {
  const n = ids.length;
  const m = rows.length;
  if (n * m > ALIGN_MAX_CELLS) return walk(ids, rows);
  const match = new Array(n).fill(-1);
  if (!m) return match;
  // The cell before each matched cell in the best chain ending there; a cell is call * m + row.
  const back = new Int32Array(n * m);
  // The best chain among the calls and the rows before a cell: its length, its first row, its first call, its last cell.
  const line = () => ({ count: new Int32Array(m + 1), from: new Int32Array(m + 1), first: new Int32Array(m + 1), cell: new Int32Array(m + 1).fill(-1) });
  let above = line();
  let here = line();
  let end = -1;
  let endCount = 0;
  let endSpan = 0;
  let endFirst = 0;
  for (let i = 0; i < n; i++) {
    here.count[0] = 0;
    here.cell[0] = -1;
    for (let j = 0; j < m; j++) {
      const left = beats(here.count[j], here.from[j], here.first[j], above.count[j + 1], above.from[j + 1], above.first[j + 1]);
      const src = left ? here : above;
      const at = left ? j : j + 1;
      let count = src.count[at];
      let from = src.from[at];
      let first = src.first[at];
      let cell = src.cell[at];
      if (ids[i] === rows[j].stop_id) {
        const c = above.count[j] + 1;
        const f = c > 1 ? above.from[j] : j;
        const k = c > 1 ? above.first[j] : i;
        const id = i * m + j;
        back[id] = above.cell[j];
        if (c > endCount || (c === endCount && (j - f < endSpan || (j - f === endSpan && k < endFirst)))) {
          end = id;
          endCount = c;
          endSpan = j - f;
          endFirst = k;
        }
        if (beats(c, f, k, count, from, first)) {
          count = c;
          from = f;
          first = k;
          cell = id;
        }
      }
      here.count[j + 1] = count;
      here.from[j + 1] = from;
      here.first[j + 1] = first;
      here.cell[j + 1] = cell;
    }
    [above, here] = [here, above];
  }
  for (let id = end; id !== -1; id = back[id]) match[Math.floor(id / m)] = id % m;
  return match;
};

/** The rows in order: [{ stop_id, calls: Map(trip_id → the stop time of that trip this row holds) }]. */
export const mergeStopOrder = (stopTimes) => {
  const byTrip = new Map();
  const unsequenced = [];
  for (const st of stopTimes || []) {
    const seq = parseInt(st.stop_sequence, 10);
    if (Number.isNaN(seq)) {
      unsequenced.push(st);
      continue;
    }
    if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
    byTrip.get(st.trip_id).push({ st, seq });
  }
  const patterns = new Map();
  for (const [tripId, calls] of byTrip) {
    calls.sort((a, b) => a.seq - b.seq);
    const ids = calls.map((c) => c.st.stop_id);
    const key = ids.join("\u0000");
    if (!patterns.has(key)) patterns.set(key, { ids, trips: [] });
    patterns.get(key).trips.push({ tripId, calls });
  }
  // Longest first, the first met on a tie, so the reference is the one the grid always showed.
  const ordered = [...patterns.values()].map((pattern, i) => ({ ...pattern, i })).sort((a, b) => b.ids.length - a.ids.length || a.i - b.i);

  const rows = [];
  const rowsOf = new Map();
  const addRow = (stopId) => {
    const row = { stop_id: stopId, calls: new Map() };
    if (!rowsOf.has(stopId)) rowsOf.set(stopId, []);
    rowsOf.get(stopId).push(row);
    return row;
  };

  for (const { ids, trips } of ordered) {
    // A call that names no stop (a zone) never makes its trip one that calls again.
    const stops = ids.filter((id) => id != null);
    const again = new Set(stops).size < stops.length;
    const fit = again || ids.some((id) => rowsOf.get(id)?.length > 1) ? align(ids, rows).map((j) => rows[j]) : null;
    const placed = [];
    let prev = -1;
    let pending = [];
    const flush = (at) => {
      rows.splice(at, 0, ...pending);
      const count = pending.length;
      pending = [];
      return count;
    };
    ids.forEach((id, i) => {
      let row = fit ? fit[i] : rowsOf.get(id)?.[0];
      let at = row ? rows.indexOf(row) : -1;
      // A stop met again earlier in the order leaves the place reached as it is.
      if (!fit && at <= prev) at = -1;
      if (at === -1) {
        // Only a trip calling again at a stop adds a row for a stop the order holds.
        row = again ? null : rowsOf.get(id)?.[0];
        if (!row) pending.push((row = addRow(id)));
      } else prev = at + flush(prev === -1 ? at : prev + 1);
      placed.push(row);
    });
    flush(prev === -1 ? rows.length : prev + 1);
    for (const { tripId, calls } of trips) calls.forEach(({ st }, i) => placed[i].calls.set(tripId, st));
  }

  for (const st of unsequenced) {
    let row = rowsOf.get(st.stop_id)?.find((r) => !r.calls.has(st.trip_id));
    if (!row) rows.push((row = addRow(st.stop_id)));
    row.calls.set(st.trip_id, st);
  }
  return rows;
};
