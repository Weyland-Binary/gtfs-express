/**
 * strictNumericCoercion.test.js — fieldValidators reject silent JS coercion.
 *
 * Without this guard, a frontend that posts `stop_lat: true` would land 1
 * in the DB (because `Number(true) === 1`), and `stop_lat: [48.8]` would
 * land 48.8 (Array.toString → "48.8" → 48.8). For a "world reference"
 * editor those values must be rejected outright.
 *
 * The fix lives in `fieldValidators.js`:
 *   • numeric helpers (isValidNumber, isValidNonNegativeNumber,
 *     isValidNonNegativeInt) accept only `number | numeric string`.
 *   • lat/lon checks in validateStopFields and validateShapeFields gate on
 *     the same type predicate before falling through to `Number()`.
 */

"use strict";

const {
  validateStopFields,
  validateShapeFields,
  isValidNumber,
  isValidNonNegativeNumber,
  isValidNonNegativeInt,
} = require("../utils/fieldValidators");

describe("strict numeric coercion in fieldValidators", () => {
  describe("validateStopFields stop_lat / stop_lon", () => {
    test("accepts numbers in range", () => {
      expect(validateStopFields({ stop_lat: 48.8 })).toEqual([]);
      expect(validateStopFields({ stop_lon: 2.3 })).toEqual([]);
    });

    test("accepts numeric strings in range", () => {
      expect(validateStopFields({ stop_lat: "48.8" })).toEqual([]);
      expect(validateStopFields({ stop_lon: "2.3" })).toEqual([]);
    });

    test("rejects boolean true (would coerce to 1 silently)", () => {
      const errs = validateStopFields({ stop_lat: true });
      expect(errs.some((e) => /stop_lat/.test(e))).toBe(true);
    });

    test("rejects boolean false (would coerce to 0 silently)", () => {
      const errs = validateStopFields({ stop_lon: false });
      expect(errs.some((e) => /stop_lon/.test(e))).toBe(true);
    });

    test("rejects array (Array.toString could coerce to numeric)", () => {
      expect(
        validateStopFields({ stop_lat: [48.8] }).some((e) =>
          /stop_lat/.test(e),
        ),
      ).toBe(true);
      expect(
        validateStopFields({ stop_lon: [] }).some((e) => /stop_lon/.test(e)),
      ).toBe(true);
    });

    test("rejects plain object", () => {
      expect(
        validateStopFields({ stop_lat: { value: 48.8 } }).some((e) =>
          /stop_lat/.test(e),
        ),
      ).toBe(true);
    });

    test("rejects non-numeric string", () => {
      expect(
        validateStopFields({ stop_lat: "not-a-number" }).some((e) =>
          /stop_lat/.test(e),
        ),
      ).toBe(true);
    });

    test("rejects out-of-range values", () => {
      expect(
        validateStopFields({ stop_lat: 91 }).some((e) => /stop_lat/.test(e)),
      ).toBe(true);
      expect(
        validateStopFields({ stop_lon: -181 }).some((e) => /stop_lon/.test(e)),
      ).toBe(true);
    });

    test("null is treated as 'not-set' (skipped)", () => {
      expect(validateStopFields({ stop_lat: null })).toEqual([]);
      expect(validateStopFields({ stop_lon: null })).toEqual([]);
    });
  });

  describe("validateShapeFields shape_pt_lat / shape_pt_lon", () => {
    test("rejects boolean", () => {
      expect(
        validateShapeFields({ shape_pt_lat: true }).some((e) =>
          /shape_pt_lat/.test(e),
        ),
      ).toBe(true);
    });

    test("rejects array", () => {
      expect(
        validateShapeFields({ shape_pt_lon: [2.3] }).some((e) =>
          /shape_pt_lon/.test(e),
        ),
      ).toBe(true);
    });

    test("accepts valid number/string", () => {
      expect(validateShapeFields({ shape_pt_lat: 48.8 })).toEqual([]);
      expect(validateShapeFields({ shape_pt_lon: "2.3" })).toEqual([]);
    });
  });

  describe("isValidNumber / isValidNonNegativeNumber / isValidNonNegativeInt", () => {
    test("rejects boolean", () => {
      expect(isValidNumber(true)).toBe(false);
      expect(isValidNonNegativeNumber(false)).toBe(false);
      expect(isValidNonNegativeInt(true)).toBe(false);
    });

    test("rejects array", () => {
      expect(isValidNumber([1])).toBe(false);
      expect(isValidNonNegativeNumber([])).toBe(false);
      expect(isValidNonNegativeInt([42])).toBe(false);
    });

    test("rejects object", () => {
      expect(isValidNumber({})).toBe(false);
      expect(isValidNonNegativeNumber({ v: 1 })).toBe(false);
    });

    test("accepts numbers", () => {
      expect(isValidNumber(-3.14)).toBe(true);
      expect(isValidNonNegativeNumber(0)).toBe(true);
      expect(isValidNonNegativeInt(42)).toBe(true);
    });

    test("accepts numeric strings", () => {
      expect(isValidNumber("-3.14")).toBe(true);
      expect(isValidNonNegativeNumber("0")).toBe(true);
      expect(isValidNonNegativeInt("42")).toBe(true);
    });

    test("rejects null / undefined / empty string", () => {
      expect(isValidNumber(null)).toBe(false);
      expect(isValidNumber(undefined)).toBe(false);
      expect(isValidNumber("")).toBe(false);
    });

    test("rejects non-numeric strings", () => {
      expect(isValidNumber("abc")).toBe(false);
      expect(isValidNonNegativeNumber("12abc")).toBe(false);
    });
  });
});
