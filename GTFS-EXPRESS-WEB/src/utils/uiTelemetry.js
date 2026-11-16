/**
 * The steps of the way to the licence the operator's console counts. Fire and forget: never awaited, never retried,
 * never an error on screen. The server keeps a visitor key of the day, never an address.
 * Off under unit tests, whose fetch mocks count a screen's calls.
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

const OFF = import.meta.env.MODE === "test";

/** The server records a `source` it does not list as « other ». */
export const trackUi = (step, source = null, extra = null) => {
  if (OFF || typeof window === "undefined") return;
  try {
    fetchWithSession(`${API_BASE_URL}/telemetry/ui`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, ...(source ? { source } : {}), ...(extra || {}) }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* telemetry never stands in the way */
  }
};

const landingOf = (pathname) => {
  if (/^\/r\//.test(pathname)) return "reader";
  if (/^\/p\//.test(pathname)) return "project";
  if (/^\/partage\//.test(pathname)) return "share";
  if (pathname === "/" || pathname === "") return "home";
  return "other";
};

const referrerHost = () => {
  try {
    if (!document.referrer) return null;
    const host = new URL(document.referrer).hostname;
    return host && host !== window.location.hostname ? host : null;
  } catch {
    return null;
  }
};

let visitSent = false;

// Nothing is stored in the browser: the server keeps one visit per visitor and day.
export const trackVisit = () => {
  if (OFF || visitSent || typeof window === "undefined") return;
  visitSent = true;
  const ref = referrerHost();
  trackUi("visit", landingOf(window.location.pathname), ref ? { ref } : null);
};
