/**
 * The gates in one object, served by GET /config/features as `access`: the server states what each route will answer,
 * so the web never works out a person's entitlements on its own. Under PAID_ACCESS_ENABLED it adds the paid states
 * ("ok" | "sign_in_required" | "subscription_required" | "unavailable"), the licence and the ways to buy one.
 */

"use strict";

const config = require("../config");
const plansService = require("./plansService");

const ALLOWED_SCHEMES = /^(mailto:|https:)/i;

/** The operator's "request an access" URL: mailto: or https: only, so the web can put it in a link; else null. */
const requestAccessUrl = () => {
  const explicit = String(config.REQUEST_ACCESS_URL || "").trim();
  if (explicit) return ALLOWED_SCHEMES.test(explicit) ? explicit : null;
  const email = String(config.SUPPORT_EMAIL || "").trim();
  if (!email || email.includes("/") || !email.includes("@")) return null;
  return `mailto:${email}`;
};

/** The assistant in the open model: with accounts, studioGate first wants the "studio" entitlement. */
const studioOf = (req) => {
  if (!config.NL2SQL_CHAT_ENABLED || !config.LLM_CONFIGURED) return "unavailable";
  if (config.ACCOUNTS_ENABLED) {
    const entitlements = req.user && Array.isArray(req.user.entitlements) ? req.user.entitlements : [];
    if (!entitlements.includes("studio")) return "entitlement_required";
  }
  return "ok";
};

const paidAccessOf = (req) => {
  const paid = require("./paidAccess");
  const studioAccess = paid.paidStateOf(req, "studio");
  const assistant = config.NL2SQL_CHAT_ENABLED && config.LLM_CONFIGURED ? "ok" : "unavailable";
  const sub = req.user && req.user.subscription ? require("./accounts/store").subscriptionSummary(req.user.subscription) : null;
  return {
    edit: paid.paidStateOf(req, "edit"),
    // "trial": the modified network cannot leave (export, delivery, share) while the licence is the free trial.
    deliver: require("./trialWork").isTrial(req) ? "trial" : paid.paidStateOf(req, "edit"),
    studio_access: studioAccess,
    studio: studioAccess === "ok" ? assistant : studioAccess,
    licence: req.user && req.user.licence ? licenceSummaryOf(req.user.licence) : null,
    billing: {
      checkout: plansService.checkoutMode(),
      portal: Boolean(config.STRIPE_SECRET_KEY),
      subscription: sub,
      trial_days: config.TRIAL_DAYS,
      quote: Boolean(String(config.PLAN_CONTACT_EMAIL || config.SUPPORT_EMAIL || "").includes("@") && require("./mail/mailer").isAvailable()),
      price_eur_year: config.LICENCE_PRICE_EUR_YEAR,
      price_eur_month: config.LICENCE_PRICE_EUR_MONTH,
      monthly: require("./billing/billingService").monthlyAvailable(),
    },
  };
};

/** No entitlement list: `edit` and `studio_access` already say it. */
const licenceSummaryOf = (l) => ({ active: Boolean(l.active), source: l.source || null, until: l.until || null, unlimited: Boolean(l.unlimited), trial_available: Boolean(l.trial_available), trial_until: l.trial_until || null });

const validatorOf = () => (require("./canonicalValidatorService").isEnabled() ? "ok" : "unavailable");

const accessOf = (req) => {
  const paidModel = Boolean(config.PAID_ACCESS_ENABLED);
  return {
    read: "ok",
    edit: "ok",
    studio: studioOf(req),
    ...(paidModel ? paidAccessOf(req) : {}),
    model: paidModel ? "paid" : "open",
    validator: validatorOf(),
    provider: { name: config.MODEL_PROVIDER_NAME || null, documents_retention: config.WORKSPACE_ENABLED ? "project" : "session" },
    projects_retention_days: config.PROJECTS_RETENTION_DAYS,
    request_access_url: requestAccessUrl(),
  };
};

module.exports = { accessOf, requestAccessUrl, ALLOWED_SCHEMES, _internals: { studioOf, paidAccessOf, licenceSummaryOf } };
