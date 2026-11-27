/**
 * What a screen read of the open network and where the person left it, kept in memory while the screen is away: it
 * comes back at once, as it was, and reads again in silence. Kept by network (the session read) and, for what follows
 * the data, by its version. Memory only: nothing here reaches the browser's storage.
 */

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { validatedSession } from "./sessionManager";

// The working copy and its draft are two networks: both are kept, an older one dropped.
const MAX_NETWORKS = 2;
// What one network keeps at most, the oldest dropped first.
const MAX_ENTRIES = 160;

const networks = new Map();

const entriesOf = () => {
  const network = validatedSession() || "";
  const entries = networks.get(network) || new Map();
  // The network read last stays the longest.
  networks.delete(network);
  networks.set(network, entries);
  while (networks.size > MAX_NETWORKS) networks.delete(networks.keys().next().value);
  return entries;
};
const keyOf = (name, version) => `${version}|${name}`;

// Who follows what is kept, told once a moment after it changed: a write made while a screen is drawn tells no one
// in the middle of it.
const watchers = new Set();
let telling = false;
const tell = () => {
  if (telling || watchers.size === 0) return;
  telling = true;
  queueMicrotask(() => {
    telling = false;
    for (const watcher of [...watchers]) watcher();
  });
};
const watchKept = (watcher) => {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
};

/** What is kept under `name` for the open network (and `version` of its data), undefined when nothing is. */
export const readKept = (name, version = "") => entriesOf().get(keyOf(name, version));

export const writeKept = (name, value, version = "") => {
  const entries = entriesOf();
  const key = keyOf(name, version);
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
  tell();
};

export const dropKept = (name, version = "") => {
  if (entriesOf().delete(keyOf(name, version))) tell();
};

/** Everything forgotten: another person signs in, a test starts. */
export const clearKept = () => {
  networks.clear();
  tell();
};

/**
 * A state of the screen that outlives it: `[value, set]` as useState gives, read back when the screen returns to the
 * same network. `fresh` starts from that value whatever was kept (the screen was asked to open on something).
 */
export function useKept(name, initial, { version = "", fresh = undefined } = {}) {
  const [value, setValue] = useState(() => {
    if (fresh !== undefined) {
      writeKept(name, fresh, version);
      return fresh;
    }
    const kept = readKept(name, version);
    return kept !== undefined ? kept : typeof initial === "function" ? initial() : initial;
  });
  const at = useRef(version);
  at.current = version;
  const set = useCallback(
    (next) =>
      setValue((prev) => {
        const now = typeof next === "function" ? next(prev) : next;
        writeKept(name, now, at.current);
        return now;
      }),
    [name],
  );
  return [value, set];
}

/** What is kept under `name`, followed: the screen that reads it is drawn again when it is written or dropped. */
export function useKeptValue(name, version = "") {
  return useSyncExternalStore(watchKept, () => readKept(name, version));
}

/** The names the report's first reads are kept under: who reads them ahead writes where the page looks. */
export const KEPT = Object.freeze({
  // The corrections of this network are being computed ahead of the report's opening.
  warming: "report.warming",
  plan: "repair.plan",
  announced: (skip, include, answers, contact) => `correction.announced:${JSON.stringify([skip, include, answers, Boolean(contact)])}`,
});

/** Whether two answers of the server say the same: the screen keeps the one it shows, and nothing is drawn again. */
export const sameAnswer = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
