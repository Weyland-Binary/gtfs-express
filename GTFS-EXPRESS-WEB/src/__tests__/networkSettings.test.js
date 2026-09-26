/**
 * networkSettings.test.js — a network built by hand needs no JSON: the
 * operator, validity, weekend, holidays and caps have a form; the territory
 * fills the empty ones (never overwrites); stops added by hand get an id so
 * they can be placed and put on a line.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key), language: "fr" }),
}));

import NetworkSettings, { prefillFromTerritory } from "../components/network/NetworkSettings";
import { withStopIds } from "../components/network/SpecEditors";

const withTheme = (ui) => <ThemeProvider theme={createTheme()}>{ui}</ThemeProvider>;
const TERRITORY = {
  timezone: "Asia/Riyadh",
  country: { languages: ["ar", "en"], weekend: ["fri", "sat"] },
  holidays: [{ date: "20260923", name: "National Day" }, { date: "20270223", name: "Founding Day" }, { date: "20300101", name: "Far away" }],
};

describe("prefillFromTerritory", () => {
  it("fills the empty settings from the territory, holidays within the validity", () => {
    const { spec, filled } = prefillFromTerritory({ agency: { name: "X" }, feed: { start_date: "20260901", end_date: "20270831" }, lines: [] }, TERRITORY);
    expect(filled).toEqual(["timezone", "lang", "weekend", "holidays"]);
    expect(spec.agency).toMatchObject({ name: "X", timezone: "Asia/Riyadh", lang: "ar" });
    expect(spec.weekend).toEqual(["fri", "sat"]);
    expect(spec.holidays).toEqual(["20260923", "20270223"]);
  });

  it("never overwrites what the user or the assistant set", () => {
    const before = { agency: { timezone: "Europe/Paris", lang: "fr" }, weekend: ["sat", "sun"], holidays: ["20261225"], lines: [] };
    const { spec, filled } = prefillFromTerritory(before, TERRITORY);
    expect(filled).toEqual([]);
    expect(spec).toBe(before);
  });
});

describe("NetworkSettings", () => {
  it("edits the operator, validity and caps, and flags the required fields", () => {
    const onChange = vi.fn();
    // Controlled like in the Studio: the parent keeps the spec.
    function Host() {
      const [spec, setSpec] = React.useState({ agency: {}, lines: [] });
      return <NetworkSettings spec={spec} onChange={(next) => { onChange(next); setSpec(next); }} />;
    }
    render(withTheme(<Host />));
    expect(screen.getByTestId("settings-missing").textContent).toBe("network.settings.missing".replace("{count}", "3"));
    fireEvent.change(screen.getByTestId("settings-agency-name"), { target: { value: "Réseau Test" } });
    expect(onChange.mock.calls.at(-1)[0].agency.name).toBe("Réseau Test");
    fireEvent.change(screen.getByTestId("settings-start"), { target: { value: "2026-09-01" } });
    expect(onChange.mock.calls.at(-1)[0].feed.start_date).toBe("20260901");
    fireEvent.change(screen.getByTestId("settings-max-vehicles"), { target: { value: "12" } });
    expect(onChange.mock.calls.at(-1)[0].operations).toEqual({ max_vehicles: 12 });
    fireEvent.change(screen.getByTestId("settings-max-vehicles"), { target: { value: "" } });
    expect(onChange.mock.calls.at(-1)[0].operations).toBeUndefined();
  });

  it("offers the territory's holidays", () => {
    const onChange = vi.fn();
    render(withTheme(<NetworkSettings spec={{ agency: {}, feed: { start_date: "20260901", end_date: "20270831" }, lines: [] }} onChange={onChange} territory={TERRITORY} />));
    fireEvent.click(screen.getByTestId("settings-territory-holidays"));
    expect(onChange.mock.calls.at(-1)[0].holidays).toEqual(["20260923", "20270223"]);
  });
});

describe("withStopIds", () => {
  it("gives unique ids to stops added by hand and keeps existing ones", () => {
    const existing = [{ id: "S2", name: "A" }, { id: "GARE", name: "Gare" }];
    const out = withStopIds(existing, [{ name: "New" }, { id: "GARE", name: "Dup" }, { id: "osm:1", name: "OSM" }]);
    expect(out.map((s) => s.id)).toEqual(["S3", "S4", "osm:1"]);
  });
});
