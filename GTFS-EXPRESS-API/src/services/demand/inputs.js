/**
 * What the demand model knows about a territory: residents, jobs and students on a 250 m grid (students at
 * their place of study), named generators, OD flows and the observed ridership, each layer with its sources
 * and quality. A generator's jobs and students are ALREADY in its cell: never add them twice. Every typical
 * value is flagged `estimated` and stated once in `warnings`: nothing is silently guessed.
 */

"use strict";

const config = require("../../config");
const { CELL_M, createGrid, isBbox, inBbox, round5 } = require("./grid");
const { addSource } = require("./sources");

const MAX_CELLS = 6000;
const MAX_GENERATORS = 600;
const MAX_OD = 3000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PARTIAL_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 24;

const LAYERS = ["pop", "jobs", "students"];

// Typical sizes of OpenStreetMap places, used only when no official figure exists and always flagged
// estimated: jobs and students are persons at the place, visits those it attracts on a weekday; a name
// refines the category (first matching rule wins).
const OSM_PROXY = {
  work: { jobs: 40 }, // office, industrial / commercial / retail land
  market: { jobs: 30, visits: 1500 }, // supermarket, mall, marketplace
  hospital: { jobs: 150, visits: 600 }, // hospital or clinic, size unknown
  civic: { jobs: 25, visits: 150 }, // town hall, court, library
  school: { jobs: 15, students: 200 }, // school or kindergarten, level unknown
  college: { jobs: 80, students: 1000 }, // college or university
  station: { jobs: 5, visits: 1000 }, // rail / bus station, ferry, airport
  leisure: { jobs: 10, visits: 300 }, // stadium, sports centre, museum, attraction
};
const OSM_PROXY_BY_NAME = {
  school: [
    [/universit|faculte|campus|\biut\b|\binsa\b|ecole (nationale|superieure|d.ingenieurs|de commerce)/, { jobs: 150, students: 2000 }],
    [/lycee|high school/, { jobs: 70, students: 750 }],
    [/college/, { jobs: 45, students: 530 }],
    [/maternelle|kindergarten|nursery|creche/, { jobs: 8, students: 95 }],
    [/elementaire|primaire|primary|groupe scolaire|ecole/, { jobs: 10, students: 140 }],
  ],
  college: [
    [/universit|faculte|campus/, { jobs: 150, students: 2000 }],
    [/lycee/, { jobs: 70, students: 750 }],
    [/\biut\b|\binsa\b|ecole|institut/, { jobs: 60, students: 800 }],
  ],
  hospital: [
    [/\bchu\b|\bchr\b|hospitalier universitaire|university hospital/, { jobs: 3000, visits: 3000 }],
    [/centre hospitalier|hopital|hospital/, { jobs: 800, visits: 1500 }],
    [/clinique|clinic|cabinet|centre medical|maison (de sante|medicale)|dispensaire/, { jobs: 60, visits: 200 }],
  ],
  market: [
    [/hypermarche|centre commercial|shopping (centre|center|mall)|galerie|retail park/, { jobs: 150, visits: 5000 }],
    [/supermarche|supermarket/, { jobs: 40, visits: 1500 }],
    [/marche|market/, { jobs: 20, visits: 800 }],
  ],
};
const PROXY_NOTE = {
  jobs: "jobs are a rough proxy: typical job counts per OpenStreetMap place (office or business land 40, shop or mall 30–150, hospital 150–3 000, clinic 60, school 8–150, town hall 25), not a count of jobs",
  students: "students are typical enrolments per OpenStreetMap school or college (by name: nursery 95, primary 140, collège 530, lycée 750, university 2 000; otherwise 200 per school and 1 000 per college), not official counts",
  weight: "OpenStreetMap places weigh their typical size (jobs + students + typical weekday visits), flagged estimated",
};

const fold = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Typical { jobs, students, visits } of a dossier POI (category, then name). */
const osmProxy = (poi) => {
  const base = OSM_PROXY[poi.category] || {};
  const name = fold(poi.name);
  const rule = (OSM_PROXY_BY_NAME[poi.category] || []).find(([re]) => re.test(name));
  const p = rule ? rule[1] : base;
  return { jobs: p.jobs || 0, students: p.students || 0, visits: p.visits || 0 };
};

// ── Sources

/** The dossier's sources a layer was built from, with what they were used for. */
const dossierSources = (territory, usedFor) => {
  const byId = new Map((territory?.sources || []).map((s) => [s.id, s]));
  const pick = (id, used) => {
    const s = byId.get(id);
    return s && used.length ? { id: s.id, name: s.name, url: s.url || null, license: s.license || null, used_for: used } : null;
  };
  return [pick("osm", usedFor.osm), pick("overpass", usedFor.osm), pick("wikidata", usedFor.wikidata), pick("nominatim", usedFor.nominatim)].filter(Boolean);
};


// A draft holds each layer as points { lat, lon, v, commune?, kind? }, so a provider can replace a layer
// (or the part a kind marks) without unpicking cells; finalize() bins them onto the grid.

const emptyDraft = (territory) => {
  const p = territory?.place || null;
  const bbox = p && isBbox(p.bbox) ? p.bbox.slice() : null;
  return {
    place: p ? { name: p.name || p.query || null, country_code: p.country_code || null, lat: Number.isFinite(p.lat) ? p.lat : null, lon: Number.isFinite(p.lon) ? p.lon : null, bbox } : null,
    bbox,
    refLat: Number.isFinite(p?.lat) ? p.lat : bbox ? (bbox[0] + bbox[2]) / 2 : 0,
    layers: { pop: [], jobs: [], students: [] },
    generators: [],
    od: [],
    observed: null,
    quality: { population: "none", jobs: "none", schools: "none", od: "none", observed: "none" },
    sources: new Map(),
    warnings: [],
    partial: false,
  };
};

const fmt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");

/** The dossier's layers as a draft: residents, OSM places, their typical sizes. */
const draftFromTerritory = (territory) => {
  const draft = emptyDraft(territory);
  if (!territory || !territory.place) {
    draft.warnings.push("territory: no territory dossier — load the place first; the demand inputs are empty");
    return draft;
  }
  const used = { osm: [], wikidata: [], nominatim: [] };

  // Residents: the dossier's grid (known total over OSM residential land).
  const grid = territory.population_grid;
  if (grid && Array.isArray(grid.cells) && grid.cells.length) {
    for (const c of grid.cells) if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && c.pop > 0) draft.layers.pop.push({ lat: c.lat, lon: c.lon, v: c.pop, kind: "dossier" });
    used.osm.push("population");
    if (grid.estimated) {
      draft.quality.population = "default_density";
      draft.warnings.push(`population: estimated from a default density (${fmt(4000)} inhabitants per km² of residential land) — no count of the place's population was available; very uncertain`);
    } else {
      draft.quality.population = "osm_residential";
      const src = territory.population?.source;
      if (src === "wikidata") used.wikidata.push("population");
      else if (src === "osm") used.nominatim.push("population");
    }
    const placed = grid.cells.reduce((s, c) => s + (c.pop > 0 ? c.pop : 0), 0);
    if (grid.total > 0 && placed < grid.total * 0.98) draft.warnings.push(`population: the dossier kept its densest ${grid.cells.length} cells: ${fmt(grid.total - placed)} residents (${Math.round((100 * (grid.total - placed)) / grid.total)} %) are not placed`);
  } else {
    draft.warnings.push("population: the territory dossier has no population grid (no residential land in OpenStreetMap, or the source was unavailable)");
  }

  // Places: generators with typical sizes; jobs and students proxies.
  const items = Array.isArray(territory.pois?.items) ? territory.pois.items : [];
  let jobsN = 0;
  let studentsN = 0;
  for (const poi of items) {
    if (!Number.isFinite(poi.lat) || !Number.isFinite(poi.lon)) continue;
    const t = osmProxy(poi);
    if (t.jobs > 0) {
      draft.layers.jobs.push({ lat: poi.lat, lon: poi.lon, v: t.jobs, kind: "osm" });
      jobsN += 1;
    }
    if (t.students > 0) {
      draft.layers.students.push({ lat: poi.lat, lon: poi.lon, v: t.students, kind: poi.category === "school" ? "school" : "higher" });
      studentsN += 1;
    }
    draft.generators.push({ id: String(poi.id), name: poi.name || poi.category, category: poi.category, lat: poi.lat, lon: poi.lon, weight: t.jobs + t.students + t.visits, ...(t.jobs ? { jobs: t.jobs } : {}), ...(t.students ? { students: t.students } : {}), source: "osm", estimated: true });
  }
  if (jobsN) {
    draft.quality.jobs = "osm_proxy";
    used.osm.push("jobs");
    const unplaced = Math.max(0, (territory.pois?.categories?.work || 0) - items.filter((p) => p.category === "work").length);
    draft.warnings.push(`jobs: ${PROXY_NOTE.jobs}${unplaced ? `; ${unplaced} unnamed business areas are not placed` : ""}`);
  } else {
    draft.warnings.push("jobs: no data — no workplace in the territory dossier");
  }
  if (studentsN) {
    draft.quality.schools = "osm";
    used.osm.push("schools");
    draft.warnings.push(`students: ${PROXY_NOTE.students}`);
  } else {
    draft.warnings.push("students: no data — no school in the territory dossier");
  }
  if (draft.generators.length) {
    used.osm.push("generators");
    draft.warnings.push(`generators: ${PROXY_NOTE.weight}`);
  }
  for (const s of dossierSources(territory, used)) addSource(draft, s);
  if (territory.partial) {
    draft.warnings.push("territory: some public sources of the dossier failed — the layers built on them are partial");
    draft.partial = true; // cached briefly, like the dossier: the next request retries
  }
  return draft;
};

// ── Finalize: bin the layers, cap, total

const r1 = (x) => Math.round(x * 10) / 10;

const finalize = (draft) => {
  const grid = createGrid(draft.refLat, CELL_M);
  const cells = new Map();
  const outside = { pop: 0, jobs: 0, students: 0 };
  const inside = { pop: 0, jobs: 0, students: 0 };
  for (const layer of LAYERS) {
    for (const p of draft.layers[layer]) {
      if (!(p.v > 0) || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      if (draft.bbox && !inBbox(p.lat, p.lon, draft.bbox)) {
        outside[layer] += p.v;
        continue;
      }
      inside[layer] += p.v;
      const id = grid.idOf(p.lat, p.lon);
      let c = cells.get(id);
      if (!c) {
        const centre = grid.centreOf(p.lat, p.lon);
        c = { id, lat: centre.lat, lon: centre.lon, pop: 0, jobs: 0, students: 0, _communes: null };
        cells.set(id, c);
      }
      c[layer] += p.v;
      if (p.commune) {
        c._communes = c._communes || new Map();
        c._communes.set(p.commune, (c._communes.get(p.commune) || 0) + p.v * (layer === "pop" ? 2 : 1));
      }
    }
  }
  const warnings = [...draft.warnings];
  for (const layer of LAYERS) {
    const total = inside[layer] + outside[layer];
    if (total > 0 && outside[layer] / total > 0.01) warnings.push(`${layer === "pop" ? "population" : layer}: ${fmt(outside[layer])} (${Math.round((100 * outside[layer]) / total)} %) lie outside the territory's bounding box and are left out`);
  }
  let list = [...cells.values()].map((c) => {
    let commune;
    if (c._communes) commune = [...c._communes.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return { id: c.id, lat: c.lat, lon: c.lon, pop: r1(c.pop), jobs: r1(c.jobs), students: r1(c.students), ...(commune ? { commune } : {}) };
  });
  list = list.filter((c) => c.pop > 0 || c.jobs > 0 || c.students > 0);
  const mass = (c) => c.pop + c.jobs + c.students;
  list.sort((a, b) => mass(b) - mass(a) || (a.id < b.id ? -1 : 1));
  if (list.length > MAX_CELLS) {
    const all = list.reduce((s, c) => s + mass(c), 0);
    const kept = list.slice(0, MAX_CELLS);
    const lost = all - kept.reduce((s, c) => s + mass(c), 0);
    warnings.push(`cells: ${list.length} cells, the ${MAX_CELLS} densest kept (${all ? ((100 * lost) / all).toFixed(1) : 0} % of residents, jobs and students left out)`);
    list = kept;
  }
  const totals = { pop: Math.round(list.reduce((s, c) => s + c.pop, 0)), jobs: Math.round(list.reduce((s, c) => s + c.jobs, 0)), students: Math.round(list.reduce((s, c) => s + c.students, 0)) };

  const seen = new Set();
  const generators = draft.generators
    .filter((g) => g && Number.isFinite(g.lat) && Number.isFinite(g.lon) && !seen.has(g.id) && seen.add(g.id))
    .map((g) => ({ ...g, lat: round5(g.lat), lon: round5(g.lon), weight: Math.max(0, Math.round(g.weight || 0)) }))
    .sort((a, b) => b.weight - a.weight);
  if (generators.length > MAX_GENERATORS) warnings.push(`generators: ${generators.length} places, the ${MAX_GENERATORS} largest kept`);

  let od = draft.od.filter((f) => f && f.flow > 0);
  if (od.length > MAX_OD) {
    od = [...od].sort((a, b) => b.flow - a.flow);
    warnings.push(`od: ${od.length} flows, the ${MAX_OD} largest kept`);
    od = od.slice(0, MAX_OD);
  }
  return {
    cells: list,
    generators: generators.slice(0, MAX_GENERATORS),
    od,
    observed: draft.observed,
    totals,
    sources: [...draft.sources.values()],
    quality: { ...draft.quality },
    warnings: [...new Set(warnings)],
    grid: { cell_m: grid.cellM },
    place: draft.place,
    partial: Boolean(draft.partial),
    generatedAt: new Date().toISOString(),
  };
};

/** DemandInputs from the territory dossier alone (sync, no network). */
const demandInputsFromTerritory = (territory) => finalize(draftFromTerritory(territory));

// ── Providers and the public-data upgrade

/**
 * The providers, in stages run one after the other (a stage's providers side by side). A provider upgrades the
 * draft's layers in place and throws when its service is down; `providers` overrides them by id (a function
 * replaces run, false turns one off).
 */
const defaultProviders = () => require("./providers").PROVIDERS;

const resolveProviders = (overrides) => {
  const list = defaultProviders().map((p) => ({ ...p }));
  if (!overrides || typeof overrides !== "object") return list;
  const out = [];
  for (const p of list) {
    const o = overrides[p.id];
    if (o === false || o === null) continue;
    out.push(typeof o === "function" ? { ...p, run: o } : o && typeof o === "object" ? { ...p, ...o } : p);
  }
  return out;
};

const abortError = () => Object.assign(new Error("The demand inputs request was aborted."), { name: "AbortError", status: 499, code: "ABORTED" });
const isAbort = (err, signal) => Boolean(signal?.aborted) || (err?.name === "AbortError" && err?.code === "ABORTED");

const runProviders = async (draft, providers, ctx) => {
  const stages = [...new Set(providers.map((p) => p.stage || 0))].sort((a, b) => a - b);
  for (const stage of stages) {
    if (ctx.signal?.aborted) throw abortError();
    const batch = providers.filter((p) => (p.stage || 0) === stage && (!p.countries || p.countries.includes(ctx.countryCode)));
    await Promise.all(
      batch.map(async (p) => {
        try {
          await p.run(draft, ctx);
        } catch (err) {
          if (isAbort(err, ctx.signal)) throw abortError();
          draft.partial = true;
          const why = err?.name === "AbortError" || err?.name === "TimeoutError" ? "timeout" : String(err?.message || err).slice(0, 200);
          draft.warnings.push(`${p.label || p.id}: unavailable (${why}) — ${p.fallback || "the layer keeps its previous source"}`);
        }
      }),
    );
  }
};

// Bounded cache of upgraded drafts (the public-data part), per place.
const _cache = new Map(); // key → { at, ttl, draft }
const cacheGet = (key) => {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    _cache.delete(key);
    return null;
  }
  return hit.draft;
};
const cacheSet = (key, draft) => {
  _cache.delete(key);
  _cache.set(key, { at: Date.now(), ttl: draft.partial ? PARTIAL_CACHE_TTL_MS : CACHE_TTL_MS, draft });
  while (_cache.size > MAX_CACHE_ENTRIES) _cache.delete(_cache.keys().next().value);
};

const cloneDraft = (d) => ({
  ...d,
  place: d.place ? { ...d.place } : null,
  layers: { pop: d.layers.pop.slice(), jobs: d.layers.jobs.slice(), students: d.layers.students.slice() },
  generators: d.generators.slice(),
  od: d.od.slice(),
  observed: d.observed ? JSON.parse(JSON.stringify(d.observed)) : null,
  quality: { ...d.quality },
  sources: new Map([...d.sources.entries()].map(([k, v]) => [k, { ...v, used_for: [...(v.used_for || [])] }])),
  warnings: d.warnings.slice(),
});

const placeKeyOf = (territory) => {
  const p = territory.place || {};
  const q = String(p.query || p.display_name || p.name || "").trim().toLowerCase();
  return q || (isBbox(p.bbox) ? p.bbox.map((x) => x.toFixed(4)).join(",") : "?");
};

/**
 * The dossier's layers upgraded with the best public data available for its country. Throws 400 without a
 * territory, 499 when `signal` aborts; a provider failure is a warning, never an error.
 */
const buildDemandInputs = async ({ territory = null, countryCode = null, fetchImpl = null, providers = null, signal = null, force = false } = {}) => {
  if (signal?.aborted) throw abortError();
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  const dossier = territory && typeof territory === "object" ? territory : null;
  if (!dossier) throw Object.assign(new Error("A territory (dossier) is required."), { status: 400, code: "INVALID_INPUT" });
  const cc = String(countryCode || dossier.place?.country_code || "").toUpperCase() || null;
  const enabled = config.DEMAND_PROVIDERS_ENABLED !== false;
  const list = enabled ? resolveProviders(providers) : [];
  // The dossier's build time is in the key: a rebuilt dossier is read again.
  const key = `${placeKeyOf(dossier)}|${dossier.generatedAt || ""}|${cc || "-"}|${list.map((p) => p.id).join(",")}`;
  let base = force ? null : cacheGet(key);
  if (!base) {
    const draft = draftFromTerritory(dossier);
    if (!enabled) draft.warnings.push("official data: the public data providers are turned off on this server (DEMAND_PROVIDERS_ENABLED=false)");
    await runProviders(draft, list, { fetchImpl: doFetch, signal, countryCode: cc, territory: dossier });
    cacheSet(key, draft);
    base = draft;
  }
  const draft = cloneDraft(base);
  if (signal?.aborted) throw abortError();
  return finalize(draft);
};

module.exports = {
  buildDemandInputs,
  demandInputsFromTerritory,
  OSM_PROXY,
  _internals: { draftFromTerritory, finalize, emptyDraft, cloneDraft, addSource, osmProxy, runProviders, resolveProviders, fold, fmt, _cache, clearCache: () => _cache.clear(), MAX_CELLS, MAX_GENERATORS, MAX_OD, CACHE_TTL_MS, PARTIAL_CACHE_TTL_MS, MAX_CACHE_ENTRIES },
};
