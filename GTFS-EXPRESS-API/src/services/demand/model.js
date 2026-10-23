/**
 * Daily origin–destination demand for all modes, from the demand inputs: the
 * first steps of the four-step model, kept explainable.
 *   1. Zones: the input cells and generators on a 500 m grid; above MAX_ZONES
 *      the smallest merge into their nearest neighbour.
 *   2. Generation: residents × a home-based trip rate per purpose (orders of
 *      magnitude from French household surveys, EMC²); attractions balanced to
 *      the productions of their purpose.
 *   3. Distribution: singly-constrained gravity, exp(−λ·d), λ by purpose and
 *      town size, calibrated on observed flows when the inputs carry them.
 * The largest pairs (≥ 95 % of trips, ≤ 40 000 pairs) are kept exactly, the
 * rest grouped by destination district, so no trip is left out. Every assumed
 * value is listed in `assumptions`, what the data lacks in `warnings`.
 */

"use strict";

const ZONE_M = 500;
const MAX_ZONES = 1500;
const MAX_PAIRS = 40000;
const COVER = 0.95;
const NOMINAL_ZONE_KM2 = (ZONE_M / 1000) ** 2;
// A generator's weight is the persons it attracts on a weekday: it adds to the
// residents as an attraction of "other" trips, person for person.
const PERSONS_PER_WEIGHT = 1;
const PURPOSES = ["work", "school", "other"];
// One-way home-based trips per resident per average weekday, all modes; the
// return trip is implied (the OD is read in both directions).
const TRIP_RATES = { work: 0.45, school: 0.25, other: 1.2 };
// λ (1/km) by town size: in an open plane the mean trip length is about 2/λ.
const TOWN_CLASSES = [
  { id: "small", max: 20000, label: "small town (< 20 000 inhabitants)", lambda: { work: 0.3, school: 0.8, other: 0.9 } },
  { id: "town", max: 100000, label: "town (20 000–100 000 inhabitants)", lambda: { work: 0.22, school: 0.7, other: 0.65 } },
  { id: "city", max: 500000, label: "city (100 000–500 000 inhabitants)", lambda: { work: 0.15, school: 0.5, other: 0.45 } },
  { id: "metropolis", max: Infinity, label: "metropolis (> 500 000 inhabitants)", lambda: { work: 0.1, school: 0.35, other: 0.3 } },
];
const COMMUNE_MAX_KM = 12; // a zone farther than this from every observed commune is left out
const CALIBRATION_MAX_ZONES = 600;
const LAMBDA_RANGE = [0.01, 3];

const round = (v, n = 0) => Math.round(v * 10 ** n) / 10 ** n;
const finite = (v) => Number.isFinite(v);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const townClassOf = (population) => TOWN_CLASSES.find((c) => (population || 0) < c.max) || TOWN_CLASSES[TOWN_CLASSES.length - 1];

// ── Zones ─────────────────────────────────────────────────────────────────

/** Equirectangular projection around a latitude: kilometres east/north. */
const projection = (lat0) => {
  const kx = (111320 * Math.cos((lat0 * Math.PI) / 180)) / 1000;
  const ky = 111320 / 1000;
  return { kx, ky, x: (lon) => lon * kx, y: (lat) => lat * ky };
};

const massOf = (z) => z.pop + z.jobs + z.students + (z.gen_weight ?? z.weight ?? 0) * PERSONS_PER_WEIGHT;

/** Zones with mass-weighted centroids; beyond `maxZones` the smallest merge into their nearest remaining zone. */
const buildZones = (inputs, { zoneM = ZONE_M, maxZones = MAX_ZONES } = {}) => {
  const cells = (inputs?.cells || []).filter((c) => c && finite(c.lat) && finite(c.lon) && (num(c.pop) > 0 || num(c.jobs) > 0 || num(c.students) > 0));
  const gens = (inputs?.generators || []).filter((g) => g && finite(g.lat) && finite(g.lon));
  const all = [...cells, ...gens];
  if (!all.length) return { zones: [], proj: null, merged: 0 };
  const lat0 = all.reduce((s, p) => s + p.lat, 0) / all.length;
  const proj = projection(lat0);
  const stepKm = zoneM / 1000;
  const byKey = new Map();
  const zoneAt = (lat, lon) => {
    const ix = Math.floor(proj.x(lon) / stepKm);
    const iy = Math.floor(proj.y(lat) / stepKm);
    const key = `${ix}_${iy}`;
    if (!byKey.has(key)) byKey.set(key, { id: `z${ix}_${iy}`, ix, iy, sx: 0, sy: 0, sm: 0, pop: 0, jobs: 0, students: 0, gen_weight: 0, gen_jobs: 0, gen_students: 0, school_weight: 0, cells: 1, top: null });
    return byKey.get(key);
  };
  const addMass = (z, lat, lon, m) => {
    const w = m > 0 ? m : 1e-6;
    z.sx += proj.x(lon) * w;
    z.sy += proj.y(lat) * w;
    z.sm += w;
  };
  for (const c of cells) {
    const z = zoneAt(c.lat, c.lon);
    z.pop += num(c.pop);
    z.jobs += num(c.jobs);
    z.students += num(c.students);
    addMass(z, c.lat, c.lon, num(c.pop) + num(c.jobs) + num(c.students));
  }
  for (const g of gens) {
    const z = zoneAt(g.lat, g.lon);
    const w = num(g.weight) > 0 ? num(g.weight) : 1;
    z.gen_weight += w;
    z.gen_jobs += num(g.jobs);
    z.gen_students += num(g.students);
    if (g.category === "school" || g.category === "college") z.school_weight += w;
    if (!z.top || w > z.top.weight) z.top = { name: g.name || g.category || null, weight: w };
    addMass(z, g.lat, g.lon, w * PERSONS_PER_WEIGHT);
  }
  let zones = [...byKey.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let merged = 0;
  if (zones.length > maxZones) {
    const order = [...zones].sort((a, b) => massOf(a) - massOf(b) || (a.id < b.id ? -1 : 1));
    const drop = new Set(order.slice(0, zones.length - maxZones));
    const keep = zones.filter((z) => !drop.has(z));
    for (const d of order.slice(0, zones.length - maxZones)) {
      const dx = d.sx / d.sm;
      const dy = d.sy / d.sm;
      let best = null;
      let bestD = Infinity;
      for (const k of keep) {
        const dd = (k.sx / k.sm - dx) ** 2 + (k.sy / k.sm - dy) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = k;
        }
      }
      for (const f of ["sx", "sy", "sm", "pop", "jobs", "students", "gen_weight", "gen_jobs", "gen_students", "school_weight", "cells"]) best[f] += d[f];
      if (d.top && (!best.top || d.top.weight > best.top.weight)) best.top = d.top;
      merged += 1;
    }
    zones = keep;
  }
  const out = zones.map((z) => {
    const x = z.sx / z.sm;
    const y = z.sy / z.sm;
    const area = NOMINAL_ZONE_KM2 * (zoneM / ZONE_M) ** 2 * z.cells;
    return { id: z.id, lat: y / proj.ky, lon: x / proj.kx, x, y, pop: z.pop, jobs: z.jobs, students: z.students, weight: z.gen_weight, gen_jobs: z.gen_jobs, gen_students: z.gen_students, school_weight: z.school_weight, area_km2: round(area, 3), density: round((z.pop + z.jobs) / area), name: z.top ? z.top.name : null };
  });
  return { zones: out, proj, merged };
};

// ── Generation ────────────────────────────────────────────────────────────

const generation = (zones, { tripRates = TRIP_RATES } = {}) => {
  const n = zones.length;
  const assumptions = [];
  const warnings = [];
  const P = {};
  const A = {};
  for (const p of PURPOSES) {
    P[p] = new Float64Array(n);
    A[p] = new Float64Array(n);
  }
  const sum = (f) => zones.reduce((s, z) => s + f(z), 0);
  const cellJobs = sum((z) => z.jobs);
  const genJobs = sum((z) => z.gen_jobs);
  const cellStudents = sum((z) => z.students);
  const genStudents = sum((z) => z.gen_students);
  const schoolWeights = sum((z) => z.school_weight);
  let workBasis = "jobs";
  if (!(cellJobs > 0)) {
    if (genJobs > 0) workBasis = "generator_jobs";
    else {
      workBasis = "proxy_population_generators";
      warnings.push("No jobs in the inputs: work trips are attracted like other trips (residents and trip generators). Load the jobs (or a local OD survey) for a sounder estimate.");
    }
  }
  let schoolBasis = "students";
  if (!(cellStudents > 0)) {
    if (genStudents > 0) schoolBasis = "generator_students";
    else if (schoolWeights > 0) {
      schoolBasis = "school_places";
      assumptions.push("School trips go to the schools and colleges of the territory in proportion to their weight (no enrolment figures).");
    } else {
      schoolBasis = "proxy_population";
      warnings.push("No schools nor students in the inputs: school trips are assumed to stay near home.");
    }
  }
  zones.forEach((z, i) => {
    P.work[i] = z.pop * tripRates.work;
    P.school[i] = z.pop * tripRates.school;
    P.other[i] = z.pop * tripRates.other;
    const generators = z.weight * PERSONS_PER_WEIGHT;
    A.work[i] = workBasis === "jobs" ? z.jobs : workBasis === "generator_jobs" ? z.gen_jobs : z.pop + generators;
    A.school[i] = schoolBasis === "students" ? z.students : schoolBasis === "generator_students" ? z.gen_students : schoolBasis === "school_places" ? z.school_weight * PERSONS_PER_WEIGHT : z.pop;
    A.other[i] = z.pop + generators;
  });
  // Balancing: each purpose's attractions scaled to its productions.
  const balance = {};
  const B = {};
  for (const p of PURPOSES) {
    const tp = P[p].reduce((s, v) => s + v, 0);
    const ta = A[p].reduce((s, v) => s + v, 0);
    const k = ta > 0 ? tp / ta : 0;
    B[p] = A[p].map((v) => v * k);
    balance[p] = { productions: tp, attractions: ta, balanced_attractions: B[p].reduce((s, v) => s + v, 0), factor: k };
  }
  assumptions.push(`Trip rates: ${PURPOSES.map((p) => `${p} ${tripRates[p]}`).join(", ")} home-based one-way trips per resident per weekday, all modes (orders of magnitude from French household surveys, EMC²); the return trips are counted too.`);
  assumptions.push("Other trips are attracted by the residents and by the trip generators' weekday visitors (their weight, in persons).");
  return { P, A, B, balance, bases: { work: workBasis, school: schoolBasis, other: "population_generators" }, assumptions, warnings };
};

// ── Distribution ──────────────────────────────────────────────────────────

const intraKm = (z) => 0.5 * Math.sqrt(z.area_km2 || NOMINAL_ZONE_KM2);
const distKm = (a, b) => (a === b ? intraKm(a) : Math.hypot(a.x - b.x, a.y - b.y));

/** Gravity flows of one origin for every purpose, written into the row buffers; returns the row total. */
const rowFlows = (i, zones, P, B, lambda, flows, scale = null) => {
  const n = zones.length;
  const zi = zones[i];
  let total = 0;
  for (const p of PURPOSES) {
    const row = flows[p];
    if (!(P[p][i] > 0)) {
      row.fill(0);
      continue;
    }
    const lam = lambda[p];
    const a = B[p];
    let den = 0;
    for (let j = 0; j < n; j++) {
      const v = a[j] > 0 ? a[j] * Math.exp(-lam * distKm(zi, zones[j])) : 0;
      row[j] = v;
      den += v;
    }
    const k = den > 0 ? P[p][i] / den : 0;
    const s = scale ? scale[p] : null;
    for (let j = 0; j < n; j++) {
      let v = row[j] * k;
      if (s && v > 0) v *= s(i, j);
      row[j] = v;
      total += v;
    }
  }
  return total;
};

/**
 * Districts: a coarser grid (the finest of DISTRICT_KM keeping n × districts
 * within MAX_RESIDUAL_PAIRS) whose largest zone stands for the others as a
 * destination of the small flows.
 */
const DISTRICT_KM = [1, 1.5, 2, 3, 5, 8, 12, 20, 40];
const MAX_RESIDUAL_PAIRS = 60000;
const districtsOf = (zones, n) => {
  const xs = zones.map((z) => z.x);
  const ys = zones.map((z) => z.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  let km = DISTRICT_KM[DISTRICT_KM.length - 1];
  for (const d of DISTRICT_KM) {
    const cells = Math.ceil((Math.max(...xs) - x0 + 1e-9) / d) * Math.ceil((Math.max(...ys) - y0 + 1e-9) / d);
    if (n * Math.min(cells, n) <= MAX_RESIDUAL_PAIRS) {
      km = d;
      break;
    }
  }
  const keyOf = (z) => `${Math.floor((z.x - x0) / km)}_${Math.floor((z.y - y0) / km)}`;
  const byKey = new Map();
  zones.forEach((z, i) => {
    const k = keyOf(z);
    const cur = byKey.get(k);
    if (cur == null || massOf(z) > massOf(zones[cur])) byKey.set(k, i);
  });
  const keys = [...byKey.keys()].sort();
  const index = new Map(keys.map((k, i) => [k, i]));
  return { km, reps: keys.map((k) => byKey.get(k)), of: zones.map((z) => index.get(keyOf(z))) };
};

// ── Calibration on observed flows ─────────────────────────────────────────

const endpointKey = (e) => (e && (e.code != null && String(e.code).trim() ? `code:${String(e.code).trim()}` : finite(Number(e?.lat)) && finite(Number(e?.lon)) ? `pt:${Number(e.lat).toFixed(3)},${Number(e.lon).toFixed(3)}` : null));

/**
 * λ of one purpose fitted on observed commune-to-commune flows (the mean
 * commune-level trip length), the fit of the model to them, and the
 * per-pair factors that rescale the zone flows to the observed ones.
 */
const calibrateOnOd = (zones, gen, lambda, observed, purpose, proj) => {
  const ends = new Map();
  const pairs = new Map();
  let ignored = 0;
  for (const f of observed) {
    const flow = Number(f.flow);
    const a = f.from;
    const b = f.to;
    const ka = endpointKey(a);
    const kb = endpointKey(b);
    const located = (e) => finite(Number(e?.lat)) && finite(Number(e?.lon));
    if (!(flow > 0)) continue;
    if (!ka || !kb) {
      ignored += 1;
      continue;
    }
    for (const [k, e] of [[ka, a], [kb, b]]) {
      if (ends.has(k)) continue;
      if (!located(e)) continue;
      ends.set(k, { key: k, name: e.name || e.code || null, x: proj.x(Number(e.lon)), y: proj.y(Number(e.lat)) });
    }
    if (!ends.has(ka) || !ends.has(kb)) {
      ignored += 1;
      continue;
    }
    pairs.set(`${ka}|${kb}`, (pairs.get(`${ka}|${kb}`) || 0) + flow);
  }
  if (!pairs.size) return { fit: null, ignored };
  const communes = [...ends.values()];
  const cIndex = new Map(communes.map((c, i) => [c.key, i]));
  const nc = communes.length;
  // Each zone belongs to its nearest observed commune (within COMMUNE_MAX_KM).
  const communeOf = zones.map((z) => {
    let best = -1;
    let bd = COMMUNE_MAX_KM;
    communes.forEach((c, i) => {
      const d = Math.hypot(z.x - c.x, z.y - c.y);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  });
  const cDist = (a, b) => (a === b ? 0 : Math.hypot(communes[a].x - communes[b].x, communes[a].y - communes[b].y));
  const obs = new Float64Array(nc * nc);
  let obsTotal = 0;
  let obsKm = 0;
  for (const [k, flow] of pairs) {
    const [ka, kb] = k.split("|");
    const a = cIndex.get(ka);
    const b = cIndex.get(kb);
    obs[a * nc + b] += flow;
    obsTotal += flow;
    obsKm += flow * cDist(a, b);
  }
  const obsMean = obsKm / obsTotal;
  // λ is searched on the largest zones only (bounded); the final flows use every zone.
  const idx = zones.map((z, i) => i).filter((i) => communeOf[i] >= 0);
  const sub = idx.length > CALIBRATION_MAX_ZONES ? [...idx].sort((a, b) => massOf(zones[b]) - massOf(zones[a]) || a - b).slice(0, CALIBRATION_MAX_ZONES).sort((a, b) => a - b) : idx;
  const everyZone = zones.map((z, i) => i);
  const P = gen.P[purpose];
  const B = gen.B[purpose];
  // Commune-to-commune flows of the model: origins in `from`, destinations in `to` (denominators over `to`).
  const modelCommunes = (lam, from = sub, to = sub) => {
    const m = new Float64Array(nc * nc);
    const row = new Float64Array(to.length);
    for (const i of from) {
      if (!(P[i] > 0)) continue;
      let den = 0;
      to.forEach((j, jj) => {
        const v = B[j] > 0 ? B[j] * Math.exp(-lam * distKm(zones[i], zones[j])) : 0;
        row[jj] = v;
        den += v;
      });
      if (!(den > 0)) continue;
      const k = P[i] / den;
      const a = communeOf[i];
      to.forEach((j, jj) => {
        if (row[jj] > 0 && communeOf[j] >= 0) m[a * nc + communeOf[j]] += row[jj] * k;
      });
    }
    return m;
  };
  const meanOf = (m) => {
    let t = 0;
    let km = 0;
    for (let a = 0; a < nc; a++) for (let b = 0; b < nc; b++) {
      const v = m[a * nc + b];
      t += v;
      km += v * cDist(a, b);
    }
    return t > 0 ? km / t : 0;
  };
  // The mean commune-level length falls as λ grows: bisection on log λ.
  let lo = Math.log(LAMBDA_RANGE[0]);
  let hi = Math.log(LAMBDA_RANGE[1]);
  let lam = lambda[purpose];
  const meanLo = meanOf(modelCommunes(Math.exp(lo)));
  const meanHi = meanOf(modelCommunes(Math.exp(hi)));
  let bounded = null;
  if (obsMean >= meanLo) {
    lam = Math.exp(lo);
    bounded = "lower";
  } else if (obsMean <= meanHi) {
    lam = Math.exp(hi);
    bounded = "upper";
  } else {
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (meanOf(modelCommunes(Math.exp(mid))) > obsMean) lo = mid;
      else hi = mid;
    }
    lam = Math.exp((lo + hi) / 2);
  }
  // The model as it will run: every origin of the observed area, denominators over every zone.
  const m = modelCommunes(lam, idx, everyZone);
  // Fit on the observed pairs, model scaled to the observed total.
  let modTotal = 0;
  for (let k = 0; k < nc * nc; k++) if (obs[k] > 0) modTotal += m[k];
  const s = modTotal > 0 ? obsTotal / modTotal : 0;
  const mean = obsTotal / pairs.size;
  let ssRes = 0;
  let ssTot = 0;
  for (let k = 0; k < nc * nc; k++) {
    if (!(obs[k] > 0)) continue;
    ssRes += (obs[k] - m[k] * s) ** 2;
    ssTot += (obs[k] - mean) ** 2;
  }
  // Rescale factors: the zone flows of an observed commune pair add up to the observation.
  const factors = new Float64Array(nc * nc).fill(1);
  let fmin = Infinity;
  let fmax = 0;
  for (let k = 0; k < nc * nc; k++) {
    if (!(obs[k] > 0) || !(m[k] > 0)) continue;
    factors[k] = obs[k] / m[k];
    fmin = Math.min(fmin, factors[k]);
    fmax = Math.max(fmax, factors[k]);
  }
  return {
    ignored,
    communeOf,
    nc,
    factors,
    lambda: lam,
    fit: {
      purpose,
      communes: nc,
      pairs: pairs.size,
      zones_used: sub.length,
      lambda_default: lambda[purpose],
      lambda: round(lam, 4),
      ...(bounded ? { lambda_at_bound: bounded } : {}),
      observed_total: round(obsTotal),
      model_total_on_pairs: round(modTotal),
      observed_mean_km: round(obsMean, 2),
      model_mean_km: round(meanOf(m), 2),
      r2: ssTot > 0 ? round(1 - ssRes / ssTot, 3) : null,
      rescale: { min: finite(fmin) ? round(fmin, 3) : null, max: fmax ? round(fmax, 3) : null },
    },
  };
};

// ── The model ─────────────────────────────────────────────────────────────

const buildDemandModel = (inputs, opts = {}) => {
  const tripRates = { ...TRIP_RATES, ...(opts.tripRates || {}) };
  const { zones, proj, merged } = buildZones(inputs, { maxZones: opts.maxZones || MAX_ZONES });
  const population = zones.reduce((s, z) => s + z.pop, 0) || num(inputs?.totals?.pop);
  const town = townClassOf(population);
  const lambda = { ...town.lambda, ...(opts.lambda || {}) };
  const warnings = [...(inputs?.warnings || []).map(String)];
  const assumptions = [];
  if (merged) assumptions.push(`${merged} small zone(s) merged into their neighbours to keep ${zones.length} zones.`);
  const empty = { zones, pairs: [], totals: { residents: 0, productions: {}, attractions: {}, balanced_attractions: {}, distributed: {}, trips_one_way: 0, trips_day: 0, pairs_total: 0, pairs_kept: 0, pairs_aggregated: 0, coverage: 0, district_km: null }, town: { population, class: town.id, label: town.label }, parameters: { trip_rates: tripRates, lambda, zone_m: ZONE_M }, calibration: { od: null }, assumptions, warnings };
  if (!zones.length || !(population > 0)) {
    warnings.push("No residents in the inputs: no demand can be estimated.");
    return empty;
  }
  const gen = generation(zones, { tripRates });
  assumptions.push(...gen.assumptions);
  warnings.push(...gen.warnings);
  assumptions.push(`Distribution: gravity model with exp(−λ·d), λ per km ${PURPOSES.map((p) => `${p} ${round(lambda[p], 3)}`).join(", ")} (${town.label}).`);

  const odByPurpose = {};
  for (const f of Array.isArray(inputs?.od) ? inputs.od : []) {
    const p = PURPOSES.includes(f?.purpose) ? f.purpose : "other";
    (odByPurpose[p] = odByPurpose[p] || []).push(f);
  }
  const calibration = {};
  const scale = {};
  for (const p of PURPOSES) {
    if (!odByPurpose[p]) continue;
    const c = calibrateOnOd(zones, gen, lambda, odByPurpose[p], p, proj);
    if (c.ignored) warnings.push(`${c.ignored} observed ${p} flow(s) without coordinates were ignored.`);
    if (!c.fit) continue;
    lambda[p] = c.lambda;
    calibration[p] = c.fit;
    const { communeOf, nc, factors } = c;
    scale[p] = (i, j) => (communeOf[i] >= 0 && communeOf[j] >= 0 ? factors[communeOf[i] * nc + communeOf[j]] : 1);
  }
  const calibrated = Object.keys(calibration).length > 0;
  if (calibrated) assumptions.push(`Observed flows (${Object.keys(calibration).join(", ")}) read as one-way home-based trips per weekday; λ fitted on them and the model rescaled to them commune by commune.`);

  // Pass 1: every pair, row by row — totals and a log histogram of the pair flows.
  const n = zones.length;
  const flows = { work: new Float64Array(n), school: new Float64Array(n), other: new Float64Array(n) };
  const scaler = calibrated ? scale : null;
  const BINS = 8 * 80;
  const binOf = (v) => Math.max(0, Math.min(BINS - 1, Math.floor((Math.log2(v) + 50) * 8)));
  const histSum = new Float64Array(BINS);
  const histCount = new Float64Array(BINS);
  const distributed = { work: 0, school: 0, other: 0 };
  let total = 0;
  for (let i = 0; i < n; i++) {
    rowFlows(i, zones, gen.P, gen.B, lambda, flows, scaler);
    for (let j = 0; j < n; j++) {
      const v = flows.work[j] + flows.school[j] + flows.other[j];
      distributed.work += flows.work[j];
      distributed.school += flows.school[j];
      distributed.other += flows.other[j];
      if (!(v > 0)) continue;
      total += v;
      const b = binOf(v);
      histSum[b] += v;
      histCount[b] += 1;
    }
  }
  // Threshold: the largest pairs covering COVER of the trips, at most MAX_PAIRS pairs.
  const maxPairs = opts.maxPairs || MAX_PAIRS;
  const cover = opts.cover || COVER;
  let acc = 0;
  let count = 0;
  let cut = BINS;
  for (let b = BINS - 1; b >= 0; b--) {
    if (count + histCount[b] > maxPairs && count > 0) break;
    acc += histSum[b];
    count += histCount[b];
    cut = b;
    if (acc >= cover * total) break;
  }
  // Pass 2: the kept pairs exactly; the smaller ones aggregated on the
  // destination's district (a coarser grid), so every trip stays in the
  // sample with an approximate length.
  const districts = districtsOf(zones, n);
  const exact = [];
  const residual = new Map(); // "o|rep" → pair
  const nd = districts.reps.length;
  const rw = { work: new Float64Array(nd), school: new Float64Array(nd), other: new Float64Array(nd) };
  for (let i = 0; i < n; i++) {
    rowFlows(i, zones, gen.P, gen.B, lambda, flows, scaler);
    for (const p of PURPOSES) rw[p].fill(0);
    for (let j = 0; j < n; j++) {
      const v = flows.work[j] + flows.school[j] + flows.other[j];
      if (!(v > 0)) continue;
      if (binOf(v) >= cut) exact.push({ o: i, d: j, km: round(distKm(zones[i], zones[j]), 3), work: flows.work[j], school: flows.school[j], other: flows.other[j], total: v });
      else {
        const k = districts.of[j];
        for (const p of PURPOSES) rw[p][k] += flows[p][j];
      }
    }
    for (let k = 0; k < nd; k++) {
      const v = rw.work[k] + rw.school[k] + rw.other[k];
      if (!(v > 0)) continue;
      const d = districts.reps[k];
      residual.set(`${i}|${d}`, { o: i, d, km: round(distKm(zones[i], zones[d]), 3), work: rw.work[k], school: rw.school[k], other: rw.other[k], total: v, aggregated: true });
    }
  }
  exact.sort((a, b) => b.total - a.total || a.o - b.o || a.d - b.d);
  // A histogram bin is coarse: never more than maxPairs exact pairs (the rest is aggregated too).
  if (exact.length > maxPairs) {
    for (const x of exact.splice(maxPairs)) {
      const k = districts.of[x.d];
      const d = districts.reps[k];
      const key = `${x.o}|${d}`;
      const r = residual.get(key) || { o: x.o, d, km: round(distKm(zones[x.o], zones[d]), 3), work: 0, school: 0, other: 0, total: 0, aggregated: true };
      for (const p of PURPOSES) r[p] += x[p];
      r.total += x.total;
      residual.set(key, r);
    }
  }
  const kept = exact.reduce((s, p) => s + p.total, 0);
  const coverage = total > 0 ? kept / total : 0;
  if (coverage < cover - 1e-9) warnings.push(`${exact.length} zone pairs carry ${round(coverage * 100, 1)} % of the trips; the smaller flows are grouped by destination district (${districts.km} km grid), with approximate lengths.`);
  const pairs = [...exact, ...[...residual.values()].sort((a, b) => b.total - a.total || a.o - b.o || a.d - b.d)];
  const residents = zones.reduce((s, z) => s + z.pop, 0);
  const productions = Object.fromEntries(PURPOSES.map((p) => [p, gen.balance[p].productions]));
  return {
    zones,
    pairs,
    totals: {
      residents: round(residents),
      productions,
      attractions: Object.fromEntries(PURPOSES.map((p) => [p, gen.balance[p].attractions])),
      balanced_attractions: Object.fromEntries(PURPOSES.map((p) => [p, gen.balance[p].balanced_attractions])),
      distributed,
      trips_one_way: total,
      trips_day: 2 * total,
      pairs_total: n * n,
      pairs_kept: exact.length,
      pairs_aggregated: pairs.length - exact.length,
      coverage: round(coverage, 4),
      district_km: districts.km,
    },
    town: { population: round(population), class: town.id, label: town.label },
    parameters: { trip_rates: tripRates, lambda: Object.fromEntries(PURPOSES.map((p) => [p, round(lambda[p], 4)])), zone_m: ZONE_M, bases: gen.bases, persons_per_weight: PERSONS_PER_WEIGHT },
    calibration: { od: calibrated ? calibration : null },
    assumptions,
    warnings,
  };
};

module.exports = { buildDemandModel, buildZones, townClassOf, TRIP_RATES, TOWN_CLASSES, PURPOSES, PERSONS_PER_WEIGHT, _internals: { generation, calibrateOnOd, distKm, rowFlows, projection, MAX_ZONES, MAX_PAIRS, COVER } };
