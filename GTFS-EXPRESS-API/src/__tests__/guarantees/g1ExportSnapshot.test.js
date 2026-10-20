/**
 * G1 on the GTFS export (exportService.exportGTFS): the feed streamed is the feed the gate validated. The working
 * copy stays writable while the validator runs (minutes on a large feed); a write landing in that window must not
 * reach the archive, which streams the gate's read snapshot (exportService.openSnapshot).
 */

"use strict";

const { app, request, sampleSession, binary, unzip } = require("../_helpers/session");
const gate = require("../../services/validatorGate");
const { getEditDb } = require("../../services/db/connection");

const realValidateDir = gate.deps.validateDir;
afterEach(() => {
  gate.deps.validateDir = realValidateDir;
});

test("a write during the validation does not reach the archive", async () => {
  const sessionId = await sampleSession();
  const db = getEditDb(sessionId);
  const before = db.prepare("SELECT stop_id, stop_name FROM stops ORDER BY stop_id LIMIT 1").get();

  gate.deps.validateDir = async (dir, countryCode) => {
    const report = await realValidateDir(dir, countryCode);
    // Another tab's edit, while the validator is still running.
    db.prepare("UPDATE stops SET stop_name = 'CHANGED DURING VALIDATION'").run();
    return report;
  };

  const res = await request(app).get("/gtfs/edit/export").set("X-Session-ID", sessionId).buffer(true).parse(binary);
  expect(res.status).toBe(200);
  const files = await unzip(res.body);
  expect(files["stops.txt"]).toContain(before.stop_name);
  expect(files["stops.txt"]).not.toContain("CHANGED DURING VALIDATION");
  // The write itself stands: the next export validates and delivers it.
  expect(db.prepare("SELECT stop_name FROM stops WHERE stop_id = ?").get(before.stop_id).stop_name).toBe("CHANGED DURING VALIDATION");
});

test("a refused export releases its snapshot and delivers nothing", async () => {
  const sessionId = await sampleSession();
  gate.deps.validateDir = async () => ({ valid: false, errors: { "trips.txt": [{ ruleCode: "foreign_key_violation", severity: "ERROR" }] }, counts: { errors: 1, warnings: 0, infos: 0 }, engine: "test" });
  const res = await request(app).get("/gtfs/edit/export").set("X-Session-ID", sessionId);
  expect(res.status).toBe(422);
  expect(res.body.error).toBe("VALIDATION_NEW_ERRORS");
  // The session's own handle still writes (no lock left behind by the snapshot).
  expect(() => getEditDb(sessionId).prepare("UPDATE stops SET stop_desc = stop_desc").run()).not.toThrow();
});

test("?force is refused", async () => {
  const sessionId = await sampleSession();
  const res = await request(app).get("/gtfs/edit/export?force=true").set("X-Session-ID", sessionId);
  expect(res.status).toBe(400);
});
