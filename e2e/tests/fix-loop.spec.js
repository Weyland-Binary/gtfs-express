// GTFS Express — validate → locate → fix loop on a broken feed.
//
// Builds a deliberately broken copy of the bundled sample feed (invalid
// route colour, stop without name, arrival before the previous departure,
// invalid agency URL), uploads it, and checks that:
//   - the repair station opens with findings linked to their records
//     (entityType/entityId derived from the MobilityData engine output),
//   - the "Fix one by one" queue opens the right editor with the offending
//     field flagged,
//   - fixing the colour then re-validating removes the invalid_color rule.
//
// Requires the real MobilityData JAR (GTFS_CANONICAL_VALIDATOR_JAR); with the
// dev stub validator every feed is "valid" and the suite skips itself.

const { test, expect } = require("@playwright/test");
const fs = require("fs");
const path = require("path");

test.describe.configure({ mode: "serial" });

const SAMPLE_DIR = path.resolve(__dirname, "..", "..", "GTFS-EXPRESS-API", "sample");
const TMP_DIR = path.resolve(__dirname, "..", ".tmp");
const BROKEN_ZIP = path.join(TMP_DIR, "broken-sample.zip");

/** @type {import('@playwright/test').Page} */
let page;

const breakLine = (text, predicate, replace) =>
  text
    .split("\n")
    .map((line, i) => (i > 0 && predicate(line) ? replace(line) : line))
    .join("\n");

async function buildBrokenZip() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  // archiver ships with the API package; the harness runs next to it.
  const archiver = require(
    path.resolve(__dirname, "..", "..", "GTFS-EXPRESS-API", "node_modules", "archiver"),
  );
  const out = fs.createWriteStream(BROKEN_ZIP);
  const archive = archiver("zip", { zlib: { level: 6 } });
  const done = new Promise((resolve, reject) => {
    out.on("close", resolve);
    archive.on("error", reject);
  });
  archive.pipe(out);
  for (const file of fs.readdirSync(SAMPLE_DIR)) {
    let text = fs.readFileSync(path.join(SAMPLE_DIR, file), "utf8");
    if (file === "routes.txt") {
      text = breakLine(text, (l) => l.startsWith("S1,"), (l) => l.replace(",B51017,", ",ZZZZZZ,"));
    } else if (file === "stops.txt") {
      text = breakLine(text, (l) => l.startsWith("34F,"), (l) => l.replace("34F,34F,East 34 St Ferry,", "34F,34F,,"));
    } else if (file === "stop_times.txt") {
      text = breakLine(
        text,
        (l) => l.startsWith("B1_WKD_0_001,05:03:22,"),
        (l) => l.replace("B1_WKD_0_001,05:03:22,05:03:22,", "B1_WKD_0_001,04:03:22,04:03:22,"),
      );
    } else if (file === "agency.txt") {
      text = breakLine(text, () => true, (l) => l.replace("https://example.com/nyc-demo-transit,", "notaurl,"));
    }
    archive.append(text, { name: file });
  }
  await archive.finalize();
  await done;
}

test.beforeAll(async ({ browser }) => {
  await buildBrokenZip();
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.localStorage.setItem("appLanguage", "en");
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  await page?.context().close();
});

test("a broken feed lands on the repair station with entity-linked findings", async () => {
  test.setTimeout(240_000);
  await page.goto("/");
  await expect(page.getByTestId("uploader-load-sample")).toBeVisible();
  await page.locator('input[type="file"]').first().setInputFiles(BROKEN_ZIP);

  // Rescue landing: the validation page opens on top of the loaded app.
  // With the stub validator the feed is accepted as valid → skip the suite.
  const validationPage = page.getByTestId("validation-page");
  const home = page.getByTestId("tab-home");
  await expect(validationPage.or(home).first()).toBeVisible({ timeout: 180_000 });
  if (!(await validationPage.isVisible().catch(() => false))) {
    test.skip(true, "stub validator: no findings to fix");
    return;
  }
  // The blocking findings are listed by rule, and the fix queue is offered
  // because the server identified the offending records.
  await expect(page.getByText("invalid_color").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("fix-queue-start")).toBeVisible();
});

test("the fix queue opens the editor with the offending field flagged, and re-validation clears the rule", async () => {
  test.setTimeout(240_000);
  if (!(await page.getByTestId("validation-page").isVisible().catch(() => false))) {
    test.skip(true, "stub validator");
    return;
  }
  // Enter edit mode from the repair station (beta gate disabled in the harness).
  await page.getByTestId("rescue-fix-cta").click();
  await expect(page.getByTestId("edit-undo")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("fix-queue-start").click();
  await expect(page.getByTestId("fix-queue-bar")).toBeVisible();

  // Walk the queue until the route dialog for the invalid colour opens
  // (queue order follows the rule list: errors first, by volume).
  let flagged = null;
  for (let i = 0; i < 6; i++) {
    const dialog = page.locator(".MuiDialog-root").last();
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    // The colour field wraps a hidden native <input type="color">: target the text input.
    const candidate = dialog.locator('.gtfs-field-flagged input[type="text"]');
    if ((await candidate.count()) > 0 && (await dialog.getByText("Edit route").count()) > 0) {
      flagged = candidate.first();
      break;
    }
    await page.keyboard.press("Escape");
    await page.getByTestId("fix-queue-next").click();
  }
  expect(flagged, "route dialog with flagged route_color").not.toBeNull();

  // Fix the colour, save, close the queue, re-validate.
  await flagged.fill("B51017");
  await page.keyboard.press("Control+Enter");
  await expect(page.locator(".MuiDialog-root")).toHaveCount(0, { timeout: 30_000 });
  await page.getByTestId("fix-queue-bar").getByLabel("Close").click();

  // The report is now out of date: the page says so and the fixed row is
  // dimmed until the next validation run confirms.
  await expect(page.getByTestId("validation-stale-banner")).toBeVisible();

  await page.getByTestId("rescue-revalidate").click();
  await expect(page.getByText("invalid_color")).toHaveCount(0, { timeout: 120_000 });
});
