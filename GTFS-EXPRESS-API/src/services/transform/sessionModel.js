/**
 * The feed model of a session at its data version, built once and read by every reader of the feed (the day strip,
 * the stop sheets, the offer, the coherence report, the engine's previews, the brief's turns). The one place a
 * session's model is kept: what is kept is bounded by what the models weigh on the heap, the one read longest ago
 * leaving first, the one being read never; a model nothing can ask for any more leaves before the next one is built.
 * A reader that can wait (modelReady) lets the event loop run between the build's slices; one build of a session's
 * model at a time, whoever asks.
 */

"use strict";

const v8 = require("v8");
const { getDataVersion } = require("../../middleware/readCache");
const connection = require("../db/connection");
const { buildFeedModel, buildSteps } = require("./feedModel");

// A model's bytes from its row counts, fitted on the demo, eleven real feeds and two synthetic ones of 0.2 and 2 million
// stop_times (within a fifth of what each holds on the heap); what its readers keep on it (the days' journeys, the
// sheets' catalogue) adds about half as much.
const BYTES_PER_STOP_TIME = 80;
const BYTES_PER_TRIP = 1200;
const READERS_SHARE = 1.5;
// The share of the heap the process may use that the kept models may weigh: a draft and its working copy both stay
// for a network of 2 million stop_times under production's 1 800 MB.
const BUDGET_SHARE = 0.45;

const budget = { bytes: Math.floor(v8.getHeapStatistics().heap_size_limit * BUDGET_SHARE) };

const weightOfRows = (stopTimes, trips) => Math.round((stopTimes * BYTES_PER_STOP_TIME + trips * BYTES_PER_TRIP) * READERS_SHARE);

const weightOf = (model) => {
  let stopTimes = 0;
  for (const t of model.trips.values()) stopTimes += t.stops.length;
  return weightOfRows(stopTimes, model.trips.size);
};

/** What the model of `db` will weigh, before it is built: a table's highest rowid is never less than its rows. */
const expectedWeight = (db) => {
  try {
    const rows = db.prepare("SELECT (SELECT MAX(rowid) FROM stop_times) AS stop_times, (SELECT MAX(rowid) FROM trips) AS trips").get();
    return weightOfRows(Number(rows.stop_times) || 0, Number(rows.trips) || 0);
  } catch {
    return 0;
  }
};

// key → { sessionId, version, db, model, bytes }, the one read longest ago first.
const kept = new Map();
// A model pushed out is not gone while a reader holds it: asked again, it is given back, never built a second time.
const released = new Map();

const release = (key) => {
  const entry = kept.get(key);
  if (!entry) return;
  kept.delete(key);
  released.set(key, { db: entry.db, model: new WeakRef(entry.model) });
};

const heldStill = (key, db) => {
  for (const [k, r] of released) if (!r.model.deref() || !r.db.open) released.delete(k);
  const r = released.get(key);
  if (!r || r.db !== db) return null;
  released.delete(key);
  return r.model.deref();
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
    makeRoom(expectedWeight(db));
    model = build();
  }
  kept.set(key, { sessionId, version, db, model, bytes: weightOf(model) });
  makeRoom(0, key);
  return model;
};

// sessionId → the build of its model under way: { db, version, key, steps, done, model, dropped }.
const building = new Map();

const keptAt = (key, db) => {
  const entry = kept.get(key);
  if (!entry || entry.db !== db) return null;
  kept.delete(key);
  kept.set(key, entry);
  return entry.model;
};

const store = (sessionId, version, key, db, model) => {
  kept.set(key, { sessionId, version, db, model, bytes: weightOf(model) });
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
  makeRoom(expectedWeight(db));
  const build = { sessionId, db, version, key, steps: buildSteps(db), done: false, model: null, dropped: false };
  building.set(sessionId, build);
  return { build };
};

/**
 * One step of the build, or all of them. A build paused reads the feed in slices that the session's own writes may
 * fall between: a model that ends at another data version than it began is dropped, never kept nor given.
 */
const advance = (build, whole) => {
  try {
    let step = build.steps.next();
    while (whole && !step.done) step = build.steps.next();
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
