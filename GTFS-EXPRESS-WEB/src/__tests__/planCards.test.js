/**
 * planCards.test.js — the planner's cards in the chat: the requirements
 * (assumptions one click from a correction), the quality report, the
 * questions with suggested answers accepted in one click, and the network
 * report shown when a designed network lands in the application.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));
vi.mock("../components/edit/BetaGateDialog", () => ({ BETA_CODE_STORAGE_KEY: "beta-code" }));

import PlanChat from "../components/network/PlanChat";
import NetworkReportDialog from "../components/network/NetworkReportDialog";
import { findingText, readinessLines } from "../components/network/PlanCards";

const theme = createTheme({ palette: { ai: { main: "#7c4dff", gradientStart: "#7c4dff", gradientEnd: "#00bcd4", contrastText: "#fff" } } });
const withTheme = (ui) => <ThemeProvider theme={theme}>{ui}</ThemeProvider>;

const REQUIREMENTS = {
  operator: "Ville Mobilités",
  area: "Ville, France",
  objectives: ["serve the station"],
  lines_requested: [{ name: "A", mode: "bus", from: "Gare", to: "Hôpital", via: ["Centre"] }],
  service: { days: "weekday + saturday", span: "06:00–21:00", headways: null, holidays: null },
  constraints: [],
  assumptions: [{ topic: "headway", value: "15 min peak", confidence: "medium", reason: "brief silent" }],
  open_questions: [{ id: "sun", question: "Sunday service?", impact: "low", default: "none" }],
};
const QUALITY = {
  score: 72,
  grade: "B",
  majors: 1,
  dimensions: [
    { id: "coverage", weight: 25, score: 60, findings: [{ level: "major", message: "Only 60% covered.", hint: "Add a stop." }] },
    { id: "spacing", weight: 15, score: 80, findings: [] },
    { id: "directness", weight: 15, score: 100, findings: [] },
    { id: "service", weight: 20, score: 70, findings: [{ level: "minor", message: "No Sunday service.", hint: "Add one." }] },
    { id: "connectivity", weight: 10, score: 100, findings: [] },
    { id: "plausibility", weight: 10, score: null, findings: [{ level: "info", message: "Not estimated." }] },
    { id: "compliance", weight: 5, score: 90, findings: [] },
  ],
  recommendations: [],
};

describe("PlanChat cards", () => {
  it("shows the requirements and prefills a correction from an assumption", () => {
    const turns = [{ id: "a1", role: "assistant", content: "Voici le réseau.", steps: [{ kind: "requirements" }, { kind: "quality", score: 72 }], requirements: REQUIREMENTS, quality: QUALITY, status: "complete" }];
    render(withTheme(<PlanChat turns={turns} streaming={false} pendingTool={null} onSend={() => {}} onStop={() => {}} canPlan />));
    expect(screen.getByTestId("plan-requirements")).toBeTruthy();
    expect(screen.getByText("Ville Mobilités")).toBeTruthy();
    expect(screen.getByText(/Gare → Hôpital via Centre/)).toBeTruthy();
    expect(screen.getByText("network.step.requirements")).toBeTruthy();
    expect(screen.getByText("network.step.quality")).toBeTruthy();
    fireEvent.click(screen.getByTestId("plan-assumption"));
    expect(screen.getByTestId("plan-brief").value).toBe("network.req.correctPrefill");
    // The quality card: score, grade, seven dimensions, the major finding first.
    const card = screen.getByTestId("plan-quality");
    expect(card.textContent).toContain("72");
    expect(card.textContent).toContain("network.quality.grade.B");
    expect(screen.getAllByTestId(/quality-dim-/)).toHaveLength(7);
    expect(screen.getByTestId("quality-dim-plausibility").textContent).toContain("network.quality.na");
    const findings = screen.getAllByTestId("quality-finding");
    expect(findings[0].textContent).toContain("Only 60% covered.");
    expect(findings[1].textContent).toContain("No Sunday service.");
  });

  it("accepts the suggested answers in one click", () => {
    const onSend = vi.fn();
    const turns = [{ id: "a1", role: "assistant", content: "Deux questions.", steps: [], questions: [{ id: "town", question: "Which town?", options: ["Ville (41)", "Ville (72)"], default: "Ville (41)", why: "Changes everything." }, { id: "lines", question: "How many lines?", default: "2" }], status: "complete" }];
    render(withTheme(<PlanChat turns={turns} streaming={false} pendingTool={null} onSend={onSend} onStop={() => {}} canPlan />));
    expect(screen.getByText("Changes everything.")).toBeTruthy();
    expect(screen.getByTestId("plan-answer-lines").getAttribute("placeholder")).toBe("network.questions.suggested");
    fireEvent.change(screen.getByTestId("plan-answer-lines"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("plan-answers-defaults"));
    expect(onSend).toHaveBeenCalledWith("Which town? → Ville (41)\nHow many lines? → 3", { answersFor: "a1" });
  });
});

describe("NetworkReportDialog", () => {
  it("shows the design quality, validation, audit, requirements and sources, with explore/refine", () => {
    const onClose = vi.fn();
    const onRefine = vi.fn();
    const report = { design: QUALITY, validation: { errors: 0, warnings: 3 }, audit: { counts: { warning: 1, info: 2 }, findings: [{ code: "stop_spacing", severity: "warning", count: 4 }] }, territory: { place: "Ville, France", sources: [{ id: "osm", name: "OpenStreetMap", url: "https://osm.org/copyright" }] }, requirements: REQUIREMENTS, counts: { routes: 2, stops: 9, trips: 120 }, routing_fallback_legs: 0 };
    render(withTheme(<NetworkReportDialog open report={report} onClose={onClose} onRefine={onRefine} />));
    expect(screen.getByTestId("network-report")).toBeTruthy();
    expect(screen.getByText("report.subtitle")).toBeTruthy();
    expect(screen.getByTestId("report-requirements").textContent).toContain("report.requirements");
    expect(screen.getByTestId("report-validation").textContent).toBe("report.validation.ok");
    expect(screen.getByTestId("report-audit").textContent).toBe("report.audit");
    expect(screen.getByText("stop spacing ×4")).toBeTruthy();
    expect(screen.getByText("OpenStreetMap").getAttribute("href")).toBe("https://osm.org/copyright");
    expect(screen.getByTestId("plan-quality").textContent).toContain("72");
    fireEvent.click(screen.getByTestId("report-refine"));
    expect(onRefine).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("report-explore"));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("findingText — quality findings in the reader's language", () => {
  const DICT = {
    "network.finding.detour": "Ligne {line}, sens {dir} : {routed} km pour {straight} km (×{ratio}).",
    "network.finding.detour.hint": "Réordonnez les arrêts.",
    "network.finding.unserved_place": "{name} ({category}) n'est pas desservi.",
    "territory.category.college": "Enseignement supérieur",
  };
  const t = (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), DICT[key] || key);

  it("translates by code with numbers in the reader's format, and the category label", () => {
    const x = { level: "major", code: "detour", params: { line: "1", dir: "0", routed: 11.2, straight: 5.3, ratio: 2.1 }, message: "Line 1 direction 0 detours", hint: "Straighten" };
    expect(findingText(x, t, "fr")).toEqual({ message: "Ligne 1, sens 0 : 11,2 km pour 5,3 km (×2,1).", hint: "Réordonnez les arrêts." });
    const y = { level: "minor", code: "unserved_place", params: { name: "Agro Campus", category: "college", radius: 400 }, message: "Agro Campus (college) is not served.", hint: "Route a line via Agro Campus." };
    // No translated hint: the server's hint stays.
    expect(findingText(y, t, "fr")).toEqual({ message: "Agro Campus (Enseignement supérieur) n'est pas desservi.", hint: "Route a line via Agro Campus." });
  });

  it("falls back to the server's text for an unknown or missing code", () => {
    expect(findingText({ code: "new_rule", message: "Something new.", hint: "Do this." }, t, "fr")).toEqual({ message: "Something new.", hint: "Do this." });
    expect(findingText({ message: "Legacy." }, t, "fr")).toEqual({ message: "Legacy.", hint: undefined });
  });
});

describe("readinessLines", () => {
  const t = (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key === "network.notReady.over_plan_limit" ? "{count} lines, plan allows {max}" : key);
  it("explains each reason, translating codes and falling back to the finding's text", () => {
    const lines = readinessLines(
      [
        { code: "over_plan_limit", count: 5, max: 3 },
        { code: "fleet_over", finding: { code: "unknown_code", message: "The plan needs 14 vehicles; the brief allows 10." } },
        { code: "never_seen" },
      ],
      t,
      "en",
    );
    expect(lines).toEqual(["5 lines, plan allows 3", "The plan needs 14 vehicles; the brief allows 10.", "never_seen"]);
  });
});
