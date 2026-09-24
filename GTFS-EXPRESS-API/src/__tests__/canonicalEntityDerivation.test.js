/**
 * canonicalEntityDerivation.test.js — entityType / entityId derived from the
 * flat id fields of MobilityData sample notices (the JAR never emits
 * `entityType` / `entityId` itself).
 */

"use strict";

const {
  parseReport,
  deriveEntity,
} = require("../services/canonicalValidatorService");

// Realistic excerpt of a report.json produced by gtfs-validator 5.x.
const REPORT = {
  summary: { validatorVersion: "5.0.1" },
  notices: [
    {
      code: "stop_time_with_arrival_before_previous_departure_time",
      severity: "ERROR",
      totalNotices: 1,
      sampleNotices: [
        {
          csvRowNumber: 812,
          prevCsvRowNumber: 811,
          tripId: "S1_WKD_0_001",
          stopSequence: 7,
          prevStopSequence: 6,
          arrivalTime: "05:40:00",
          departureTime: "05:41:00",
        },
      ],
    },
    {
      code: "missing_required_field",
      severity: "ERROR",
      totalNotices: 1,
      sampleNotices: [
        {
          filename: "stops.txt",
          csvRowNumber: 14,
          fieldName: "stop_name",
          stopId: "INW_S",
        },
      ],
    },
    {
      code: "invalid_color",
      severity: "ERROR",
      totalNotices: 1,
      sampleNotices: [
        {
          filename: "routes.txt",
          csvRowNumber: 3,
          fieldName: "route_color",
          fieldValue: "ZZZZZZ",
          routeId: "S2",
        },
      ],
    },
    {
      code: "expired_calendar",
      severity: "WARNING",
      totalNotices: 1,
      sampleNotices: [
        { filename: "calendar.txt", csvRowNumber: 2, serviceId: "WKD", endDate: "20240101" },
      ],
    },
    {
      code: "unusable_trip",
      severity: "WARNING",
      totalNotices: 1,
      sampleNotices: [{ filename: "trips.txt", csvRowNumber: 99, tripId: "S1_WKD_0_042" }],
    },
    {
      code: "calendar_has_no_active_days",
      severity: "WARNING",
      totalNotices: 1,
      sampleNotices: [
        { filename: "calendar_dates.txt", csvRowNumber: 5, serviceId: "HOL", date: "20260704" },
      ],
    },
    {
      code: "overlapping_frequency",
      severity: "ERROR",
      totalNotices: 1,
      sampleNotices: [
        {
          filename: "frequencies.txt",
          csvRowNumber: 2,
          tripId: "N1_NIT_0_001",
          startTime: "01:00:00",
          endTime: "05:00:00",
        },
      ],
    },
    {
      code: "station_with_parent_station",
      severity: "ERROR",
      totalNotices: 1,
      sampleNotices: [
        { filename: "stops.txt", csvRowNumber: 21, childId: "HUB_34F", parentId: "OTHER" },
      ],
    },
    {
      code: "invalid_url",
      severity: "ERROR",
      totalNotices: 1,
      sampleNotices: [
        {
          filename: "agency.txt",
          csvRowNumber: 2,
          fieldName: "agency_url",
          fieldValue: "htp:/broken",
          agencyId: "NYCDEMO",
        },
      ],
    },
    {
      code: "fast_travel_between_consecutive_stops",
      severity: "WARNING",
      totalNotices: 1,
      sampleNotices: [
        {
          filename: "stop_times.txt",
          tripCsvRowNumber: 4,
          tripId: "B1_WKD_0_001",
          routeId: "B1",
          speedKph: 240.5,
        },
      ],
    },
  ],
};

const findingsByCode = (report) => {
  const out = {};
  for (const list of Object.values(report.errors)) {
    for (const f of list) {
      if (!f.aggregate) out[f.ruleCode] = f;
    }
  }
  return out;
};

describe("deriveEntity — priority rules", () => {
  test("composite keys win over single ids", () => {
    expect(deriveEntity({ tripId: "T1", stopSequence: 3 })).toEqual({
      entityType: "stop_time",
      entityId: "T1:3",
    });
    expect(deriveEntity({ serviceId: "S", date: "20260101" })).toEqual({
      entityType: "calendar_date",
      entityId: "S:20260101",
    });
    expect(deriveEntity({ tripId: "T1", startTime: "06:00:00" })).toEqual({
      entityType: "frequency",
      entityId: "T1:06:00:00",
    });
  });

  test("single ids in priority order, childId maps to stop", () => {
    expect(deriveEntity({ tripId: "T", routeId: "R" }).entityType).toBe("trip");
    expect(deriveEntity({ stopId: "S", routeId: "R" }).entityType).toBe("stop");
    expect(deriveEntity({ childId: "S" })).toEqual({ entityType: "stop", entityId: "S" });
    expect(deriveEntity({ shapeId: "SH" })).toEqual({ entityType: "shape", entityId: "SH" });
    expect(deriveEntity({ agencyId: "A" })).toEqual({ entityType: "agency", entityId: "A" });
    expect(deriveEntity({ pathwayId: "P" })).toEqual({ entityType: "pathway", entityId: "P" });
    expect(deriveEntity({ levelId: "L" })).toEqual({ entityType: "level", entityId: "L" });
    expect(deriveEntity({ fareId: "F" })).toEqual({
      entityType: "fare_attribute",
      entityId: "F",
    });
  });

  test("filename + <table>_id fallback, else nulls", () => {
    expect(deriveEntity({ filename: "levels.txt", level_id: "L2" })).toEqual({
      entityType: "level",
      entityId: "L2",
    });
    expect(
      deriveEntity({ filename: "stops.txt", fieldName: "stop_id", fieldValue: "X1" }),
    ).toEqual({ entityType: "stop", entityId: "X1" });
    expect(deriveEntity({ filename: "stops.txt", csvRowNumber: 3 })).toEqual({
      entityType: null,
      entityId: null,
    });
    expect(deriveEntity({ csvRowNumber: 3 })).toEqual({ entityType: null, entityId: null });
  });

  test("explicit entityType / entityId are kept verbatim", () => {
    expect(deriveEntity({ entityType: "agency", entityId: "AG1", stopId: "S" })).toEqual({
      entityType: "agency",
      entityId: "AG1",
    });
  });
});

describe("parseReport — derived entity on realistic notices", () => {
  const report = parseReport(REPORT);
  const byCode = findingsByCode(report);

  test("stop_time notice → stop_time / trip:sequence", () => {
    const f = byCode.stop_time_with_arrival_before_previous_departure_time;
    expect(f.entityType).toBe("stop_time");
    expect(f.entityId).toBe("S1_WKD_0_001:7");
  });

  test("missing_required_field on stops.txt with stopId → stop", () => {
    expect(byCode.missing_required_field.entityType).toBe("stop");
    expect(byCode.missing_required_field.entityId).toBe("INW_S");
    expect(byCode.missing_required_field.field).toBe("stop_name");
  });

  test("invalid_color with routeId → route", () => {
    expect(byCode.invalid_color.entityType).toBe("route");
    expect(byCode.invalid_color.entityId).toBe("S2");
  });

  test("expired_calendar with serviceId → calendar", () => {
    expect(byCode.expired_calendar.entityType).toBe("calendar");
    expect(byCode.expired_calendar.entityId).toBe("WKD");
  });

  test("unusable_trip with tripId → trip", () => {
    expect(byCode.unusable_trip.entityType).toBe("trip");
    expect(byCode.unusable_trip.entityId).toBe("S1_WKD_0_042");
  });

  test("serviceId + date → calendar_date, tripId + startTime → frequency", () => {
    expect(byCode.calendar_has_no_active_days.entityType).toBe("calendar_date");
    expect(byCode.calendar_has_no_active_days.entityId).toBe("HOL:20260704");
    expect(byCode.overlapping_frequency.entityType).toBe("frequency");
    expect(byCode.overlapping_frequency.entityId).toBe("N1_NIT_0_001:01:00:00");
  });

  test("stop hierarchy childId → stop, agencyId → agency, tripId beats routeId", () => {
    expect(byCode.station_with_parent_station.entityType).toBe("stop");
    expect(byCode.station_with_parent_station.entityId).toBe("HUB_34F");
    expect(byCode.invalid_url.entityType).toBe("agency");
    expect(byCode.invalid_url.entityId).toBe("NYCDEMO");
    expect(byCode.fast_travel_between_consecutive_stops.entityType).toBe("trip");
    expect(byCode.fast_travel_between_consecutive_stops.entityId).toBe("B1_WKD_0_001");
  });

  test("context carries the derived entityId FIRST, engine fields after", () => {
    const f = byCode.invalid_color;
    expect(Object.keys(f.context)[0]).toBe("entityId");
    expect(f.context.entityId).toBe("S2");
    expect(f.context.routeId).toBe("S2");
    expect(f.context.fieldValue).toBe("ZZZZZZ");
    // The engine-only context of a bare-code notice stays untouched.
    const c = byCode.stop_time_with_arrival_before_previous_departure_time.context;
    expect(c.entityId).toBe("S1_WKD_0_001:7");
    expect(c.prevStopSequence).toBe("6");
  });

  test("aggregate tail markers keep null entities", () => {
    const tailReport = parseReport({
      notices: [
        {
          code: "invalid_color",
          severity: "ERROR",
          totalNotices: 4,
          sampleNotices: [{ filename: "routes.txt", routeId: "R1" }],
        },
      ],
    });
    const list = tailReport.errors["routes.txt"];
    expect(list[0].entityId).toBe("R1");
    expect(list[1].aggregate).toBe(true);
    expect(list[1].entityId).toBeNull();
  });
});
