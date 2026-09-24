/**
 * pricingDialog.test.js — the offer dialog: plans from the API, the current
 * plan marked, request-by-email when billing is off, and the access-code
 * path that stores the code and refreshes.
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));
vi.mock("../components/edit/BetaGateDialog", () => ({ BETA_CODE_STORAGE_KEY: "beta-code" }));

import PricingDialog from "../components/PricingDialog";

const theme = createTheme({ palette: { ai: { main: "#7c4dff", gradientStart: "#7c4dff", gradientEnd: "#00bcd4", contrastText: "#fff" } } });
const PLANS = {
  current: { name: "free", source: "anonymous", limits: { network_lines: 3 } },
  contact_email: "sales@example.com",
  billing_enabled: false,
  plans: [
    { id: "free", price_eur: 0, period: "month", limits: { network_lines: 3, ai_messages: 5, seats: 1 }, features: ["explore"], checkout_url: null },
    { id: "pro", price_eur: 39, period: "month", limits: { network_lines: 40, ai_messages: 2000, seats: 1 }, features: ["studio_full"], checkout_url: null },
    { id: "team", price_eur: 149, period: "month", limits: { network_lines: 80, ai_messages: 6000, seats: 5 }, features: ["seats"], checkout_url: "https://checkout.example/team" },
  ],
};

describe("PricingDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => PLANS });
  });

  it("shows the plans, marks the current one, and offers checkout or a request", async () => {
    render(
      <ThemeProvider theme={theme}>
        <PricingDialog open onClose={() => {}} reason="network_limit" />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("plan-pro")).toBeTruthy());
    expect(screen.getByText("pricing.reason.networkLimit")).toBeTruthy();
    expect(screen.getByTestId("plan-free-current")).toBeTruthy();
    expect(screen.getByText("39 €")).toBeTruthy();
    expect(screen.getByTestId("plan-pro-request").getAttribute("href")).toMatch(/^mailto:sales@example.com/);
    expect(screen.getByText("pricing.subscribe").closest("a").getAttribute("href")).toBe("https://checkout.example/team");
  });

  it("stores an access code and reloads the plans with it", async () => {
    render(
      <ThemeProvider theme={theme}>
        <PricingDialog open onClose={() => {}} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("plan-pro")).toBeTruthy());
    fireEvent.click(screen.getByTestId("pricing-have-code"));
    fireEvent.change(screen.getByTestId("pricing-code"), { target: { value: "abcd1234efgh" } });
    globalThis.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ...PLANS, current: { name: "pro", source: "code", limits: { network_lines: 40 } } }) });
    fireEvent.click(screen.getByTestId("pricing-code-activate"));
    expect(localStorage.getItem("beta-code")).toBe("ABCD-1234-EFGH");
    await waitFor(() => expect(screen.getByTestId("plan-pro-current")).toBeTruthy());
    const headers = globalThis.fetch.mock.calls[1][1].headers;
    expect(headers["X-Beta-Code"]).toBe("ABCD-1234-EFGH");
    expect(screen.getByText("pricing.codeSaved")).toBeTruthy();
  });
});
