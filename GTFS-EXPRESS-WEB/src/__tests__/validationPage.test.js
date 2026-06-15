/**
 * validationPage.test.js — redesigned validation report page.
 *
 * Pins the three product contracts from the overhaul:
 *   1. findings the tolerant import resolved (resolvedByImport) are
 *      announced in the AutoFixedBanner and EXCLUDED from the outstanding
 *      counts and the rule list;
 *   2. expanding a rule shows the engine's own fields as columns
 *      (finding.context), not a fixed Line/Entity/Field/Message grid;
 *   3. the single rule-grouped view renders (no view-mode toggle).
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({
    // Render keys verbatim, with interpolation params appended so tests
    // can assert the values that would be displayed.
    t: (key, params) =>
      params && Object.keys(params).length > 0
        ? `${key}[${Object.entries(params)
            .map(([k, v]) => `${k}=${v}`)
            .join(",")}]`
        : key,
  }),
}));

vi.mock("../contexts/EditModeContext", () => ({
  useEditMode: () => ({
    editing: false,
    entering: false,
    enterEditMode: vi.fn(),
    recordEdit: vi.fn(),
    undoLast: vi.fn(),
    dataVersion: 0,
  }),
}));

vi.mock("../contexts/DetailPanelContext", () => ({
  useDetailPanel: () => ({ openPanel: vi.fn() }),
}));

vi.mock("../utils/featuresApi", () => ({
  useFeatures: () => ({ features: { chat: { enabled: false }, nl2sql: { enabled: false } } }),
}));

const fetchWithSession = vi.fn().mockResolvedValue({
  ok: true,
  status: 200,
  json: async () => ({}),
});
vi.mock("../utils/sessionManager", () => ({
  fetchWithSession: (...args) => fetchWithSession(...args),
}));

vi.mock("../components/edit/BetaGateDialog", () => ({
  default: () => null,
}));

import { ThemeProvider } from "@mui/material";
import { lightTheme } from "../Theme";
import ValidationErrorsPage from "../components/ValidationErrorsPage";

const REPORT = {
  valid: false,
  counts: { errors: 1, warnings: 1, infos: 0, resolvedByImport: 179 },
  errors: {
    "agency.txt": [
      {
        ruleCode: "invalid_url",
        severity: "error",
        message: "invalid_url: fieldName=agency_url, fieldValue=htp:/broken",
        context: {
          filename: "agency.txt",
          csvRowNumber: "2",
          fieldName: "agency_url",
          fieldValue: "htp:/broken",
        },
      },
      {
        ruleCode: "missing_recommended_file",
        severity: "warning",
        message: "missing_recommended_file:",
        context: { filename: "agency.txt" },
      },
    ],
    "calendar_dates.txt": [
      {
        ruleCode: "duplicate_key",
        severity: "error",
        resolvedByImport: true,
        message: "duplicate_key: service_id=W, date=20260704",
        context: { filename: "calendar_dates.txt", csvRowNumber: "5" },
      },
      {
        ruleCode: "duplicate_key",
        severity: "error",
        resolvedByImport: true,
        aggregate: true,
        aggregateCount: 178,
        message: "duplicate_key: 178 additional occurrence(s) not sampled…",
      },
    ],
  },
};

const renderPage = () =>
  render(
    <ThemeProvider theme={lightTheme}>
      <ValidationErrorsPage
        report={REPORT}
        onReupload={() => {}}
        onBack={null}
        onReportRefreshed={() => {}}
        baselineCounts={REPORT.counts}
      />
    </ThemeProvider>,
  );

describe("ValidationErrorsPage (redesign)", () => {
  it("announces import-resolved findings and keeps them out of the rule list", () => {
    renderPage();

    const banner = screen.getByTestId("auto-fixed-banner");
    // 1 sampled + 178 aggregate tail = 179 announced.
    expect(banner.textContent).toContain("179");
    expect(banner.textContent).toContain("calendar_dates.txt · 179");

    // duplicate_key is NOT outstanding work: absent from the rule list…
    expect(screen.queryAllByText("duplicate_key")).toHaveLength(0);
    // …and the header tallies only the 2 active findings (2 rules).
    expect(
      screen.getByText(/validation\.header\.summary/).textContent,
    ).toContain("findings=2");
  });

  it("expanding a rule shows the engine's own fields as columns", () => {
    renderPage();

    fireEvent.click(screen.getByText("invalid_url"));
    // Column headers = the exact keys the canonical engine returned.
    expect(screen.getByText("fieldValue")).toBeTruthy();
    expect(screen.getByText("csvRowNumber")).toBeTruthy();
    // Cell values verbatim.
    expect(screen.getByText("htp:/broken")).toBeTruthy();
    // No fixed legacy grid: the Message column only appears when the
    // engine returned no context fields.
    expect(
      screen.queryByText("validation.occurrence.column.message"),
    ).toBeNull();
  });

  it("severity stats reflect active findings only and filter the list", () => {
    renderPage();

    // 1 error + 1 warning (the 179 resolved errors are excluded).
    const errorPill = screen.getByText("validation.severity.errors").parentElement;
    expect(errorPill.textContent).toContain("1");

    // Toggling the error pill off leaves only the warning rule visible.
    fireEvent.click(errorPill);
    expect(screen.queryByText("invalid_url")).toBeNull();
    expect(screen.getByText("missing_recommended_file")).toBeTruthy();
  });
});
