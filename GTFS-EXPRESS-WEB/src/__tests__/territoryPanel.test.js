/**
 * territoryPanel.test.js — the territory panel: a place is analysed through
 * the API, the dossier is shown (facts, layers, generators, coverage,
 * sources), existing stops can be pulled into the plan, and a place the
 * geocoder does not know is reported without breaking the studio.
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
  const onToggleLayer = vi.fn();
  const onUseExistingStops = vi.fn();
  render(
    <ThemeProvider theme={theme}>
      <TerritoryPanel territory={null} onTerritory={onTerritory} layers={{ stops: true, pois: true }} onToggleLayer={onToggleLayer} coverage={null} onUseExistingStops={onUseExistingStops} {...props} />
    </ThemeProvider>,
  );
  return { onTerritory, onToggleLayer, onUseExistingStops };
};

describe("TerritoryPanel", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("analyses a place and hands the dossier back", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => DOSSIER });
    const { onTerritory } = renderPanel();
    expect(screen.getByText("territory.hint")).toBeTruthy();
    fireEvent.change(screen.getByTestId("territory-query"), { target: { value: "Aurillac" } });
    fireEvent.keyDown(screen.getByTestId("territory-query"), { key: "Enter" });
    await waitFor(() => expect(onTerritory).toHaveBeenCalledWith(DOSSIER));
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toMatch(/\/network\/territory$/);
    expect(JSON.parse(init.body)).toEqual({ place: "Aurillac", force: false });
  });

  it("shows the dossier: facts, layers, generators, coverage, sources, partial warning", () => {
    const coverage = { pois_total: 3, pois_covered: 2, coverage_pct: 67, stops_planned: 5, existing_stops_reused: 2, top_missed: [{ name: "Lycée Duclaux" }] };
    const { onToggleLayer, onUseExistingStops } = renderPanel({ territory: DOSSIER, coverage });
    expect(screen.getByTestId("territory-card")).toBeTruthy();
    expect(screen.getByText("Aurillac")).toBeTruthy();
    expect(screen.getByText(/Europe\/Paris/)).toBeTruthy();
    expect(screen.getByText(/territory\.population/)).toBeTruthy();
    expect(screen.getByText("territory.stops")).toBeTruthy();
    expect(screen.getByText("territory.category.hospital 1")).toBeTruthy();
    expect(screen.getByText("territory.category.school 2")).toBeTruthy();
    expect(screen.getByTestId("territory-coverage").textContent).toContain("territory.coverage");
    expect(screen.getByTestId("territory-coverage").textContent).toContain("territory.missed");
    expect(screen.getByText("OpenStreetMap").getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
    expect(screen.getByText("territory.partial")).toBeTruthy();
    fireEvent.click(screen.getByTestId("territory-layer-pois"));
    expect(onToggleLayer).toHaveBeenCalledWith("pois");
    fireEvent.click(screen.getByTestId("territory-use-stops"));
    expect(onUseExistingStops).toHaveBeenCalledWith(DOSSIER);
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
