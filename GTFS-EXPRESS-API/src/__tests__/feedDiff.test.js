/**
 * feedDiff.test.js — POST /gtfs/diff (feed-to-feed comparison).
 *
 *   • Two identical sample sessions diff to all-zero counts.
 *   • A renamed stop surfaces as `changed` with the exact changedColumns
 *     (natural single-column PK path).
 *   • A deleted stop_times row surfaces as `removed` (composite PK path).
 *   • An inserted level surfaces as `added`.
 *   • Session-id validation: malformed → 400, unknown → 404, self → 400.
 */

"use strict";

const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Override the upload dir BEFORE any project require so the in-memory
// constant in services/sessionManager picks it up.
const TEST_UPLOAD_ROOT = path.join(
  os.tmpdir(),
  `gtfs-diff-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(TEST_UPLOAD_ROOT, { recursive: true });
process.env.GTFS_UPLOAD_DIR = TEST_UPLOAD_ROOT;
process.env.BETA_GATE_DISABLED = "true";

const request = require("supertest");
const Database = require("better-sqlite3");
const app = require("../app");
const { closeEditDb, dbPathFor } = require("../services/db/connection");

const loadSample = async () => {
  const res = await request(app).get("/gtfs/load-sample");
  expect(res.status).toBe(200);
  expect(res.body.sessionId).toBeTruthy();
  return res.body.sessionId;
};

const diff = (baseId, otherId) =>
  request(app)
    .post("/gtfs/diff")
    .set("X-Session-ID", baseId)
    .send({ otherSessionId: otherId });

describe("POST /gtfs/diff", () => {
  let baseId;
  let otherId;

  beforeAll(async () => {
    baseId = await loadSample();
    otherId = await loadSample();
  }, 60_000);

  afterAll(() => {
    closeEditDb(baseId);
    closeEditDb(otherId);
    fs.rmSync(TEST_UPLOAD_ROOT, { recursive: true, force: true });
  });

  test("identical feeds produce an all-zero diff", async () => {
    const res = await diff(baseId, otherId);
    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
      tablesWithChanges: 0,
    });
    expect(res.body.tables.stops).toMatchObject({
      added: 0,
      removed: 0,
      changed: 0,
    });
  });

  test("rename, delete and insert each land in the right category", async () => {
    // Mutate the OTHER session's database directly on disk (the diff reads
    // files, not the in-memory caches).
    const db = new Database(dbPathFor(otherId));
    const stopId = db
      .prepare("SELECT stop_id FROM stops ORDER BY stop_id LIMIT 1")
      .get().stop_id;
    db.prepare("UPDATE stops SET stop_name = ? WHERE stop_id = ?").run(
      "Diff Harness Stop",
      stopId,
    );
    db.prepare(
      "DELETE FROM stop_times WHERE rowid = (SELECT rowid FROM stop_times LIMIT 1)",
    ).run();
    db.prepare(
      "INSERT INTO levels (level_id, level_index, level_name) VALUES (?, ?, ?)",
    ).run("diff_test_level", 99, "Diff Test Level");
    db.close();

    const res = await diff(baseId, otherId);
    expect(res.status).toBe(200);

    const { tables, summary } = res.body;

    // Renamed stop → changed, with the precise column flagged.
    expect(tables.stops.changed).toBe(1);
    const changedSample = tables.stops.samples.changed[0];
    expect(changedSample.key.stop_id).toBe(stopId);
    expect(changedSample.changedColumns).toEqual(["stop_name"]);
    expect(changedSample.after.stop_name).toBe("Diff Harness Stop");
    expect(changedSample.before.stop_name).not.toBe("Diff Harness Stop");

    // Deleted stop_times row (composite PK trip_id+stop_sequence) →
    // removed relative to the base→other direction.
    expect(tables.stop_times.removed).toBe(1);
    expect(tables.stop_times.added).toBe(0);
    expect(tables.stop_times.samples.removed).toHaveLength(1);

    // Inserted level → added.
    expect(tables.levels.added).toBe(1);
    expect(tables.levels.samples.added[0].level_id).toBe("diff_test_level");

    expect(summary.changed).toBe(1);
    expect(summary.removed).toBe(1);
    expect(summary.added).toBe(1);
    expect(summary.tablesWithChanges).toBe(3);
  });

  test("malformed otherSessionId is rejected with 400", async () => {
    const res = await diff(baseId, "../../../etc/passwd");
    expect(res.status).toBe(400);
  });

  test("well-formed but unknown otherSessionId yields 404", async () => {
    const res = await diff(baseId, "11111111-2222-4333-8444-555555555555");
    expect(res.status).toBe(404);
  });

  test("comparing a session against itself is rejected with 400", async () => {
    const res = await diff(baseId, baseId);
    expect(res.status).toBe(400);
  });
});
