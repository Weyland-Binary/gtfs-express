// SQL Console — read-only path: open the console on the sample feed, type a
// query into CodeMirror, run it, and check the result renders.

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

test("a SELECT typed in the editor runs and renders its result", async () => {
  await page.getByTestId("tab-sql").click();

  const editor = page.locator(".cm-content");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.click();
  await page.keyboard.type(
    "SELECT 'e2e_marker' AS marker, COUNT(*) AS n FROM stops",
  );

  await page.getByTestId("sql-run").click();

  // The sample feed ships 320 stops; the marker pins the assertion to OUR
  // result row rather than any incidental occurrence of the number.
  await expect(page.getByText("e2e_marker").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("320", { exact: true }).first()).toBeVisible();
});
