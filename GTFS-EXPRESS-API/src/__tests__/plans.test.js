/**
 * plans.test.js — the offer endpoint and the plan-based network cap: an
 * anonymous caller is Free, a valid code with a tier maps to Pro/Team, an
 * invalid code stays Free, and /network/validate reports the cap.
 */

"use strict";

process.env.NODE_ENV = "test";
process.env.BETA_GATE_DISABLED = "false";
process.env.IP_HASH_SECRET = "test-plans";

const fs = require("fs");
const os = require("os");
const path = require("path");

const codesPath = path.join(os.tmpdir(), `gtfs-plans-codes-${process.pid}.json`);
fs.writeFileSync(
  codesPath,
  JSON.stringify({
    "PROP-ROPR-OPRO": { email: "pro@example.com", tier: "pro" },
    "TEAM-TEAM-TEAM": { email: "team@example.com", tier: "team" },
    "BETA-BETA-BETA": { email: "beta@example.com" },
    "GONE-GONE-GONE": { email: "gone@example.com", revoked: true },
  }),
  "utf8",
);
process.env.BETA_CODES_PATH = codesPath;
process.env.BETA_USAGE_PATH = path.join(os.tmpdir(), `gtfs-plans-usage-${process.pid}.jsonl`);

const request = require("supertest");
const app = require("../app");
const { resolvePlan, limitsFor } = require("../services/plansService");

afterAll(() => {
  try {
    fs.unlinkSync(codesPath);
  } catch {
    /* gone */
  }
});

const SPEC = (lines) => ({
  agency: { name: "X", url: "https://x.example", timezone: "Europe/Paris" },
  stops: [{ id: "A", name: "A", lat: 47, lon: 0.6 }, { id: "B", name: "B", lat: 47.01, lon: 0.61 }],
  lines: Array.from({ length: lines }, (_, i) => ({ short_name: String(i + 1), stops: ["A", "B"], services: [{ calendar: "weekday", departures: ["08:00"] }] })),
});

describe("plans", () => {
  test("GET /config/plans lists the catalogue and resolves the caller's plan", async () => {
    const anon = await request(app).get("/gtfs/config/plans");
    expect(anon.status).toBe(200);
    expect(anon.body.plans.map((p) => p.id)).toEqual(["free", "pro", "team"]);
    expect(anon.body.current).toMatchObject({ name: "free", source: "anonymous" });
    expect(anon.body.current.limits.network_lines).toBe(3);
    expect(anon.body.billing_enabled).toBe(false);
    const pro = await request(app).get("/gtfs/config/plans").set("X-Beta-Code", "PROP-ROPR-OPRO");
    expect(pro.body.current).toMatchObject({ name: "pro", source: "code", tier: "pro" });
    expect(pro.body.current.limits.network_lines).toBe(40);
    const team = await request(app).get("/gtfs/config/plans").set("X-Beta-Code", "TEAM-TEAM-TEAM");
    expect(team.body.current.name).toBe("team");
    const beta = await request(app).get("/gtfs/config/plans").set("X-Beta-Code", "beta beta beta");
    expect(beta.body.current).toMatchObject({ name: "pro", tier: "beta" });
    const bad = await request(app).get("/gtfs/config/plans").set("X-Beta-Code", "NOPE-NOPE-NOPE");
    expect(bad.body.current).toMatchObject({ name: "free", source: "invalid_code", error: "INVALID_BETA_CODE" });
    const gone = await request(app).get("/gtfs/config/plans").set("X-Beta-Code", "GONE-GONE-GONE");
    expect(gone.body.current).toMatchObject({ name: "free", error: "BETA_REVOKED" });
  });

  test("the network cap follows the plan", async () => {
    const four = SPEC(4);
    const anon = await request(app).post("/gtfs/network/validate").send({ spec: four });
    expect(anon.body.plan).toMatchObject({ name: "free", max_lines: 3, over_limit: true });
    expect(anon.body.ok).toBe(false);
    const pro = await request(app).post("/gtfs/network/validate").set("X-Beta-Code", "PROP-ROPR-OPRO").send({ spec: four });
    expect(pro.body.plan).toMatchObject({ name: "pro", max_lines: 40, over_limit: false });
    expect(pro.body.ok).toBe(true);
    const capped = await request(app).post("/gtfs/network/compile").send({ spec: four, options: { routing: "straight" } });
    expect(capped.status).toBe(402);
    expect(capped.body.plan.name).toBe("free");
    expect(limitsFor("team").network_lines).toBe(80);
    expect(resolvePlan({ headers: {} }).name).toBe("free");
  });

  test("GET /config/features exposes the free cap", async () => {
    const res = await request(app).get("/gtfs/config/features");
    expect(res.body.plans).toEqual({ freeMaxLines: 3, billingEnabled: false });
  });
});
