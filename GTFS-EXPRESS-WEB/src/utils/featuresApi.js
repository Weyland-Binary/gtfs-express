/**
 * featuresApi — Cache + fetch helper for GET /gtfs/config/features.
 *
 * The features endpoint is intentionally light: a single GET that returns
 * server-side flags (NL2SQL kill-switch + model name today). We hit it once
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
 * `paidLockOf(access, "edit" | "studio")` says what stands in the way
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
  // The four gates in one server-computed object (§7.1: read, edit, studio,
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
 * The "request an access" link, checked on this side too (D39): a `mailto:`
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

/** Ask the server again (the access changed: a code used, a sign-in) and tell every mounted hook. */
export const refreshFeatures = async () => {
  cachedFeatures = null;
  const f = await fetchFeatures();
  for (const fn of listeners) fn(f);
  return f;
};

/**
 * Synchronous accessor — returns the cached value or `null` if not yet
 * loaded. Used by code paths that already check `loaded` (e.g. button
 * gating in the parent component) and don't want a re-render loop.
 */
export const getCachedFeatures = () => cachedFeatures;

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

// ── The access object in words (target design §7.1) ─────────────────────────

const PRICING_EVENT = "gtfs:open-pricing";
/** Open the plans (PricingDialog listens), with the reason that led there. */
export const openPricing = (reason) => window.dispatchEvent(new CustomEvent(PRICING_EVENT, { detail: { reason } }));

/** Whether the server sells editing and the studio (access.model, PAID_ACCESS_ENABLED). */
export const isPaidModel = (access) => access?.model === "paid";

/**
 * Under the paid offer, what stands between the person and "edit" or "studio":
 * null when they hold it (or under the open model, where these locks do not
 * exist), else "sign_in_required" | "subscription_required" | "unavailable".
 */
export const paidLockOf = (access, entitlement) => {
  if (!isPaidModel(access)) return null;
  const state = entitlement === "edit" ? access.edit : access.studio_access;
  return state === "ok" ? null : state || "subscription_required";
};

/** Open the offer for a paid feature (PaywallHost listens): what was asked, and what stood in the way. */
export const openPaywall = (entitlement = "studio", state = null) => window.dispatchEvent(new CustomEvent(PAYWALL_EVENT, { detail: { entitlement, state, explicit: true } }));

/** access.studio → "ok" | "trial" | "paid" | "entitlement_required" | "sign_in_required" | "subscription_required" | "unavailable". */
export const studioState = (studio) => (studio && typeof studio === "object" ? "trial" : studio || "unavailable");

/** The assistant's state in words. */
export const studioText = (access, t) => {
  const s = studioState(access?.studio);
  if (s === "ok") return t("access.studio.ok", { plan: access?.size?.plan || "" });
  if (s === "trial") return t("access.studio.trial", { count: access.studio.trial_left ?? 0 });
  if (s === "paid") return t("access.studio.paid");
  if (s === "entitlement_required") return t("access.studio.entitlement");
  if (s === "sign_in_required" || s === "subscription_required") return t("paywall.lock.studio");
  return t("access.studio.unavailable");
};

/**
 * The one-line gate of a journey card (`gate-hint`), read from `access`
 * (never guessed): reading free; for "create" the free size, the assistant
 * and a free delivery; for "modify" the assistant (or by hand) and what
 * applying needs; nothing can be delivered where the validator is missing.
 * Without the object (not loaded, an older server): the static line.
 */
export const gateHint = (kind, access, t) => {
  if (!access) return t(`home.gate.${kind}`, { max: "—", count: "—" });
  if (kind === "explore") return t("access.hint.read");
  if (isPaidModel(access)) {
    // The paid offer: the journey itself is the subscription's; once held, what it includes.
    if (paidLockOf(access, "studio")) return t("paywall.hint.locked");
    const deliverPaid = access.validator === "unavailable" ? t("access.hint.validatorOff") : t("paywall.hint.deliver");
    return [t("paywall.hint.included"), access.studio === "ok" ? t("access.hint.assistantOk") : t("access.hint.assistantOff"), deliverPaid].join(" · ");
  }
  const s = studioState(access.studio);
  const assistant = s === "ok" ? t("access.hint.assistantOk") : s === "trial" ? t("access.hint.assistantTrial", { count: access.studio.trial_left ?? 0 }) : s === "unavailable" ? t("access.hint.assistantOff") : t("access.hint.assistantPaid");
  const deliver = access.validator === "unavailable" ? t("access.hint.validatorOff") : null;
  const parts =
    kind === "create"
      ? [access.size?.max_lines ? t("access.hint.size", { max: access.size.max_lines }) : t("access.hint.read"), assistant, deliver || t("access.hint.deliverFree")]
      : [t("access.hint.read"), assistant, deliver || (access.edit === "ok" ? t("access.hint.applyOk") : t("access.hint.applyCode"))];
  return parts.join(" · ");
};

/**
 * The assistant's lock (D30), for LockedAction: null when the assistant is
 * served (included, or trial messages left); else the reason and the one
 * action that lifts it — sign in, request an access, see the plans. The
 * journey itself is never locked by it: steps 2 and 3 are done by hand.
 */
export const studioLockOf = (access, t, { signIn = null, requestUrl = null } = {}) => {
  // The paid offer: the studio itself is closed until the subscription; its one action opens the offer.
  const paid = paidLockOf(access, "studio");
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
