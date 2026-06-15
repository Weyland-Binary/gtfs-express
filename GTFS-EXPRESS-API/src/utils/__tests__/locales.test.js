/**
 * locales.test.js — i18n coverage + behaviour tests for rulesCatalog.
 *
 * End-to-end locale integration with the canonical validator lives in
 * the canonical service tests; this file focuses on rule-catalogue
 * drift guards and the pure t() / pickLocaleFromAcceptLanguage /
 * applyLocaleToReport helpers.
 */

"use strict";

const {
  t,
  DEFAULT_LOCALE,
  getAvailableLocales,
  applyLocaleToReport,
  pickLocaleFromAcceptLanguage,
  RULES_CATALOG,
} = require("../rulesCatalog");

describe("locales — catalogue coverage", () => {
  test("at least en and fr are loaded", () => {
    const locs = getAvailableLocales();
    expect(locs).toContain("en");
    expect(locs).toContain("fr");
  });

  test("every catalogue rule has an en.json entry (drift guard)", () => {
    // The drift guard already ran at module load; redo it explicitly so
    // the test catches a regression even if module-load throws got silenced.
    const en = require("../locales/en.json");
    const missing = Object.keys(RULES_CATALOG).filter(
      (code) => !Object.prototype.hasOwnProperty.call(en, code),
    );
    expect(missing).toEqual([]);
  });

  test("every catalogue rule has a fr.json entry", () => {
    const fr = require("../locales/fr.json");
    const missing = Object.keys(RULES_CATALOG).filter(
      (code) => !Object.prototype.hasOwnProperty.call(fr, code),
    );
    expect(missing).toEqual([]);
  });

  test("every fr value is a non-empty string distinct from its key", () => {
    const fr = require("../locales/fr.json");
    for (const [code, msg] of Object.entries(fr)) {
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toBe(code);
    }
  });
});

describe("t() — pure lookup", () => {
  test("known code resolves in default locale", () => {
    const msg = t("missing_required_field");
    expect(msg).toMatch(/required field/i);
  });

  test("known code resolves in fr locale", () => {
    const msg = t("missing_required_field", "fr");
    expect(msg).toMatch(/champ requis/i);
  });

  test("unknown locale falls back to en", () => {
    expect(t("missing_required_field", "xx")).toBe(
      t("missing_required_field", "en"),
    );
  });

  test("unknown rule code returns the code itself", () => {
    expect(t("totally_made_up_rule", "fr")).toBe("totally_made_up_rule");
  });
});

describe("pickLocaleFromAcceptLanguage", () => {
  test.each([
    ["fr", "fr"],
    ["fr-FR", "fr"],
    ["fr-FR,fr;q=0.9,en;q=0.8", "fr"],
    ["en-GB,en;q=0.9", "en"],
    ["de,fr;q=0.9", "fr"], // de not loaded → falls through to fr
    ["", DEFAULT_LOCALE],
    [undefined, DEFAULT_LOCALE],
    ["zz-ZZ", DEFAULT_LOCALE],
  ])("'%s' → %s", (header, expected) => {
    expect(pickLocaleFromAcceptLanguage(header)).toBe(expected);
  });
});

describe("applyLocaleToReport — in-place mutation", () => {
  test("attaches messageLocalized in non-default locale", () => {
    const report = {
      "agency.txt": [
        { ruleCode: "missing_required_field", severity: "error", message: "x" },
      ],
    };
    applyLocaleToReport("fr", report);
    expect(report["agency.txt"][0].messageLocalized).toMatch(/champ requis/i);
    // Original message stays English
    expect(report["agency.txt"][0].message).toBe("x");
  });

  test("no-op when locale is en", () => {
    const report = {
      "agency.txt": [
        { ruleCode: "missing_required_field", severity: "error", message: "x" },
      ],
    };
    applyLocaleToReport("en", report);
    expect(report["agency.txt"][0].messageLocalized).toBeUndefined();
  });

  test("no-op when locale is unknown", () => {
    const report = {
      "agency.txt": [
        { ruleCode: "missing_required_field", severity: "error", message: "x" },
      ],
    };
    applyLocaleToReport("zz", report);
    expect(report["agency.txt"][0].messageLocalized).toBeUndefined();
  });
});

