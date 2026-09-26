/**
 * eval/network/cases.js — golden briefs for the network planner.
 *
 * Each case is what a real user would ask, the ORACLE the answer is
 * measured against (clauses a transport planner validated: the brief, made
 * checkable), a REFERENCE design that meets it, and MUTANTS — plausible
 * wrong designs that the oracle must reject. Everything happens in a
 * frozen, fictional town (no network access): its dossier stands in for
 * the territory, its gazetteer for the geocoder.
 *
 * Level 0 (CI, no tokens — GTFS-EXPRESS-API/src/__tests__/networkGolden.test.js):
 *   the reference meets every must clause, each mutant fails the clause it
 *   targets, the reference compiles into valid tables.
 * Level 1 (eval/network/run.mjs, real tokens): the planner designs each
 *   brief; the oracle scores what it delivered.
 *
 * CommonJS so both Jest and the ESM runner can load it.
 */

"use strict";

// ── The town: Valmont (fictional), a 25 000-inhabitant town on a grid ──────

const O = { lat: 45.5, lon: 4.0 };
const north = (m) => O.lat + m / 111320;
const east = (m) => O.lon + m / (111320 * Math.cos((O.lat * Math.PI) / 180));
const pt = (n, e) => ({ lat: Number(north(n).toFixed(6)), lon: Number(east(e).toFixed(6)) });

// Named places (gazetteer), metres from the centre.
const PLACES = {
  "Gare de Valmont": pt(-900, 1500),
  "Hôtel de Ville": pt(0, 0),
  "Place du Marché": pt(250, -300),
  "Centre Hospitalier": pt(1800, -600),
  "Lycée Jean Moulin": pt(-1400, -1800),
  "Zone d'activités des Plaines": pt(-2500, 2600),
  "Quartier des Tilleuls": pt(2300, 1900),
  "Stade municipal": pt(900, 2100),
  "Collège Pasteur": pt(1200, 800),
  "Médiathèque": pt(-300, 500),
};

const EXISTING_STOPS = Object.entries(PLACES).map(([name, p], i) => ({ id: `osm:node/${1000 + i}`, name, lat: p.lat, lon: p.lon, kind: "bus_stop" }));

const rect = (n1, e1, n2, e2) => {
  const a = pt(n1, e1);
  const b = pt(n2, e2);
  return [
    [a.lon, a.lat],
    [b.lon, a.lat],
    [b.lon, b.lat],
    [a.lon, b.lat],
    [a.lon, a.lat],
  ];
};

/** The territory dossier of Valmont (populationGrid is injected by the caller). */
const territory = (populationGrid) => ({
  place: { query: "Valmont", name: "Valmont", display_name: "Valmont, France", country_code: "fr", country: "France", lat: O.lat, lon: O.lon, bbox: [north(-4000), east(-4000), north(4000), east(4000)] },
  timezone: "Europe/Paris",
  elevation_m: 300,
  population: { value: 25000, source: "fixture" },
  population_grid: populationGrid([rect(-700, -700, 700, 700), rect(1900, 1500, 2700, 2300), rect(-1800, -2200, -1000, -1400), rect(800, 400, 1600, 1200)], 25000),
  stats: { area_km2: 30, density_per_km2: 833 },
  country: { code: "FR", name: "France", currency: { code: "EUR", symbol: "€" }, languages: ["fr"], weekend: ["sat", "sun"], cost_factor: 1 },
  existing_stops: EXISTING_STOPS,
  existing_lines: [],
  pois: {
    categories: { station: 1, hospital: 1, school: 1, college: 1, work: 1, civic: 1, market: 1, leisure: 1 },
    items: [
      { id: "poi:gare", name: "Gare de Valmont", category: "station", ...PLACES["Gare de Valmont"], weight: 5 },
      { id: "poi:hop", name: "Centre Hospitalier", category: "hospital", ...PLACES["Centre Hospitalier"], weight: 4 },
      { id: "poi:lycee", name: "Lycée Jean Moulin", category: "school", ...PLACES["Lycée Jean Moulin"], weight: 3 },
      { id: "poi:college", name: "Collège Pasteur", category: "school", ...PLACES["Collège Pasteur"], weight: 3 },
      { id: "poi:za", name: "Zone d'activités des Plaines", category: "work", ...PLACES["Zone d'activités des Plaines"], weight: 3 },
      { id: "poi:mairie", name: "Hôtel de Ville", category: "civic", ...PLACES["Hôtel de Ville"], weight: 2 },
      { id: "poi:marche", name: "Place du Marché", category: "market", ...PLACES["Place du Marché"], weight: 2 },
      { id: "poi:stade", name: "Stade municipal", category: "leisure", ...PLACES["Stade municipal"], weight: 1 },
    ],
  },
  works: { items: [] },
  holidays: [
    { date: "20261101", name: "Toussaint" },
    { date: "20261111", name: "Armistice" },
    { date: "20261225", name: "Noël" },
    { date: "20270101", name: "Jour de l'an" },
    { date: "20270405", name: "Lundi de Pâques" },
    { date: "20270501", name: "Fête du Travail" },
  ],
  school_holidays: [],
  sources: [],
  warnings: [],
  generatedAt: "2026-09-01T00:00:00.000Z",
});

/** Gazetteer lookup standing in for the geocoder ("Place, Valmont" → the place). */
const geocode = (query) => {
  const q = String(query || "").split(",")[0].trim().toLowerCase();
  const hit = Object.entries(PLACES).find(([name]) => name.toLowerCase() === q || name.toLowerCase().includes(q) || q.includes(name.toLowerCase()));
  return { query, candidates: hit ? [{ label: `${hit[0]}, Valmont, France`, name: hit[0], lat: hit[1].lat, lon: hit[1].lon, kind: "place" }] : [] };
};

const AGENCY = { name: "Valmont Mobilités", url: "https://valmont-mobilites.example", timezone: "Europe/Paris", lang: "fr" };
const FEED = { start_date: "20260901", end_date: "20270831" };
const stop = (name) => ({ id: name.replace(/[^A-Za-z]/g, "").slice(0, 10).toUpperCase(), name, ...PLACES[name] });

// ── The cases ─────────────────────────────────────────────────────────────

const CASES = [
  {
    id: "shuttle_station_hospital",
    brief: "Pour Valmont, une navette entre la gare, l'hôtel de ville et le centre hospitalier, toutes les 20 minutes de 7h à 19h en semaine. Pas de service le dimanche.",
    answers: {},
    oracle: {
      clauses: [
        { id: "serves_gare", kind: "serves", level: "must", params: { place: "Gare de Valmont" } },
        { id: "serves_mairie", kind: "serves", level: "must", params: { place: "Hôtel de Ville" } },
        { id: "serves_hopital", kind: "serves", level: "must", params: { place: "Centre Hospitalier" } },
        { id: "every_20", kind: "headway_max", level: "must", params: { day: "weekday", from: "07:00", to: "19:00", minutes: 20 } },
        { id: "span", kind: "span", level: "must", params: { day: "weekday", first_before: "07:00", last_after: "18:40" } },
        { id: "no_sunday", kind: "no_service", level: "must", params: { days: ["sunday"] } },
        { id: "one_line", kind: "lines_max", level: "should", params: { count: 1 } },
      ],
    },
    reference: {
      agency: AGENCY,
      feed: FEED,
      stops: [stop("Gare de Valmont"), stop("Hôtel de Ville"), stop("Centre Hospitalier")],
      lines: [{ short_name: "N", long_name: "Navette Gare ↔ Hôpital", mode: "shuttle", directions: [{ stops: ["GAREDEVALM", "HTELDEVILL", "CENTREHOSP"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 20 }] }] }],
    },
    mutants: [
      { id: "every_30", breaks: "every_20", change: (s) => ({ ...s, lines: [{ ...s.lines[0], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 30 }] }] }] }) },
      { id: "skips_hospital", breaks: "serves_hopital", change: (s) => ({ ...s, lines: [{ ...s.lines[0], directions: [{ stops: ["GAREDEVALM", "HTELDEVILL"] }] }] }) },
      { id: "runs_sunday", breaks: "no_sunday", change: (s) => ({ ...s, lines: [{ ...s.lines[0], services: [...s.lines[0].services, { calendar: "sunday", periods: [{ from: "09:00", to: "18:00", headway_min: 60 }] }] }] }) },
    ],
  },
  {
    id: "town_three_lines_budget",
    brief: "Concevez le réseau de bus de Valmont (25 000 habitants) : trois lignes au plus, qui passent toutes par l'hôtel de ville. Il faut desservir la gare, l'hôpital, la zone d'activités des Plaines et le quartier des Tilleuls. Une ligne forte gare ↔ hôpital toutes les 10 minutes en pointe (7h-9h). Budget d'exploitation maximum : 1,5 M€ par an. Un habitant de la gare doit rejoindre l'hôpital en moins de 25 minutes à 8h.",
    answers: { sunday: "Pas de service le dimanche", budget: "1,5 M€ par an" },
    oracle: {
      clauses: [
        { id: "max3", kind: "lines_max", level: "must", params: { count: 3 } },
        { id: "gare", kind: "serves", level: "must", params: { place: "Gare de Valmont" } },
        { id: "hopital", kind: "serves", level: "must", params: { place: "Centre Hospitalier" } },
        { id: "za", kind: "serves", level: "must", params: { place: "Zone d'activités des Plaines" } },
        { id: "tilleuls", kind: "serves", level: "must", params: { place: "Quartier des Tilleuls" } },
        { id: "budget", kind: "budget_max", level: "must", params: { amount: 1500000 } },
        { id: "gare_hopital_25", kind: "od_max_time", level: "must", params: { from: "Gare de Valmont", to: "Centre Hospitalier", day: "weekday", depart_at: "08:00", max_minutes: 25 } },
        { id: "peak_10", kind: "headway_max", level: "should", params: { day: "weekday", from: "07:00", to: "09:00", minutes: 10, line: "A" } },
      ],
    },
    reference: {
      agency: AGENCY,
      feed: FEED,
      stops: ["Gare de Valmont", "Hôtel de Ville", "Centre Hospitalier", "Zone d'activités des Plaines", "Quartier des Tilleuls", "Place du Marché", "Collège Pasteur"].map(stop),
      lines: [
        { short_name: "A", directions: [{ stops: ["GAREDEVALM", "HTELDEVILL", "CENTREHOSP"] }], services: [{ calendar: "weekday", periods: [{ from: "06:30", to: "07:00", headway_min: 20 }, { from: "07:00", to: "09:00", headway_min: 10 }, { from: "09:00", to: "20:00", headway_min: 20 }] }, { calendar: "saturday", periods: [{ from: "08:00", to: "19:00", headway_min: 30 }] }] },
        { short_name: "B", directions: [{ stops: ["ZONEDACTIV", "HTELDEVILL", "QUARTIERDE"] }], services: [{ calendar: "weekday", periods: [{ from: "06:30", to: "20:00", headway_min: 30 }] }] },
        { short_name: "C", directions: [{ stops: ["PLACEDUMAR", "HTELDEVILL", "COLLGEPAST"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 60 }] }] },
      ],
    },
    mutants: [
      { id: "four_lines", breaks: "max3", change: (s) => ({ ...s, lines: [...s.lines, { short_name: "D", directions: [{ stops: ["GAREDEVALM", "PLACEDUMAR"] }], services: [{ calendar: "weekday", departures: ["08:00"] }] }] }) },
      { id: "forgets_tilleuls", breaks: "tilleuls", change: (s) => ({ ...s, lines: s.lines.map((l) => (l.short_name === "B" ? { ...l, directions: [{ stops: ["ZONEDACTIV", "HTELDEVILL"] }] } : l)) }) },
      { id: "overspends", breaks: "budget", change: (s) => ({ ...s, lines: s.lines.map((l) => ({ ...l, services: [{ calendar: "daily", periods: [{ from: "05:00", to: "23:59", headway_min: 5 }] }] })) }) },
      { id: "slow_link", breaks: "gare_hopital_25", change: (s) => ({ ...s, lines: s.lines.map((l) => (l.short_name === "A" ? { ...l, speed_kmh: 6 } : l)) }) },
    ],
  },
  {
    id: "school_line_arrive_by",
    brief: "Une ligne scolaire pour le lycée Jean Moulin de Valmont : départ de la gare, passage par la place du marché, arrivée au lycée avant 7h55 les jours de classe, et un retour après 17h. Deux services suffisent.",
    answers: {},
    oracle: {
      clauses: [
        { id: "termini", kind: "serves", level: "must", params: { place: "Lycée Jean Moulin" } },
        { id: "via_marche", kind: "serves", level: "must", params: { place: "Place du Marché" } },
        { id: "arrive_755", kind: "od_max_time", level: "must", params: { from: "Gare de Valmont", to: "Lycée Jean Moulin", day: "weekday", arrive_by: "07:55", max_minutes: 40 } },
        { id: "evening", kind: "span", level: "must", params: { day: "weekday", last_after: "17:00" } },
        { id: "no_weekend", kind: "no_service", level: "should", params: { days: ["saturday", "sunday"] } },
      ],
    },
    reference: {
      agency: AGENCY,
      feed: FEED,
      stops: [stop("Gare de Valmont"), stop("Place du Marché"), stop("Lycée Jean Moulin")],
      lines: [{ short_name: "S1", long_name: "Scolaire Gare ↔ Lycée", mode: "shuttle", directions: [{ id: "0", stops: ["GAREDEVALM", "PLACEDUMAR", "LYCEJEANMO"] }, { id: "1", stops: ["LYCEJEANMO", "PLACEDUMAR", "GAREDEVALM"] }], services: [{ calendar: "weekday", direction: "0", departures: ["07:20"] }, { calendar: "weekday", direction: "1", departures: ["17:10"] }] }],
    },
    mutants: [
      { id: "too_late", breaks: "arrive_755", change: (s) => ({ ...s, lines: [{ ...s.lines[0], services: [{ calendar: "weekday", direction: "0", departures: ["07:50"] }, s.lines[0].services[1]] }] }) },
      { id: "no_return", breaks: "evening", change: (s) => ({ ...s, lines: [{ ...s.lines[0], services: [s.lines[0].services[0]] }] }) },
    ],
  },
];

module.exports = { CASES, PLACES, territory, geocode };
