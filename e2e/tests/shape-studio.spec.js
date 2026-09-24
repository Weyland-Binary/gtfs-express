// GTFS Express — Shape Studio: reachability, pattern-based shape creation,
// section editing tools, base map switch, and the undo path back.
//
// The map itself is Leaflet: vertex markers are located by their DivIcon
// size (12 px interior vertices) and driven with mouse coordinates.

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

/** @type {import('@playwright/test').Page} */
let page;

const pointCount = async () => {
  const text = await page.getByTestId("shape-editor-toolbar").innerText();
  const m = /(\d+)\s+points/.exec(text);
  return m ? Number(m[1]) : NaN;
};

// Interior, unselected vertex markers of the editor (12 px DivIcons).
const vertexMarkers = () =>
  page
    .locator(".leaflet-marker-icon.leaflet-interactive:not(.gtfs-stop-marker)")
    .filter({ has: page.locator('div[style*="width:12px"]') });

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
  await expect(page.getByTestId("edit-undo")).toBeVisible({ timeout: 30_000 });

  await page.getByTestId("tab-shape-studio").click();
  await expect(page.getByTestId("shape-studio")).toBeVisible({
    timeout: 30_000,
  });
  expect(page.url()).toContain("tab=studio");
});

test("a shape is created from a stop pattern and linked to its trips", async () => {
  test.setTimeout(120_000);
  await page.getByTestId("studio-line-S1").click();
  await expect(page.getByTestId("studio-shape-list")).toBeVisible({ timeout: 30_000 });
  const cards = page.getByTestId("studio-shape-card");
  const before = await cards.count();
  expect(before).toBeGreaterThan(0);

  // New shape → the line's stop patterns are listed, the busiest preselected.
  await page.getByTestId("studio-new-shape").click();
  const dialog = page.getByTestId("new-shape-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("new-shape-pattern").first()).toBeVisible({ timeout: 30_000 });
  await dialog.getByTestId("new-shape-method-straight").click();
  await dialog.getByTestId("new-shape-create").click();

  // Editor opens pre-seeded with the pattern's stops: every stop is on the trace.
  const toolbar = page.getByTestId("shape-editor-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 30_000 });
  await expect(toolbar.getByTestId("shape-fit-ok")).toBeVisible();
  expect(await pointCount()).toBeGreaterThan(3);

  await toolbar.getByTestId("shape-save").click();
  await expect(toolbar).toHaveCount(0, { timeout: 30_000 });

  // The new shape is listed and selected with the pattern's trips; the
  // shape those trips used before (S1_0) lost every trip and now sits in
  // the "unassigned shapes" section of the rail.
  const created = page.locator('[data-testid="studio-shape-card"][data-shape-id^="shp_S1_"]');
  await expect(created).toHaveCount(1, { timeout: 30_000 });
  await expect(created).toContainText("267 trips");
  await expect(cards).toHaveCount(before);
  const strip = page.getByTestId("studio-status-strip");
  await expect(strip).toContainText("267 trips");
  await expect(page.getByTestId("studio-unused-S1_0")).toBeVisible();
});

test("section tools straighten part of the shape; undo removes the shape again", async () => {
  test.setTimeout(120_000);
  const cards = page.getByTestId("studio-shape-card");
  const count = await cards.count();

  // Double-clicking the selected card opens the editor.
  await page.getByTestId("studio-edit").click();
  const toolbar = page.getByTestId("shape-editor-toolbar");
  await expect(toolbar).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(800); // let fitBounds settle
  const n0 = await pointCount();
  expect(n0).toBeGreaterThan(5);

  // Select a section of four vertices (click, then Shift+click) and straighten it.
  const markers = vertexMarkers();
  await expect(markers.nth(3)).toBeVisible();
  const a = await markers.nth(0).boundingBox();
  const b = await markers.nth(3).boundingBox();
  await page.mouse.click(a.x + a.width / 2, a.y + a.height / 2);
  await expect(toolbar.getByTestId("shape-selection-panel")).toBeVisible();
  await page.keyboard.down("Shift");
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.keyboard.up("Shift");
  await expect(toolbar.getByTestId("shape-section-straighten")).toBeEnabled();
  await toolbar.getByTestId("shape-section-straighten").click();
  expect(await pointCount()).toBe(n0 - 2);

  // Local undo restores the vertices; Escape leaves the editor (clean).
  await toolbar.getByTestId("shape-undo").click();
  expect(await pointCount()).toBe(n0);
  await page.keyboard.press("Escape"); // clears the selection
  await page.keyboard.press("Escape"); // closes the editor (nothing to discard)
  await expect(toolbar).toHaveCount(0, { timeout: 10_000 });

  // Base map switch persists.
  await page.getByTestId("basemap-control").click();
  await page.getByTestId("basemap-satellite").click();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("gtfs_basemap")))
    .toBe("satellite");
  await expect(page.locator(".leaflet-tile-pane img[src*='arcgisonline']").first()).toBeAttached({
    timeout: 10_000,
  });
  await page.getByTestId("basemap-control").click();
  await page.getByTestId("basemap-auto").click();

  // Server-side undo of the creation: the shape and its trip links go away
  // and S1_0 gets its trips back.
  await page.getByTestId("edit-undo").click();
  await expect(
    page.locator('[data-testid="studio-shape-card"][data-shape-id^="shp_S1_"]'),
  ).toHaveCount(0, { timeout: 30_000 });
  await expect(cards).toHaveCount(count);
  await expect(page.getByTestId("studio-unused-shapes")).toHaveCount(0);
});

test("leaving edit mode drops the studio and its tab", async () => {
  await page.getByTestId("edit-mode-exit").click();
  // The session carries unsaved (undone) edits: confirm the discard.
  await page.getByRole("button", { name: "Discard and continue" }).click();
  await expect(page.getByTestId("tab-shape-studio")).toHaveCount(0, {
    timeout: 30_000,
  });
});
