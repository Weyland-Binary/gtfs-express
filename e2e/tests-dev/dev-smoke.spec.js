// Vite DEV-MODE smoke: the page must actually execute and render in a real
// browser — an HTTP 200 on / is not enough, since dependency pre-bundling
// failures (CJS/ESM interop) throw at runtime and leave a blank page (the
// MUI/Emotion "styled_default is not a function" regression shipped through
// exactly that gap).
//
// The web server config pre-runs `vite optimize` so the browser opens on a
// warm dependency cache: racing the optimizer mid-flight is inherently
// timing-dependent, while a genuinely broken optimizer OUTPUT — the thing
// this smoke exists to catch — fails on a warm cache all the same.

const { test, expect } = require("@playwright/test");

test("dev server renders the app without page errors", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.getByTestId("uploader-load-sample")).toBeVisible({
    timeout: 30_000,
  });

  // Tolerate external-resource noise (fonts/tiles in sandboxed CI), fail on
  // any uncaught runtime exception.
  expect(pageErrors, `page errors: ${pageErrors.join(" | ")}`).toHaveLength(0);
});
