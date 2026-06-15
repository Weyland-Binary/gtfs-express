// Dev-server smoke configuration. The main config exercises the production
// bundle; this one boots the actual Vite dev server, because the dependency
// pre-bundling path is dev-only and has its own failure modes (e.g. the
// MUI/Emotion "styled_default is not a function" blank page) that a
// production build can never catch.

const { defineConfig, devices } = require("@playwright/test");
const path = require("path");

const API_PORT = 3004;
// Own port: never collides with the production-bundle suite (3000) when the
// two configs run back-to-back with reuseExistingServer enabled locally.
const WEB_PORT = 3001;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;

module.exports = defineConfig({
  testDir: "./tests-dev",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
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
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        NODE_ENV: "development",
        PORT: String(API_PORT),
        BETA_GATE_DISABLED: "true",
        // Harness-owned server: lift the demo-feed limiter so repeated
        // local runs (3 sample loads per run) never trip 5/15min.
        RATE_LIMIT_MAX_SAMPLES: "100",
        ALLOWED_ORIGINS: `${WEB_URL},http://localhost:${WEB_PORT}`,
        GTFS_UPLOAD_DIR: path.resolve(__dirname, ".tmp", "uploads-dev"),
      },
    },
    {
      // The real dev server — .env.development already points the bundle at
      // the local API. Sequence matters: wipe the dependency cache (a kill
      // mid-write leaves truncated chunks), run the optimizer TO COMPLETION
      // with `vite optimize`, only then start the server. The readiness
      // probe therefore opens the browser on a warm cache — racing the
      // cold optimizer mid-flight is inherently flaky, while a genuinely
      // broken optimizer OUTPUT (the interop regression this smoke exists
      // for) still fails the test on a warm cache all the same.
      command:
        'node -e "require(\'fs\').rmSync(\'node_modules/.vite\',{recursive:true,force:true})" && npx vite optimize --force && npx vite --port ' +
        WEB_PORT,
      cwd: path.resolve(__dirname, "..", "GTFS-EXPRESS-WEB"),
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
