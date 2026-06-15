// Playwright E2E smoke harness for GTFS Express.
//
// Boots the real backend (Express + better-sqlite3) and serves the built
// frontend bundle, then drives the core user loop in a real browser:
// load sample → explore → validate → edit → undo → export.
//
// The backend runs with BETA_GATE_DISABLED=true so edit mode is reachable
// without a beta code. When GTFS_CANONICAL_VALIDATOR_JAR is unset the
// validator falls back to its dev stub — assertions therefore stay
// engine-agnostic (the report UI renders; never exact finding counts).
//
// Prerequisite: a production build of the frontend pointing at the local
// API, e.g. from GTFS-EXPRESS-WEB/:
//   VITE_API_BASE_URL=http://127.0.0.1:3004/gtfs npm run build
// (Before the Vite migration: REACT_APP_API_BASE_URL=… npm run build)

const { defineConfig, devices } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const API_PORT = 3004;
const WEB_PORT = 3000;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

// Frontend build output: CRA emits build/, Vite emits dist/. Support both so
// the harness is a stable oracle across the migration.
const WEB_ROOT = path.resolve(__dirname, "..", "GTFS-EXPRESS-WEB");
const BUILD_DIR = ["dist", "build"]
  .map((d) => path.join(WEB_ROOT, d))
  .find((d) => fs.existsSync(path.join(d, "index.html")));

if (!BUILD_DIR) {
  throw new Error(
    "No frontend build found (GTFS-EXPRESS-WEB/dist or /build). " +
      "Build it first — see the header comment of this file.",
  );
}

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Smoke paths share one session narrative — keep them strictly ordered.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node src/app.js",
      cwd: path.resolve(__dirname, "..", "GTFS-EXPRESS-API"),
      url: `${API_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        NODE_ENV: "development",
        PORT: String(API_PORT),
        BETA_GATE_DISABLED: "true",
        // Harness-owned server: lift the demo-feed limiter so repeated
        // local runs (3 sample loads per run) never trip 5/15min.
        RATE_LIMIT_MAX_SAMPLES: "100",
        ALLOWED_ORIGINS: `${WEB_URL},http://localhost:${WEB_PORT}`,
        GTFS_UPLOAD_DIR: path.resolve(__dirname, ".tmp", "uploads"),
      },
    },
    {
      // serve resolves from e2e/node_modules — cwd stays here on purpose.
      command: `npx serve -s "${BUILD_DIR}" -l ${WEB_PORT} --no-clipboard`,
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
