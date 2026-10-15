/**
 * communes — the official communes covering the territory, from the French
 * government's geography API (geo.api.gouv.fr, Licence Ouverte): INSEE
 * code, name, legal population (latest census), area, centre, département,
 * EPCI and contour. Every French provider after it works on this list
 * (ctx.communes); on its own it changes no layer.
 *
 * The API answers "which commune is at this point", not "which communes are
 * in this box", so the box is covered in four steps:
 *   1. the communes at nine points of the box (centre, corners, mid-edges)
 *      give its départements;
 *   2. each département's list (light: no contours) gives the communes whose
 *      centre lies in the box grown by 3 km;
 *   3. their contours are fetched, nearest first, at most MAX_COMMUNES; the
 *      communes whose contour meets the box are kept, with the share of
 *      their area inside it;
 *   4. residents of the dossier that fall in no contour are looked up at
 *      their place (at most MAX_GAP_LOOKUPS), so a large commune whose centre
 *      lies outside the grown box is not missed.
 */

"use strict";

const config = require("../../../config");
const { getJson, createPacer, mapLimit } = require("./http");
const { isBbox, inBbox, expandBbox, bboxIntersects, geometryBbox, pointInGeometry, shareInBbox } = require("../grid");

const LIGHT_FIELDS = "nom,code,population,surface,centre,codeDepartement,codeEpci";
const FULL_FIELDS = `${LIGHT_FIELDS},contour`;
const MAX_COMMUNES = 150;
const MAX_DEPARTEMENTS = 6;
const MAX_GAP_LOOKUPS = 12;
const GROW_M = 3000;
const MIN_INTERVAL_MS = 25; // the API allows 50 requests / s per IP

const SOURCE = { id: "geo_api", name: "Découpage administratif — INSEE populations légales, IGN contours (geo.api.gouv.fr)", url: "https://geo.api.gouv.fr", license: "Licence Ouverte / Open Licence" };

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : Number.isFinite(parseFloat(v)) ? parseFloat(v) : null);

/** A geo.api commune record → our commune (contour optional). */
const toCommune = (r) => {
  if (!r || typeof r !== "object" || !r.code) return null;
  const c = Array.isArray(r.centre?.coordinates) ? r.centre.coordinates : null;
  const contour = r.contour && (r.contour.type === "Polygon" || r.contour.type === "MultiPolygon") ? r.contour : null;
  return {
    code: String(r.code),
    name: String(r.nom || r.code),
    population: num(r.population),
    surface_km2: num(r.surface) !== null ? num(r.surface) / 100 : null, // the API gives hectares
    lat: c ? num(c[1]) : null,
    lon: c ? num(c[0]) : null,
    departement: r.codeDepartement ? String(r.codeDepartement) : null,
    epci: r.codeEpci ? String(r.codeEpci) : null,
    contour,
    cbbox: contour ? geometryBbox(contour) : null,
  };
};

const url = (path, params) => {
  const u = new URL(`${String(config.GEO_API_URL).replace(/\/$/, "")}${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

/** The nine sampling points of a box (corners and edges inset by 2 %). */
const samplePoints = (b) => {
  const dy = (b[2] - b[0]) * 0.02;
  const dx = (b[3] - b[1]) * 0.02;
  const ys = [b[0] + dy, (b[0] + b[2]) / 2, b[2] - dy];
  const xs = [b[1] + dx, (b[1] + b[3]) / 2, b[3] - dx];
  const pts = [];
  for (const y of ys) for (const x of xs) pts.push({ lat: y, lon: x });
  // Centre first: it is the commune the territory is named after.
  return [pts[4], ...pts.slice(0, 4), ...pts.slice(5)];
};

/**
 * The communes of a box: [{ code, name, population, surface_km2, lat, lon,
 * departement, epci, contour, cbbox, share }] and notes. Throws when the API
 * is down or no French commune lies at the box.
 */
const findCommunes = async (bbox, ctx, { probePoints = [] } = {}) => {
  if (!isBbox(bbox)) throw new Error("the territory has no bounding box");
  const pace = createPacer(MIN_INTERVAL_MS, ctx.signal);
  const notes = [];
  const at = async (p, fields) => {
    const rows = await getJson(ctx, url("/communes", { lat: p.lat.toFixed(6), lon: p.lon.toFixed(6), fields, format: "json", geometry: "contour" }), { pace });
    return Array.isArray(rows) && rows[0] ? toCommune(rows[0]) : null;
  };

  // 1. Communes at the sampling points → départements.
  const sampled = (await mapLimit(samplePoints(bbox), 4, (p) => at(p, LIGHT_FIELDS))).filter(Boolean);
  if (!sampled.length) throw new Error("no French commune at the territory (sea, or outside France)");
  const deps = [...new Set(sampled.map((c) => c.departement).filter(Boolean))].slice(0, MAX_DEPARTEMENTS);

  // 2. Département lists → communes whose centre is in the grown box.
  const grown = expandBbox(bbox, GROW_M);
  const candidates = new Map(sampled.map((c) => [c.code, c]));
  const lists = await mapLimit(deps, 3, (dep) => getJson(ctx, url(`/departements/${encodeURIComponent(dep)}/communes`, { fields: LIGHT_FIELDS, format: "json" }), { pace, timeoutMs: 30000 }));
  for (const rows of lists) {
    for (const r of Array.isArray(rows) ? rows : []) {
      const c = toCommune(r);
      if (c && Number.isFinite(c.lat) && Number.isFinite(c.lon) && inBbox(c.lat, c.lon, grown) && !candidates.has(c.code)) candidates.set(c.code, c);
    }
  }

  // 3. Contours, nearest first.
  const cLat = (bbox[0] + bbox[2]) / 2;
  const cLon = (bbox[1] + bbox[3]) / 2;
  const dist = (c) => (!Number.isFinite(c.lat) ? Infinity : (c.lat - cLat) ** 2 + ((c.lon - cLon) * Math.cos((cLat * Math.PI) / 180)) ** 2);
  let list = [...candidates.values()].sort((a, b) => dist(a) - dist(b));
  if (list.length > MAX_COMMUNES) {
    notes.push(`communes: ${list.length} communes around the territory, the ${MAX_COMMUNES} nearest kept`);
    list = list.slice(0, MAX_COMMUNES);
  }
  const full = await mapLimit(list, 6, async (c) => {
    const r = await getJson(ctx, url(`/communes/${encodeURIComponent(c.code)}`, { fields: FULL_FIELDS, format: "json", geometry: "contour" }), { pace, notFound: null });
    return toCommune(r) || c;
  });
  const found = new Map();
  const keep = (c) => {
    if (!c || found.has(c.code)) return;
    if (c.contour) {
      if (!bboxIntersects(c.cbbox, bbox)) return;
      const share = shareInBbox(c.contour, bbox);
      if (!(share > 0)) return;
      found.set(c.code, { ...c, share: Math.min(1, share) });
    } else if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && inBbox(c.lat, c.lon, bbox)) {
      found.set(c.code, { ...c, share: null }); // no contour: counted whole, not placeable
    }
  };
  full.forEach(keep);

  // 4. Residents in no contour: look their commune up.
  const inAny = (p) => [...found.values()].some((c) => c.contour && pointInGeometry(p.lat, p.lon, c.contour, c.cbbox));
  let lookups = 0;
  for (const p of probePoints) {
    if (lookups >= MAX_GAP_LOOKUPS) break;
    if (!inBbox(p.lat, p.lon, bbox) || inAny(p)) continue;
    lookups += 1;
    keep(await at(p, FULL_FIELDS));
  }
  const communes = [...found.values()].sort((a, b) => (a.code < b.code ? -1 : 1));
  if (!communes.length) throw new Error("no official commune contour meets the territory's box");
  if (communes.some((c) => !c.contour)) notes.push(`communes: ${communes.filter((c) => !c.contour).length} communes came without a contour`);
  return { communes, departements: [...new Set(communes.map((c) => c.departement).filter(Boolean))], notes };
};

/** Stage 0: the commune list for the other French providers. */
const communesProvider = {
  id: "communes",
  label: "official communes (geo.api.gouv.fr)",
  stage: 0,
  countries: ["FR"],
  fallback: "population, jobs, schools and commuting flows keep the dossier's estimates",
  run: async (draft, ctx) => {
    const probe = [...draft.layers.pop].sort((a, b) => b.v - a.v);
    const r = await findCommunes(draft.bbox, ctx, { probePoints: probe });
    ctx.communes = r.communes;
    ctx.departements = r.departements;
    draft.warnings.push(...r.notes);
  },
};

module.exports = { communesProvider, findCommunes, SOURCE, _internals: { toCommune, samplePoints, MAX_COMMUNES, MAX_GAP_LOOKUPS } };
