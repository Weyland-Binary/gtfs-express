/**
 * populationGrid — the residents of a session's feed, as a territory the
 * conformance reads (`{ population_grid: { cells: [{ lat, lon, pop }], estimated? } }`),
 * for the clause `population_coverage` wherever a plan of that feed is
 * measured: the Change Studio preview and the planner's previews.
 *
 * Without it that clause is "unknown" there, so an objective retained at ②
 * (transform/recommendations, « 81,4 % des habitants à moins de 400 m d'un
 * arrêt ») would hold the commit at ③ behind an acknowledgement, although
 * the residents were counted a moment before. The grid is the same one the
 * recommendations counted: the demand inputs of the feed (the place's
 * territory when one is named, else the feed's own area), so the target and
 * its measure agree.
 *
 *   needsGrid(requirements)   whether any clause counts residents
 *   gridOf(db, { sessionId, countryCode, place, dataIds })  the territory, or
 *                             null under the stop proxy (no resident counted:
 *                             the clause stays unknown and says why)
 *
 * The residents do not change with the plan: one grid per session, place
 * and data sources, kept 10 min (the demand inputs themselves are cached
 * 24 h per place, so even a miss costs one feed model).
 */

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 32;
const _cache = new Map(); // key → { at, territory }

const needsGrid = (requirements) => (requirements?.clauses || []).some((c) => c && c.kind === "population_coverage");

const keyOf = ({ sessionId, place, dataIds }) => JSON.stringify([sessionId || "", place || "", [...(dataIds || [])].sort()]);

const gridOf = async (db, { sessionId = null, countryCode = null, place = null, dataIds = [], deps = {} } = {}) => {
  const key = keyOf({ sessionId, place, dataIds });
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.territory;
  const { buildFeedModel } = require("../transform/feedModel");
  const { inputsForFeed, feedNameOf, countryOfFeed } = require("./feedInputs");
  const inputsService = require("./inputs");
  const territoryService = require("../network/territoryService");
  const d = {
    buildDemandInputs: (opts) => inputsService.buildDemandInputs(opts),
    getTerritory: async (p) => territoryService.getCachedTerritory(p) || (await territoryService.buildTerritory(p)),
    ...deps,
  };
  const model = buildFeedModel(db);
  const { inputs } = await inputsForFeed(model, { place, dataIds, countryCode: countryCode || countryOfFeed(db), name: feedNameOf(model, db), deps: d });
  const proxy = inputs?.quality?.population === "stop_proxy";
  const cells = proxy ? [] : (inputs?.cells || []).filter((x) => x && x.pop > 0).map((x) => ({ lat: x.lat, lon: x.lon, pop: x.pop }));
  const territory = cells.length ? { population_grid: { cells, ...(inputs.quality?.population === "default_density" ? { estimated: true } : {}) } } : null;
  if (_cache.size >= MAX_ENTRIES) _cache.delete(_cache.keys().next().value);
  _cache.set(key, { at: Date.now(), territory });
  return territory;
};

/**
 * The grid when the requirements need it, else null; never throws (a grid
 * that cannot be had leaves the clause unknown, as it was).
 */
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
