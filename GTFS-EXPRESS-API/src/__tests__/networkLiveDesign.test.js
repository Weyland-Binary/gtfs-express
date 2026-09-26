/**
 * networkLiveDesign.test.js — a designed network lives on after its build:
 * the chat reads the brief it answers (get_network_design), sees which
 * clauses an edit broke, the report re-measures the brief on the feed as it
 * is now (?live=1), and a proposal that touches designed stops says so.
 */

"use strict";

process.env.BETA_GATE_DISABLED = "true";

const request = require("supertest");
const app = require("../app");
const { removeUploadRoot } = require("./_helpers/sampleSession");
const connection = require("../services/db/connection");
const chatAgentTools = require("../services/chatAgentTools");
const liveDesign = require("../services/network/liveDesign");

afterAll(() => {
  connection.closeAllDbHandles?.();
  removeUploadRoot();
});

const SPEC = {
  agency: { name: "Vivant", url: "https://vivant.example", timezone: "Europe/Paris" },
  stops: [
    { id: "GARE", name: "Gare", lat: 47.4, lon: 0.69 },
    { id: "MAIRIE", name: "Mairie", lat: 47.405, lon: 0.695 },
    { id: "HOP", name: "Hôpital", lat: 47.41, lon: 0.7 },
    { id: "MAIRIE2", name: "Mairie annexe", lat: 47.4051, lon: 0.6951 },
  ],
  lines: [
    { short_name: "A", directions: [{ stops: ["GARE", "MAIRIE", "HOP"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 15 }] }] },
    { short_name: "B", directions: [{ stops: ["GARE", "MAIRIE2"] }], services: [{ calendar: "weekday", departures: ["08:00", "17:00"] }] },
  ],
};
const REQUIREMENTS = {
  operator: "Vivant",
  area: "Tours",
  objectives: ["relier la gare à l'hôpital"],
  clauses: [
    { id: "A_exists", kind: "line_exists", level: "must", params: { line: "A" } },
    { id: "A_hop", kind: "via", level: "must", params: { line: "A", stops: ["Hôpital"] } },
    { id: "A_15", kind: "headway_max", level: "must", params: { line: "A", day: "weekday", from: "07:00", to: "09:00", minutes: 15 } },
  ],
};

let sessionId;
const toolCtx = () => {
  const events = [];
  const ctx = chatAgentTools.createToolContext({ dbCtx: { db: connection.ensureDbHandle(sessionId), sessionId }, emit: (e, d) => events.push({ e, d }) });
  return { ctx, events };
};

beforeAll(async () => {
  const res = await request(app).post("/gtfs/network/compile").send({ spec: SPEC, options: { routing: "straight", requirements: REQUIREMENTS } });
  expect(res.status).toBe(201);
  sessionId = res.body.sessionId;
});

test("get_network_design: the brief, its verdict at build and now", () => {
  const { ctx } = toolCtx();
  const out = JSON.parse(chatAgentTools.executeTool("get_network_design", {}, ctx).content);
  expect(out.objectives).toEqual(["relier la gare à l'hôpital"]);
  expect(out.brief_at_build.summary.must).toMatchObject({ total: 3, pass: 3 });
  expect(out.brief_now.summary.must).toMatchObject({ total: 3, pass: 3 });
  expect(out.brief_now.approximate).toBe(true);
  expect(out.regressions).toEqual([]);
});

test("an edit that removes the hospital from line A is reported as a regression", () => {
  const db = connection.ensureDbHandle(sessionId);
  db.prepare("DELETE FROM stop_times WHERE stop_id = 'HOP'").run();
  liveDesign._internals._cache.clear();
  const { ctx } = toolCtx();
  const out = JSON.parse(chatAgentTools.executeTool("get_network_design", {}, ctx).content);
  expect(out.brief_now.summary.must.fail).toBeGreaterThanOrEqual(1);
  expect(out.regressions.join(" ")).toMatch(/A_hop/);
  expect(out.note).toMatch(/broke/);
});

test("GET /network/report?live=1 re-measures the brief on the current feed", async () => {
  const res = await request(app).get("/gtfs/network/report?live=1").set("X-Session-ID", sessionId);
  expect(res.status).toBe(200);
  expect(res.body.conformance.summary.must.pass).toBe(3); // at build
  expect(res.body.live.conformance.summary.must.fail).toBeGreaterThanOrEqual(1); // now
  const plain = await request(app).get("/gtfs/network/report").set("X-Session-ID", sessionId);
  expect(plain.body.live).toBeUndefined();
});

test("a merge touching designed stops is flagged and kept out of 'apply all'", () => {
  const { ctx, events } = toolCtx();
  const res = chatAgentTools.executeTool("merge_stops", { survivor_id: "MAIRIE", duplicate_ids: ["MAIRIE2"] }, ctx);
  expect(res.isError).toBeFalsy();
  expect(res.content).toMatch(/DESIGNED NETWORK/);
  expect(events.find((x) => x.e === "proposal").d.touchesDesign).toBe(true);
});

test("the chat's context says the feed was designed from a brief", () => {
  const block = liveDesign.designBlock(sessionId);
  expect(block).toMatch(/\[Network design\]/);
  expect(block).toMatch(/Brief at build: 3\/3/);
  expect(block).toMatch(/relier la gare/);
});

test("an uploaded feed has no design", () => {
  expect(liveDesign.loadDesign("00000000-0000-4000-8000-000000000000")).toBeNull();
});
