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
 * Frequency-based trips count one run per departure.
 */

"use strict";

const { haversineMeters } = require("../../utils/geoUtils");

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
    if (f && f.length) {
      for (const w of f) for (let s = w.start; s < w.end; s += w.headway) out.push({ trip: t.id, route: t.route_id, dep: s, arr: s + (t.lastArr - t.first), from, to });
    } else out.push({ trip: t.id, route: t.route_id, dep: t.first, arr: t.lastArr, from, to });
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
      if (ready + d / speed <= s.dep) cands.push([j, d, s.dep]);
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

module.exports = { minFleet, _internals: { maxMatching, runsOn, DEFAULTS } };
