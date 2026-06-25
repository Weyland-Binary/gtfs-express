/**
 * repairFlow.test.js — guided in-chat repair loop state machine.
 *
 * Mocks the network (fetchWithSession) and the edit-mode context to walk the
 * happy path (preview → apply → revalidate → report) plus the contract
 * points that protect reliability: recordEdit() after apply (rule #17),
 * the validation-refresh broadcast, the large-mutation confirmation gate,
 * and the deferred-revalidation fallback on 429.
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const recordEdit = vi.fn();
const undoLast = vi.fn().mockResolvedValue(undefined);
const enterEditMode = vi.fn().mockResolvedValue({ ok: true });
let editingState = true;

vi.mock("../contexts/EditModeContext", () => ({
  useEditMode: () => ({
    editing: editingState,
    entering: false,
    enterEditMode,
    recordEdit,
    undoLast,
  }),
}));

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key, params = {}) =>
      Object.entries(params).reduce(
        (acc, [k, v]) => acc.replace(`{${k}}`, String(v)),
        key,
      ),
  }),
}));

const fetchWithSession = vi.fn();
vi.mock("../utils/sessionManager", () => ({
  fetchWithSession: (...args) => fetchWithSession(...args),
}));

import RepairFlow from "../components/chat/RepairFlow";

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const PREVIEW_OK = {
  statements: [{ verb: "UPDATE", table: "routes", affected: 12, cascade: [] }],
  totalAffected: 12,
  defaultCap: 50000,
  confirmedCap: 200000,
  previewThreshold: 50,
  exceedsDefaultCap: false,
  exceedsConfirmedCap: false,
};

describe("RepairFlow", () => {
  beforeEach(() => {
    fetchWithSession.mockReset();
    recordEdit.mockClear();
    undoLast.mockClear();
    editingState = true;
  });

  it("walks preview → apply → revalidate and reports the error delta", async () => {
    fetchWithSession
      .mockResolvedValueOnce(jsonResponse(PREVIEW_OK)) // preview
      .mockResolvedValueOnce(jsonResponse({ affected: 12, mutated: true })) // apply
      .mockResolvedValueOnce(
        jsonResponse({ valid: true, errors: {}, counts: { errors: 0 } }),
      ); // revalidate

    const onOutcome = vi.fn();
    const refreshListener = vi.fn();
    window.addEventListener("gtfs:validation-refreshed", refreshListener);

    render(
      <RepairFlow
        draftSql="UPDATE routes SET route_url = NULL;"
        currentErrorCount={12}
        onOutcome={onOutcome}
      />,
    );

    fireEvent.click(screen.getByTestId("repair-preview"));
    await waitFor(() =>
      expect(screen.getByText(/chat\.repair\.previewSummary/)).toBeTruthy(),
    );
    // 12 rows < previewThreshold 50 → no confirmation checkbox required.
    expect(screen.queryByTestId("repair-confirm")).toBeNull();

    fireEvent.click(screen.getByTestId("repair-apply"));
    await waitFor(() =>
      expect(screen.getByTestId("repair-report")).toBeTruthy(),
    );

    // Rule #17: the pending-edits counter must be bumped after the apply.
    expect(recordEdit).toHaveBeenCalledTimes(1);
    // The app-wide validation state is refreshed from the fresh report.
    expect(refreshListener).toHaveBeenCalledTimes(1);
    // The model-facing outcome carries the real delta.
    expect(onOutcome).toHaveBeenCalledWith(
      expect.stringContaining("12 -> 0"),
    );
    // 12 → 0 is the clean report.
    expect(screen.getByTestId("repair-report").textContent).toContain(
      "chat.repair.reportClean",
    );
    // Apply request carried the chat attribution flag.
    const applyCall = fetchWithSession.mock.calls[1];
    expect(JSON.parse(applyCall[1].body).source).toBe("chat");

    window.removeEventListener("gtfs:validation-refreshed", refreshListener);
  });

  it("requires the confirmation checkbox above the preview threshold", async () => {
    fetchWithSession.mockResolvedValueOnce(
      jsonResponse({ ...PREVIEW_OK, totalAffected: 5000 }),
    );
    render(<RepairFlow draftSql="UPDATE stops SET stop_url = NULL;" />);

    fireEvent.click(screen.getByTestId("repair-preview"));
    await waitFor(() =>
      expect(screen.getByTestId("repair-confirm")).toBeTruthy(),
    );
    // Apply is disabled until the user ticks the box.
    expect(screen.getByTestId("repair-apply").disabled).toBe(true);
    fireEvent.click(screen.getByTestId("repair-confirm").querySelector("input"));
    expect(screen.getByTestId("repair-apply").disabled).toBe(false);
  });

  it("defers revalidation on 429 and offers a retry", async () => {
    fetchWithSession
      .mockResolvedValueOnce(jsonResponse(PREVIEW_OK))
      .mockResolvedValueOnce(jsonResponse({ affected: 12, mutated: true }))
      .mockResolvedValueOnce(jsonResponse({ error: "rate" }, 429));

    render(<RepairFlow draftSql="UPDATE routes SET route_url = NULL;" />);
    fireEvent.click(screen.getByTestId("repair-preview"));
    await waitFor(() => screen.getByTestId("repair-apply"));
    fireEvent.click(screen.getByTestId("repair-apply"));

    await waitFor(() =>
      expect(
        screen.getByText("chat.repair.revalidateDeferred"),
      ).toBeTruthy(),
    );
    // The mutation itself succeeded — the undo chip is available.
    expect(screen.getByTestId("repair-undo")).toBeTruthy();
  });

  it("shows apply-time validation violations and stays recoverable", async () => {
    fetchWithSession
      .mockResolvedValueOnce(jsonResponse(PREVIEW_OK))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "Validation failed", violations: ["stop_lat out of range"] },
          400,
        ),
      );

    render(<RepairFlow draftSql="UPDATE stops SET stop_lat = 999;" />);
    fireEvent.click(screen.getByTestId("repair-preview"));
    await waitFor(() => screen.getByTestId("repair-apply"));
    fireEvent.click(screen.getByTestId("repair-apply"));

    await waitFor(() =>
      expect(screen.getByText("stop_lat out of range")).toBeTruthy(),
    );
    expect(recordEdit).not.toHaveBeenCalled();
    // The apply button is still there for a retry after the user adjusts.
    expect(screen.getByTestId("repair-apply")).toBeTruthy();
  });

  it("offers undo after apply and reports the undone outcome", async () => {
    fetchWithSession
      .mockResolvedValueOnce(jsonResponse(PREVIEW_OK))
      .mockResolvedValueOnce(jsonResponse({ affected: 3, mutated: true }))
      .mockResolvedValueOnce(
        jsonResponse({ valid: false, errors: {}, counts: { errors: 4 } }),
      );

    const onOutcome = vi.fn();
    render(
      <RepairFlow
        draftSql="DELETE FROM transfers;"
        currentErrorCount={4}
        onOutcome={onOutcome}
      />,
    );
    fireEvent.click(screen.getByTestId("repair-preview"));
    await waitFor(() => screen.getByTestId("repair-apply"));
    fireEvent.click(screen.getByTestId("repair-apply"));
    await waitFor(() => screen.getByTestId("repair-undo"));

    fireEvent.click(screen.getByTestId("repair-undo"));
    await waitFor(() => expect(undoLast).toHaveBeenCalledTimes(1));
    expect(onOutcome).toHaveBeenLastCalledWith(
      expect.stringContaining("undone"),
    );
  });

  it("renders the preview's sample rows", async () => {
    fetchWithSession.mockResolvedValueOnce(
      jsonResponse({
        ...PREVIEW_OK,
        statements: [
          {
            verb: "DELETE",
            table: "calendar_dates",
            affected: 2,
            cascade: [],
            sampleRows: [
              { service_id: "WEEK-2026", date: "20260704" },
              { service_id: "WEEK-2026", date: "20260705" },
            ],
          },
        ],
        totalAffected: 2,
      }),
    );
    render(<RepairFlow draftSql="DELETE FROM calendar_dates WHERE 0;" />);
    fireEvent.click(screen.getByTestId("repair-preview"));
    await waitFor(() => screen.getByTestId("repair-sample-rows"));
    const sampleText = screen.getByTestId("repair-sample-rows").textContent;
    expect(sampleText).toContain("service_id=WEEK-2026");
    expect(sampleText).toContain("date=20260705");
  });

  it("zero-rows preview: no apply, honest re-validation instead", async () => {
    fetchWithSession
      .mockResolvedValueOnce(
        jsonResponse({
          ...PREVIEW_OK,
          statements: [
            {
              verb: "DELETE",
              table: "calendar_dates",
              affected: 0,
              cascade: [],
              sampleRows: [],
            },
          ],
          totalAffected: 0,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ valid: true, errors: {}, counts: { errors: 0 } }),
      );

    const onOutcome = vi.fn();
    render(
      <RepairFlow
        draftSql="DELETE FROM calendar_dates WHERE rowid NOT IN (SELECT MIN(rowid) FROM calendar_dates GROUP BY service_id, date);"
        currentErrorCount={179}
        onOutcome={onOutcome}
      />,
    );
    fireEvent.click(screen.getByTestId("repair-preview"));
    await waitFor(() => screen.getByTestId("repair-zero-rows"));

    // The apply button never appears — there is nothing to apply.
    expect(screen.queryByTestId("repair-apply")).toBeNull();

    fireEvent.click(screen.getByTestId("repair-revalidate-zero"));
    await waitFor(() => screen.getByTestId("repair-report"));

    // Neutral wording: the flow refreshed a stale report, it did not "fix
    // 179 errors" with a no-op DELETE.
    expect(screen.getByTestId("repair-report").textContent).toContain(
      "chat.repair.reportRefreshed",
    );
    expect(recordEdit).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(
      expect.stringContaining("No rows matched"),
    );
  });

  it("signals onApplied(true) after apply and onApplied(false) after undo", async () => {
    fetchWithSession
      .mockResolvedValueOnce(jsonResponse(PREVIEW_OK))
      .mockResolvedValueOnce(jsonResponse({ affected: 3, mutated: true }))
      .mockResolvedValueOnce(
        jsonResponse({ valid: true, errors: {}, counts: { errors: 0 } }),
      );

    const onApplied = vi.fn();
    render(
      <RepairFlow
        draftSql="INSERT INTO feed_info (feed_publisher_name) SELECT 'x';"
        onApplied={onApplied}
      />,
    );
    fireEvent.click(screen.getByTestId("repair-preview"));
    await waitFor(() => screen.getByTestId("repair-apply"));
    fireEvent.click(screen.getByTestId("repair-apply"));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByTestId("repair-undo"));
    await waitFor(() => expect(onApplied).toHaveBeenLastCalledWith(false));
  });

  it("gates apply behind edit mode", async () => {
    editingState = false;
    fetchWithSession.mockResolvedValueOnce(jsonResponse(PREVIEW_OK));

    render(<RepairFlow draftSql="UPDATE routes SET route_url = NULL;" />);
    fireEvent.click(screen.getByTestId("repair-preview"));
    await waitFor(() =>
      expect(screen.getByText("chat.blocked.enterEditMode")).toBeTruthy(),
    );
    expect(screen.queryByTestId("repair-apply")).toBeNull();
  });
});
