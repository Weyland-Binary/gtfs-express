// GTFS Express — core-loop smoke suite.
//
// One serial narrative on a single page (the session id lives in
// sessionStorage, which is per-tab): load the bundled sample feed, explore
// the dashboard and schedule grid, check validation surfaces, then enter
// edit mode, rename a stop, undo it, and export the feed as a ZIP.
//
// Assertions are engine-agnostic: with the dev stub validator the report is
// empty (header badge hidden), with the real MobilityData JAR it usually is
// not — both paths must stay green.

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  // Force English so assertions never depend on browser locale.
  await context.addInitScript(() => {
    window.localStorage.setItem("appLanguage", "en");
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await page?.context().close();
});

test("landing page renders the uploader", async () => {
  await page.goto("/");
  await expect(page.getByTestId("uploader-load-sample")).toBeVisible();
});

test("loading the sample feed reaches the dashboard", async () => {
  // The bundled sample is a real feed (~78k stop_times): parsing + SQLite
  // ingestion can take a while on cold CI runners.
  test.setTimeout(180_000);
  await page.getByTestId("uploader-load-sample").click();
  await expect(page.getByTestId("tab-home")).toBeVisible({ timeout: 150_000 });
  await expect(page.getByTestId("dashboard-validation-health")).toBeVisible({
    timeout: 30_000,
  });
});

test("schedule grid renders stops for the auto-picked route", async () => {
  await page.getByTestId("tab-schedules").click();
  // First route/direction/date are auto-picked on first visit; the grid
  // then renders one row per stop with the stop name in the first column.
  await expect(page.getByTestId("schedule-grid")).toBeVisible({
    timeout: 60_000,
  });
  await expect(
    page.getByTestId("schedule-stop-name").first(),
  ).toBeVisible({ timeout: 30_000 });
});

test("validation surfaces are reachable", async () => {
  await page.getByTestId("tab-home").click();
  await expect(page.getByTestId("dashboard-validation-health")).toBeVisible();
  // With real findings the header badge opens the full report page; with a
  // clean (stub) report the badge is intentionally absent.
  const badge = page.getByTestId("validation-report-badge");
  if (await badge.isVisible().catch(() => false)) {
    await badge.click();
    await expect(page.getByTestId("validation-page")).toBeVisible();
    await page.getByTestId("tab-home").click();
  }
});

test("edit mode can be entered", async () => {
  await page.getByTestId("edit-mode-enter").click();
  // Entering shows a confirmation dialog before flipping the backend flag.
  await page.getByTestId("edit-mode-enter-confirm").click();
  await expect(page.getByTestId("edit-undo")).toBeVisible({
    timeout: 30_000,
  });
});

test("renaming a stop applies and shows in the grid", async () => {
  await page.getByTestId("tab-schedules").click();
  const firstStop = page.getByTestId("schedule-stop-name").first();
  await expect(firstStop).toBeVisible({ timeout: 30_000 });
  await firstStop.click();

  // Detail panel → edit dialog → change stop_name → save.
  await page.getByTestId("stop-detail-edit").click();
  const nameInput = page.getByTestId("stop-name-input");
  await expect(nameInput).toBeVisible();
  await nameInput.fill("E2E Renamed Stop");
  await page.getByTestId("stop-dialog-save").click();

  await expect(page.getByTestId("schedule-stop-name").first()).toHaveText(
    "E2E Renamed Stop",
    { timeout: 30_000 },
  );

  // Close the detail panel (modal drawer) — it would otherwise sit above
  // the header toolbar and swallow the next test's undo click.
  await page.keyboard.press("Escape");
  await expect(page.locator(".MuiDrawer-modal")).toBeHidden({
    timeout: 10_000,
  });
});

test("undo restores the previous stop name", async () => {
  await page.getByTestId("edit-undo").click();
  await expect(
    page.getByTestId("schedule-stop-name").first(),
  ).not.toHaveText("E2E Renamed Stop", { timeout: 30_000 });
});

test("export produces a GTFS zip", async () => {
  test.setTimeout(180_000);
  await page.getByTestId("edit-export").click();

  // Preflight dialog: depending on the validation engine the feed may be
  // clean (direct export) or carry ERROR findings (risky-export double
  // confirm). Handle both deterministically.
  const direct = page.getByTestId("export-confirm");
  const anyway = page.getByTestId("export-anyway");
  await expect(direct.or(anyway).first()).toBeVisible({ timeout: 120_000 });

  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  if (await direct.isVisible().catch(() => false)) {
    await direct.click();
  } else {
    await anyway.click();
    await page.getByTestId("export-risk-checkbox").check();
    await page.getByTestId("export-risky-confirm").click();
  }

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const filePath = await download.path();
  const { statSync } = require("fs");
  expect(statSync(filePath).size).toBeGreaterThan(1024);
});
