/**
 * GET /gtfs/config/plans: the offer's two plans, « free » (reading) and « pro » (the licence, every modification).
 * The prices are indicative: the payment provider's price is what is charged. Without the paid offer everyone holds « pro ».
 */

"use strict";

const config = require("../config");


const readerCompanion = () => Boolean(config.PAID_ACCESS_ENABLED && config.ACCOUNTS_ENABLED && config.READER_AI_QUESTIONS_MONTH > 0);

const catalogue = () => [
  {
    id: "free",
    price_eur: 0,
    period: "year",
    limits: { ai_messages: config.NL2SQL_FREE_MESSAGES_PER_SESSION, seats: 1, reader_questions_month: readerCompanion() ? config.READER_AI_QUESTIONS_MONTH : 0 },
    features: ["explore", "validate", "diagnostic", "compare", "share", "coherence", "public_feeds", ...(readerCompanion() ? ["reader_assistant"] : [])],
    checkout_url: null,
  },
  {
    id: "pro",
    price_eur: config.LICENCE_PRICE_EUR_YEAR,
    period: "year",
    // `monthly`: whether the monthly licence, sold online only, can be bought here.
    price_eur_month: config.LICENCE_PRICE_EUR_MONTH,
    monthly: isPaid() && require("./billing/billingService").monthlyAvailable(),
    limits: { ai_messages: config.BETA_NL2SQL_DAILY_LIMIT_PER_CODE, seats: 1 },
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

const resolvePaidPlan = (req) => {
  const user = config.ACCOUNTS_ENABLED && req.user ? req.user : null;
  if (!user) return { name: "free", source: "anonymous", tier: null };
  const licence = user.licence || require("./accounts/store").licenceOf(user, user.subscription);
  if (!licence.active) return { name: "free", source: "account", tier: null };
  return { name: "pro", source: licence.source === "admin" || licence.source === "tester" ? "granted" : licence.source, tier: null, until: licence.until, label: user.display_name || null, ...(user.subscription ? { status: user.subscription.status } : {}) };
};

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
    // Lazy: accessService requires this module.
    request_access_url: require("./accessService").requestAccessUrl(),
    billing_enabled: isPaid() ? checkoutMode() !== "contact" : Boolean(config.STRIPE_CHECKOUT_URL_PRO),
    model: isPaid() ? "paid" : "open",
    checkout: checkoutMode(),
    subscription: req.user && req.user.subscription ? require("./accounts/store").subscriptionSummary(req.user.subscription) : null,
    licence: req.user ? req.user.licence || null : null,
    trial_days: config.TRIAL_DAYS,
    quote: Boolean(String(config.PLAN_CONTACT_EMAIL || config.SUPPORT_EMAIL || "").includes("@") && require("./mail/mailer").isAvailable()),
  });
};

module.exports = { getPlans, resolvePlan, limitsFor, catalogue, checkoutMode };
