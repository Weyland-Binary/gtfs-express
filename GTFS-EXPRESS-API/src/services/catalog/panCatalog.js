/**
 * The public transit feeds of France from its National Access
 * Point, transport.data.gouv.fr: every published GTFS with the area it
 * officially covers (commune, EPCI, département, région, the whole
 * country), its validity and content, and — from the access point's own
 * stop index — whether it really serves the place. A network known by its
 * brand is found by name (findPanFeedsByName), the brand named exactly first.
 *
 * The place (lat, lon, name) is matched to its commune, EPCI, département
 * and région through geo.api.gouv.fr: the same official codes the access
 * point uses for the areas its datasets cover. A place named after a
 * département or a région widens "the place" to it.
 *
 * Tiers, most relevant first:
 *   local         a commune or EPCI of the place (the urban network, its
 *                 demand-responsive and school services)
 *   departmental  the département (interurban and school networks)
 *   regional      the région (regional trains and coaches)
 *   nearby        another commune or EPCI of the département, or a network
 *                 of another area whose stops really serve the place (lines
 *                 coming in from outside)
 *   national      the whole country, kept only when it has stops at the
 *                 place (SNCF, long-distance coaches)
 * Within a tier: current timetables before future, unknown and expired
 * ones; commercial before school-only; the ones serving the place most,
 * then the largest. Each GTFS resource of a dataset is a feed (a dataset
 * may publish several perimeters, or a lighter variant for real time).
 *
 * Throws when the access point or the geography cannot be read: the caller
 * falls back to the Mobility Database. The stop index and the per-dataset
 * details are optional (without them, validity is unknown and national
 * feeds are kept unverified).
 */

"use strict";

const config = require("../../config");

const TTL_MS = 6 * 60 * 60 * 1000;
const GEO_TTL_MS = 24 * 60 * 60 * 1000;
const LIST_TIMEOUT_MS = 60000;
const TIMEOUT_MS = 15000;
const MAX_DETAILS = 40;
const DETAIL_CONCURRENCY = 6;
const MAX_FEEDS = 24;
const STOP_BOX_DEG = 0.04; // ≈ 4.5 km each side of the centre
const NEARBY_MIN_STOPS = 10; // a network of another area kept when it really serves the place

const TIERS = ["local", "departmental", "regional", "nearby", "national"];
const STATUS_RANK = { current: 0, future: 1, unknown: 2, expired: 3 };

const FAILURE_TTL_MS = 5 * 60 * 1000; // a failed answer is not asked again for five minutes

// Keys come from the places people search (stops:lat,lon, geo:lat,lon): the least recently used go past MAX_ENTRIES.
// A key already asked for shares its answer in flight, so a burst of searches makes one request upstream.
const MAX_ENTRIES = 500;
const _cache = new Map(); // key → { at, value } | { at, error }, oldest use first
const _inFlight = new Map(); // key → promise
const remember = (key, entry) => {
  _cache.delete(key);
  _cache.set(key, entry);
  while (_cache.size > MAX_ENTRIES) _cache.delete(_cache.keys().next().value);
};
const cached = async (key, ttl, fn) => {
  const hit = _cache.get(key);
  if (hit && hit.error && Date.now() - hit.at < FAILURE_TTL_MS) throw hit.error;
  if (hit && !hit.error && Date.now() - hit.at < ttl) {
    remember(key, hit);
    return hit.value;
  }
  if (_inFlight.has(key)) return _inFlight.get(key);
  const asked = (async () => {
    try {
      const value = await fn();
      remember(key, { at: Date.now(), value });
      return value;
    } catch (error) {
      remember(key, { at: Date.now(), error });
      throw error;
    } finally {
      _inFlight.delete(key);
    }
  })();
  _inFlight.set(key, asked);
  return asked;
};

const unavailable = (message) => Object.assign(new Error(message), { status: 502, code: "PAN_UNAVAILABLE" });

// A connection the access point closed under the client ("terminated", a socket reset): a pooled keep-alive socket
// the server had already dropped, seen on the 2.5 MB dataset list of a long-running API while a fresh process gets
// it. One new attempt, never more; a timeout or an HTTP error is an answer and is not retried.
const droppedConnection = (err) => {
  const code = err?.cause?.code || err?.code || "";
  return err?.name !== "AbortError" && (err?.message === "terminated" || err?.message === "fetch failed" || ["UND_ERR_SOCKET", "ECONNRESET", "UND_ERR_CLOSED", "EPIPE"].includes(code));
};

const getJsonOnce = async (fetchImpl, url, ms) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { Accept: "application/json", "User-Agent": "gtfs-express/1.0" } });
    if (!res || !res.ok) throw unavailable(`${new URL(url).host}: HTTP ${res ? res.status : "no response"}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const getJson = async (fetchImpl, url, ms = TIMEOUT_MS) => {
  try {
    return await getJsonOnce(fetchImpl, url, ms);
  } catch (err) {
    if (!droppedConnection(err)) throw err;
    return getJsonOnce(fetchImpl, url, ms);
  }
};

/** Run `fn` over `items`, `n` at a time. */
const mapLimit = async (items, n, fn) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
};

const fold = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const ymd = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso || "")) ? String(iso).slice(0, 10).replace(/-/g, "") : null);
// A resource title that is only a URL or a file name says nothing.
const blankTitle = (t) => !t || /^https?:\/\//i.test(t) || /\.zip$/i.test(t);
// The département of a commune's INSEE code (overseas: three digits).
const deptOfCommune = (insee) => (/^97/.test(String(insee)) ? String(insee).slice(0, 3) : String(insee).slice(0, 2));

// ── The access point ────────────────────────────────────────────────────────

/** Every public-transit dataset with at least one available GTFS resource. */
const loadDatasets = (fetchImpl) =>
  cached("datasets", TTL_MS, async () => {
    const rows = await getJson(fetchImpl, `${config.PAN_URL}/api/datasets`, LIST_TIMEOUT_MS);
    if (!Array.isArray(rows)) throw unavailable("transport.data.gouv.fr: unexpected answer");
    return rows
      .filter((d) => d && d.type === "public-transit")
      .map((d) => ({
        id: String(d.id),
        slug: d.slug || null,
        title: d.title || "",
        page_url: d.page_url || null,
        licence: d.licence || null,
        updated: d.updated || null,
        sub_types: Array.isArray(d.sub_types) ? d.sub_types : [],
        areas: (d.covered_area || []).map((c) => ({ type: c.type, name: c.nom || "", code: String(c.insee ?? "") })),
        owners: (d.legal_owners || []).map((o) => o.name).filter(Boolean),
        publisher: d.publisher?.name || null,
        offers: (d.offers || []).map((o) => o.nom_commercial).filter(Boolean),
        resources: (d.resources || [])
          .filter((r) => String(r.format || "").toUpperCase() === "GTFS" && r.is_available !== false && r.url)
          // A title that is only a URL or a file name says nothing: dropped.
          .map((r) => ({ id: String(r.id), title: blankTitle(r.title) ? "" : r.title, url: r.url, updated: r.updated || null })),
      }))
      .filter((d) => d.resources.length);
  });

/** One GTFS resource of a dataset as the search lists it (`m`: the access point's analysis of it, when read). */
const feedOf = ({ d, r, tier, m = null, near = null, today, named = false }) => {
  const validity = m && (m.start || m.end) ? { start: m.start, end: m.end } : null;
  const coverage = d.areas.map((a) => a.name).filter(Boolean).join(", ");
  return {
    source: "pan",
    id: `pan-${r.id}`,
    dataset_id: d.id,
    resource_id: r.id,
    provider: d.owners[0] || d.publisher || d.title,
    name: d.title,
    resource_title: r.title,
    offers: d.offers.slice(0, 6),
    coverage,
    municipality: coverage,
    region: "",
    country: "FR",
    url: r.url,
    page_url: d.page_url,
    license: d.licence,
    scope: tier,
    covers_centre: tier === "local" || tier === "departmental" || tier === "regional" || (near || 0) > 0,
    stops_near: near,
    named,
    kinds: d.sub_types,
    validity,
    status: statusOf(validity, today),
    stats: m ? { routes: m.routes, trips: m.trips, stops: m.stops } : null,
    modes: m?.modes || [],
    networks: m?.networks || [],
    has_shapes: m ? m.has_shapes : null,
    features: m?.features || [],
    updated: r.updated || d.updated,
    area_deg2: null,
  };
};
const schoolOnly = (f) => f.kinds.includes("school") && !f.kinds.some((k) => k === "urban" || k === "intercity");

/** Validity, size and content of a dataset's GTFS resources (the access point's own analysis). */
const datasetDetails = (fetchImpl, id) =>
  cached(`detail:${id}`, TTL_MS, async () => {
    const d = await getJson(fetchImpl, `${config.PAN_URL}/api/datasets/${encodeURIComponent(id)}`);
    const out = new Map();
    for (const r of d?.resources || []) {
      if (String(r.format || "").toUpperCase() !== "GTFS") continue;
      const m = r.metadata || {};
      const s = m.stats || {};
      out.set(String(r.id), {
        start: ymd(m.start_date),
        end: ymd(m.end_date),
        routes: s.routes_count ?? null,
        trips: s.trips_count ?? null,
        stops: s.stops_count ?? m.stops_count ?? null,
        modes: Array.isArray(m.modes) ? m.modes : Array.isArray(r.modes) ? r.modes : [],
        networks: Array.isArray(m.networks) ? m.networks : [],
        has_shapes: typeof m.has_shapes === "boolean" ? m.has_shapes : null,
        features: Array.isArray(r.features) ? r.features : [],
        filesize: Number.isFinite(r.filesize) ? r.filesize : null,
      });
    }
    return out;
  });

/** GTFS stops the access point indexes around the centre, counted per resource. */
const stopsNear = (fetchImpl, lat, lon) =>
  cached(`stops:${lat.toFixed(3)},${lon.toFixed(3)}`, TTL_MS, async () => {
    const dLat = STOP_BOX_DEG;
    const dLon = STOP_BOX_DEG / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const q = `south=${(lat - dLat).toFixed(5)}&north=${(lat + dLat).toFixed(5)}&west=${(lon - dLon).toFixed(5)}&east=${(lon + dLon).toFixed(5)}`;
    const fc = await getJson(fetchImpl, `${config.PAN_URL}/api/gtfs-stops?${q}`);
    const byResource = new Map();
    for (const f of fc?.features || []) {
      const rid = String(f?.properties?.resource_id ?? "");
      if (rid) byResource.set(rid, (byResource.get(rid) || 0) + 1);
    }
    return byResource;
  });

// ── The official geography ──────────────────────────────────────────────────

/** The commune at a point, with its EPCI, département and région codes. */
const placeCodes = (fetchImpl, lat, lon) =>
  cached(`geo:${lat.toFixed(4)},${lon.toFixed(4)}`, GEO_TTL_MS, async () => {
    const rows = await getJson(fetchImpl, `${config.GEO_API_URL}/communes?lat=${lat}&lon=${lon}&fields=code,nom,codeEpci,epci,codeDepartement,codeRegion`);
    const c = Array.isArray(rows) ? rows[0] : null;
    if (!c || !c.code) return null;
    return { commune: { code: String(c.code), name: c.nom || "" }, epci: c.codeEpci ? { code: String(c.codeEpci), name: c.epci?.nom || "" } : null, departement: c.codeDepartement ? String(c.codeDepartement) : null, region: c.codeRegion ? String(c.codeRegion) : null };
  });

const departements = (fetchImpl) =>
  cached("geo:departements", GEO_TTL_MS, async () => {
    const rows = await getJson(fetchImpl, `${config.GEO_API_URL}/departements?fields=code,nom,codeRegion`);
    return new Map((Array.isArray(rows) ? rows : []).map((d) => [String(d.code), { name: d.nom || "", region: String(d.codeRegion || "") }]));
  });

const regions = (fetchImpl) =>
  cached("geo:regions", GEO_TTL_MS, async () => {
    const rows = await getJson(fetchImpl, `${config.GEO_API_URL}/regions?fields=code,nom`);
    return new Map((Array.isArray(rows) ? rows : []).map((r) => [String(r.code), r.nom || ""]));
  });

const epciDepartements = (fetchImpl) =>
  cached("geo:epcis", GEO_TTL_MS, async () => {
    const rows = await getJson(fetchImpl, `${config.GEO_API_URL}/epcis?fields=code,codesDepartements`);
    return new Map((Array.isArray(rows) ? rows : []).map((e) => [String(e.code), (e.codesDepartements || []).map(String)]));
  });

/** "commune" by default; "departement" or "region" when the place is named after one. */
const placeLevel = (place, codes, deps, regs) => {
  const name = fold(place?.name);
  if (!name) return "commune";
  if (codes.departement && fold(deps.get(codes.departement)?.name) === name) return "departement";
  if (codes.region && fold(regs.get(codes.region)) === name) return "region";
  return "commune";
};

// ── Matching and ranking ────────────────────────────────────────────────────

/** The tier a dataset's covered areas give it for the place, or null. */
const tierByArea = (d, { codes, level, deps, epcis }) => {
  const inPlaceDept = (dept) => (level === "region" ? deps.get(dept)?.region === codes.region : dept === codes.departement);
  let best = null;
  const take = (t) => {
    if (best == null || TIERS.indexOf(t) < TIERS.indexOf(best)) best = t;
  };
  for (const a of d.areas) {
    if (a.type === "commune") {
      if (a.code === codes.commune.code) take("local");
      else if (inPlaceDept(deptOfCommune(a.code))) take(level === "commune" ? "nearby" : "local");
    } else if (a.type === "epci") {
      if (codes.epci && a.code === codes.epci.code) take("local");
      else if ((epcis.get(a.code) || []).some(inPlaceDept)) take(level === "commune" ? "nearby" : "local");
    } else if (a.type === "departement") {
      if (a.code === codes.departement || (level === "region" && inPlaceDept(a.code))) take("departmental");
    } else if (a.type === "region") {
      if (a.code === codes.region) take("regional");
    } else if (a.type === "pays") take("national");
  }
  return best;
};

const statusOf = (v, today) => {
  if (!v || (!v.start && !v.end)) return "unknown";
  if (v.end && v.end < today) return "expired";
  if (v.start && v.start > today) return "future";
  return "current";
};

const todayYmd = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/** The feeds of France serving a place (see the header). */
const findPanFeeds = async (place, { fetchImpl, today = todayYmd() } = {}) => {
  const lat = Number(place?.lat);
  const lon = Number(place?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw unavailable("No coordinates for the place.");
  const [datasets, codes] = await Promise.all([loadDatasets(fetchImpl), placeCodes(fetchImpl, lat, lon)]);
  if (!codes) return { feeds: [], codes: null, level: null };
  const [deps, regs, epcis, stops] = await Promise.all([departements(fetchImpl).catch(() => new Map()), regions(fetchImpl).catch(() => new Map()), epciDepartements(fetchImpl).catch(() => new Map()), stopsNear(fetchImpl, lat, lon).catch(() => null)]);
  const level = placeLevel(place, codes, deps, regs);
  const ctx = { codes, level, deps, epcis };

  // Candidates: by the area they cover, or by their stops at the place.
  const candidates = [];
  const seen = new Set();
  for (const d of datasets) {
    const near = stops ? Math.max(0, ...d.resources.map((r) => stops.get(r.id) || 0)) : null;
    let tier = tierByArea(d, ctx);
    if (tier === "national" && stops && !near) continue; // the whole country, but no stop here
    // Kept for its stops (another area, or the whole country): only its files that have some here.
    let byStops = tier === "national";
    if (!tier && near >= NEARBY_MIN_STOPS) {
      tier = "nearby";
      byStops = true;
    }
    if (!tier) continue;
    candidates.push({ d, tier, near, byStops });
  }
  // Details (validity, size) for the most relevant candidates first.
  const provisional = (c) => TIERS.indexOf(c.tier) * 1e6 - (c.near || 0);
  candidates.sort((a, b) => provisional(a) - provisional(b));
  const details = new Map();
  await mapLimit(candidates.slice(0, MAX_DETAILS), DETAIL_CONCURRENCY, async (c) => {
    try {
      details.set(c.d.id, await datasetDetails(fetchImpl, c.d.id));
    } catch {
      /* validity stays unknown */
    }
  });

  const feeds = [];
  for (const { d, tier, byStops } of candidates) {
    const det = details.get(d.id) || new Map();
    for (const r of d.resources) {
      if (seen.has(r.id)) continue; // a resource shared by an aggregate
      if (byStops && stops && !stops.get(r.id)) continue;
      seen.add(r.id);
      feeds.push(feedOf({ d, r, tier, m: det.get(r.id) || null, near: stops ? stops.get(r.id) || 0 : null, today }));
    }
  }
  feeds.sort(
    (a, b) =>
      TIERS.indexOf(a.scope) - TIERS.indexOf(b.scope) ||
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      Number(schoolOnly(a)) - Number(schoolOnly(b)) ||
      (b.stops_near || 0) - (a.stops_near || 0) ||
      (b.stats?.trips || 0) - (a.stats?.trips || 0) ||
      String(b.updated || "").localeCompare(String(a.updated || "")),
  );
  return { feeds: feeds.slice(0, MAX_FEEDS), codes, level };
};

// The tier a dataset found by name says of itself: the widest area it covers.
const ownTier = (d) => {
  const types = new Set(d.areas.map((a) => a.type));
  return types.has("pays") ? "national" : types.has("region") ? "regional" : types.has("departement") ? "departmental" : "local";
};
const MAX_BY_NAME = 12;

const findPanFeedsByName = async (query, { fetchImpl, today = todayYmd() } = {}) => {
  const wanted = fold(query);
  const words = wanted.split(" ").filter((w) => w.length >= 2);
  if (!words.length) return { feeds: [] };
  const datasets = await loadDatasets(fetchImpl);
  const hits = [];
  for (const d of datasets) {
    const brand = [...d.offers, d.title].map(fold);
    const hay = ` ${fold([d.title, d.slug, ...d.offers, ...d.owners, d.publisher].filter(Boolean).join(" "))} `;
    if (!words.every((w) => hay.includes(w))) continue;
    // Named exactly (its commercial name, or a whole word of its title) before a mere mention.
    const exact = brand.some((b) => b === wanted || ` ${b} `.includes(` ${wanted} `));
    hits.push({ d, exact });
  }
  hits.sort((a, b) => Number(b.exact) - Number(a.exact) || TIERS.indexOf(ownTier(a.d)) - TIERS.indexOf(ownTier(b.d)));
  const kept = hits.slice(0, MAX_BY_NAME);
  const details = new Map();
  await mapLimit(kept, DETAIL_CONCURRENCY, async ({ d }) => {
    try {
      details.set(d.id, await datasetDetails(fetchImpl, d.id));
    } catch {
      /* validity stays unknown */
    }
  });
  const feeds = [];
  const seen = new Set();
  for (const { d, exact } of kept) {
    const det = details.get(d.id) || new Map();
    for (const r of d.resources) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      feeds.push({ ...feedOf({ d, r, tier: ownTier(d), m: det.get(r.id) || null, today, named: true }), name_match: exact ? "exact" : "partial" });
    }
  }
  feeds.sort(
    (a, b) =>
      Number(b.name_match === "exact") - Number(a.name_match === "exact") ||
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      Number(schoolOnly(a)) - Number(schoolOnly(b)) ||
      (b.stats?.trips || 0) - (a.stats?.trips || 0),
  );
  return { feeds: feeds.slice(0, MAX_FEEDS) };
};

module.exports = { findPanFeeds, findPanFeedsByName, _internals: { reset: () => (_cache.clear(), _inFlight.clear()), cacheSize: () => _cache.size, cached, MAX_ENTRIES, getJson, droppedConnection, fold, deptOfCommune, tierByArea, statusOf, placeLevel, TIERS } };
