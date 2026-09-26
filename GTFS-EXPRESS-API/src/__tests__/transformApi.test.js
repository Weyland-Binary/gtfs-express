/**
 * transformApi.test.js — the transformation loop over HTTP on a real
 * session: catalogue, overview, preview (nothing written), commit (one
 * edit), undo (the feed as it was), redo (the plan again).
 */

"use strict";

const { seedSession, teardownSession, removeUploadRoot, api } = require("./_helpers/sampleSession");

describe("transform API: preview → commit → undo → redo", () => {
  let sessionId;
  let db;
  const count = (sql) => db.prepare(sql).get().n;
  const plan = {
    title: "S1 every 6 min in the weekday morning",
    operations: [{ id: "h1", type: "set_headway", params: { route: "S1", days: "weekday", from: "07:00", to: "09:00", headway_min: 6 } }],
    requirements: { clauses: [{ id: "c1", kind: "headway_max", params: { line: "S1", day: "weekday", from: "07:00", to: "09:00", minutes: 6 } }] },
  };

  beforeAll(async () => {
    ({ sessionId, db } = await seedSession());
  });
  afterAll(() => {
    teardownSession(sessionId);
    removeUploadRoot();
  });

  test("the catalogue lists set_headway with its parameters", async () => {
    const r = await api(sessionId).get("/transform/operations");
    expect(r.status).toBe(200);
    const op = r.body.operations.find((o) => o.type === "set_headway");
    expect(op.params.map((p) => p.name)).toEqual(expect.arrayContaining(["route", "days", "from", "to", "headway_min"]));
  });

  test("the feed's health: quality, minimum fleet and consumer checks", async () => {
    const r = await api(sessionId).get("/transform/quality");
    expect(r.status).toBe(200);
    expect(r.body.grade).toMatch(/^[A-E]$/);
    expect(r.body.fleet.vehicles).toBeGreaterThan(0);
    expect(Array.isArray(r.body.checks)).toBe(true);
  });

  test("the overview gives each line its service per day type", async () => {
    const r = await api(sessionId).get("/transform/overview");
    expect(r.status).toBe(200);
    const s1 = r.body.routes.find((x) => x.id === "S1");
    expect(s1.service.weekday.trips).toBeGreaterThan(0);
  });

  test("full loop", async () => {
    const trips0 = count("SELECT COUNT(*) AS n FROM trips");
    const st0 = count("SELECT COUNT(*) AS n FROM stop_times");

    const pv = await api(sessionId).post("/transform/preview", { plan });
    expect(pv.status).toBe(200);
    expect(pv.body.blocked).toBe(false);
    expect(pv.body.id).toMatch(/^[a-f0-9]{18}$/);
    expect(pv.body.conformance.after.results[0].status).toBe("pass");
    // A preview writes nothing.
    expect(count("SELECT COUNT(*) AS n FROM trips")).toBe(trips0);

    const bad = await api(sessionId).post("/transform/commit", { previewId: "nope" });
    expect(bad.status).toBe(400);

    const cm = await api(sessionId).post("/transform/commit", { previewId: pv.body.id });
    expect(cm.status).toBe(200);
    const trips1 = count("SELECT COUNT(*) AS n FROM trips");
    const st1 = count("SELECT COUNT(*) AS n FROM stop_times");
    expect(trips1).not.toBe(trips0);

    // The same preview cannot be committed twice.
    const twice = await api(sessionId).post("/transform/commit", { previewId: pv.body.id });
    expect(twice.status).toBe(404);

    const un = await api(sessionId).undo();
    expect(un.status).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM trips")).toBe(trips0);
    expect(count("SELECT COUNT(*) AS n FROM stop_times")).toBe(st0);

    const re = await api(sessionId).redo();
    expect(re.status).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM trips")).toBe(trips1);
    expect(count("SELECT COUNT(*) AS n FROM stop_times")).toBe(st1);

    // The feed now conforms: a fresh preview of the same clause-only plan says so.
    const check = await api(sessionId).post("/transform/preview", { plan: { operations: [], requirements: plan.requirements } });
    expect(check.body.empty).toBe(true);
    expect(check.body.conformance.before.results[0].status).toBe("pass");
  });

  test("a preview taken before another edit is stale", async () => {
    const pv = await api(sessionId).post("/transform/preview", { plan: { operations: [{ type: "set_headway", params: { route: "S2", days: "weekday", from: "07:00", to: "09:00", headway_min: 5 } }] } });
    expect(pv.body.id).toBeTruthy();
    await api(sessionId).undo();
    const cm = await api(sessionId).post("/transform/commit", { previewId: pv.body.id });
    expect(cm.status).toBe(409);
    expect(cm.body.error).toBe("PREVIEW_STALE");
  });

  test("invalid plans are refused", async () => {
    const r = await api(sessionId).post("/transform/preview", { plan: { nope: true } });
    expect(r.status).toBe(400);
  });
});

describe("transform API: GTFS Diff export", () => {
  let sessionId;
  beforeAll(async () => {
    ({ sessionId } = await seedSession());
  });
  afterAll(() => teardownSession(sessionId));

  test("a preview exports as GTFS Diff v1 CSV and v2 JSON; unknown or foreign previews are refused", async () => {
    const pv = await api(sessionId).post("/transform/preview", { plan: { title: "rename", operations: [{ type: "set_headway", params: { route: "S1", days: "weekday", from: "07:00", to: "08:00", headway_min: 6 } }] } });
    const id = pv.body.id;
    const csv = await api(sessionId).get(`/transform/preview/${id}/gtfs-diff/csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csv.text.trim().split("\n");
    expect(lines[0]).toBe("id,file,action,target,identifier,initial_value,new_value,note");
    expect(lines.some((l) => /,trips\.txt,add,row,/.test(l))).toBe(true);
    expect(lines.some((l) => /,stop_times\.txt,delete,row,/.test(l))).toBe(true);
    const json = await api(sessionId).get(`/transform/preview/${id}/gtfs-diff/json`);
    expect(json.body.summary.rows_added).toBeGreaterThan(0);
    expect(json.body.file_diffs.map((f) => f.file_name)).toEqual(expect.arrayContaining(["trips.txt", "stop_times.txt"]));
    expect((await api(sessionId).get("/transform/preview/aaaaaaaaaaaaaaaaaa/gtfs-diff/csv")).status).toBe(404);
    expect((await api(sessionId).get(`/transform/preview/${id}/gtfs-diff/xml`)).status).toBe(400);
  });

  test("a preview's passenger information: alerts as JSON, GTFS-RT protobuf, a notice", async () => {
    const pv = await api(sessionId).post("/transform/preview", { plan: { title: "S1 renforcée", operations: [{ type: "set_headway", params: { route: "S1", days: "weekday", from_date: "2026-10-05", from: "07:00", to: "09:00", headway_min: 4 } }] } });
    const id = pv.body.id;
    expect(pv.body.passenger.length).toBeGreaterThan(0);
    const j = await api(sessionId).get(`/transform/preview/${id}/alerts?language=fr&cause=MAINTENANCE`);
    expect(j.status).toBe(200);
    expect(j.body.feed.entity[0].alert.effect).toBe("ADDITIONAL_SERVICE");
    expect(j.body.feed.entity[0].alert.cause).toBe("MAINTENANCE");
    expect(j.body.notice.text).toMatch(/Ligne S1 : service renforcé à partir du 5 octobre 2026/);
    const pb = await api(sessionId).get(`/transform/preview/${id}/alerts?format=pb`).buffer(true).parse((res, cb) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(pb.headers["content-type"]).toMatch(/application\/x-protobuf/);
    const { transit_realtime: rt } = require("gtfs-realtime-bindings");
    expect(rt.FeedMessage.decode(pb.body).entity.length).toBe(j.body.feed.entity.length);
    const txt = await api(sessionId).get(`/transform/preview/${id}/alerts?format=txt&language=en`);
    expect(txt.text).toMatch(/^Service change — S1 renforcée/);
    expect((await api(sessionId).get(`/transform/preview/${id}/alerts?format=xml`)).status).toBe(400);
    expect((await api(sessionId).get("/transform/preview/aaaaaaaaaaaaaaaaaa/alerts")).status).toBe(404);
  });
});
