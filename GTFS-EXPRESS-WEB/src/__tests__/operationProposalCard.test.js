/**
 * operationProposalCard.test.js — the assistant's operation proposals
 * (rename batch with line-by-line review, stop merge, calendar extension):
 * the request hits the right endpoint with the reviewed params, recordEdit
 * runs after apply, and the outcome is reported back to the assistant.
 */

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const recordEdit = vi.fn();
const undoLast = vi.fn().mockResolvedValue(undefined);
const enterEditMode = vi.fn().mockResolvedValue({ ok: true });
let editingState = true;

vi.mock("../contexts/EditModeContext", () => ({
  useEditMode: () => ({ editing: editingState, entering: false, enterEditMode, recordEdit, undoLast }),
}));

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({
    t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key),
  }),
}));

const fetchWithSession = vi.fn();
vi.mock("../utils/sessionManager", () => ({
  fetchWithSession: (...args) => fetchWithSession(...args),
}));

import OperationProposalCard from "../components/chat/OperationProposalCard";

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("OperationProposalCard", () => {
  beforeEach(() => {
    fetchWithSession.mockReset();
    recordEdit.mockClear();
    editingState = true;
  });

  it("rename_stops: unticked lines are left out of the request", async () => {
    fetchWithSession.mockResolvedValueOnce(jsonResponse({ renamed: 1, renames: [{ stop_id: "B" }], validation: { items: [] }, undoEntryId: 7 }));
    const onOutcome = vi.fn();
    render(
      <OperationProposalCard
        proposal={{
          proposalId: "p1",
          kind: "operation",
          operation: "rename_stops",
          title: "Harmoniser",
          rationale: "Sans code",
          params: { renames: [{ stop_id: "A", stop_name: "Gare" }, { stop_id: "B", stop_name: "Mairie" }] },
          preview: { renames: [{ stop_id: "A", old_name: "GARE", stop_name: "Gare" }, { stop_id: "B", old_name: "MAIRIE", stop_name: "Mairie" }], unchanged: 0 },
        }}
        onOutcome={onOutcome}
      />,
    );
    expect(screen.getByText("chat.op.renameSelected")).toBeTruthy();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]);
    fireEvent.click(screen.getByTestId("chat-operation-apply"));
    await waitFor(() => expect(fetchWithSession).toHaveBeenCalledTimes(1));
    const [url, init] = fetchWithSession.mock.calls[0];
    expect(url).toMatch(/\/edit\/stops\/rename_batch$/);
    expect(JSON.parse(init.body)).toEqual({ renames: [{ stop_id: "B", stop_name: "Mairie" }] });
    await waitFor(() => expect(recordEdit).toHaveBeenCalledTimes(1));
    expect(recordEdit.mock.calls[0][2]).toMatchObject({ entity: "stop", entityId: "B" });
    expect(onOutcome).toHaveBeenCalledWith("Applied: 1 stop(s) renamed.");
    expect(screen.getByTestId("chat-operation-undo")).toBeTruthy();
  });

  it("rename_stops: nothing selected disables apply", () => {
    render(
      <OperationProposalCard
        proposal={{
          proposalId: "p1",
          kind: "operation",
          operation: "rename_stops",
          title: "x",
          params: { renames: [{ stop_id: "A", stop_name: "Gare" }] },
          preview: { renames: [{ stop_id: "A", old_name: "GARE", stop_name: "Gare" }] },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByTestId("chat-operation-apply").closest("button").disabled).toBe(true);
  });

  it("merge_stops: shows the plan and posts the params as is", async () => {
    fetchWithSession.mockResolvedValueOnce(jsonResponse({ merged: 1, survivor: { stop_id: "S" }, validation: { items: [] }, undoEntryId: 9 }));
    render(
      <OperationProposalCard
        proposal={{
          proposalId: "p2",
          kind: "operation",
          operation: "merge_stops",
          title: "Fusion",
          params: { survivor_id: "S", duplicate_ids: ["D"] },
          preview: {
            survivor: { stop_id: "S", stop_name: "Gare" },
            duplicates: [{ stop_id: "D", stop_name: "Gare (bis)", distance_m: 3, stop_times: 40 }],
            by_table: { stop_times: 40, transfers: 2 },
            trips_with_both: 1,
            filled: { stop_code: "123" },
          },
        }}
      />,
    );
    expect(screen.getByText("chat.op.mergeBoth")).toBeTruthy();
    expect(screen.getByText("chat.op.mergeFilled")).toBeTruthy();
    fireEvent.click(screen.getByTestId("chat-operation-apply"));
    await waitFor(() => expect(fetchWithSession).toHaveBeenCalledTimes(1));
    const [url, init] = fetchWithSession.mock.calls[0];
    expect(url).toMatch(/\/edit\/stops\/merge$/);
    expect(JSON.parse(init.body)).toEqual({ survivor_id: "S", duplicate_ids: ["D"] });
    await waitFor(() => expect(recordEdit).toHaveBeenCalled());
    expect(recordEdit.mock.calls[0][2]).toMatchObject({ entity: "stop", entityId: "S" });
  });

  it("outside edit mode the card offers to enter it and a failed apply shows the error", async () => {
    editingState = false;
    const { rerender } = render(
      <OperationProposalCard
        proposal={{ proposalId: "p3", kind: "operation", operation: "extend_calendar", title: "Prolonger", params: { end_date: "20271231" }, preview: { end_date: "20271231", services: [{ service_id: "WKD", old_end_date: "20270331", end_date: "20271231", trips: 10, exceptions_in_window: 0 }] } }}
      />,
    );
    expect(screen.queryByTestId("chat-operation-apply")).toBeNull();
    fireEvent.click(screen.getByText("chat.blocked.enterEditMode"));
    expect(enterEditMode).toHaveBeenCalled();
    editingState = true;
    fetchWithSession.mockResolvedValueOnce(jsonResponse({ error: "Nothing to extend" }, 409));
    rerender(
      <OperationProposalCard
        proposal={{ proposalId: "p3", kind: "operation", operation: "extend_calendar", title: "Prolonger", params: { end_date: "20271231" }, preview: { end_date: "20271231", services: [] } }}
      />,
    );
    fireEvent.click(screen.getByTestId("chat-operation-apply"));
    await waitFor(() => expect(screen.getByText("Nothing to extend")).toBeTruthy());
    expect(recordEdit).not.toHaveBeenCalled();
  });
});
