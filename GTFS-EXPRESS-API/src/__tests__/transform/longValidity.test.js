/**
 * A feed valid for decades (end_date 20991231, a common open-ended convention) is read to its end: a change on one
 * date keeps every service's period. The feed model and the scopes used to read the first 1200 days only, so the
 * services a change rewrote ended about three years after the feed's start — silently, the diff being read on the
 * same 1200 days (calendars.MAX_RANGE_DAYS is now a runaway guard, a century).
 */

"use strict";

const { sampleSession } = require("../_helpers/session");
const { getEditDb } = require("../../services/db/connection");
const engine = require("../../services/transform/engine");
const { sandboxOf } = require("../../services/transform/changeset");
const calendars = require("../../services/transform/calendars");

test("rangeDates reads a century, not 1200 days", () => {
  const dates = calendars.rangeDates("20260101", "20991231");
  expect(dates[dates.length - 1]).toBe("20991231");
  expect(calendars.rangeDates("20260101", "99991231").length).toBe(calendars.MAX_RANGE_DAYS);
});

test("a one-day suspension on a feed valid until 2099 keeps the services' end date", async () => {
  const sessionId = await sampleSession();
  const db = getEditDb(sessionId);
  db.prepare("UPDATE calendar SET end_date = '20991231'").run();
  const route = db.prepare("SELECT route_id FROM routes ORDER BY route_id LIMIT 1").get();

  const preview = await engine.previewPlan(db, { title: "14 July", operations: [{ type: "suspend_service", params: { routes: [route.route_id], from_date: "2026-07-14", to_date: "2026-07-14" } }] }, { sessionId });
  expect(preview.steps[0].status).toBe("applied");

  const after = sandboxOf(db);
  try {
    engine.applyToSandbox(sessionId, preview.id, after);
    const services = after.prepare("SELECT service_id, end_date FROM calendar").all();
    expect(services.length).toBeGreaterThan(0);
    for (const s of services) expect({ service_id: s.service_id, end_date: String(s.end_date) }).toEqual({ service_id: s.service_id, end_date: "20991231" });
    // The suspended date is an exception of the line's new service, not the end of its period.
    const created = services.filter((s) => s.service_id.includes("~")).map((s) => s.service_id);
    expect(created.length).toBeGreaterThan(0);
    const removed = after.prepare(`SELECT date FROM calendar_dates WHERE exception_type = 2 AND service_id IN (${created.map(() => "?").join(",")})`).all(...created).map((r) => String(r.date));
    expect(removed).toContain("20260714");
  } finally {
    after.close();
  }
});
