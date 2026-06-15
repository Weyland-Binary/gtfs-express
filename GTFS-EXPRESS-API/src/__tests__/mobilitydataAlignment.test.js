/**
 * mobilitydataAlignment.test.js — drift guard for the canonical-rule
 * coverage delta added in chantier 3.A.
 *
 * Asserts that the explicit list of MobilityData Canonical notice IDs
 * we promised to support shows up in rules.json with the *literal*
 * canonical name as `mobilitydata_match`. Without this guard, a future
 * refactor that renames our internal rule code (and drops the
 * canonical link) would silently regress the alignment ratio.
 *
 * Source of canonical IDs: https://gtfs-validator.mobilitydata.org/rules.html
 */

"use strict";

const path = require("path");
const fs = require("fs");

const RULES_JSON = path.resolve(
  __dirname,
  "..",
  "utils",
  "rules.json",
);

const EN_LOCALE = path.resolve(
  __dirname,
  "..",
  "utils",
  "locales",
  "en.json",
);

const FR_LOCALE = path.resolve(
  __dirname,
  "..",
  "utils",
  "locales",
  "fr.json",
);

// Canonical rule IDs we explicitly committed to align in chantier 3.A.
// Adding to this list without updating rules.json + en.json + fr.json
// will fail the test — by design.
const REQUIRED_CANONICAL_MATCHES = [
  // Naming corrections
  "feed_expiration_date7_days",
  "feed_expiration_date30_days",
  // Booking rules (Flex / DRT)
  "forbidden_real_time_booking_field_value",
  "forbidden_same_day_booking_field_value",
  "forbidden_prior_day_booking_field_value",
  "missing_prior_day_booking_field_value",
  "missing_prior_notice_duration_min",
  "missing_prior_notice_last_day",
  "missing_prior_notice_last_time",
  "missing_prior_notice_start_time",
  "forbidden_prior_notice_start_day",
  "forbidden_prior_notice_start_time",
  "invalid_prior_notice_duration_min",
  "prior_notice_last_day_after_start_day",
  "missing_pickup_drop_off_booking_rule_id",
  // Flex stop_times
  "forbidden_arrival_or_departure_time",
  "missing_pickup_or_drop_off_window",
  "invalid_pickup_drop_off_window",
  "overlapping_zone_and_pickup_drop_off_window",
  // Timeframes
  "timeframe_overlap",
  "timeframe_only_start_or_end_time_specified",
  "timeframe_start_or_end_time_greater_than_twenty_four_hours",
  // Trips / shapes data quality
  "unusable_trip",
  "unused_trip",
  "unused_shape",
  "unused_station",
  "fast_travel_between_consecutive_stops",
  "fast_travel_between_far_stops",
  "single_shape_point",
  // Misc data quality
  "mixed_case_recommended_field",
  "non_ascii_or_non_printable_char",
  "empty_row",
  "start_and_end_range_equal",
  "missing_recommended_field",
  "missing_feed_contact_email_and_url",
];

describe("MobilityData canonical alignment delta (chantier 3.A)", () => {
  let catalog, en, fr;
  beforeAll(() => {
    catalog = JSON.parse(fs.readFileSync(RULES_JSON, "utf8")).rules;
    en = JSON.parse(fs.readFileSync(EN_LOCALE, "utf8"));
    fr = JSON.parse(fs.readFileSync(FR_LOCALE, "utf8"));
  });

  test("every required canonical ID is mapped via mobilitydata_match", () => {
    const allMappings = new Set(
      Object.values(catalog)
        .map((r) => r.mobilitydata_match)
        .filter((v) => typeof v === "string"),
    );
    const missing = REQUIRED_CANONICAL_MATCHES.filter(
      (canonical) => !allMappings.has(canonical),
    );
    expect(missing).toEqual([]);
  });

  test("each newly-added rule has en + fr i18n entries", () => {
    // The 32 new local rule codes (excluding the two naming corrections,
    // which already had i18n).
    const newRuleCodes = REQUIRED_CANONICAL_MATCHES.filter(
      (id) =>
        id !== "feed_expiration_date7_days" &&
        id !== "feed_expiration_date30_days",
    );
    const missingEn = newRuleCodes.filter((c) => !(c in en));
    const missingFr = newRuleCodes.filter((c) => !(c in fr));
    expect(missingEn).toEqual([]);
    expect(missingFr).toEqual([]);
  });

  test("alignment ratio is now >= 85%", () => {
    const total = Object.keys(catalog).length;
    const aligned = Object.values(catalog).filter(
      (r) => r.mobilitydata_match !== null,
    ).length;
    // Pre-chantier-3.A baseline was ~117/143 = 81.8%.
    // After +30 catalogue entries this should land at ~147/173 ≈ 85%.
    expect(aligned / total).toBeGreaterThanOrEqual(0.85);
  });

  test("every newly-added catalogue entry has well-formed metadata", () => {
    for (const canonical of REQUIRED_CANONICAL_MATCHES) {
      // Find the catalogue entry whose mobilitydata_match equals the canonical.
      const entries = Object.entries(catalog).filter(
        ([, r]) => r.mobilitydata_match === canonical,
      );
      expect(entries.length).toBeGreaterThan(0);
      for (const [code, entry] of entries) {
        expect(entry.message_i18n_key).toBe(`rule.${code}`);
        expect(entry.description.length).toBeGreaterThan(20);
        expect(["error", "warning", "info"]).toContain(entry.default_severity);
      }
    }
  });
});
