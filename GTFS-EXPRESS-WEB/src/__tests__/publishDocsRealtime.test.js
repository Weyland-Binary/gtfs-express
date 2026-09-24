/**
 * publishDocsRealtime.test.js — batch 3 on the web side: the share dialog
 * publishes a new version of a link this browser created, the realtime
 * check dialog runs and renders findings, the passenger documents open
 * from a session-authenticated blob, and the brief templates prefill the
 * composer.
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ language: "fr", t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));
vi.mock("../components/edit/BetaGateDialog", () => ({ BETA_CODE_STORAGE_KEY: "beta-code" }));

import ShareButton from "../components/share/ShareButton";
import RealtimeCheckDialog from "../components/validation/RealtimeCheckDialog";
import PlanChat from "../components/network/PlanChat";
import { openTimetable } from "../utils/documentsApi";
import { rememberedShares } from "../utils/shareApi";

const theme = createTheme({ palette: { ai: { main: "#7c4dff", gradientStart: "#7c4dff", gradientEnd: "#00bcd4", contrastText: "#fff" } } });
const withTheme = (ui) => <ThemeProvider theme={theme}>{ui}</ThemeProvider>;
const TOKEN = "0123456789abcdef0123";
const CARD = { token: TOKEN, title: "Réseau 2026", counts: { routes: 3, stops: 20, trips: 200 }, validation: { errors: 0, warnings: 1 }, design: { score: 80 }, expiresAt: "2027-01-01T00:00:00.000Z", current_version: 2, versions: [{ n: 1 }, { n: 2 }] };

describe("ShareButton publishing", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("remembers the secret of a created share and publishes a new version to it", async () => {
    globalThis.fetch = vi.fn(async (url, init) => {
      if (String(url).endsWith("/share")) return { ok: true, status: 201, json: async () => ({ token: TOKEN, secret: "s".repeat(32), expiresAt: CARD.expiresAt, card: { ...CARD, current_version: 1, versions: [{ n: 1 }] } }) };
      if (String(url).endsWith("/versions")) {
        expect(init.headers["X-Share-Secret"]).toBe("s".repeat(32));
        expect(JSON.parse(init.body)).toEqual({ note: "Ligne 3 prolongée" });
        return { ok: true, status: 201, json: async () => ({ token: TOKEN, version: { n: 2, changelog: { counts: { routes: 1, stops: 4, trips: 30 }, routes: { added: ["3"], removed: [] } } }, card: CARD }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { unmount } = render(withTheme(<ShareButton />));
    fireEvent.click(screen.getByTestId("share-network"));
    await waitFor(() => expect(screen.getByTestId("share-link")).toBeTruthy());
    expect(rememberedShares()[0]).toMatchObject({ token: TOKEN, secret: "s".repeat(32), title: "Réseau 2026" });
    unmount();
    // Second time: the dialog offers to publish a new version of the remembered link.
    render(withTheme(<ShareButton />));
    fireEvent.click(screen.getByTestId("share-network"));
    await waitFor(() => expect(screen.getByTestId("share-choose")).toBeTruthy());
    fireEvent.change(screen.getByTestId("share-note"), { target: { value: "Ligne 3 prolongée" } });
    fireEvent.click(screen.getByTestId("share-publish"));
    await waitFor(() => expect(screen.getByTestId("share-version")).toBeTruthy());
    expect(screen.getByTestId("share-version").textContent).toBe("share.published");
    expect(screen.getByTestId("share-changelog").textContent).toContain("+ 3");
    expect(screen.getByTestId("share-link").value).toMatch(new RegExp(`share=${TOKEN}`));
  });

  it("forgets a link the server no longer knows", async () => {
    localStorage.setItem("gtfs:shares", JSON.stringify([{ token: TOKEN, secret: "x".repeat(32), title: "Old" }]));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: "SHARE_NOT_FOUND" }) });
    render(withTheme(<ShareButton />));
    fireEvent.click(screen.getByTestId("share-network"));
    await waitFor(() => expect(screen.getByTestId("share-publish")).toBeTruthy());
    fireEvent.click(screen.getByTestId("share-publish"));
    await waitFor(() => expect(screen.getByText("share.notFound")).toBeTruthy());
    expect(rememberedShares()).toEqual([]);
  });
});

describe("RealtimeCheckDialog", () => {
  it("runs the check on a URL and lists the findings", async () => {
    sessionStorage.clear();
    globalThis.fetch = vi.fn(async (url, init) => {
      expect(String(url)).toMatch(/\/realtime\/validate$/);
      expect(JSON.parse(init.body)).toEqual({ url: "https://rt.example/tu.pb" });
      return { ok: true, status: 200, json: async () => ({ ok: false, summary: { entities: 5, trip_updates: 3, vehicle_positions: 2, alerts: 0 }, counts: { error: 1, warning: 1 }, findings: [{ code: "unknown_trip", severity: "error", message: "Trip updates reference trips missing from the static feed.", count: 2, samples: [{ id: "1", trip_id: "ghost" }] }, { code: "stale_vehicle", severity: "warning", message: "A vehicle position is older than 15 min.", count: 1, samples: [] }] }) };
    });
    render(withTheme(<RealtimeCheckDialog open onClose={() => {}} />));
    fireEvent.change(screen.getByTestId("realtime-url"), { target: { value: "https://rt.example/tu.pb" } });
    fireEvent.click(screen.getByTestId("realtime-run"));
    await waitFor(() => expect(screen.getByTestId("realtime-result")).toBeTruthy());
    expect(screen.getByTestId("realtime-verdict").textContent).toBe("realtime.errors");
    const findings = screen.getAllByTestId("realtime-finding");
    expect(findings).toHaveLength(2);
    expect(findings[0].textContent).toContain("missing from the static feed");
    expect(findings[0].textContent).toContain("trip_id=ghost");
    expect(localStorage.getItem("gtfs:realtime-url")).toBe("https://rt.example/tu.pb");
  });
});

describe("documents", () => {
  it("fetches the timetable with the session header and opens it in a new tab", async () => {
    sessionStorage.clear();
    const blob = new Blob(["<html>ok</html>"], { type: "text/html" });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
    globalThis.URL.createObjectURL = vi.fn(() => "blob:doc");
    globalThis.URL.revokeObjectURL = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue({});
    const ok = await openTimetable("A", { lang: "fr", date: "20260112" });
    expect(ok).toBe(true);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(url).toMatch(/\/documents\/timetable\?route_id=A&date=20260112&lang=fr$/);
    expect(init.headers["X-Session-ID"]).toBeTruthy();
    expect(open).toHaveBeenCalledWith("blob:doc", "_blank", "noopener");
    open.mockRestore();
  });
});

describe("brief templates", () => {
  it("prefills the composer with a template", () => {
    render(withTheme(<PlanChat turns={[]} streaming={false} pendingTool={null} onSend={() => {}} onStop={() => {}} canPlan />));
    const chips = screen.getAllByTestId("plan-template");
    expect(chips).toHaveLength(5);
    fireEvent.click(chips[0]);
    expect(screen.getByTestId("plan-brief").value).toBe("network.templates.smallTown.brief");
  });
});
