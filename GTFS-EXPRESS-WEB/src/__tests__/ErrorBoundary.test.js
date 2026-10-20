import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { useEffect } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import fr from "virtual:i18n/fr";
import ErrorBoundary from "../components/ErrorBoundary";

// The boundary's default fallback reads the language outside any provider
// (useOptionalT): French, the default, is in the app — its sentences here.
describe("ErrorBoundary", () => {
  let errorSpy;
  // React's development build rethrows a caught render error as a window
  // "error" event (jsdom prints it): silenced, as is React's own log and the boundary's.
  const swallow = (e) => e.preventDefault();
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    window.addEventListener("error", swallow);
  });
  afterEach(() => {
    window.removeEventListener("error", swallow);
    errorSpy.mockRestore();
  });

  it("renders the fallback on a throw, and retry remounts the children", () => {
    const state = { fail: true, mounts: 0 };
    const Bomb = () => {
      useEffect(() => {
        state.mounts += 1;
      }, []);
      if (state.fail) throw new Error("boom");
      return <p>alive</p>;
    };

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText(fr["errorBoundary.title"])).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.queryByText("alive")).not.toBeInTheDocument();

    state.fail = false;
    fireEvent.click(screen.getByRole("button", { name: fr["app.retry"] }));
    expect(screen.getByText("alive")).toBeInTheDocument();
    expect(state.mounts).toBe(1);
  });

  it("offers a reload, not a retry, for a stale lazy chunk", () => {
    const Stale = () => {
      throw new TypeError("Failed to fetch dynamically imported module: /assets/SqlConsole-old.js");
    };
    render(
      <ErrorBoundary>
        <Stale />
      </ErrorBoundary>,
    );
    expect(screen.getByText(fr["errorBoundary.chunkTitle"])).toBeInTheDocument();
    expect(screen.getByRole("button", { name: fr["errorBoundary.reload"] })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: fr["app.retry"] })).not.toBeInTheDocument();
  });

  it("passes the error and the retry to a render-prop fallback", () => {
    const Bomb = () => {
      throw new Error("kaput");
    };
    render(
      <ErrorBoundary fallback={({ error, chunkError, retry }) => <p>{`${error.message}:${chunkError}:${typeof retry}`}</p>}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText("kaput:false:function")).toBeInTheDocument();
  });
});
