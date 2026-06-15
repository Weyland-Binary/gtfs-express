/**
 * uploadMigrationFlag.test.js — the upload-time SQLite migration is
 * best-effort, but its failure must be VISIBLE to the client: without
 * gtfs.db every read endpoint 4xxes and the landing page looks broken for
 * no reason (root cause of a Docker-only white screen: an /agencies error
 * envelope leaked into frontend state).
 *
 * Contract: 200 + migrationFailed:true + bounded migrationError when the
 * migration throws a generic error; migrationFailed:false on the happy path.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-migflag-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.IP_HASH_SECRET = "test-migflag";
process.env.BETA_GATE_DISABLED = "true";

jest.mock("../services/canonicalValidatorService", () => {
  const actual = jest.requireActual("../services/canonicalValidatorService");
  return {
    ...actual,
    validateWithCanonical: jest.fn().mockResolvedValue({
      valid: true,
      errors: {},
      counts: { errors: 0, warnings: 0, infos: 0 },
      profile: "canonical",
      engine: "mobilitydata-canonical",
    }),
  };
});

jest.mock("../services/editSession", () => {
  const actual = jest.requireActual("../services/editSession");
  return { ...actual, migrateUploadToDb: jest.fn(actual.migrateUploadToDb) };
});

const request = require("supertest");
const archiver = require("archiver");
const app = require("../app");
const { migrateUploadToDb } = require("../services/editSession");

const SAMPLE_DIR = path.join(__dirname, "..", "..", "sample");

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

describe("upload migration failure visibility", () => {
  afterAll(() => {
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("happy path: migrationFailed false, no error string", async () => {
    const res = await uploadSample();
    expect(res.status).toBe(200);
    expect(res.body.migrationFailed).toBe(false);
    expect(res.body.migrationError).toBeNull();
    expect(res.body.migration_ms).toBeGreaterThan(0);
  });

  test("generic migration error: upload still succeeds with a visible flag", async () => {
    migrateUploadToDb.mockRejectedValueOnce(
      new Error("SQLITE_IOERR: disk I/O error".padEnd(500, "x")),
    );
    const res = await uploadSample();
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    expect(res.body.migrationFailed).toBe(true);
    expect(res.body.migrationError).toContain("SQLITE_IOERR");
    // Bounded: never leak a full stack into the client payload.
    expect(res.body.migrationError.length).toBeLessThanOrEqual(300);
  });
});
