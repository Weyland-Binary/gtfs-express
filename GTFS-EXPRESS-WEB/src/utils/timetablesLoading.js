/**
 * A network read before its stop times are in (the API's timetablesLoading): the opening answered once the network
 * could be read, and its stop times load behind. What the server cannot answer without them it refuses 425
 * TIMETABLES_LOADING; fetchWithSession then waits here and asks again once they are in, so a screen that needs them
 * stays in its own loading state and completes by itself. One network at a time (the one the reader shows): where
 * its load stands is asked every second, said by the status bar, and its end is an event the app hears (the whole
 * network to read again, or the refusal of stop times that could not be loaded).
 */

import { useSyncExternalStore } from "react";
import API_BASE_URL from "../config";
import { TIMETABLES_WHOLE_EVENT, TIMETABLES_FAILED_EVENT } from "./appEvents";

// What the reader's openings ask with: the server may answer before a large feed's stop times are in. An opening
// that does not ask is answered whole, as a screen that reads the network by its id expects.
export const READ_FIRST_HEADERS = Object.freeze({ "X-Read-Before-Timetables": "1" });

const POLL_MS = 1000;
const POLL_AGAIN_MS = 3000;

// { sessionId, done, total } while the stop times load, else null.
let current = null;
let timer = null;
const waiting = new Set();
const listeners = new Set();
// Given by sessionManager, which reads this module: the request that says where a session's stop times stand.
let ask = null;
export const setTimetablesAsk = (fn) => {
  ask = fn;
};

const set = (next) => {
  current = next;
  for (const listener of listeners) listener();
};
const settle = (sessionId, how) => {
  for (const waiter of [...waiting]) {
    if (waiter.sessionId !== sessionId) continue;
    waiting.delete(waiter);
    waiter.resolve(how);
  }
};

const poll = async (sessionId) => {
  if (!current || current.sessionId !== sessionId) return;
  let status = null;
  try {
    status = ask ? await ask(`${API_BASE_URL}/import/timetables`, sessionId) : null;
  } catch {
    status = null;
  }
  if (!current || current.sessionId !== sessionId) return;
  if (!status || (status.state !== "whole" && status.state !== "failed")) {
    if (status) set({ sessionId, done: Number(status.done) || 0, total: Number(status.total) || 0 });
    timer = setTimeout(() => poll(sessionId), status ? POLL_MS : POLL_AGAIN_MS);
    return;
  }
  set(null);
  settle(sessionId, status.state);
  if (typeof window === "undefined") return;
  if (status.state === "whole") window.dispatchEvent(new CustomEvent(TIMETABLES_WHOLE_EVENT, { detail: { sessionId, importAdjustments: status.importAdjustments || {}, blankRows: status.blankRows || {} } }));
  else window.dispatchEvent(new CustomEvent(TIMETABLES_FAILED_EVENT, { detail: { sessionId, status: status.status, refusal: status.refusal || null } }));
};

/** The network of `sessionId` is read while its stop times load: its load is followed from now. */
export const beginTimetables = (sessionId) => {
  if (!sessionId || current?.sessionId === sessionId) return;
  clearTimeout(timer);
  // The network shown before is no longer followed: whoever still waits for it asks again and is answered.
  if (current) settle(current.sessionId, "left");
  set({ sessionId, done: 0, total: 0 });
  poll(sessionId);
};

/** Stops following (the reader left the network). */
export const endTimetables = () => {
  clearTimeout(timer);
  if (!current) return;
  const { sessionId } = current;
  set(null);
  settle(sessionId, "left");
};

/**
 * Resolves once the stop times of `sessionId` are in (« whole »), could not be loaded (« failed ») or are no longer
 * followed (« left »); rejects when `signal` aborts. A session not followed yet is, from here: a page loaded again
 * while they load learns it from the first request refused.
 */
export const whenTimetablesWhole = (sessionId, signal = null) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("The request was aborted.", "AbortError"));
    // Another network is followed: this one is no longer shown, and its request is answered as the server answers.
    if (current && current.sessionId !== sessionId) return resolve("left");
    beginTimetables(sessionId);
    const waiter = { sessionId, resolve };
    waiting.add(waiter);
    signal?.addEventListener(
      "abort",
      () => {
        waiting.delete(waiter);
        reject(new DOMException("The request was aborted.", "AbortError"));
      },
      { once: true },
    );
    return undefined;
  });

/** { sessionId, done, total, percent } while the shown network's stop times load, else null. */
export const getTimetablesLoading = () => current;
export const useTimetablesLoading = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getTimetablesLoading,
    getTimetablesLoading,
  );

/** The share of the feed loaded, 0 to 99: the stop times are in only once the whole network took its place. */
export const percentOf = (loading) => (loading && loading.total > 0 ? Math.max(0, Math.min(99, Math.floor((100 * loading.done) / loading.total))) : null);
