/** The public networks serving a place, and one of them opened as a new session like an upload. */

"use strict";

const territoryService = require("../network/territoryService");
const catalogService = require("./catalogService");
const { recordEvent, extractReqMeta } = require("../eventLogger");

// The places the search resolved, for the open that follows it to know the network's country; bounded, the oldest
// dropped first.
const _places = new Map();
const MAX_PLACES = 64;
const keepPlace = (query, resolved) => {
  if (!resolved) return;
  _places.delete(query);
  if (_places.size >= MAX_PLACES) _places.delete(_places.keys().next().value);
  _places.set(query, resolved);
};

/** The French région a place's display name names (one of its comma-separated parts), or null. */
const regionOfPlace = (displayName) => {
  const { FR_REGION_NAMES } = require("../network/schoolCalendar")._internals;
  for (const part of String(displayName || "").split(",")) {
    const letters = part.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]/g, "");
    if (FR_REGION_NAMES[letters]) return part.trim();
  }
  return null;
};

const getCatalog = async (req, res) => {
  const place = typeof req.query?.place === "string" ? req.query.place.trim() : "";
  if (place.length < 2) return res.status(400).json({ error: "INVALID_INPUT", message: "place is required." });
  try {
    const doFetch = typeof fetch === "function" ? fetch : null;
    const query = place.slice(0, 200);
    // The words are a place (a town, an urban area) or a network's own name (its brand): both are asked at once.
    const [resolved, byName] = await Promise.all([
      doFetch ? territoryService._internals.resolvePlace(query, doFetch).catch(() => null) : null,
      catalogService.findFeedsByName(query).catch(() => ({ feeds: [], sources: null })),
    ]);
    if (!resolved) {
      if (!byName.feeds.length) return res.status(404).json({ error: "PLACE_NOT_FOUND", message: `No place and no network found for "${query}".` });
      return res.json({ place: query, feeds: byName.feeds, sources: byName.sources, codes: null, light: true, by_name: true });
    }
    keepPlace(place, resolved);
    const { feeds, sources, codes } = await catalogService.findFeedsDetailed({ place: resolved });
    // A network named exactly by the words comes first; the place's networks follow, each once.
    const exact = byName.feeds.filter((f) => f.name_match === "exact");
    const seen = new Set(exact.map((f) => f.id));
    const merged = [...exact, ...feeds.filter((f) => !seen.has(f.id))].slice(0, 30);
    // Named exactly, the network is what was asked: the words are said back, not a place of the same name elsewhere.
    return res.json({ place: exact.length ? query : resolved.display_name, feeds: merged, sources, codes, light: true, ...(exact.length ? { by_name: true } : {}) });
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.code || "CATALOG_FAILED", message: err.message });
  }
};

const openCatalogFeed = async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2000) return res.status(400).json({ error: "INVALID_INPUT", message: "url (http/https, a GTFS zip) is required." });
  const name = typeof req.body?.name === "string" ? req.body.name.slice(0, 120) : null;
  const place = typeof req.body?.place === "string" ? req.body.place.trim() : "";
  const resolved = place.length >= 2 ? _places.get(place) || null : null;
  const countryCode = resolved?.country_code || null;
  // The French région the place's name carries gives its school zone: the network's school periods are then resolved
  // without asking.
  const schoolRegion = String(countryCode || "").toUpperCase() === "FR" ? regionOfPlace(resolved?.display_name) : null;
  const started = Date.now();
  try {
    const r = await require("./feedSessionService").openFeedAsSession(url, { name, req, countryCode, schoolRegion });
    recordEvent("network.catalog_open", { ...extractReqMeta(req), routes: r.counts?.routes ?? null, trips: r.counts?.trips ?? null, durationMs: Date.now() - started });
    return res.status(201).json(r);
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.code || "OPEN_FAILED", message: err.message });
  }
};

module.exports = { getCatalog, openCatalogFeed };
