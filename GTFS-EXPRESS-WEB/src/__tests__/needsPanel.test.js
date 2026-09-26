/**
 * needsPanel.test.js — "What we need from you": needs listed by impact with
 * their reason and the action that answers them, the chip that counts the
 * essential ones, and the levers' table (fleet and cost of each choice).
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));

import NeedsPanel, { NeedsChip } from "../components/network/NeedsPanel";

const withTheme = (ui) => <ThemeProvider theme={createTheme()}>{ui}</ThemeProvider>;
const NEEDS = {
  needs: [
    { id: "stops_unlocated", impact: "high", state: "missing", params: { count: 2 }, action: "map" },
    { id: "caps", impact: "medium", state: "missing", params: { fleet: 6, cost_year: 1200000, currency: "EUR" }, action: "settings" },
    { id: "validity", impact: "low", state: "defaulted", params: {}, action: "settings" },
  ],
  counts: { high: 1, medium: 1, low: 1 },
};
const LEVERS = { currency: "EUR", base: { fleet: 6, cost_year: 1200000 }, variants: [{ id: "peak_headway", params: { minutes: 10 }, fleet: 9, cost_year: 1500000, delta_fleet: 3, delta_cost: 300000 }, { id: "no_sunday", params: {}, fleet: 6, cost_year: 1100000, delta_fleet: 0, delta_cost: -100000 }] };

describe("NeedsPanel", () => {
  it("lists the needs with their impact and routes each action", () => {
    const onAction = vi.fn();
    render(withTheme(<NeedsPanel needs={NEEDS} levers={LEVERS} onAction={onAction} />));
    const rows = screen.getAllByTestId("need");
    expect(rows.map((r) => r.getAttribute("data-impact"))).toEqual(["high", "medium", "low"]);
    fireEvent.click(screen.getByTestId("need-action-stops_unlocated"));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ id: "stops_unlocated", action: "map" }));
  });

  it("shows what each choice costs", () => {
    render(withTheme(<NeedsPanel needs={NEEDS} levers={LEVERS} />));
    const table = screen.getByTestId("levers");
    expect(table.textContent).toMatch(/network\.levers\.peak/);
    expect(table.textContent).toMatch(/\(\+3\)/);
  });

  it("the chip counts the essential needs", () => {
    render(withTheme(<NeedsChip needs={NEEDS} onClick={() => {}} />));
    expect(screen.getByTestId("needs-chip").getAttribute("data-high")).toBe("1");
  });
});
