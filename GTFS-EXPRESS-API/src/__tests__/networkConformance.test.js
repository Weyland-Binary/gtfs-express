/**
 * networkConformance.test.js — the brief as checkable clauses: each kind
 * against a small network, typical trips on the compiled timetable, the
 * merge that keeps the user's decisions, the generic norms a clause lifts,
 * and the verdict in the built network's report and /network/evaluate.
 */

"use strict";

process.env.BETA_GATE_DISABLED = "true";

const request = require("supertest");
const app = require("../app");
const { removeUploadRoot } = require("./_helpers/sampleSession");
const connection = require("../services/db/connection");
const { normalizeSpec } = require("../services/network/networkSpec");
const { compileSpec } = require("../services/network/compiler");
const { createRouter } = require("../services/network/roadRouter");
const design = require("../services/network/networkDesignService");
const C = require("../services/network/conformanceService");

afterAll(() => {
  connection.closeAllDbHandles?.();
  removeUploadRoot();
});

// Line A: Gare → Mairie → Hôpital, every 10 min 07–09 then 30 min to 20:00 on
// weekdays, hourly on Saturday. Line S: school shuttle, two runs.
const RAW = {
  agency: { name: "Conforme", url: "https://conforme.example", timezone: "Europe/Paris" },
  feed: { start_date: "20260901", end_date: "20270831" },
  stops: [
    { id: "GARE", name: "Gare SNCF", lat: 47.4, lon: 0.69 },
    { id: "MAIRIE", name: "Mairie", lat: 47.405, lon: 0.695 },
    { id: "HOP", name: "Hôpital Bretonneau", lat: 47.41, lon: 0.7 },
    { id: "LYC", name: "Lycée Balzac", lat: 47.415, lon: 0.71 },
  ],
  lines: [
    {
      short_name: "A",
      directions: [{ stops: ["GARE", "MAIRIE", "HOP"] }],
      services: [
        { calendar: "weekday", periods: [{ from: "07:00", to: "09:00", headway_min: 10 }, { from: "09:00", to: "20:00", headway_min: 30 }] },
        { calendar: "saturday", periods: [{ from: "08:00", to: "19:00", headway_min: 60 }] },
      ],
    },
    { short_name: "S", mode: "shuttle", directions: [{ stops: ["GARE", "LYC"] }], services: [{ calendar: "weekday", departures: ["07:30", "17:00"] }] },
  ],
};
const spec = normalizeSpec(RAW).spec;
const clause = (id, kind, params, extra = {}) => ({ id, kind, params, level: "must", ...extra });
const verdictOf = (clauses, ctx = {}) => C.checkConformance(spec, { clauses }, ctx);
const statusOf = (clauses, ctx) => Object.fromEntries(verdictOf(clauses, ctx).results.map((r) => [r.id, r.status]));

describe("clauses, one by one", () => {
  test("lines, termini, vias, mode", () => {
    expect(
      statusOf([
        clause("a", "line_exists", { line: "A" }),
        clause("b", "line_exists", { line: "Z" }),
        clause("t1", "termini", { line: "A", from: "Hôpital", to: "Gare" }), // either direction, partial names
        clause("t2", "termini", { line: "A", from: "Gare", to: "Lycée Balzac" }),
        clause("v1", "via", { line: "A", stops: ["Mairie"] }),
        clause("v2", "via", { line: "A", stops: ["Lycée Balzac"] }),
        clause("m", "mode", { line: "S", mode: "shuttle" }),
      ]),
    ).toEqual({ a: "pass", b: "fail", t1: "pass", t2: "fail", v1: "pass", v2: "fail", m: "pass" });
  });

  test("serves: a place near a stop, by coordinates or by name; unknown when it cannot be located", () => {
    const r = statusOf([
      clause("near", "serves", { place: "Clinique", lat: 47.4101, lon: 0.7003 }),
      clause("far", "serves", { place: "Stade", lat: 47.45, lon: 0.75 }),
      clause("name", "serves", { place: "Lycée Balzac" }),
      clause("unknown", "serves", { place: "Piscine olympique" }),
    ]);
    expect(r).toEqual({ near: "pass", far: "fail", name: "pass", unknown: "unknown" });
  });

  test("headway, span, days, no_service", () => {
    const r = statusOf([
      clause("peak10", "headway_max", { line: "A", day: "weekday", from: "07:00", to: "09:00", minutes: 10 }),
      clause("peak5", "headway_max", { line: "A", day: "weekday", from: "07:00", to: "09:00", minutes: 5 }),
      clause("eve", "headway_max", { line: "A", day: "weekday", from: "20:30", to: "22:00", minutes: 30 }),
      clause("span_ok", "span", { line: "A", day: "weekday", first_before: "07:00", last_after: "20:00" }),
      clause("span_late", "span", { line: "A", day: "weekday", last_after: "21:00" }),
      clause("sat", "days", { line: "A", days: ["saturday"] }),
      clause("sun", "days", { line: "A", days: ["sunday"] }),
      clause("nosun", "no_service", { days: ["sunday"] }),
      clause("nosat", "no_service", { line: "S", days: ["sat"] }),
    ]);
    expect(r).toEqual({ peak10: "pass", peak5: "fail", eve: "fail", span_ok: "pass", span_late: "fail", sat: "pass", sun: "fail", nosun: "pass", nosat: "pass" });
    const peak5 = verdictOf([clause("peak5", "headway_max", { line: "A", day: "weekday", from: "07:00", to: "09:00", minutes: 5 })]).results[0];
    expect(peak5.measured).toMatch(/longest wait 10 min/);
  });

  test("counts and caps", () => {
    const ops = { fleet_total: 4, cost_year: 900000, currency: "EUR" };
    expect(
      statusOf(
        [clause("max", "lines_max", { count: 2 }), clause("min", "lines_min", { count: 3 }), clause("fleet", "fleet_max", { vehicles: 3 }), clause("budget", "budget_max", { amount: 1000000 })],
        { operations: ops },
      ),
    ).toEqual({ max: "pass", min: "fail", fleet: "fail", budget: "pass" });
    // Without an operations estimate the caps cannot be told: unknown, not pass.
    expect(statusOf([clause("fleet", "fleet_max", { vehicles: 3 })]).fleet).toBe("unknown");
  });

  test("a waived clause is neither pass nor fail, and the summary says so", () => {
    const v = verdictOf([clause("sun", "days", { line: "A", days: ["sunday"] }, { status: "waived", reason: "budget" }), clause("a", "line_exists", { line: "A" })]);
    expect(v.results[0].status).toBe("waived");
    expect(v.summary).toMatchObject({ must: { total: 1, pass: 1, fail: 0 }, waived: 1 });
    expect(v.conforms).toBe(true);
  });

  test("old briefs: lines_requested becomes line_exists / termini / via clauses", () => {
    const v = C.checkConformance(spec, { lines_requested: [{ name: "A", from: "Gare", to: "Hôpital", via: ["Mairie"] }, { name: "B", from: "Gare", to: "Stade" }] });
    const byId = Object.fromEntries(v.results.map((r) => [r.id, r.status]));
    expect(byId).toEqual({ req_a_exists: "pass", req_a_termini: "pass", req_a_via: "pass", req_b_exists: "fail", req_b_termini: "fail" });
    expect(v.conforms).toBe(false);
  });
});

describe("typical trips on the compiled timetable", () => {
  let tables;
  beforeAll(async () => {
    tables = (await compileSpec(spec, { router: createRouter({ mode: "straight" }), shapes: false })).tables;
  });

  test("depart_at and arrive_by, walk included; no connection is a failure", () => {
    const r = verdictOf(
      [
        clause("gh", "od_max_time", { from: "Gare SNCF", to: "Hôpital Bretonneau", depart_at: "07:55", max_minutes: 20 }),
        clause("gh_tight", "od_max_time", { from: "Gare SNCF", to: "Hôpital Bretonneau", depart_at: "07:55", max_minutes: 3 }),
        clause("school", "od_max_time", { from: "Gare SNCF", to: "Lycée Balzac", arrive_by: "08:00", max_minutes: 30 }),
        clause("sunday", "od_max_time", { from: "Gare SNCF", to: "Lycée Balzac", day: "sunday", depart_at: "10:00", max_minutes: 60 }),
      ],
      { tables },
    ).results;
    const byId = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(byId.gh.status).toBe("pass");
    expect(byId.gh_tight.status).toBe("fail");
    expect(byId.school.status).toBe("pass");
    expect(byId.school.measured).toMatch(/leave 07:/);
    expect(byId.sunday).toMatchObject({ status: "fail", measured: "no connection" });
  });

  test("without a compiled timetable a trip is unknown, never passed", () => {
    expect(statusOf([clause("gh", "od_max_time", { from: "Gare SNCF", to: "Hôpital Bretonneau", max_minutes: 20 })]).gh).toBe("unknown");
  });
});

describe("the record of the brief", () => {
  test("clauses merge by id; the model never overturns the user's decision", () => {
    const prev = [
      { id: "sun", kind: "days", level: "must", status: "waived", decided_by: "user", reason: "no budget", params: { days: ["sunday"] } },
      { id: "peak", kind: "headway_max", level: "must", status: "stated", params: { minutes: 10 } },
      { id: "old", kind: "line_exists", level: "must", status: "stated", params: { line: "X" } },
    ];
    const merged = C.mergeClauses(prev, [{ id: "sun", kind: "days", level: "must", status: "stated", params: { days: ["sunday"] } }, { id: "peak", kind: "headway_max", params: { minutes: 8 } }, { id: "new", kind: "lines_max", params: { count: 5 } }, { id: "bad", kind: "nonsense", params: {} }], ["old"]);
    const byId = Object.fromEntries(merged.map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(["new", "peak", "sun"]);
    expect(byId.sun).toMatchObject({ status: "waived", decided_by: "user", reason: "no budget" });
    expect(byId.peak.params.minutes).toBe(8);
  });

  test("a clause sent again without an id upserts itself; it never overwrites another", () => {
    const first = C.mergeClauses([], [{ kind: "lines_max", params: { count: 3 } }]);
    const again = C.mergeClauses(first, [{ kind: "lines_max", params: { count: 3 } }, { kind: "lines_min", params: { count: 2 } }]);
    expect(again).toHaveLength(2);
    expect(again[0].id).toBe(first[0].id);
    const named = C.mergeClauses([{ id: "lines_max_2", kind: "lines_max", params: { count: 9 } }], [{ kind: "lines_max", params: { count: 3 } }]);
    expect(named.map((c) => c.params.count).sort()).toEqual([3, 9]);
  });

  test("a clause on span or days lifts the generic finding it contradicts", () => {
    // Line A without its Saturday service: the generic norm wants one, the brief says none.
    const weekdayOnly = normalizeSpec({ ...RAW, lines: [{ ...RAW.lines[0], services: [RAW.lines[0].services[0]] }] }).spec;
    const report = design.evaluatePlan(weekdayOnly, {});
    const codes = (r) => r.dimensions.flatMap((d) => d.findings.map((f) => `${f.code}:${f.line || ""}`));
    expect(codes(report)).toContain("no_saturday:A");
    const lifted = C.liftGenericFindings(report, { clauses: [clause("s_week", "no_service", { line: "A", days: ["saturday", "sunday"] })] }, weekdayOnly);
    expect(codes(lifted)).not.toContain("no_saturday:A");
    expect(lifted.lifted_by_brief).toEqual([expect.objectContaining({ code: "no_saturday", clause: "s_week" })]);
  });
});

describe("the verdict travels", () => {
  const requirements = { clauses: [clause("a", "line_exists", { line: "A" }), clause("peak5", "headway_max", { line: "A", day: "weekday", from: "07:00", to: "09:00", minutes: 5 }), clause("gh", "od_max_time", { from: "Gare SNCF", to: "Hôpital Bretonneau", depart_at: "07:55", max_minutes: 20 })] };

  test("POST /network/evaluate returns the conformance with the quality report", async () => {
    const res = await request(app).post("/gtfs/network/evaluate").send({ spec: RAW, requirements });
    expect(res.status).toBe(200);
    expect(res.body.conformance.summary.must).toMatchObject({ total: 3, pass: 2, fail: 1 });
    expect(res.body.conformance.conforms).toBe(false);
  });

  test("the built network's report carries the verdict on the real timetable", async () => {
    const res = await request(app).post("/gtfs/network/compile").send({ spec: RAW, options: { routing: "straight", requirements } });
    expect(res.status).toBe(201);
    const c = res.body.report.conformance;
    expect(Object.fromEntries(c.results.map((r) => [r.id, r.status]))).toEqual({ a: "pass", peak5: "fail", gh: "pass" });
    // The built feed measured like any other: quality, fewest vehicles, consumer checks.
    const b = res.body.report.built;
    expect(b.score).toBeGreaterThan(0);
    expect(b.grade).toMatch(/^[A-E]$/);
    expect(b.lines.length).toBeGreaterThan(0);
    expect(b.fleet.vehicles).toBeGreaterThan(0);
    expect(b.fleet.vehicles_line_by_line).toBeGreaterThanOrEqual(b.fleet.vehicles);
    expect(Array.isArray(b.checks)).toBe(true);
  });
});
