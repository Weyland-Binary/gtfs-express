/**
 * Schools and their pupils (France), from the Éducation nationale open data:
 * the directory for the open schools of the box, the headcount datasets for
 * each UAI's latest enrolment (a lycée in both GT and pro is summed), the
 * national average of its level when a school is missing (flagged estimated).
 * Higher education is in none of these datasets and stays an OSM place. A
 * `select` a dataset refuses (HTTP 400) is retried without it.
 */

"use strict";

const config = require("../../../config");
const { getJson, createPacer } = require("./http");
const { inBbox, bboxCircle } = require("../grid");
const { addSource, dropUse } = require("../sources");

const DIRECTORY = "fr-en-annuaire-education";
const DIRECTORY_FIELDS = ["identifiant_de_l_etablissement", "nom_etablissement", "type_etablissement", "libelle_nature", "latitude", "longitude", "code_commune", "nom_commune", "etat", "statut_public_prive", "ecole_maternelle", "ecole_elementaire"];
const HEADCOUNTS = [
  { id: "fr-en-ecoles-effectifs-nb_classes", commune: "code_commune_insee", uai: "numero_ecole", count: "nombre_total_eleves", levels: ["preschool", "primary"] },
  { id: "fr-en-college-effectifs-niveau-sexe-lv", commune: "code_commune", uai: "numero_college", count: "nombre_eleves_total", levels: ["lower_secondary"] },
  { id: "fr-en-lycee_gt-effectifs-niveau-sexe-lv", commune: "code_commune", uai: "numero_lycee", count: "nombre_d_eleves", levels: ["upper_secondary"] },
  { id: "fr-en-lycee_pro-effectifs-niveau-sexe-lv", commune: "code_commune", uai: "numero_lycee", count: "nombre_d_eleves", levels: ["upper_secondary"] },
];
// National averages per establishment (Éducation nationale, recent years).
const DEFAULT_ENROLMENT = { preschool: 95, primary: 140, lower_secondary: 530, upper_secondary: 750, other: 100 };
const PAGE = 100;
const MAX_HEADCOUNT_PAGES = 20;
const COMMUNES_PER_QUERY = 25;
const MAX_RADIUS_KM = 50;
// Tunable in tests only: the directory page budget, the spacing of requests.
const SETTINGS = { maxDirectoryPages: 40, minIntervalMs: 60 };

const SOURCES = {
  directory: { id: "education_annuaire", name: "Annuaire de l'éducation (ministère de l'Éducation nationale)", url: "https://data.education.gouv.fr/explore/dataset/fr-en-annuaire-education/", license: "Licence Ouverte / Open Licence" },
  headcounts: { id: "education_effectifs", name: "Effectifs d'élèves par école, collège et lycée (ministère de l'Éducation nationale)", url: "https://data.education.gouv.fr", license: "Licence Ouverte / Open Licence" },
};

const fold = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const fmt = (n) => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");
const quote = (s) => `"${String(s).replace(/["\\]/g, "")}"`;

const recordsUrl = (dataset, params) => {
  const u = new URL(`${String(config.EDUCATION_API_URL).replace(/\/$/, "")}/catalog/datasets/${dataset}/records`);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) u.searchParams.set(k, String(v));
  return u.toString();
};

/** GET records, retrying once without `select` when the dataset refuses it. */
const records = async (ctx, dataset, params, pace) => {
  try {
    return await getJson(ctx, recordsUrl(dataset, params), { pace });
  } catch (err) {
    if (err.status !== 400 || !params.select) throw err;
    return getJson(ctx, recordsUrl(dataset, { ...params, select: null }), { pace });
  }
};

const toSchool = (r) => {
  if (!r || typeof r !== "object") return null;
  const etat = fold(r.etat);
  if (etat && etat !== "ouvert") return null;
  const type = fold(r.type_etablissement);
  const nature = fold(r.libelle_nature);
  let level;
  if (type.startsWith("ecole")) level = (Number(r.ecole_maternelle) === 1 && Number(r.ecole_elementaire) !== 1) || /maternelle/.test(nature) ? "preschool" : "primary";
  else if (type.startsWith("college")) level = "lower_secondary";
  else if (type.startsWith("lycee")) level = "upper_secondary";
  else if (type === "erea") level = "other";
  else return null;
  const lat = num(r.latitude ?? r.position?.lat);
  const lon = num(r.longitude ?? r.position?.lon);
  const uai = String(r.identifiant_de_l_etablissement || "").trim().toUpperCase();
  if (lat === null || lon === null || !uai) return null;
  return { uai, name: String(r.nom_etablissement || uai).slice(0, 120), level, lat, lon, commune: r.code_commune ? String(r.code_commune) : null, sector: r.statut_public_prive || null, enrolment: num(r.nombre_d_eleves) };
};

const fetchSchools = async (bbox, ctx, pace) => {
  const c = bboxCircle(bbox);
  const radius = Math.min(MAX_RADIUS_KM, Math.ceil(c.radiusKm * 10) / 10 + 0.1);
  const where = `within_distance(position, geom'POINT(${c.lon.toFixed(6)} ${c.lat.toFixed(6)})', ${radius}km)`;
  const out = new Map();
  let total = null;
  let truncated = false;
  for (let page = 0; ; page++) {
    if (page >= SETTINGS.maxDirectoryPages) {
      truncated = true;
      break;
    }
    const data = await records(ctx, DIRECTORY, { where, limit: PAGE, offset: page * PAGE, select: DIRECTORY_FIELDS.join(",") }, pace);
    const rows = Array.isArray(data?.results) ? data.results : [];
    if (total === null) total = num(data?.total_count);
    for (const r of rows) {
      const s = toSchool(r);
      if (s && inBbox(s.lat, s.lon, bbox) && !out.has(s.uai)) out.set(s.uai, s);
    }
    if (rows.length < PAGE || (total !== null && (page + 1) * PAGE >= total)) break;
  }
  return { schools: [...out.values()], total, truncated };
};

// Records come newest school year first; reading stops once two school years have been seen.
const fetchHeadcounts = async (ds, communes, ctx, pace) => {
  const byUai = new Map(); // uai → { year, count }
  let latest = null;
  for (let i = 0; i < communes.length; i += COMMUNES_PER_QUERY) {
    const chunk = communes.slice(i, i + COMMUNES_PER_QUERY);
    const where = chunk.map((c) => `${ds.commune}=${quote(c)}`).join(" OR ");
    for (let page = 0; page < MAX_HEADCOUNT_PAGES; page++) {
      const data = await records(ctx, ds.id, { where, order_by: "rentree_scolaire DESC", limit: PAGE, offset: page * PAGE, select: `${ds.uai},${ds.count},rentree_scolaire` }, pace);
      const rows = Array.isArray(data?.results) ? data.results : [];
      let older = false;
      for (const r of rows) {
        const year = parseInt(String(r?.rentree_scolaire ?? "").slice(0, 4), 10);
        const uai = String(r?.[ds.uai] || "").trim().toUpperCase();
        const count = num(r?.[ds.count]);
        if (!uai || count === null || !Number.isFinite(year)) continue;
        if (latest === null || year > latest) latest = year;
        if (year < latest - 1) {
          older = true;
          continue;
        }
        const prev = byUai.get(uai);
        if (!prev || year > prev.year) byUai.set(uai, { year, count });
      }
      if (older || rows.length < PAGE) break;
    }
  }
  return byUai;
};

const educationProvider = {
  id: "education",
  label: "schools (Éducation nationale open data)",
  stage: 1,
  countries: ["FR"],
  fallback: "students keep the OpenStreetMap typical sizes",
  run: async (draft, ctx) => {
    if (!draft.bbox) throw new Error("the territory has no bounding box");
    const pace = createPacer(SETTINGS.minIntervalMs, ctx.signal);
    const { schools, truncated } = await fetchSchools(draft.bbox, ctx, pace);
    if (!schools.length) {
      draft.warnings.push("students: the national school directory lists no open school in the box — students keep the OpenStreetMap typical sizes");
      return;
    }
    // Headcounts fail soft: the directory alone is still better than OSM.
    const communes = [...new Set(schools.map((s) => s.commune).filter(Boolean))];
    const counts = new Map(); // uai → { year, count } summed across datasets of a level
    let headcountFailure = null;
    for (const ds of HEADCOUNTS) {
      if (!schools.some((s) => ds.levels.includes(s.level))) continue;
      try {
        const m = await fetchHeadcounts(ds, communes, ctx, pace);
        for (const [uai, v] of m) {
          const prev = counts.get(uai);
          if (!prev || v.year > prev.year) counts.set(uai, { ...v });
          else if (v.year === prev.year) prev.count += v.count; // a lycée in both GT and pro datasets
        }
      } catch (err) {
        if (err.code === "ABORTED") throw err;
        headcountFailure = err.message;
      }
    }
    let counted = 0;
    let estimated = 0;
    const years = new Set();
    const items = schools.map((s) => {
      const hc = counts.get(s.uai);
      if (hc && hc.count > 0) {
        counted += 1;
        years.add(hc.year);
        return { ...s, students: hc.count, estimated: false };
      }
      if (s.enrolment > 0) {
        counted += 1;
        return { ...s, students: s.enrolment, estimated: false };
      }
      estimated += 1;
      return { ...s, students: DEFAULT_ENROLMENT[s.level] || DEFAULT_ENROLMENT.other, estimated: true };
    });
    const total = items.reduce((a, s) => a + s.students, 0);
    // Synchronous from here: the official schools replace the OSM ones.
    draft.layers.students = [...draft.layers.students.filter((p) => p.kind !== "school"), ...items.map((s) => ({ lat: s.lat, lon: s.lon, v: s.students, ...(s.commune ? { commune: s.commune } : {}), kind: "school" }))];
    draft.generators = [...draft.generators.filter((g) => !(g.source === "osm" && g.category === "school")), ...items.map((s) => ({ id: `uai:${s.uai}`, name: s.name, category: "school", level: s.level, lat: s.lat, lon: s.lon, weight: s.students, students: s.students, source: "education", ...(s.estimated ? { estimated: true } : {}) }))];
    draft.quality.schools = "education_annuaire";
    const yearNote = years.size ? ` (school year ${Math.max(...years)}–${Math.max(...years) + 1})` : "";
    draft.warnings.push(`students: ${items.length} schools, collèges and lycées from the national school directory, ${fmt(total)} pupils; ${counted} enrolments from the official headcounts${yearNote}${estimated ? `, ${estimated} estimated from national averages by level (nursery 95, primary 140, collège 530, lycée 750)` : ""}`);
    if (headcountFailure) draft.warnings.push(`students: the official headcounts could not all be read (${headcountFailure}) — the schools concerned use national averages`);
    if (truncated) draft.warnings.push(`students: the school directory was read up to ${SETTINGS.maxDirectoryPages * PAGE} schools around the territory — some may be missing`);
    if (draft.layers.students.some((p) => p.kind === "higher")) draft.warnings.push("students: universities and higher education are not in the national school datasets: they keep their OpenStreetMap typical size");
    else dropUse(draft, ["osm", "overpass"], "schools");
    addSource(draft, { ...SOURCES.directory, used_for: ["schools", "generators"] });
    if (counted) addSource(draft, { ...SOURCES.headcounts, used_for: ["schools"] });
  },
};

module.exports = { educationProvider, fetchSchools, fetchHeadcounts, DEFAULT_ENROLMENT, SOURCES, _internals: { toSchool, HEADCOUNTS, DIRECTORY, recordsUrl, SETTINGS } };
