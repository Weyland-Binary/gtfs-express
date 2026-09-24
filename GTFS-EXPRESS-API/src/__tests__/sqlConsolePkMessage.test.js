/**
 * sqlConsolePkMessage.test.js — the PK-mutation refusal of POST /edit/sql
 * must not point at a "dedicated rename endpoint" (there is none). Status
 * and semantics are unchanged: 400, nothing persisted.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");

describe("SQL console PK mutation message", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("UPDATE stops SET stop_id → 400 with the new wording", async () => {
    const stop = db.prepare("SELECT stop_id FROM stops LIMIT 1").get();
    const res = await api(sessionId).post("/edit/sql", {
      query: `UPDATE stops SET stop_id = 'RENAMED_X' WHERE stop_id = '${stop.stop_id.replace(/'/g, "''")}'`,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PK column mutation/i);
    expect(res.body.error).toMatch(/stops\.stop_id/);
    expect(res.body.error).toMatch(/primary keys cannot be changed from the console/i);
    expect(res.body.error).toMatch(/create a new row/i);
    expect(res.body.error).not.toMatch(/dedicated rename endpoint/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM stops WHERE stop_id = 'RENAMED_X'").get().n).toBe(0);
  });
});
