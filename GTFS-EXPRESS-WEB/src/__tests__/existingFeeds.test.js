/**
 * existingFeeds.test.js — the network that already runs: the catalog list
 * in the territory panel, loading a feed as the baseline, the accessibility
 * block of the quality card, and the pulse control of the lines editor.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));
vi.mock("../components/edit/BetaGateDialog", () => ({ BETA_CODE_STORAGE_KEY: "beta-code" }));

import ExistingFeeds from "../components/network/ExistingFeeds";
import { QualityCard } from "../components/network/PlanCards";
import { LinesEditor } from "../components/network/SpecEditors";

const theme = createTheme();
const withTheme = (ui) => <ThemeProvider theme={theme}>{ui}</ThemeProvider>;

describe("ExistingFeeds", () => {
  it("lists the feeds covering the place and loads one as the baseline", async () => {
    const onImported = vi.fn();
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/network/catalog/import")) return { ok: true, status: 200, json: async () => ({ spec: { agency: { name: "X" }, stops: [], lines: [] }, stats: { lines: 3, stops: 40 }, report: { score: 61 } }) };
      return { ok: true, status: 200, json: async () => ({ place: "Ville", feeds: [{ id: "1", provider: "Réseau Urbain", name: "Bus", country: "FR", municipality: "Ville", url: "https://feeds.example/u.zip", license: "https://l.example", covers_centre: true }, { id: "2", provider: "Région", name: "TER", country: "FR", region: "Centre", url: "https://feeds.example/r.zip", covers_centre: false }] }) };
    });
    render(withTheme(<ExistingFeeds place="Ville" onImported={onImported} />));
    fireEvent.click(screen.getByTestId("feeds-search"));
    await waitFor(() => expect(screen.getAllByTestId("feed-row")).toHaveLength(2));
    expect(screen.getByText("Réseau Urbain")).toBeTruthy();
    expect(screen.getByText("feeds.local")).toBeTruthy();
    expect(screen.getByText("feeds.license").getAttribute("href")).toBe("https://l.example");
    fireEvent.click(screen.getAllByTestId("feed-import")[0]);
    await waitFor(() => expect(onImported).toHaveBeenCalled());
    const [result, feed] = onImported.mock.calls[0];
    expect(result.stats.lines).toBe(3);
    expect(feed.provider).toBe("Réseau Urbain");
    const importCall = globalThis.fetch.mock.calls.find((c) => String(c[0]).includes("/catalog/import"));
    expect(JSON.parse(importCall[1].body)).toEqual({ url: "https://feeds.example/u.zip", place: "Ville" });
  });

  it("says when no feed covers the area or the catalog is down", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ feeds: [] }) });
    render(withTheme(<ExistingFeeds place="Ville" onImported={() => {}} />));
    fireEvent.click(screen.getByTestId("feeds-search"));
    await waitFor(() => expect(screen.getByText("feeds.none")).toBeTruthy());
  });
});

describe("accessibility in the quality card", () => {
  it("renders the reach of each target and the residents served", () => {
    const quality = { score: 70, grade: "B", majors: 0, dimensions: [], recommendations: [], accessibility: { at: "08:00", cutoffs_min: [30, 45, 60], residents_served_pct: 82, targets: [{ name: "Gare", category: "station", served: true, within: { 30: 35, 45: 70, 60: 88 } }, { name: "Hôpital", category: "hospital", served: false, within: { 30: 0, 45: 0, 60: 0 } }] } };
    render(withTheme(<QualityCard quality={quality} />));
    const block = screen.getByTestId("quality-accessibility");
    expect(block.textContent).toContain("network.access.title");
    expect(block.textContent).toContain("network.access.served");
    expect(block.textContent).toContain("Gare");
    expect(block.textContent).toContain("35%");
    expect(block.textContent).toContain("88%");
    expect(block.textContent).toContain("network.access.unserved");
  });
});

describe("pulse control", () => {
  it("sets and clears the network sync from the lines editor", () => {
    const onChange = vi.fn();
    const spec = { agency: {}, stops: [{ id: "gare", name: "Gare", lat: 1, lon: 1 }, { id: "centre", name: "Centre", lat: 1, lon: 1 }], lines: [{ short_name: "A", mode: "bus", directions: [{ id: "0", headsign: "", stops: ["gare", "centre"] }], services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "20:00", headway_min: 30 }] }] }] };
    render(withTheme(<LinesEditor spec={spec} onChange={onChange} />));
    expect(screen.getByTestId("sync-editor")).toBeTruthy();
    fireEvent.change(screen.getByTestId("sync-stop"), { target: { value: "centre" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sync: { stop: "centre", minute: 0 } }));
    const { unmount } = render(withTheme(<LinesEditor spec={{ ...spec, sync: { stop_id: "centre", minute: 0 } }} onChange={onChange} />));
    fireEvent.change(screen.getAllByTestId("sync-minute")[0], { target: { value: "15" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sync: { stop: "centre", minute: 15 } }));
    unmount();
  });
});
