// i18n smoke — drive the language selector through all 8 languages on the
// landing page and assert the document adapts (lang attribute, RTL for
// Arabic) and the page still renders content. A render crash in any locale
// would blank the page and fail the visibility assertions.

const { test, expect } = require("@playwright/test");

const LANGUAGES = ["en", "fr", "es", "de", "pt", "zh", "ar", "hi"];

test("all 8 languages render and Arabic flips the document to RTL", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("uploader-load-sample")).toBeVisible();

  for (const code of LANGUAGES) {
    await page.getByTestId("language-selector").click();
    await page.getByTestId(`language-option-${code}`).click();

    await expect(page.locator("html")).toHaveAttribute("lang", code);
    const expectedDir = code === "ar" ? "rtl" : "ltr";
    await expect(page.locator("html")).toHaveAttribute("dir", expectedDir);

    // The uploader tile must keep rendering visible text in every locale.
    await expect(page.getByTestId("uploader-load-sample")).toBeVisible();
    const text = await page.getByTestId("uploader-load-sample").innerText();
    expect(text.trim().length).toBeGreaterThan(0);
  }
});
