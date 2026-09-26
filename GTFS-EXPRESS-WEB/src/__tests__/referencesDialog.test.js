/**
 * referencesDialog.test.js — other operators' timetables: listed with their
 * agencies, trips kept near the network and validity; added from an https
 * URL (the button waits for one); removed.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../contexts/LanguageContext", () => ({
  useLanguage: () => ({ language: "en", t: (key, params = {}) => Object.entries(params || {}).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), key) }),
}));
const api = { fetchReferences: vi.fn(), addReference: vi.fn(), removeReference: vi.fn() };
vi.mock("../utils/transformApi", () => ({ fetchReferences: (...a) => api.fetchReferences(...a), addReference: (...a) => api.addReference(...a), removeReference: (...a) => api.removeReference(...a) }));

import ReferencesDialog from "../components/transform/ReferencesDialog";

describe("ReferencesDialog", () => {
  it("lists, adds from an https URL, removes", async () => {
    const ter = { id: "abcdef123456", name: "TER Occitanie", agencies: ["SNCF Voyageurs"], counts: { trips: 135 }, validity: { start: "20260831", end: "20270704" } };
    api.fetchReferences.mockResolvedValueOnce({ references: [] }).mockResolvedValue({ references: [ter] });
    api.addReference.mockResolvedValue(ter);
    api.removeReference.mockResolvedValue({ ok: true });
    const onChange = vi.fn();
    render(<ReferencesDialog open onClose={() => {}} onChange={onChange} />);
    await screen.findByText("transform.references.none");
    const add = screen.getByTestId("change-reference-add");
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("change-reference-url"), { target: { value: "http://insecure.example/gtfs.zip" } });
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("change-reference-url"), { target: { value: "https://example.org/ter.zip" } });
    fireEvent.click(add);
    await waitFor(() => expect(api.addReference).toHaveBeenCalledWith({ url: "https://example.org/ter.zip", name: undefined }));
    expect((await screen.findByTestId("change-reference")).textContent).toBe("TER Occitanietransform.references.meta");
    expect(onChange).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("transform.references.remove"));
    await waitFor(() => expect(api.removeReference).toHaveBeenCalledWith("abcdef123456"));
  });
});
