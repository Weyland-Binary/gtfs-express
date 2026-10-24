/**
 * The residents of a session's feed as a territory, so the clause
 * `population_coverage` can be measured. It is the grid the demand estimates
 * count on, so a target and its measure agree; null under the stop proxy.
 * The residents do not change with the plan: one grid per session, kept 10 min.
 */

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 32;
const _cache = new Map(); // key → { at, territory }

const needsGrid = (requirements) => (requirements?.clauses || []).some((c) => c && c.kind === "population_coverage");

const keyOf = ({ sessionId }) => String(sessionId || "");

const gridOf = async (db, { sessionId = null, countryCode = null, deps = {} } = {}) => {
  const key = keyOf({ sessionId });
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.territory;
  const { buildFeedModel } = require("../transform/feedModel");
  const { inputsForFeed, feedNameOf, countryOfFeed } = require("./feedInputs");
  const inputsService = require("./inputs");
  const d = { buildDemandInputs: (opts) => inputsService.buildDemandInputs(opts), ...deps };
  const model = buildFeedModel(db);
  const { inputs } = await inputsForFeed(model, { countryCode: countryCode || countryOfFeed(db), name: feedNameOf(model, db), deps: d });
  const proxy = inputs?.quality?.population === "stop_proxy";
  const cells = proxy ? [] : (inputs?.cells || []).filter((x) => x && x.pop > 0).map((x) => ({ lat: x.lat, lon: x.lon, pop: x.pop }));
  const territory = cells.length ? { population_grid: { cells, ...(inputs.quality?.population === "default_density" ? { estimated: true } : {}) } } : null;
  if (_cache.size >= MAX_ENTRIES) _cache.delete(_cache.keys().next().value);
  _cache.set(key, { at: Date.now(), territory });
  return territory;
};

/** Never throws: a grid that cannot be had leaves the clause unknown, as without one. */
const territoryFor = async (db, requirements, opts = {}) => {
  if (!needsGrid(requirements)) return null;
  try {
    return await gridOf(db, opts);
  } catch (err) {
    if (err?.status === 499) throw err; // aborted by the caller
    return null;
  }
};

module.exports = { needsGrid, gridOf, territoryFor, _internals: { _cache, TTL_MS } };
