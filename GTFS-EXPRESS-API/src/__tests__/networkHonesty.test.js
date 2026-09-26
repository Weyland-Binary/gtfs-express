/**
 * networkHonesty.test.js — measures that never claim more than they know,
 * and downloads that cannot reach the server's own network:
 *   - user/model URLs (catalog import, realtime check) are refused when they
 *     point at a private, loopback, link-local or metadata address;
 *   - a share of a Studio network carries the design, not the author's
 *     private brief (budget and fleet caps, constraints, assumptions);
 *   - a routing fallback (straight lines) is never cached;
 *   - a validator that did not run leaves the build "unverified".
 */

"use strict";

process.env.BETA_GATE_DISABLED = "true";
process.env.SHARES_DIR = require("path").join(require("os").tmpdir(), `gtfs-shares-honesty-${process.pid}`);

const fs = require("fs");
const http = require("http");
const path = require("path");
const request = require("supertest");
const app = require("../app");
const { removeUploadRoot } = require("./_helpers/sampleSession");
const connection = require("../services/db/connection");
const share = require("../services/shareService");
const { safeFetch, assertPublicUrl, isPrivateAddress, _internals: sf } = require("../utils/safeFetch");
const { createRouter, _internals: routerInternals } = require("../services/network/roadRouter");
const { _internals: compilerInternals } = require("../services/network/compiler");

afterAll(() => {
  connection.closeAllDbHandles?.();
  fs.rmSync(share.SHARES_DIR, { recursive: true, force: true });
  removeUploadRoot();
});

describe("safeFetch: public internet only", () => {
  test("private, loopback, link-local, metadata and reserved addresses are recognised", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    for (const ip of ["8.8.8.8", "151.101.1.1", "2a00:1450:4007::1"]) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
  });

  test("URLs are refused by scheme, credentials, port, literal address or local name", () => {
    const bad = ["file:///etc/passwd", "ftp://x.org/a", "http://user:pw@x.org/", "http://x.org:22/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "http://localhost:3004/", "http://db.internal/", "http://intranet/"];
    for (const u of bad) expect(() => assertPublicUrl(u)).toThrow(expect.objectContaining({ code: "URL_NOT_ALLOWED" }));
    expect(assertPublicUrl("https://transport.data.gouv.fr/resources/1/download").hostname).toBe("transport.data.gouv.fr");
    expect(assertPublicUrl("http://feeds.example.org:8080/gtfs.zip").port).toBe("8080");
  });

  test("the socket lookup refuses a name resolving to a private address", (done) => {
    sf.guardedLookup("localhost", {}, (err) => {
      expect(err && err.code).toBe("URL_NOT_ALLOWED");
      done();
    });
  });

  test("a live server on loopback is never reached", async () => {
    let hits = 0;
    const server = http.createServer((req, res) => {
      hits += 1;
      res.end("secret");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    await expect(safeFetch(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: "URL_NOT_ALLOWED" });
    await new Promise((r) => server.close(r));
    expect(hits).toBe(0);
  });

  test("POST /network/catalog/import refuses the metadata endpoint", async () => {
    const res = await request(app).post("/gtfs/network/catalog/import").send({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("URL_NOT_ALLOWED");
  });
});

describe("shares carry the design, not the private brief", () => {
  test("publicSpec drops the operating figures; publicReport keeps objectives, drops caps and constraints", () => {
    const { publicSpec, publicReport } = share._internals;
    const spec = publicSpec({ spec: { agency: { name: "X" }, lines: [], operations: { max_cost_year: 1900000, max_vehicles: 12, cost_per_km: 4.2 } }, savedAt: "t" });
    expect(spec.spec.operations).toBeUndefined();
    expect(spec.spec.agency.name).toBe("X");
    const report = publicReport({
      requirements: { operator: "AOM", area: "Ville", objectives: ["serve the hospital"], constraints: ["budget 1.9 M€"], assumptions: [{ topic: "budget" }], open_questions: [{ id: "q" }] },
      design: {
        score: 70,
        operations: { fleet_total: 14, cost_year: 2100000, limits: { max_cost_year: 1900000 } },
        dimensions: [{ id: "compliance", findings: [{ level: "major", code: "budget_over", message: "budget is 1 900 000 €" }, { level: "info", code: "no_holidays", message: "x" }] }],
      },
    });
    expect(report.requirements).toEqual({ operator: "AOM", area: "Ville", objectives: ["serve the hospital"] });
    expect(report.design.operations.limits).toBeUndefined();
    expect(report.design.operations.fleet_total).toBe(14);
    expect(report.design.dimensions[0].findings.map((f) => f.code)).toEqual(["no_holidays"]);
  });

  test("a real share of a Studio network stores the sanitised files", async () => {
    const SPEC = {
      agency: { name: "Honnête Mobilités", url: "https://honnete.example", timezone: "Europe/Paris" },
      stops: [{ id: "a", name: "Centre", lat: 47.0, lon: 1.0 }, { id: "b", name: "Gare", lat: 47.0, lon: 1.03 }],
      lines: [{ short_name: "A", mode: "bus", directions: [{ headsign: "Gare", stops: ["a", "b"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 20 }] }] }],
      operations: { max_cost_year: 123456, max_vehicles: 3 },
    };
    const built = await request(app).post("/gtfs/network/compile").send({ spec: SPEC, options: { routing: "straight" } });
    expect(built.status).toBe(201);
    const res = await request(app).post("/gtfs/share").set("X-Session-ID", built.body.sessionId).send({ title: "Démo" });
    expect(res.status).toBe(201);
    const dir = path.join(share.SHARES_DIR, res.body.token);
    const storedSpec = JSON.parse(fs.readFileSync(path.join(dir, "_network_spec.json"), "utf8"));
    expect(storedSpec.spec.operations).toBeUndefined();
    const text = fs.readFileSync(path.join(dir, "_network_report.json"), "utf8");
    expect(text).not.toMatch(/123456|123 456/);
    // The card's validation comes from the session, at the right level of the meta.
    expect(res.body.card.validation).toMatchObject({ errors: expect.any(Number) });
  });
});

describe("routing fallbacks are not cached", () => {
  test("a failed router answer (straight legs) is retried on the next call", async () => {
    routerInternals._cache.clear();
    let calls = 0;
    const down = async () => {
      calls += 1;
      return { ok: false, status: 503, json: async () => ({}) };
    };
    const router = createRouter({ mode: "osrm", fetchImpl: down, baseUrl: "https://osrm.example" });
    const pts = [{ lat: 47, lon: 1 }, { lat: 47.01, lon: 1.01 }];
    const a = await router.route(pts);
    expect(a.fallbacks).toBe(1);
    await router.route(pts);
    expect(calls).toBe(2);
    expect(routerInternals._cache.size).toBe(0);
  });
});

describe("a validator that did not run", () => {
  test("is reported as unverified, never as valid", () => {
    expect(compilerInternals.validationSummary(null)).toMatchObject({ valid: null, unverified: true });
    expect(compilerInternals.validationSummary({ valid: null, unverified: true, counts: { errors: 0 } })).toMatchObject({ valid: null, unverified: true });
    expect(compilerInternals.validationSummary({ valid: true, counts: { errors: 0, warnings: 2 } })).toEqual({ errors: 0, warnings: 2, valid: true });
  });
});
