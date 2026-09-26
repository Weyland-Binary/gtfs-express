/**
 * transformPassenger.test.js — what riders are told about a plan, from what
 * it really changes: GTFS-RT service alerts (effect, active period in the
 * agency's timezone, lines and stops) that the realtime validator accepts
 * on the changed feed, and a notice in French or English — on the real
 * Albi feed (a works detour on two lines, a frequency increase from a
 * date, a line withdrawn) and over HTTP.
 */

"use strict";

const { loadReal } = require("./_helpers/feedDb");
const { previewPlan, commitPreview } = require("../services/transform/engine");
const { renderAlerts, encodeFeed, _internals } = require("../services/transform/passengerInfo");
const { checkFeed, staticIndex, decodeFeed } = require("../services/realtimeService");
const registry = require("../services/transform/operators");

// Tests that need operators of a family not in the catalogue yet are skipped.
const withOps = (...types) => (types.every((t) => registry.get(t)) ? test : test.skip);

const DETOUR = {
  title: "Travaux secteur cathédrale",
  operations: [
    { type: "reroute", params: { route: "B", from_stop: "Place Perret", to_stop: "Les Mines", via: [{ name: "Sainte-Cécile provisoire", lat: 43.9405, lon: 2.1486 }], from_date: "2026-11-02", to_date: "2026-11-20", mode: "absorb" } },
    { type: "reroute", params: { route: "C", direction: "0", from_stop: "Provence", to_stop: "Les Mines", via: [{ name: "Sainte-Cécile provisoire", lat: 43.9405, lon: 2.1486 }], from_date: "2026-11-02", to_date: "2026-11-20", mode: "absorb" } },
    { type: "reroute", params: { route: "C", direction: "1", from_stop: "Les Mines", to_stop: "Majesté", via: [{ name: "Sainte-Cécile provisoire", lat: 43.9405, lon: 2.1486 }], from_date: "2026-11-02", to_date: "2026-11-20", mode: "absorb" } },
  ],
};

describe("passenger information from a plan", () => {
  withOps("reroute")("a works detour on two lines is one DETOUR alert, valid GTFS-RT on the changed feed", async () => {
    const db = loadReal("albi");
    const p = await previewPlan(db, DETOUR, { sessionId: "t" });
    expect(p.blocked).toBe(false);
    expect(p.passenger).toHaveLength(1);
    const a = p.passenger[0];
    expect(a.effect).toBe("DETOUR");
    expect(a.routes.map((r) => r.label).sort()).toEqual(["B", "C"]);
    expect(a.period).toEqual({ from: "20261102", to: "20261120" });
    expect(a.open_ended).toBe(false);
    expect([...new Set(a.stops.lost.map((s) => s.name))].sort()).toEqual(["Sainte-Cécile", "Soulages"]);
    expect(a.stops.gained.map((s) => s.name)).toEqual(["Sainte-Cécile provisoire"]);

    const out = renderAlerts(p.passenger, { language: "fr", timezone: "Europe/Paris", cause: "construction", now: 1790000000, title: DETOUR.title });
    const al = out.feed.entity[0].alert;
    expect(al.cause).toBe("CONSTRUCTION");
    expect(al.headerText.translation[0]).toEqual({ text: "Lignes B, C : déviation du 2 au 20 novembre 2026", language: "fr" });
    expect(al.descriptionText.translation[0].text).toBe("Arrêts non desservis : Sainte-Cécile, Soulages.\nArrêt desservi : Sainte-Cécile provisoire.");
    // 2 Nov 00:00 in Paris (UTC+1) → 20 Nov + 1 day 04:00.
    expect(al.activePeriod[0]).toEqual({ start: Date.UTC(2026, 10, 1, 23) / 1000, end: Date.UTC(2026, 10, 21, 3) / 1000 });
    expect(al.informedEntity).toEqual(expect.arrayContaining([{ routeId: "114" }, { routeId: "112" }]));
    expect(out.notice.text).toMatch(/^Information voyageurs — Travaux secteur cathédrale\n\nLignes B, C : déviation/);

    // The protobuf the app would publish, checked by the realtime validator on the changed feed.
    commitPreview("t", db, p.id);
    const decoded = decodeFeed({ buffer: encodeFeed(out.feed) });
    const r = checkFeed(decoded, staticIndex(db), { now: 1790000000 });
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(r.findings.map((f) => f.code)).not.toContain("unknown_stop");
  });

  withOps("discontinue_route")("more service from a date is open-ended; a line withdrawn is NO_SERVICE without stop noise", async () => {
    const more = await previewPlan(loadReal("albi"), { operations: [{ type: "set_headway", params: { route: "C", days: "weekday", period: "school_days", region: "C", from_date: "2026-11-02", from: "07:00", to: "09:00", headway_min: 10 } }] }, { sessionId: "t", country: "FR", fetchImpl: frozen() });
    const main = more.passenger.find((a) => a.period.from === "20261102");
    expect(main.effect).toBe("ADDITIONAL_SERVICE");
    expect(main.open_ended).toBe(true);
    expect(main.facts).toEqual(expect.arrayContaining([{ code: "headway", period: "am_peak", before: 15, after: 10 }]));
    const en = renderAlerts(more.passenger, { language: "en", timezone: "Europe/Paris" });
    expect(en.feed.entity[0].alert.headerText.translation[0].text).toBe("Line C: more service from 2 November 2026");
    expect(en.feed.entity[0].alert.descriptionText.translation[0].text).toMatch(/^Monday to Friday, 7–9 am: every 10 min \(was 15\)\./);
    expect(en.feed.entity[0].alert.activePeriod[0].end).toBeUndefined();

    const gone = await previewPlan(loadReal("albi"), { operations: [{ type: "discontinue_route", params: { route: "J", from_date: "2027-01-04" } }] }, { sessionId: "t" });
    expect(gone.passenger).toHaveLength(1);
    expect(gone.passenger[0]).toEqual(expect.objectContaining({ effect: "NO_SERVICE", period: expect.objectContaining({ from: "20270104" }), open_ended: true }));
    expect(gone.passenger[0].stops.lost).toEqual([]);
    const fr = renderAlerts(gone.passenger, { language: "fr" });
    expect(fr.feed.entity[0].alert.headerText.translation[0].text).toBe("Ligne J : ne circule pas à partir du 4 janvier 2027");
  });

  test("local midnight in the agency's timezone, summer and winter", () => {
    expect(_internals.zonedEpoch("20260701", 0, "Europe/Paris")).toBe(Date.UTC(2026, 5, 30, 22) / 1000);
    expect(_internals.zonedEpoch("20260105", 0, "America/New_York")).toBe(Date.UTC(2026, 0, 5, 5) / 1000);
    expect(_internals.zonedEpoch("20260105", 0, null)).toBe(Date.UTC(2026, 0, 5) / 1000);
  });
});

// The frozen calendar service of the golden cases (school holidays of zone C from the feed).
const frozen = () => {
  const path = require("path");
  const fm = require("../services/transform/feedModel");
  const S = require("../services/transform/scope");
  const { frozenFetch } = require(path.join(__dirname, "../../../eval/transform/cases.js"));
  return frozenFetch(fm.buildFeedModel(loadReal("albi")), S, fm);
};
