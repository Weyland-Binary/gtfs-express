/**
 * changeStudio.test.js — the Change Studio: a plan is built by hand from the
 * catalogue, previewed; a blocked question is answered with one click (the
 * parameter is set and the plan previewed again); the diff is phrased from
 * its codes; "Apply" enters edit mode, previews on the edit database and
 * commits one edit.
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key, params = {}) => Object.entries(params || {}).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));
vi.mock("../utils/featuresApi", () => ({ useFeatures: () => ({ features: { chat: { enabled: false } } }) }));
vi.mock("../components/edit/BetaGateDialog", () => ({ BETA_CODE_STORAGE_KEY: "beta-code" }));
const editState = { editing: false, enterEditMode: vi.fn(async () => ({ ok: true })), recordEdit: vi.fn() };
vi.mock("../contexts/EditModeContext", () => ({ useEditMode: () => editState }));
const api = {
  fetchOperations: vi.fn(),
  fetchOverview: vi.fn(),
  fetchHealth: vi.fn(),
  fetchAlerts: vi.fn(),
  previewChangePlan: vi.fn(),
  commitChangePlan: vi.fn(),
  streamChangePlan: vi.fn(),
};
vi.mock("../utils/transformApi", async () => {
  const real = await vi.importActual("../utils/transformApi");
  return { ...real, fetchOperations: (...a) => api.fetchOperations(...a), fetchOverview: (...a) => api.fetchOverview(...a), fetchHealth: (...a) => api.fetchHealth(...a), fetchAlerts: (...a) => api.fetchAlerts(...a), previewChangePlan: (...a) => api.previewChangePlan(...a), commitChangePlan: (...a) => api.commitChangePlan(...a), streamChangePlan: (...a) => api.streamChangePlan(...a) };
});

import ChangeStudio from "../components/transform/ChangeStudio";
import { describeItem, OperationDialog } from "../components/transform/ChangePlanParts";

const theme = createTheme({ palette: { ai: { main: "#7c4dff", gradientStart: "#7c4dff", gradientEnd: "#00bcd4", contrastText: "#fff" } } });
const CATALOGUE = [
  { type: "set_headway", title: "Change the frequency of a line over a period", category: "service", params: [{ name: "route", type: "route", required: true }, { name: "days", type: "days", required: true }, { name: "from", type: "time", required: true }, { name: "to", type: "time", required: true }, { name: "headway_min", type: "number", required: true }] },
];
const blockedPreview = (plan) => ({
  id: "aaaaaaaaaaaaaaaaaa",
  blocked: true,
  empty: false,
  steps: [{ id: plan.operations[0].id, type: "set_headway", status: "blocked", ambiguities: [{ param: "days", code: "days_missing", message: "Which days?", options: ["weekday", "saturday"] }], warnings: [] }],
  diff: { items: [] },
  integrity: [],
  conformance: null,
});
const readyPreview = (plan) => ({
  id: "bbbbbbbbbbbbbbbbbb",
  blocked: false,
  empty: false,
  steps: [{ id: plan.operations[0].id, type: "set_headway", status: "applied", summary: "Line S1: every 6 min", ambiguities: [], warnings: [] }],
  diff: { items: [{ code: "service_headway", label: "S1", day: "weekday", period: "am_peak", direction: "0", before: 10, after: 6, dates: null }], totals: { trips_weekday: { before: 100, after: 120 }, vehicles_peak_weekday: { before: 10, after: 12 }, routes: { before: 3, after: 3 }, stops: { before: 20, after: 20 } } },
  integrity: [],
  conformance: null,
  passenger: [{ id: "alert-1", effect: "ADDITIONAL_SERVICE" }],
});

const mount = (onClose = () => {}) =>
  render(
    <ThemeProvider theme={theme}>
      <ChangeStudio open onClose={onClose} />
    </ThemeProvider>,
  );

describe("ChangeStudio", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    editState.enterEditMode.mockClear();
    editState.recordEdit.mockClear();
    api.fetchOperations.mockResolvedValue({ operations: CATALOGUE });
    api.fetchOverview.mockResolvedValue({ routes: [{ id: "S1", short_name: "S1", long_name: "Broadway" }] });
    api.fetchHealth.mockResolvedValue({ score: 79, grade: "B", dimensions: [{ id: "frequency", score: 70 }], lines: [{ id: "S1", tier: "structuring" }], fleet: { date: "20261006", vehicles: 32, vehicles_line_by_line: 43, deadhead_km: 266 }, checks: [{ code: "low_contrast", count: 2 }] });
    api.previewChangePlan.mockImplementation(async (plan) => (plan.operations[0].params.days ? readyPreview(plan) : blockedPreview(plan)));
    api.commitChangePlan.mockResolvedValue({ ok: true, description: "S1", tables: ["trips"] });
    api.fetchAlerts.mockResolvedValue({ notice: { language: "en", title: "Service change", text: "Service change\n\nLine S1: more service" } });
  });

  it("adds an operation by hand, answers the engine's question, shows the changes and applies one edit", async () => {
    const onClose = vi.fn();
    mount(onClose);
    expect(screen.getByTestId("change-welcome")).toBeTruthy();
    // Before any change: the feed's health on the yardstick every preview compares against.
    expect((await screen.findByTestId("network-health-score")).textContent).toBe("B 79");
    expect(screen.getByTestId("network-health-fleet").textContent).toBe("transform.health.fleet");
    expect(within(screen.getByTestId("network-health-checks")).getByText("low_contrast: 2")).toBeTruthy();
    fireEvent.click(screen.getByTestId("change-add"));
    const dialog = await screen.findByTestId("change-operation-dialog");
    const typeInput = within(dialog).getByTestId("change-type");
    fireEvent.mouseDown(typeInput);
    fireEvent.change(typeInput, { target: { value: "frequency" } });
    fireEvent.click(await screen.findByText(/Change the frequency of a line/));
    fireEvent.change(within(dialog).getByTestId("change-param-from"), { target: { value: "07:00" } });
    fireEvent.change(within(dialog).getByTestId("change-param-to"), { target: { value: "09:00" } });
    fireEvent.change(within(dialog).getByTestId("change-param-headway_min"), { target: { value: "6" } });
    fireEvent.click(within(dialog).getByTestId("change-operation-save"));

    // Previewed: blocked, with the engine's question and its options.
    await waitFor(() => expect(screen.getByTestId("change-operation").getAttribute("data-status")).toBe("blocked"));
    const sent = api.previewChangePlan.mock.calls[0][0];
    expect(sent.operations[0]).toMatchObject({ id: "op1", type: "set_headway", params: { from: "07:00", to: "09:00", headway_min: 6 } });
    expect(screen.getByTestId("change-apply").disabled).toBe(true);
    fireEvent.click(screen.getAllByTestId("change-answer-option")[0]);
    await waitFor(() => expect(screen.getByTestId("change-operation").getAttribute("data-status")).toBe("applied"));
    expect(api.previewChangePlan.mock.calls[1][0].operations[0].params.days).toBe("weekday");

    // The changes, phrased from the codes.
    fireEvent.click(screen.getByTestId("change-tab-changes"));
    expect(screen.getByTestId("change-diff-line").textContent).toBe("transform.diff.headway");
    // What riders must be told, ready to publish.
    expect((await screen.findByTestId("change-publish-notice")).textContent).toMatch(/Line S1: more service/);
    expect(api.fetchAlerts).toHaveBeenCalledWith("bbbbbbbbbbbbbbbbbb", { language: "en" });
    expect(screen.getByTestId("change-publish-alerts")).toBeTruthy();

    // Apply: edit mode, a fresh preview on the edit database, one commit.
    fireEvent.click(screen.getByTestId("change-apply"));
    await waitFor(() => expect(api.commitChangePlan).toHaveBeenCalledWith("bbbbbbbbbbbbbbbbbb"));
    expect(editState.enterEditMode).toHaveBeenCalled();
    expect(editState.recordEdit).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("typed inputs: lines as a list, a boolean, a colour without #, an object from its JSON", async () => {
    const onSave = vi.fn();
    const catalogue = [
      {
        type: "set_route_attributes",
        title: "Change a line's identity",
        category: "routes",
        params: [{ name: "route", type: "route" }, { name: "color", type: "color" }, { name: "whole_feed", type: "boolean" }, { name: "changes", type: "list" }],
        example: { changes: [{ route: "B1", short_name: "5401" }] },
      },
      { type: "copy_day_service", title: "Copy a day's timetable", category: "calendar", params: [{ name: "routes", type: "routes", required: true }, { name: "period", type: "period" }] },
    ];
    const initial = { id: "op9", type: "set_route_attributes", params: { route: "S1" } };
    render(
      <ThemeProvider theme={theme}>
        <OperationDialog open catalogue={catalogue} routes={[{ id: "S1", short_name: "S1" }]} initial={initial} onClose={() => {}} onSave={onSave} />
      </ThemeProvider>,
    );
    fireEvent.change(screen.getByTestId("change-param-color"), { target: { value: "#6e6e6e" } });
    fireEvent.change(screen.getByTestId("change-param-changes"), { target: { value: '[{"route":"S1","short_name":"5"}]' } });
    expect(screen.getByTestId("change-param-changes").getAttribute("placeholder")).toBe('[{"route":"B1","short_name":"5401"}]');
    fireEvent.click(screen.getByTestId("change-operation-save"));
    expect(onSave.mock.calls[0][0].params).toEqual({ route: "S1", color: "6E6E6E", changes: [{ route: "S1", short_name: "5" }] });
  });

  it("phrases every diff code with its day, period and dates", () => {
    const t = (key, params = {}) => `${key}${JSON.stringify(params)}`;
    const line = describeItem(t, { code: "service_headway", day: "weekday", period: "am_peak", direction: "0", before: 10, after: 12, dates: { from: "20260907", to: "20261030", count: 40 } });
    expect(line).toContain("transform.diff.headway");
    expect(line).toContain("transform.diff.period");
    expect(describeItem(t, { code: "stop_renamed", before: "A", after: "B" })).toContain("transform.diff.stopRenamed");
    expect(describeItem(t, { code: "unknown_code" })).toBe("unknown_code");
  });
});
