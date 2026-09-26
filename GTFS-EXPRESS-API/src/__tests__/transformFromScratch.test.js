/**
 * transformFromScratch.test.js — the two ways of producing a network meet:
 * a network designed from scratch in the Network Studio (a spec compiled
 * into a GTFS session) is then changed like any existing feed — a plan
 * previewed, applied as one undoable edit, measured on the same yardstick
 * before and after, its riders told.
 */

"use strict";

process.env.BETA_GATE_DISABLED = "true";

const request = require("supertest");
const app = require("../app");
const { removeUploadRoot } = require("./_helpers/sampleSession");
const connection = require("../services/db/connection");

afterAll(() => {
  connection.closeAllDbHandles?.();
  removeUploadRoot();
});

const SPEC = {
  agency: { name: "Nouveau Réseau", url: "https://nouveau.example", timezone: "Europe/Paris" },
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

describe("designed from scratch, then changed", () => {
  test("compile → health → a change plan previewed, applied, undone, and its riders told", async () => {
    const built = await request(app).post("/gtfs/network/compile").send({ spec: SPEC, options: { routing: "straight" } });
    expect(built.status).toBe(201);
    const sid = built.body.sessionId;
    const api = {
      get: (p) => request(app).get(`/gtfs${p}`).set("X-Session-ID", sid),
      post: (p, body) => request(app).post(`/gtfs${p}`).set("X-Session-ID", sid).send(body),
    };
    // The built feed on the engine's yardstick, as the compile report says.
    const h0 = await api.get("/transform/quality");
    expect(h0.status).toBe(200);
    expect(h0.body.score).toBe(built.body.report.built.score);
    expect(h0.body.fleet.vehicles).toBe(built.body.report.built.fleet.vehicles);

    // A change the Studio's spec did not have: line A every 6 minutes at the morning peak from 5 October.
    const plan = { title: "A renforcée", operations: [{ id: "op1", type: "set_headway", params: { route: "A", days: "weekday", from_date: "2026-10-05", from: "07:00", to: "09:00", headway_min: 6 } }] };
    const pv = await api.post("/transform/preview", { plan });
    expect(pv.status).toBe(200);
    expect(pv.body.blocked).toBe(false);
    expect(pv.body.integrity).toEqual([]);
    expect(pv.body.impact.totals.km.delta).toBeGreaterThan(0);
    expect(pv.body.passenger[0]).toEqual(expect.objectContaining({ effect: "ADDITIONAL_SERVICE", open_ended: true }));
    expect(pv.body.passenger[0].period.from).toBe("20261005");

    expect((await api.post("/edit/enter", {})).status).toBe(200);
    const pv2 = await api.post("/transform/preview", { plan });
    const cm = await api.post("/transform/commit", { previewId: pv2.body.id });
    expect(cm.status).toBe(200);
    const h1 = await api.get("/transform/quality");
    expect(h1.body.fleet.vehicles).toBeGreaterThanOrEqual(h0.body.fleet.vehicles);
    const ov = await api.get("/transform/overview");
    const a = ov.body.routes.find((r) => r.short_name === "A");
    expect(a).toBeTruthy();

    // One undo takes the whole plan back.
    expect((await api.post("/edit/undo", {})).status).toBe(200);
    const h2 = await api.get("/transform/quality");
    expect(h2.body.fleet.vehicles).toBe(h0.body.fleet.vehicles);
    expect(h2.body.score).toBe(h0.body.score);
  });
});
