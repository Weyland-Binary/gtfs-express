/**
 * uploadRescue.test.js — rescue flow for broken feeds.
 *
 * A feed that FAILS canonical validation (ERROR-severity findings) must be
 * ACCEPTED at upload: the session is created, the feed is migrated to SQLite
 * and marked non-compliant in _session_meta.json. Only the export preflight
 * keeps gating on errors (HTTP 422). Rejecting at upload would turn away the
 * exact user the product exists for — someone with a broken feed to fix.
 *
 * The canonical validator is mocked: these are pipeline-contract tests, the
 * real JAR is exercised by the canonical-integration CI job.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-rescue-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.IP_HASH_SECRET = "test-rescue";
process.env.BETA_GATE_DISABLED = "true";

jest.mock("../services/canonicalValidatorService", () => {
  const actual = jest.requireActual("../services/canonicalValidatorService");
  return { ...actual, validateWithCanonical: jest.fn() };
});

const request = require("supertest");
const archiver = require("archiver");
const app = require("../app");
const {
  validateWithCanonical,
} = require("../services/canonicalValidatorService");

const SAMPLE_DIR = path.join(__dirname, "..", "..", "sample");

const INVALID_REPORT = {
  valid: false,
  errors: {
    "stops.txt": [
      {
        ruleCode: "invalid_url",
        severity: "error",
        message: "stop_url is not a valid URL",
        entityType: "stop",
        entityId: "S1",
      },
    ],
  },
  counts: { errors: 1, warnings: 0, infos: 0 },
  profile: "canonical",
  engine: "mobilitydata-canonical",
};

const VALID_REPORT = {
  valid: true,
  errors: {},
  counts: { errors: 0, warnings: 0, infos: 0 },
  profile: "canonical",
  engine: "mobilitydata-canonical",
};

// The bundled sample feed is structurally migrable, which is exactly the
// rescue-flow contract: canonical findings do not prevent the SQLite load.
const buildSampleZip = () =>
  new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 0 } });
    const chunks = [];
    archive.on("data", (c) => chunks.push(c));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);
    for (const f of fs.readdirSync(SAMPLE_DIR)) {
      archive.file(path.join(SAMPLE_DIR, f), { name: f });
    }
    archive.finalize();
  });

const uploadSample = async () => {
  const buf = await buildSampleZip();
  return request(app).post("/gtfs/upload").attach("gtfsZip", buf, {
    filename: "feed.zip",
    contentType: "application/zip",
  });
};

const readMeta = async (sessionId) =>
  JSON.parse(
    await fsp.readFile(
      path.join(TEST_UPLOAD_ROOT, sessionId, "_session_meta.json"),
      "utf8",
    ),
  );

describe("upload rescue flow (non-compliant feeds are accepted)", () => {
  afterAll(() => {
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("feed with canonical ERRORs → 200, session created, marked non_compliant", async () => {
    validateWithCanonical.mockResolvedValue(INVALID_REPORT);

    const res = await uploadSample();
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(res.body.validationReport.counts.errors).toBe(1);
    expect(res.body.validationReport.errors["stops.txt"]).toHaveLength(1);

    const sessionId = res.body.sessionId;
    const folder = path.join(TEST_UPLOAD_ROOT, sessionId);
    expect(fs.existsSync(folder)).toBe(true);
    // The feed was migrated to SQLite despite the findings: the session is
    // immediately explorable and repairable.
    expect(fs.existsSync(path.join(folder, "gtfs.db"))).toBe(true);

    const meta = await readMeta(sessionId);
    expect(meta.compliance).toBe("non_compliant");
    expect(meta.validation.errors_count).toBe(1);
  });

  test("read endpoints work on a non-compliant session", async () => {
    validateWithCanonical.mockResolvedValue(INVALID_REPORT);
    const up = await uploadSample();
    expect(up.status).toBe(200);

    const res = await request(app)
      .get("/gtfs/agencies")
      .set("X-Session-ID", up.body.sessionId);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test("export of a non-compliant session stays blocked with 422", async () => {
    validateWithCanonical.mockResolvedValue(INVALID_REPORT);
    const up = await uploadSample();
    expect(up.status).toBe(200);
    const sessionId = up.body.sessionId;

    const enter = await request(app)
      .post("/gtfs/edit/enter")
      .set("X-Session-ID", sessionId);
    expect(enter.status).toBe(200);

    const exp = await request(app)
      .get("/gtfs/edit/export")
      .set("X-Session-ID", sessionId);
    expect(exp.status).toBe(422);
    expect(exp.body.errorCount).toBe(1);
    expect(exp.body.report).toBeDefined();
  });

  test("clean feed → 200, valid:true, marked compliant", async () => {
    validateWithCanonical.mockResolvedValue(VALID_REPORT);

    const res = await uploadSample();
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);

    const meta = await readMeta(res.body.sessionId);
    expect(meta.compliance).toBe("compliant");
    expect(meta.validation.errors_count).toBe(0);
  });
});
