/**
 * plansService — the offer.
 *
 *   GET /gtfs/config/plans   → { current, plans, licence, trial_days, quote, … }
 *
 * The paid offer (PAID_ACCESS_ENABLED, services/paidAccess): two plans —
 * « free » is reading (explore, validate, the Diagnostic, compare, share, the coherence report, the public
 * feeds), « pro » is the licence: every modification (edit mode, the SQL console's writes, the assistant's fixes,
 * the Change Studio, the delivered GTFS), yearly at LICENCE_PRICE_EUR_YEAR (or by the month,
 * LICENCE_PRICE_EUR_MONTH) excluding VAT (indicative: the payment provider's price is what is charged). An account holds it from its licence (accounts/store
 * .licenceOf): a subscription, the administrator's grant, the free trial or the operator's own address. Three
 * ways to it, as the web offers them: the free trial (POST /billing/trial), paying online (`checkout`: "stripe",
 * "link" or "contact") and a quote (`quote`: POST /billing/quote).
 *
 * The open model (PAID_ACCESS_ENABLED off: the lab, development): everything is open, everyone holds the licence's plan.
 *
 * `resolvePlan(req)` is what the gated features consult (network line cap).
 */

"use strict";

const config = require("../config");
const { LIMITS } = require("./network/networkSpec");


const readerCompanion = () => Boolean(config.PAID_ACCESS_ENABLED && config.ACCOUNTS_ENABLED && config.READER_AI_QUESTIONS_MONTH > 0);

// One offer whatever the model: reading is free, the licence is every modification. The open model (no paid offer)
// sells nothing and gives everyone the licence's plan.
const catalogue = () => [
  {
    id: "free",
    price_eur: 0,
    period: "year",
    limits: { network_lines: null, ai_messages: config.NL2SQL_FREE_MESSAGES_PER_SESSION, seats: 1, reader_questions_month: readerCompanion() ? config.READER_AI_QUESTIONS_MONTH : 0 },
    // The reading companion (an account's free questions a month to the reader's assistant) where it is on.
    features: ["explore", "validate", "diagnostic", "compare", "share", "coherence", "public_feeds", ...(readerCompanion() ? ["reader_assistant"] : [])],
    checkout_url: null,
  },
  {
    id: "pro",
    price_eur: config.LICENCE_PRICE_EUR_YEAR,
    period: "year",
    // The same licence by the month, without commitment, online only (`monthly`: whether it can be bought here).
    price_eur_month: config.LICENCE_PRICE_EUR_MONTH,
    monthly: isPaid() && require("./billing/billingService").monthlyAvailable(),
    limits: { network_lines: LIMITS.lines, ai_messages: config.BETA_NL2SQL_DAILY_LIMIT_PER_CODE, seats: 1 },
    features: ["everything_free", "edit", "sql_write", "assistant", "change_studio", "export_gtfs", "canonical_delivery", "priority_support"],
    checkout_url: config.STRIPE_CHECKOUT_URL_PRO || null,
  },
];

const isPaid = () => Boolean(config.PAID_ACCESS_ENABLED);

/** How the web subscribes: "stripe" (server-side Checkout), "link" (payment links) or "contact". */
const checkoutMode = () => {
  if (config.STRIPE_SECRET_KEY && config.STRIPE_PRICE_PRO) return "stripe";
  if (config.STRIPE_CHECKOUT_URL_PRO) return "link";
  return "contact";
};

/** Under the paid offer: the account's licence (accounts/store.licenceOf) is the licence plan, else Free. */
const resolvePaidPlan = (req) => {
  const user = config.ACCOUNTS_ENABLED && req.user ? req.user : null;
  if (!user) return { name: "free", source: "anonymous", tier: null };
  const licence = user.licence || require("./accounts/store").licenceOf(user, user.subscription);
  if (!licence.active) return { name: "free", source: "account", tier: null };
  return { name: "pro", source: licence.source === "admin" ? "granted" : licence.source, tier: null, until: licence.until, label: user.display_name || null, ...(user.subscription ? { status: user.subscription.status } : {}) };
};

/** The plan a request is entitled to: the licence under the paid offer; everything in the open model. */
const resolvePlan = (req) => {
  if (isPaid()) return resolvePaidPlan(req);
  return { name: "pro", source: "open", tier: null };
};

const limitsFor = (planName) => (catalogue().find((p) => p.id === planName) || catalogue()[0]).limits;

const getPlans = (req, res) => {
  const current = resolvePlan(req);
  res.json({
    current: { ...current, limits: limitsFor(current.name) },
    plans: catalogue(),
    contact_email: config.SUPPORT_EMAIL || config.PLAN_CONTACT_EMAIL || null,
    // The same address as a link the web may open (mailto: or https: only;
    // accessService requires this module, hence the lazy require).
    request_access_url: require("./accessService").requestAccessUrl(),
    billing_enabled: isPaid() ? checkoutMode() !== "contact" : Boolean(config.STRIPE_CHECKOUT_URL_PRO),
    model: isPaid() ? "paid" : "open",
    checkout: checkoutMode(),
    // The account's subscription as the account dialog shows it (accounts/store.subscriptionSummary).
    subscription: req.user && req.user.subscription ? require("./accounts/store").subscriptionSummary(req.user.subscription) : null,
    // The licence the account holds, and the two other ways to it: the free trial and a quote.
    licence: req.user ? req.user.licence || null : null,
    trial_days: config.TRIAL_DAYS,
    quote: Boolean(String(config.PLAN_CONTACT_EMAIL || config.SUPPORT_EMAIL || "").includes("@") && require("./mail/mailer").isAvailable()),
  });
};

module.exports = { getPlans, resolvePlan, limitsFor, catalogue, checkoutMode };
