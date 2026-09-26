/**
 * networkSpecPatch.test.js — targeted edits of a Network Spec: each
 * operation, a rejected one leaving no half-change, the diff between two
 * specs, and the compact view the planner reads for large networks.
 */

"use strict";

const { normalizeSpec } = require("../services/network/networkSpec");
const P = require("../services/network/specPatch");

const base = normalizeSpec({
  agency: { name: "Patch", url: "https://patch.example", timezone: "Europe/Paris" },
  stops: [
    { id: "A", name: "Gare", lat: 47.4, lon: 0.69 },
    { id: "B", name: "Centre", lat: 47.41, lon: 0.7 },
    { id: "C", name: "Hôpital", lat: 47.42, lon: 0.71 },
  ],
  lines: [
    { short_name: "1", directions: [{ stops: ["A", "B", "C"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 20 }] }] },
    { short_name: "2", directions: [{ stops: ["A", "C"] }], services: [{ calendar: "weekday", departures: ["08:00", "17:00"] }] },
  ],
}).spec;
const apply = (ops) => {
  const r = P.applyPatch(base, ops);
  return { ...r, norm: normalizeSpec(r.spec) };
};

test("insert a stop after another: the outbound changes, the return is derived again, line 2 untouched", () => {
  const { norm, applied } = apply([{ op: "insert_stop", line: "1", stop: { name: "Mairie", lat: 47.405, lon: 0.695 }, after: "A" }]);
  expect(applied).toHaveLength(1);
  const l1 = norm.spec.lines.find((l) => l.short_name === "1");
  expect(l1.directions[0].stops).toEqual(["A", "MAIRIE", "B", "C"]);
  expect(l1.directions[1]).toMatchObject({ stops: ["C", "B", "MAIRIE", "A"], derived: true });
  expect(norm.spec.lines.find((l) => l.short_name === "2")).toEqual(base.lines.find((l) => l.short_name === "2"));
  const d = P.diff(base, norm.spec);
  expect(d).toMatchObject({ lines_changed: ["1"], stops_added: ["MAIRIE"], lines_added: [], lines_removed: [] });
});

test("upsert a line's service only; remove a line; set a setting", () => {
  const { norm } = apply([
    { op: "upsert_lines", lines: [{ short_name: "1", services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 10 }] }] }] },
    { op: "remove_lines", ids: ["2"] },
    { op: "set", field: "operations", value: { max_vehicles: 5 } },
  ]);
  expect(norm.spec.lines.map((l) => l.short_name)).toEqual(["1"]);
  expect(norm.spec.lines[0].services[0].periods[0].headway_min).toBe(10);
  expect(norm.spec.lines[0].directions[0].stops).toEqual(["A", "B", "C"]);
  expect(norm.spec.operations).toEqual({ max_vehicles: 5 });
  expect(P.summarizeDiff(P.diff(base, norm.spec))).toMatch(/lines removed: 2; lines changed: 1; settings changed: operations/);
});

test("stops: upsert by id or name, remove from every line", () => {
  const { norm } = apply([
    { op: "upsert_stops", stops: [{ id: "B", lat: 47.411 }, { name: "Hôpital", code: "HOP" }, { name: "Stade", lat: 47.43, lon: 0.72 }] },
    { op: "remove_stops", ids: ["B"] },
  ]);
  expect(norm.spec.stops.map((s) => s.id)).toEqual(["A", "C", "STADE"]);
  expect(norm.spec.stops.find((s) => s.id === "C").code).toBe("HOP");
  expect(norm.spec.lines[0].directions[0].stops).toEqual(["A", "C"]);
});

test("a rejected op is skipped whole and reported; the others apply", () => {
  const { applied, rejected, norm } = apply([
    { op: "insert_stop", line: "9", stop: "B" },
    { op: "insert_stop", line: "2", stop: "B", after: "Nowhere" },
    { op: "explode" },
    { op: "set", field: "lines", value: [] },
    { op: "insert_stop", line: "2", stop: "B", before: "C" },
  ]);
  expect(rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/no line/), expect.stringMatching(/anchor/), expect.stringMatching(/unknown op/), expect.stringMatching(/field must be/)]);
  expect(applied).toEqual([{ index: 4, op: "insert_stop" }]);
  expect(norm.spec.lines.find((l) => l.short_name === "2").directions[0].stops).toEqual(["A", "B", "C"]);
});

test("the compact view drops derived returns and summarises long departure lists only when needed", () => {
  const small = P.compactSpec(base);
  expect(JSON.parse(small).lines[0].directions).toHaveLength(1);
  const many = normalizeSpec({ ...base, lines: [{ ...base.lines[1], services: [{ calendar: "weekday", departures: Array.from({ length: 300 }, (_, i) => `${String(5 + Math.floor(i / 20)).padStart(2, "0")}:${String((i * 3) % 60).padStart(2, "0")}`) }] }] }).spec;
  const view = P.compactSpec(many, 2000);
  expect(view.length).toBeLessThan(4000);
  expect(view).toMatch(/departures .*get_spec/);
});
