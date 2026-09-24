/**
 * dialogDeleteCascadeUndo.test.js — dialog deletes (DELETE /edit/stops/:id,
 * /edit/agencies/:id, /edit/trips/:id) capture the rows SQLite removes or
 * nulls through ON DELETE CASCADE / SET NULL, so undo restores them exactly.
 */

"use strict";

const {
  seedSession,
  teardownSession,
  removeUploadRoot,
  api,
} = require("./_helpers/sampleSession");

describe("dialog delete → FK cascade capture → undo", () => {
  let sessionId;
  let db;

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  }, 60_000);

  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("DELETE /edit/stops/:id restores the cascaded transfer + pathway on undo", async () => {
    const other = db.prepare("SELECT stop_id FROM stops LIMIT 1").get().stop_id;

    const created = await api(sessionId).post("/edit/stops", {
      stop_id: "CASC_STOP",
      stop_name: "Cascade test stop",
      stop_lat: 40.7,
      stop_lon: -73.99,
    });
    expect(created.status).toBe(201);

    const transfer = await api(sessionId).post("/edit/transfers", {
      from_stop_id: "CASC_STOP",
      to_stop_id: other,
      transfer_type: 2,
      min_transfer_time: 120,
    });
    expect(transfer.status).toBe(201);
    const transferRow = db
      .prepare("SELECT * FROM transfers WHERE from_stop_id = 'CASC_STOP'")
      .get();
    expect(transferRow).toBeDefined();

    db.prepare(
      "INSERT INTO pathways (pathway_id, from_stop_id, to_stop_id, pathway_mode, is_bidirectional) VALUES ('CASC_PW', 'CASC_STOP', ?, 1, 1)",
    ).run(other);

    const del = await api(sessionId).delete("/edit/stops/CASC_STOP");
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe("CASC_STOP");
    expect(del.body.cascade.transfers).toBe(1);
    expect(del.body.cascade.pathways).toBe(1);

    // SQLite really cascaded.
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE from_stop_id = 'CASC_STOP'").get().n,
    ).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM pathways WHERE pathway_id = 'CASC_PW'").get().n,
    ).toBe(0);

    const entry = db.prepare("SELECT * FROM _edit_log ORDER BY id DESC LIMIT 1").get();
    expect(entry.entity).toBe("stop");
    expect(entry.description).toMatch(/Cascade:/);
    const undoOps = JSON.parse(entry.undo_ops);
    expect(undoOps.some((o) => o.sql.startsWith("INSERT INTO transfers"))).toBe(true);
    expect(undoOps.some((o) => o.sql.startsWith("INSERT INTO pathways"))).toBe(true);

    const undo = await api(sessionId).undo();
    expect(undo.status).toBe(200);

    const restoredStop = db.prepare("SELECT * FROM stops WHERE stop_id = 'CASC_STOP'").get();
    expect(restoredStop).toBeDefined();
    const restoredTransfer = db
      .prepare("SELECT * FROM transfers WHERE from_stop_id = 'CASC_STOP'")
      .get();
    expect(restoredTransfer).toEqual(transferRow);
    const restoredPathway = db
      .prepare("SELECT pathway_id, from_stop_id, to_stop_id FROM pathways WHERE pathway_id = 'CASC_PW'")
      .get();
    expect(restoredPathway).toEqual({
      pathway_id: "CASC_PW",
      from_stop_id: "CASC_STOP",
      to_stop_id: other,
    });

    // Redo deletes everything again (cascade re-fires).
    const redo = await api(sessionId).redo();
    expect(redo.status).toBe(200);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE from_stop_id = 'CASC_STOP'").get().n,
    ).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM stops WHERE stop_id = 'CASC_STOP'").get().n).toBe(0);
  });

  test("DELETE /edit/agencies/:id restores cascaded attributions and SET NULL fare_attributes", async () => {
    const created = await api(sessionId).post("/edit/agencies", {
      agency_id: "CASC_AG",
      agency_name: "Cascade Agency",
      agency_url: "https://example.com/cascade",
      agency_timezone: "America/New_York",
    });
    expect(created.status).toBe(201);
    db.prepare(
      "INSERT INTO attributions (attribution_id, agency_id, organization_name, is_producer) VALUES ('CASC_ATTR', 'CASC_AG', 'Cascade Org', 1)",
    ).run();
    db.prepare(
      "INSERT INTO fare_attributes (fare_id, price, currency_type, payment_method, agency_id) VALUES ('CASC_FARE', '2.75', 'USD', '0', 'CASC_AG')",
    ).run();

    const del = await api(sessionId).delete("/edit/agencies/CASC_AG");
    expect(del.status).toBe(200);
    expect(del.body.cascade.attributions).toBe(1);
    expect(del.body.cascade.fare_attributes).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM attributions WHERE attribution_id = 'CASC_ATTR'").get().n,
    ).toBe(0);
    expect(
      db.prepare("SELECT agency_id FROM fare_attributes WHERE fare_id = 'CASC_FARE'").get().agency_id,
    ).toBeNull();

    const undo = await api(sessionId).undo();
    expect(undo.status).toBe(200);
    expect(db.prepare("SELECT agency_id FROM agency WHERE agency_id = 'CASC_AG'").get()).toBeDefined();
    const attr = db
      .prepare("SELECT agency_id, organization_name FROM attributions WHERE attribution_id = 'CASC_ATTR'")
      .get();
    expect(attr).toEqual({ agency_id: "CASC_AG", organization_name: "Cascade Org" });
    expect(
      db.prepare("SELECT agency_id FROM fare_attributes WHERE fare_id = 'CASC_FARE'").get().agency_id,
    ).toBe("CASC_AG");
  });

  test("DELETE /edit/trips/:id restores stop_times, frequencies and a trip-level transfer", async () => {
    const trip = db
      .prepare(
        "SELECT t.trip_id FROM trips t JOIN stop_times st ON st.trip_id = t.trip_id GROUP BY t.trip_id ORDER BY COUNT(*) ASC LIMIT 1",
      )
      .get();
    const tripId = trip.trip_id;
    const stopTimesBefore = db
      .prepare("SELECT * FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence")
      .all(tripId);
    expect(stopTimesBefore.length).toBeGreaterThan(0);
    db.prepare(
      "INSERT INTO frequencies (trip_id, start_time, end_time, headway_secs, exact_times) VALUES (?, '06:00:00', '07:00:00', 600, 0)",
    ).run(tripId);
    const otherTrip = db
      .prepare("SELECT trip_id FROM trips WHERE trip_id != ? LIMIT 1")
      .get(tripId).trip_id;
    db.prepare(
      "INSERT INTO transfers (from_trip_id, to_trip_id, transfer_type) VALUES (?, ?, 1)",
    ).run(tripId, otherTrip);

    const del = await api(sessionId).delete(`/edit/trips/${encodeURIComponent(tripId)}`);
    expect(del.status).toBe(200);
    expect(del.body.cascade.stop_times).toBe(stopTimesBefore.length);
    expect(del.body.cascade.frequencies).toBe(1);
    expect(del.body.cascade.transfers).toBe(1);

    const undo = await api(sessionId).undo();
    expect(undo.status).toBe(200);
    const stopTimesAfter = db
      .prepare("SELECT * FROM stop_times WHERE trip_id = ? ORDER BY stop_sequence")
      .all(tripId);
    expect(stopTimesAfter).toEqual(stopTimesBefore);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM frequencies WHERE trip_id = ?").get(tripId).n,
    ).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE from_trip_id = ?").get(tripId).n,
    ).toBe(1);
  });
});
