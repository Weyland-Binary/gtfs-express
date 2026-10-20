import { describe, it, expect, vi } from "vitest";
import { isChunkLoadError, reloadOnceForStaleChunk, RELOAD_STAMP_KEY, RELOAD_WINDOW_MS } from "../utils/chunkErrors";

const memoryStorage = () => {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
};

describe("isChunkLoadError", () => {
  it("recognises each browser's message for a failed lazy chunk", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: https://x/assets/a.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module: https://x/assets/a.js"))).toBe(true);
    expect(isChunkLoadError("Unable to preload CSS for /assets/a.css")).toBe(true);
  });

  it("leaves any other error alone", () => {
    expect(isChunkLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isChunkLoadError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe("reloadOnceForStaleChunk", () => {
  it("reloads once, then not again within the window, then again after it", () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(reloadOnceForStaleChunk({ storage, now: 1000, reload })).toBe(true);
    expect(storage.getItem(RELOAD_STAMP_KEY)).toBe("1000");
    expect(reloadOnceForStaleChunk({ storage, now: 1000 + RELOAD_WINDOW_MS - 1, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadOnceForStaleChunk({ storage, now: 1000 + RELOAD_WINDOW_MS, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never reloads without a usable storage (no guard against a loop)", () => {
    const reload = vi.fn();
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(reloadOnceForStaleChunk({ storage: null, reload })).toBe(false);
    expect(reloadOnceForStaleChunk({ storage: throwing, reload })).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});
