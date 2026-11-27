/**
 * The feed model of a session at its data version, built once and read by every reader of the feed (the day strip,
 * the stop sheets, the offer, the coherence report, the engine's previews, the brief's turns). The one place a
 * session's model is kept: what is kept is bounded by what the models weigh on the heap, the one read longest ago
 * leaving first, the one being read never; a model nothing can ask for any more leaves before the next one is built.
 * A reader that can wait (modelReady) lets the event loop run between the build's slices; one build of a session's
 * model at a time, whoever asks.
 */

"use strict";

const { getDataVersion } = require("../../middleware/readCache");
const connection = require("../db/connection");
const { buildFeedModel, buildSteps } = require("./feedModel");
const room = require("./modelRoom");

const { weightOfRows, expectedWeight } = room;
// The share of the heap the process may use that the kept models may weigh: a draft and its working copy both stay
// for a network of 2 million stop_times under production's 1 800 MB.
const BUDGET_SHARE = 0.45;

const budget = { bytes: Math.floor(room._internals.heap.limit * BUDGET_SHARE) };

const weightOf = (model) => {
  let stopTimes = 0;
  for (const t of model.trips.values()) stopTimes += t.stops.length;
  let dates = 0;
  for (const s of model.services.values()) dates += s.added.size + s.removed.size;
  let windows = 0;
  for (const f of model.frequencies.values()) windows += f.length;
  return weightOfRows({ stop_times: stopTimes, trips: model.trips.size, stops: model.stops.size, routes: model.routes.size, calendar_dates: dates, frequencies: windows });
};

// key → { sessionId, version, db, model, ref, bytes }, the one read longest ago first.
const kept = new Map();
// A model pushed out is not gone while a reader holds it: asked again, it is given back, never built a second time.
const released = new Map();
// A released model that was collected leaves the list by itself: looking at the others (deref) would hold each of
// them until the turn ends, in the very turn that releases them to make room.
const collected = new FinalizationRegistry((key) => {
  const r = released.get(key);
  if (r && !r.model.deref()) released.delete(key);
});

// The weak reference is made when the model is kept, not when it leaves: one made in the turn that releases it would
// hold it until that turn ends, and the collection that turn asks for would free nothing.
const entryOf = (key, sessionId, version, db, model) => {
  collected.register(model, key);
  return { sessionId, version, db, model, ref: new WeakRef(model), bytes: weightOf(model) };
};

const release = (key) => {
  const entry = kept.get(key);
  if (!entry) return;
  kept.delete(key);
  released.set(key, { db: entry.db, model: entry.ref });
};

const heldStill = (key, db) => {
  const r = released.get(key);
  if (!r) return null;
  const model = r.db === db && r.db.open ? r.model.deref() : null;
  if (model || !r.db.open) released.delete(key);
  return model || null;
};

/**
 * What nothing can ask for any more leaves: the models of a session whose data moved on (an edit, an undo, a file
 * replaced) and those of a working copy that was closed.
 */
const dropUnasked = () => {
  const standing = new Map();
  for (const [key, entry] of kept) {
    if (!entry.db.open) {
      kept.delete(key);
      continue;
    }
    if (!standing.has(entry.db)) standing.set(entry.db, getDataVersion(entry.db));
    if (standing.get(entry.db) !== entry.version) release(key);
  }
};

/** The models read longest ago leave until what is kept, with `incoming` bytes to come, fits the budget. */
const makeRoom = (incoming, except = null) => {
  let total = incoming;
  for (const entry of kept.values()) total += entry.bytes;
  for (const [key, entry] of kept) {
    if (total <= budget.bytes) break;
    if (key === except) continue;
    release(key);
    total -= entry.bytes;
  }
};

// A build short of heap asks the kept models to leave, the one read longest ago first, before it gives up.
room.holder.release = (bytes) => {
  let left = 0;
  for (const [key, entry] of kept) {
    if (left >= bytes) break;
    release(key);
    left += entry.bytes;
  }
  return left;
};
room.holder.kept = () => kept.size;

/** Whether `db` is the open working copy of the session `sessionId`: the only database whose model is kept. */
const keeps = (sessionId, db) => Boolean(sessionId && db && connection.hasEditDb(sessionId) && connection.getEditDb(sessionId) === db);

const keptModel = (sessionId, db, name, build) => {
  if (!keeps(sessionId, db)) return build();
  const version = getDataVersion(db);
  const key = `${sessionId}|${version}|${name}`;
  const entry = kept.get(key);
  if (entry && entry.db === db) {
    kept.delete(key);
    kept.set(key, entry);
    return entry.model;
  }
  kept.delete(key);
  // Before the build, so that an edit never holds two models of its feed.
  dropUnasked();
  let model = heldStill(key, db);
  if (!model) {
    const incoming = expectedWeight(db);
    room.fits(incoming);
    makeRoom(incoming);
    model = build();
  }
  kept.set(key, entryOf(key, sessionId, version, db, model));
  makeRoom(0, key);
  return model;
};

// sessionId → the build of its model under way: { db, version, key, steps, started, done, model, dropped }.
const building = new Map();
// The build whose step runs now: the room asks how many others read beside it.
let stepping = null;
room.holder.building = () => {
  let n = 0;
  for (const b of building.values()) if (b !== stepping && b.started && !b.done) n += 1;
  return n;
};

const keptAt = (key, db) => {
  const entry = kept.get(key);
  if (!entry || entry.db !== db) return null;
  kept.delete(key);
  kept.set(key, entry);
  return entry.model;
};

const store = (sessionId, version, key, db, model) => {
  kept.set(key, entryOf(key, sessionId, version, db, model));
  makeRoom(0, key);
  return model;
};

/** A build of the session's model at `version`, or the model itself when one still held can be given back. */
const startBuild = (sessionId, db, version, key) => {
  const previous = building.get(sessionId);
  if (previous) previous.dropped = true;
  building.delete(sessionId);
  kept.delete(key);
  dropUnasked();
  const held = heldStill(key, db);
  if (held) return { model: store(sessionId, version, key, db, held) };
  // A network too large is refused before the kept models leave for it.
  const incoming = expectedWeight(db);
  room.fits(incoming);
  makeRoom(incoming);
  const build = { sessionId, db, version, key, steps: buildSteps(db), done: false, model: null, dropped: false };
  building.set(sessionId, build);
  return { build };
};

/**
 * One step of the build, or all of them. A build paused reads the feed in slices that the session's own writes may
 * fall between: a model that ends at another data version than it began is dropped, never kept nor given.
 */
const advance = (build, whole) => {
  const outer = stepping;
  stepping = build;
  try {
    // The first step is the build's admission; the heap is looked at between the steps that follow.
    if (build.started) room.check();
    let step = build.steps.next();
    build.started = true;
    while (whole && !step.done) {
      room.check();
      step = build.steps.next();
    }
    if (!step.done) return;
    build.done = true;
    if (building.get(build.sessionId) === build) building.delete(build.sessionId);
    if (build.dropped || !build.db.open || getDataVersion(build.db) !== build.version) {
      build.dropped = true;
      return;
    }
    build.model = store(build.sessionId, build.version, build.key, build.db, step.value);
  } catch (err) {
    build.done = true;
    build.dropped = true;
    if (building.get(build.sessionId) === build) building.delete(build.sessionId);
    throw err;
  } finally {
    stepping = outer;
  }
};

/**
 * The model of the session's feed as it stands, the same object for every reader. A database that is not the
 * session's own working copy (a sandbox, a copy an evaluation plays on) is modelled aside and never kept. A build
 * that a waiting reader began is finished here at once rather than started again.
 */
const modelOf = (sessionId, db) => {
  if (!keeps(sessionId, db)) return buildFeedModel(db);
  const version = getDataVersion(db);
  const key = `${sessionId}|${version}|`;
  const hit = keptAt(key, db);
  if (hit) return hit;
  const current = building.get(sessionId);
  let build;
  if (current && current.db === db && current.version === version) build = current;
  else {
    const started = startBuild(sessionId, db, version, key);
    if (started.model) return started.model;
    build = started.build;
  }
  advance(build, true);
  return build.model || modelOf(sessionId, db);
};

// A reader whose build was overtaken by writes that many times builds the next one without a pause.
const PAUSED_TRIES = 3;

/**
 * modelOf for a reader that can wait: the build pauses between its slices so that the server answers others
 * meanwhile, and readers asking for the same model while it is built wait for that one build.
 */
const modelReady = async (sessionId, db) => {
  if (!keeps(sessionId, db)) return buildFeedModel(db);
  for (let tries = 0; tries < PAUSED_TRIES; tries++) {
    const version = getDataVersion(db);
    const key = `${sessionId}|${version}|`;
    const hit = keptAt(key, db);
    if (hit) return hit;
    let build = building.get(sessionId);
    if (!build || build.db !== db || build.version !== version) {
      const started = startBuild(sessionId, db, version, key);
      if (started.model) return started.model;
      build = started.build;
    }
    while (!build.done && !build.dropped) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!build.done && !build.dropped) advance(build, false);
    }
    if (build.model) return build.model;
  }
  return modelOf(sessionId, db);
};

/**
 * A model made from the session's feed as it stands (a preview's « after »), kept and weighed with the feed's own:
 * `name` says which, `build()` makes it.
 */
const derivedModelOf = (sessionId, db, name, build) => keptModel(sessionId, db, `derived:${name}`, build);

module.exports = { modelOf, modelReady, derivedModelOf, keeps, _internals: { kept, released, building, budget, weightOf, expectedWeight, BUDGET_SHARE } };
