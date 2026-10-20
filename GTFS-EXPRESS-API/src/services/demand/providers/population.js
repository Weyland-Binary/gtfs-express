/**
 * population — official resident counts on the working grid (France), from
 * the best of:
 *   • the INSEE 200 m grid (inseeGrid.js) when INSEE_GRID_DIR holds the file
 *     of every département of the box → quality "official_grid";
 *   • otherwise each commune's legal population (INSEE, through
 *     geo.api.gouv.fr) spread over the dossier's residential cells inside
 *     the commune → "official_commune_scaled". A commune crossing the edge
 *     of the box counts the share of its population matching the share of
 *     its area inside it; a commune with no residential cell in the dossier
 *     gets a uniform spread over its area in the box (flagged). Residents
 *     of the dossier in no commune found keep their estimate.
 */

"use strict";

const config = require("../../../config");
const { CELL_M, inBbox, latticeIn, pointInGeometry } = require("../grid");
const { addSource, dropUse } = require("../sources");
const { SOURCE: GEO_SOURCE } = require("./communes");
const inseeGrid = require("./inseeGrid");

const fmt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");
const names = (list, max = 6) => `${list.slice(0, max).join(", ")}${list.length > max ? ` and ${list.length - max} more` : ""}`;

/** The commune (with a contour) a point lies in, or null. */
const ownerOf = (communes) => (lat, lon) => communes.find((c) => c.contour && pointInGeometry(lat, lon, c.contour, c.cbbox)) || null;

/**
 * Residents rescaled on the communes: { points, scaled, synthesized, noPop,
 * edge, orphanPop }. `points` are the dossier's; the result replaces them.
 */
const rescaleOnCommunes = (points, communes, bbox, { cellM = CELL_M } = {}) => {
  const placeable = communes.filter((c) => c.contour);
  const owner = ownerOf(placeable);
  const byCommune = new Map();
  const orphans = [];
  for (const p of points) {
    if (bbox && !inBbox(p.lat, p.lon, bbox)) continue; // outside the territory
    const c = owner(p.lat, p.lon);
    if (!c) orphans.push(p);
    else {
      if (!byCommune.has(c.code)) byCommune.set(c.code, []);
      byCommune.get(c.code).push(p);
    }
  }
  const out = [];
  const scaled = [];
  const synthesized = [];
  const noPop = [];
  const edge = [];
  for (const c of placeable) {
    const pts = byCommune.get(c.code) || [];
    if (!(c.population > 0)) {
      for (const p of pts) out.push({ ...p, commune: c.code });
      noPop.push(c.name);
      continue;
    }
    const share = Number.isFinite(c.share) ? c.share : 1;
    if (share < 0.995) edge.push(c.name);
    const target = c.population * share;
    if (!(target > 0)) continue;
    const s = pts.reduce((a, p) => a + p.v, 0);
    if (s > 0) {
      const k = target / s;
      for (const p of pts) out.push({ lat: p.lat, lon: p.lon, v: p.v * k, commune: c.code, kind: "official" });
      scaled.push(c.name);
      continue;
    }
    const lattice = latticeIn(c.contour, { stepM: cellM, clip: bbox, max: 2000 });
    if (lattice.length) {
      const each = target / lattice.length;
      for (const q of lattice) out.push({ lat: q.lat, lon: q.lon, v: each, commune: c.code, kind: "synthetic" });
    } else if (Number.isFinite(c.lat) && Number.isFinite(c.lon) && (!bbox || inBbox(c.lat, c.lon, bbox))) {
      out.push({ lat: c.lat, lon: c.lon, v: target, commune: c.code, kind: "synthetic" });
    } else continue;
    synthesized.push(c.name);
  }
  out.push(...orphans);
  return { points: out, scaled, synthesized, noPop, edge, orphanPop: orphans.reduce((a, p) => a + p.v, 0) };
};

/** Tag grid points with their commune when the file did not. */
const tagCommunes = (points, communes) => {
  const owner = ownerOf(communes);
  return points.map((p) => {
    if (p.commune) return p;
    const c = owner(p.lat, p.lon);
    return c ? { ...p, commune: c.code } : p;
  });
};

const populationProvider = {
  id: "population",
  label: "official population",
  stage: 1,
  countries: ["FR"],
  fallback: "residents keep the dossier's estimate",
  run: async (draft, ctx) => {
    const communes = ctx.communes;
    if (!Array.isArray(communes) || !communes.length) throw new Error("needs the official commune list");
    const warnings = [];
    const dir = config.INSEE_GRID_DIR;
    if (dir) {
      const deps = ctx.departements?.length ? ctx.departements : [...new Set(communes.map((c) => c.departement).filter(Boolean))];
      let g = null;
      try {
        g = await inseeGrid.readGridCells({ dir, departements: deps, bbox: draft.bbox, signal: ctx.signal });
      } catch (err) {
        if (err.code === "ABORTED") throw err;
        warnings.push(`population: the INSEE 200 m grid could not be read (${err.message}) — commune populations used instead`);
      }
      if (g && g.missing.length) warnings.push(`population: no INSEE 200 m grid file for département ${g.missing.join(", ")} in INSEE_GRID_DIR — commune populations used instead`);
      else if (g && !g.points.length) warnings.push("population: the INSEE 200 m grid has no populated cell in the territory's box — commune populations used instead");
      else if (g) {
        const points = tagCommunes(g.points, communes);
        const total = points.reduce((a, p) => a + p.v, 0);
        const official = communes.reduce((a, c) => a + (c.population > 0 ? c.population * (Number.isFinite(c.share) ? c.share : 1) : 0), 0);
        draft.layers.pop = points;
        draft.quality.population = "official_grid";
        draft.warnings.push(...warnings, `population: INSEE 200 m grid (Filosofi, tax data) — ${fmt(total)} residents in ${points.length} cells`);
        if (official > 0 && Math.abs(total / official - 1) > 0.2) draft.warnings.push(`population: the grid counts ${fmt(total)} residents where the census gives about ${fmt(official)} for the communes of the box — check that the grid files match the territory`);
        // The grid replaces both the total and the distribution of the dossier.
        dropUse(draft, ["osm", "overpass", "wikidata", "nominatim"], "population");
        addSource(draft, { ...inseeGrid.SOURCE, used_for: ["population"] });
        return;
      }
    }
    const r = rescaleOnCommunes(draft.layers.pop, communes, draft.bbox);
    if (!r.scaled.length && !r.synthesized.length) throw new Error("no commune of the box has an official population");
    draft.layers.pop = r.points;
    draft.quality.population = "official_commune_scaled";
    draft.warnings.push(...warnings, `population: official population of ${r.scaled.length + r.synthesized.length} communes (INSEE legal populations) spread over the dossier's residential land`);
    if (r.synthesized.length) draft.warnings.push(`population: ${r.synthesized.length} commune(s) without residential land in OpenStreetMap got a uniform spread over their area (${names(r.synthesized)}) — less precise`);
    if (r.edge.length) draft.warnings.push(`population: ${r.edge.length} commune(s) cross the edge of the territory's box (${names(r.edge)}): only the share of their population matching their area inside it is counted`);
    if (r.noPop.length) draft.warnings.push(`population: no official population for ${names(r.noPop)} — the dossier's estimate is kept there`);
    if (r.orphanPop > 0) draft.warnings.push(`population: ${fmt(r.orphanPop)} residents of the dossier lie in no commune found and keep their estimate`);
    // Official totals replace the dossier's; OSM residential land still spreads them.
    dropUse(draft, ["wikidata", "nominatim"], "population");
    addSource(draft, { ...GEO_SOURCE, used_for: ["population"] });
  },
};

module.exports = { populationProvider, rescaleOnCommunes, tagCommunes };
