/**
 * accessService — the gates in one object, computed by the server.
 *
 * The web never adds an account's entitlements, the offer and the assistant's
 * availability up on its own: it could not announce honestly, before any work,
 * what a person would need. `accessOf(req)` is that one source, served by
 * GET /config/features as `access`.
 *
 * The open model (PAID_ACCESS_ENABLED off: the lab, development):
 *
 *   read:      "ok"                                   (reading is free)
 *   edit:      "ok"                                   (everything is open)
 *   studio:    "ok" | "entitlement_required" | "unavailable"
 *              (the assistant; with accounts, the studio's routes still want
 *              the "studio" entitlement)
 *   size:      { max_lines: N | null, plan }           (the offer's cap)
 *   validator: "ok" | "unavailable"                    (the canonical validator)
 *   provider:  { name, documents_retention }
 *   projects_retention_days, request_access_url
 *   model:     "open" | "paid"                        (PAID_ACCESS_ENABLED)
 *
 * Under the paid offer (services/paidAccess) the same object says what the
 * person holds of the two paid things, as the routes will really answer:
 *
 *   edit:          "ok" | "sign_in_required" | "subscription_required" | "unavailable"
 *   studio_access: the same four, for the Network Studio itself (create and
 *                  modify, by hand or with the assistant)
 *   studio:        the assistant inside it: "ok" | "unavailable" (no model
 *                  configured), or the studio's own state when it is closed
 *   licence:       { active, source, until, unlimited, trial_available, trial_until } of the signed-in
 *                  account (accounts/store.licenceOf), null without one
 *   billing:       { checkout: "stripe" | "link" | "contact", portal, subscription, trial_days, quote,
 *                  price_eur_year } — the three ways to the licence: the trial, paying online, a quote
 *
 * `requestAccessUrl()` is the only place the operator's address is read:
 * a `mailto:` or `https:` URL, or nothing — never another scheme, so the
 * web can put it in a link without a second thought (the web checks again).
 */

"use strict";

const config = require("../config");
const plansService = require("./plansService");

const ALLOWED_SCHEMES = /^(mailto:|https:)/i;

/** The operator's "request an access" URL, or null when none is configured or its scheme is refused. */
const requestAccessUrl = () => {
  const explicit = String(config.REQUEST_ACCESS_URL || "").trim();
  if (explicit) return ALLOWED_SCHEMES.test(explicit) ? explicit : null;
  const email = String(config.SUPPORT_EMAIL || "").trim();
  if (!email || email.includes("/") || !email.includes("@")) return null;
  return `mailto:${email}`;
};

/**
 * The assistant in the open model, as the planner routes will really serve it: with accounts, `studioGate` first
 * wants the "studio" entitlement; then everyone gets the full assistant (the free trial of messages is the paid
 * model's, nl2sqlChatController.chatAccessGate).
 */
const studioOf = (req) => {
  if (!config.NL2SQL_CHAT_ENABLED || !config.LLM_CONFIGURED) return "unavailable";
  if (config.ACCOUNTS_ENABLED) {
    const entitlements = req.user && Array.isArray(req.user.entitlements) ? req.user.entitlements : [];
    if (!entitlements.includes("studio")) return "entitlement_required";
  }
  return "ok";
};

/** The paid offer's states (services/paidAccess): the routes' own answer, announced before any work. */
const paidAccessOf = (req) => {
  const paid = require("./paidAccess");
  const studioAccess = paid.paidStateOf(req, "studio");
  const assistant = config.NL2SQL_CHAT_ENABLED && config.LLM_CONFIGURED ? "ok" : "unavailable";
  const sub = req.user && req.user.subscription ? require("./accounts/store").subscriptionSummary(req.user.subscription) : null;
  return {
    edit: paid.paidStateOf(req, "edit"),
    // Taking the modified network away (export, delivery, share): "trial" while the licence is the free trial.
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

/** What the web is told of a licence (no entitlement list: `edit` and `studio_access` say it already). */
const licenceSummaryOf = (l) => ({ active: Boolean(l.active), source: l.source || null, until: l.until || null, unlimited: Boolean(l.unlimited), trial_available: Boolean(l.trial_available), trial_until: l.trial_until || null });

const validatorOf = () => (require("./canonicalValidatorService").isEnabled() ? "ok" : "unavailable");

const accessOf = (req) => {
  const plan = plansService.resolvePlan(req);
  const limits = plansService.limitsFor(plan.name);
  const paidModel = Boolean(config.PAID_ACCESS_ENABLED);
  return {
    read: "ok",
    edit: "ok",
    studio: studioOf(req),
    ...(paidModel ? paidAccessOf(req) : {}),
    model: paidModel ? "paid" : "open",
    size: { max_lines: Number.isFinite(limits.network_lines) ? limits.network_lines : null, plan: plan.name },
    validator: validatorOf(),
    // Documents are kept with the project (the workspace, same retention);
    // without the workspace they live with the conversation, a couple of hours.
    provider: { name: config.MODEL_PROVIDER_NAME || null, documents_retention: config.WORKSPACE_ENABLED ? "project" : "session" },
    projects_retention_days: config.PROJECTS_RETENTION_DAYS,
    request_access_url: requestAccessUrl(),
  };
};

module.exports = { accessOf, requestAccessUrl, ALLOWED_SCHEMES, _internals: { studioOf, paidAccessOf, licenceSummaryOf } };
