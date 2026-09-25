/**
 * territoryPanel.test.js — the territory panel: a place is analysed through
 * the API, the dossier is shown (key figures, generators, coverage,
 * sources, retry, the existing network), existing stops can be pulled into
 * the plan, and a place the geocoder does not know is reported without
 * breaking the studio.
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));
vi.mock("../components/edit/BetaGateDialog", () => ({ BETA_CODE_STORAGE_KEY: "beta-code" }));

import TerritoryPanel from "../components/network/TerritoryPanel";

const theme = createTheme();
const DOSSIER = {
  place: { query: "Aurillac", name: "Aurillac", display_name: "Aurillac, Cantal, France", country: "France", country_code: "fr", lat: 44.92, lon: 2.44, bbox: [44.9, 2.4, 44.95, 2.5] },
  timezone: "Europe/Paris",
  elevation_m: 620,
  population: { value: 25000, source: "wikidata" },
  existing_stops: [
    { id: "osm:1", name: "Gare SNCF", lat: 44.92, lon: 2.44, kind: "station" },
    { id: "osm:2", name: "Hôpital", lat: 44.93, lon: 2.45, kind: "bus_stop" },
  ],
  existing_lines: [{ id: "osm:r1", ref: "A", name: "Ligne A", mode: "bus" }],
  pois: { categories: { hospital: 1, school: 2 }, items: [{ id: "p1", name: "Centre hospitalier", category: "hospital", lat: 44.93, lon: 2.45, weight: 4 }] },
  holidays: [{ date: "20260101", name: "Jour de l'an", en: "New Year's Day" }],
  school_holidays: [{ start: "2026-02-14", end: "2026-03-02", name: "Vacances d'hiver", nationwide: false }],
  sources: [{ id: "osm", name: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright", license: "ODbL" }],
  warnings: ["nager: HTTP 500"],
  generatedAt: "2026-09-24T00:00:00.000Z",
  fromCache: false,
};

const renderPanel = (props = {}) => {
  const onTerritory = vi.fn();
  const onUseExistingStops = vi.fn();
  const onImportedFeed = vi.fn();
  render(
    <ThemeProvider theme={theme}>
      <TerritoryPanel territory={null} onTerritory={onTerritory} coverage={null} onUseExistingStops={onUseExistingStops} {...props} />
    </ThemeProvider>,
  );
  return { onTerritory, onUseExistingStops, onImportedFeed };
};

describe("TerritoryPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("analyses a place and hands the dossier back", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => DOSSIER });
    const { onTerritory } = renderPanel();
    expect(screen.getByText("territory.hint")).toBeTruthy();
    // The analyse action is a quiet text button inside the search field.
    expect(screen.getByTestId("territory-search").disabled).toBe(true);
    fireEvent.change(screen.getByTestId("territory-query"), { target: { value: "Aurillac" } });
    expect(screen.getByTestId("territory-search").disabled).toBe(false);
    fireEvent.keyDown(screen.getByTestId("territory-query"), { key: "Enter" });
    await waitFor(() => expect(onTerritory).toHaveBeenCalledWith(DOSSIER));
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toMatch(/\/network\/territory$/);
    expect(JSON.parse(init.body)).toEqual({ place: "Aurillac", force: false });
  });

  it("shows the dossier as key figures, generators by kind, coverage meters, sources behind an info button", () => {
    const coverage = { pois_total: 3, pois_covered: 2, coverage_pct: 67, population: { pct: 58 }, stops_planned: 5, existing_stops_reused: 2, top_missed: [{ name: "Lycée Duclaux" }] };
    const { onUseExistingStops } = renderPanel({ territory: DOSSIER, coverage });
    expect(screen.getByTestId("territory-card")).toBeTruthy();
    expect(screen.getByText("Aurillac")).toBeTruthy();
    expect(screen.getByText(/Europe\/Paris/)).toBeTruthy();
    expect(screen.getByText(/territory\.population/)).toBeTruthy();
    // Key figures: numbers over labels, no chips.
    expect(screen.getByTestId("territory-stat-stops").textContent).toBe("2territory.stat.stops");
    expect(screen.getByTestId("territory-stat-pois").textContent).toBe("1territory.stat.pois");
    expect(screen.getByTestId("territory-stat-lines").textContent).toBe("1territory.stat.lines");
    expect(screen.getByTestId("territory-stat-holidays").textContent).toBe("1territory.stat.holidays");
    // Generators by kind: an icon and a count, labelled for assistive tech.
    expect(screen.getByLabelText("territory.category.school 2")).toBeTruthy();
    expect(screen.getByLabelText("territory.category.hospital 1")).toBeTruthy();
    // Coverage as two meters, and the main missed place.
    const cov = screen.getByTestId("territory-coverage");
    expect(cov.textContent).toContain("territory.coverageTitle");
    expect(cov.textContent).toContain("67%");
    expect(cov.textContent).toContain("58%");
    expect(cov.textContent).toContain("territory.missed");
    // Sources are one click away, not a paragraph.
    expect(screen.queryByText("OpenStreetMap")).toBeNull();
    fireEvent.click(screen.getByTestId("territory-sources"));
    expect(screen.getByText("OpenStreetMap").getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    // Layers live on the map, not in the panel.
    expect(screen.queryByTestId("territory-layer-pois")).toBeNull();
    fireEvent.click(screen.getByTestId("territory-use-stops"));
    expect(onUseExistingStops).toHaveBeenCalledWith(DOSSIER);
  });

  it("a partial dossier offers a retry that forces a fresh read", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...DOSSIER, warnings: [] }) });
    const { onTerritory } = renderPanel({ territory: DOSSIER });
    expect(screen.getByText("territory.partial")).toBeTruthy();
    fireEvent.click(screen.getByTestId("territory-retry"));
    await waitFor(() => expect(onTerritory).toHaveBeenCalled());
    expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body)).toEqual({ place: "Aurillac", force: true });
  });

  it("folds into a one-line summary", () => {
    renderPanel({ territory: DOSSIER });
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(screen.getByText(/Aurillac · territory\.stops/)).toBeTruthy();
  });

  it("the existing network: the list, then a single baseline line once one is loaded", async () => {
    const feeds = [1, 2, 3, 4, 5].map((i) => ({ id: String(i), provider: `Réseau ${i}`, name: "Bus", country: "FR", url: `https://feeds.example/${i}.zip`, scope: i === 1 ? "local" : "regional", covers_centre: true }));
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/catalog/import")) return { ok: true, status: 200, json: async () => ({ spec: { agency: {}, stops: [], lines: [] }, stats: { lines: 2, stops: 10 }, report: { score: 55 } }) };
      return { ok: true, status: 200, json: async () => ({ feeds }) };
    });
    const onImportedFeed = vi.fn();
    renderPanel({ territory: DOSSIER, onImportedFeed });
    fireEvent.click(screen.getByTestId("feeds-search"));
    await waitFor(() => expect(screen.getAllByTestId("feed-row")).toHaveLength(3));
    // Only the local feed carries the tag; the rest folds behind "n more".
    expect(screen.getAllByText("feeds.local")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("feeds-more"));
    expect(screen.getAllByTestId("feed-row")).toHaveLength(5);
    fireEvent.click(screen.getAllByTestId("feed-import")[0]);
    await waitFor(() => expect(screen.getByTestId("feeds-base")).toBeTruthy());
    expect(onImportedFeed).toHaveBeenCalledWith(expect.objectContaining({ stats: { lines: 2, stops: 10 } }), feeds[0]);
    expect(screen.queryAllByTestId("feed-row")).toHaveLength(0);
    expect(screen.getByTestId("feeds-base").textContent).toContain("feeds.base");
  });

  it("reports an unknown place without handing anything back", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "PLACE_NOT_FOUND", message: "No such place" }) });
    const { onTerritory } = renderPanel();
    fireEvent.change(screen.getByTestId("territory-query"), { target: { value: "Nowhere" } });
    fireEvent.click(screen.getByTestId("territory-search"));
    await waitFor(() => expect(screen.getByText("territory.notFound")).toBeTruthy());
    expect(onTerritory).not.toHaveBeenCalled();
  });
});
