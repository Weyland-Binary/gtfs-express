/**
 * briefChecklist.test.js — the brief, clause by clause: verdicts shown with
 * what was expected and measured, failures first; the user's decisions
 * (lift with a reason, require again, make it a wish) are recorded as
 * theirs; a clause implied by the brief becomes a recorded one when the
 * user decides on it; the footer badge counts the required clauses met.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));

import { BriefBadge, BriefChecklist, clauseLabel } from "../components/network/BriefChecklist";

const withTheme = (ui) => <ThemeProvider theme={createTheme()}>{ui}</ThemeProvider>;

const CLAUSES = [
  { id: "A_peak", kind: "headway_max", level: "must", status: "stated", text: "A every 10 min at peak", params: { line: "A", minutes: 10 } },
  { id: "A_exists", kind: "line_exists", level: "must", status: "stated", params: { line: "A" } },
];
const CONFORMANCE = {
  results: [
    { id: "A_exists", kind: "line_exists", level: "must", status: "pass", expected: "line A", measured: "line A", params: { line: "A" } },
    { id: "A_peak", kind: "headway_max", level: "must", status: "fail", expected: "every 10 min", measured: "longest wait 15 min", params: { line: "A", minutes: 10 } },
    { id: "req_b_exists", kind: "line_exists", level: "must", status: "fail", text: "Line B", expected: "line B", measured: "no such line", params: { line: "B" } },
  ],
  summary: { must: { total: 3, pass: 1, fail: 2, unknown: 0 }, should: { total: 0, pass: 0, fail: 0, unknown: 0 }, waived: 0 },
  conforms: false,
};

describe("BriefChecklist", () => {
  it("lists failures first with what was expected and measured", () => {
    render(withTheme(<BriefChecklist clauses={CLAUSES} conformance={CONFORMANCE} />));
    const rows = screen.getAllByTestId("brief-clause");
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["fail", "fail", "pass"]);
    expect(rows[0].textContent).toMatch(/A every 10 min at peak/);
    expect(rows[0].textContent).toMatch(/longest wait 15 min/);
    // Read-only without onChange: no action buttons.
    expect(screen.queryByTestId("brief-waive")).toBeNull();
  });

  it("lifting a clause records the user's decision and reason", () => {
    const onChange = vi.fn();
    render(withTheme(<BriefChecklist clauses={CLAUSES} conformance={CONFORMANCE} onChange={onChange} />));
    const row = screen.getAllByTestId("brief-clause").find((r) => r.getAttribute("data-clause") === "A_peak");
    fireEvent.click(within(row).getByTestId("brief-waive"));
    fireEvent.change(within(row).getByTestId("brief-waive-reason"), { target: { value: "budget" } });
    fireEvent.click(within(row).getByTestId("brief-waive-ok"));
    const next = onChange.mock.calls[0][0];
    expect(next.find((c) => c.id === "A_peak")).toMatchObject({ status: "waived", reason: "budget", decided_by: "user" });
    expect(next).toHaveLength(2);
  });

  it("a clause implied by the brief becomes a recorded one when the user decides", () => {
    const onChange = vi.fn();
    render(withTheme(<BriefChecklist clauses={CLAUSES} conformance={CONFORMANCE} onChange={onChange} />));
    const row = screen.getAllByTestId("brief-clause").find((r) => r.getAttribute("data-clause") === "req_b_exists");
    fireEvent.click(within(row).getByTestId("brief-level"));
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(3);
    expect(next[2]).toMatchObject({ id: "req_b_exists", kind: "line_exists", level: "should", decided_by: "user", params: { line: "B" } });
    expect(next[2].derived).toBeUndefined();
  });

  it("the badge counts the required clauses met", () => {
    render(withTheme(<BriefBadge conformance={CONFORMANCE} />));
    const badge = screen.getByTestId("brief-badge");
    expect(badge.textContent).toBe("network.contract.badge".replace("{pass}", "1").replace("{total}", "3"));
    expect(badge.getAttribute("data-state")).toBe("fail");
  });

  it("labels a clause without text from its kind and parameters", () => {
    const t = (k) => (k === "network.clause.kind.headway_max" ? "Frequency" : k);
    expect(clauseLabel({ kind: "headway_max", params: { line: "A", minutes: 10 } }, t)).toBe("Frequency · A · 10 min");
  });
});
