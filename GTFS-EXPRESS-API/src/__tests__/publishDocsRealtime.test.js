/**
 * publishDocsRealtime.test.js — batch 3: published versions of a share
 * with a changelog and a secret, print-ready passenger documents (line
 * timetable, stop poster), and the GTFS-Realtime check against the static
 * feed (protobuf and JSON inputs).
 */

"use strict";

process.env.BETA_GATE_DISABLED = "true";
process.env.SHARES_DIR = require("path").join(require("os").tmpdir(), `gtfs-shares-publish-${process.pid}`);

const fs = require("fs");
const path = require("path");
const request = require("supertest");
const { transit_realtime } = require("gtfs-realtime-bindings");
const app = require("../app");
const { removeUploadRoot } = require("./_helpers/sampleSession");
const connection = require("../services/db/connection");
const share = require("../services/shareService");
const realtime = require("../services/realtimeService");
const documents = require("../services/documentsService");

const SPEC = {
  agency: { name: "Docs Mobilités", url: "https://docs.example", timezone: "Europe/Paris" },
  feed: { start_date: "20260101", end_date: "20271231" },
  stops: [{ id: "a", name: "Centre", lat: 47.0, lon: 1.0 }, { id: "b", name: "Poste", lat: 47.0, lon: 1.01 }, { id: "c", name: "Gare", lat: 47.0, lon: 1.03 }, { id: "d", name: "Hôpital", lat: 47.02, lon: 1.0 }],
  lines: [
    { id: "A", short_name: "A", mode: "bus", color: "E53935", directions: [{ headsign: "Gare", stops: ["a", "b", "c"] }], services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 15 }] }, { calendar: "saturday", periods: [{ from: "09:00", to: "12:00", headway_min: 60 }] }] },
    { id: "B", short_name: "B", mode: "bus", directions: [{ headsign: "Hôpital", stops: ["a", "d"] }], services: [{ calendar: "weekday", departures: ["07:30", "12:30", "17:30"] }] },
  ],
};

let sessionId;
let token;
let secret;

beforeAll(async () => {
  const built = await request(app).post("/gtfs/network/compile").send({ spec: SPEC, options: { routing: "straight" } });
  expect(built.status).toBe(201);
  sessionId = built.body.sessionId;
});

afterAll(() => {
  connection.closeAllDbHandles?.();
  fs.rmSync(share.SHARES_DIR, { recursive: true, force: true });
  removeUploadRoot();
});

describe("published versions", () => {
  test("creating a share returns a secret; publishing a new version needs it and records a changelog", async () => {
    const created = await request(app).post("/gtfs/share").set("X-Session-ID", sessionId).send({ title: "Réseau publié" });
    expect(created.status).toBe(201);
    token = created.body.token;
    secret = created.body.secret;
    expect(secret).toMatch(/^[a-f0-9]{32}$/);
    expect(created.body.card.secret_hash).toBeUndefined();
    expect(created.body.card.current_version).toBe(1);
    expect(created.body.card.versions).toHaveLength(1);
    // Edit the session: rename a stop, add a route.
    const enter = await request(app).post("/gtfs/edit/enter").set("X-Session-ID", sessionId).send({});
    expect([200, 201]).toContain(enter.status);
    const rename = await request(app).patch("/gtfs/edit/stops/a").set("X-Session-ID", sessionId).send({ stop_name: "Centre-ville" });
    expect(rename.status).toBe(200);
    const removed = await request(app).delete("/gtfs/edit/stops/d").set("X-Session-ID", sessionId).send({});
    expect([200, 204, 400, 409]).toContain(removed.status);
    // Wrong secret → 403; right secret → version 2 with a changelog.
    const forbidden = await request(app).post(`/gtfs/share/${token}/versions`).set("X-Session-ID", sessionId).set("X-Share-Secret", "0".repeat(32)).send({ note: "x" });
    expect(forbidden.status).toBe(403);
    const v2 = await request(app).post(`/gtfs/share/${token}/versions`).set("X-Session-ID", sessionId).set("X-Share-Secret", secret).send({ note: "Renamed the centre stop" });
    expect(v2.status).toBe(201);
    expect(v2.body.version.n).toBe(2);
    expect(v2.body.version.note).toBe("Renamed the centre stop");
    expect(v2.body.version.changelog.counts).toMatchObject({ routes: 0 });
    expect(v2.body.card.current_version).toBe(2);
    expect(v2.body.card.versions).toHaveLength(2);
    expect(v2.body.card.secret_hash).toBeUndefined();
    // The root serves the latest (renamed stop); version 1 is archived and still downloadable.
    const stopsNow = fs.readFileSync(path.join(share.SHARES_DIR, token, "stops.txt"), "utf8");
    expect(stopsNow).toMatch(/Centre-ville/);
    const stopsV1 = fs.readFileSync(path.join(share.SHARES_DIR, token, "versions", "1", "stops.txt"), "utf8");
    expect(stopsV1).not.toMatch(/Centre-ville/);
    const parse = (r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    };
    const zipV1 = await request(app).get(`/gtfs/share/${token}/gtfs.zip?v=1`).buffer(true).parse(parse);
    expect(zipV1.status).toBe(200);
    expect(zipV1.headers["content-disposition"]).toMatch(/-v1\.zip/);
    const zipMissing = await request(app).get(`/gtfs/share/${token}/gtfs.zip?v=9`);
    expect(zipMissing.status).toBe(404);
    // The public card lists the versions and never the secret.
    const card = await request(app).get(`/gtfs/share/${token}`);
    expect(card.body.versions.map((v) => v.n)).toEqual([1, 2]);
    expect(card.body.secret_hash).toBeUndefined();
    // Opening the share gives the latest state.
    const opened = await request(app).post(`/gtfs/share/${token}/open`);
    expect(opened.status).toBe(201);
    const { GTFS_UPLOAD_DIR } = require("../services/sessionManager");
    expect(fs.readFileSync(path.join(GTFS_UPLOAD_DIR, opened.body.sessionId, "stops.txt"), "utf8")).toMatch(/Centre-ville/);
  });

  test("the changelog names the routes and stops added or removed", async () => {
    const dirA = path.join(share.SHARES_DIR, "_tmpA");
    const dirB = path.join(share.SHARES_DIR, "_tmpB");
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, "routes.txt"), "route_id,route_short_name\nR1,1\nR2,2\n");
    fs.writeFileSync(path.join(dirB, "routes.txt"), "route_id,route_short_name\nR1,1\nR3,3\n");
    fs.writeFileSync(path.join(dirA, "stops.txt"), "stop_id,stop_name\nS1,Gare\n");
    fs.writeFileSync(path.join(dirB, "stops.txt"), "stop_id,stop_name\nS1,Gare\nS2,Mairie\n");
    const c = await share._internals.changelogBetween(dirA, dirB, { routes: 2, stops: 1, trips: 10 }, { routes: 2, stops: 2, trips: 12 });
    expect(c).toEqual({ counts: { routes: 0, stops: 1, trips: 2, stop_times: 0 }, routes: { added: ["3"], removed: ["2"] }, stops: { added: ["Mairie"], removed: [] } });
  });
});

describe("passenger documents", () => {
  test("the line timetable is print-ready HTML with a matrix for a sparse line and a grid for a frequent one", async () => {
    // A weekday: line A has 49 trips per direction → grid; line B 3 → matrix.
    const gridRes = await request(app).get("/gtfs/documents/timetable").query({ route_id: "A", date: "20260112", lang: "fr" }).set("X-Session-ID", sessionId);
    expect(gridRes.status).toBe(200);
    expect(gridRes.headers["content-type"]).toMatch(/text\/html/);
    expect(gridRes.text).toMatch(/Fiche horaire/);
    expect(gridRes.text).toMatch(/lun\. 12\/01\/2026/);
    expect(gridRes.text).toMatch(/class="grid"/);
    expect(gridRes.text).toMatch(/Direction Gare/);
    expect(gridRes.text).toMatch(/07h/);
    expect(gridRes.text).toMatch(/#E53935/);
    const matrixRes = await request(app).get("/gtfs/documents/timetable").query({ route_id: "B", date: "20260112" }).set("X-Session-ID", sessionId);
    expect(matrixRes.status).toBe(200);
    expect(matrixRes.text).toMatch(/Towards Hôpital/);
    expect(matrixRes.text).toMatch(/<th>07:30<\/th>/);
    expect(matrixRes.text).not.toMatch(/class="grid"/);
    // A Sunday: no service → the next day with service is shown and said.
    const shifted = await request(app).get("/gtfs/documents/timetable").query({ route_id: "A", date: "20260111", lang: "en" }).set("X-Session-ID", sessionId);
    expect(shifted.text).toMatch(/No service on the requested date; showing Mon 12\/01\/2026/);
    const missing = await request(app).get("/gtfs/documents/timetable").query({ route_id: "ZZ" }).set("X-Session-ID", sessionId);
    expect(missing.status).toBe(404);
    const bad = await request(app).get("/gtfs/documents/timetable").set("X-Session-ID", sessionId);
    expect(bad.status).toBe(400);
  });

  test("the stop poster lists departures per line and direction with first/last", async () => {
    const res = await request(app).get("/gtfs/documents/stop").query({ stop_id: "a", date: "20260112", lang: "fr" }).set("X-Session-ID", sessionId);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/Centre-ville|Centre/);
    expect(res.text).toMatch(/Direction Gare/);
    expect(res.text).toMatch(/Premier \/ dernier 07:00 \/ 19:00/);
    expect(res.text).toMatch(/Direction Hôpital/);
    expect(res.text).toMatch(/07:30 \/ 17:30/);
    // The terminus has no departures towards itself.
    const term = await request(app).get("/gtfs/documents/stop").query({ stop_id: "c", date: "20260112" }).set("X-Session-ID", sessionId);
    expect(term.text).not.toMatch(/Towards Gare/);
    expect(documents._internals.hourGrid([7 * 3600, 7 * 3600 + 900, 8 * 3600 + 60])).toEqual([[7, [0, 15]], [8, [1]]]);
  });
});

describe("GTFS-Realtime check", () => {
  const now = Math.floor(Date.now() / 1000);
  const feedObject = {
    header: { gtfsRealtimeVersion: "2.0", incrementality: "FULL_DATASET", timestamp: now - 30 },
    entity: [
      { id: "1", tripUpdate: { trip: { tripId: "A_WKD_0_001", routeId: "A" }, stopTimeUpdate: [{ stopSequence: 1, stopId: "a", departure: { delay: 60 } }, { stopSequence: 2, stopId: "b", arrival: { delay: 120 } }] } },
      { id: "2", tripUpdate: { trip: { tripId: "ghost", routeId: "A" }, stopTimeUpdate: [{ stopSequence: 1, stopId: "a", departure: { delay: 5 * 3600 } }] } },
      { id: "3", tripUpdate: { trip: { tripId: "A_WKD_0_002" }, stopTimeUpdate: [{ stopSequence: 3, stopId: "c", arrival: { delay: 0 } }, { stopSequence: 2, stopId: "d", arrival: { delay: 0 } }] } },
      { id: "4", vehicle: { trip: { tripId: "A_WKD_0_001" }, position: { latitude: 47.001, longitude: 1.005, speed: 12 }, timestamp: now - 10 } },
      { id: "5", vehicle: { trip: { tripId: "A_WKD_0_003" }, position: { latitude: 48.9, longitude: 2.3 }, timestamp: now - 3600 } },
      { id: "5", alert: { activePeriod: [{ start: now, end: now - 10 }], informedEntity: [{ routeId: "Z" }], headerText: { translation: [{ text: "", language: "fr" }] } } },
      { id: "6", alert: { informedEntity: [{ routeId: "A" }], headerText: { translation: [{ text: "Travaux", language: "fr" }] } } },
    ],
  };

  test("decodes protobuf and JSON feeds and reports what a journey planner would trip on", async () => {
    const message = transit_realtime.FeedMessage.fromObject(feedObject);
    const buffer = Buffer.from(transit_realtime.FeedMessage.encode(message).finish());
    const res = await request(app).post("/gtfs/realtime/validate").set("X-Session-ID", sessionId).set("Content-Type", "application/x-protobuf").send(buffer);
    expect(res.status).toBe(200);
    expect(res.body.summary).toMatchObject({ entities: 7, trip_updates: 3, vehicle_positions: 2, alerts: 2, version: "2.0" });
    const codes = Object.fromEntries(res.body.findings.map((f) => [f.code, f]));
    expect(codes.unknown_trip.count).toBe(1);
    expect(codes.unknown_trip.severity).toBe("error");
    expect(codes.absurd_delay.count).toBe(1);
    expect(codes.stop_sequence_order.count).toBe(1);
    expect(codes.stop_not_on_trip.count).toBe(1);
    expect(codes.vehicle_outside_network.count).toBe(1);
    expect(codes.stale_vehicle.count).toBe(1);
    expect(codes.duplicate_entity_id.count).toBe(1);
    expect(codes.alert_without_text.count).toBe(1);
    expect(codes.alert_period_inverted.count).toBe(1);
    expect(codes.unknown_route.count).toBe(1);
    expect(codes.stale_header).toBeUndefined();
    expect(res.body.ok).toBe(false);
    // The same feed as JSON.
    const json = await request(app).post("/gtfs/realtime/validate").set("X-Session-ID", sessionId).send({ feed: feedObject });
    expect(json.status).toBe(200);
    expect(json.body.counts).toEqual(res.body.counts);
    // A clean feed is ok.
    const clean = await request(app).post("/gtfs/realtime/validate").set("X-Session-ID", sessionId).send({ feed: { header: { gtfsRealtimeVersion: "2.0", timestamp: now }, entity: [feedObject.entity[0], feedObject.entity[3], feedObject.entity[6]] } });
    expect(clean.body.ok).toBe(true);
    expect(clean.body.findings).toEqual([]);
    // Garbage is a 400; a stale header is a warning.
    const bad = await request(app).post("/gtfs/realtime/validate").set("X-Session-ID", sessionId).set("Content-Type", "application/x-protobuf").send(Buffer.from("not a feed at all, really not"));
    expect(bad.status).toBe(400);
    const stale = realtime.checkFeed({ header: { gtfsRealtimeVersion: "2.0", timestamp: now - 3600 }, entity: [] }, realtime.staticIndex(connection.ensureDbHandle(sessionId)), { now });
    expect(stale.findings.map((f) => f.code)).toEqual(["stale_header"]);
    const none = await request(app).post("/gtfs/realtime/validate").set("X-Session-ID", sessionId).send({});
    expect(none.status).toBe(400);
  });

  test("fetches a feed from a URL", async () => {
    const message = transit_realtime.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: "2.0", timestamp: now }, entity: [feedObject.entity[0]] });
    const buffer = Buffer.from(transit_realtime.FeedMessage.encode(message).finish());
    realtime.validateRealtime._fetch = async () => ({ ok: true, headers: { get: () => "application/x-protobuf" }, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) });
    try {
      const res = await request(app).post("/gtfs/realtime/validate").set("X-Session-ID", sessionId).send({ url: "https://rt.example/feed.pb" });
      expect(res.status).toBe(200);
      expect(res.body.summary.trip_updates).toBe(1);
      const bad = await request(app).post("/gtfs/realtime/validate").set("X-Session-ID", sessionId).send({ url: "ftp://nope" });
      expect(bad.status).toBe(400);
    } finally {
      delete realtime.validateRealtime._fetch;
    }
  });
});
