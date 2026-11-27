/**
 * The room a feed's model needs on the heap, judged before the model is built and while it is. A process out of
 * heap ends for everyone it serves: a model that cannot fit is refused (413 NETWORK_TOO_LARGE) before a row is read,
 * and a build that finds the heap short gives up (503 SERVER_BUSY) once the kept models have left.
 */

"use strict";

const v8 = require("v8");
const vm = require("vm");
const { refusal } = require("../refusal");

// What a row of each table the model holds leaves on the heap. A stop time and a trip (its 1 200 bytes hold the
// arrays of its calls) are fitted on the demo, eleven real feeds and two synthetic ones of 0.2 and 2 million stop_times
// (within a fifth of what each holds); the other tables are measured on synthetic ones. What a model's readers keep on
// it (the days' journeys, the sheets' catalogue) adds about half as much.
const BYTES = { stop_times: 80, trips: 1200, stops: 300, routes: 400, calendar_dates: 60, frequencies: 300 };
const TABLES = Object.keys(BYTES);
const READERS_SHARE = 1.5;
// A trip whose calls are another model's costs its own object.
const BYTES_PER_SHARED_TRIP = 400;
// A build stops when the heap in use passes HIGH and a collection does not bring it back under LOW.
const HIGH_SHARE = 0.85;
const LOW_SHARE = 0.78;
// The share of the heap past which a model is refused for good: what no server could admit, even with nothing but
// its own tenth on the heap. Below it the heap as measured decides.
const CEILING_SHARE = HIGH_SHARE - 0.1;
// A model's weight says up to two and a half times what it frees.
const RELEASE_MARGIN = 2.5;
// Collections asked back to back while the heap stays full leave the process no time of its own between them, which
// V8 reads as a heap that can no longer be freed and ends the process on: a pair at most, then none for a while.
const COLLECT_EVERY_MS = 2000;
const RETRY_AFTER_SEC = 20;
const MB = 1024 * 1024;

let collector;
const collectorOf = () => {
  if (collector === undefined) {
    collector = typeof global.gc === "function" ? global.gc : null;
    if (!collector) {
      try {
        v8.setFlagsFromString("--expose-gc");
        collector = vm.runInNewContext("gc");
        v8.setFlagsFromString("--no-expose-gc");
      } catch {
        collector = null;
      }
    }
  }
  return collector;
};

const clock = { now: () => performance.now() };
const last = { ended: -Infinity, took: 0, forced: 0 };

/**
 * A full collection, when one may be asked now: `paired` is the second of a pair (after models were released), which
 * follows the first whatever the time. Answers whether it ran.
 */
const collect = (paired = false) => {
  const run = collectorOf();
  if (!run) return false;
  const started = clock.now();
  if (!paired && started - last.ended < Math.max(COLLECT_EVERY_MS, 5 * last.took)) return false;
  run();
  last.ended = clock.now();
  last.took = paired ? last.took + (last.ended - started) : last.ended - started;
  last.forced += 1;
  return true;
};

const heap = {
  limit: v8.getHeapStatistics().heap_size_limit,
  used: () => v8.getHeapStatistics().used_heap_size,
  collect,
};

// What holds models says how to let `bytes` of them go (it answers the bytes that left), how many it still keeps,
// and how many builds are under way beside the one that asks.
const holder = { release: () => 0, kept: () => 0, building: () => 0 };

const ceiling = () => Math.floor(heap.limit * CEILING_SHARE);

/** A model's bytes from its rows by table: { stop_times, trips, stops, routes, calendar_dates, frequencies }. */
const weightOfRows = (rows) => {
  let bytes = 0;
  for (const table of TABLES) bytes += (Number(rows[table]) || 0) * BYTES[table];
  return Math.round(bytes * READERS_SHARE);
};

/** What a model built from another weighs: the trips it reads itself, and one object for each trip it shares. */
const weightOfPart = (whole, trips, shared) => (trips > 0 ? Math.round((whole * (trips - shared)) / trips) + shared * BYTES_PER_SHARED_TRIP : 0);

// db → { state, bound, exact }: what the tables said at a state of the data, so that a door asked again reads nothing.
const weighed = new WeakMap();
// A database's writes, this connection's and the others': what a reading of its tables stands for.
const stateOf = (db) => `${db.prepare("SELECT total_changes() AS n").get().n}|${db.pragma("data_version", { simple: true })}`;

// Each table's rows read by `measure` (an aggregate of its own rows); a table the database lacks holds none.
const rowsBy = (db, measure) => {
  const rows = {};
  for (const table of TABLES) {
    try {
      rows[table] = db.prepare(`SELECT ${measure} AS n FROM ${table}`).get().n;
    } catch {
      rows[table] = 0;
    }
  }
  return rows;
};

/**
 * What the model of `db` will weigh, before it is built. A table's highest rowid is never less than its rows and
 * costs nothing to read; rows deleted leave it where it was, so a network that would be refused on it is counted.
 * Both are read once for a state of the data. A reading that cannot be made leaves the bound: too much, never too
 * little.
 */
const expectedWeight = (db) => {
  let state = null;
  try {
    state = stateOf(db);
  } catch {
    return weightOfRows(rowsBy(db, "MAX(rowid)"));
  }
  let known = weighed.get(db);
  if (!known || known.state !== state) {
    known = { state, bound: weightOfRows(rowsBy(db, "MAX(rowid)")), exact: null };
    weighed.set(db, known);
  }
  if (known.bound <= ceiling()) return known.bound;
  if (known.exact == null) known.exact = weightOfRows(rowsBy(db, "COUNT(*)"));
  return known.exact;
};

const tooLarge = (bytes) =>
  refusal(413, "NETWORK_TOO_LARGE", "This network is too large for the memory of this server to model.", {
    needed_mb: Math.ceil(bytes / MB),
    max_mb: Math.floor(ceiling() / MB),
  });

const short = () => refusal(503, "SERVER_BUSY", "The server is short of memory for this network right now. Try again in a moment.", { retryAfterSec: RETRY_AFTER_SEC });

// The heap is held by what the requests under way hold themselves (a network's model beside the one to build): to
// try again would be refused the same, so the refusal is the size's, never « try again ».
const noRoom = () =>
  refusal(413, "NETWORK_TOO_LARGE", "This server's memory cannot hold this computation on a network of this size.", {
    reason: "no_room",
    max_mb: Math.floor(ceiling() / MB),
  });

/** Whether `err` is the room's refusal: a caller that turns its failures into a result lets these through. */
const refused = (err) => Boolean(err && err.status && (err.code === "NETWORK_TOO_LARGE" || err.code === "SERVER_BUSY"));

/** Refuses a model that could not fit a server with nothing else on its heap. */
const fits = (bytes) => {
  if (bytes > ceiling()) throw tooLarge(bytes);
};

/**
 * Refuses what needs a second whole model of the network beside the first (a change's « before » and « after ») where
 * the heap could not hold both: said at the door, before any work is done or paid for.
 */
const fitsBeside = (bytes) => {
  fits(bytes);
  if (bytes + Math.round(bytes / READERS_SHARE) > ceiling()) throw noRoom();
};

/**
 * Whether the heap in use is at most `mark` once what can leave has left, the garbage first, then kept models for
 * what the heap measured after that collection still lacks: "ok", or why not. "unread": no collection may be asked
 * now, the heap as it reads decides. "busy": models are still kept or built beside, so a later try may find room.
 * "held": everything that could leave has left.
 */
const under = (mark, extra = 0) => {
  const over = () => heap.used() + extra - mark;
  if (over() <= 0) return "ok";
  if (!heap.collect()) return "unread";
  if (over() <= 0) return "ok";
  if (holder.release(over() * RELEASE_MARGIN) > 0) {
    heap.collect(true);
    if (over() <= 0) return "ok";
  }
  return holder.kept() > 0 || holder.building() > 0 ? "busy" : "held";
};

const refuse = (state) => {
  throw state === "held" ? noRoom() : short();
};

/**
 * Before a build: refuses a model that cannot fit, or one the heap has no room for now. The heap is asked for what
 * the build itself puts on it; what the model's readers add afterwards passes check().
 */
const admit = (bytes) => {
  fits(bytes);
  const state = under(heap.limit * HIGH_SHARE, Math.round(bytes / READERS_SHARE));
  if (state !== "ok") refuse(state);
};

/** Between two slices of a build, and when a reader adds to a model: gives up rather than run the process out of heap. */
const check = () => {
  if (heap.used() <= heap.limit * HIGH_SHARE) return;
  const state = under(heap.limit * LOW_SHARE);
  if (state !== "ok") refuse(state);
};

module.exports = { admit, check, fits, fitsBeside, refused, expectedWeight, weightOfRows, weightOfPart, holder, _internals: { heap, clock, last, ceiling, READERS_SHARE, CEILING_SHARE, HIGH_SHARE, LOW_SHARE, RELEASE_MARGIN, COLLECT_EVERY_MS } };
