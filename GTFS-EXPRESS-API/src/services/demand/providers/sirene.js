/**
 * sirene — jobs at the workplace from the SIRENE register of establishments,
 * through the API Recherche d'entreprises (recherche-entreprises.api.gouv.fr,
 * Licence Ouverte): the open establishments of the territory's communes,
 * placed at their geocoded address and sized by their OWN INSEE headcount
 * band (its midpoint).
 *
 * Why /search and not /near_point: /near_point ignores
 * tranche_effectif_salarie (identical totals with and without it) and ranks companies by their number of
 * establishments, so a page cap keeps chains' small branches and misses a
 * town's hospital or factory. /search honours the size filter together
 * with an establishment-commune filter (code_commune accepts a
 * comma-separated list). The size filter applies to the COMPANY, so
 * companies are read by band, largest first: an establishment of ≥ 50
 * employees belongs to a company of ≥ 50, hence when the page budget runs
 * out, every establishment above the last completed band is counted — the
 * warning says which.
 *
 * Kept: etat_administratif "A" (a closed establishment keeps its old
 * band), coordinates inside the box, a declared band (NN / 00 / none: no
 * headcount → skipped, counted in the warning). Companies under 10
 * employees are not read (about 1 job in 5 in France) and the API lists a
 * limited number of establishments per company: the layer under-counts,
 * but places the main employers right. Requests are sequential and
 * ≥ 150 ms apart (the API allows 7 per second).
 */

"use strict";

const config = require("../../../config");
const { getJson, createPacer } = require("./http");
const { inBbox } = require("../grid");
const { addSource, dropUse } = require("../sources");

// INSEE headcount bands → midpoint employees (01–03 are bands of the
// establishments of larger companies).
const BAND_MIDPOINT = { "01": 1.5, "02": 4, "03": 7.5, 11: 15, 12: 35, 21: 75, 22: 150, 31: 225, 32: 375, 41: 750, 42: 1500, 51: 3500, 52: 7500, 53: 12000 };
const BAND_LABEL = { "01": "1–2", "02": "3–5", "03": "6–9", 11: "10–19", 12: "20–49", 21: "50–99", 22: "100–199", 31: "200–249", 32: "250–499", 41: "500–999", 42: "1 000–1 999", 51: "2 000–4 999", 52: "5 000–9 999", 53: "10 000+" };
// Company size bands read, largest first, with the establishment size
// above which the band completes the count.
const GROUPS = [
  { bands: ["41", "42", "51", "52", "53"], min: 500 },
  { bands: ["21", "22", "31", "32"], min: 50 },
  { bands: ["12"], min: 20 },
  { bands: ["11"], min: 10 },
];
const PER_PAGE = 25;
const CODES_PER_QUERY = 25;
// Tunable in tests only: the page budget, the spacing of requests (the API
// allows 7 per second) and the time budget.
const SETTINGS = { maxPages: 40, minIntervalMs: 150, timeBudgetMs: 90000 };
const MATCHING_LIMIT = 100;
const MAX_GENERATORS = 80;
const GENERATOR_MIN_EMPLOYEES = 20;

const SOURCE = { id: "sirene", name: "SIRENE — établissements (INSEE), API Recherche d'entreprises", url: "https://recherche-entreprises.api.gouv.fr", license: "Licence Ouverte / Open Licence" };

const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};
const fmt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");

const searchUrl = (codes, bands, page) => {
  const u = new URL(`${String(config.RECHERCHE_ENTREPRISES_URL).replace(/\/$/, "")}/search`);
  u.searchParams.set("code_commune", codes.join(","));
  u.searchParams.set("tranche_effectif_salarie", bands.join(","));
  u.searchParams.set("etat_administratif", "A");
  u.searchParams.set("per_page", String(PER_PAGE));
  u.searchParams.set("page", String(page));
  u.searchParams.set("limite_matching_etablissements", String(MATCHING_LIMIT));
  return u.toString();
};

/** The establishments of one page of results → pushed into `acc`. */
const readPage = (data, bbox, acc) => {
  for (const r of Array.isArray(data?.results) ? data.results : []) {
    const company = String(r?.nom_complet || r?.nom_raison_sociale || "").trim();
    for (const m of Array.isArray(r?.matching_etablissements) ? r.matching_etablissements : []) {
      const siret = String(m?.siret || "");
      if (!siret || acc.seen.has(siret)) continue;
      acc.seen.add(siret);
      if (m.etat_administratif && m.etat_administratif !== "A") {
        acc.closed += 1;
        continue;
      }
      const band = String(m.tranche_effectif_salarie ?? "");
      const employees = BAND_MIDPOINT[band];
      if (!employees) {
        acc.unknown += 1;
        continue;
      }
      const lat = num(m.latitude);
      const lon = num(m.longitude);
      if (lat === null || lon === null) {
        acc.noGeo += 1;
        continue;
      }
      if (!inBbox(lat, lon, bbox)) continue;
      const brand = Array.isArray(m.liste_enseignes) && m.liste_enseignes[0] ? String(m.liste_enseignes[0]) : m.nom_commercial ? String(m.nom_commercial) : "";
      acc.items.push({ siret, name: (brand || company || siret).slice(0, 120), company: company.slice(0, 120), lat, lon, employees, band, commune: m.commune ? String(m.commune) : null, naf: m.activite_principale || null });
    }
  }
};

/**
 * The establishments of the communes `codes` inside `bbox`: { items,
 * pages, completedMin, truncated, closed, unknown, noGeo }.
 */
const collectEstablishments = async (codes, bbox, ctx) => {
  const pace = createPacer(SETTINGS.minIntervalMs, ctx.signal);
  const started = Date.now();
  const chunks = [];
  for (let i = 0; i < codes.length; i += CODES_PER_QUERY) chunks.push(codes.slice(i, i + CODES_PER_QUERY));
  const acc = { items: [], seen: new Set(), closed: 0, unknown: 0, noGeo: 0 };
  let pages = 0;
  let completedMin = null;
  let truncated = false;
  outer: for (const group of GROUPS) {
    for (const chunk of chunks) {
      for (let page = 1; ; page++) {
        if (pages >= SETTINGS.maxPages || Date.now() - started > SETTINGS.timeBudgetMs) {
          truncated = true;
          break outer;
        }
        const data = await getJson(ctx, searchUrl(chunk, group.bands, page), { pace, retries: 3 });
        pages += 1;
        readPage(data, bbox, acc);
        const results = Array.isArray(data?.results) ? data.results.length : 0;
        const totalPages = num(data?.total_pages);
        if (results < PER_PAGE || (totalPages !== null && page >= totalPages)) break;
      }
    }
    completedMin = group.min;
  }
  return { items: acc.items, pages, completedMin, truncated, closed: acc.closed, unknown: acc.unknown, noGeo: acc.noGeo };
};

const sireneProvider = {
  id: "sirene",
  label: "jobs (SIRENE, API Recherche d'entreprises)",
  stage: 1,
  countries: ["FR"],
  fallback: "jobs keep the OpenStreetMap proxy",
  run: async (draft, ctx) => {
    const codes = (ctx.communes || []).filter((c) => !(c.share === 0)).map((c) => c.code);
    if (!codes.length) throw new Error("needs the official commune list");
    const r = await collectEstablishments(codes, draft.bbox, ctx);
    if (!r.items.length) {
      draft.warnings.push("jobs: SIRENE lists no open establishment with a declared headcount in the box — jobs keep the OpenStreetMap proxy");
      return;
    }
    const total = r.items.reduce((a, e) => a + e.employees, 0);
    const top = [...r.items].sort((a, b) => b.employees - a.employees).filter((e) => e.employees >= GENERATOR_MIN_EMPLOYEES).slice(0, MAX_GENERATORS);
    // Commit (synchronous): the SIRENE jobs replace the proxy; OSM places keep
    // their typical weight but no longer claim jobs.
    draft.layers.jobs = r.items.map((e) => ({ lat: e.lat, lon: e.lon, v: e.employees, ...(e.commune ? { commune: e.commune } : {}), kind: "sirene" }));
    draft.generators = draft.generators.map((g) => {
      if (g.source !== "osm" || g.jobs === undefined) return g;
      const rest = { ...g };
      delete rest.jobs;
      return rest;
    });
    draft.generators.push(...top.map((e) => ({ id: `siret:${e.siret}`, name: e.name, category: "work", lat: e.lat, lon: e.lon, weight: e.employees, jobs: e.employees, source: "sirene", band: e.band, band_label: BAND_LABEL[e.band], ...(e.company && e.company !== e.name ? { company: e.company } : {}) })));
    draft.quality.jobs = "sirene";
    draft.warnings.push(`jobs: SIRENE (API Recherche d'entreprises): ${r.items.length} open establishments of companies with 10+ employees, ${fmt(total)} jobs from the midpoints of their INSEE headcount bands; companies under 10 employees are not counted (about 1 job in 5) and multi-site employers may be partly listed`);
    if (r.unknown) draft.warnings.push(`jobs: ${r.unknown} open establishments without a declared headcount were skipped`);
    if (r.truncated) draft.warnings.push(r.completedMin ? `jobs: stopped after ${r.pages} pages of results — every establishment of ${r.completedMin}+ employees is counted, smaller ones only in part` : `jobs: stopped after ${r.pages} pages of results — only part of the largest companies was read`);
    dropUse(draft, ["osm", "overpass"], "jobs");
    addSource(draft, { ...SOURCE, used_for: ["jobs", "generators"] });
  },
};

module.exports = { sireneProvider, collectEstablishments, BAND_MIDPOINT, SOURCE, _internals: { GROUPS, SETTINGS, PER_PAGE, searchUrl, readPage } };
