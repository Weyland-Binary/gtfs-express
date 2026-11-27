/**
 * The network's days: the dates of a window as the network runs them. Every date has a regime (the services running
 * it), two regimes are alike when the journeys they run differ by a few only, and the regimes make the day classes
 * (dayClasses: the working days, the rest days, a block run otherwise, a public holiday). The reader's strip, the
 * stop sheets and the offer read the same classes; the strip also counts the trips each date runs, the network's or
 * a line's. Free in both editions.
 */

"use strict";

const crypto = require("crypto");
const { classesOf } = require("../stopSheets/dayClasses");
const { _internals: fm, memo, MAX_FREQ_DEPARTURES } = require("../transform/feedModel");
const room = require("../transform/modelRoom");

const { addDays, dowOf, ymdToDate, SLICE } = fm;
const MAX_WINDOW_DAYS = 400;
// Two regimes are alike when the journeys they run differ by less than this share of the larger one.
const SIMILAR_SHARE = 0.15;
// A validity longer than the window is shown from this many days before today.
const DAYS_BEFORE_TODAY = 45;
// What the comparisons of one window may read: a count of what they read (PASS.work), never a clock, so a feed gets
// the same classes on every machine and at every call. Past it two regimes are alike only when the same services run,
// which only ever takes « alike » away from a pair. A service, one of its journeys, one of its lanes or a grid
// compared weighs 1; a point of a profile swept against the others of its lane, POINT for each level of the heap that
// holds them.
const PASS = { work: 50e6 };
const POINT = 5;
// Kept with a model: the verdicts of the pairs read, the strips of the windows last shown.
const MAX_VERDICTS = 50000;
const MAX_STRIPS = 4;

const shortHash = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
const daysBetween = (a, b) => Math.round((ymdToDate(b) - ymdToDate(a)) / 86400000);

// What profileOf and added read and write before a profile is copied out, one call at a time: a template larger than
// SCRATCH numbers gets buffers of its own, so that the module keeps no more than that between two calls.
const SCRATCH = 1 << 20;
const scratch = { in: new Float64Array(4096), out: new Float64Array(8192) };
const bufferOf = (side, n) => {
  if (n > SCRATCH) return new Float64Array(n);
  if (scratch[side].length < n) scratch[side] = new Float64Array(Math.min(SCRATCH, Math.max(n, 2 * scratch[side].length)));
  return scratch[side];
};

/**
 * A template's frequencies.txt rows as the profile of its lane (a template's line, direction, stops and running
 * times): { points, runs }, or null when no row gives a departure. Each row is a window of four numbers: the headway,
 * negative with exact_times; where the window falls on that headway; the first departure it gives, numbered along
 * that grid; the one after its last. `points`: flat, four numbers a point, the grid's two, a departure's number, and
 * how many windows give the departures from there on, off the collected heap. Points come in the grids' order, so two
 * profiles are read together in one pass, and rows that meet end to end are one run. `runs`: the departures in all.
 */
const profileOf = (rows) => {
  const windows = bufferOf("in", 4 * rows.length);
  let k = 0;
  let runsAll = 0;
  for (const w of rows) {
    // Counted whole, past the model's MAX_FREQ_DEPARTURES: nothing is laid out here, and a window cut short would
    // hide where two days differ.
    const runs = Math.ceil((w.end - w.start) / w.headway);
    if (!(runs > 0)) continue;
    const from = Math.floor(w.start / w.headway);
    windows[k] = w.exact ? -w.headway : w.headway;
    windows[k + 1] = w.start % w.headway;
    windows[k + 2] = from;
    windows[k + 3] = from + runs;
    k += 4;
    runsAll += runs;
  }
  if (!k) return null;
  const order = new Int32Array(k / 4);
  for (let i = 0; i < k; i += 4) order[i / 4] = i;
  const before = (p, q) => windows[p] - windows[q] || windows[p + 1] - windows[q + 1] || windows[p + 2] - windows[q + 2];
  // Rows a feed writes in order need no sort.
  let sorted = true;
  for (let i = 4; i < k && sorted; i += 4) sorted = before(i - 4, i) <= 0;
  if (!sorted) order.sort(before);
  // A window opens once and closes once: two points at most.
  const out = bufferOf("out", 2 * k);
  let n = 0;
  for (let s = 0, e = 0; s < order.length; s = e) {
    const step = windows[order[s]];
    const offset = windows[order[s] + 1];
    if (s + 1 === order.length || windows[order[s + 1]] !== step || windows[order[s + 1] + 1] !== offset) {
      // A window alone on its grid: where it opens, where it closes.
      out[n] = out[n + 4] = step;
      out[n + 1] = out[n + 5] = offset;
      out[n + 2] = windows[order[s] + 2];
      out[n + 3] = 1;
      out[n + 6] = windows[order[s] + 3];
      out[n + 7] = 0;
      n += 8;
      e = s + 1;
      continue;
    }
    // A grid's windows open in order; where they close is sorted apart, for windows that overlap.
    const ends = [];
    for (; e < order.length && windows[order[e]] === step && windows[order[e] + 1] === offset; e++) ends.push(windows[order[e] + 3]);
    ends.sort((a, b) => a - b);
    let open = 0;
    let said = 0;
    for (let i = s, j = 0; j < ends.length; ) {
      const x = i < e && windows[order[i] + 2] < ends[j] ? windows[order[i] + 2] : ends[j];
      for (; i < e && windows[order[i] + 2] === x; i++) open += 1;
      for (; j < ends.length && ends[j] === x; j++) open -= 1;
      if (open === said) continue;
      out[n] = step;
      out[n + 1] = offset;
      out[n + 2] = x;
      out[n + 3] = open;
      n += 4;
      said = open;
    }
  }
  return { points: out.slice(0, n), runs: runsAll };
};

// Which profile's next point comes first: negative a's, positive b's, 0 the same point of both.
const ahead = (a, i, b, j) => (j >= b.length ? -1 : i >= a.length ? 1 : a[i] - b[j] || a[i + 1] - b[j + 1] || a[i + 2] - b[j + 2]);

/** The departures two profiles of one lane do not share, a departure given twice counted twice. */
const unshared = (a, b) => {
  if (a === b) return 0;
  let out = 0;
  let i = 0;
  let j = 0;
  let inA = 0;
  let inB = 0;
  let at = 0;
  while (i < a.length || j < b.length) {
    const side = ahead(a, i, b, j);
    const x = side <= 0 ? a[i + 2] : b[j + 2];
    // A grid ends with no window open: the step from its last number to the next grid's first counts nothing.
    out += Math.abs(inA - inB) * (x - at);
    at = x;
    if (side <= 0) {
      inA = a[i + 3];
      i += 4;
    }
    if (side >= 0) {
      inB = b[j + 3];
      j += 4;
    }
  }
  return out;
};

/**
 * What the profiles of one lane do not share between two sides, each profile counted `coefs[i]` times, positive on
 * one side and negative on the other: Σ over the departures of |Σ coefs × windows giving it|, every profile read once
 * in the grids' order, none merged.
 */
const among = (profiles, coefs) => {
  if (profiles.length === 2 && coefs[0] * coefs[1] === -1) return unshared(profiles[0], profiles[1]);
  const at = new Array(profiles.length).fill(0);
  const open = new Array(profiles.length).fill(0);
  // A heap of the profiles by their next point.
  const heap = profiles.map((_, i) => i);
  const before = (i, j) => ahead(profiles[i], at[i], profiles[j], at[j]) < 0;
  const sink = (from) => {
    for (let k = from; ; ) {
      let least = k;
      if (2 * k + 1 < heap.length && before(heap[2 * k + 1], heap[least])) least = 2 * k + 1;
      if (2 * k + 2 < heap.length && before(heap[2 * k + 2], heap[least])) least = 2 * k + 2;
      if (least === k) return;
      const moved = heap[k];
      heap[k] = heap[least];
      heap[least] = moved;
      k = least;
    }
  };
  for (let k = (heap.length >> 1) - 1; k >= 0; k--) sink(k);
  let out = 0;
  let given = 0;
  let from = 0;
  while (heap.length) {
    const i = heap[0];
    const profile = profiles[i];
    const x = profile[at[i] + 2];
    // As in `unshared`: between two grids no window is open.
    out += Math.abs(given) * (x - from);
    from = x;
    given += coefs[i] * (profile[at[i] + 3] - open[i]);
    open[i] = profile[at[i] + 3];
    at[i] += 4;
    if (at[i] >= profile.length) {
      const last = heap.pop();
      if (!heap.length) break;
      heap[0] = last;
    }
    sink(0);
  }
  return out;
};

// Two profiles of a lane are one when their windows give the same departures: bucketed by this, then compared whole.
const hashOf = (p) => {
  let h = 2166136261;
  for (let i = 0; i < p.length; i++) h = Math.imul(h ^ (p[i] | 0), 16777619);
  return h >>> 0;
};
const sameProfile = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const NO_GRID = new Int32Array(0);
/**
 * The grids a profile lies on, each as one number. Two grids that fall on one (an offset past 2^22 seconds) are only
 * swept where they could have been summed, never counted otherwise.
 */
const gridsOf = (points) => {
  const out = new Float64Array(points.length / 4);
  let m = 0;
  for (let i = 0; i < points.length; i += 4) if (!i || points[i] !== points[i - 4] || points[i + 1] !== points[i - 3]) out[m++] = points[i] * 4194304 + points[i + 1];
  return out.subarray(0, m);
};

/** Two profiles of one lane as one (two templates of a service on the same lane): a departure both give given twice. */
const added = (a, b) => {
  const out = bufferOf("out", a.length + b.length);
  let n = 0;
  let i = 0;
  let j = 0;
  let inA = 0;
  let inB = 0;
  let said = 0;
  while (i < a.length || j < b.length) {
    const side = ahead(a, i, b, j);
    const from = side <= 0 ? a : b;
    const k = side <= 0 ? i : j;
    if (side <= 0) {
      inA = a[i + 3];
      i += 4;
    }
    if (side >= 0) {
      inB = b[j + 3];
      j += 4;
    }
    if (inA + inB === said) continue;
    out[n] = from[k];
    out[n + 1] = from[k + 1];
    out[n + 2] = from[k + 2];
    out[n + 3] = inA + inB;
    n += 4;
    said = inA + inB;
  }
  return out.slice(0, n);
};

/**
 * Each service's journeys by what a rider sees of them: { services: Map(service → { index, timed, profiles, size,
 * weight }), order, profiles, keys, grids }. A service's `timed`: its trips by line, direction, stops and times, two
 * numbers each, the journey's number among the model's `keys` and how many trips run it; its `profiles`: its
 * frequencies.txt windows, one profile (profileOf) a lane it runs, by number among the model's `profiles`, where
 * services whose windows give the same departures on a lane share one: { lane, points, total, grids, alone },
 * numbered lane by lane, `total` the departures it gives, `grids` those of its grids another profile of its lane lies
 * on (by number among `grids`), `alone` when there is none. `size`: a service's trips and departures in all;
 * `weight`: what reading it costs. `order`: the services by `index`. Two services whose templates share their
 * stop_times run the departures their windows share and no other.
 */
const journeysOf = (model) =>
  memo(model, "days.journeys", () => {
    const read = new Map();
    const readFor = (serviceId) => {
      if (!read.has(serviceId)) read.set(serviceId, { trips: [], windows: new Map(), size: 0 });
      return read.get(serviceId);
    };
    const numbered = (ids, key) => {
      if (!ids.has(key)) ids.set(key, ids.size);
      return ids.get(key);
    };
    const keys = new Map();
    const lanes = new Map();
    let n = 0;
    for (const t of model.trips.values()) {
      if (++n % SLICE.trips === 0) room.check();
      const way = `${t.route_id}|${t.direction_id}|${t.stops.join(">")}|`;
      const rows = model.frequencies.get(t.id);
      if (!rows) {
        const own = readFor(t.service_id);
        own.trips.push(numbered(keys, shortHash(way + t.dep.join(","))));
        own.size += 1;
        continue;
      }
      const made = profileOf(rows);
      if (!made) continue;
      // A template is hashed once, whatever its rows: a long line's stops and times are not the cost of each of them.
      // Its stop_times give its running times only: its windows give the same departures whatever time it is written
      // from.
      const lane = numbered(lanes, shortHash(way + t.dep.map((x) => (x == null ? "" : x - (t.first || 0))).join(",")));
      const own = readFor(t.service_id);
      const had = own.windows.get(lane);
      own.windows.set(lane, had ? { points: added(had.points, made.points), runs: had.runs + made.runs } : made);
      own.size += made.runs;
    }
    const found = [];
    const distinct = new Map();
    const uses = new Map();
    for (const { windows } of read.values()) for (const lane of windows.keys()) uses.set(lane, (uses.get(lane) || 0) + 1);
    const profileFor = (lane, { points, runs }) => {
      // A lane one service runs alone has nothing to share its profile with.
      const bucket = uses.get(lane) > 1 ? `${lane}|${hashOf(points)}` : null;
      if (bucket !== null && !distinct.has(bucket)) distinct.set(bucket, []);
      const same = bucket === null ? undefined : distinct.get(bucket).find((id) => sameProfile(found[id].points, points));
      if (same !== undefined) return same;
      found.push({ lane, points, total: runs, grids: NO_GRID, alone: true });
      if (bucket !== null) distinct.get(bucket).push(found.length - 1);
      return found.length - 1;
    };
    const services = new Map();
    const order = [];
    for (const [serviceId, { trips, windows, size }] of read) {
      trips.sort((a, b) => a - b);
      const timed = [];
      for (let i = 0, j = 0; i < trips.length; i = j) {
        while (j < trips.length && trips[j] === trips[i]) j += 1;
        timed.push(trips[i], j - i);
      }
      const own = [];
      for (const [lane, made] of windows) {
        own.push(profileFor(lane, made));
        if (++n % SLICE.trips === 0) room.check();
      }
      // What was read of a service leaves as its journeys are kept.
      read.set(serviceId, null);
      const service = { index: order.length, timed: Int32Array.from(timed), profiles: Int32Array.from(own), size, weight: timed.length / 2 + own.length };
      services.set(serviceId, service);
      order.push(service);
    }
    // Numbered lane by lane, so that a pair's profiles sorted by number come a lane at a time.
    const byLane = found.map((_, i) => i).sort((a, b) => found[a].lane - found[b].lane || a - b);
    const renumbered = new Int32Array(found.length);
    byLane.forEach((id, i) => {
      renumbered[id] = i;
    });
    const profiles = byLane.map((id) => found[id]);
    for (const service of order) for (let i = 0; i < service.profiles.length; i++) service.profiles[i] = renumbered[service.profiles[i]];
    // A profile keeps the grids another profile of its lane also lies on, numbered: none, it is alone. The lane's
    // longest profile is only looked up, so that one template of millions of rows costs no map of them.
    const gridIds = new Map();
    for (let i = 0, j = 0; i < profiles.length; i = j) {
      for (j = i + 1; j < profiles.length && profiles[j].lane === profiles[i].lane; j++);
      if (j - i < 2) continue;
      const keysOf = profiles.slice(i, j).map((p) => gridsOf(p.points));
      const longest = keysOf.reduce((best, list, k) => (list.length > keysOf[best].length ? k : best), 0);
      const seen = new Map();
      keysOf.forEach((list, k) => {
        if (k !== longest) for (const key of list) seen.set(key, (seen.get(key) || 0) + 1);
      });
      const shared = new Set([...seen].filter(([, count]) => count > 1).map(([key]) => key));
      for (const key of keysOf[longest]) if (seen.has(key)) shared.add(key);
      if (!shared.size) continue;
      keysOf.forEach((list, k) => {
        const ids = [];
        for (const key of list) if (shared.has(key)) ids.push(numbered(gridIds, key));
        profiles[i + k].grids = Int32Array.from(ids);
        profiles[i + k].alone = !ids.length;
      });
    }
    const grids = gridIds.size;
    return { services, order, profiles, keys: keys.size, grids };
  });

/**
 * What two sets of services do not share of their trips and departures, read on one scratch the model's size, in
 * two steps: `take(onlyA, onlyB)` reads what each runs, adds up what needs no sweep (a profile both sides run as
 * often cancels; one alone on its grids, or on a lane whose two sides share no grid, is unshared whole) and answers
 * what the sweeps left will weigh; `diff()` sweeps them and answers the count. Nothing of a pair outlives it but the
 * count.
 */
const readerOf = (journeys) => {
  const { profiles } = journeys;
  const count = new Int32Array(journeys.keys);
  const keyAt = new Int32Array(journeys.keys);
  const keyOf = new Int32Array(journeys.keys);
  const coef = new Int32Array(profiles.length);
  const profileAt = new Int32Array(profiles.length);
  const touched = new Int32Array(profiles.length);
  const shared = new Int32Array(profiles.length);
  const gridAt = new Int32Array(journeys.grids);
  const sweeps = [];
  let pair = 0;
  let stamp = 0;
  let keys = 0;
  let reached = 0;
  let summed = 0;
  const side = (list, sign) => {
    for (const { timed, profiles: own } of list) {
      for (let i = 0; i < timed.length; i += 2) {
        const k = timed[i];
        if (keyAt[k] !== pair) {
          keyAt[k] = pair;
          count[k] = 0;
          keyOf[keys++] = k;
        }
        count[k] += sign * timed[i + 1];
      }
      for (let i = 0; i < own.length; i++) {
        const id = own[i];
        if (profileAt[id] !== pair) {
          profileAt[id] = pair;
          coef[id] = 0;
          touched[reached++] = id;
        }
        coef[id] += sign;
      }
    }
  };
  const take = (onlyA, onlyB) => {
    pair += 1;
    keys = 0;
    reached = 0;
    summed = 0;
    sweeps.length = 0;
    side(onlyA, 1);
    side(onlyB, -1);
    let cost = 0;
    let left = 0;
    for (let i = 0; i < reached; i++) {
      const id = touched[i];
      if (!coef[id]) continue;
      if (profiles[id].alone) summed += Math.abs(coef[id]) * profiles[id].total;
      else {
        shared[left++] = id;
        cost += profiles[id].grids.length;
      }
    }
    const list = shared.subarray(0, left).sort();
    for (let i = 0, j = 0; i < left; i = j) {
      const { lane } = profiles[list[i]];
      let signs = 0;
      for (j = i; j < left && profiles[list[j]].lane === lane; j++) signs |= coef[list[j]] > 0 ? 1 : 2;
      // Departures one side alone gives are all unshared: a lane whose two sides lie on no grid in common is summed.
      let mixed = false;
      if (signs === 3) {
        stamp += 1;
        for (let k = i; k < j; k++) if (coef[list[k]] > 0) for (const g of profiles[list[k]].grids) gridAt[g] = stamp;
        for (let k = i; k < j && !mixed; k++) if (coef[list[k]] < 0) mixed = profiles[list[k]].grids.some((g) => gridAt[g] === stamp);
      }
      if (!mixed) {
        for (let k = i; k < j; k++) summed += Math.abs(coef[list[k]]) * profiles[list[k]].total;
        continue;
      }
      // A sweep reads each point once and keeps the profiles in a heap.
      const inLane = [];
      const coefs = [];
      let points = 0;
      for (let k = i; k < j; k++) {
        inLane.push(profiles[list[k]].points);
        coefs.push(coef[list[k]]);
        points += profiles[list[k]].points.length / 4;
      }
      cost += POINT * points * (32 - Math.clz32(j - i));
      sweeps.push([inLane, coefs]);
    }
    return cost;
  };
  const diff = () => {
    let out = summed;
    for (let i = 0; i < keys; i++) out += Math.abs(count[keyOf[i]]);
    for (const [lane, coefs] of sweeps) out += among(lane, coefs);
    sweeps.length = 0;
    return out;
  };
  return { take, diff };
};

/**
 * The dates of [from, to] (MAX_WINDOW_DAYS at most) by day class: { dates, classes, classOf, holidays, sigOf,
 * datesOfService, work, exact }. `keys`: date → the services running, computed here when not given; `names`: the
 * periods and holidays someone named, laid over the classes. `work`: what the comparisons read; `exact`: false when
 * they stopped at PASS.work.
 */
const classesIn = (model, { from, to }, { keys = null, names = null } = {}) => {
  const dates = [];
  for (let d = from, i = 0; d <= to && i < MAX_WINDOW_DAYS; d = addDays(d, 1), i++) dates.push(d);
  const memoised = new Map();
  const datesOfService = (sid) => {
    if (!memoised.has(sid)) {
      const set = new Set();
      for (const d of dates) if (model.runsOn(sid, d)) set.add(d);
      memoised.set(sid, set);
    }
    return memoised.get(sid);
  };
  let running = keys;
  if (!running) {
    running = new Map(dates.map((d) => [d, []]));
    for (const sid of model.services.keys()) for (const d of datesOfService(sid)) running.get(d).push(sid);
    for (const [d, list] of running) running.set(d, list.sort().join(","));
  }
  // The dates of one regime share its text: two regimes are told apart at a glance, however many services they list.
  const texts = new Map();
  const sigs = new Map();
  for (const d of dates) {
    const sig = running.get(d) ?? "";
    if (!texts.has(sig)) texts.set(sig, sig);
    sigs.set(d, texts.get(sig));
  }
  const sigOf = (d) => sigs.get(d) ?? "";
  // Regimes are compared by the journeys they run, not their services' ids: a feed giving each weekday a service of
  // its own for the same timetable runs the same journeys every weekday.
  const journeys = journeysOf(model);
  // A pair's verdict depends on its two regimes and the model alone: kept with the model, whatever window asks.
  const verdicts = memo(model, "days.alike", () => new Map());
  const words = Math.ceil(journeys.order.length / 32);
  const regimes = new Map();
  const regimeOf = (sig) => {
    if (!regimes.has(sig)) regimes.set(sig, { key: shortHash(sig), sig, runs: null, size: 0 });
    return regimes.get(sig);
  };
  // The services a regime runs, a bit each.
  const runsOf = (regime) => {
    if (!regime.runs) {
      regime.runs = new Uint32Array(words);
      for (const sid of regime.sig ? regime.sig.split(",") : []) {
        const own = journeys.services.get(sid);
        if (!own) continue;
        regime.runs[own.index >>> 5] |= 1 << (own.index & 31);
        regime.size += own.size;
      }
    }
    return regime.runs;
  };
  let reader = null;
  let work = 0;
  // One pair: the services both regimes run cancel out of what they do not share, so only the others are read, and
  // not even those when their sizes settle it (what two regimes do not share is at least the difference of what
  // their own services run, at most the sum). Answers the verdict with what it weighed, as one number: more than 0
  // alike, less apart; 0 past PASS.work.
  const read = (A, B) => {
    const [a, b] = [runsOf(A), runsOf(B)];
    const only = [[], []];
    const sizes = [0, 0];
    let cost = words;
    let weight = 0;
    for (let w = 0; w < words; w++) {
      for (let x = a[w] ^ b[w]; x; x &= x - 1) {
        const bit = 31 - Math.clz32(x & -x);
        const own = journeys.order[w * 32 + bit];
        const s = (a[w] >>> bit) & 1 ? 0 : 1;
        only[s].push(own);
        sizes[s] += own.size;
        cost += 1;
        weight += own.weight;
      }
    }
    const base = Math.max(A.size, B.size);
    // Divided as the count is, so that a bound never decides otherwise than the count it stands for.
    const settled = !(base > 0) || Math.abs(sizes[0] - sizes[1]) / base >= SIMILAR_SHARE ? false : (sizes[0] + sizes[1]) / base < SIMILAR_SHARE ? true : null;
    if (settled === null) {
      cost += weight;
      if (work + cost > PASS.work) return 0;
      // A feed the room admitted is refused here rather than ending the process on what a pair lays out.
      room.check();
      reader = reader || readerOf(journeys);
      cost += reader.take(only[0], only[1]);
    }
    if (work + cost > PASS.work) return 0;
    const alike = settled ?? reader.diff() / base < SIMILAR_SHARE;
    return alike ? cost + 1 : -cost - 1;
  };
  let exact = true;
  const asked = new Map();
  // A verdict kept is charged what its reading weighed, so a window is decided the same whoever asked first; the
  // first pair that would take the window past PASS.work ends the reading.
  const similar = (a, b) => {
    if (a === b) return true;
    const A = regimeOf(a);
    const B = regimeOf(b);
    const key = A.key < B.key ? A.key + B.key : B.key + A.key;
    if (asked.has(key)) return asked.get(key);
    let verdict = exact ? verdicts.get(key) : 0;
    if (verdict === undefined) {
      verdict = read(A, B);
      if (verdict) {
        if (verdicts.size >= MAX_VERDICTS) verdicts.clear();
        verdicts.set(key, verdict);
      }
    }
    if (exact && verdict && work + Math.abs(verdict) - 1 <= PASS.work) work += Math.abs(verdict) - 1;
    else [exact, verdict] = [false, 0];
    asked.set(key, verdict > 0);
    return verdict > 0;
  };
  const { classes, classOf, holidays } = classesOf({ dates, sigOf, dowOf, similar, names });
  return { dates, classes, classOf, holidays, sigOf, datesOfService, work, exact };
};

/** The window shown: the whole validity when it holds in MAX_WINDOW_DAYS, else that many days from DAYS_BEFORE_TODAY before today, kept inside the validity. */
const windowOf = (range, today) => {
  if (!range) return null;
  if (daysBetween(range.start, range.end) < MAX_WINDOW_DAYS) return { from: range.start, to: range.end };
  const latest = addDays(range.end, 1 - MAX_WINDOW_DAYS);
  const wanted = addDays(today, -DAYS_BEFORE_TODAY);
  const from = wanted < range.start ? range.start : wanted > latest ? latest : wanted;
  return { from, to: addDays(from, MAX_WINDOW_DAYS - 1) };
};

/** As many departures as the model lays out of a trip (tripStarts), counted without laying them out. */
const startsOf = (model, t) => {
  const rows = model.frequencies.get(t.id);
  if (!rows || !rows.length) return t.first == null ? 0 : 1;
  let n = 0;
  for (const w of rows) {
    const runs = Math.ceil((w.end - w.start) / w.headway);
    if (runs > 0) n += runs;
    if (n >= MAX_FREQ_DEPARTURES) return MAX_FREQ_DEPARTURES;
  }
  return n;
};

/** The trips (frequencies.txt expanded) of each service, the network's or a line's: Map(service → count). */
const tripsByService = (model, routeId) =>
  memo(model, `days.trips|${routeId || ""}`, () => {
    const out = new Map();
    for (const t of model.trips.values()) {
      if (routeId && t.route_id !== routeId) continue;
      out.set(t.service_id, (out.get(t.service_id) || 0) + startsOf(model, t));
    }
    return out;
  });

/**
 * A window's classes as the strip shows them, kept with the model as plain values: { classes, days: [{ date, sig,
 * cls }] }. A function kept here would keep with it everything classesIn read to answer.
 */
const stripOf = (model, window, names, namesKey) => {
  const strips = memo(model, "days.strips", () => new Map());
  const key = `${window.from}|${window.to}|${namesKey}`;
  if (!strips.has(key)) {
    room.check();
    const cal = classesIn(model, window, { names });
    // A class the network never runs (a Sunday without service) is no class of the strip.
    const classes = cal.classes.filter((c) => c.sig !== "");
    const index = new Map(classes.map((c, i) => [c, i]));
    const days = cal.dates.map((date) => {
      const sig = cal.sigOf(date);
      const cls = sig ? cal.classOf.get(date) : null;
      return { date, sig, cls: cls && index.has(cls) ? index.get(cls) : -1 };
    });
    if (strips.size >= MAX_STRIPS) strips.delete(strips.keys().next().value);
    strips.set(key, { classes, days });
  }
  return strips.get(key);
};

/**
 * The days of the window around `today` (YYYYMMDD): { window, classes, days: [{ date, cls, trips }] }, `cls` the index
 * of the date's class in `classes` (-1 when nothing runs that date), `trips` what runs it, the network's or the line's.
 */
const daysOf = (model, { today, routeId = null, names = null, namesKey = "" } = {}) => {
  const window = windowOf(model.range, today);
  if (!window) return null;
  const strip = stripOf(model, window, names, namesKey);
  const counts = tripsByService(model, routeId);
  const tripsOf = new Map();
  const days = strip.days.map(({ date, sig, cls }) => {
    if (!tripsOf.has(sig)) {
      let trips = 0;
      for (const sid of sig ? sig.split(",") : []) trips += counts.get(sid) || 0;
      tripsOf.set(sig, trips);
    }
    return { date, cls, trips: tripsOf.get(sig) };
  });
  return { window, classes: strip.classes, days };
};

module.exports = { daysOf, classesIn, windowOf, journeysOf, MAX_WINDOW_DAYS, SIMILAR_SHARE, DAYS_BEFORE_TODAY, _internals: { PASS, POINT, MAX_VERDICTS, MAX_STRIPS, startsOf } };
