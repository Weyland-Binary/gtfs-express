// Network Studio: build a network from a hand-written plan (the assistant
// is off in the harness), then open the resulting session in the app.
//
// The plan is pasted as JSON (the power-user path); the editors, the map and
// the estimate all react to it; "Build the network" compiles it into a new
// session that the dashboard adopts.

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

let page;

const SPEC = {
  agency: { name: "Réseau E2E", url: "https://e2e.example", timezone: "Europe/Paris", lang: "fr" },
  feed: { start_date: "20260901", end_date: "20270831" },
  stops: [
    { id: "GARE", name: "Gare", lat: 47.4, lon: 0.69 },
    { id: "MAIRIE", name: "Mairie", lat: 47.405, lon: 0.695 },
    { id: "HOPITAL", name: "Hôpital", lat: 47.41, lon: 0.7 },
  ],
  lines: [
    {
      short_name: "A",
      long_name: "Gare ↔ Hôpital",
      mode: "bus",
      color: "E53935",
      directions: [{ headsign: "Hôpital", stops: ["GARE", "MAIRIE", "HOPITAL"] }],
      services: [{ calendar: "weekday", periods: [{ from: "07:00", to: "19:00", headway_min: 30 }] }],
    },
  ],
};

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ locale: "en-US" });
  page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("gtfs-language", "en");
    } catch {}
  });
  await page.goto("/");
});

test.afterAll(async () => {
  await page.context().close();
});

test("the landing offers to create a network and the studio validates a pasted plan", async () => {
  await page.getByTestId("uploader-create-network").click();
  const studio = page.getByTestId("network-studio");
  await expect(studio).toBeVisible();
  await expect(page.getByTestId("plan-brief")).toBeVisible();
  await page.getByTestId("network-tab-json").click();
  const json = page.getByTestId("spec-json");
  await json.fill(JSON.stringify(SPEC, null, 2));
  await page.getByTestId("spec-json-apply").click();
  // Live validation: 1 line, 3 stops, 25 departures per direction × 2.
  await expect(page.getByText("1 lines")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("3 stops")).toBeVisible();
  await expect(page.getByText("50 trips")).toBeVisible();
  await expect(page.getByText("Ready to build")).toBeVisible();
});

test("the editors reflect the plan and an edit re-validates it", async () => {
  await page.getByTestId("network-tab-lines").click();
  await expect(page.getByTestId("line-card")).toHaveCount(1);
  await expect(page.getByTestId("line-short-name")).toHaveValue("A");
  await page.getByTestId("network-tab-stops").click();
  await expect(page.getByTestId("stop-row")).toHaveCount(3);
  // Adding an unused stop without coordinates becomes a blocker.
  await page.getByTestId("add-stop").click();
  await expect(page.getByText("1 to fix before building")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("network-build")).toBeDisabled();
  // Remove it again (last row's delete button).
  await page.getByTestId("stop-row").last().getByLabel("Remove").click();
  await expect(page.getByText("Ready to build")).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("network-tab-map").click();
  await expect(page.getByTestId("network-map")).toBeVisible();
});

test("building the network creates a session the app opens", async () => {
  test.setTimeout(120_000);
  await page.getByTestId("network-build").click();
  const result = page.getByTestId("network-result");
  await expect(result).toBeVisible({ timeout: 90_000 });
  await expect(result.getByText(/1 routes, 3 stops, 50 trips and 150 stop times/)).toBeVisible();
  await page.getByTestId("network-open").click();
  await expect(page.getByTestId("tab-home")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("dashboard-validation-health")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Réseau E2E").first()).toBeVisible({ timeout: 30_000 });
});
