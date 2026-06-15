/**
 * useSmoothText.test.js — the streaming reveal must never lie:
 * it animates while streaming, always converges on the full target,
 * snaps instantly when streaming ends, and resets cleanly on regenerate.
 */

import { describe, expect, it } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import useSmoothText from "../components/chat/useSmoothText";

const LONG = "The quick brown fox jumps over the lazy dog. ".repeat(8);

describe("useSmoothText", () => {
  it("returns the target untouched when not streaming", () => {
    const { result } = renderHook(
      ({ target, enabled }) => useSmoothText(target, enabled),
      { initialProps: { target: LONG, enabled: false } },
    );
    expect(result.current).toBe(LONG);
  });

  it("converges on the full target while streaming", async () => {
    const { result, rerender } = renderHook(
      ({ target, enabled }) => useSmoothText(target, enabled),
      { initialProps: { target: "", enabled: true } },
    );
    // A burst of text lands at once (typical SSE chunk).
    rerender({ target: LONG, enabled: true });
    await waitFor(() => expect(result.current).toBe(LONG), { timeout: 3000 });
  });

  it("snaps to the full text the moment streaming ends", () => {
    const { result, rerender } = renderHook(
      ({ target, enabled }) => useSmoothText(target, enabled),
      { initialProps: { target: "", enabled: true } },
    );
    rerender({ target: LONG, enabled: true });
    // Completion mid-animation: no trailing animation may delay the answer.
    act(() => {
      rerender({ target: LONG, enabled: false });
    });
    expect(result.current).toBe(LONG);
  });

  it("resets instantly when the target shrinks (regenerate)", async () => {
    const { result, rerender } = renderHook(
      ({ target, enabled }) => useSmoothText(target, enabled),
      { initialProps: { target: "first answer that streamed", enabled: true } },
    );
    await waitFor(() =>
      expect(result.current).toBe("first answer that streamed"),
    );
    rerender({ target: "new", enabled: true });
    await waitFor(() => expect(result.current).toBe("new"));
  });
});
