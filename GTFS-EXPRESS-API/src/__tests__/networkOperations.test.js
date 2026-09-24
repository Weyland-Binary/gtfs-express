/**
 * networkOperations.test.js — residents on the ground and the bill to run
 * the plan: the population grid spread over residential land, its share
 * within reach of a stop, the demand hubs weighed by residents, the fleet
 * (peak overlapping trips), the yearly vehicle-km and cost, and the caps a
 * brief imposes.
 */

"use strict";

const territory = require("../services/network/territoryService");
const design = require("../services/network/networkDesignService");
const ops = require("../services/network/operationsService");
const { normalizeSpec } = require("../services/network/networkSpec");

const east = (m) => 1.0 + m / (111320 * Math.cos((47 * Math.PI) / 180));
const north = (m) => 47.0 + m / 111320;
const rect = (x0, y0, x1, y1) => [{ lat: north(y0), lon: east(x0) }, { lat: north(y0), lon: east(x1) }, { lat: north(y1), lon: east(x1) }, { lat: north(y1), lon: east(x0) }, { lat: north(y0), lon: east(x0) }];

describe("population grid", () => {
  test("spreads the known population over the residential polygons on a 250 m grid", () => {
    // Two residential areas: 1 km² around the centre, 0.25 km² 3 km east.
    const grid = territory.populationGrid([rect(-500, -500, 500, 500), rect(2750, -250, 3250, 250)], 20000);
    expect(grid.cell_m).toBe(250);
    expect(grid.total).toBe(20000);
    expect(grid.estimated).toBe(false);
    expect(grid.residential_km2).toBeCloseTo(1.25, 1);
    const total = grid.cells.reduce((s, c) => s + c.pop, 0);
    expect(total).toBeGreaterThan(19000);
    expect(total).toBeLessThanOrEqual(20000);
    // The big square holds ~80 % of the residents, the small one ~20 %.
    const eastPop = grid.cells.filter((c) => c.lon > east(2000)).reduce((s, c) => s + c.pop, 0);
    expect(eastPop / total).toBeGreaterThan(0.15);
    expect(eastPop / total).toBeLessThan(0.25);
    expect(territory._internals.polygonAreaM2(rect(0, 0, 1000, 1000))).toBeCloseTo(1e6, -3);
    expect(territory._internals.pointInPolygon(north(10), east(10), rect(0, 0, 100, 100))).toBe(true);
    expect(territory._internals.pointInPolygon(north(150), east(10), rect(0, 0, 100, 100))).toBe(false);
  });

  test("without a known population the grid is estimated from a default density and flagged", () => {
    const grid = territory.populationGrid([rect(0, 0, 1000, 1000)], null);
    expect(grid.estimated).toBe(true);
    expect(grid.total).toBeCloseTo(4000, -2);
    expect(territory.populationGrid([], 1000)).toBeNull();
  });

  test("coverage counts the residents within reach; hubs are weighed by residents", () => {
    const grid = territory.populationGrid([rect(-500, -500, 500, 500), rect(2750, -250, 3250, 250)], 20000);
    const dossier = { place: { name: "Ville", lat: 47.0, lon: 1.0, bbox: [46.9, 0.9, 47.1, 1.1] }, population: { value: 20000 }, population_grid: grid, existing_stops: [], existing_lines: [], pois: { categories: {}, items: [] }, holidays: [], school_holidays: [], sources: [], warnings: [] };
    const spec = normalizeSpec({
      agency: { name: "V", url: "https://v.example", timezone: "Europe/Paris" },
      stops: [{ id: "a", name: "A", lat: north(-300), lon: east(-300) }, { id: "b", name: "B", lat: north(300), lon: east(300) }],
      lines: [{ short_name: "1", directions: [{ stops: ["a", "b"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 20 }] }] }],
    }).spec;
    const c = territory.coverageOf(spec, dossier);
    expect(c.population.total).toBe(grid.cells.reduce((s, x) => s + x.pop, 0));
    // Two stops in the centre square: most of it within 400 m, nothing in the east.
    expect(c.population.pct).toBeGreaterThan(30);
    expect(c.population.pct).toBeLessThan(80);
    expect(c.population.top_missed).toHaveLength(5);
    expect(c.population.top_missed.every((m) => m.pop > 0)).toBe(true);
    const hubs = design.demandHubs(dossier);
    expect(hubs.some((h) => h.categories.residents)).toBe(true);
    // The report's coverage dimension is the mean of generators (n/a here) and residents.
    const r = design.evaluatePlan(spec, { territory: dossier });
    expect(r.dimensions[0].score).toBe(c.population.pct);
    expect(territory.summarizeForModel(dossier)).toMatch(/Residents on a 250 m grid/);
  });
});

const SPEC = {
  agency: { name: "V", url: "https://v.example", timezone: "Europe/Paris" },
  feed: { start_date: "20260101", end_date: "20261231" },
  stops: [{ id: "a", name: "A", lat: 47.0, lon: 1.0 }, { id: "b", name: "B", lat: 47.0, lon: east(6000) }],
  lines: [
    { id: "L1", short_name: "1", mode: "bus", directions: [{ stops: ["a", "b"] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "20:00", headway_min: 10 }] }, { calendar: "saturday", periods: [{ from: "08:00", to: "20:00", headway_min: 30 }] }] },
    { id: "L2", short_name: "2", mode: "tram", directions: [{ stops: ["a", "b"] }], services: [{ calendar: "daily", departures: ["08:00", "12:00"] }] },
  ],
  operations: { currency: "CHF", cost_per_km: { tram: 10 }, layover_min: 6, max_vehicles: 6 },
};
const GEOMETRY = { lines: [
  { id: "L1", short_name: "1", directions: [{ id: "0", routable: true, distance_km: 7.5, running_min: 24 }, { id: "1", routable: true, distance_km: 7.5, running_min: 24 }] },
  { id: "L2", short_name: "2", directions: [{ id: "0", routable: true, distance_km: 7.0, running_min: 18 }, { id: "1", routable: true, distance_km: 7.0, running_min: 18 }] },
] };

describe("operations", () => {
  test("fleet from overlapping trips, yearly vehicle-km and cost per line, caps", () => {
    const norm = normalizeSpec(SPEC);
    expect(norm.ok).toBe(true);
    expect(norm.spec.operations).toEqual({ currency: "CHF", cost_per_km: { tram: 10 }, layover_min: 6, max_vehicles: 6 });
    const o = ops.estimateOperations(norm.spec, GEOMETRY);
    const l1 = o.per_line.find((l) => l.id === "L1");
    // Line 1: cycle 2 × (24 + 6) = 60 min at a 10-min headway → 6 vehicles.
    expect(l1.vehicles_peak).toBe(6);
    expect(l1.trips_weekday).toBe(85 * 2);
    // 2026 has 261 weekdays and 52 Saturdays.
    expect(o.days.mon).toBe(52);
    expect(l1.veh_km_year).toBe(Math.round(170 * 7.5 * 261 + 25 * 2 * 7.5 * 52));
    expect(l1.cost_per_km).toBe(4.2);
    expect(l1.cost_year).toBe(Math.round(l1.veh_km_year * 4.2));
    const l2 = o.per_line.find((l) => l.id === "L2");
    // Both directions leave at 08:00 and 12:00 (no reverse offset): two trams at once.
    expect(l2.vehicles_peak).toBe(2);
    expect(l2.cost_per_km).toBe(10);
    expect(l2.veh_km_year).toBe(Math.round(2 * 2 * 7.0 * 365));
    expect(o.fleet_total).toBe(8);
    expect(o.currency).toBe("CHF");
    expect(o.limits).toEqual({ max_vehicles: 6 });
    expect(ops.summarizeOperations(o)).toMatch(/OVER THE FLEET CAP: 8 > 6/);
    // The report carries it and flags the overrun as a major compliance finding.
    const r = design.evaluatePlan(norm.spec, { geometry: GEOMETRY });
    expect(r.operations.fleet_total).toBe(8);
    const compliance = r.dimensions.find((d) => d.id === "compliance");
    expect(compliance.findings.some((x) => x.level === "major" && /needs 8 vehicles; the brief allows 6/.test(x.message))).toBe(true);
    expect(design.summarizeReport(r)).toMatch(/Operations \(no interlining, layover 6 min\): fleet 8/);
  });

  test("falls back to straight distances and mode speeds without geometry; invalid figures are rejected", () => {
    const norm = normalizeSpec({ ...SPEC, operations: undefined });
    const o = ops.estimateOperations(norm.spec, null);
    expect(o.currency).toBe("EUR");
    expect(o.per_line[0].km_weekday).toBeGreaterThan(0);
    expect(o.per_line[0].vehicles_peak).toBeGreaterThanOrEqual(5);
    const bad = normalizeSpec({ ...SPEC, operations: { cost_per_km: -1 } });
    expect(bad.blockers.some((b) => b.code === "invalid_operations")).toBe(true);
  });
});
