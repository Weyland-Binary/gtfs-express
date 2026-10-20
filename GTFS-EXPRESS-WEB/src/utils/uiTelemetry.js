/**
 * uiTelemetry — the steps of the way to the licence the operator's console counts (POST /telemetry/ui, the API's
 * services/admin/funnel): a visit, « Modifier » clicked, the offer shown, the sign-in opened, a way to the licence
 * chosen. Fire and forget: never awaited, never retried, never an error on screen. The server keeps the step, where
 * it was asked from (its closed list), the account if one is signed in and a visitor key of the day — no address.
 *
 * Unit tests run without it: their fetch mocks count the calls a screen makes, and a counter is none of them.
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

const OFF = import.meta.env.MODE === "test";

/** Report one step; `source` is where it was asked from (the server keeps « other » for a source it does not list). */
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
    /* a counter never stands in the way */
  }
};

/** Where a visit lands, by the page's path. */
const landingOf = (pathname) => {
  if (/^\/r\//.test(pathname)) return "reader";
  if (/^\/p\//.test(pathname)) return "project";
  if (/^\/partage\//.test(pathname)) return "share";
  if (pathname === "/" || pathname === "") return "home";
  return "other";
};

/** The referring site's host name, when the visit came from another site. */
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

/**
 * The visit of this page load: where it landed, and the site it came from. Nothing is stored in the browser to
 * remember it: the server keeps one visit per visitor and day.
 */
export const trackVisit = () => {
  if (OFF || visitSent || typeof window === "undefined") return;
  visitSent = true;
  const ref = referrerHost();
  trackUi("visit", landingOf(window.location.pathname), ref ? { ref } : null);
};
