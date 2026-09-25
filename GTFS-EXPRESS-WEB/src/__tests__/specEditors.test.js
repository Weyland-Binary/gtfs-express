/**
 * specEditors.test.js — the Lines and Stops tabs of the studio: lines
 * collapsed to one summary row when there are several, a return that only
 * reverses the outbound shown as one line until its order is edited, stops
 * as a table with the lines serving them, a filter and missing positions.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));
vi.mock("../utils/networkStudioApi", () => ({ geocodeQuery: vi.fn(async () => ({ candidates: [] })) }));

import { LinesEditor, StopsEditor } from "../components/network/SpecEditors";

const withTheme = (ui) => <ThemeProvider theme={createTheme()}>{ui}</ThemeProvider>;

const STOPS = [
  { id: "a", name: "Gare", lat: 47.79, lon: 1.07 },
  { id: "b", name: "Mairie", lat: 47.793, lon: 1.065 },
  { id: "c", name: "Hôpital", lat: 47.8, lon: 1.06 },
  { id: "d", name: "ZI Nord" },
];
const line = (id, name, stops, back = null) => ({
  id,
  short_name: name,
  color: "D32F2F",
  mode: "bus",
  directions: [{ id: "0", headsign: "Out", stops }, ...(back ? [{ id: "1", headsign: "Back", stops: back }] : [])],
  services: [{ calendar: "weekday", periods: [{ from: "06:00", to: "20:00", headway_min: 30 }] }],
});

describe("LinesEditor", () => {
  it("shows several lines as summary rows, then a reversed return as one line until its order is edited", () => {
    const spec = { stops: STOPS, lines: [line("L1", "1", ["a", "b", "c"], ["c", "b", "a"]), line("L2", "2", ["a", "c"]), line("L3", "3", ["b", "c"])] };
    render(withTheme(<LinesEditor spec={spec} onChange={() => {}} />));
    expect(screen.getAllByTestId("line-card")).toHaveLength(3);
    // Collapsed: headers only, with the line's summary.
    expect(screen.queryAllByTestId("line-direction")).toHaveLength(0);
    expect(screen.getAllByText(/network\.line\.stops.*network\.calendar\.weekday 06:00–20:00/)).toHaveLength(3);
    fireEvent.click(within(screen.getAllByTestId("line-card")[0]).getByRole("button", { name: "network.line.expand" }));
    const dirs = screen.getAllByTestId("line-direction");
    expect(dirs).toHaveLength(2);
    expect(within(dirs[0]).getAllByRole("listitem")).toHaveLength(3);
    // The return mirrors the outbound: one line, no second stop list.
    expect(within(dirs[1]).getByTestId("direction-mirror").textContent).toContain("network.direction.mirror");
    expect(within(dirs[1]).queryAllByRole("listitem")).toHaveLength(0);
    fireEvent.click(within(dirs[1]).getByTestId("direction-mirror-edit"));
    expect(within(dirs[1]).getAllByRole("listitem")).toHaveLength(3);
  });

  it("opens the details of one or two lines directly; a return that differs is listed in full", () => {
    const spec = { stops: STOPS, lines: [line("L1", "1", ["a", "b", "c"], ["c", "a"])] };
    render(withTheme(<LinesEditor spec={spec} onChange={() => {}} />));
    const dirs = screen.getAllByTestId("line-direction");
    expect(dirs).toHaveLength(2);
    expect(within(dirs[1]).queryByTestId("direction-mirror")).toBeNull();
    expect(within(dirs[1]).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByTestId("line-short-name").value).toBe("1");
  });

  it("edits a period in place", () => {
    const onChange = vi.fn();
    const spec = { stops: STOPS, lines: [line("L1", "1", ["a", "b"])] };
    render(withTheme(<LinesEditor spec={spec} onChange={onChange} />));
    fireEvent.change(screen.getByLabelText("network.field.headway"), { target: { value: "15" } });
    expect(onChange.mock.calls[0][0].lines[0].services[0].periods[0].headway_min).toBe(15);
  });
});

// The studio holds the spec: edits flow back in, as in NetworkStudio.
function Controlled({ initial, Editor }) {
  const [spec, setSpec] = React.useState(initial);
  return <Editor spec={spec} onChange={setSpec} />;
}

describe("LinesEditor — review fixes", () => {
  it("labels server calendar ids and custom or local-weekend calendars by their days, never as raw keys", () => {
    const withCal = (id, calendar) => ({ ...line(id, id, ["a", "b"]), services: [{ calendar, calendar_id: calendar, periods: [{ from: "06:00", to: "20:00", headway_min: 30 }] }] });
    const spec = {
      stops: STOPS,
      // A Fri–Sat weekend: the server's WKD runs Sunday to Thursday.
      calendars: [{ id: "WKD", days: ["sun", "mon", "tue", "wed", "thu"] }, { id: "SAT", days: ["sat"] }, { id: "FRI_SAT", days: ["fri", "sat"] }],
      lines: [withCal("1", "WKD"), withCal("2", "SAT"), withCal("3", "FRI_SAT")],
    };
    render(withTheme(<LinesEditor spec={spec} onChange={() => {}} />));
    const text = screen.getAllByTestId("line-card").map((c) => c.textContent).join(" | ");
    expect(text).not.toMatch(/network\.calendar\.(WKD|SAT|FRI_SAT)/);
    expect(text).toContain("Sun–Thu 06:00–20:00");
    expect(text).toContain("network.calendar.saturday 06:00–20:00");
    expect(text).toContain("Fri, Sat 06:00–20:00");
  });

  it("keeps a line's open state with it when another line is removed, and opens a line just added", () => {
    const spec = { stops: STOPS, lines: [line("", "1", ["a", "b"]), line("", "2", ["b", "c"]), line("", "3", ["a", "c"])].map(({ id: _id, ...l }) => l) };
    render(withTheme(<Controlled initial={spec} Editor={LinesEditor} />));
    const cards = () => screen.getAllByTestId("line-card");
    fireEvent.click(within(cards()[1]).getByRole("button", { name: "network.line.expand" }));
    expect(within(cards()[1]).getAllByTestId("line-direction")).toHaveLength(1);
    fireEvent.click(within(cards()[0]).getByRole("button", { name: "network.removeLine" }));
    // Line "2" is now first and still open; line "3" stays closed.
    expect(cards()).toHaveLength(2);
    expect(within(cards()[0]).getByTestId("line-short-name").value).toBe("2");
    expect(within(cards()[0]).getAllByTestId("line-direction")).toHaveLength(1);
    expect(within(cards()[1]).queryAllByTestId("line-direction")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("add-line"));
    fireEvent.click(screen.getByTestId("add-line"));
    // Four lines: the new ones open (no stops yet) so their stops can be picked.
    expect(within(cards()[3]).getAllByTestId("line-direction")).toHaveLength(1);
  });

  it("gives a new colour a readable text colour", () => {
    const onChange = vi.fn();
    const spec = { stops: STOPS, lines: [{ ...line("L1", "1", ["a", "b"]), color: "1E88E5", text_color: "FFFFFF" }] };
    const { container } = render(withTheme(<LinesEditor spec={spec} onChange={onChange} />));
    fireEvent.change(container.querySelector('input[type="color"]'), { target: { value: "#ffeb3b" } });
    expect(onChange.mock.calls[0][0].lines[0]).toMatchObject({ color: "FFEB3B", text_color: "000000" });
  });
});

describe("StopsEditor", () => {
  const spec = { stops: STOPS, lines: [line("L1", "1", ["a", "b"]), line("L2", "2", ["a", "c"])] };

  it("lists the stops with the lines serving them, unserved and unlocated ones flagged", () => {
    render(withTheme(<StopsEditor spec={spec} onChange={() => {}} />));
    const rows = screen.getAllByTestId("stop-row");
    expect(rows).toHaveLength(4);
    // Gare is served by lines 1 and 2.
    expect(within(rows[0]).getByText("1")).toBeTruthy();
    expect(within(rows[0]).getByText("2")).toBeTruthy();
    // ZI Nord: no line, no position.
    expect(within(rows[3]).getByText("network.stopUnused")).toBeTruthy();
    expect(within(rows[3]).getByText("network.noCoordinates")).toBeTruthy();
    expect(screen.getByText("network.stops.missing")).toBeTruthy();
  });

  it("filters the stops once the list is long", () => {
    const many = { stops: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: i === 3 ? "Gare centrale" : `Arrêt ${i}`, lat: 47 + i / 100, lon: 1 })), lines: [] };
    render(withTheme(<StopsEditor spec={many} onChange={() => {}} />));
    fireEvent.change(screen.getByTestId("stops-filter"), { target: { value: "gare" } });
    expect(screen.getAllByTestId("stop-row")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("stops-filter"), { target: { value: "zzz" } });
    expect(screen.queryAllByTestId("stop-row")).toHaveLength(0);
    expect(screen.getByText("network.stops.noMatch")).toBeTruthy();
  });

  it("never traps the list behind a filter: short lists keep the field while filtered, adding clears it, a renamed row stays", () => {
    const nine = { stops: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: i === 3 ? "Gare centrale" : `Arrêt ${i}`, lat: 47 + i / 100, lon: 1 })), lines: [] };
    render(withTheme(<Controlled initial={nine} Editor={StopsEditor} />));
    fireEvent.change(screen.getByTestId("stops-filter"), { target: { value: "gare" } });
    expect(screen.getAllByTestId("stop-row")).toHaveLength(1);
    // Renaming the matching stop: its row stays while it is being edited.
    const name = screen.getByTestId("stop-name");
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: "P" } });
    expect(screen.getAllByTestId("stop-row")).toHaveLength(1);
    fireEvent.blur(name);
    expect(screen.queryAllByTestId("stop-row")).toHaveLength(0);
    // Down to 8 stops is no dead end: the field stays while it holds text.
    fireEvent.change(screen.getByTestId("stops-filter"), { target: { value: "Arrêt 0" } });
    fireEvent.click(within(screen.getAllByTestId("stop-row")[0]).getByLabelText("network.remove"));
    expect(screen.getByTestId("stops-filter").value).toBe("Arrêt 0");
    // Adding a stop clears the filter so the new row is visible.
    fireEvent.click(screen.getByTestId("add-stop"));
    expect(screen.getAllByTestId("stop-row")).toHaveLength(9);
  });
});
