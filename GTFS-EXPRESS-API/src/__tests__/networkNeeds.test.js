/**
 * networkNeeds.test.js — what the system needs from the user, by impact,
 * and what a choice costs: the needs of an empty Studio, of a plan with a
 * territory and a brief, the service levers (fleet and yearly cost with
 * another peak headway or without weekend service), and POST /network/needs.
 */

"use strict";

process.env.BETA_GATE_DISABLED = "true";

const request = require("supertest");
const app = require("../app");
const { removeUploadRoot } = require("./_helpers/sampleSession");
const { normalizeSpec } = require("../services/network/networkSpec");
const { computeNeeds, serviceLevers, summarizeLevers, summarizeNeeds } = require("../services/network/dataNeedsService");

afterAll(() => removeUploadRoot());

const RAW = {
  agency: { name: "Besoins", url: "https://besoins.example", timezone: "Europe/Paris" },
  stops: [{ id: "A", name: "Gare", lat: 47.4, lon: 0.69 }, { id: "B", name: "Centre", lat: 47.41, lon: 0.7 }, { id: "C", name: "Hôpital", lat: 47.42, lon: 0.72 }, { id: "D", name: "Lycée" }],
  lines: [
    { short_name: "1", directions: [{ stops: ["A", "B", "C"] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "09:00", headway_min: 20 }, { from: "09:00", to: "20:00", headway_min: 30 }] }, { calendar: "saturday", periods: [{ from: "08:00", to: "19:00", headway_min: 30 }] }, { calendar: "sunday", periods: [{ from: "09:00", to: "18:00", headway_min: 60 }] }] },
  ],
};
const ids = (r) => r.needs.map((n) => n.id);

test("an empty Studio needs a territory, a brief and an operator first", () => {
  const r = computeNeeds({ spec: { agency: {}, stops: [], lines: [] } });
  expect(ids(r).slice(0, 3).sort()).toEqual(["brief", "operator", "territory"]);
  expect(r.counts.high).toBe(3);
  expect(r.needs.every((n, i, a) => i === 0 || ["high", "medium", "low"].indexOf(a[i - 1].impact) <= ["high", "medium", "low"].indexOf(n.impact))).toBe(true);
});

test("a plan with a territory and a brief: what is still defaulted or missing", () => {
  const spec = { ...normalizeSpec(RAW).spec, feed: undefined };
  const territory = { holidays: [{ date: "20261225" }], school_holidays: [{ nationwide: false }], population_grid: { estimated: true }, existing_lines: [{ id: "x" }], warnings: [] };
  const requirements = { clauses: [{ id: "c1", kind: "line_exists", params: { line: "1" } }], assumptions: [{ topic: "budget", value: "none", confidence: "low" }] };
  const r = computeNeeds({ spec, requirements, territory, quality: { operations: { fleet_total: 6, cost_year: 1200000, currency: "EUR", assumptions: { cost_basis: "country:fr" } } } });
  const byId = Object.fromEntries(r.needs.map((n) => [n.id, n]));
  expect(byId.stops_unlocated).toMatchObject({ impact: "high", params: { count: 1 }, action: "map" });
  expect(byId.caps).toMatchObject({ impact: "medium", state: "missing", params: { fleet: 6, cost_year: 1200000 } });
  expect(byId.holidays.impact).toBe("medium");
  expect(byId.service_level.state).toBe("defaulted");
  expect(byId.typical_trips).toBeTruthy();
  expect(byId.population.state).toBe("defaulted");
  expect(byId.brief_confirm.state).toBe("unconfirmed");
  expect(byId.assumptions.params.topics).toEqual(["budget"]);
  expect(byId.validity.impact).toBe("low");
  expect(byId.territory).toBeUndefined();
  expect(summarizeNeeds(r)).toMatch(/stops_unlocated \(high/);
});

test("service levers put figures on a question: a tighter peak needs more vehicles", () => {
  const spec = normalizeSpec({ ...RAW, stops: RAW.stops.slice(0, 3) }).spec;
  const l = serviceLevers(spec);
  const peak = (m) => l.variants.find((v) => v.id === "peak_headway" && v.params.minutes === m);
  expect(peak(10).fleet).toBeGreaterThanOrEqual(peak(20).fleet);
  expect(peak(10).cost_year).toBeGreaterThan(peak(20).cost_year);
  expect(peak(20).delta_fleet).toBe(0); // the plan already runs every 20 min at peak
  expect(l.variants.find((v) => v.id === "no_sunday").delta_cost).toBeLessThan(0);
  expect(summarizeLevers(l)).toMatch(/Peak every 10 min: \d+ vehicle/);
});

test("POST /network/needs: needs by impact and the levers", async () => {
  const res = await request(app).post("/gtfs/network/needs").send({ spec: { ...RAW, stops: RAW.stops.slice(0, 3) }, requirements: { clauses: [{ id: "c1", kind: "fleet_max", params: { vehicles: 4 } }] } });
  expect(res.status).toBe(200);
  expect(res.body.needs.map((n) => n.id)).toContain("territory");
  expect(res.body.needs.map((n) => n.id)).not.toContain("caps"); // the brief caps the fleet
  expect(res.body.needs.map((n) => n.id)).toContain("validity"); // dates left out
  expect(res.body.levers.base.fleet).toBeGreaterThan(0);
});

test("no Sunday also takes Sunday out of a weekend or daily calendar", () => {
  const spec = normalizeSpec({ ...RAW, stops: RAW.stops.slice(0, 3), lines: [{ ...RAW.lines[0], services: [{ calendar: "daily", periods: [{ from: "07:00", to: "19:00", headway_min: 30 }] }] }] }).spec;
  const l = serviceLevers(spec);
  const noSun = l.variants.find((v) => v.id === "no_sunday");
  const noSat = l.variants.find((v) => v.id === "no_saturday");
  expect(noSun.delta_cost).toBeLessThan(0);
  expect(noSat.delta_cost).toBeLessThan(0);
});
