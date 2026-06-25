/**
 * rulesDocService.test.js — guards the on-the-fly validation-rules HTML
 * page that replaces the previous static rules.generated.html artefact.
 *
 * The endpoint must:
 *   1. Return 200 + text/html for GET /gtfs/edit/validate/rules
 *   2. Cover every rule in rules.json (each code appears in the HTML)
 *   3. Cache between calls (same byte-for-byte output, no fs re-read)
 *
 * If a rule is added to rules.json (with the proper RULE constant + EN
 * locale entry that the boot drift-guards already enforce), the next
 * request to this endpoint surfaces it automatically.
 */

"use strict";

process.env.NODE_ENV = "test";

const request = require("supertest");
const app = require("../app");
const rulesJson = require("../utils/rules.json");
const {
  getRulesDocHtml,
  _resetCacheForTests,
} = require("../services/rulesDocService");

describe("GET /gtfs/edit/validate/rules — on-the-fly rules doc", () => {
  beforeEach(() => {
    _resetCacheForTests();
  });

  test("returns 200 + text/html with the full rules catalogue", async () => {
    const res = await request(app).get("/gtfs/edit/validate/rules");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.text).toMatch(/^<!doctype html>/i);
    expect(res.text).toMatch(/<\/html>\s*$/i);
  });

  test("every rule code in rules.json is rendered into the HTML", async () => {
    const res = await request(app).get("/gtfs/edit/validate/rules");
    const codes = Object.keys(rulesJson.rules);
    expect(codes.length).toBeGreaterThan(100);
    // Each rule emits an article with id="rule-<code>" — check a sample
    // and the full set in one assertion to keep the failure message
    // useful if a code goes missing.
    const missing = codes.filter((c) => !res.text.includes(`id="rule-${c}"`));
    expect(missing).toEqual([]);
  });

  test("repeated calls return identical HTML (mtime cache hit)", () => {
    const a = getRulesDocHtml();
    const b = getRulesDocHtml();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(50_000);
  });

  test("Cache-Control header is set for proxy / CDN reuse", async () => {
    const res = await request(app).get("/gtfs/edit/validate/rules");
    expect(res.headers["cache-control"]).toMatch(/max-age=\d+/);
  });

  test("renders the rules.json schema version in the footer", async () => {
    const res = await request(app).get("/gtfs/edit/validate/rules");
    expect(res.text).toContain(`<code>${rulesJson.$schema_version}</code>`);
  });

  test("links MobilityData-aligned rules to the canonical reference", async () => {
    const res = await request(app).get("/gtfs/edit/validate/rules");
    const aligned = Object.entries(rulesJson.rules).find(
      ([, m]) => m.mobilitydata_match,
    );
    expect(aligned).toBeDefined();
    const [, meta] = aligned;
    expect(res.text).toContain(
      `href="https://gtfs-validator.mobilitydata.org/rules.html#${meta.mobilitydata_match.toUpperCase()}"`,
    );
  });
});
