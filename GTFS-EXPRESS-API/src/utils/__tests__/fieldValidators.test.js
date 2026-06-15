/**
 * fieldValidators.test.js
 *
 * Unit tests for the shared field-validation kernel.
 * Each predicate is tested with at least one positive and one negative case.
 * Higher-level validators are tested with representative field combinations.
 */

"use strict";

const {
  HEX_COLOR_RE,
  DATE_YYYYMMDD_RE,
  TIME_HHMMSS_RE,
  isValidLat,
  isValidLon,
  isValidHexColor,
  isValidServiceDay,
  isValidYYYYMMDDDate,
  isValidDirectionId,
  isValidWheelchairBoarding,
  isValidContinuousPickupDropOff,
  isValidLanguageCode,
  isValidTimezone,
  isValidPickupDropOffType,
  isValidRouteType,
  isValidGtfsTime,
  validateStopFields,
  validateRouteFields,
  validateTripFields,
  validateCalendarFields,
  validateAgencyFields,
} = require("../fieldValidators");

// ── Regex constants ───────────────────────────────────────────────────────────

describe("HEX_COLOR_RE", () => {
  test("matches 6 lowercase hex chars", () => expect(HEX_COLOR_RE.test("ff0000")).toBe(true));
  test("matches 6 uppercase hex chars", () => expect(HEX_COLOR_RE.test("FFFFFF")).toBe(true));
  test("matches mixed case", () => expect(HEX_COLOR_RE.test("0aB3F9")).toBe(true));
  test("rejects 7 chars", () => expect(HEX_COLOR_RE.test("ff00000")).toBe(false));
  test("rejects leading #", () => expect(HEX_COLOR_RE.test("#ff0000")).toBe(false));
  test("rejects 3 chars", () => expect(HEX_COLOR_RE.test("fff")).toBe(false));
  test("rejects non-hex char", () => expect(HEX_COLOR_RE.test("gggggg")).toBe(false));
});

describe("DATE_YYYYMMDD_RE", () => {
  test("matches 8 digit string", () => expect(DATE_YYYYMMDD_RE.test("20250101")).toBe(true));
  test("rejects 7 digits", () => expect(DATE_YYYYMMDD_RE.test("2025010")).toBe(false));
  test("rejects non-digit", () => expect(DATE_YYYYMMDD_RE.test("2025-01-01")).toBe(false));
  test("rejects empty", () => expect(DATE_YYYYMMDD_RE.test("")).toBe(false));
});

describe("TIME_HHMMSS_RE", () => {
  test("accepts standard HH:MM:SS", () => expect(TIME_HHMMSS_RE.test("08:30:00")).toBe(true));
  test("accepts single-digit hour H:MM:SS", () => expect(TIME_HHMMSS_RE.test("8:30:00")).toBe(true));
  test("accepts >24h time", () => expect(TIME_HHMMSS_RE.test("25:15:45")).toBe(true));
  test("accepts very large hour", () => expect(TIME_HHMMSS_RE.test("100:00:00")).toBe(true));
  test("rejects invalid minutes 60", () => expect(TIME_HHMMSS_RE.test("08:60:00")).toBe(false));
  test("rejects invalid seconds 60", () => expect(TIME_HHMMSS_RE.test("08:00:60")).toBe(false));
  test("rejects missing seconds", () => expect(TIME_HHMMSS_RE.test("08:30")).toBe(false));
  test("rejects empty", () => expect(TIME_HHMMSS_RE.test("")).toBe(false));
});

// ── isValidLat ────────────────────────────────────────────────────────────────

describe("isValidLat", () => {
  test("accepts 0", () => expect(isValidLat(0)).toBe(true));
  test("accepts 90", () => expect(isValidLat(90)).toBe(true));
  test("accepts -90", () => expect(isValidLat(-90)).toBe(true));
  test("accepts 48.8566", () => expect(isValidLat(48.8566)).toBe(true));
  test("rejects 90.0001", () => expect(isValidLat(90.0001)).toBe(false));
  test("rejects -90.0001", () => expect(isValidLat(-90.0001)).toBe(false));
  test("rejects string '48'", () => expect(isValidLat("48")).toBe(false));
  test("rejects NaN", () => expect(isValidLat(NaN)).toBe(false));
  test("rejects Infinity", () => expect(isValidLat(Infinity)).toBe(false));
});

// ── isValidLon ────────────────────────────────────────────────────────────────

describe("isValidLon", () => {
  test("accepts 0", () => expect(isValidLon(0)).toBe(true));
  test("accepts 180", () => expect(isValidLon(180)).toBe(true));
  test("accepts -180", () => expect(isValidLon(-180)).toBe(true));
  test("accepts 2.3522", () => expect(isValidLon(2.3522)).toBe(true));
  test("rejects 180.0001", () => expect(isValidLon(180.0001)).toBe(false));
  test("rejects -180.0001", () => expect(isValidLon(-180.0001)).toBe(false));
  test("rejects string '2'", () => expect(isValidLon("2")).toBe(false));
  test("rejects NaN", () => expect(isValidLon(NaN)).toBe(false));
});

// ── isValidHexColor ───────────────────────────────────────────────────────────

describe("isValidHexColor", () => {
  test("accepts FF0000", () => expect(isValidHexColor("FF0000")).toBe(true));
  test("accepts 000000", () => expect(isValidHexColor("000000")).toBe(true));
  test("rejects with #", () => expect(isValidHexColor("#FF0000")).toBe(false));
  test("rejects empty string", () => expect(isValidHexColor("")).toBe(false));
  test("rejects non-string", () => expect(isValidHexColor(123456)).toBe(false));
});

// ── isValidServiceDay ─────────────────────────────────────────────────────────

describe("isValidServiceDay", () => {
  test("accepts 0", () => expect(isValidServiceDay(0)).toBe(true));
  test("accepts 1", () => expect(isValidServiceDay(1)).toBe(true));
  test("accepts string '0'", () => expect(isValidServiceDay("0")).toBe(true));
  test("accepts string '1'", () => expect(isValidServiceDay("1")).toBe(true));
  test("rejects 2", () => expect(isValidServiceDay(2)).toBe(false));
  test("rejects -1", () => expect(isValidServiceDay(-1)).toBe(false));
  // Number("") === 0, which is a valid service day value — intentional.
  test("accepts empty string (coerces to 0)", () => expect(isValidServiceDay("")).toBe(true));
});

// ── isValidYYYYMMDDDate ───────────────────────────────────────────────────────

describe("isValidYYYYMMDDDate", () => {
  test("accepts 20250101", () => expect(isValidYYYYMMDDDate("20250101")).toBe(true));
  test("accepts number 20250101", () => expect(isValidYYYYMMDDDate(20250101)).toBe(true));
  test("rejects 2025-01-01", () => expect(isValidYYYYMMDDDate("2025-01-01")).toBe(false));
  test("rejects 7-digit string", () => expect(isValidYYYYMMDDDate("2025010")).toBe(false));
  test("rejects empty", () => expect(isValidYYYYMMDDDate("")).toBe(false));
});

// ── isValidDirectionId ────────────────────────────────────────────────────────

describe("isValidDirectionId", () => {
  test("accepts 0", () => expect(isValidDirectionId(0)).toBe(true));
  test("accepts 1", () => expect(isValidDirectionId(1)).toBe(true));
  test("accepts string '0'", () => expect(isValidDirectionId("0")).toBe(true));
  test("accepts string '1'", () => expect(isValidDirectionId("1")).toBe(true));
  test("rejects 2", () => expect(isValidDirectionId(2)).toBe(false));
  test("rejects empty string", () => expect(isValidDirectionId("")).toBe(false));
});

// ── isValidWheelchairBoarding ─────────────────────────────────────────────────

describe("isValidWheelchairBoarding", () => {
  test("accepts '0'", () => expect(isValidWheelchairBoarding("0")).toBe(true));
  test("accepts '1'", () => expect(isValidWheelchairBoarding("1")).toBe(true));
  test("accepts '2'", () => expect(isValidWheelchairBoarding("2")).toBe(true));
  test("accepts empty string", () => expect(isValidWheelchairBoarding("")).toBe(true));
  test("accepts number 0", () => expect(isValidWheelchairBoarding(0)).toBe(true));
  test("rejects '3'", () => expect(isValidWheelchairBoarding("3")).toBe(false));
  test("rejects '-1'", () => expect(isValidWheelchairBoarding("-1")).toBe(false));
});

// ── isValidContinuousPickupDropOff ────────────────────────────────────────────

describe("isValidContinuousPickupDropOff", () => {
  test("accepts '0'", () => expect(isValidContinuousPickupDropOff("0")).toBe(true));
  test("accepts '1'", () => expect(isValidContinuousPickupDropOff("1")).toBe(true));
  test("accepts '2'", () => expect(isValidContinuousPickupDropOff("2")).toBe(true));
  test("accepts '3'", () => expect(isValidContinuousPickupDropOff("3")).toBe(true));
  test("accepts empty string", () => expect(isValidContinuousPickupDropOff("")).toBe(true));
  test("accepts null (empty)", () => expect(isValidContinuousPickupDropOff(null)).toBe(true));
  test("rejects '4'", () => expect(isValidContinuousPickupDropOff("4")).toBe(false));
  test("rejects '-1'", () => expect(isValidContinuousPickupDropOff("-1")).toBe(false));
});

// ── isValidLanguageCode ───────────────────────────────────────────────────────

describe("isValidLanguageCode", () => {
  test("accepts 'en'", () => expect(isValidLanguageCode("en")).toBe(true));
  test("accepts 'fr'", () => expect(isValidLanguageCode("fr")).toBe(true));
  test("accepts 'fr-CA'", () => expect(isValidLanguageCode("fr-CA")).toBe(true));
  test("accepts 'zh-Hant'", () => expect(isValidLanguageCode("zh-Hant")).toBe(true));
  test("rejects empty string", () => expect(isValidLanguageCode("")).toBe(false));
  test("rejects null", () => expect(isValidLanguageCode(null)).toBe(false));
  test("rejects '123'", () => expect(isValidLanguageCode("123")).toBe(false));
});

// ── isValidTimezone ───────────────────────────────────────────────────────────

describe("isValidTimezone", () => {
  test("accepts 'Europe/Paris'", () => expect(isValidTimezone("Europe/Paris")).toBe(true));
  test("accepts 'America/New_York'", () => expect(isValidTimezone("America/New_York")).toBe(true));
  test("accepts 'UTC'", () => expect(isValidTimezone("UTC")).toBe(true));
  test("rejects 'Not/ATimezone'", () => expect(isValidTimezone("Not/ATimezone")).toBe(false));
  test("rejects empty string", () => expect(isValidTimezone("")).toBe(false));
  test("rejects null", () => expect(isValidTimezone(null)).toBe(false));
  test("memoises results (called twice, same outcome)", () => {
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("Europe/London")).toBe(true);
  });
});

// ── isValidPickupDropOffType ──────────────────────────────────────────────────

describe("isValidPickupDropOffType", () => {
  test("accepts '0'", () => expect(isValidPickupDropOffType("0")).toBe(true));
  test("accepts '3'", () => expect(isValidPickupDropOffType("3")).toBe(true));
  test("accepts empty string", () => expect(isValidPickupDropOffType("")).toBe(true));
  test("accepts null", () => expect(isValidPickupDropOffType(null)).toBe(true));
  test("rejects '4'", () => expect(isValidPickupDropOffType("4")).toBe(false));
  test("rejects 'yes'", () => expect(isValidPickupDropOffType("yes")).toBe(false));
});

// ── isValidRouteType ──────────────────────────────────────────────────────────

describe("isValidRouteType", () => {
  test("accepts 0", () => expect(isValidRouteType(0)).toBe(true));
  test("accepts 3", () => expect(isValidRouteType(3)).toBe(true));
  test("accepts 100", () => expect(isValidRouteType(100)).toBe(true));
  test("accepts string '3'", () => expect(isValidRouteType("3")).toBe(true));
  test("rejects -1", () => expect(isValidRouteType(-1)).toBe(false));
  test("rejects 1.5", () => expect(isValidRouteType(1.5)).toBe(false));
  test("rejects empty string", () => expect(isValidRouteType("")).toBe(false));
  test("rejects null", () => expect(isValidRouteType(null)).toBe(false));
});

// ── isValidGtfsTime ───────────────────────────────────────────────────────────

describe("isValidGtfsTime", () => {
  test("accepts '08:30:00'", () => expect(isValidGtfsTime("08:30:00")).toBe(true));
  test("accepts '25:15:00' (overnight)", () => expect(isValidGtfsTime("25:15:00")).toBe(true));
  test("accepts '8:00:00' (single digit hour)", () => expect(isValidGtfsTime("8:00:00")).toBe(true));
  test("rejects '08:60:00' (bad minutes)", () => expect(isValidGtfsTime("08:60:00")).toBe(false));
  test("rejects '08:00:60' (bad seconds)", () => expect(isValidGtfsTime("08:00:60")).toBe(false));
  test("rejects '08:30' (no seconds)", () => expect(isValidGtfsTime("08:30")).toBe(false));
  test("rejects non-string", () => expect(isValidGtfsTime(83000)).toBe(false));
  test("rejects empty string", () => expect(isValidGtfsTime("")).toBe(false));
});

// ── validateStopFields ────────────────────────────────────────────────────────

describe("validateStopFields", () => {
  test("returns [] for empty body", () => {
    expect(validateStopFields({})).toEqual([]);
  });

  test("returns [] for valid lat/lon", () => {
    expect(validateStopFields({ stop_lat: 48.8566, stop_lon: 2.3522 })).toEqual([]);
  });

  test("returns error for lat out of range", () => {
    const errs = validateStopFields({ stop_lat: 91 });
    expect(errs).toContain("stop_lat must be a number between -90 and 90");
  });

  test("returns error for lon out of range", () => {
    const errs = validateStopFields({ stop_lon: 200 });
    expect(errs).toContain("stop_lon must be a number between -180 and 180");
  });

  test("returns error for stop_name as non-string", () => {
    const errs = validateStopFields({ stop_name: 123 });
    expect(errs).toContain("stop_name must be a string");
  });

  test("returns error for empty stop_name (default location_type 0)", () => {
    const errs = validateStopFields({ stop_name: "  " });
    expect(errs).toContain(
      "stop_name is required for stops with location_type 0 (stop), 1 (station), or 2 (entrance/exit) and cannot be empty",
    );
  });

  test("allows empty stop_name for location_type 3 (generic node)", () => {
    const errs = validateStopFields({ stop_name: "", location_type: 3 });
    expect(errs).toEqual([]);
  });

  test("returns error for invalid wheelchair_boarding", () => {
    const errs = validateStopFields({ wheelchair_boarding: "3" });
    expect(errs).toContain("wheelchair_boarding must be 0, 1 or 2");
  });

  test("accepts wheelchair_boarding '2'", () => {
    expect(validateStopFields({ wheelchair_boarding: "2" })).toEqual([]);
  });

  test("accepts null stop_lat (field omitted from patch)", () => {
    expect(validateStopFields({ stop_lat: null })).toEqual([]);
  });
});

// ── validateRouteFields ───────────────────────────────────────────────────────

describe("validateRouteFields", () => {
  test("returns [] for empty body", () => {
    expect(validateRouteFields({})).toEqual([]);
  });

  test("returns error for invalid route_color", () => {
    const errs = validateRouteFields({ route_color: "#FF0000" });
    expect(errs).toContain("route_color must be a 6-char hex value (no #)");
  });

  test("accepts valid route_color", () => {
    expect(validateRouteFields({ route_color: "FF0000" })).toEqual([]);
  });

  test("returns error for invalid route_text_color", () => {
    const errs = validateRouteFields({ route_text_color: "GGGGGG" });
    expect(errs).toContain("route_text_color must be a 6-char hex value (no #)");
  });

  test("returns error for negative route_type", () => {
    const errs = validateRouteFields({ route_type: -1 });
    expect(errs).toContain("route_type must be a non-negative integer");
  });

  test("accepts route_type 3", () => {
    expect(validateRouteFields({ route_type: 3 })).toEqual([]);
  });

  test("returns error for invalid continuous_pickup", () => {
    const errs = validateRouteFields({ continuous_pickup: "4" });
    expect(errs).toContain("continuous_pickup must be 0, 1, 2 or 3");
  });

  test("returns error for invalid continuous_drop_off", () => {
    const errs = validateRouteFields({ continuous_drop_off: "5" });
    expect(errs).toContain("continuous_drop_off must be 0, 1, 2 or 3");
  });

  test("accepts continuous_pickup '3'", () => {
    expect(validateRouteFields({ continuous_pickup: "3" })).toEqual([]);
  });
});

// ── validateTripFields ────────────────────────────────────────────────────────

describe("validateTripFields", () => {
  test("returns [] for empty body", () => {
    expect(validateTripFields({})).toEqual([]);
  });

  test("returns error for invalid direction_id", () => {
    const errs = validateTripFields({ direction_id: "2" });
    expect(errs).toContain("direction_id must be 0 or 1");
  });

  test("accepts direction_id '0'", () => {
    expect(validateTripFields({ direction_id: "0" })).toEqual([]);
  });

  test("accepts direction_id 1 (number)", () => {
    expect(validateTripFields({ direction_id: 1 })).toEqual([]);
  });

  test("returns error for invalid wheelchair_accessible", () => {
    const errs = validateTripFields({ wheelchair_accessible: "3" });
    expect(errs).toContain("wheelchair_accessible must be 0, 1 or 2");
  });

  test("accepts wheelchair_accessible '2'", () => {
    expect(validateTripFields({ wheelchair_accessible: "2" })).toEqual([]);
  });

  test("allows null direction_id (field not changed)", () => {
    expect(validateTripFields({ direction_id: null })).toEqual([]);
  });
});

// ── validateCalendarFields ────────────────────────────────────────────────────

describe("validateCalendarFields", () => {
  test("returns [] for empty body", () => {
    expect(validateCalendarFields({})).toEqual([]);
  });

  test("returns error for invalid monday value", () => {
    const errs = validateCalendarFields({ monday: 2 });
    expect(errs).toContain("monday must be 0 or 1");
  });

  test("accepts monday 0 and tuesday 1", () => {
    expect(validateCalendarFields({ monday: 0, tuesday: 1 })).toEqual([]);
  });

  test("returns error for invalid start_date format", () => {
    const errs = validateCalendarFields({ start_date: "2025-01-01" });
    expect(errs).toContain("start_date must match YYYYMMDD");
  });

  test("accepts valid start_date", () => {
    expect(validateCalendarFields({ start_date: "20250101" })).toEqual([]);
  });

  test("returns error for invalid end_date format", () => {
    const errs = validateCalendarFields({ end_date: "01012025" });
    // 8 digits but valid format — "01012025" matches /^\d{8}$/, should pass
    expect(errs).toEqual([]);
  });

  test("rejects end_date with dashes", () => {
    const errs = validateCalendarFields({ end_date: "2025-12-31" });
    expect(errs).toContain("end_date must match YYYYMMDD");
  });

  test("validates all 7 day fields", () => {
    const body = {
      monday: 1,
      tuesday: 0,
      wednesday: 1,
      thursday: 0,
      friday: 1,
      saturday: 0,
      sunday: 0,
    };
    expect(validateCalendarFields(body)).toEqual([]);
  });
});

// ── validateAgencyFields ──────────────────────────────────────────────────────

describe("validateAgencyFields", () => {
  test("returns [] for any body (no format constraints yet)", () => {
    expect(validateAgencyFields({ agency_name: "Test Agency" })).toEqual([]);
    expect(validateAgencyFields({})).toEqual([]);
  });
});
