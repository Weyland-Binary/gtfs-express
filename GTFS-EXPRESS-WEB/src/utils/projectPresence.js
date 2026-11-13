/**
 * Where a project is open when not here: another tab of this browser (utils/tabPresence, at once), another of the
 * person's devices or a colleague (the server's holder, asked every 15 s while the page shows it). Nothing is taken from
 * them unasked; the page says where it is and how long ago it was worked on.
 */

import { useEffect, useState } from "react";
import { isThisBrowsersPage, workspacePresence } from "./projectApi";
import { useFeatures } from "./featuresApi";
import { onTabClosed } from "./tabPresence";

const ASK_MS = 15000;

// The server's labels, read the same way: the browser and the system.
const BROWSERS = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS/, "Firefox"],
  [/Chrome\/|CriOS/, "Chrome"],
  [/Safari\//, "Safari"],
];
const SYSTEMS = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];
export const deviceOf = (agent) => {
  const ua = String(agent || "");
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] || null;
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1] || null;
  return browser || system ? [browser, system].filter(Boolean).join(" · ") : null;
};
const ownDevice = () => (typeof navigator !== "undefined" ? deviceOf(navigator.userAgent) : null);

/**
 * Who holds the project now: undefined while not known yet (the server's features still loading included), null when
 * nobody does or the server keeps no projects. Asked again every 15 s while the tab is in front, and when it comes back.
 */
export function useProjectHolder(projectId, handle = null) {
  const { features, loaded } = useFeatures();
  const kept = loaded ? Boolean(features?.workspace?.enabled) : null;
  // The answer is for the project it was asked for: a page whose project just arrived never reads an older one.
  const [answer, setAnswer] = useState({ id: null, holder: null });
  useEffect(() => {
    if (!projectId || kept === null) return undefined;
    if (!kept) {
      setAnswer({ id: projectId, holder: null });
      return undefined;
    }
    let alive = true;
    const ask = () =>
      workspacePresence(projectId)
        .then((out) => alive && setAnswer({ id: projectId, holder: out?.holder || null }))
        .catch(() => alive && setAnswer((a) => (a.id === projectId ? a : { id: projectId, holder: null })));
    ask();
    const timer = setInterval(() => document.visibilityState === "visible" && ask(), ASK_MS);
    let lastAsk = 0;
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastAsk < 3000) return;
      lastAsk = Date.now();
      ask();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    // The tab holding it closed in this browser: its last word reaches the server, then the holder is asked again.
    let after = null;
    const stopClosed = onTabClosed((gone) => {
      if (!handle || gone !== handle) return;
      clearTimeout(after);
      after = setTimeout(ask, 400);
    });
    return () => {
      alive = false;
      clearInterval(timer);
      clearTimeout(after);
      stopClosed();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [projectId, kept, handle]);
  if (!projectId) return null;
  return answer.id === projectId ? answer.holder : undefined;
}

/**
 * Where the project is open, from this browser's tabs (`local`: true, false, null while they answer) and the server's
 * holder: "tab", "device" (the person's other device), "person" (a colleague), "away" (the person elsewhere, the
 * device not told apart from this one), false when nowhere, null while not known yet.
 */
export const whereOpen = ({ local, holder }) => {
  if (local === true) return "tab";
  // A page of this browser is one of its tabs, or a tab closed whose last word did not reach the server yet: the tabs'
  // answer says which.
  if (holder?.live && !holder.self && isThisBrowsersPage(holder.page)) return local === null ? null : false;
  if (holder?.live && !holder.self) {
    if (!holder.same_person) return "person";
    return holder.device && holder.device !== ownDevice() ? "device" : "away";
  }
  if (local === null || holder === undefined) return null;
  return false;
};
