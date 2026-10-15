/**
 * billingService — the subscription that opens editing and the Network
 * Studio (services/paidAccess), with Stripe as the payment provider.
 *
 * No SDK: the three calls the product makes (create a Checkout session,
 * create a Customer Portal session, read a subscription) go to the REST API
 * with the secret key (STRIPE_SECRET_KEY, never logged, never sent to the
 * web), and the webhook's signature is checked here, HMAC-SHA256 over
 * `<timestamp>.<raw body>` with STRIPE_WEBHOOK_SECRET, within five minutes.
 *
 * The provider is the only source of a subscription's state: the web's
 * return from Checkout (?billing=success) proves nothing and grants nothing;
 * the webhook writes `subscriptions` (accounts/store) and the next request
 * reads the effective entitlements from it (middleware/userContext). Events
 * are applied once (billing_events) and forgotten again when their handling
 * fails, so that the provider's retry applies them.
 *
 * Without the secret key, the payment links (STRIPE_CHECKOUT_URL_PRO/_TEAM)
 * are used: the account's id goes as `client_reference_id`, which the
 * webhook's checkout.session.completed carries back.
 */

"use strict";

const crypto = require("crypto");
const config = require("../../config");
const { refusal } = require("../refusal");
const store = require("../accounts/store");

const API = "https://api.stripe.com/v1";
const SIGNATURE_TOLERANCE_S = 300;
// The plans a subscription may carry: "pro", the licence, the only one sold; "team", an older offer, is still read
// from the provider's events.
const PLANS = Object.freeze(["pro", "team"]);
const SOLD = Object.freeze(["pro"]);
// The events that change a subscription; any other is acknowledged and ignored.
const SUBSCRIPTION_EVENTS = Object.freeze(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);

// The licence is billed by the year (the reference, also a quote's) or by the month (online only, no commitment).
const PERIODS = Object.freeze(["year", "month"]);
const priceOf = (plan, period = "year") => (period === "month" ? config.STRIPE_PRICE_PRO_MONTHLY : config.STRIPE_PRICE_PRO) || "";
const linkOf = (plan, period = "year") => (period === "month" ? config.STRIPE_CHECKOUT_URL_PRO_MONTHLY : config.STRIPE_CHECKOUT_URL_PRO) || "";
/** Whether the monthly billing can be bought on this server (its price with the secret key, or its link). */
const monthlyAvailable = () => Boolean(config.STRIPE_SECRET_KEY ? config.STRIPE_PRICE_PRO_MONTHLY : config.STRIPE_CHECKOUT_URL_PRO_MONTHLY);
const planOfPrice = (priceId) => {
  if (!priceId) return null;
  if (config.STRIPE_PRICE_TEAM && priceId === config.STRIPE_PRICE_TEAM) return "team";
  if (config.STRIPE_PRICE_PRO && priceId === config.STRIPE_PRICE_PRO) return "pro";
  if (config.STRIPE_PRICE_PRO_MONTHLY && priceId === config.STRIPE_PRICE_PRO_MONTHLY) return "pro";
  return null;
};
const isoOf = (seconds) => (Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : null);

/** Stripe's form encoding: nested objects and arrays as `a[b][0]=c`. */
const formEncode = (params, prefix = "", out = new URLSearchParams()) => {
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((item, i) => (item && typeof item === "object" ? formEncode(item, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(item))));
    else if (typeof value === "object") formEncode(value, name, out);
    else out.append(name, String(value));
  }
  return out;
};

// The transport, replaceable by the tests (`_setTransport`): (method, url, headers, body) → { status, json }.
let transport = async (method, url, headers, body) => {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(15000) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const stripeCall = async (method, path, params) => {
  if (!config.STRIPE_SECRET_KEY) throw refusal(503, "BILLING_UNAVAILABLE", "Payments are not configured on this server.");
  const body = method === "GET" ? undefined : formEncode(params).toString();
  const url = method === "GET" && params ? `${API}${path}?${formEncode(params).toString()}` : `${API}${path}`;
  let out;
  try {
    out = await transport(method, url, { Authorization: `Bearer ${config.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Stripe-Version": "2024-06-20" }, body);
  } catch (err) {
    throw refusal(502, "BILLING_PROVIDER_ERROR", `The payment provider did not answer (${err.name || "error"}).`);
  }
  if (out.status >= 400) {
    // The provider's message names the parameter at fault, never the key.
    const message = out.json && out.json.error && typeof out.json.error.message === "string" ? out.json.error.message.slice(0, 300) : `status ${out.status}`;
    throw refusal(502, "BILLING_PROVIDER_ERROR", `The payment provider refused the request: ${message}`);
  }
  return out.json || {};
};

/**
 * Where the provider sends the person back: BILLING_RETURN_URL, else the
 * request's own origin when the server allows it (ALLOWED_ORIGINS), else
 * nothing — an address the request alone chose is never trusted.
 */
const returnBaseOf = (req) => {
  const explicit = String(config.BILLING_RETURN_URL || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const origin = String((req && req.headers && req.headers.origin) || "").trim();
  const allowed = Array.isArray(config.ALLOWED_ORIGINS) ? config.ALLOWED_ORIGINS : [];
  if (origin && allowed.includes(origin)) return origin.replace(/\/+$/, "");
  throw refusal(503, "BILLING_UNAVAILABLE", "The return address of the payment is not configured on this server.");
};

/** The return page's address: the page the person came from (a same-origin path), with the outcome. */
const returnUrl = (base, path, outcome) => {
  const p = typeof path === "string" && /^\/[A-Za-z0-9/_\-.~%]*$/.test(path) && !path.startsWith("//") ? path : "/";
  return `${base}${p}${p.includes("?") ? "&" : "?"}billing=${outcome}`;
};

/** A Checkout session for `plan` billed by `period` ("year" | "month"), or its payment link: { url, mode }. */
const createCheckout = async (req, { plan, period = "year", returnPath } = {}) => {
  const user = req.user;
  if (!SOLD.includes(plan)) throw refusal(400, "INVALID_INPUT", `A plan is one of ${SOLD.join(", ")}.`);
  if (!PERIODS.includes(period)) throw refusal(400, "INVALID_INPUT", `A period is one of ${PERIODS.join(", ")}.`);
  const sub = user.subscription || store.subscriptionOf(user.id);
  if (store.isEntitledSubscription(sub)) throw refusal(409, "SUBSCRIPTION_ACTIVE", "This account already has a subscription: change it from the subscription management page.", { portal: Boolean(config.STRIPE_SECRET_KEY && sub.customer_id) });
  if (!config.STRIPE_SECRET_KEY) {
    const link = linkOf(plan, period);
    if (!link) throw refusal(503, "BILLING_UNAVAILABLE", period === "month" ? "The monthly billing is not configured on this server." : "Payments are not configured on this server.");
    const url = new URL(link);
    url.searchParams.set("client_reference_id", user.id);
    if (user.email) url.searchParams.set("prefilled_email", user.email);
    return { url: url.toString(), mode: "link" };
  }
  const price = priceOf(plan, period);
  if (!price) throw refusal(503, "BILLING_UNAVAILABLE", period === "month" ? "The monthly billing is not configured on this server." : `The ${plan} plan has no price configured on this server.`);
  const base = returnBaseOf(req);
  const session = await stripeCall("POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.id,
    ...(sub && sub.customer_id ? { customer: sub.customer_id } : { customer_email: user.email || undefined }),
    success_url: returnUrl(base, returnPath, "success"),
    cancel_url: returnUrl(base, returnPath, "cancel"),
    allow_promotion_codes: "true",
    locale: "auto",
    metadata: { user_id: user.id, plan, period },
    subscription_data: { metadata: { user_id: user.id, plan, period } },
  });
  if (!session.url) throw refusal(502, "BILLING_PROVIDER_ERROR", "The payment provider gave no payment page.");
  return { url: session.url, mode: "stripe" };
};

/** A Customer Portal session (change the plan, the card, cancel): { url }. */
const createPortal = async (req, { returnPath } = {}) => {
  const sub = req.user.subscription || store.subscriptionOf(req.user.id);
  if (!sub || !sub.customer_id) throw refusal(404, "SUBSCRIPTION_NOT_FOUND", "This account has no subscription to manage.");
  const base = returnBaseOf(req);
  const session = await stripeCall("POST", "/billing_portal/sessions", { customer: sub.customer_id, return_url: returnUrl(base, returnPath, "portal") });
  if (!session.url) throw refusal(502, "BILLING_PROVIDER_ERROR", "The payment provider gave no management page.");
  return { url: session.url };
};

/**
 * The webhook's signature (`Stripe-Signature: t=<s>,v1=<hex>[,v1=…]`):
 * true when one v1 is the HMAC of `<t>.<raw body>` and t is recent.
 */
const verifySignature = (rawBody, header, secret = config.STRIPE_WEBHOOK_SECRET, nowS = Math.floor(Date.now() / 1000)) => {
  if (!secret || !header || rawBody == null) return false;
  const parts = String(header).split(",").map((p) => p.trim().split("="));
  const t = Number((parts.find(([k]) => k === "t") || [])[1]);
  const signatures = parts.filter(([k, v]) => k === "v1" && /^[0-9a-f]{64}$/i.test(v || "")).map(([, v]) => v.toLowerCase());
  if (!Number.isFinite(t) || !signatures.length || Math.abs(nowS - t) > SIGNATURE_TOLERANCE_S) return false;
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), "utf8");
  const expected = crypto.createHmac("sha256", secret).update(`${t}.`).update(payload).digest();
  return signatures.some((sig) => {
    const given = Buffer.from(sig, "hex");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
};

/** What a provider's subscription object says, as `subscriptions` keeps it. */
const subscriptionPatchOf = (sub, { deleted = false } = {}) => {
  const item = sub && sub.items && Array.isArray(sub.items.data) ? sub.items.data[0] : null;
  const priceId = item && item.price ? item.price.id : null;
  const metaPlan = sub && sub.metadata && PLANS.includes(sub.metadata.plan) ? sub.metadata.plan : null;
  return {
    customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer && sub.customer.id ? sub.customer.id : undefined,
    subscription_id: sub.id || undefined,
    plan: planOfPrice(priceId) || metaPlan || undefined,
    status: deleted ? "canceled" : String(sub.status || "incomplete"),
    // The period's end sits on the subscription (older API versions) or on its item (newer ones).
    current_period_end: isoOf(sub.current_period_end || (item && item.current_period_end)),
    cancel_at_period_end: Boolean(sub.cancel_at_period_end),
  };
};

const userExists = (id) => Boolean(id && store.getUserById(id));
// A subscription belongs to one account: an event naming one another account already holds is acknowledged and set
// aside (never moved, never a 500 the provider would retry forever).
const ownedElsewhere = (subscriptionId, userId) => {
  const owner = subscriptionId ? store.userIdForBilling({ subscription_id: subscriptionId }) : null;
  return Boolean(owner && owner !== userId);
};

/** Apply one verified event: { handled, user_id? }. */
const applyEvent = async (event) => {
  const object = event && event.data && event.data.object ? event.data.object : {};
  if (event.type === "checkout.session.completed") {
    if (object.mode && object.mode !== "subscription") return { handled: false };
    const userId = object.client_reference_id || (object.metadata && object.metadata.user_id) || null;
    if (!userExists(userId)) return { handled: false, reason: "unknown_account" };
    const subscriptionId = typeof object.subscription === "string" ? object.subscription : object.subscription && object.subscription.id;
    if (ownedElsewhere(subscriptionId, userId)) return { handled: false, reason: "owned_elsewhere" };
    const customerId = typeof object.customer === "string" ? object.customer : object.customer && object.customer.id;
    // The subscription itself says its status and period; the session alone only says it was paid.
    if (subscriptionId && config.STRIPE_SECRET_KEY) {
      const sub = await stripeCall("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
      store.upsertSubscription(userId, { ...subscriptionPatchOf(sub), customer_id: customerId || subscriptionPatchOf(sub).customer_id });
    } else {
      const metaPlan = object.metadata && PLANS.includes(object.metadata.plan) ? object.metadata.plan : undefined;
      store.upsertSubscription(userId, { customer_id: customerId || undefined, subscription_id: subscriptionId || undefined, plan: metaPlan, status: object.payment_status === "paid" || object.payment_status === "no_payment_required" ? "active" : "incomplete" });
    }
    return { handled: true, user_id: userId };
  }
  if (SUBSCRIPTION_EVENTS.includes(event.type)) {
    const patch = subscriptionPatchOf(object, { deleted: event.type === "customer.subscription.deleted" });
    const metaUser = object.metadata && object.metadata.user_id;
    const userId = userExists(metaUser) ? metaUser : store.userIdForBilling({ customer_id: patch.customer_id, subscription_id: patch.subscription_id });
    if (!userExists(userId)) return { handled: false, reason: "unknown_account" };
    if (ownedElsewhere(patch.subscription_id, userId)) return { handled: false, reason: "owned_elsewhere" };
    // An older subscription's event never overwrites the account's newer one.
    const current = store.subscriptionOf(userId);
    if (current && current.subscription_id && patch.subscription_id && current.subscription_id !== patch.subscription_id && store.isEntitledSubscription(current) && event.type !== "customer.subscription.created") {
      return { handled: false, reason: "superseded" };
    }
    // A canceled subscription is final at the provider (subscribing again makes a new one): an older « updated » of the
    // same subscription delivered late or retried after its « deleted » — the provider keeps no order — never
    // reopens it (that would give the licence back until the old period's end).
    if (current && current.subscription_id && current.subscription_id === patch.subscription_id && current.status === "canceled" && patch.status !== "canceled") {
      return { handled: false, reason: "already_canceled" };
    }
    store.upsertSubscription(userId, patch);
    return { handled: true, user_id: userId };
  }
  return { handled: false, reason: "ignored_type" };
};

/** The webhook: verify, apply once, answer. Returns { status, body }. */
const handleWebhook = async (rawBody, signatureHeader) => {
  if (!config.STRIPE_WEBHOOK_SECRET) return { status: 503, body: { error: "BILLING_UNAVAILABLE", message: "The payment webhook is not configured on this server." } };
  if (!verifySignature(rawBody, signatureHeader)) return { status: 400, body: { error: "BILLING_SIGNATURE_INVALID", message: "The event's signature does not match." } };
  let event;
  try {
    event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody));
  } catch (_) {
    return { status: 400, body: { error: "INVALID_INPUT", message: "The event is not JSON." } };
  }
  if (!event || typeof event.type !== "string") return { status: 400, body: { error: "INVALID_INPUT", message: "The event has no type." } };
  if (!store.recordBillingEvent(event.id, event.type)) return { status: 200, body: { received: true, duplicate: true } };
  try {
    const out = await applyEvent(event);
    return { status: 200, body: { received: true, handled: out.handled } };
  } catch (err) {
    store.forgetBillingEvent(event.id);
    throw err;
  }
};

module.exports = {
  createCheckout,
  createPortal,
  handleWebhook,
  verifySignature,
  monthlyAvailable,
  PERIODS,
  _internals: { formEncode, subscriptionPatchOf, applyEvent, returnBaseOf, returnUrl, planOfPrice, _setTransport: (fn) => { transport = fn; } },
};
