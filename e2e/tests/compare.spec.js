// Feed comparison — happy path: load the sample feed, open the Compare tab,
// upload the SAME feed as the comparison target and expect the "identical
// feeds" verdict. Exercises the full chain: second-session upload (explicit
// X-Session-ID), POST /gtfs/diff, summary rendering.
//
// Prerequisite: bench/fixtures/small.zip (built by `node bench/zip-sample.mjs`
// from the bundled sample/ folder — the exact feed /load-sample serves).

const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

const FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "bench",
  "fixtures",
  "small.zip",
);

test.describe.configure({ mode: "serial" });

/** @type {import('@playwright/test').Page} */
let page;

test.beforeAll(async ({ browser }) => {
  test.skip(!fs.existsSync(FIXTURE), "fixture missing — run bench/zip-sample.mjs");
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

test("comparing the sample feed against itself reports identical feeds", async () => {
  test.setTimeout(180_000);
  await page.getByTestId("tab-compare").click();
  await expect(page.getByTestId("compare-dropzone")).toBeVisible();

  // react-dropzone keeps a hidden <input type=file> inside the zone.
  await page
    .getByTestId("compare-dropzone")
    .locator('input[type="file"]')
    .setInputFiles(FIXTURE);

  // Upload (~600 KB) + migration + diff of ~78k stop_times both sides.
  await expect(page.getByTestId("compare-identical")).toBeVisible({
    timeout: 120_000,
  });

  // Reset returns to the dropzone for another comparison.
  await page.getByTestId("compare-reset").click();
  await expect(page.getByTestId("compare-dropzone")).toBeVisible();
});
