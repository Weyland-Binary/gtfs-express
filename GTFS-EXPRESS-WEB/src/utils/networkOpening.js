/**
 * A network opening from Home (the person's file, a published feed, the demo), as Home's computer screen shows it:
 * the bytes the browser sends, then the stages the server says on GET /import/progress/:id while the request runs
 * (the request carries X-Import-Progress). One opening at a time; the stages are a courtesy, the opening goes on
 * without them. The request never waits for the stream: a stream that joins late is given the stage the opening has
 * reached.
 */

import { useSyncExternalStore } from "react";
import API_BASE_URL from "../config";
import { request } from "./apiRequest";
import { readSSE } from "./transformApi";
import { newSessionId } from "./sessionManager";

// The screen's three steps, the first one the opening's own.
export const FIRST_STEP = { file: "send", feed: "download", demo: "prepare" };

let current = null;
let stopFollowing = null;
const listeners = new Set();
const set = (next) => {
  current = next;
  for (const listener of listeners) listener();
};
const patch = (id, changes) => {
  if (current?.id !== id) return;
  const stageAt = changes.stage && changes.stage !== current.stage ? Date.now() : current.stageAt;
  set({ ...current, ...changes, stageAt });
};

/** The opening on screen ({ id, kind, name, size, stage, done, total, sent, state, stageAt }) or null. */
export const getOpening = () => current;
export const useNetworkOpening = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getOpening,
    getOpening,
  );

/**
 * Starts showing an opening: `kind` file | feed | demo. Its handle gives the header the request carries,
 * `sent(fraction)`, `finish()` once the request answered, and `end()`. Null while another opening is on screen: two would race to the reader, the second
 * replacing the first's network unseen, so the caller refuses its own.
 */
export function beginOpening({ kind, name = null, size = null }) {
  if (current) return null;
  stopFollowing?.();
  const id = newSessionId();
  const controller = new AbortController();
  stopFollowing = () => controller.abort();
  set({ id, kind, name, size, stage: FIRST_STEP[kind] || "prepare", done: null, total: null, sent: null, state: "running", stageAt: Date.now() });
  (async () => {
    try {
      const res = await request(`${API_BASE_URL}/import/progress/${id}`, { withSession: false, signal: controller.signal });
      if (!res.ok || !res.body) return;
      await readSSE(res, (event, data) => {
        if (event !== "progress" || !data?.stage) return;
        if (data.stage === "failed") return;
        if (data.stage === "done") return patch(id, { stage: "done", done: null, total: null });
        patch(id, { stage: data.stage, done: Number.isFinite(data.done) ? data.done : null, total: Number.isFinite(data.total) ? data.total : null });
      });
    } catch {
      /* no stages to show: the opening itself is unaffected */
    }
  })();
  return {
    id,
    headers: { "X-Import-Progress": id },
    sent: (fraction) => patch(id, { sent: Math.max(0, Math.min(1, fraction)) }),
    finish: () => patch(id, { state: "ready", stage: "done", done: null, total: null }),
    end: () => {
      controller.abort();
      if (current?.id === id) set(null);
    },
  };
}

/** Whether a network is opening on Home's screen: the other ways to open one wait. */
export const useOpeningBusy = () => Boolean(useNetworkOpening());

/** Ends whatever opening is on screen (the reader has taken it). */
export const endOpening = () => {
  stopFollowing?.();
  if (current) set(null);
};
