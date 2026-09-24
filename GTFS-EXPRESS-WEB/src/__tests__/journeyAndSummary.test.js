/**
 * journeyAndSummary.test.js — the journey card (itinerary timeline and the
 * unreachable diagnosis) and the AI summary card (generate → markdown →
 * copy, hidden when the assistant is off, NO_EDITS mapped to a message).
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({
    language: "fr",
    t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key),
  }),
}));

let chatEnabled = true;
vi.mock("../utils/featuresApi", () => ({
  useFeatures: () => ({ features: { chat: { enabled: chatEnabled } } }),
}));

const fetchWithSession = vi.fn();
vi.mock("../utils/sessionManager", () => ({
  fetchWithSession: (...args) => fetchWithSession(...args),
}));

import { ThemeProvider, createTheme } from "@mui/material/styles";
import JourneyCard from "../components/chat/JourneyCard";
import AiSummaryCard from "../components/common/AiSummaryCard";

// The app theme carries an `ai` palette the cards draw their accent from.
const theme = createTheme({
  palette: { ai: { main: "#7c4dff", gradientStart: "#7c4dff", gradientEnd: "#00bcd4", contrastText: "#fff" } },
});
const withTheme = (ui) => <ThemeProvider theme={theme}>{ui}</ThemeProvider>;

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("JourneyCard", () => {
  it("renders the legs, times and transfer count", () => {
    render(
      <JourneyCard
        journey={{
          journeyId: "j1",
          from: { stop_id: "A", stop_name: "Gare" },
          to: { stop_id: "C", stop_name: "Mairie" },
          date: "20260415",
          time: "08:00:00",
          reachable: true,
          diagnostics: ["tight_connection:B:130"],
          itinerary: {
            departure: "08:05:00",
            arrival: "08:40:00",
            duration_secs: 2100,
            wait_before_secs: 300,
            transfers: 1,
            legs: [
              { type: "ride", trip_id: "T1", route_id: "R1", route_short_name: "12", route_color: "FF0000", headsign: "Centre", from: { stop_id: "A", stop_name: "Gare", time: "08:05:00" }, to: { stop_id: "B", stop_name: "Pont", time: "08:20:00" }, stops: 4, duration_secs: 900 },
              { type: "walk", from: { stop_id: "B", stop_name: "Pont" }, to: { stop_id: "B2", stop_name: "Pont (quai 2)" }, duration_secs: 120 },
              { type: "ride", trip_id: "T2", route_id: "R2", route_short_name: "7", route_color: null, headsign: "Mairie", from: { stop_id: "B2", stop_name: "Pont (quai 2)", time: "08:24:00" }, to: { stop_id: "C", stop_name: "Mairie", time: "08:40:00" }, stops: 6, duration_secs: 960 },
            ],
          },
        }}
      />,
    );
    expect(screen.getByText("Gare → Mairie")).toBeTruthy();
    expect(screen.getByText("08:05 → 08:40")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("chat.journey.walk")).toBeTruthy();
    expect(screen.getByText("chat.journey.tight")).toBeTruthy();
    expect(screen.getByText("chat.journey.transfers")).toBeTruthy();
  });

  it("explains why no itinerary exists", () => {
    render(
      <JourneyCard
        journey={{ journeyId: "j2", from: { stop_name: "A" }, to: { stop_name: "B" }, date: "20200101", time: "08:00:00", reachable: false, diagnostics: ["no_service_on_date", "frequencies_expanded"], itinerary: null }}
      />,
    );
    expect(screen.getByText("chat.journey.unreachable")).toBeTruthy();
    expect(screen.getByText("• chat.journey.diag.no_service_on_date")).toBeTruthy();
    expect(screen.queryByText(/frequencies_expanded/)).toBeNull();
  });
});

describe("AiSummaryCard", () => {
  beforeEach(() => {
    fetchWithSession.mockReset();
    chatEnabled = true;
  });

  it("generates, renders the markdown and reports back", async () => {
    fetchWithSession.mockResolvedValueOnce(jsonResponse({ kind: "changelog", markdown: "# Notes\n\n- **3 stops** renamed", stored: true }));
    const onGenerated = vi.fn();
    render(withTheme(<AiSummaryCard kind="changelog" title="Notes" description="desc" generateLabel="Go" onGenerated={onGenerated} testId="card" />));
    fireEvent.click(screen.getByTestId("card-generate"));
    await waitFor(() => expect(screen.getByTestId("card-markdown")).toBeTruthy());
    const [url, init] = fetchWithSession.mock.calls[0];
    expect(url).toMatch(/\/ai\/summarize$/);
    expect(JSON.parse(init.body)).toEqual({ kind: "changelog", language: "fr", payload: null });
    expect(screen.getByText("3 stops")).toBeTruthy();
    expect(onGenerated).toHaveBeenCalledWith(expect.objectContaining({ stored: true }));
    expect(screen.getByTestId("card-copy")).toBeTruthy();
  });

  it("maps NO_EDITS to a friendly message and keeps the button", async () => {
    fetchWithSession.mockResolvedValueOnce(jsonResponse({ error: "NO_EDITS", message: "empty" }, 409));
    render(withTheme(<AiSummaryCard kind="changelog" title="Notes" testId="card" />));
    fireEvent.click(screen.getByTestId("card-generate"));
    await waitFor(() => expect(screen.getByText("ai.summary.noEdits")).toBeTruthy());
    expect(screen.getByTestId("card-generate")).toBeTruthy();
  });

  it("is hidden when the assistant is disabled", () => {
    chatEnabled = false;
    const { container } = render(withTheme(<AiSummaryCard kind="diff" title="x" testId="card" payload={{ diff: {} }} />));
    expect(container.innerHTML).toBe("");
  });
});
