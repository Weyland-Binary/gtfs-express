/**
 * quickFixesRescue.test.js — rescue-flow wave of the quickfix catalogue.
 * Three new scanners targeting export-blocking (ERROR) rules:
 *
 *   - start_and_end_range_out_of_order → calendar: swap start/end dates
 *   - invalid_url                      → agency/routes/stops: add https://
 *   - leading_or_trailing_whitespaces  → text columns: trim
 *
 * Same harness as quickFixesNew.test.js: each scanner tested in isolation
 * against an in-memory edit DB (fast, deterministic, no HTTP).
 */

"use strict";

const Database = require("better-sqlite3");
const { applySchema } = require("../services/db/schema");
const { QUICK_FIXES } = require("../utils/quickFixes");

const newDb = () => {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
};

// ═══════════════════════════════════════════════════════════════════════════
//   1. start_and_end_range_out_of_order
// ═══════════════════════════════════════════════════════════════════════════

describe("start_and_end_range_out_of_order scanner", () => {
  const fix = QUICK_FIXES.start_and_end_range_out_of_order;

  test("registry entry has expected metadata", () => {
    expect(fix).toBeDefined();
    expect(fix.entity).toBe("calendar");
    expect(fix.titleKey).toBe(
      "quickFix.start_and_end_range_out_of_order.title",
    );
    expect(typeof fix.scan).toBe("function");
  });

  test("swaps reversed ranges, leaves ordered and equal ranges alone", () => {
    const db = newDb();
    const ins = db.prepare(
      "INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) " +
        "VALUES (?, 1, 1, 1, 1, 1, 0, 0, ?, ?)",
    );
    ins.run("SVC_REVERSED", "20261231", "20260101");
    ins.run("SVC_OK", "20260101", "20261231");
    ins.run("SVC_SAME_DAY", "20260601", "20260601");

    const proposals = fix.scan(db);
    expect(proposals.map((p) => p.id)).toEqual(["SVC_REVERSED"]);
    expect(proposals[0].entity).toBe("calendar");
    expect(proposals[0].patch).toEqual({
      start_date: "20260101",
      end_date: "20261231",
    });
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//   2. invalid_url
// ═══════════════════════════════════════════════════════════════════════════

describe("invalid_url scanner", () => {
  const fix = QUICK_FIXES.invalid_url;

  test("prepends https:// to scheme-less host-like URLs across entities", () => {
    const db = newDb();
    db.prepare(
      "INSERT INTO agency (agency_id, agency_name, agency_url) VALUES (?, ?, ?)",
    ).run("A_BAD", "X", "www.example.com");
    db.prepare(
      "INSERT INTO agency (agency_id, agency_name, agency_url) VALUES (?, ?, ?)",
    ).run("A_OK", "Y", "https://ok.example.com");
    db.prepare(
      "INSERT INTO routes (route_id, route_type, route_url) VALUES (?, ?, ?)",
    ).run("R_BAD", "3", "transit.example.org/line/12");
    db.prepare(
      "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, stop_url) VALUES (?, ?, 0, 0, ?)",
    ).run("S_BAD", "Stop", "www.stop.example.com");

    const proposals = fix.scan(db);
    const byId = Object.fromEntries(proposals.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(["A_BAD", "R_BAD", "S_BAD"]);
    expect(byId.A_BAD.patch.agency_url).toBe("https://www.example.com");
    expect(byId.A_BAD.entity).toBe("agency");
    expect(byId.R_BAD.patch.route_url).toBe(
      "https://transit.example.org/line/12",
    );
    expect(byId.S_BAD.patch.stop_url).toBe("https://www.stop.example.com");
    db.close();
  });

  test("does NOT touch garbage values or URLs that already have a scheme", () => {
    const db = newDb();
    db.prepare(
      "INSERT INTO agency (agency_id, agency_name, agency_url) VALUES (?, ?, ?)",
    ).run("A_GARBAGE", "X", "not a url at all");
    db.prepare(
      "INSERT INTO agency (agency_id, agency_name, agency_url) VALUES (?, ?, ?)",
    ).run("A_FTP", "Y", "ftp://files.example.com");
    db.prepare(
      "INSERT INTO agency (agency_id, agency_name, agency_url) VALUES (?, ?, ?)",
    ).run("A_NO_TLD", "Z", "localhost");
    expect(fix.scan(db)).toEqual([]);
    db.close();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//   3. leading_or_trailing_whitespaces
// ═══════════════════════════════════════════════════════════════════════════

describe("leading_or_trailing_whitespaces scanner", () => {
  const fix = QUICK_FIXES.leading_or_trailing_whitespaces;

  test("trims text columns across entities, skips clean rows", () => {
    const db = newDb();
    db.prepare(
      "INSERT INTO agency (agency_id, agency_name) VALUES (?, ?)",
    ).run("A", "  Metro Agency  ");
    db.prepare(
      "INSERT INTO routes (route_id, route_type, route_short_name, route_long_name) VALUES (?, ?, ?, ?)",
    ).run("R", "3", "12 ", "Crosstown");
    db.prepare(
      "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon) VALUES (?, ?, 0, 0)",
    ).run("S_CLEAN", "Central");
    db.prepare(
      "INSERT INTO trips (trip_id, route_id, service_id, trip_headsign) VALUES (?, ?, ?, ?)",
    ).run("T", "R", "SVC", " Downtown ");

    const proposals = fix.scan(db);
    const byId = Object.fromEntries(proposals.map((p) => [p.id, p]));
    expect(Object.keys(byId).sort()).toEqual(["A", "R", "T"]);
    expect(byId.A.patch.agency_name).toBe("Metro Agency");
    expect(byId.R.patch.route_short_name).toBe("12");
    // Clean column on the same row is not included in the patch.
    expect(byId.R.patch.route_long_name).toBeUndefined();
    expect(byId.T.patch.trip_headsign).toBe("Downtown");
    db.close();
  });

  test("never proposes trimming identifier / foreign-key columns", () => {
    const db = newDb();
    // A trailing space inside an FK column must NOT be flagged: trimming
    // one side of a join breaks the reference. Both sides carry the space
    // (the feed is internally consistent), which is exactly why a blind
    // trim would corrupt it.
    db.prepare(
      "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type) VALUES (?, ?, 0, 0, 1)",
    ).run("PARENT ", "Station");
    db.prepare(
      "INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon, parent_station, zone_id) VALUES (?, ?, 0, 0, ?, ?)",
    ).run("S", "Clean name", "PARENT ", " Z1");
    expect(fix.scan(db)).toEqual([]);
    db.close();
  });

  test("whitespace-only value is patched to null", () => {
    const db = newDb();
    db.prepare(
      "INSERT INTO routes (route_id, route_type, route_desc) VALUES (?, ?, ?)",
    ).run("R", "3", "   ");
    const proposals = fix.scan(db);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].patch.route_desc).toBeNull();
    db.close();
  });
});
