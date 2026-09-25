/**
 * networkDesign.test.js — the deterministic design engine: demand hubs and
 * corridor candidates from a territory, snapping and densifying stops with
 * the existing ones, the design quality report, and the normalised-spec
 * round trip that makes refined specs re-validatable.
 */

"use strict";

const design = require("../services/network/networkDesignService");
const { normalizeSpec } = require("../services/network/networkSpec");

// A synthetic town: a centre, a station 2.5 km east, a hospital 2 km north,
// a school district 1.5 km west; bus stops along the east–west axis.
const C = { lat: 47.0, lon: 1.0 };
const east = (m) => 1.0 + m / (111320 * Math.cos((47 * Math.PI) / 180));
const north = (m) => 47.0 + m / 111320;
const TERRITORY = {
  place: { query: "Ville", name: "Ville", display_name: "Ville, France", country_code: "FR", lat: C.lat, lon: C.lon, bbox: [46.9, 0.9, 47.1, 1.1] },
  timezone: "Europe/Paris",
  population: { value: 45000, source: "wikidata" },
  existing_stops: [
    { id: "osm:1", name: "Centre", lat: C.lat, lon: C.lon, kind: "bus_stop" },
    { id: "osm:2", name: "Poste", lat: north(20), lon: east(500), kind: "bus_stop" },
    { id: "osm:3", name: "Stade", lat: north(-15), lon: east(1000), kind: "bus_stop" },
    { id: "osm:4", name: "Collège", lat: north(30), lon: east(1600), kind: "bus_stop" },
    { id: "osm:5", name: "Gare", lat: C.lat, lon: east(2500), kind: "station" },
    { id: "osm:6", name: "Hôpital", lat: north(2000), lon: C.lon, kind: "bus_stop" },
    { id: "osm:7", name: "Écoles", lat: C.lat, lon: east(-1500), kind: "bus_stop" },
    { id: "osm:8", name: null, lat: north(500), lon: east(500), kind: "bus_stop" },
  ],
  existing_lines: [],
  pois: {
    categories: { station: 1, hospital: 1, school: 2, market: 1 },
    items: [
      { id: "p1", name: "Gare SNCF", category: "station", lat: north(30), lon: east(2520), weight: 5 },
      { id: "p2", name: "Centre hospitalier", category: "hospital", lat: north(2050), lon: east(20), weight: 4 },
      { id: "p3", name: "École Jules Ferry", category: "school", lat: north(40), lon: east(-1520), weight: 3 },
      { id: "p4", name: "École Pasteur", category: "school", lat: north(-60), lon: east(-1480), weight: 3 },
      { id: "p5", name: "Marché", category: "market", lat: north(50), lon: east(40), weight: 3 },
    ],
  },
  holidays: [{ date: "20261225", name: "Noël" }],
  school_holidays: [],
  sources: [],
  warnings: [],
};

const SPEC = {
  agency: { name: "Ville Mobilités", url: "https://ville.example", timezone: "Europe/Paris" },
  feed: { start_date: "20260901", end_date: "20270831" },
  stops: [
    { id: "centre", name: "Centre-ville", lat: north(10), lon: east(15) }, // 18 m from osm:1 → snapped
    { id: "gare", name: "Gare", lat: C.lat, lon: east(2500) },
    { id: "hopital", name: "Hôpital", lat: north(2000), lon: C.lon },
  ],
  lines: [
    { short_name: "A", mode: "bus", directions: [{ headsign: "Gare", stops: ["centre", "gare"] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "21:00", headway_min: 15 }] }, { calendar: "saturday", periods: [{ from: "08:00", to: "20:00", headway_min: 30 }] }] },
    { short_name: "B", mode: "bus", directions: [{ headsign: "Hôpital", stops: ["centre", "hopital"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "12:00", headway_min: 40 }] }] },
  ],
  holidays: ["20261225"],
};

describe("demand hubs and corridors", () => {
  test("clusters the generators into hubs and proposes corridors between them", () => {
    const hubs = design.demandHubs(TERRITORY);
    expect(hubs.length).toBeGreaterThanOrEqual(4);
    // The centre (market + place centre) is the heaviest hub and sits on an existing stop.
    expect(hubs[0].name).toBe("Ville");
    expect(hubs[0].stop).toMatchObject({ id: "osm:1", name: "Centre" });
    expect(hubs.find((h) => h.name === "Gare SNCF").stop.id).toBe("osm:5");
    const { corridors } = design.suggestCorridors(TERRITORY, { maxLines: 3 });
    expect(corridors.length).toBe(3);
    expect(corridors[0].score).toBeGreaterThanOrEqual(corridors[1].score);
    // The centre ↔ station corridor exists and reuses the existing stop ids.
    const cs = corridors.find((c) => [c.from.name, c.to.name].includes("Centre") && [c.from.name, c.to.name].includes("Gare"));
    expect(cs).toBeTruthy();
    expect([cs.from.existing_stop_id, cs.to.existing_stop_id].sort()).toEqual(["osm:1", "osm:5"]);
    expect(cs.straight_km).toBeCloseTo(2.5, 0);
    const text = design.summarizeCorridors({ hubs, corridors });
    expect(text).toMatch(/Corridor candidates/);
    expect(text).toMatch(/c1 score/);
  });

  test("corridors already served by the plan are skipped", () => {
    const norm = normalizeSpec(SPEC).spec;
    const { corridors } = design.suggestCorridors(TERRITORY, { maxLines: 4, spec: norm });
    const both = corridors.filter((c) => ["Centre", "Gare"].includes(c.from.name) && ["Centre", "Gare"].includes(c.to.name));
    expect(both).toHaveLength(0);
  });
});

describe("refineStops", () => {
  test("snaps onto existing stops and fills long gaps with the existing stops along the way", () => {
    const norm = normalizeSpec(SPEC).spec;
    const r = design.refineStops(norm, TERRITORY);
    expect(r.snapped).toBe(1);
    expect(r.changes[0]).toMatchObject({ type: "snap", stop_id: "centre", to: "Centre", existing_id: "osm:1" });
    // Line A: 2.5 km between Centre and Gare → Poste, Stade, Collège inserted in order.
    const lineA = r.spec.lines.find((l) => l.short_name === "A");
    expect(lineA.directions[0].stops).toEqual(["centre", "osm:2", "osm:3", "osm:4", "gare"]);
    expect(lineA.directions[1].stops).toEqual(["gare", "osm:4", "osm:3", "osm:2", "centre"]);
    expect(r.inserted).toBe(3);
    // Line B (north): the unnamed stop is never used; nothing lies on the axis.
    const lineB = r.spec.lines.find((l) => l.short_name === "B");
    expect(lineB.directions[0].stops).toEqual(["centre", "hopital"]);
    // The refined spec re-validates as is (calendar ids round-trip).
    const again = normalizeSpec(r.spec);
    expect(again.ok).toBe(true);
    expect(again.spec.stops.map((s) => s.id)).toEqual(expect.arrayContaining(["osm:2", "osm:3", "osm:4"]));
    expect(again.spec.lines[0].services[0].calendar_id).toBe("WKD");
    expect(again.spec.calendars.map((c) => c.id).sort()).toEqual(["SAT", "WKD"]);
  });

  test("a normalised spec with custom calendars round-trips through normalizeSpec", () => {
    const custom = { ...SPEC, lines: [{ ...SPEC.lines[0], services: [{ calendar: { days: ["mon", "tue"], start_date: "20260901", end_date: "20261231" }, periods: [{ from: "08:00", to: "10:00", headway_min: 30 }] }] }] };
    const first = normalizeSpec(custom);
    expect(first.ok).toBe(true);
    const second = normalizeSpec(first.spec);
    expect(second.ok).toBe(true);
    expect(second.spec.calendars).toEqual(first.spec.calendars);
    expect(second.spec.lines[0].services[0].calendar_id).toBe(first.spec.lines[0].services[0].calendar_id);
  });
});

describe("evaluatePlan", () => {
  test("scores the seven dimensions and recommends what to fix", () => {
    const norm = normalizeSpec(SPEC).spec;
    const geometry = { lines: [
      { id: "A", short_name: "A", directions: [{ id: "0", routable: true, distance_km: 2.9, running_min: 11 }, { id: "1", routable: true, distance_km: 2.9, running_min: 11 }] },
      { id: "B", short_name: "B", directions: [{ id: "0", routable: true, distance_km: 2.2, running_min: 4 }, { id: "1", routable: true, distance_km: 2.2, running_min: 4 }] },
    ] };
    const r = design.evaluatePlan(norm, { territory: TERRITORY, geometry });
    const byId = Object.fromEntries(r.dimensions.map((d) => [d.id, d]));
    expect(r.dimensions.map((d) => d.id)).toEqual(["coverage", "spacing", "directness", "service", "connectivity", "plausibility", "compliance"]);
    // Coverage: schools (west) unserved.
    expect(byId.coverage.score).toBeLessThan(100);
    expect(byId.coverage.findings.some((x) => /École/.test(x.message))).toBe(true);
    // Spacing: both lines have a single long leg.
    expect(byId.spacing.score).toBe(0);
    expect(byId.spacing.findings.some((x) => x.line === "A" && /gap/.test(x.message))).toBe(true);
    // Directness: straight lines.
    expect(byId.directness.score).toBe(100);
    // Service: B runs 5 h, every 40 min, no weekend → findings on B, not on A's headway.
    expect(byId.service.peak_headway_target_min).toBe(15);
    expect(byId.service.findings.some((x) => x.line === "B" && /runs 4.7 h/.test(x.message))).toBe(true);
    expect(byId.service.findings.some((x) => x.line === "B" && /peak headway 40 min/.test(x.message))).toBe(true);
    expect(byId.service.findings.some((x) => x.line === "A" && /peak headway/.test(x.message))).toBe(false);
    // Every finding shown to the user carries a code and its values: the studio translates it.
    expect(byId.service.findings.find((x) => x.line === "B" && x.code === "short_span").params).toMatchObject({ line: "B", hours: 4.7 });
    expect(byId.service.findings.find((x) => x.line === "B" && /^peak_headway/.test(x.code)).params).toMatchObject({ headway: 40, target: 15 });
    for (const d of r.dimensions) for (const x of d.findings) if (x.level !== "info") expect(x.code).toMatch(/^[a-z_]+$/);
    // Connectivity: both lines meet at the centre.
    expect(byId.connectivity.score).toBe(100);
    // Plausibility: B at 33 km/h is plausible; A at 15.8 km/h too.
    expect(byId.plausibility.score).toBe(100);
    // Compliance: a placeholder URL (example) costs 10 points.
    expect(byId.compliance.score).toBe(90);
    expect(byId.compliance.findings.some((x) => /placeholder/.test(x.message))).toBe(true);
    expect(r.score).toBeGreaterThan(40);
    expect(r.score).toBeLessThan(85);
    expect(["B", "C", "D"]).toContain(r.grade);
    expect(r.recommendations[0].level).toBe("major");
    expect(design.summarizeReport(r)).toMatch(/Design quality: \d+\/100/);
  });

  test("without a territory the coverage dimension is not measurable and the score renormalises", () => {
    const norm = normalizeSpec(SPEC).spec;
    const r = design.evaluatePlan(norm, {});
    expect(r.dimensions[0].score).toBeNull();
    expect(r.score).not.toBeNull();
    expect(r.dimensions.find((d) => d.id === "plausibility").findings.some((x) => /estimate_routes/.test(x.hint || ""))).toBe(true);
  });

  test("isolated lines and missing coordinates are major findings", () => {
    const spec = { ...SPEC, stops: [...SPEC.stops, { id: "far", name: "Loin" }, { id: "far2", name: "Plus loin", lat: north(6000), lon: east(6000) }], lines: [...SPEC.lines, { short_name: "Z", mode: "bus", directions: [{ headsign: "x", stops: ["far", "far2"] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "20:00", headway_min: 20 }] }] }] };
    const norm = normalizeSpec(spec).spec;
    const r = design.evaluatePlan(norm, { territory: TERRITORY });
    const byId = Object.fromEntries(r.dimensions.map((d) => [d.id, d]));
    expect(byId.connectivity.findings.some((x) => x.level === "major" && x.line === "Z")).toBe(true);
    expect(byId.plausibility.findings.some((x) => x.level === "major" && /without coordinates/.test(x.message))).toBe(true);
    expect(r.majors).toBeGreaterThanOrEqual(2);
  });
});
