/**
 * featuresApi — Cache + fetch helper for GET /gtfs/config/features.
 *
 * The features endpoint is intentionally light: a single GET that returns
 * server-side flags (the assistants and their model, accounts, the Network
 * Studio, the access object). We hit it once
 * at boot, cache the response in module memory, and reuse it across all
 * consumers. The `useFeatures()` hook below returns a `{features, loaded}`
 * tuple so consumers can render a skeleton during the (very brief) load.
 *
 * Defaults — when the request fails or before it lands — are conservative
 * (everything OFF). This guarantees the UI never flickers a button that
 * would 503 on click.
 *
 * The `access` object depends on who asks (the account): after a sign-in or
 * a licence started, `refreshFeatures()` asks again and every mounted
 * `useFeatures()` re-renders with the new answer, so the locks never keep
 * saying "licence required" once it runs.
 *
 * The paid offer (`access.model === "paid"`, PAID_ACCESS_ENABLED on the
 * API): reading is free; every modification needs the licence (a
 * subscription, a quote the operator granted, the free trial).
 * `licenceLockOf(access)` says what stands in the way
 * ("sign_in_required" | "subscription_required" | "unavailable", or null),
 * `openPaywall()` opens the offer (PaywallHost), and the hints and locks
 * below speak of the subscription instead of codes and trials.
 */

import { useEffect, useState } from "react";
import API_BASE_URL from "../config";
import { fetchWithSession, PAYWALL_EVENT } from "./sessionManager";

export const DEFAULT_FEATURES = Object.freeze({
  // User accounts (ACCOUNTS_ENABLED on the API) and the signed-in state as
  // the server saw it at boot; the AccountContext is the live source.
  accounts: { enabled: false, signedIn: false, entitlements: [] },
  nl2sql: { enabled: false, model: null },
  chat: { enabled: false, model: null },
  // The Network Studio (designing a network): off unless the server offers it.
  network_studio: { enabled: false },
  // The access gates in one server-computed object (read, edit, studio,
  // size, validator, provider, retention) — null until the server answers,
  // so nothing is announced that the server did not say.
  access: null,
  // Where a person asks for an access: a `mailto:` or `https:` URL from the
  // server's configuration, or null when none is set. Never an address
  // written in the web.
  request_access_url: null,
});

const REQUEST_ACCESS_SCHEMES = /^(mailto:|https:)/i;

/**
 * The "request an access" link, checked on this side too: a `mailto:`
 * or `https:` URL, or null. For a `mailto:`, `subject` and `body` are
 * appended when the address carries no query of its own, so a dialog can
 * pre-fill the request; an `https:` form is opened as it is.
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

/** The address behind a `mailto:` link, for display; null for anything else. */
export const requestAccessAddress = (url) => {
  const link = requestAccessLink(url);
  if (!link) return null;
  const m = /^mailto:([^?]+)/i.exec(link);
  return m ? decodeURIComponent(m[1]) : link.replace(/^https:\/\//i, "");
};

let cachedFeatures = null;
let inflight = null;
// The mounted useFeatures() hooks, told when refreshFeatures() brings a new answer.
const listeners = new Set();

const mergeFeatures = (body) => ({
  ...DEFAULT_FEATURES,
  ...body,
  accounts: { ...DEFAULT_FEATURES.accounts, ...(body?.accounts || {}) },
  nl2sql: { ...DEFAULT_FEATURES.nl2sql, ...(body?.nl2sql || {}) },
  chat: { ...DEFAULT_FEATURES.chat, ...(body?.chat || {}) },
  // Checked here as well as on the server: a link is only ever mailto: or https:.
  access: body?.access && typeof body.access === "object" ? { ...body.access, request_access_url: requestAccessLink(body.access.request_access_url) } : null,
  request_access_url: requestAccessLink(body?.request_access_url),
});

/**
 * Fetch features from the API. Memoizes both the result and the in-flight
 * promise (so concurrent callers don't fan out).
 */
export const fetchFeatures = () => {
  if (cachedFeatures) return Promise.resolve(cachedFeatures);
  if (inflight) return inflight;
  inflight = fetchWithSession(`${API_BASE_URL}/config/features`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`features fetch ${res.status}`);
      const body = await res.json();
      // Defensive merge — if the server adds new flags later, missing
      // ones still default to false instead of undefined.
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

/** Ask the server again (the access changed: a sign-in, a licence started) and tell every mounted hook. */
export const refreshFeatures = async () => {
  cachedFeatures = null;
  const f = await fetchFeatures();
  for (const fn of listeners) fn(f);
  return f;
};

/**
 * React hook — fetch on mount, return `{features, loaded}`.
 * `features` is always non-null (defaults until the request lands).
 * `loaded` flips to true once the request resolves (success OR failure —
 * either way we have the canonical values cached).
 */
export const useFeatures = () => {
  const [state, setState] = useState(() => ({
    features: cachedFeatures || DEFAULT_FEATURES,
    loaded: Boolean(cachedFeatures),
  }));

  useEffect(() => {
    // Loaded earlier in this session: synced at once; either way the hook hears later refreshes.
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

// ── The access object in words ──────────────────────────────────────────────

const PRICING_EVENT = "gtfs:open-pricing";
/** Open the plans (PricingDialog listens), with the reason that led there. */
export const openPricing = (reason) => window.dispatchEvent(new CustomEvent(PRICING_EVENT, { detail: { reason } }));

/** Whether this server offers the Network Studio (NETWORK_STUDIO_ENABLED on the API). */
export const networkStudioOn = (features) => features?.network_studio?.enabled === true;

/** Whether the server sells editing and the studio (access.model, PAID_ACCESS_ENABLED). */
export const isPaidModel = (access) => access?.model === "paid";

/**
 * Under the paid offer, what stands between the person and the licence (one licence: editing, the change, the
 * assistant and the delivery come together, so the server's `edit` and `studio_access` agree): null when they hold
 * it (or under the open model, where there is no lock), else "sign_in_required" | "subscription_required" |
 * "unavailable".
 */
export const licenceLockOf = (access) => {
  if (!isPaidModel(access)) return null;
  const state = access.edit;
  return state === "ok" ? null : state || "subscription_required";
};

/**
 * Open the offer (PaywallHost listens): what was asked, what stood in the way, and `resume`, the act asked, which
 * the app carries out by itself once the licence runs (a trial started or a licence bought in the offer).
 */
export const openPaywall = (entitlement = "studio", state = null, resume = null) =>
  window.dispatchEvent(new CustomEvent(PAYWALL_EVENT, { detail: { entitlement, state, explicit: true, ...(typeof resume === "function" ? { resume } : {}) } }));

/** access.studio → "ok" | "trial" | "paid" | "entitlement_required" | "sign_in_required" | "subscription_required" | "unavailable". */
export const studioState = (studio) => (studio && typeof studio === "object" ? "trial" : studio || "unavailable");

/**
 * The assistant's lock, for LockedAction: null when the assistant is
 * served (included, or trial messages left); else the reason and the one
 * action that lifts it — sign in, request an access, see the plans. The
 * journey itself is never locked by it: steps 2 and 3 are done by hand.
 */
export const studioLockOf = (access, t, { signIn = null, requestUrl = null } = {}) => {
  // The paid offer: the studio itself is closed until the subscription; its one action opens the offer.
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
