/**
 * openapiCoverage.test.js — keeps docs/openapi.yaml alive.
 *
 * Enforces a strict bijection between the Express router and the OpenAPI
 * surface:
 *   1. Every route declared in src/routes/gtfsRoutes.js exists in the spec
 *      (missing routes are listed on failure).
 *   2. Every path+method in the spec exists in the router (stale entries
 *      are listed on failure). GET /health is the only spec entry defined
 *      outside the router (src/app.js) and is ignored in that direction.
 *   3. The spec is structurally valid OpenAPI 3.0 (swagger-parser).
 *   4. The runtime mounts work: GET /gtfs/openapi.yaml serves parseable
 *      YAML and GET /gtfs/docs/ serves the Swagger UI page.
 *
 * Route extraction uses the same regex family as scripts/refresh-facts.sh
 * (`router.(get|post|put|patch|delete)(`), extended to capture the path
 * literal across line breaks (a few routes wrap the path onto the next
 * line). A sanity check asserts both counts match so the two extraction
 * strategies can never silently drift apart.
 */

"use strict";

process.env.NODE_ENV = "test";

const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const SwaggerParser = require("@apidevtools/swagger-parser");
const request = require("supertest");
const app = require("../app");

const ROUTES_FILE = path.join(__dirname, "..", "routes", "gtfsRoutes.js");
const SPEC_FILE = path.join(__dirname, "..", "..", "docs", "openapi.yaml");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"];

// Spec paths documented manually (defined in src/app.js, not in the router).
const SPEC_ONLY_PATHS = new Set(["/health"]);

/** Extract `${method} ${path}` pairs from the router source. */
const extractRouterRoutes = () => {
  const src = fs.readFileSync(ROUTES_FILE, "utf8");
  // Same family as refresh-facts.sh, plus the first string-literal argument.
  // `\s*` spans newlines so multi-line declarations are captured too.
  const routeRe = /router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g;
  const routes = [];
  let m;
  while ((m = routeRe.exec(src)) !== null) {
    const oasPath = "/gtfs" + m[2].replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    routes.push(`${m[1]} ${oasPath}`);
  }
  // Per-line count exactly as refresh-facts.sh greps it. If a route is ever
  // declared without an inline string literal (variable path, router.use
  // mount…), the two counts diverge and this test flags it for review.
  const lineHits = (src.match(/router\.(get|post|put|patch|delete)\(/g) || [])
    .length;
  return { routes, lineHits };
};

/** Extract `${method} ${path}` pairs from the OpenAPI document. */
const extractSpecRoutes = (spec) => {
  const routes = [];
  for (const [specPath, pathItem] of Object.entries(spec.paths || {})) {
    for (const method of HTTP_METHODS) {
      if (pathItem && pathItem[method]) routes.push(`${method} ${specPath}`);
    }
  }
  return routes;
};

describe("OpenAPI spec ↔ router bijection", () => {
  const { routes: routerRoutes, lineHits } = extractRouterRoutes();
  const spec = YAML.parse(fs.readFileSync(SPEC_FILE, "utf8"));
  const specRoutes = extractSpecRoutes(spec);

  test("route extraction stays in sync with the refresh-facts.sh regex", () => {
    expect(routerRoutes.length).toBeGreaterThan(0);
    expect(routerRoutes.length).toBe(lineHits);
  });

  test("every router route is documented in docs/openapi.yaml", () => {
    const specSet = new Set(specRoutes);
    const missing = routerRoutes.filter((r) => !specSet.has(r));
    if (missing.length > 0) {
      console.error(
        `Routes missing from docs/openapi.yaml (${missing.length}):\n` +
          missing.map((r) => `  - ${r}`).join("\n"),
      );
    }
    expect(missing).toEqual([]);
  });

  test("every spec operation (except /health) exists in the router", () => {
    const routerSet = new Set(routerRoutes);
    const stale = specRoutes.filter((r) => {
      const specPath = r.split(" ")[1];
      if (SPEC_ONLY_PATHS.has(specPath)) return false;
      return !routerSet.has(r);
    });
    if (stale.length > 0) {
      console.error(
        `Stale spec operations with no matching router route (${stale.length}):\n` +
          stale.map((r) => `  - ${r}`).join("\n"),
      );
    }
    expect(stale).toEqual([]);
  });

  test("the spec documents GET /health", () => {
    expect(specRoutes).toContain("get /health");
  });
});

describe("OpenAPI spec structural validity", () => {
  test("docs/openapi.yaml passes swagger-parser validation", async () => {
    // validate() dereferences and checks the document against the
    // OpenAPI 3.0 schema + spec rules (duplicate params, bad $refs…).
    const api = await SwaggerParser.validate(SPEC_FILE);
    expect(api.openapi).toBe("3.0.3");
    expect(api.info.title).toBe("GTFS Express API");
    expect(api.info.version).toBe("1.0.0");
  });
});

describe("OpenAPI runtime mounts (app.js)", () => {
  test("GET /gtfs/openapi.yaml returns the spec as parseable YAML", async () => {
    const res = await request(app).get("/gtfs/openapi.yaml");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/yaml/);
    expect(res.headers["cache-control"]).toMatch(/max-age=300/);
    const parsed = YAML.parse(res.text);
    expect(parsed.openapi).toBe("3.0.3");
    expect(parsed.info.title).toBe("GTFS Express API");
  });

  test("GET /gtfs/docs/ serves the Swagger UI HTML page", async () => {
    const res = await request(app).get("/gtfs/docs/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.text.toLowerCase()).toContain("swagger");
    expect(res.text).toContain("GTFS Express API");
  });
});
