/**
 * share.test.js — public links: the share button creates a snapshot and
 * shows the link, the landing page renders the card and opens the feed as
 * the visitor's own session, an expired token is reported, and the URL
 * helpers round-trip the token.
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));

import ShareButton from "../components/share/ShareButton";
import SharedFeedLanding from "../components/share/SharedFeedLanding";
import { shareUrl, shareTokenFromLocation, clearShareFromLocation } from "../utils/shareApi";

const theme = createTheme();
const withTheme = (ui) => <ThemeProvider theme={theme}>{ui}</ThemeProvider>;
const TOKEN = "0123456789abcdef0123";
const CARD = {
  token: TOKEN,
  title: "Réseau de démonstration",
  agency: "Demo Mobilités",
  source: "network_studio",
  counts: { routes: 2, stops: 9, trips: 120 },
  validation: { errors: 0, warnings: 3, infos: 1, valid: true },
  audit: { warning: 1, info: 2 },
  design: { score: 74, grade: "B", majors: 0, dimensions: [{ id: "coverage", score: 70 }, { id: "service", score: 80 }], operations: { fleet_total: 5, veh_km_year: 210000, cost_year: 880000, currency: "EUR" } },
  territory: { place: "Ville, France", sources: [{ id: "osm", name: "OpenStreetMap", url: "https://osm.org/copyright" }] },
  requirements: { operator: "Demo Mobilités", area: "Ville, France", objectives: [] },
  expiresAt: "2027-01-01T00:00:00.000Z",
  opens: 0,
};

describe("share helpers", () => {
  it("builds and reads the share URL", () => {
    window.history.replaceState({}, "", "/?tab=schedules");
    const url = shareUrl(TOKEN);
    expect(url).toMatch(new RegExp(`\\?share=${TOKEN}$`));
    window.history.replaceState({}, "", `/?share=${TOKEN}`);
    expect(shareTokenFromLocation()).toBe(TOKEN);
    clearShareFromLocation();
    expect(shareTokenFromLocation()).toBeNull();
    window.history.replaceState({}, "", "/?share=nope");
    expect(shareTokenFromLocation()).toBeNull();
    window.history.replaceState({}, "", "/");
  });
});

describe("ShareButton", () => {
  beforeEach(() => {
    sessionStorage.clear();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ token: TOKEN, expiresAt: CARD.expiresAt, card: CARD }) });
  });

  it("creates the share on click and shows the link and the card", async () => {
    render(withTheme(<ShareButton />));
    fireEvent.click(screen.getByTestId("share-network"));
    await waitFor(() => expect(screen.getByTestId("share-link")).toBeTruthy());
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toMatch(/\/share$/);
    expect(init.method).toBe("POST");
    expect(screen.getByTestId("share-link").value).toMatch(new RegExp(`share=${TOKEN}`));
    expect(screen.getByText("Réseau de démonstration")).toBeTruthy();
    expect(screen.getByText("share.quality")).toBeTruthy();
    expect(screen.getByTestId("share-zip").getAttribute("href")).toMatch(new RegExp(`/share/${TOKEN}/gtfs.zip$`));
  });
});

describe("SharedFeedLanding", () => {
  it("shows the card and opens the feed as a new session", async () => {
    const onOpened = vi.fn();
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith("/open")) return { ok: true, status: 201, json: async () => ({ sessionId: "s-1", counts: CARD.counts, share: CARD }) };
      expect(init).toBeUndefined();
      return { ok: true, status: 200, json: async () => CARD };
    });
    render(withTheme(<SharedFeedLanding token={TOKEN} onOpened={onOpened} onCancel={() => {}} />));
    await waitFor(() => expect(screen.getByTestId("share-landing-title").textContent).toBe("Réseau de démonstration"));
    expect(screen.getByTestId("share-validation").textContent).toBe("report.validation.ok");
    expect(screen.getByTestId("share-quality").textContent).toContain("74");
    expect(screen.getByTestId("share-quality").textContent).toContain("network.ops.fleet");
    expect(screen.getByText("OpenStreetMap").getAttribute("href")).toBe("https://osm.org/copyright");
    expect(screen.getByTestId("share-download").getAttribute("href")).toMatch(/gtfs\.zip$/);
    fireEvent.click(screen.getByTestId("share-explore"));
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s-1" })));
  });

  it("reports an expired link and offers the uploader", async () => {
    const onCancel = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "SHARE_NOT_FOUND" }) });
    render(withTheme(<SharedFeedLanding token={TOKEN} onOpened={() => {}} onCancel={onCancel} />));
    await waitFor(() => expect(screen.getByText("share.notFound")).toBeTruthy());
    fireEvent.click(screen.getByTestId("share-cancel"));
    expect(onCancel).toHaveBeenCalled();
  });
});
