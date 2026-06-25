/**
 * uploadBrokenFeedTolerance.test.js — rescue tolerance of the upload-time
 * SQLite migration.
 *
 * Root cause of the Docker incident: a feed with duplicate_key findings
 * (duplicate calendar_dates PK) crashed the migration with 'UNIQUE
 * constraint failed' — the exact category of broken feed the rescue flow
 * exists to repair could not even be loaded. Same story for dangling
 * references (FK enforcement fired at COMMIT despite defer_foreign_keys).
 *
 * Contract under test:
 *   - duplicate-key rows are skipped (FIRST occurrence kept) and counted
 *     per table in the response's importAdjustments;
 *   - orphan rows (FK violations) are imported so the validator findings
 *     can be repaired in-app;
 *   - the session is fully usable (reads + edit mode) afterwards;
 *   - clean feeds report no adjustments.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-tolerance-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.IP_HASH_SECRET = "test-tolerance";
process.env.BETA_GATE_DISABLED = "true";

jest.mock("../services/canonicalValidatorService", () => {
  const actual = jest.requireActual("../services/canonicalValidatorService");
  return {
    ...actual,
    validateWithCanonical: jest.fn().mockResolvedValue({
      valid: false,
      errors: {
        "calendar_dates.txt": [
          {
            ruleCode: "duplicate_key",
            severity: "error",
            message: "Duplicate key",
            entityType: null,
            entityId: null,
          },
        ],
      },
      counts: { errors: 1, warnings: 0, infos: 0 },
      profile: "canonical",
      engine: "mobilitydata-canonical",
    }),
  };
});

const request = require("supertest");
const archiver = require("archiver");
const app = require("../app");

const SAMPLE_DIR = path.join(__dirname, "..", "..", "sample");

// Build a sample-based zip, then corrupt it: duplicate calendar_dates rows
// (exact PK collision, different exception_type on the dupe) + one
// stop_times row pointing at a trip that does not exist.
const buildBrokenZip = () =>
  new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 0 } });
    const chunks = [];
    archive.on("data", (c) => chunks.push(c));
    archive.on("end", () => resolve(Buffer.concat(chunks)));
    archive.on("error", reject);

    for (const f of fs.readdirSync(SAMPLE_DIR)) {
      const full = path.join(SAMPLE_DIR, f);
      if (f === "calendar_dates.txt") {
        let csv = fs.readFileSync(full, "utf8").trimEnd();
        const lines = csv.split("\n");
        const header = lines[0].split(",");
        const first = lines[1];
        // Exact duplicate + a conflicting duplicate of the same key.
        const conflicting = first
          .split(",")
          .map((v, i) => (header[i] === "exception_type" ? "2" : v))
          .join(",");
        csv += `\n${first}\n${conflicting}\n`;
        archive.append(csv, { name: f });
      } else if (f === "stop_times.txt") {
        let csv = fs.readFileSync(full, "utf8").trimEnd();
        const header = csv.split("\n")[0].split(",");
        const sample = csv.split("\n")[1].split(",");
        const orphan = header
          .map((col, i) => (col === "trip_id" ? "GHOST_TRIP" : sample[i]))
          .join(",");
        csv += `\n${orphan}\n`;
        archive.append(csv, { name: f });
      } else {
        archive.file(full, { name: f });
      }
    }
    archive.finalize();
  });

describe("broken-feed import tolerance", () => {
  let body;

  beforeAll(async () => {
    const buf = await buildBrokenZip();
    const res = await request(app).post("/gtfs/upload").attach("gtfsZip", buf, {
      filename: "broken.zip",
      contentType: "application/zip",
    });
    expect(res.status).toBe(200);
    body = res.body;
  }, 90_000);

  afterAll(() => {
    try {
      fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
    } catch (_) {
      /* best effort */
    }
  });

  test("migration succeeds despite duplicate keys and orphan references", () => {
    expect(body.migrationFailed).toBe(false);
    expect(body.migration_ms).toBeGreaterThan(0);
    expect(
      fs.existsSync(path.join(TEST_UPLOAD_ROOT, body.sessionId, "gtfs.db")),
    ).toBe(true);
  });

  test("duplicate rows are counted per table (first occurrence kept)", () => {
    expect(body.importAdjustments.calendar_dates).toBe(2);
  });

  test("duplicate_key findings come back marked import-resolved, counts adjusted", () => {
    const findings = body.validationReport.errors["calendar_dates.txt"];
    expect(findings.every((f) => f.resolvedByImport === true)).toBe(true);
    // The only blocking finding was import-resolved → the session is
    // compliant as-is, without any re-validation round-trip.
    expect(body.validationReport.counts.errors).toBe(0);
    expect(body.validationReport.counts.resolvedByImport).toBe(1);
    expect(body.validationReport.valid).toBe(true);
    expect(body.valid).toBe(true);
  });

  test("session is readable and the orphan row landed for repair", async () => {
    const agencies = await request(app)
      .get("/gtfs/agencies")
      .set("X-Session-ID", body.sessionId);
    expect(agencies.status).toBe(200);
    expect(Array.isArray(agencies.body)).toBe(true);

    const sql = await request(app)
      .post("/gtfs/sql")
      .set("X-Session-ID", body.sessionId)
      .send({
        query:
          "SELECT COUNT(*) AS c FROM stop_times WHERE trip_id = 'GHOST_TRIP';",
      });
    expect(sql.status).toBe(200);
    expect(sql.body.rows[0].c).toBe(1);
  });

  test("first occurrence wins on conflicting duplicates", async () => {
    const sql = await request(app)
      .post("/gtfs/sql")
      .set("X-Session-ID", body.sessionId)
      .send({
        query:
          "SELECT exception_type FROM calendar_dates ORDER BY service_id, date LIMIT 1;",
      });
    expect(sql.status).toBe(200);
    // The seeded conflicting dupe had exception_type=2; the original first
    // row must have been kept.
    expect(String(sql.body.rows[0].exception_type)).not.toBe("2");
  });

  test("'Fix this feed' path: edit mode opens on the tolerated session", async () => {
    const enter = await request(app)
      .post("/gtfs/edit/enter")
      .set("X-Session-ID", body.sessionId);
    expect(enter.status).toBe(200);
  });
});
