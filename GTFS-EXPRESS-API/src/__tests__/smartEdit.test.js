/**
 * smartEdit.test.js — assistant-planned batch operations:
 *   POST /edit/stop_times/insert_pattern, /edit/stops/merge,
 *   /edit/stops/rename_batch, /edit/calendar/extend.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");

const secs = (t) => t.split(":").reduce((acc, p, i) => acc + parseInt(p, 10) * [3600, 60, 1][i], 0);

describe("assistant batch operations", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  const one = (sql, ...args) => db.prepare(sql).get(...args);

  describe("insert_pattern", () => {
    test("dry run interpolates times between the anchors and flags far shapes", async () => {
      const res = await api(sessionId).post("/edit/stop_times/insert_pattern", {
        stop_id: "DOM",
        after_stop_id: "DYK",
        before_stop_id: "S1_0_X2_1",
        route_id: "S1",
        direction_id: "0",
        dry_run: true,
      });
      expect(res.status).toBe(200);
      expect(res.body.dry_run).toBe(true);
      expect(res.body.trips.length).toBeGreaterThan(1);
      const first = res.body.trips.find((t) => t.trip_id === "S1_WKD_0_001");
      expect(first).toBeDefined();
      // Between DYK (dep 05:22:42) and S1_0_X2_1 (arr 05:28:30).
      expect(secs(first.arrival_time)).toBeGreaterThan(secs("05:22:42"));
      expect(secs(first.arrival_time)).toBeLessThan(secs("05:28:30"));
      expect(first.stop_sequence).toBe(3);
      // Domino Park is in Brooklyn: every S1 shape runs far from it.
      expect(res.body.shapes_to_review.length).toBeGreaterThan(0);
      expect(res.body.shapes_to_review[0].distance_m).toBeGreaterThan(1000);
      expect(one("SELECT COUNT(*) AS n FROM stop_times WHERE stop_id = 'DOM' AND trip_id LIKE 'S1_%'").n).toBe(0);
    });

    test("applies to every trip with renumbering, then undo/redo restore the sequences", async () => {
      const before = db
        .prepare("SELECT stop_id, stop_sequence FROM stop_times WHERE trip_id = 'S1_WKD_0_001' ORDER BY CAST(stop_sequence AS INTEGER)")
        .all();
      const res = await api(sessionId).post("/edit/stop_times/insert_pattern", {
        stop_id: "DOM",
        after_stop_id: "DYK",
        route_id: "S1",
        direction_id: "0",
      });
      expect(res.status).toBe(201);
      expect(res.body.inserted).toBe(res.body.trips.length);
      expect(typeof res.body.undoEntryId).toBe("number");
      const after = db
        .prepare("SELECT stop_id, stop_sequence FROM stop_times WHERE trip_id = 'S1_WKD_0_001' ORDER BY CAST(stop_sequence AS INTEGER)")
        .all();
      expect(after.length).toBe(before.length + 1);
      expect(after[2].stop_id).toBe("DOM");
      expect(after.map((r) => Number(r.stop_sequence))).toEqual(after.map((_, i) => i + 1));
      // A second run skips the trips already serving the stop.
      const again = await api(sessionId).post("/edit/stop_times/insert_pattern", {
        stop_id: "DOM",
        after_stop_id: "DYK",
        route_id: "S1",
        direction_id: "0",
        dry_run: true,
      });
      expect(again.status).toBe(409);
      expect(again.body.skipped.already_present).toBe(res.body.inserted);

      const undo = await api(sessionId).undo();
      expect(undo.status).toBe(200);
      const restored = db
        .prepare("SELECT stop_id, stop_sequence FROM stop_times WHERE trip_id = 'S1_WKD_0_001' ORDER BY CAST(stop_sequence AS INTEGER)")
        .all();
      expect(restored).toEqual(before);
      expect(one("SELECT COUNT(*) AS n FROM stop_times WHERE stop_id = 'DOM' AND trip_id LIKE 'S1_%'").n).toBe(0);
      const redo = await api(sessionId).redo();
      expect(redo.status).toBe(200);
      expect(one("SELECT COUNT(*) AS n FROM stop_times WHERE stop_id = 'DOM' AND trip_id LIKE 'S1_%'").n).toBe(res.body.inserted);
      await api(sessionId).undo();
    });

    test("rejects unknown stops and missing anchors", async () => {
      let res = await api(sessionId).post("/edit/stop_times/insert_pattern", { stop_id: "nope", after_stop_id: "DYK", route_id: "S1" });
      expect(res.status).toBe(404);
      res = await api(sessionId).post("/edit/stop_times/insert_pattern", { stop_id: "DOM", route_id: "S1" });
      expect(res.status).toBe(400);
      // Anchor never served by the route (a Brooklyn bus stop on a Manhattan line).
      res = await api(sessionId).post("/edit/stop_times/insert_pattern", { stop_id: "DOM", after_stop_id: "B4_0_X7_1", route_id: "S1", direction_id: "0" });
      expect(res.status).toBe(409);
      expect(res.body.skipped.no_anchor).toBeGreaterThan(0);
    });
  });

  describe("merge", () => {
    test("dry run reports the references and the apply re-points them; undo restores", async () => {
      const survivor = "B4_0_X7_2";
      const dup = "B4_1_X2_1";
      const dupStopTimes = one("SELECT COUNT(*) AS n FROM stop_times WHERE stop_id = ?", dup).n;
      expect(dupStopTimes).toBeGreaterThan(0);
      const dry = await api(sessionId).post("/edit/stops/merge", { survivor_id: survivor, duplicate_ids: [dup], dry_run: true });
      expect(dry.status).toBe(200);
      expect(dry.body.duplicates[0]).toMatchObject({ stop_id: dup, distance_m: 0, stop_times: dupStopTimes });
      expect(dry.body.by_table.stop_times).toBe(dupStopTimes);
      expect(one("SELECT 1 AS n FROM stops WHERE stop_id = ?", dup)).toBeDefined();

      const res = await api(sessionId).post("/edit/stops/merge", { survivor_id: survivor, duplicate_ids: [dup] });
      expect(res.status).toBe(200);
      expect(res.body.merged).toBe(1);
      expect(one("SELECT COUNT(*) AS n FROM stops WHERE stop_id = ?", dup).n).toBe(0);
      expect(one("SELECT COUNT(*) AS n FROM stop_times WHERE stop_id = ?", dup).n).toBe(0);
      expect(one("SELECT COUNT(*) AS n FROM stop_times WHERE stop_id = ?", survivor).n).toBeGreaterThanOrEqual(dupStopTimes);

      const undo = await api(sessionId).undo();
      expect(undo.status).toBe(200);
      expect(one("SELECT stop_name FROM stops WHERE stop_id = ?", dup).stop_name).toBe("Greenpoint / Domino Park 1");
      expect(one("SELECT COUNT(*) AS n FROM stop_times WHERE stop_id = ?", dup).n).toBe(dupStopTimes);
      const redo = await api(sessionId).redo();
      expect(redo.status).toBe(200);
      expect(one("SELECT COUNT(*) AS n FROM stops WHERE stop_id = ?", dup).n).toBe(0);
      await api(sessionId).undo();
    });

    test("re-points transfers and pathways, fills empty survivor fields", async () => {
      // WTC_S has a transfer and a platform_code; create a bare duplicate.
      db.prepare("INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, stop_desc) VALUES ('DUP1', 'World Trade Center', 40.7127, -74.0099, '0', 'Desc from dup')").run();
      db.prepare("INSERT INTO transfers (from_stop_id, to_stop_id, transfer_type, min_transfer_time) VALUES ('DUP1', 'WSL_F', '2', 300)").run();
      db.prepare("INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type) VALUES ('SURV', 'World Trade Center', 40.7127, -74.0099, '0')").run();
      const res = await api(sessionId).post("/edit/stops/merge", { survivor_id: "SURV", duplicate_ids: ["DUP1"] });
      expect(res.status).toBe(200);
      expect(res.body.by_table.transfers).toBe(1);
      expect(res.body.filled.stop_desc).toBe("Desc from dup");
      expect(one("SELECT from_stop_id FROM transfers WHERE to_stop_id = 'WSL_F' AND min_transfer_time = 300").from_stop_id).toBe("SURV");
      expect(one("SELECT stop_desc FROM stops WHERE stop_id = 'SURV'").stop_desc).toBe("Desc from dup");
      const undo = await api(sessionId).undo();
      expect(undo.status).toBe(200);
      expect(one("SELECT from_stop_id FROM transfers WHERE to_stop_id = 'WSL_F' AND min_transfer_time = 300").from_stop_id).toBe("DUP1");
      expect(one("SELECT stop_desc FROM stops WHERE stop_id = 'SURV'").stop_desc).toBeNull();
      db.prepare("DELETE FROM _edit_log").run();
      db.prepare("DELETE FROM transfers WHERE from_stop_id = 'DUP1'").run();
      db.prepare("DELETE FROM stops WHERE stop_id IN ('DUP1', 'SURV')").run();
    });

    test("validates its input", async () => {
      let res = await api(sessionId).post("/edit/stops/merge", { survivor_id: "DOM", duplicate_ids: ["DOM"] });
      expect(res.status).toBe(400);
      res = await api(sessionId).post("/edit/stops/merge", { survivor_id: "DOM", duplicate_ids: ["ghost"] });
      expect(res.status).toBe(404);
    });
  });

  describe("rename_batch", () => {
    test("renames, skips unchanged, undoes", async () => {
      const res = await api(sessionId).post("/edit/stops/rename_batch", {
        renames: [
          { stop_id: "B4_0_X7_1", stop_name: "Domino Park / Greenpoint" },
          { stop_id: "B4_0_X7_2", stop_name: "  Domino Park /   Greenpoint " },
          { stop_id: "DOM", stop_name: "Domino Park" },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.body.renamed).toBe(2);
      expect(res.body.unchanged).toBe(1);
      expect(one("SELECT stop_name FROM stops WHERE stop_id = 'B4_0_X7_2'").stop_name).toBe("Domino Park / Greenpoint");
      const undo = await api(sessionId).undo();
      expect(undo.status).toBe(200);
      expect(one("SELECT stop_name FROM stops WHERE stop_id = 'B4_0_X7_2'").stop_name).toBe("Domino Park / Greenpoint 2");
    });

    test("rejects empty names and unknown stops", async () => {
      let res = await api(sessionId).post("/edit/stops/rename_batch", { renames: [{ stop_id: "DOM", stop_name: "  " }] });
      expect(res.status).toBe(400);
      res = await api(sessionId).post("/edit/stops/rename_batch", { renames: [{ stop_id: "ghost", stop_name: "X" }] });
      expect(res.status).toBe(404);
      res = await api(sessionId).post("/edit/stops/rename_batch", { renames: [{ stop_id: "DOM", stop_name: "Domino Park" }] });
      expect(res.status).toBe(409);
    });
  });

  describe("calendar/extend", () => {
    test("extends every service ending before the date plus feed_info; undo restores", async () => {
      const dry = await api(sessionId).post("/edit/calendar/extend", { end_date: "20271231", dry_run: true });
      expect(dry.status).toBe(200);
      expect(dry.body.services.length).toBeGreaterThan(0);
      expect(dry.body.services.find((s) => s.service_id === "WKD")).toMatchObject({ old_end_date: "20270331", end_date: "20271231" });
      expect(dry.body.feed_info).toEqual({ old_end_date: "20270331", end_date: "20271231" });
      expect(one("SELECT end_date FROM calendar WHERE service_id = 'WKD'").end_date).toBe("20270331");

      const res = await api(sessionId).post("/edit/calendar/extend", { end_date: "20271231", service_ids: ["WKD"] });
      expect(res.status).toBe(200);
      expect(res.body.extended).toBe(1);
      expect(one("SELECT end_date FROM calendar WHERE service_id = 'WKD'").end_date).toBe("20271231");
      expect(one("SELECT feed_end_date FROM feed_info").feed_end_date).toBe("20271231");
      expect(one("SELECT end_date FROM calendar WHERE service_id = 'SAT'").end_date).toBe("20270331");
      const undo = await api(sessionId).undo();
      expect(undo.status).toBe(200);
      expect(one("SELECT end_date FROM calendar WHERE service_id = 'WKD'").end_date).toBe("20270331");
      expect(one("SELECT feed_end_date FROM feed_info").feed_end_date).toBe("20270331");
    });

    test("validates dates", async () => {
      let res = await api(sessionId).post("/edit/calendar/extend", { end_date: "2027-12-31" });
      expect(res.status).toBe(400);
      res = await api(sessionId).post("/edit/calendar/extend", { end_date: "20200101", service_ids: ["WKD"] });
      expect(res.status).toBe(400);
      res = await api(sessionId).post("/edit/calendar/extend", { end_date: "20270331" });
      expect(res.status).toBe(409);
    });
  });
});
