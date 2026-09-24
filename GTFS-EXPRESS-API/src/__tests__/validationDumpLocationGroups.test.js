/**
 * validationDumpLocationGroups.test.js — the CSV dump handed to the canonical
 * validator must include location_groups.txt / location_group_stops.txt
 * built from the DB (not the stale uploaded files).
 */

"use strict";

const fs = require("fs");
const path = require("path");

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");
const { loadValidationDataFromSession } = require("../services/validationService");

describe("validation dump includes GTFS-Flex location groups", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("rows created through the edit endpoints land in the dump directory", async () => {
    const stopId = db.prepare("SELECT stop_id FROM stops LIMIT 1").get().stop_id;

    const lg = await api(sessionId).post("/edit/location_groups", {
      location_group_id: "LG_VAL",
      location_group_name: "Validation dump zone",
    });
    expect(lg.status).toBe(201);
    const lgs = await api(sessionId).post("/edit/location_group_stops", {
      location_group_id: "LG_VAL",
      stop_id: stopId,
    });
    expect(lgs.status).toBe(201);

    const info = await loadValidationDataFromSession(sessionId);
    try {
      expect(info.mode).toBe("sqlite");
      const groupsFile = path.join(info.path, "location_groups.txt");
      const stopsFile = path.join(info.path, "location_group_stops.txt");
      expect(fs.existsSync(groupsFile)).toBe(true);
      expect(fs.existsSync(stopsFile)).toBe(true);

      const groups = fs.readFileSync(groupsFile, "utf8").split("\n");
      expect(groups[0]).toBe("location_group_id,location_group_name");
      expect(groups).toContain("LG_VAL,Validation dump zone");

      const groupStops = fs.readFileSync(stopsFile, "utf8").split("\n");
      expect(groupStops[0]).toBe("location_group_id,stop_id");
      expect(groupStops).toContain(`LG_VAL,${stopId}`);
    } finally {
      fs.rmSync(info.tmpDir, { recursive: true, force: true });
    }
  });
});
