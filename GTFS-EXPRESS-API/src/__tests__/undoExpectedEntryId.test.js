/**
 * undoExpectedEntryId.test.js — POST /edit/undo accepts an optional
 * `{ expectedEntryId }` and refuses with 409 UNDO_TARGET_NOT_LATEST when the
 * newest active entry differs. Also pins `undone.id` and the `undoEntryId`
 * returned by POST /edit/sql.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");

describe("POST /edit/undo with expectedEntryId", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("mismatch → 409 and nothing changes; match → 200 with undone.id", async () => {
    const stop = db.prepare("SELECT stop_id, stop_name FROM stops LIMIT 1").get();
    const patched = await api(sessionId).patch(`/edit/stops/${encodeURIComponent(stop.stop_id)}`, {
      stop_name: `${stop.stop_name} (renamed)`,
    });
    expect(patched.status).toBe(200);
    const entry = db.prepare("SELECT id FROM _edit_log WHERE undone = 0 ORDER BY id DESC LIMIT 1").get();

    const stale = await api(sessionId).undo({ expectedEntryId: entry.id + 1000 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("UNDO_TARGET_NOT_LATEST");
    expect(stale.body.latestId).toBe(entry.id);
    expect(stale.body.expectedEntryId).toBe(entry.id + 1000);
    // Untouched: still renamed, entry still active.
    expect(
      db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?").get(stop.stop_id).stop_name,
    ).toBe(`${stop.stop_name} (renamed)`);
    expect(db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(entry.id).undone).toBe(0);

    const bad = await api(sessionId).undo({ expectedEntryId: "abc" });
    expect(bad.status).toBe(400);

    const ok = await api(sessionId).undo({ expectedEntryId: entry.id });
    expect(ok.status).toBe(200);
    expect(ok.body.undone.id).toBe(entry.id);
    expect(ok.body.undone.entity).toBe("stop");
    expect(
      db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?").get(stop.stop_id).stop_name,
    ).toBe(stop.stop_name);
  });

  test("without a body the newest entry is undone (legacy behaviour) and undone.id is present", async () => {
    const stop = db.prepare("SELECT stop_id, stop_name FROM stops LIMIT 1").get();
    await api(sessionId).patch(`/edit/stops/${encodeURIComponent(stop.stop_id)}`, {
      stop_name: `${stop.stop_name} v2`,
    });
    const entry = db.prepare("SELECT id FROM _edit_log WHERE undone = 0 ORDER BY id DESC LIMIT 1").get();
    const undo = await api(sessionId).undo();
    expect(undo.status).toBe(200);
    expect(undo.body.undone.id).toBe(entry.id);
  });

  test("POST /edit/sql mutations return undoEntryId usable as expectedEntryId", async () => {
    const stop = db.prepare("SELECT stop_id FROM stops LIMIT 1").get();
    const res = await api(sessionId).post("/edit/sql", {
      query: `UPDATE stops SET stop_desc = 'sql desc' WHERE stop_id = '${stop.stop_id.replace(/'/g, "''")}'`,
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.undoEntryId).toBe("number");
    const undo = await api(sessionId).undo({ expectedEntryId: res.body.undoEntryId });
    expect(undo.status).toBe(200);
    expect(undo.body.undone.id).toBe(res.body.undoEntryId);
  });
});
