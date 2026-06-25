// Shape Studio — basic reachability: the tab only exists in edit mode,
// opening it renders the studio workspace and deep-links as ?tab=studio.
// Geometry interactions (drag/extend/save) stay manual for now — this spec
// is the safety net for refactors of the studio shell and editor toolbar.

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.localStorage.setItem("appLanguage", "en");
  });
  page = await context.newPage();
  await page.goto("/");
  await page.getByTestId("uploader-load-sample").click();
  await expect(page.getByTestId("tab-home")).toBeVisible({ timeout: 150_000 });
});

test.afterAll(async () => {
  await page?.context().close();
});

test("studio tab appears with edit mode and renders the workspace", async () => {
  // Outside edit mode the tab must not exist.
  await expect(page.getByTestId("tab-shape-studio")).toHaveCount(0);

  await page.getByTestId("edit-mode-enter").click();
  await page.getByTestId("edit-mode-enter-confirm").click();
  await expect(page.getByTestId("edit-undo")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("tab-shape-studio").click();
  await expect(page.getByTestId("shape-studio")).toBeVisible({
    timeout: 30_000,
  });
  expect(page.url()).toContain("tab=studio");

  // Leaving edit mode drops the studio and its tab.
  await page.getByTestId("edit-mode-exit").click();
  await expect(page.getByTestId("tab-shape-studio")).toHaveCount(0, {
    timeout: 30_000,
  });
});
