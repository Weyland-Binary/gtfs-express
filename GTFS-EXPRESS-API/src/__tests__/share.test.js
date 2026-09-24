/**
 * share.test.js — public shares: a snapshot of a session's feed behind a
 * token, its card (counts, validation, design quality when the feed came
 * from the studio), opening it as a fresh session, the hosted zip, expiry
 * and cleanup.
 */

"use strict";

process.env.BETA_GATE_DISABLED = "true";

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../app");
const { removeUploadRoot } = require("./_helpers/sampleSession");
const connection = require("../services/db/connection");
const share = require("../services/shareService");

const SPEC = {
  agency: { name: "Partage Mobilités", url: "https://partage.example", timezone: "Europe/Paris" },
  stops: [{ id: "a", name: "Centre", lat: 47.0, lon: 1.0 }, { id: "b", name: "Gare", lat: 47.0, lon: 1.03 }, { id: "c", name: "Hôpital", lat: 47.02, lon: 1.0 }],
  lines: [
    { short_name: "A", mode: "bus", directions: [{ headsign: "Gare", stops: ["a", "b"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 20 }] }] },
    { short_name: "B", mode: "bus", directions: [{ headsign: "Hôpital", stops: ["a", "c"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 30 }] }] },
  ],
};

afterAll(() => {
  connection.closeAllDbHandles?.();
  fs.rmSync(share.SHARES_DIR, { recursive: true, force: true });
  removeUploadRoot();
});

describe("shares", () => {
  let sessionId;
  let token;

  test("a built network becomes a share with a card", async () => {
    const built = await request(app).post("/gtfs/network/compile").send({ spec: SPEC, options: { routing: "straight" } });
    expect(built.status).toBe(201);
    sessionId = built.body.sessionId;
    const res = await request(app).post("/gtfs/share").set("X-Session-ID", sessionId).send({ title: "Réseau de démonstration" });
    expect(res.status).toBe(201);
    token = res.body.token;
    expect(token).toMatch(/^[a-f0-9]{20}$/);
    expect(res.body.card).toMatchObject({ title: "Réseau de démonstration", agency: "Partage Mobilités", source: "network_studio", counts: { routes: 2, stops: 3 } });
    expect(res.body.card.design.score).toBeGreaterThan(0);
    expect(res.body.card.design.dimensions).toHaveLength(7);
    expect(res.body.card.design.operations.fleet_total).toBeGreaterThan(0);
    expect(res.body.card.validation).toMatchObject({ errors: expect.any(Number) });
    expect(res.body.card.audit).toMatchObject({ warning: expect.any(Number), info: expect.any(Number) });
    expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now() + 80 * 86400000);
    expect(fs.existsSync(path.join(share.SHARES_DIR, token, "stop_times.txt"))).toBe(true);
    expect(fs.existsSync(path.join(share.SHARES_DIR, token, "_network_report.json"))).toBe(true);
  });

  test("the card is public; an unknown token is a 404", async () => {
    const res = await request(app).get(`/gtfs/share/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("Réseau de démonstration");
    expect(res.body.opens).toBe(0);
    const none = await request(app).get("/gtfs/share/0123456789abcdef0123");
    expect(none.status).toBe(404);
    const bad = await request(app).get("/gtfs/share/not-a-token");
    expect(bad.status).toBe(404);
  });

  test("opening a share creates a fresh session from the snapshot; the zip serves the feed", async () => {
    const res = await request(app).post(`/gtfs/share/${token}/open`);
    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.sessionId).not.toBe(sessionId);
    expect(res.body.counts.routes).toBe(2);
    expect(res.body.share.title).toBe("Réseau de démonstration");
    const agencies = await request(app).get("/gtfs/agencies").set("X-Session-ID", res.body.sessionId);
    expect(agencies.status).toBe(200);
    expect(JSON.stringify(agencies.body)).toMatch(/Partage Mobilités/);
    const card = await request(app).get(`/gtfs/share/${token}`);
    expect(card.body.opens).toBe(1);
    const zip = await request(app).get(`/gtfs/share/${token}/gtfs.zip`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(zip.status).toBe(200);
    expect(zip.headers["content-type"]).toMatch(/application\/zip/);
    expect(zip.body.slice(0, 2).toString()).toBe("PK");
    expect(zip.body.length).toBeGreaterThan(500);
  });

  test("an edited session is shared in its edited state", async () => {
    const enter = await request(app).post("/gtfs/edit/enter").set("X-Session-ID", sessionId).send({});
    expect([200, 201]).toContain(enter.status);
    const rename = await request(app).patch("/gtfs/edit/stops/a").set("X-Session-ID", sessionId).send({ stop_name: "Centre-ville" });
    expect(rename.status).toBe(200);
    const res = await request(app).post("/gtfs/share").set("X-Session-ID", sessionId).send({});
    expect(res.status).toBe(201);
    const stops = fs.readFileSync(path.join(share.SHARES_DIR, res.body.token, "stops.txt"), "utf8");
    expect(stops).toMatch(/Centre-ville/);
    expect(res.body.card.title).toBe("Partage Mobilités");
  });

  test("expired shares disappear at cleanup", async () => {
    const dir = path.join(share.SHARES_DIR, "ffffffffffffffffffff");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "_share.json"), JSON.stringify({ token: "ffffffffffffffffffff", expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(share.readShare("ffffffffffffffffffff")).toBeNull();
    const removed = await share.cleanupExpiredShares();
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(dir)).toBe(false);
    expect(share.readShare(token)).not.toBeNull();
    const missing = await request(app).post("/gtfs/share").set("X-Session-ID", "00000000-0000-4000-8000-000000000000").send({});
    expect(missing.status).toBe(404);
  });
});
