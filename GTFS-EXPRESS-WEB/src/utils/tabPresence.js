/**
 * Which networks the other tabs of this browser hold: asked on a BroadcastChannel, each tab answers with the handle of
 * the network open in it. A project whose network handle another tab holds is open in that tab, and resuming it here
 * would take it from there. Where tabs cannot talk to each other, no tab is known to hold anything.
 */

import { useEffect, useState } from "react";

const CHANNEL = "gtfs:tabs";
const ANSWER_MS = 150;

let heldHere = () => null;
// Said gone: a closing page answers no more while it is torn down, unless it comes back from the back-forward cache.
let closing = false;
let channel = null;
const asks = new Map(); // ask id → the handles answered
const released = new Set(); // called with a handle a closing tab let go

const open = () => {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    return null;
  }
  // Never keeps a test runner's process alive (Node's channel only).
  channel.unref?.();
  channel.onmessage = ({ data }) => {
    if (data?.type === "ask") {
      if (closing) return;
      const handle = heldHere();
      if (handle) channel.postMessage({ type: "held", ask: data.ask, handle });
    } else if (data?.type === "held" && asks.has(data.ask)) {
      asks.get(data.ask).add(data.handle);
    } else if (data?.type === "gone" && data.handle) {
      for (const listener of released) listener(data.handle);
    }
  };
  return channel;
};

const sayGone = () => {
  const handle = heldHere();
  closing = true;
  if (handle && channel) channel.postMessage({ type: "gone", handle });
};
const backAgain = () => {
  closing = false;
};

/**
 * This tab answers with what `getHandle()` gives: the handle of the network open here, or null; closing, it says it
 * lets that network go, so a tab waiting on it knows at once.
 */
export const answerAsHolding = (getHandle) => {
  heldHere = getHandle;
  if (open() && typeof window !== "undefined") {
    window.removeEventListener("pagehide", sayGone);
    window.addEventListener("pagehide", sayGone);
    window.removeEventListener("pageshow", backAgain);
    window.addEventListener("pageshow", backAgain);
  }
};

/** Calls `fn(handle)` when another tab of this browser closes, with the handle it let go; returns the unsubscribe. */
export const onTabClosed = (fn) => {
  open();
  released.add(fn);
  return () => released.delete(fn);
};

/** The handles the other tabs hold, gathered for a moment; an empty set where tabs cannot talk. */
export const handlesHeldElsewhere = (wait = ANSWER_MS) =>
  new Promise((resolve) => {
    const ch = open();
    if (!ch) return resolve(new Set());
    const ask = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    asks.set(ask, new Set());
    ch.postMessage({ type: "ask", ask });
    setTimeout(() => {
      const held = asks.get(ask) || new Set();
      asks.delete(ask);
      resolve(held);
    }, wait);
  });

/**
 * Whether another tab holds `handle`: null while asking, then true or false; false at once without a handle. Asked
 * again when the tab comes back to the front, where the other tab may have taken it meanwhile, and when the tab
 * holding it closes.
 */
export function useHeldElsewhere(handle) {
  // The answer is for the handle it was asked for: a handle that just changed never reads the last one's.
  const [answer, setAnswer] = useState({ handle: null, held: false });
  useEffect(() => {
    if (!handle) return undefined;
    let alive = true;
    const ask = () => handlesHeldElsewhere().then((handles) => alive && setAnswer({ handle, held: handles.has(handle) }));
    ask();
    const onVisible = () => document.visibilityState === "visible" && ask();
    const onGone = (gone) => gone === handle && ask();
    document.addEventListener("visibilitychange", onVisible);
    released.add(onGone);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", onVisible);
      released.delete(onGone);
    };
  }, [handle]);
  if (!handle) return false;
  return answer.handle === handle ? answer.held : null;
}
