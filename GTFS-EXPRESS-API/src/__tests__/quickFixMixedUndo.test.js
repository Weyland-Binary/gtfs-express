/**
 * quickFixMixedUndo.test.js — undo / redo of a quick fix spanning several
 * entity types (logged with entity "mixed", entity_id "agency:A,stop:S,…").
 *
 * Regression: resyncCacheForLogEntry fell through to
 * `syncCacheEntry(sessionId, db, "mixed", …)` → TypeError on
 * ENTITY_CONFIG["mixed"] after the transaction had already committed, so
 * POST /edit/undo answered 500 although the DB was rolled back.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
  cache,
} = require("./_helpers/sampleSession");

describe("quick fix touching agency + stops → undo / redo", () => {
  let sessionId;
  let sessionDir;
  let db;

  beforeAll(async () => {
    ({ sessionId, sessionDir, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("leading_or_trailing_whitespaces on agency + stop: apply → undo 200 → redo 200", async () => {
    const agency = db.prepare("SELECT agency_id, agency_name FROM agency LIMIT 1").get();
    const stop = db.prepare("SELECT stop_id, stop_name FROM stops LIMIT 1").get();
    const paddedAgency = `  ${agency.agency_name}  `;
    const paddedStop = ` ${stop.stop_name} `;
    db.prepare("UPDATE agency SET agency_name = ? WHERE agency_id = ?").run(
      paddedAgency,
      agency.agency_id,
    );
    db.prepare("UPDATE stops SET stop_name = ? WHERE stop_id = ?").run(
      paddedStop,
      stop.stop_id,
    );

    const preview = await api(sessionId).post("/edit/quickfix/preview", {
      ruleCode: "leading_or_trailing_whitespaces",
    });
    expect(preview.status).toBe(200);
    const entities = new Set(preview.body.proposals.map((p) => p.entity));
    expect(entities.has("agency")).toBe(true);
    expect(entities.has("stop")).toBe(true);

    const apply = await api(sessionId).post("/edit/quickfix/apply", {
      ruleCode: "leading_or_trailing_whitespaces",
    });
    expect(apply.status).toBe(200);
    expect(apply.body.applied).toBeGreaterThanOrEqual(2);

    const entry = db.prepare("SELECT * FROM _edit_log ORDER BY id DESC LIMIT 1").get();
    expect(entry.entity).toBe("mixed");
    expect(entry.action).toBe("quick_fix");
    expect(entry.entity_id).toContain(`agency:${agency.agency_id}`);
    expect(entry.entity_id).toContain(`stop:${stop.stop_id}`);

    expect(
      db.prepare("SELECT agency_name FROM agency WHERE agency_id = ?").get(agency.agency_id)
        .agency_name,
    ).toBe(agency.agency_name);
    expect(
      db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?").get(stop.stop_id).stop_name,
    ).toBe(stop.stop_name);

    // ── Undo: must be 200 and restore the padded values.
    const undo = await api(sessionId).undo();
    expect(undo.status).toBe(200);
    expect(undo.body.undone.id).toBe(entry.id);
    expect(
      db.prepare("SELECT agency_name FROM agency WHERE agency_id = ?").get(agency.agency_id)
        .agency_name,
    ).toBe(paddedAgency);
    expect(
      db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?").get(stop.stop_id).stop_name,
    ).toBe(paddedStop);

    // The in-memory cache follows each `type:id` pair.
    const data = cache.get(sessionDir);
    expect(data).toBeDefined();
    const cachedAgency = data.agencies.find((a) => a.agency_id === agency.agency_id);
    expect(cachedAgency.agency_name).toBe(paddedAgency);
    const cachedStop = data.stops.find((s) => s.stop_id === stop.stop_id);
    expect(cachedStop.stop_name).toBe(paddedStop);

    // ── Redo: 200 and trimmed again.
    const redo = await api(sessionId).redo();
    expect(redo.status).toBe(200);
    expect(redo.body.redone.id).toBe(entry.id);
    expect(
      db.prepare("SELECT agency_name FROM agency WHERE agency_id = ?").get(agency.agency_id)
        .agency_name,
    ).toBe(agency.agency_name);
    expect(
      db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?").get(stop.stop_id).stop_name,
    ).toBe(stop.stop_name);
    expect(
      cache.get(sessionDir).stops.find((s) => s.stop_id === stop.stop_id).stop_name,
    ).toBe(stop.stop_name);
  });
});
