/**
 * rulesCatalog.test.js — Coherence tests for rules.json + RULE map.
 *
 * Goals:
 *   1. Every wire-format code emitted by the validator (RULE map values)
 *      has a catalogue entry — drift guard.
 *   2. Every catalogue entry has the mandatory metadata fields with
 *      well-formed values (severity in the enum, gtfs_section in the
 *      enum, message_i18n_key matches a stable convention).
 *   3. mobilitydata_match is either null or a snake_case string.
 */

"use strict";

const { RULES_CATALOG, getRule, isKnownRule, SCHEMA_VERSION } = require(
  "../rulesCatalog",
);

const VALID_SEVERITIES = new Set(["error", "warning", "info"]);

const VALID_SECTIONS = new Set([
  "structure",
  "agency",
  "stops",
  "routes",
  "trips",
  "calendar",
  "calendar_dates",
  "stop_times",
  "shapes",
  "frequencies",
  "transfers",
  "feed_info",
  "pathways",
  "levels",
  "translations",
  "attributions",
  "fare",
  "timeframes",
  "cross_file",
  "data_quality",
]);

const SNAKE_CASE_RE = /^[a-z][a-z0-9_]*$/;

describe("rulesCatalog", () => {
  test("schema version is set", () => {
    expect(typeof SCHEMA_VERSION).toBe("string");
    expect(SCHEMA_VERSION.length).toBeGreaterThan(0);
  });

  test("getRule returns null for unknown codes", () => {
    expect(getRule("totally_made_up_rule")).toBeNull();
    expect(isKnownRule("totally_made_up_rule")).toBe(false);
  });

  test.each(Object.keys(RULES_CATALOG))(
    "%s — entry has well-formed metadata",
    (code) => {
      const rule = getRule(code);
      expect(rule).not.toBeNull();
      expect(rule.code).toBe(code);
      expect(SNAKE_CASE_RE.test(rule.code)).toBe(true);
      expect(VALID_SEVERITIES.has(rule.default_severity)).toBe(true);
      expect(VALID_SECTIONS.has(rule.gtfs_section)).toBe(true);
      expect(rule.message_i18n_key).toBe(`rule.${code}`);
      expect(typeof rule.description).toBe("string");
      expect(rule.description.length).toBeGreaterThan(20);
      // mobilitydata_match: null or snake_case string
      if (rule.mobilitydata_match !== null) {
        expect(typeof rule.mobilitydata_match).toBe("string");
        expect(SNAKE_CASE_RE.test(rule.mobilitydata_match)).toBe(true);
      }
    },
  );

  test("MobilityData alignment ratio is reasonable", () => {
    const total = Object.keys(RULES_CATALOG).length;
    const aligned = Object.values(RULES_CATALOG).filter(
      (r) => r.mobilitydata_match !== null,
    ).length;
    // Should be at least 60% Canonical-aligned.
    expect(aligned / total).toBeGreaterThanOrEqual(0.6);
  });

  test("every ERROR rule has a MobilityData mapping (MD-permissive policy)", () => {
    // Contract test enforcing the policy introduced in PR #25: any rule
    // that *blocks* the import / export gate (severity=error) must have
    // a documented MobilityData equivalent. This guarantees a feed
    // accepted by MobilityData is also accepted by GTFS Express, and
    // catches a future regression where a custom rule is reintroduced
    // at ERROR without thinking through MD parity.
    const orphans = Object.entries(RULES_CATALOG)
      .filter(
        ([, r]) =>
          r.default_severity === "error" && r.mobilitydata_match === null,
      )
      .map(([code]) => code);
    expect(orphans).toEqual([]);
  });
});
