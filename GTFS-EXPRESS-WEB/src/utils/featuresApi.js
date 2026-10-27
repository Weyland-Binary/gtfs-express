/**
 * GET /config/features, fetched once and cached in module memory. The defaults, before the answer or after a
 * failure, turn everything off so no button shows that would fail on click. `access` depends on the account:
 * `refreshFeatures()` after a sign-in or a licence started re-renders every mounted `useFeatures()`.
 */

import { useEffect, useState } from "react";
import API_BASE_URL from "../config";
import { requestJson } from "./apiRequest";
import { PAYWALL_EVENT, PRICING_EVENT } from "./appEvents";

export const DEFAULT_FEATURES = Object.freeze({
  // The signed-in state as the server saw it at boot; AccountContext is the live source.
  accounts: { enabled: false, signedIn: false, entitlements: [] },
  nl2sql: { enabled: false, model: null },
  chat: { enabled: false, model: null },
  // Null until the server answers, so nothing is announced that the server did not say.
  access: null,
  // From the server's configuration only: never an address written in the web.
  request_access_url: null,
});

const REQUEST_ACCESS_SCHEMES = /^(mailto:|https:)/i;

/**
 * Only ever a `mailto:` or `https:` URL, checked here too. A `mailto:` without a query of its own gets `subject`
 * and `body` appended so a dialog can pre-fill the request.
 */
export const requestAccessLink = (url, { subject = null, body = null } = {}) => {
  const value = typeof url === "string" ? url.trim() : "";
  if (!value || !REQUEST_ACCESS_SCHEMES.test(value)) return null;
  if (!/^mailto:/i.test(value) || value.includes("?")) return value;
  const params = [];
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`);
  if (body) params.push(`body=${encodeURIComponent(body)}`);
  return params.length ? `${value}?${params.join("&")}` : value;
};

export const requestAccessAddress = (url) => {
  const link = requestAccessLink(url);
  if (!link) return null;
  const m = /^mailto:([^?]+)/i.exec(link);
  return m ? decodeURIComponent(m[1]) : link.replace(/^https:\/\//i, "");
};

let cachedFeatures = null;
let inflight = null;
const listeners = new Set();

const mergeFeatures = (body) => ({
  ...DEFAULT_FEATURES,
  ...body,
  accounts: { ...DEFAULT_FEATURES.accounts, ...(body?.accounts || {}) },
  nl2sql: { ...DEFAULT_FEATURES.nl2sql, ...(body?.nl2sql || {}) },
  chat: { ...DEFAULT_FEATURES.chat, ...(body?.chat || {}) },
  access: body?.access && typeof body.access === "object" ? { ...body.access, request_access_url: requestAccessLink(body.access.request_access_url) } : null,
  request_access_url: requestAccessLink(body?.request_access_url),
});

export const fetchFeatures = () => {
  if (cachedFeatures) return Promise.resolve(cachedFeatures);
  if (inflight) return inflight;
  inflight = requestJson(`${API_BASE_URL}/config/features`)
    .then((body) => {
      cachedFeatures = mergeFeatures(body);
      return cachedFeatures;
    })
    .catch((err) => {
      console.warn("features fetch failed, using defaults:", err);
      cachedFeatures = { ...DEFAULT_FEATURES };
      return cachedFeatures;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
};

export const refreshFeatures = async () => {
  cachedFeatures = null;
  const f = await fetchFeatures();
  for (const fn of listeners) fn(f);
  return f;
};

/** `features` is never null; `loaded` turns true once the request settles, failed or not. */
export const useFeatures = () => {
  const [state, setState] = useState(() => ({
    features: cachedFeatures || DEFAULT_FEATURES,
    loaded: Boolean(cachedFeatures),
  }));

  useEffect(() => {
    let cancelled = false;
    const listener = (f) => {
      if (!cancelled) setState({ features: f, loaded: true });
    };
    listeners.add(listener);
    if (cachedFeatures) setState({ features: cachedFeatures, loaded: true });
    else fetchFeatures().then(listener);
    return () => {
      cancelled = true;
      listeners.delete(listener);
    };
  }, []);

  return state;
};

// ── The access object in words

export const openPricing = (reason, { way = null } = {}) => window.dispatchEvent(new CustomEvent(PRICING_EVENT, { detail: { reason, ...(way ? { way } : {}) } }));

export const isPaidModel = (access) => access?.model === "paid";

/**
 * One licence covers every modification, so `edit` alone says the lock: null when held or under the open model,
 * else "sign_in_required" | "subscription_required" | "unavailable".
 */
export const licenceLockOf = (access) => {
  if (!isPaidModel(access)) return null;
  const state = access.edit;
  return state === "ok" ? null : state || "subscription_required";
};

/** `resume`: the act asked, carried out by the app once the licence runs (a trial started or a licence bought). */
export const openPaywall = (entitlement = "studio", state = null, resume = null) =>
  window.dispatchEvent(new CustomEvent(PAYWALL_EVENT, { detail: { entitlement, state, explicit: true, ...(typeof resume === "function" ? { resume } : {}) } }));

export const studioState = (studio) => (studio && typeof studio === "object" ? "trial" : studio || "unavailable");

/** The assistant's lock for LockedAction: null when served, else the reason and the one action that lifts it. */
export const studioLockOf = (access, t, { signIn = null, requestUrl = null } = {}) => {
  const paid = licenceLockOf(access);
  if (paid === "sign_in_required" || paid === "subscription_required") return { reason: t("paywall.lock.studio"), action: { label: t("paywall.cta.seePlans"), onClick: () => openPaywall("studio", paid) } };
  if (paid === "unavailable") return { reason: t("access.studio.unavailable"), action: null };
  const s = studioState(access?.studio);
  if (!access || s === "ok" || s === "trial") return null;
  if (s === "unavailable") return { reason: t("access.studio.unavailable"), action: null };
  if (s === "entitlement_required" && signIn) return { reason: t("access.studio.entitlement"), action: { label: t("status.user.signIn"), onClick: signIn } };
  const link = requestAccessLink(requestUrl);
  if (s === "entitlement_required" && link) return { reason: t("access.studio.entitlement"), action: { label: t("access.request"), href: link } };
  return { reason: s === "paid" ? t("access.studio.paid") : t("access.studio.entitlement"), action: { label: t("access.seeOffers"), onClick: () => openPricing("studio") } };
};
