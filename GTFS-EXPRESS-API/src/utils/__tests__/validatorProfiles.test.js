/**
 * validatorProfiles.test.js — coherence + behaviour tests for the
 * profile system in src/utils/validatorProfiles/.
 *
 * End-to-end profile application against a real validator run lives
 * with the canonical engine; this file covers profile loading,
 * per-rule overrides, and the bulk-promotion logic in isolation.
 */

"use strict";

const {
  getProfile,
  getAvailableProfiles,
  applyProfile,
  applyProfileToReport,
  isKnownRule,
} = require("../rulesCatalog");

const VALID_SEVERITIES = new Set(["error", "warning", "info"]);

describe("validatorProfiles — catalogue", () => {
  test("canonical / strict / lenient / fr-datagouv all load", () => {
    expect(getProfile("canonical")).toBeTruthy();
    expect(getProfile("strict")).toBeTruthy();
    expect(getProfile("lenient")).toBeTruthy();
    expect(getProfile("fr-datagouv")).toBeTruthy();
  });

  test("getAvailableProfiles returns name+title+description", () => {
    const list = getAvailableProfiles();
    expect(list.length).toBeGreaterThanOrEqual(4);
    for (const p of list) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.title).toBe("string");
      expect(typeof p.description).toBe("string");
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  test("unknown profile returns null", () => {
    expect(getProfile("definitely-not-a-real-profile")).toBeNull();
  });

  test.each(["canonical", "strict", "lenient", "fr-datagouv"])(
    "%s — every override targets a known rule with a valid severity",
    (name) => {
      const p = getProfile(name);
      for (const [code, sev] of Object.entries(p.overrides || {})) {
        expect(isKnownRule(code)).toBe(true);
        expect(VALID_SEVERITIES.has(sev)).toBe(true);
      }
    },
  );
});

describe("applyProfile — pure transform", () => {
  test("canonical is a no-op", () => {
    expect(applyProfile("canonical", "missing_required_field", "error")).toBe(
      "error",
    );
    expect(applyProfile("canonical", "duplicate_route_name", "warning")).toBe(
      "warning",
    );
    expect(applyProfile("canonical", "feed_expired", "warning")).toBe(
      "warning",
    );
  });

  test("strict promotes warning → error and info → warning", () => {
    expect(applyProfile("strict", "duplicate_route_name", "warning")).toBe(
      "error",
    );
    expect(applyProfile("strict", "unused_station", "info")).toBe(
      "warning",
    );
    // ERRORs stay ERRORs
    expect(applyProfile("strict", "missing_required_field", "error")).toBe(
      "error",
    );
  });

  test("lenient demotes specific Fares v2 ERRORs to WARNINGs", () => {
    expect(applyProfile("lenient", "invalid_currency", "error")).toBe(
      "warning",
    );
    expect(
      applyProfile(
        "lenient",
        "fare_transfer_rule_invalid_transfer_count",
        "error",
      ),
    ).toBe("warning");
    // Untouched rules stay at original severity
    expect(applyProfile("lenient", "missing_required_field", "error")).toBe(
      "error",
    );
  });

  test("fr-datagouv promotes feed_info best-practices to ERROR", () => {
    expect(
      applyProfile("fr-datagouv", "missing_feed_info_publisher_name", "error"),
    ).toBe("error");
    expect(
      applyProfile(
        "fr-datagouv",
        "missing_feed_contact_email_and_url",
        "warning",
      ),
    ).toBe("error");
    expect(applyProfile("fr-datagouv", "expired_calendar", "warning")).toBe(
      "error",
    );
  });

  test("explicit override wins over bulk promotions", () => {
    // strict has promote_warning_to_error=true and no override for
    // duplicate_route_name → should become error.
    expect(applyProfile("strict", "duplicate_route_name", "warning")).toBe(
      "error",
    );
    // lenient has explicit duplicate_route_name → "info"; bulk promotions are
    // off, so we end at info even though original was warning.
    expect(applyProfile("lenient", "duplicate_route_name", "warning")).toBe(
      "info",
    );
  });
});

describe("applyProfileToReport — in-place mutation + counts", () => {
  const buildReport = () => ({
    "agency.txt": [
      {
        ruleCode: "missing_required_field",
        severity: "error",
        message: "x",
      },
    ],
    "routes.txt": [
      { ruleCode: "duplicate_route_name", severity: "warning", message: "y" },
      { ruleCode: "unused_station", severity: "info", message: "z" },
    ],
  });

  test("canonical leaves severities untouched", () => {
    const report = buildReport();
    const counts = applyProfileToReport("canonical", report);
    expect(counts).toEqual({ errors: 1, warnings: 1, infos: 1 });
    expect(report["routes.txt"][0].severity).toBe("warning");
  });

  test("strict promotes everything below ERROR", () => {
    const report = buildReport();
    const counts = applyProfileToReport("strict", report);
    expect(counts.errors).toBe(2); // missing + duplicate_route_name promoted
    expect(counts.warnings).toBe(1); // info promoted to warning
    expect(counts.infos).toBe(0);
  });
});

