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

// The application reached from one of the content pages (a guide, a rule of the catalogue) lands as that page.
const contentPageOf = () => {
  try {
    if (!document.referrer) return null;
    const from = new URL(document.referrer);
    if (from.hostname !== window.location.hostname) return null;
    if (/^\/(en\/)?guides\//.test(from.pathname)) return "guide";
    if (/^\/(regles|en\/rules)\/./.test(from.pathname)) return "rule";
    return null;
  } catch {
    return null;
  }
};

const landingOf = (pathname) => {
  const content = contentPageOf();
  if (content) return content;
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

/** The window's width as a class, never its size: a size singles a browser out more than the figures need. */
export const screenClassOf = (width, touch = false) => {
  if (touch && width < 600) return "phone";
  if (touch && width < 1024) return "tablet";
  if (width < 1280) return "1024";
  if (width < 1440) return "1280";
  if (width < 1920) return "1440";
  return "1920";
};

let visitSent = false;

// Nothing is stored in the browser: the server keeps one visit per visitor and day, with the interface's language,
// the window's class and the theme.
export const trackVisit = ({ language = null, theme = null } = {}) => {
  if (OFF || visitSent || typeof window === "undefined") return;
  visitSent = true;
  const ref = referrerHost();
  const touch = typeof window.matchMedia === "function" && window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  trackUi("visit", landingOf(window.location.pathname), { ...(ref ? { ref } : {}), ...(language ? { lang: language } : {}), screen: screenClassOf(window.innerWidth, touch), ...(theme ? { theme } : {}) });
};
