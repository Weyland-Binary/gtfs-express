/**
 * billingController — the licence's routes (billingService, accounts/store).
 *
 *   POST /billing/checkout      { plan, return_path } → { url, mode }   a signed-in account: pay online
 *   POST /billing/portal        { return_path }       → { url }          its subscription's management
 *   GET  /billing/subscription                        → { subscription, entitlements, plan, licence }
 *   POST /billing/trial         { name, organisation, role, network?, phone?, language? } → { user }
 *                                                     the free trial, once per verified address, with who tries it
 *   POST /billing/quote         { organisation, name, email, phone?, seats?, message? } → 202 { sent }
 *                                                     a quote asked of the operator (the public buyers' way: an
 *                                                     invoice, then the licence granted by the administrator
 *                                                     with its end date)
 *   POST /billing/webhook       the provider's events, raw body (app.js), signature checked
 *
 * The web never learns more than an address to open and the account's own
 * state; the webhook is the only writer of a subscription.
 */

"use strict";

const billing = require("./billingService");
const config = require("../../config");
const store = require("../accounts/store");
const mailer = require("../mail/mailer");
const { quoteRequestMessage } = require("../mail/templates");
const { resolvePlan } = require("../plansService");
const { recordEvent, extractReqMeta, hashEmail } = require("../eventLogger");

// A typed refusal (services/refusal) is the answer; anything else goes to the central error middleware (#6).
const handler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => {
    if (!err || !err.code || !err.status || err.status >= 500 && err.status !== 502 && err.status !== 503) return next(err);
    if (res.headersSent) return res.end();
    return res.status(err.status).json({ error: err.code, message: err.message, ...(err.details || {}) });
  });
const returnPathOf = (req) => (typeof req.body?.return_path === "string" ? req.body.return_path.slice(0, 300) : "/");
const refuse = (res, status, error, message, extra = {}) => res.status(status).json({ error, message, ...extra });
const text = (raw, max) => (typeof raw === "string" ? raw.trim().slice(0, max) : "");
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const checkout = handler(async (req, res) => {
  const plan = String(req.body?.plan || "");
  const period = req.body?.period === undefined ? "year" : String(req.body.period);
  const out = await billing.createCheckout(req, { plan, period, returnPath: returnPathOf(req) });
  recordEvent("billing.checkout", { ...extractReqMeta(req), plan, period, mode: out.mode });
  require("../admin/funnel").record(req, "checkout.opened", period === "month" ? "month" : "year");
  res.setHeader("Cache-Control", "no-store");
  res.json(out);
});

const portal = handler(async (req, res) => {
  const out = await billing.createPortal(req, { returnPath: returnPathOf(req) });
  res.setHeader("Cache-Control", "no-store");
  res.json(out);
});

const subscription = handler(async (req, res) => {
  const plan = resolvePlan(req);
  res.setHeader("Cache-Control", "no-store");
  res.json({ subscription: store.subscriptionSummary(req.user.subscription || null), entitlements: req.user.entitlements || [], plan: { name: plan.name, source: plan.source }, licence: req.user.licence || null });
});

/**
 * POST /billing/trial { name, organisation, role, network?, phone?, language? } → { user }: the free trial
 * (TRIAL_DAYS) starts now, once per verified address, with who tries it (the
 * name, the organisation and its role — authority, operator, consultancy, other —, optionally the network and a
 * phone, for the operator's follow-up; accounts/store.trialProfileOf). 400 INVALID_INPUT { missing }, 409
 * LICENCE_ACTIVE (a licence already runs: nothing to try), 409 TRIAL_USED (this mailbox had it, however it is
 * spelt), 403 TRIAL_EMAIL_REFUSED (a throwaway address), 403 EMAIL_UNVERIFIED, 503 TRIAL_UNAVAILABLE (TRIAL_DAYS=0).
 * The trial's first e-mail (accounts/trialMail) leaves once it runs; a mail that fails never undoes the trial.
 */
const trial = handler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const licence = req.user.licence || store.licenceOf(req.user, req.user.subscription);
  if (licence.active && licence.source !== "trial") return refuse(res, 409, "LICENCE_ACTIVE", "This account's licence already runs: there is nothing to try.");
  const given = store.trialProfileOf(req.body || {});
  if (!given.ok) return refuse(res, 400, "INVALID_INPUT", "The trial asks who tries it: a name, the organisation and its role.", { missing: given.missing, roles: store.ORG_ROLES });
  let siteOrigin = null;
  try {
    siteOrigin = billing._internals.returnBaseOf(req);
  } catch {
    /* no address configured nor allowed: the trial's e-mails go without a link */
  }
  const out = store.startTrial(req.user.id, Date.now(), { profile: given.profile, language: text(req.body?.language, 8) || null, siteOrigin });
  if (!out.ok) {
    if (out.reason === "used") return refuse(res, 409, "TRIAL_USED", "The free trial has already been used with this e-mail address.");
    if (out.reason === "disposable") return refuse(res, 403, "TRIAL_EMAIL_REFUSED", "The free trial needs a lasting e-mail address: throwaway addresses are refused.");
    if (out.reason === "unverified") return refuse(res, 403, "EMAIL_UNVERIFIED", "Sign in with a code sent to this address first: it verifies it.");
    return refuse(res, 503, "TRIAL_UNAVAILABLE", "This server offers no free trial.");
  }
  recordEvent("billing.trial", { ...extractReqMeta(req), user_id: req.user.id, email_hash: hashEmail(req.user.email), days: config.TRIAL_DAYS, org_role: given.profile.role });
  require("../admin/funnel").record(req, "trial.started", given.profile.role || null);
  await require("../accounts/trialMail").sendStarted(out.user);
  res.json({ user: store.publicUser({ ...out.user, subscription: req.user.subscription }) });
});

/**
 * POST /billing/quote { organisation, name, email, phone?, seats?, message? } → 202 { sent: true }: the request
 * mailed to the operator (PLAN_CONTACT_EMAIL / SUPPORT_EMAIL), the requester as its reply-to, and kept for the
 * console's « Quotes » (twelve months). 400 INVALID_INPUT,
 * 503 QUOTE_UNAVAILABLE (no address to send it to, or no mail provider), 502 MAIL_PROVIDER_ERROR.
 */
const quote = handler(async (req, res) => {
  const body = req.body || {};
  const organisation = text(body.organisation, 160);
  const name = text(body.name, 120);
  const email = text(body.email, 254).toLowerCase();
  const phone = text(body.phone, 40);
  const message = text(body.message, 4000);
  const seats = Number.isInteger(body.seats) && body.seats > 0 && body.seats < 10000 ? body.seats : null;
  if (!organisation || !name || !EMAIL_RE.test(email)) return refuse(res, 400, "INVALID_INPUT", "The organisation, a name and a valid e-mail address are required.", { required: ["organisation", "name", "email"] });
  const to = String(config.PLAN_CONTACT_EMAIL || config.SUPPORT_EMAIL || "").trim();
  if (!to.includes("@") || !mailer.isAvailable()) return refuse(res, 503, "QUOTE_UNAVAILABLE", "Quote requests cannot be sent from this server yet.");
  await mailer.send({ kind: "quote", to, replyTo: email, ...quoteRequestMessage({ organisation, name, email, phone, seats, message, priceEurYear: config.LICENCE_PRICE_EUR_YEAR, account: req.user ? req.user.email : null }) });
  // Kept for the operator's console too (twelve months, admin/opsData), once the operator's mailbox has it.
  require("../admin/opsData").addQuote({ organisation, name, email, phone, seats, message, userId: req.user ? req.user.id : null });
  recordEvent("billing.quote", { ...extractReqMeta(req), email_hash: hashEmail(email), signed_in: Boolean(req.user) });
  require("../admin/funnel").record(req, "quote.sent");
  res.setHeader("Cache-Control", "no-store");
  res.status(202).json({ sent: true });
});

const webhook = handler(async (req, res) => {
  const out = await billing.handleWebhook(req.body, req.headers["stripe-signature"]);
  if (out.status === 200 && out.body.handled) recordEvent("billing.webhook", { ...extractReqMeta(req), handled: true });
  res.status(out.status).json(out.body);
});

module.exports = { checkout, portal, subscription, trial, quote, webhook };
