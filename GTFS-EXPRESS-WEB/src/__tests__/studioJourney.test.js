/**
 * studioJourney.test.js — creating a network from scratch: the welcome
 * card's three entry points, specification documents (upload, chips,
 * expiry, a document alone is a brief), the one-click proposal once the
 * territory is known, the live phases of a planner turn, the journey steps
 * and the country context and works in the territory panel.
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ language: "fr", t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));
vi.mock("../utils/featuresApi", () => ({ useFeatures: () => ({ features: { chat: { enabled: true, freeMessages: 5 } } }) }));
vi.mock("../components/edit/BetaGateDialog", () => ({ BETA_CODE_STORAGE_KEY: "beta-code" }));
vi.mock("../components/network/NetworkMap", () => ({ default: (props) => <div data-testid="network-map" data-works={(props.works || []).length} /> }));

import NetworkStudio from "../components/network/NetworkStudio";
import PlanChat from "../components/network/PlanChat";
import JourneySteps from "../components/network/JourneySteps";
import TerritoryPanel from "../components/network/TerritoryPanel";

const theme = createTheme({ palette: { ai: { main: "#7c4dff", gradientStart: "#7c4dff", gradientEnd: "#00bcd4", contrastText: "#fff" } } });
const withTheme = (ui) => <ThemeProvider theme={theme}>{ui}</ThemeProvider>;

const TERRITORY = {
  place: { query: "Riyadh", name: "Riyadh", display_name: "Riyadh, Saudi Arabia", country: "Saudi Arabia", country_code: "SA", lat: 24.71, lon: 46.67, bbox: [24.6, 46.6, 24.8, 46.8] },
  timezone: "Asia/Riyadh",
  population: { value: 7009100, source: "wikidata" },
  stats: { area_km2: 1913, density_per_km2: 3664 },
  country: { code: "SA", name: "Saudi Arabia", currency: { code: "SAR", symbol: "ر.س" }, languages: ["ar"], weekend: ["fri", "sat"], driving_side: "right", gdp_per_capita_usd: 30448, urban_pct: 85 },
  existing_stops: [{ id: "osm:1", name: "Olaya", lat: 24.71, lon: 46.67, kind: "bus_stop" }],
  existing_lines: [],
  pois: { categories: {}, items: [] },
  works: { counts: { development: 1, transit: 1 }, items: [{ id: "w1", kind: "development", status: "construction", name: "New District", lat: 24.75, lon: 46.7 }, { id: "w2", kind: "transit", status: "construction", name: "Line 7", lat: 24.72, lon: 46.69 }] },
  holidays: [],
  school_holidays: [],
  sources: [],
  warnings: [],
};

describe("welcome and journey", () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, spec: { lines: [], stops: [] }, issues: [], blockers: [], estimate: {} }) });
  });

  it("an empty studio welcomes with three ways to start and the journey steps", async () => {
    render(withTheme(<NetworkStudio open onClose={() => {}} onCreated={() => {}} />));
    expect(screen.getByTestId("studio-welcome")).toBeTruthy();
    expect(screen.getByTestId("welcome-territory")).toBeTruthy();
    expect(screen.getByTestId("welcome-brief")).toBeTruthy();
    expect(screen.getByTestId("welcome-describe")).toBeTruthy();
    // "Analyse a territory" focuses the territory search.
    fireEvent.click(screen.getByTestId("welcome-territory"));
    expect(document.activeElement).toBe(screen.getByTestId("territory-query"));
    fireEvent.click(screen.getByTestId("welcome-describe"));
    expect(document.activeElement).toBe(screen.getByTestId("plan-brief"));
    // The journey starts at the territory.
    expect(screen.getByTestId("journey-territory").getAttribute("data-state")).toBe("current");
    expect(screen.getByTestId("journey-projection").getAttribute("data-state")).toBe("todo");
  });

  it("dropping a specification uploads it, shows a chip, and a document alone can be sent", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith("/network/documents")) {
        expect(init.body).toBeInstanceOf(FormData);
        expect(init.headers["Content-Type"]).toBeUndefined();
        return { ok: true, status: 201, json: async () => ({ id: "a".repeat(24), name: "cdc.pdf", kind: "pdf", pages: 12, size: 250000 }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, spec: { lines: [], stops: [] }, issues: [], blockers: [], estimate: {} }) };
    });
    render(withTheme(<NetworkStudio open onClose={() => {}} onCreated={() => {}} />));
    const file = new File(["%PDF-1.4"], "cdc.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByTestId("welcome-file"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId("plan-document").getAttribute("data-status")).toBe("ready"));
    expect(screen.getByTestId("plan-document").textContent).toContain("cdc.pdf");
    expect(screen.getByTestId("plan-document").textContent).toContain("network.docs.pages");
    // The welcome card leaves once something is started; the brief step is done.
    expect(screen.queryByTestId("studio-welcome")).toBeNull();
    expect(screen.getByTestId("journey-brief").getAttribute("data-state")).toBe("done");
    // Empty composer + a ready document: sending is allowed.
    expect(screen.getByTestId("plan-send").disabled).toBe(false);
    expect(screen.getByTestId("plan-brief").getAttribute("placeholder")).toBe("network.docs.placeholder");
  });
});

describe("PlanChat", () => {
  it("proposes a network for the analysed territory in one click", () => {
    const onSend = vi.fn();
    render(withTheme(<PlanChat turns={[]} streaming={false} pendingTool={null} onSend={onSend} onStop={() => {}} canPlan propose={{ place: "Riyadh" }} />));
    expect(screen.getByTestId("plan-propose-card").textContent).toContain("network.propose.title");
    fireEvent.click(screen.getByTestId("plan-propose"));
    expect(onSend).toHaveBeenCalledWith("network.propose.brief");
  });

  it("sends the default brief when only documents are attached; removal and expired chips", () => {
    const onSend = vi.fn();
    const onRemove = vi.fn();
    const documents = [{ id: "a".repeat(24), name: "cdc.pdf", kind: "pdf", pages: 3, size: 1000, status: "ready" }, { id: "b".repeat(24), name: "old.docx", kind: "text", status: "expired" }];
    render(withTheme(<PlanChat turns={[]} streaming={false} pendingTool={null} onSend={onSend} onStop={() => {}} canPlan documents={documents} onAttach={() => {}} onRemoveDocument={onRemove} />));
    expect(screen.getAllByTestId("plan-document")).toHaveLength(2);
    expect(screen.getAllByTestId("plan-document")[1].textContent).toContain("network.docs.expired");
    fireEvent.click(screen.getByTestId("plan-send"));
    expect(onSend).toHaveBeenCalledWith("network.docs.defaultBrief");
    fireEvent.click(screen.getAllByLabelText("network.docs.remove")[1]);
    expect(onRemove).toHaveBeenCalledWith(documents[1]);
  });

  it("a streaming turn shows the planner's phases, done and current", () => {
    const turns = [
      { id: "u", role: "user", content: "brief" },
      { id: "a", role: "assistant", content: "", status: "streaming", steps: [{ kind: "requirements" }, { kind: "territory", place: "Riyadh" }], questions: [] },
    ];
    render(withTheme(<PlanChat turns={turns} streaming pendingTool="set_spec" onSend={() => {}} onStop={() => {}} canPlan />));
    const phases = screen.getByTestId("plan-phases");
    const state = (p) => phases.querySelector(`[data-phase="${p}"]`).getAttribute("data-state");
    expect(state("understand")).toBe("done");
    expect(state("ground")).toBe("done");
    expect(state("design")).toBe("current");
    expect(state("evaluate")).toBe("todo");
  });
});

describe("JourneySteps", () => {
  it("marks done steps and reports clicks", () => {
    const onStep = vi.fn();
    render(withTheme(<JourneySteps done={{ territory: true, brief: true }} onStep={onStep} />));
    expect(screen.getByTestId("journey-territory").getAttribute("data-state")).toBe("done");
    expect(screen.getByTestId("journey-design").getAttribute("data-state")).toBe("current");
    fireEvent.click(screen.getByTestId("journey-projection"));
    expect(onStep).toHaveBeenCalledWith("projection");
  });
});

describe("TerritoryPanel — worldwide context", () => {
  it("shows density, the country's currency, local weekend and language, and the works under way", () => {
    render(withTheme(<TerritoryPanel territory={TERRITORY} onTerritory={() => {}} coverage={null} onUseExistingStops={() => {}} />));
    expect(screen.getByText(/territory\.density/)).toBeTruthy();
    const country = screen.getByTestId("territory-country").textContent;
    expect(country).toContain("SAR (ر.س)");
    expect(country).toContain("territory.weekend");
    expect(country).toMatch(/arab/i);
    expect(country).toContain("territory.drives.right");
    expect(screen.getByTestId("territory-works").textContent).toContain("territory.works");
    expect(screen.getByLabelText("territory.work.development 1")).toBeTruthy();
    expect(screen.getByLabelText("territory.work.transit 1")).toBeTruthy();
  });
});
