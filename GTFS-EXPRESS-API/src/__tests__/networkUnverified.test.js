/**
 * networkUnverified.test.js — when the validator cannot run (JVM down, JAR
 * missing), a network built by the Studio is "unverified": the session
 * meta, the build's answer and its report say so; nothing claims it valid.
 */

"use strict";

process.env.BETA_GATE_DISABLED = "true";

jest.mock("../services/canonicalValidatorService", () => {
  const actual = jest.requireActual("../services/canonicalValidatorService");
  return { ...actual, validateWithCanonical: async () => { throw new Error("JVM unavailable"); } };
});

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const app = require("../app");
const { removeUploadRoot } = require("./_helpers/sampleSession");
const connection = require("../services/db/connection");
const { GTFS_UPLOAD_DIR } = require("../services/sessionManager");

afterAll(() => {
  connection.closeAllDbHandles?.();
  removeUploadRoot();
});

test("a build whose validation failed is unverified, not valid", async () => {
  const SPEC = {
    agency: { name: "Sans Validateur", url: "https://sv.example", timezone: "Europe/Paris" },
    stops: [{ id: "a", name: "Centre", lat: 47.0, lon: 1.0 }, { id: "b", name: "Gare", lat: 47.0, lon: 1.03 }],
    lines: [{ short_name: "A", directions: [{ stops: ["a", "b"] }], services: [{ calendar: "weekday", departures: ["08:00"] }] }],
  };
  const res = await request(app).post("/gtfs/network/compile").send({ spec: SPEC, options: { routing: "straight" } });
  expect(res.status).toBe(201);
  expect(res.body.validationReport).toMatchObject({ valid: null, unverified: true });
  expect(res.body.report.validation).toMatchObject({ valid: null, unverified: true });
  const meta = JSON.parse(fs.readFileSync(path.join(GTFS_UPLOAD_DIR, res.body.sessionId, "_session_meta.json"), "utf8"));
  expect(meta.compliance).toBe("unverified");
  expect(meta.validation.unverified).toBe(true);
});
