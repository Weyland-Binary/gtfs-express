/**
 * blocking — the fewest vehicles that run a day's trips, and which trips
 * each vehicle runs (vehicle blocks), the way scheduling software cuts them.
 *
 * A vehicle can run trip j after trip i when it reaches j's first stop in
 * time: arr(i) + layover(i) + dead running(end of i → start of j) ≤ dep(j).
 * The minimum number of vehicles is the minimum path cover of that graph,
 * n − (maximum bipartite matching) (Dilworth; Hopcroft–Karp here), and the
 * matching gives the blocks.
 *
 *   minFleet(model, date, opts) → { vehicles, trips, blocks: [[tripId]], deadhead_km, by_route: { id: vehicles } }
 *     opts.routes      only these routes (default all)
 *     opts.interline   vehicles may change line (default true); false = each line on its own
 *     opts.layover     { min_min: 5, pct: 0.12 } — recovery ≥ max(5 min, 12 % of the running time)
 *     opts.deadheadKmh dead running speed (default 25 km/h; crow-fly × 1.3)
 *     opts.maxWaitMin  a vehicle waits at most this long for its next trip (default 240)
 *     opts.maxDeadheadKm  longest dead run between two trips (default 15 km)
 *     opts.countOnly   only `vehicles` is needed: no blocks, no per-route split (faster on big networks)
 *
 * Frequency-based trips count one run per departure. A vehicle must also be
 * at j's first stop when j arrives there (`start`, before its departure when
 * the feed publishes the layover as a dwell at the origin): the canonical
 * validator reads a block's trips from their arrival at the first stop.
 *
 * After a step re-times trips, their blocks must stay feasible the way the
 * validator reads them (a trip runs from its arrival at its first stop to
 * its departure from its last; two trips of a block sharing a date may not
 * overlap):
 *
 *   rechainBlocks(db, model, tripIds, { policy, options }) → { rechained, broken, shifted, unlinked }
 *     the links of the re-timed trips' blocks the step made overlap: re-chained
 *     within the layover when it absorbs them (the next trip's arrival at its
 *     origin becomes the previous trip's end — one row, its departure stays),
 *     broken otherwise — then shifted or unlinked when the step was told how
 *     (`policy`: shift_following | unlink), else noted for the engine
 *   chainOutcome(results, { lang }) → { warnings, notes } of the step (what
 *     its policy did, the links re-chained)
 *   takeBroken(db) → { links, options } a step left broken (engine, after each step)
 *   brokenQuestion(db, links, { lang, options }) → { question, warning }: once
 *     every step ran, the step's question (blocks_broken) for the links the
 *     plan's feed still has — a later step may have mended them (replaced the
 *     trips, cut the blocks), which its warning says. Never silently: a link
 *     left broken blocks the step that broke it.
 *   BLOCKS_PARAM / BLOCKS_PARAM_KEEP, resolveBlocks(p, { lang, keepArrival })
 *     the operators' `blocks` parameter: how to answer that question
 *   unchained(model, { routeId, label, created, withdrawn, lang }) → { warning, note }
 *     what a step that rebuilds a timetable (build_timetable, set_headway)
 *     leaves to the operator's scheduling tool — never re-chained here, and
 *     never left unsaid: its new trips in no block, counted where the line's trips
 *     run in blocks, and the blocks its withdrawn trips leave with a hole —
 *     a trip of theirs no longer runs on a date another one still does (a
 *     block whose trips all go that day is gone, not holed). The step says
 *     it, and notes it (UNCHAINED: the counts, a few of the blocks)
 * Sentences in `lang` (i18n.js).
 */

"use strict";

const { haversineMeters } = require("../../utils/geoUtils");
const G = require("./gtfsOps");
const S = require("./scope");
const runtime = require("./runtime");
const { tr } = require("./i18n");
const { tripsOfRoute, _internals: fm } = require("./feedModel");

const DEFAULTS = { interline: true, layover: { min_min: 5, pct: 0.12 }, deadheadKmh: 25, maxWaitMin: 240, maxDeadheadKm: 15, detour: 1.3, sameStopM: 200 };

/** The runs of a day: one per trip (and per departure of a frequency-based trip). */
const runsOn = (model, date, routes) => {
  const out = [];
  for (const t of model.trips.values()) {
    if (routes && !routes.has(t.route_id)) continue;
    if (!model.runsOn(t.service_id, date) || t.first == null || t.lastArr == null) continue;
    const from = t.stops[0];
    const to = t.stops[t.stops.length - 1];
    const f = model.frequencies.get(t.id);
    const lead = (t.start ?? t.first) - t.first; // ≤ 0: the dwell at the origin, when the feed publishes one
    if (f && f.length) {
      for (const w of f) for (let s = w.start; s < w.end; s += w.headway) out.push({ trip: t.id, route: t.route_id, dep: s, start: s + lead, arr: s + (t.lastArr - t.first), from, to });
    } else out.push({ trip: t.id, route: t.route_id, dep: t.first, start: t.first + lead, arr: t.lastArr, from, to });
  }
  return out.sort((a, b) => a.dep - b.dep || a.arr - b.arr);
};

/** Hopcroft–Karp on adjacency lists (left i → right j). Returns matchL. */
const maxMatching = (adj, n) => {
  const INF = 1e9;
  const matchL = new Int32Array(n).fill(-1);
  const matchR = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n);
  const bfs = () => {
    const q = [];
    let found = false;
    for (let u = 0; u < n; u++) {
      if (matchL[u] === -1) {
        dist[u] = 0;
        q.push(u);
      } else dist[u] = INF;
    }
    for (let h = 0; h < q.length; h++) {
      const u = q[h];
      for (const v of adj[u]) {
        const w = matchR[v];
        if (w === -1) found = true;
        else if (dist[w] === INF) {
          dist[w] = dist[u] + 1;
          q.push(w);
        }
      }
    }
    return found;
  };
  const dfs = (u) => {
    // Iterative DFS with an explicit stack (deep chains on big networks).
    const stack = [[u, 0]];
    const path = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [x, i] = top;
      if (i >= adj[x].length) {
        dist[x] = INF;
        stack.pop();
        path.pop();
        continue;
      }
      top[1] += 1;
      const v = adj[x][i];
      const w = matchR[v];
      if (w === -1) {
        // Augment along the stack.
        path.push([x, v]);
        for (const [a, b] of path) {
          matchL[a] = b;
          matchR[b] = a;
        }
        return true;
      }
      if (dist[w] === dist[x] + 1) {
        path.push([x, v]);
        stack.push([w, 0]);
      }
    }
    return false;
  };
  // A greedy start (each run takes its first free successor) leaves few augmenting phases.
  for (let u = 0; u < n; u++) {
    for (const v of adj[u]) {
      if (matchR[v] === -1) {
        matchL[u] = v;
        matchR[v] = u;
        break;
      }
    }
  }
  while (bfs()) for (let u = 0; u < n; u++) if (matchL[u] === -1) dfs(u);
  return matchL;
};

const minFleet = (model, date, opts = {}) => require("./feedModel").memo(model, `minFleet|${date}|${JSON.stringify(opts)}`, () => computeMinFleet(model, date, opts));

const computeMinFleet = (model, date, opts = {}) => {
  const o = { ...DEFAULTS, ...opts, layover: { ...DEFAULTS.layover, ...(opts.layover || {}) } };
  const routes = opts.routes ? new Set(opts.routes) : null;
  const runs = runsOn(model, date, routes);
  const n = runs.length;
  if (!n) return { vehicles: 0, trips: 0, blocks: [], deadhead_km: 0, by_route: {} };
  // Termini as integers and their dead-running distances in a matrix, filled
  // on demand: the candidate scan below looks at millions of pairs on a city.
  const place = (id) => model.stops.get(id)?.parent || id;
  const idOf = new Map();
  const ends = [];
  const intern = (stopId) => {
    if (!idOf.has(stopId)) {
      idOf.set(stopId, ends.length);
      ends.push({ place: place(stopId), stop: model.stops.get(stopId) });
    }
    return idOf.get(stopId);
  };
  for (const r of runs) {
    r.fi = intern(r.from);
    r.ti = intern(r.to);
  }
  const P = ends.length;
  const matrix = P <= 3000 ? new Float64Array(P * P).fill(-1) : null;
  const other = matrix ? null : new Map();
  const distance = (a, b) => {
    if (a === b || ends[a].place === ends[b].place) return 0;
    const x = ends[a].stop;
    const y = ends[b].stop;
    const m = x && y && x.lat != null && y.lat != null ? haversineMeters(x.lat, x.lon, y.lat, y.lon) : Infinity;
    return m <= o.sameStopM ? 0 : m * o.detour;
  };
  const deadheadIdx = (a, b) => {
    if (matrix) {
      const k = a * P + b;
      if (matrix[k] < 0) matrix[k] = distance(a, b);
      return matrix[k];
    }
    const k = a * P + b;
    if (!other.has(k)) other.set(k, distance(a, b));
    return other.get(k);
  };
  const speed = (o.deadheadKmh * 1000) / 3600;
  const maxWait = o.maxWaitMin * 60;
  const deps = runs.map((r) => r.dep);
  const adj = runs.map(() => []);
  for (let i = 0; i < n; i++) {
    const r = runs[i];
    const ready = r.arr + Math.max(o.layover.min_min * 60, o.layover.pct * (r.arr - r.dep));
    // First candidate: binary search on departures.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (deps[mid] < ready) lo = mid + 1;
      else hi = mid;
    }
    const cands = [];
    for (let j = lo; j < n && deps[j] <= r.arr + maxWait; j++) {
      const s = runs[j];
      if (o.interline === false && s.route !== r.route) continue;
      const d = deadheadIdx(r.ti, s.fi);
      if (!Number.isFinite(d) || d > o.maxDeadheadKm * 1000) continue;
      // The layover counts up to j's departure; the vehicle is at j's first stop by j's arrival there.
      if (ready + d / speed <= s.dep && r.arr + d / speed <= s.start) cands.push([j, d, s.dep]);
    }
    // Shortest dead running first, then the earliest departure: the matching
    // takes the first augmenting edges it finds, so blocks stay compact.
    if (!o.countOnly) cands.sort((x, y) => x[1] - y[1] || x[2] - y[2]);
    adj[i] = cands.map((c) => c[0]);
  }
  const matchL = maxMatching(adj, n);
  if (o.countOnly) {
    let matched = 0;
    for (let i = 0; i < n; i++) if (matchL[i] !== -1) matched += 1;
    return { vehicles: n - matched, trips: n, blocks: null, deadhead_km: null, by_route: null };
  }
  const hasPred = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (matchL[i] !== -1) hasPred[matchL[i]] = 1;
  const blocks = [];
  let deadM = 0;
  for (let i = 0; i < n; i++) {
    if (hasPred[i]) continue;
    const chain = [];
    for (let k = i; k !== -1; k = matchL[k]) {
      chain.push(k);
      if (matchL[k] !== -1) deadM += deadheadIdx(runs[k].ti, runs[matchL[k]].fi);
    }
    blocks.push(chain.map((k) => runs[k].trip));
  }
  const byRoute = {};
  for (const b of blocks) {
    const rs = new Set(b.map((id) => model.trips.get(id)?.route_id));
    for (const r of rs) byRoute[r] = (byRoute[r] || 0) + 1 / rs.size;
  }
  for (const k of Object.keys(byRoute)) byRoute[k] = Math.round(byRoute[k] * 10) / 10;
  return { vehicles: blocks.length, trips: n, blocks, deadhead_km: Math.round(deadM / 100) / 10, by_route: byRoute };
};

// ── re-chaining the blocks of re-timed trips ─────────────────────────────

// How a step settles a link its layover cannot absorb (its `blocks` parameter).
const POLICIES = ["shift_following", "unlink", "keep_arrival"];
const MAX_ROUNDS = 50;
const BLOCKS_HELP = "When a re-timed trip no longer fits before the next trip of its vehicle block (the canonical validator's block_trips_with_overlapping_stop_times) and the layover cannot absorb it: shift_following (that next trip — and the ones after it, as needed — leave later), unlink (the re-timed trip leaves its block: re-cut the vehicle schedules)";
const BLOCKS_PARAM = { name: "blocks", type: "enum", enum: POLICIES.slice(0, 2), required: false, description: `${BLOCKS_HELP}. Asked when needed; a link the layover absorbs is re-chained without asking.` };
const BLOCKS_PARAM_KEEP = { ...BLOCKS_PARAM, enum: POLICIES, description: `${BLOCKS_HELP}, or keep_arrival (the trips keep their arrival time at the terminus and leave earlier). Asked when needed; a link the layover absorbs is re-chained without asking.` };

/** A step's `blocks` answer → { value: policy | null, ambiguity? } (keep_arrival only where the operator can keep the arrival). */
const resolveBlocks = (p, { lang, keepArrival = false } = {}) => {
  if (p.blocks == null || p.blocks === "") return { value: null };
  const options = keepArrival ? POLICIES : POLICIES.slice(0, 2);
  const v = String(p.blocks).trim().toLowerCase();
  if (options.includes(v)) return { value: v };
  return { value: null, ambiguity: { param: "blocks", code: "blocks_invalid", message: tr(lang, "blocking.invalid", { value: String(p.blocks), options: options.join(", ") }), options } };
};

const sec = fm.timeToSec;
const hm = runtime.hm;
// A copy a step made of a trip (<trip>~<hash>: a split, a moved date set) was that trip before the step.
const originalOf = (model, id) => model.trips.get(id) || model.trips.get(String(id).replace(/~[0-9a-f]+(_\d+)?$/, "")) || null;
// A trip of the model as the validator reads it: arrival at its first stop, departure there, departure from its last.
const spanIn = (t) => (t && t.start != null ? { start: t.start, dep: t.dep[0] ?? t.first, end: t.dep[t.dep.length - 1] ?? t.lastArr ?? t.start } : null);
const intersects = (p, q) => p.start < q.end && q.start < p.end;
// Links in a stable order: by the previous trip's end, then the trips.
const byLink = (a, b) => a.end - b.end || (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0);

/** A trip as written: [arrival at its first stop, departure from its last], its first departure and first row; null without times. */
const spanReader = (db) => {
  const rowsOf = db.prepare("SELECT stop_sequence, arrival_time, departure_time FROM stop_times WHERE trip_id = ? ORDER BY CAST(stop_sequence AS INTEGER)");
  return (id) => {
    const rows = rowsOf.all(id);
    const a = rows[0];
    const z = rows[rows.length - 1];
    const start = a ? sec(a.arrival_time) ?? sec(a.departure_time) : null;
    const dep = a ? sec(a.departure_time) ?? sec(a.arrival_time) : null;
    const end = z ? sec(z.departure_time) ?? sec(z.arrival_time) : null;
    return start == null || dep == null || end == null ? null : { start, dep, end, seq: a.stop_sequence };
  };
};

/** Whether two services run on a common date, read from the model when it knows them, else from the tables (a service a step created). */
const serviceSharing = (db, model = null) => {
  const dates = new Map();
  const datesOf = (sid) => {
    if (!dates.has(sid)) dates.set(sid, new Set(model && model.services.has(sid) ? S.activeDates(model, sid) : S.datesInDb(db, sid)));
    return dates.get(sid);
  };
  const memo = new Map();
  return (a, b) => {
    if (a === b) return true;
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!memo.has(k)) {
      const x = datesOf(a);
      memo.set(k, [...datesOf(b)].some((d) => x.has(d)));
    }
    return memo.get(k);
  };
};

/**
 * A reader of whether a trip overlaps another trip of its vehicle block on a common date (the next one leaves before
 * it arrives): the block as the canonical validator refuses it. For set_headway, which keeps under its trip_id only a
 * trip whose block holds — an earlier step that re-timed it (an extension) leaves it to be replaced.
 */
const overlapReader = (db) => {
  const read = spanReader(db);
  const share = serviceSharing(db);
  const row = db.prepare("SELECT block_id, service_id FROM trips WHERE trip_id = ?");
  const mates = db.prepare("SELECT trip_id, service_id FROM trips WHERE block_id = ? AND trip_id <> ?");
  return (id) => {
    const t = row.get(id);
    if (!t || !t.block_id) return false;
    const s = read(id);
    if (!s) return false;
    return mates.all(t.block_id, id).some((m) => {
      if (!share(t.service_id, m.service_id)) return false;
      const o = read(m.trip_id);
      return Boolean(o && o.start < s.end && s.start < o.end);
    });
  };
};

// The links a step's new times broke, per database (the sandbox), until the engine takes them at the step's end.
const _broken = new WeakMap();
const noteBroken = (db, links, options) => {
  if (!links.length) return;
  const x = _broken.get(db) || { links: new Map(), options };
  for (const l of links) x.links.set(`${l.from}>${l.to}`, l);
  _broken.set(db, x);
};

/**
 * The links of the re-timed trips' blocks, the canonical validator's way (see
 * the header). A link is only this step's when the two trips were not an
 * overlap of one block in `model` (the feed before the step): an overlap the
 * feed already had is not the step's to settle, a link the step made (a
 * block it gave the trips: set_interlining) is. Frequency-based trips stand
 * outside blocks here. The links left broken are noted for the engine
 * (takeBroken), with the answers the step takes (`options`).
 */
const rechainBlocks = (db, model, tripIds, { policy = null, options = POLICIES.slice(0, 2) } = {}) => {
  const out = { rechained: [], broken: [], shifted: [], unlinked: [] };
  const ids = [...new Set(tripIds || [])];
  if (!ids.length) return out;
  const freq = db.prepare("SELECT 1 FROM frequencies WHERE trip_id = ? LIMIT 1");
  const tripRow = db.prepare("SELECT block_id, service_id FROM trips WHERE trip_id = ?");
  const moved = new Set();
  const blockIds = new Set();
  for (const id of ids) {
    const r = tripRow.get(id);
    if (!r || r.block_id == null || r.block_id === "" || freq.get(id)) continue;
    moved.add(id);
    blockIds.add(r.block_id);
  }
  if (!moved.size) return out;
  // Every trip of those blocks (one scan per 500 blocks: block_id has no index).
  const trips = new Map(); // id → { id, block, service }
  const list = [...blockIds];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    for (const r of db.prepare(`SELECT trip_id, block_id, service_id FROM trips WHERE block_id IN (${chunk.map(() => "?").join(", ")})`).all(...chunk)) {
      if (!freq.get(r.trip_id)) trips.set(r.trip_id, { id: r.trip_id, block: r.block_id, service: r.service_id });
    }
  }
  const byBlock = new Map();
  for (const t of trips.values()) (byBlock.get(t.block) || byBlock.set(t.block, []).get(t.block)).push(t);
  const read = spanReader(db);
  const spans = new Map();
  const spanOf = (id) => {
    if (!spans.has(id)) spans.set(id, read(id));
    return spans.get(id);
  };
  // Before the step (the model): the same reading, and the block.
  const before = (id) => {
    const t = originalOf(model, id);
    const sp = spanIn(t);
    return sp && t.block_id ? { ...sp, block: t.block_id } : null;
  };
  const share = serviceSharing(db, model);
  // The links the step made overlap: (x, y), y starting after x (x first on a tie of starts: its id).
  const links = () => {
    const found = new Map();
    for (const id of moved) {
      const t = trips.get(id);
      const me = t ? spanOf(id) : null;
      if (!me) continue;
      for (const o of byBlock.get(t.block) || []) {
        if (o.id === id) continue;
        const other = spanOf(o.id);
        if (!other || !share(t.service, o.service)) continue;
        const [x, y] = me.start < other.start || (me.start === other.start && id < o.id) ? [t, o] : [o, t];
        const sx = spanOf(x.id);
        const sy = spanOf(y.id);
        if (sy.start >= sx.end) continue;
        const bx = before(x.id);
        const by = before(y.id);
        if (bx && by && bx.block === by.block && intersects(bx, by)) continue;
        found.set(`${x.id}>${y.id}`, { block: t.block, from: x.id, to: y.id, end: sx.end, dep: sy.dep });
      }
    }
    return [...found.values()].sort(byLink);
  };
  const { step } = runtime.timePrecision(model);
  const setArrival = db.prepare("UPDATE stop_times SET arrival_time = ? WHERE trip_id = ? AND stop_sequence = ?");
  const setTimes = db.prepare("UPDATE stop_times SET arrival_time = ?, departure_time = ? WHERE trip_id = ? AND stop_sequence = ?");
  const unblock = db.prepare("UPDATE trips SET block_id = NULL WHERE trip_id = ?");
  const shiftedBy = new Map();
  // The policy first (each round may break the next link down the block), then the layover.
  for (let round = 0; ; round++) {
    const all = links();
    const broken = all.filter((l) => l.end > l.dep);
    if (broken.length && (policy === "shift_following" || policy === "unlink") && round < MAX_ROUNDS) {
      if (policy === "unlink") {
        // The re-timed trip of the link leaves its block (the earlier one when the step moved both).
        for (const l of broken) {
          const id = moved.has(l.from) ? l.from : l.to;
          if (!trips.has(id)) continue;
          unblock.run(id);
          out.unlinked.push({ trip: id, block: l.block });
          const mates = byBlock.get(l.block);
          mates.splice(mates.findIndex((x) => x.id === id), 1);
          trips.delete(id);
          moved.delete(id);
        }
      } else {
        // The next trip leaves once the previous one has ended (whole steps of the feed's precision), then its own next…
        const by = new Map();
        for (const l of broken) by.set(l.to, Math.max(by.get(l.to) || 0, runtime.ceilTo(l.end - l.dep, step)));
        for (const [id, d] of by) {
          for (const r of G.stopTimesOf(db, id)) setTimes.run(G.shiftTime(r.arrival_time, d), G.shiftTime(r.departure_time, d), id, r.stop_sequence);
          spans.delete(id);
          shiftedBy.set(id, (shiftedBy.get(id) || 0) + d);
          moved.add(id);
        }
      }
      continue;
    }
    // Within the layover: the next trip arrives at its origin when the previous one ends.
    const need = new Map();
    for (const l of all) if (l.end <= l.dep) need.set(l.to, Math.max(need.get(l.to) ?? -Infinity, l.end));
    for (const [id, at] of need) {
      setArrival.run(fm.secToTime(at), id, spanOf(id).seq);
      spans.delete(id);
    }
    out.rechained.push(...all.filter((l) => l.end <= l.dep));
    out.broken = broken;
    break;
  }
  out.shifted = [...shiftedBy].map(([trip, by]) => ({ trip, block: trips.get(trip).block, by }));
  noteBroken(db, out.broken, options);
  return out;
};

/** The links the step just applied on `db` left broken, and the answers it takes (then forgotten): the engine's to ask about. */
const takeBroken = (db) => {
  const x = _broken.get(db);
  _broken.delete(db);
  return x ? { links: [...x.links.values()].sort(byLink), options: x.options } : null;
};

const few = (xs, n, sep = ", ") => (xs.length > n ? `${xs.slice(0, n).join(sep)} … (+${xs.length - n})` : xs.join(sep));
const byKey = (xs, key) => [...new Map(xs.map((x) => [key(x), x])).values()];

/**
 * The question of a step whose broken links the plan's last feed still has
 * (the engine asks it once every step ran: a later step may have mended the
 * links — replaced the trips, cut the blocks). Each link is read again on
 * `db`: both trips still in one block, on a common date, overlapping.
 * → { question: ambiguity | null, warning: the links later steps mended, in words | null }
 */
const brokenQuestion = (db, links, { lang, options = POLICIES.slice(0, 2) } = {}) => {
  const read = spanReader(db);
  const row = db.prepare("SELECT block_id, service_id FROM trips WHERE trip_id = ?");
  const share = serviceSharing(db);
  const still = [];
  for (const l of links) {
    const a = row.get(l.from);
    const b = row.get(l.to);
    if (!a || !b || !a.block_id || a.block_id !== b.block_id || !share(a.service_id, b.service_id)) continue;
    const sa = read(l.from);
    const sb = read(l.to);
    if (!sa || !sb) continue;
    const [x, y, sx, sy] = sa.start <= sb.start ? [l.from, l.to, sa, sb] : [l.to, l.from, sb, sa];
    if (sy.start < sx.end) still.push({ block: a.block_id, from: x, to: y, end: sx.end, dep: sy.dep });
  }
  const mended = links.length - still.length;
  return { question: still.length ? blocksQuestion(still.sort(byLink), { lang, options }) : null, warning: mended ? tr(lang, "blocking.mended", { count: mended }) : null };
};

/** The step's question while a link is broken (blocks_broken): its param, the links in words, the answers. */
const blocksQuestion = (broken, { lang, options = POLICIES.slice(0, 2) } = {}) => ({
  param: "blocks",
  code: "blocks_broken",
  message: tr(lang, "blocking.question", {
    count: broken.length,
    links: few(broken.map((l) => tr(lang, "blocking.link", { from: l.from, to: l.to, block: l.block, end: hm(l.end), dep: hm(l.dep) })), 3, tr(lang, "common.semicolon")),
    keep: options.includes("keep_arrival") ? tr(lang, "blocking.keep_arrival") : "",
  }),
  options,
});

/**
 * What a step says of its blocks, from its rechainBlocks results (one per
 * call: a link met twice counts once): a sentence and a note for the trips
 * shifted or unlinked by its policy, a note for the links re-chained within
 * the layover. The links left broken are the engine's (takeBroken).
 */
const chainOutcome = (results, { lang } = {}) => {
  const rs = (results || []).filter(Boolean);
  const rechained = byKey(rs.flatMap((r) => r.rechained), (l) => `${l.from}>${l.to}`);
  const shifted = new Map();
  for (const x of rs.flatMap((r) => r.shifted)) if (!shifted.has(x.trip) || shifted.get(x.trip).by < x.by) shifted.set(x.trip, x);
  const unlinked = byKey(rs.flatMap((r) => r.unlinked), (x) => x.trip).sort((a, b) => (a.trip < b.trip ? -1 : 1));
  const warnings = [];
  const notes = [];
  if (rechained.length) notes.push({ code: "blocks_rechained", links: rechained.length, examples: rechained.slice(0, 5).map((l) => ({ block: l.block, from: l.from, to: l.to, at: hm(l.end) })) });
  if (shifted.size) {
    const xs = [...shifted.values()].sort((a, b) => (a.trip < b.trip ? -1 : 1));
    const max = Math.max(...xs.map((x) => x.by));
    warnings.push(tr(lang, "blocking.shifted", { count: xs.length, max: max % 60 ? `${max} s` : `${max / 60} min`, trips: few(xs.map((x) => x.trip), 6) }));
    notes.push({ code: "blocks_shifted", trips: xs.length, max_s: max, examples: xs.slice(0, 10).map((x) => ({ trip: x.trip, block: x.block, by_s: x.by })) });
  }
  if (unlinked.length) {
    const blocks = [...new Set(unlinked.map((x) => x.block))].sort();
    warnings.push(tr(lang, "blocking.unlinked", { count: unlinked.length, trips: few(unlinked.map((x) => x.trip), 6), blocks: few(blocks, 5) }));
    notes.push({ code: "blocks_unlinked", trips: unlinked.length, blocks: blocks.length, examples: unlinked.slice(0, 10).map((x) => ({ trip: x.trip, block: x.block })) });
  }
  return { warnings, notes };
};

// The code of a step's note on what it leaves to the scheduling tool.
const UNCHAINED = "blocks_unchained";

/**
 * The blocks `withdrawn` (trip id → the Set of dates it stops running on, read on the model before the step) leaves
 * with a hole: on a date one of its trips stops running, another of its trips still runs. → [block ids], sorted
 */
const holedBlocks = (model, withdrawn) => {
  // The dates each block loses a trip on (a withdrawn date the trip did not run is no loss).
  const lost = new Map();
  for (const [id, dates] of withdrawn) {
    const t = model.trips.get(id);
    if (!t?.block_id) continue;
    const runs = new Set(S.activeDates(model, t.service_id));
    for (const d of dates) {
      if (!runs.has(d)) continue;
      if (!lost.has(t.block_id)) lost.set(t.block_id, new Set());
      lost.get(t.block_id).add(d);
    }
  }
  const out = new Set();
  if (!lost.size) return [];
  // One pass over the feed's trips: a trip of such a block still running on one of those dates holes it.
  for (const t of model.trips.values()) {
    const days = t.block_id && !out.has(t.block_id) ? lost.get(t.block_id) : null;
    if (!days) continue;
    const gone = withdrawn.get(t.id);
    if (S.activeDates(model, t.service_id).some((d) => days.has(d) && !(gone && gone.has(d)))) out.add(t.block_id);
  }
  return [...out].sort();
};

/** The sentence of what is left to the scheduling tool on a line: null when there is nothing. */
const unchainedText = (lang, { lines, trips, blocks }) => {
  const parts = [...(trips ? [tr(lang, "blocking.unchained_trips", { count: trips })] : []), ...(blocks ? [tr(lang, "blocking.unchained_blocks", { count: blocks })] : [])];
  return parts.length ? tr(lang, "blocking.unchained", { count: lines.length, lines: lines.join(", "), what: parts.join(tr(lang, "common.semicolon")) }) : null;
};

/** What a step that builds `created` trips (none in a block) and withdraws `withdrawn` leaves to the scheduling tool (see the header). */
const unchained = (model, { routeId, label, created, withdrawn, lang }) => {
  // New trips without a block are said where the line's trips run in blocks: elsewhere they are like the feed's own.
  const trips = created && tripsOfRoute(model, routeId).some((t) => t.block_id) ? created : 0;
  const blocks = holedBlocks(model, withdrawn);
  if (!trips && !blocks.length) return { warning: null, note: null };
  return { warning: unchainedText(lang, { lines: [label], trips, blocks: blocks.length }), note: { code: UNCHAINED, line: label, trips, blocks: blocks.length, examples: blocks.slice(0, 10) } };
};

module.exports = { minFleet, rechainBlocks, takeBroken, brokenQuestion, chainOutcome, blocksQuestion, resolveBlocks, unchained, overlapReader, UNCHAINED, BLOCKS_PARAM, BLOCKS_PARAM_KEEP, POLICIES, _internals: { maxMatching, runsOn, holedBlocks, unchainedText, DEFAULTS } };
