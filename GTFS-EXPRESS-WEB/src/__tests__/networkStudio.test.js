/**
 * networkStudio.test.js — the studio mounts (its hooks are declared in an
 * order that survives a production build), restores a draft with its
 * territory, and pulls the territory's named stops into the plan.
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));
vi.mock("../utils/featuresApi", () => ({ useFeatures: () => ({ features: { chat: { enabled: true } } }) }));
vi.mock("../components/edit/BetaGateDialog", () => ({ BETA_CODE_STORAGE_KEY: "beta-code" }));
vi.mock("../components/network/NetworkMap", () => ({ default: (props) => <div data-testid="network-map" data-existing={(props.existingStops || []).length} data-pois={(props.pois || []).length} /> }));

import NetworkStudio from "../components/network/NetworkStudio";

const theme = createTheme({ palette: { ai: { main: "#7c4dff", gradientStart: "#7c4dff", gradientEnd: "#00bcd4", contrastText: "#fff" } } });
const TERRITORY = {
  place: { query: "Aurillac", name: "Aurillac", display_name: "Aurillac, France", country: "France", country_code: "fr", lat: 44.92, lon: 2.44, bbox: [44.9, 2.4, 44.95, 2.5] },
  timezone: "Europe/Paris",
  elevation_m: null,
  population: null,
  existing_stops: [
    { id: "osm:1", name: "Gare", lat: 44.92, lon: 2.44, kind: "station" },
    { id: "osm:2", name: "Hôpital", lat: 44.93, lon: 2.45, kind: "bus_stop" },
    { id: "osm:3", name: null, lat: 44.93, lon: 2.46, kind: "bus_stop" },
  ],
  existing_lines: [],
  pois: { categories: { school: 1 }, items: [{ id: "p1", name: "École", category: "school", lat: 44.93, lon: 2.45, weight: 3 }] },
  holidays: [],
  school_holidays: [],
  sources: [{ id: "osm", name: "OpenStreetMap", url: "https://www.openstreetmap.org/copyright", license: "ODbL" }],
  warnings: [],
};

const mount = () =>
  render(
    <ThemeProvider theme={theme}>
      <NetworkStudio open onClose={() => {}} onCreated={() => {}} />
    </ThemeProvider>,
  );

describe("NetworkStudio", () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, spec: { lines: [], stops: [] }, issues: [], blockers: 0, estimate: {} }) });
  });

  it("mounts empty with the brief, the territory search and the map", () => {
    mount();
    expect(screen.getByTestId("network-studio")).toBeTruthy();
    expect(screen.getByTestId("plan-brief")).toBeTruthy();
    expect(screen.getByTestId("territory-query")).toBeTruthy();
    expect(screen.getByTestId("network-map").getAttribute("data-existing")).toBe("0");
  });

  it("restores a draft with its territory and pulls the named existing stops into the plan", async () => {
    localStorage.setItem("gtfs:network-draft", JSON.stringify({ spec: { agency: { name: "", url: "", timezone: "" }, stops: [], lines: [] }, turns: [], territory: TERRITORY }));
    mount();
    await waitFor(() => expect(screen.getByTestId("territory-card")).toBeTruthy());
    expect(screen.getByTestId("network-map").getAttribute("data-existing")).toBe("3");
    expect(screen.getByTestId("network-map").getAttribute("data-pois")).toBe("1");
    fireEvent.click(screen.getByTestId("territory-use-stops"));
    await waitFor(() => expect(screen.getAllByTestId("stop-row")).toHaveLength(2));
    // Back on the map, hiding the layer removes the markers.
    fireEvent.click(screen.getByTestId("network-tab-map"));
    await waitFor(() => expect(screen.getByTestId("network-map").getAttribute("data-existing")).toBe("3"));
    fireEvent.click(screen.getByTestId("territory-layer-stops"));
    await waitFor(() => expect(screen.getByTestId("network-map").getAttribute("data-existing")).toBe("0"));
  });
});
