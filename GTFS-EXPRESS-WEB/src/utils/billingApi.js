/**
 * The web never handles a payment: it goes to the provider's page the server names, the provider brings the person
 * back with ?billing=success | cancel | portal, and only the server's webhook opens the paid features.
 */

import { apiUrl, post, request } from "./apiRequest";

export const BILLING_PARAM = "billing";

// Replaceable by the tests: jsdom does not navigate.
let navigateTo = (url) => window.location.assign(url);
export const _setNavigate = (fn) => {
  navigateTo = fn;
};

const returnPath = () => {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(BILLING_PARAM);
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
};

/** Only ever https, or http on this machine in development. */
const safeUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) return url.toString();
  } catch {
    /* not an URL */
  }
  return null;
};

export const startCheckout = async (plan, { go = navigateTo, period = "year" } = {}) => {
  const out = await post("/billing/checkout", { plan, period, return_path: returnPath() });
  const url = safeUrl(out?.url);
  if (!url) throw Object.assign(new Error("No payment page."), { code: "BILLING_PROVIDER_ERROR" });
  go(url);
  return url;
};

export const openPortal = async ({ go = navigateTo } = {}) => {
  const out = await post("/billing/portal", { return_path: returnPath() });
  const url = safeUrl(out?.url);
  if (!url) throw Object.assign(new Error("No management page."), { code: "BILLING_PROVIDER_ERROR" });
  go(url);
  return url;
};

/** `profile`: { name, organisation, role, network?, phone? }; `language`: that of the trial's e-mails. */
export const startTrial = async (profile = {}, language = null) => {
  const out = await post("/billing/trial", { ...profile, ...(language ? { language } : {}) });
  return out?.user || null;
};

/** `form`: { organisation, name, email, phone?, seats?, message? }. */
export const requestQuote = async (form) => post("/billing/quote", form);

export const fetchSubscription = async () => {
  try {
    const res = await request(apiUrl("/billing/subscription"), { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

export const billingReturnOf = (search = typeof window !== "undefined" ? window.location.search : "") => {
  const value = new URLSearchParams(search || "").get(BILLING_PARAM);
  return ["success", "cancel", "portal"].includes(value) ? value : null;
};

/** replaceState, so Back never replays a return. */
export const clearBillingReturn = () => {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(BILLING_PARAM)) return;
    url.searchParams.delete(BILLING_PARAM);
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* no history */
  }
};
