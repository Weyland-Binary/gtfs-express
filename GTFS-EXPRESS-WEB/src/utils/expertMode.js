/**
 * The « Expert » switch changes what is shown, never what is allowed: the server still holds every write and the
 * SQL console's assistant behind the licence. Where accounts exist it is the signed-in account's, switched from its
 * menu: a visitor sees the reader without the expert tools. A server without accounts keeps the switch in the bar.
 */

import { useEffect, useState } from "react";
import { useAccount } from "../contexts/AccountContext";
import { EXPERT_EVENT } from "./appEvents";

const KEY = "gtfs:expert";

export const isExpert = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

export const setExpert = (on) => {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage disabled: the switch holds for this page only */
  }
  window.dispatchEvent(new CustomEvent(EXPERT_EVENT, { detail: { on: Boolean(on) } }));
};

/** Whether the switch lives in the account's menu (accounts exist) rather than in the bar. */
export const useExpertInAccount = () => useAccount().enabled;

/** Follows changes from another component and from another tab; off for a visitor where accounts exist. */
export function useExpertMode() {
  const { enabled, me } = useAccount();
  const [on, setOn] = useState(isExpert);
  useEffect(() => {
    const follow = (e) => setOn(typeof e?.detail?.on === "boolean" ? e.detail.on : isExpert());
    const fromStorage = (e) => {
      if (e.key === KEY) setOn(isExpert());
    };
    window.addEventListener(EXPERT_EVENT, follow);
    window.addEventListener("storage", fromStorage);
    return () => {
      window.removeEventListener(EXPERT_EVENT, follow);
      window.removeEventListener("storage", fromStorage);
    };
  }, []);
  return [on && (!enabled || Boolean(me)), setExpert];
}
