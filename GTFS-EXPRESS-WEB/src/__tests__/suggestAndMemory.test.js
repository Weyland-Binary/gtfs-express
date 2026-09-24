/**
 * suggestAndMemory.test.js — the form sparkle (POST /ai/suggest-field fills
 * the field and explains), the session-memory hook (GET/PUT + broadcast)
 * and the memory chip's popover.
 */

import React, { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ThemeProvider, createTheme } from "@mui/material/styles";
import { TextField } from "@mui/material";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({
    language: "fr",
    t: (key, params = {}) => Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key),
  }),
}));
let chatEnabled = true;
vi.mock("../utils/featuresApi", () => ({ useFeatures: () => ({ features: { chat: { enabled: chatEnabled } } }) }));
const fetchWithSession = vi.fn();
vi.mock("../utils/sessionManager", () => ({ fetchWithSession: (...args) => fetchWithSession(...args) }));

import SuggestFieldButton from "../components/edit/SuggestFieldButton";
import useAssistantMemory, { MEMORY_EVENT, updateAssistantMemory } from "../components/chat/useAssistantMemory";
import MemoryChip from "../components/chat/MemoryChip";

const theme = createTheme({ palette: { ai: { main: "#7c4dff", dark: "#5e35b1", gradientStart: "#7c4dff", gradientEnd: "#00bcd4", contrastText: "#fff" } } });
const withTheme = (ui) => <ThemeProvider theme={theme}>{ui}</ThemeProvider>;
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function Form() {
  const [form, setForm] = useState({ stop_id: "S1", stop_name: "" });
  return (
    <TextField
      label="name"
      value={form.stop_name}
      onChange={(e) => setForm((f) => ({ ...f, stop_name: e.target.value }))}
      inputProps={{ "data-testid": "name" }}
      InputProps={{ endAdornment: <SuggestFieldButton entity="stop" field="stop_name" form={form} id={form.stop_id} onSuggest={(v) => setForm((f) => ({ ...f, stop_name: v }))} /> }}
    />
  );
}

describe("SuggestFieldButton", () => {
  beforeEach(() => {
    fetchWithSession.mockReset();
    chatEnabled = true;
  });

  it("fills the field with the suggestion and sends the form context", async () => {
    fetchWithSession.mockResolvedValueOnce(jsonResponse({ field: "stop_name", value: "Gare Centrale", reason: "Nom des arrêts voisins" }));
    render(withTheme(<Form />));
    fireEvent.click(screen.getByTestId("suggest-stop_name"));
    await waitFor(() => expect(screen.getByTestId("name").value).toBe("Gare Centrale"));
    const [url, init] = fetchWithSession.mock.calls[0];
    expect(url).toMatch(/\/ai\/suggest-field$/);
    expect(JSON.parse(init.body)).toEqual({ entity: "stop", field: "stop_name", form: { stop_id: "S1", stop_name: "" }, id: "S1", language: "fr" });
  });

  it("keeps the field when the model has nothing to suggest, and hides itself when the chat is off", async () => {
    fetchWithSession.mockResolvedValueOnce(jsonResponse({ field: "stop_name", value: "", reason: "Aucun indice" }));
    render(withTheme(<Form />));
    fireEvent.click(screen.getByTestId("suggest-stop_name"));
    await waitFor(() => expect(fetchWithSession).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("name").value).toBe("");
    chatEnabled = false;
    const { container } = render(withTheme(<SuggestFieldButton entity="stop" field="stop_desc" form={{}} onSuggest={() => {}} />));
    expect(container.innerHTML).toBe("");
  });
});

function MemoryHarness() {
  const { memory, update } = useAssistantMemory({ enabled: true });
  return withTheme(<MemoryChip memory={memory} onUpdate={update} />);
}

describe("assistant memory hook and chip", () => {
  beforeEach(() => fetchWithSession.mockReset());

  it("loads the memory, adds a note, forgets it, and follows broadcast updates", async () => {
    fetchWithSession
      .mockResolvedValueOnce(jsonResponse({ notes: [], ignoredFindings: ["duplicate_stops"], updatedAt: null }))
      .mockResolvedValueOnce(jsonResponse({ notes: [{ id: "n1", text: "Ligne 12 scolaire" }], ignoredFindings: ["duplicate_stops"], updatedAt: "x" }))
      .mockResolvedValueOnce(jsonResponse({ notes: [], ignoredFindings: ["duplicate_stops"], updatedAt: "y" }));
    render(<MemoryHarness />);
    await waitFor(() => expect(screen.getByTestId("chat-memory-chip").textContent).toBe("1"));
    fireEvent.click(screen.getByTestId("chat-memory-chip"));
    await waitFor(() => expect(screen.getByTestId("chat-memory-popover")).toBeTruthy());
    expect(screen.getByText("duplicate_stops")).toBeTruthy();
    fireEvent.change(screen.getByTestId("chat-memory-input"), { target: { value: "Ligne 12 scolaire" } });
    fireEvent.keyDown(screen.getByTestId("chat-memory-input"), { key: "Enter" });
    await waitFor(() => expect(screen.getByText("Ligne 12 scolaire")).toBeTruthy());
    const put = fetchWithSession.mock.calls[1];
    expect(put[1].method).toBe("PUT");
    expect(JSON.parse(put[1].body)).toEqual({ addNotes: ["Ligne 12 scolaire"] });
    expect(screen.getByTestId("chat-memory-chip").textContent).toBe("2");
    fireEvent.click(screen.getByLabelText("chat.memory.forget"));
    await waitFor(() => expect(screen.getByTestId("chat-memory-chip").textContent).toBe("1"));
    // Another surface (the Diagnostic) wrote the memory: the chip follows.
    act(() => {
      window.dispatchEvent(new CustomEvent(MEMORY_EVENT, { detail: { notes: [], ignoredFindings: [], updatedAt: "z" } }));
    });
    await waitFor(() => expect(screen.getByTestId("chat-memory-chip").textContent).toBe("0"));
  });

  it("updateAssistantMemory broadcasts the new memory", async () => {
    fetchWithSession.mockResolvedValueOnce(jsonResponse({ notes: [], ignoredFindings: ["x"], updatedAt: "t" }));
    const seen = vi.fn();
    window.addEventListener(MEMORY_EVENT, (e) => seen(e.detail));
    const body = await updateAssistantMemory({ ignore: ["x"] });
    expect(body.ignoredFindings).toEqual(["x"]);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ ignoredFindings: ["x"] }));
  });
});
