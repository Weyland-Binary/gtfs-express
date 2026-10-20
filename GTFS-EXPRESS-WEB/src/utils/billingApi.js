/**
 * billingApi — the subscription that opens editing and the Network Studio
 * (the API's services/billing). The web never handles a payment: it asks the
 * server for the provider's page (Checkout, or the payment link; the
 * management portal) and goes there; the provider brings the person back
 * with ?billing=success | cancel | portal (BillingReturn), and only the
 * server's webhook opens the paid features.
 *
 *   startCheckout(plan)   POST /billing/checkout → goes to the payment page
 *   openPortal()          POST /billing/portal   → goes to the management page
 *   startTrial(profile, language)  POST /billing/trial → the account, its licence running for the trial's days
 *                         (`profile`: { name, organisation, role, network?, phone? }, who tries it; `language`: the
 *                         trial's e-mails')
 *   requestQuote(form)    POST /billing/quote    → { sent }: the request mailed to the operator
 *   fetchSubscription()   GET  /billing/subscription
 *   BILLING_PARAM         the return's query parameter
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";
import { readRefusal } from "./refusalToAction";

export const BILLING_PARAM = "billing";

// Leaving for the provider's page (replaceable by the tests: jsdom does not navigate).
let navigateTo = (url) => window.location.assign(url);
export const _setNavigate = (fn) => {
  navigateTo = fn;
};

// The page to come back to: where the person is, without a previous return's parameter.
const returnPath = () => {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete(BILLING_PARAM);
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
};

const post = async (path, body) => {
  const res = await fetchWithSession(`${API_BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw await readRefusal(res);
  return res.json();
};

/** The provider's address for an URL the server gave: only ever https (or http on this machine, in development). */
const safeUrl = (value) => {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) return url.toString();
  } catch {
    /* not an URL */
  }
  return null;
};

/** Leave for the payment page of the licence (`plan` "pro"). Rejects with the server's refusal. */
export const startCheckout = async (plan, { go = navigateTo, period = "year" } = {}) => {
  const out = await post("/billing/checkout", { plan, period, return_path: returnPath() });
  const url = safeUrl(out?.url);
  if (!url) throw Object.assign(new Error("No payment page."), { code: "BILLING_PROVIDER_ERROR" });
  go(url);
  return url;
};

/** Leave for the subscription's management page (the provider's portal). */
export const openPortal = async ({ go = navigateTo } = {}) => {
  const out = await post("/billing/portal", { return_path: returnPath() });
  const url = safeUrl(out?.url);
  if (!url) throw Object.assign(new Error("No management page."), { code: "BILLING_PROVIDER_ERROR" });
  go(url);
  return url;
};

/** Start the free trial of the licence (once per address): the account as the server now says it. */
export const startTrial = async (profile = {}, language = null) => {
  const out = await post("/billing/trial", { ...profile, ...(language ? { language } : {}) });
  return out?.user || null;
};

/** Ask the operator for a quote: { organisation, name, email, phone?, seats?, message? } → { sent }. */
export const requestQuote = async (form) => post("/billing/quote", form);

/** { subscription, entitlements, plan } of the signed-in account, or null. */
export const fetchSubscription = async () => {
  try {
    const res = await fetchWithSession(`${API_BASE_URL}/billing/subscription`, { cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};

/** The return from the provider in the address (?billing=…): "success" | "cancel" | "portal" | null. */
export const billingReturnOf = (search = typeof window !== "undefined" ? window.location.search : "") => {
  const value = new URLSearchParams(search || "").get(BILLING_PARAM);
  return ["success", "cancel", "portal"].includes(value) ? value : null;
};

/** The address without the return's parameter (history.replaceState: Back never replays a return). */
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
