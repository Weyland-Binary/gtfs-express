/**
 * calendarContext — the country and the school zone of a working copy whose
 * session does not know them.
 *
 * The change engine resolves « school days », « school holidays » and
 * « public holidays » (calendars.named) from the session's country and school
 * region (sessionCountry). A session learns them only when its network is
 * opened from the catalogue: an uploaded feed, a shared one, a version
 * reopened has neither, and every operation or clause naming a school period
 * then asks « which country? », then « which region? ». The feed itself
 * usually says both:
 *
 *   • its country — the one its agency's time zone names, as the demand
 *     inputs read it (feedInputs.countryOfFeed: France, its overseas
 *     départements, a few neighbours), else as the coherence report does
 *     (dayTypes.countryOfFeed: France's other territories);
 *   • its school zone — the one its own calendars follow: the coherence
 *     report's inference (dayTypes.schoolCalendarFor), asked with the very
 *     inputs coherenceService.reportOf builds (the feed's window, the
 *     services running on each date, the agency's time zone).
 *
 *   contextOf(db, sessionId, { fetchImpl, model }) (async)
 *     → { country, country_source: "session" | "feed" | null,
 *         region, region_source: "session" | "inferred" | null }
 *   feedCountry(db) → the country the feed itself names (lowercase alpha-2),
 *     or null: the country alone, without the zone (a plan naming the public
 *     holidays needs no school calendar) — never throws
 *
 * `country` is lowercase alpha-2, as the session keeps it; `region` is the
 * session's own words, or a zone as schoolCalendarFor names it ("A", "B",
 * "C", "CO") — both as calendars.named reads them.
 *
 * What the session knows always wins, and is read at every call. The zone
 * read from the feed decides dates WRITTEN in a feed, where the report only
 * shows it, so it is taken on firmer ground than the report's:
 *   • a metropolitan feed only (agency time zone Europe/Paris), whose
 *     candidates are the zones A, B, C and Corsica: overseas a dozen
 *     territories are compared and a coincidence wins (a Martinique feed
 *     can follow another territory's holidays better than its own);
 *   • the single best zone (region_source "inferred", never the holidays
 *     "common" to every zone), ahead of the next one by MIN_LEAD_DAYS
 *     weekdays: a day or two ahead is a bridge day, not a zone (a Moselle
 *     feed reads as zone A, 33 weekdays against 32);
 *   • agreeing with the feed on most of its weekdays: over a window that is
 *     mostly summer the holiday timetable is the usual one, every zone
 *     disagrees almost everywhere and the best of them is noise (Dieppe and
 *     Beauvais read as Corsica, 3 weekdays against 1).
 * Anything else is no zone (null) and the engine asks: nothing is guessed.
 *
 * Never throws (what fails is null, and said in the log) and never fetches
 * by itself: the school holidays are dayTypes' to read (OpenHolidays through
 * its own fetcher — off under Jest unless a fetch is injected, off with
 * SCHOOL_HOLIDAYS_FETCH_ENABLED=false — and cached a day there). A caller's
 * `fetchImpl` (a test's, an evaluation's frozen world) goes through
 * dayTypes.deps for the time of the call alone.
 *
 * The zone costs a feed model (unless the caller hands the `model` it
 * already built of this database) and is kept per session and version of
 * the working copy (readCache.getDataVersion): 20 minutes, 50 entries, the
 * oldest dropped. A zone that could not be read because the school calendar
 * could not (the fetch off, the service down) is asked again after
 * 2 minutes. Without a session, or on a database without a file (a sandbox,
 * a test feed), nothing is kept and the feed is read each time: two such
 * databases would share one version.
 */

"use strict";

const { getDataVersion } = require("../../middleware/readCache");
const sessionCountry = require("../sessionCountry");
const feedInputs = require("../demand/feedInputs");
const dayTypes = require("../coherence/dayTypes");
const coherence = require("../coherence/coherenceService");
const feedModel = require("./feedModel");

const TTL_MS = 20 * 60 * 1000;
const RETRY_TTL_MS = 2 * 60 * 1000; // the school calendar could not be read: asked again soon
const MAX_ENTRIES = 50;
const MIN_LEAD_DAYS = 3; // weekdays the best zone must be ahead of the next one
const METROPOLITAN_TIMEZONE = "Europe/Paris";

const _cache = new Map(); // key → { at, region, retry }

const lifeOf = (entry) => (entry.retry ? RETRY_TTL_MS : TTL_MS);

// Nothing here is expected to fail (a calendar that cannot be read is an answer of dayTypes, not a throw): what
// does is said in the log and answered null — the engine asks — never thrown at the request.
const unexpected = (what, err) => console.warn(`calendarContext: ${what} could not be read:`, err?.message || err);

/** The agency's time zone as the coherence report reads it (the first agency's), trimmed. */
const timezoneOf = (db) => String(coherence.agencyTimezone(db) || "").trim() || null;

/**
 * The country the feed itself names (lowercase alpha-2) or null: its agency's time zone, as the demand inputs read
 * it, else as the coherence report does — but only for a time zone the demand table does not know (France's
 * smaller territories). One it knows was read there already and its null stands: agencies of several countries
 * in one feed are no answer, never the first agency's. Exported for the callers that need the country alone (the
 * preview of a plan naming the public holidays, a planner turn): each reader below answers null for a database
 * without an agency table, so this never throws.
 */
const feedCountry = (db) => {
  const named = sessionCountry.normalizeCountryCode(feedInputs.countryOfFeed(db));
  if (named) return named;
  const timezone = timezoneOf(db);
  if (!timezone || feedInputs._internals.TZ_COUNTRY[timezone]) return null;
  return sessionCountry.normalizeCountryCode(dayTypes.countryOfFeed({ timezone }));
};

/** The window's weekdays (Monday to Friday): the days the zones' scores are counted on, at most. */
const weekdaysOf = (signatures) => {
  let n = 0;
  for (const d of signatures.keys()) {
    const dow = dayTypes._internals.dowOf(d);
    if (dow !== "sat" && dow !== "sun") n += 1;
  }
  return n;
};

/**
 * The zone schoolCalendarFor inferred, when it stands clear (see the header): the single best one, ahead of the
 * next by MIN_LEAD_DAYS weekdays and agreeing with the feed on more than half the window's weekdays. null otherwise.
 */
const clearZone = (school, signatures) => {
  if (!school || school.status !== "ok" || school.region_source !== "inferred" || !school.region) return null;
  const scores = school.region_scores && typeof school.region_scores === "object" ? school.region_scores : {};
  const best = Number(scores[school.region]);
  if (!Number.isFinite(best)) return null;
  const next = Object.entries(scores).filter(([r]) => r !== school.region).reduce((m, [, n]) => Math.max(m, Number(n) || 0), 0);
  if (best - next < MIN_LEAD_DAYS) return null;
  if (2 * best <= weekdaysOf(signatures)) return null;
  return String(school.region);
};

/**
 * dayTypes asked with the caller's fetch, through its own injection point (deps.fetchImpl, as its tests do) and put
 * back at once: schoolCalendarFor picks its fetch before its first await, so no other request ever sees the swap.
 */
const withFetch = (fetchImpl, ask) => {
  if (!fetchImpl) return ask();
  const saved = dayTypes.deps.fetchImpl;
  dayTypes.deps.fetchImpl = fetchImpl;
  try {
    return ask();
  } finally {
    dayTypes.deps.fetchImpl = saved;
  }
};

/** A session's working copy at its version; null without a session or for a database with no file (never kept). */
const keyOf = (db, sessionId) => (sessionId && db && db.name && !db.memory ? `${sessionId}|${db.name}|${getDataVersion(db)}` : null);

const remember = (key, region, retry) => {
  if (!key) return;
  const now = Date.now();
  // What is past its life goes (this key's former answer first of all), then the oldest beyond MAX_ENTRIES.
  for (const [k, v] of _cache) if (now - v.at >= lifeOf(v)) _cache.delete(k);
  _cache.set(key, { at: now, region, retry });
  while (_cache.size > MAX_ENTRIES) _cache.delete(_cache.keys().next().value);
};

/** The school zone a metropolitan feed's own calendars follow ("A", "B", "C", "CO"), or null when none stands clear. */
const zoneOf = async (db, sessionId, { fetchImpl = null, model = null } = {}) => {
  const timezone = timezoneOf(db);
  if (timezone !== METROPOLITAN_TIMEZONE) return null;
  const key = keyOf(db, sessionId);
  const hit = key ? _cache.get(key) : null;
  if (hit && Date.now() - hit.at < lifeOf(hit)) return hit.region;
  // The report's own inputs (coherenceService.reportOf): the feed's window, each date's services, the time zone.
  const feed = model && model.services instanceof Map && model.trips instanceof Map ? model : feedModel.buildFeedModel(db);
  const window = coherence._internals.windowOf(feed);
  let region = null;
  let retry = false;
  if (window) {
    const signatures = coherence._internals.dayIndex(feed, window).keys;
    let school = null;
    try {
      school = await withFetch(fetchImpl, () => dayTypes.schoolCalendarFor({ country: "FR", region: null, territory: null, window, signatures, timezone }));
    } catch (err) {
      unexpected("the school calendar", err); // kept like a calendar that could not be read: asked again soon
    }
    region = clearZone(school, signatures);
    // Not read at all (no source: the fetch is off or failed) is asked again soon; a calendar that was read and
    // says nothing of this window (nothing published for its dates) is an answer, kept like any other.
    retry = !school || (school.status === "unavailable" && !school.source);
  }
  remember(key, region, retry);
  return region;
};

/**
 * The country and the school zone the engine resolves a working copy's named periods with: the session's, else
 * the feed's own. Each is null (with a null source) when neither tells; a failure is null too, never a throw.
 */
const contextOf = async (db, sessionId, { fetchImpl = null, model = null } = {}) => {
  const out = { country: null, country_source: null, region: null, region_source: null };
  try {
    const known = sessionCountry.sessionCountryCode(sessionId);
    const own = known ? null : feedCountry(db);
    out.country = known || own;
    out.country_source = known ? "session" : own ? "feed" : null;
  } catch (err) {
    unexpected("the country", err);
  }
  try {
    const known = sessionCountry.sessionSchoolRegion(sessionId);
    // France alone has a zone to read here: elsewhere schoolCalendarFor knows no school calendar.
    const own = !known && out.country === "fr" ? await zoneOf(db, sessionId, { fetchImpl, model }) : null;
    out.region = known || own;
    out.region_source = known ? "session" : own ? "inferred" : null;
  } catch (err) {
    unexpected("the school zone", err);
  }
  return out;
};

module.exports = { contextOf, feedCountry, _internals: { _cache, TTL_MS, RETRY_TTL_MS, MAX_ENTRIES, MIN_LEAD_DAYS, feedCountry } };
