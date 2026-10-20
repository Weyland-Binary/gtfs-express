import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, act, waitFor } from "@testing-library/react";
import { LanguageProvider } from "../contexts/LanguageContext";
import { EditModeProvider, useEditMode } from "../contexts/EditModeContext";

// The provider asks the backend for the edit status on mount: answered here,
// no network.
vi.mock("../utils/sessionManager", () => ({
  fetchWithSession: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ editing: false, counts: null }),
  })),
}));

describe("EditModeContext value", () => {
  it("keeps its identity across a re-render that changes nothing, and a toast does not re-render its consumers", async () => {
    const seen = [];
    const Probe = () => {
      seen.push(useEditMode());
      return null;
    };
    // A memo'd consumer: it re-renders only when the context value changes.
    const MemoProbe = React.memo(Probe);
    const tree = (
      <LanguageProvider>
        <EditModeProvider>
          <MemoProbe />
        </EditModeProvider>
      </LanguageProvider>
    );

    const { rerender } = render(tree);
    await waitFor(() => expect(seen[seen.length - 1].statusReady).toBe(true));
    const settled = seen[seen.length - 1];

    // The same tree again: the providers re-render, the value stays the same object.
    rerender(tree);
    expect(seen[seen.length - 1]).toBe(settled);

    // A toast: shown, and the edit state's consumers do not re-render.
    const before = seen.length;
    act(() => settled.showToast("Saved stop S1", "success"));
    expect(await screen.findByText("Saved stop S1")).toBeInTheDocument();
    expect(seen.length).toBe(before);
    expect(seen[seen.length - 1]).toBe(settled);
  });
});
