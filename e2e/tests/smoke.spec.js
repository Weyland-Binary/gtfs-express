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
  // The Diagnostic (semantic audit) runs on the dashboard: the demo feed
  // has two bus/ferry stops sharing a name and a place.
  await expect(page.getByTestId("dashboard-audit")).toBeVisible();
  await expect(page.getByTestId("audit-finding-duplicate_stops")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("audit-finding-duplicate_stops").click();
  await expect(page.getByText("Domino Park").first()).toBeVisible();
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
  // A single click enters edit mode (no confirmation dialog: every change is
  // undoable). With the beta gate disabled the backend flips straight away.
  await page.getByTestId("edit-mode-enter").click();
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

test("schedule cells are keyboard-navigable and open the editor with Enter", async () => {
  const firstCell = page.locator('[data-cell="0:0"]');
  await expect(firstCell).toBeVisible({ timeout: 30_000 });
  await firstCell.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator('[data-cell="0:1"]')).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('[data-cell="1:1"]')).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("schedule-edit-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("schedule-edit-popover")).toBeHidden();
});

test("shifting a trip's times from the column menu is a single undoable step", async () => {
  const menuButton = page.getByTestId("trip-col-menu").first();
  await expect(menuButton).toBeVisible({ timeout: 30_000 });
  await menuButton.click();
  await page.getByTestId("col-menu-shift").click();
  await page.getByTestId("shift-minutes").fill("5");
  await page.getByTestId("shift-apply").click();
  // Success toast (English locale forced in beforeAll).
  await expect(page.getByText(/shifted by \+5 min/)).toBeVisible({
    timeout: 30_000,
  });
  // One undo reverts the whole shift.
  await page.getByTestId("edit-undo").click();
  await expect(page.getByText(/Undone:/)).toBeVisible({ timeout: 30_000 });
});

test("merging duplicate stops from the Diagnostic is a single undoable step", async () => {
  await page.getByTestId("tab-home").click();
  const finding = page.getByTestId("audit-finding-duplicate_stops");
  await expect(finding).toBeVisible({ timeout: 30_000 });
  await finding.click();
  await page.getByTestId("audit-merge").first().click();
  const dialog = page.getByTestId("merge-stops-dialog");
  await expect(dialog).toBeVisible();
  // The dry-run of both sides has to come back before the survivor choice
  // is offered; the default is the stop with the most stop times.
  await expect(dialog.getByRole("radio").first()).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("merge-stops-confirm").click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  // One undo step puts the duplicate back; the Diagnostic re-runs after it.
  const undo = page.getByTestId("edit-undo");
  await expect(undo).toBeEnabled({ timeout: 30_000 });
  await undo.click();
  await expect(page.getByTestId("audit-finding-duplicate_stops")).toBeVisible({ timeout: 30_000 });
});

test("ignoring a Diagnostic finding hides it and is remembered for the session", async () => {
  const finding = page.getByTestId("audit-finding-duplicate_stops");
  await expect(finding).toBeVisible({ timeout: 30_000 });
  // The row may still be expanded from the merge scenario.
  if (!(await page.getByTestId("audit-ignore").first().isVisible().catch(() => false))) {
    await finding.click();
  }
  await page.getByTestId("audit-ignore").first().click();
  await expect(page.getByTestId("audit-finding-duplicate_stops")).toBeHidden({ timeout: 15_000 });
  await page.getByTestId("audit-toggle-ignored").first().click();
  await expect(page.getByTestId("audit-finding-duplicate_stops")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("audit-finding-duplicate_stops").click();
  await page.getByTestId("audit-unignore").first().click();
  await expect(page.getByTestId("audit-toggle-ignored")).toBeHidden({ timeout: 15_000 });
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
