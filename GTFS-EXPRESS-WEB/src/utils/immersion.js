/**
 * The way into the reader from Home: Home's computer screen grows until it is the page, then the reader shows in
 * it. Home registers its screen; the app calls zoomIn() once the network's server side is ready (it resolves when
 * the screen fills the window, at once without a registered screen or with reduced motion) and arrive() once the
 * reader is drawn underneath (app/Immersion fades away then).
 */

import { useSyncExternalStore } from "react";
import { endOpening } from "./networkOpening";

// The screen says « prêt » this long before it grows.
export const SETTLE_MS = 380;
export const ZOOM_MS = 950;
export const LEAVE_MS = 320;
// An arrival never announced (an error swallowed elsewhere) still gives the page back.
const ARRIVAL_LIMIT_MS = 12_000;

let screen = null;
let state = null; // { rect, name, phase: "zoom" | "full" | "leave", done }
const listeners = new Set();
const set = (next) => {
  state = next;
  for (const listener of listeners) listener();
};

/** Home's computer screen while it is shown; returns the unregistering. */
export const registerScreen = (el) => {
  screen = el;
  return () => {
    if (screen === el) screen = null;
  };
};

/** Whether Home's screen is on the page: a network opened now is shown in it. */
export const hasScreen = () => Boolean(screen && screen.isConnected);

const reducedMotion = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const getImmersion = () => state;
export const useImmersion = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getImmersion,
    getImmersion,
  );

let pending = null;
let limit = null;
let arrived = false;

const leave = () => {
  if (!state || state.phase === "leave") return;
  set({ ...state, phase: "leave", done: null });
  setTimeout(() => {
    if (state?.phase === "leave") set(null);
  }, LEAVE_MS);
};

// The reader's first screen still fills itself after the network is taken (its figures, its map): the page is
// drawn once its main area has not changed for a moment.
const QUIET_MS = 220;
const DRAWN_LIMIT_MS = 1600;
const drawn = () =>
  new Promise((resolve) => {
    const root = typeof document !== "undefined" ? document.querySelector("main") : null;
    if (!root || typeof MutationObserver === "undefined") return resolve();
    let quiet = null;
    const done = () => {
      observer.disconnect();
      clearTimeout(quiet);
      clearTimeout(limit);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(quiet);
      quiet = setTimeout(done, QUIET_MS);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    quiet = setTimeout(done, QUIET_MS);
    const limit = setTimeout(done, DRAWN_LIMIT_MS);
  });
const leaveOnceDrawn = () => drawn().then(leave);

/** Grows Home's screen to the window; resolves once it fills it (or at once when there is nothing to grow). */
export function zoomIn({ name = null } = {}) {
  if (pending) return pending;
  const el = screen;
  const rect = el && el.isConnected ? el.getBoundingClientRect() : null;
  if (!rect || rect.width < 40 || reducedMotion()) {
    endOpening();
    return Promise.resolve(false);
  }
  arrived = false;
  pending = new Promise((resolve) => {
    setTimeout(() => {
      // Measured again: the screen may have moved while it said « prêt ».
      const at = el.isConnected ? el.getBoundingClientRect() : null;
      if (!at || at.width < 40) return resolve(false);
      set({ rect: { left: at.left, top: at.top, width: at.width, height: at.height }, name, phase: "zoom", done: () => resolve(true) });
    }, SETTLE_MS);
  }).then((zoomed) => {
    pending = null;
    if (!state) return zoomed;
    if (arrived) leaveOnceDrawn();
    else {
      set({ ...state, phase: "full", done: null });
      clearTimeout(limit);
      limit = setTimeout(arrive, ARRIVAL_LIMIT_MS);
    }
    return zoomed;
  });
  return pending;
}

/** The reader is drawn under the grown screen: it fades away (once the screen has filled the window). */
export function arrive() {
  clearTimeout(limit);
  endOpening();
  arrived = true;
  if (state && state.phase === "full") leaveOnceDrawn();
}
