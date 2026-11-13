/**
 * The facts the legal pages quote, served by GET /config/features as `legal`. Publisher and host come only from
 * the LEGAL_* settings (LCEN art. 6-III: the operator's to say, never the public code's); an empty one is null and
 * named in `missing`, never a placeholder. Every other figure is read where the server enforces it.
 */

"use strict";

const config = require("../config");

/** A setting as the pages may print it: trimmed, bounded, or null when empty. */
const clean = (value) => {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
  return text ? text.slice(0, 300) : null;
};

/** An address the pages may link to: an e-mail (no scheme) or nothing. */
const emailOf = (value) => {
  const text = clean(value);
  return text && /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(text) ? text : null;
};

/** A URL the pages may link to: https only. */
const httpsOf = (value) => {
  const text = clean(value);
  return text && /^https:\/\/[^\s]+$/i.test(text) ? text : null;
};

// What the law asks the notice to hold (LCEN art. 6-III-1): the publisher's name, address, a way to reach it,
// its registration, the publication's director, and the host's identity.
const REQUIRED = Object.freeze(["name", "address", "registration", "director", "contact", "host"]);

/** The model provider as the privacy page names it, and whether its processing leaves the EU. */
const modelOf = () => {
  if (!config.NL2SQL_CHAT_ENABLED || !config.LLM_CONFIGURED) return null;
  const provider = config.LLM_PROVIDER;
  const named = clean(config.MODEL_PROVIDER_NAME);
  if (provider === "bedrock") {
    const region = clean(config.LLM_AWS_REGION) || "";
    return { name: named || "Amazon Web Services (Amazon Bedrock)", region: region || null, outside_eu: !/^eu-/i.test(region) };
  }
  if (provider === "vertex") {
    const region = clean(config.LLM_VERTEX_REGION) || "eu";
    return { name: named || "Google Cloud (Vertex AI)", region, outside_eu: !/^(eu|europe-)/i.test(region) };
  }
  return { name: named || "Anthropic, PBC", region: "us", outside_eu: true };
};

/** The e-mail provider that sends the sign-in codes and the quote requests, when one sends anything. */
const mailOf = () => (config.MAIL_PROVIDER === "brevo" ? { name: "Brevo (Sendinblue SAS)", country: "FR", outside_eu: false } : null);

/** The payment provider, when online payment is configured. */
const paymentOf = () => (config.PAID_ACCESS_ENABLED && (config.STRIPE_SECRET_KEY || config.STRIPE_CHECKOUT_URL_PRO) ? { name: "Stripe Payments Europe, Ltd.", country: "IE", outside_eu: false } : null);

const legalFacts = () => {
  const store = require("./accounts/store");
  const publisher = {
    name: clean(config.LEGAL_PUBLISHER),
    status: clean(config.LEGAL_STATUS),
    address: clean(config.LEGAL_ADDRESS),
    registration: clean(config.LEGAL_REGISTRATION),
    vat: clean(config.LEGAL_VAT),
    director: clean(config.LEGAL_DIRECTOR),
    email: emailOf(config.LEGAL_EMAIL) || emailOf(config.SUPPORT_EMAIL),
    phone: clean(config.LEGAL_PHONE),
  };
  const host = clean(config.LEGAL_HOST);
  const present = { ...publisher, contact: publisher.email || publisher.phone, host };
  const sharesDays = require("./shareService").SHARE_TTL_DAYS;
  return {
    publisher,
    host,
    missing: REQUIRED.filter((field) => !present[field]),
    source_code_url: httpsOf(config.SOURCE_CODE_URL),
    retention: {
      session_hours: Math.max(1, Math.round(config.SESSION_CLEANUP_AGE_MS / 3_600_000)),
      projects_days: config.WORKSPACE_ENABLED ? config.PROJECTS_RETENTION_DAYS : null,
      account_projects_days: config.ACCOUNTS_ENABLED ? config.ACCOUNT_PROJECTS_RETENTION_DAYS : null,
      shares_days: sharesDays,
      logs_days: config.LOG_RETENTION_DAYS,
      login_code_minutes: Math.round(store.LOGIN_CODE_TTL_MS / 60_000),
      account_session_days: Math.round(store.SESSION_TTL_MS / 86_400_000),
      trial_record_years: Math.round(store.TRIAL_RECORD_MS / (365 * 86_400_000)),
      quote_months: Math.round(require("./admin/opsData").QUOTE_RETENTION_DAYS / 30.4),
    },
    offer: {
      accounts: Boolean(config.ACCOUNTS_ENABLED),
      paid: Boolean(config.PAID_ACCESS_ENABLED),
      price_eur_year: config.LICENCE_PRICE_EUR_YEAR,
      price_eur_month: config.LICENCE_PRICE_EUR_MONTH,
      trial_days: config.TRIAL_DAYS,
      trial_ai_daily: config.TRIAL_AI_DAILY_LIMIT,
      trial_ai_eur: config.TRIAL_AI_BUDGET_EUR > 0 ? config.TRIAL_AI_BUDGET_EUR : null,
      licence_ai_eur_month: config.LICENCE_AI_BUDGET_EUR_MONTH > 0 ? config.LICENCE_AI_BUDGET_EUR_MONTH : null,
      licence_ai_daily: config.BETA_NL2SQL_DAILY_LIMIT_PER_CODE,
      licence_ai_hourly: config.BETA_NL2SQL_RATE_LIMIT,
      // The reading companion of an account without the licence: its questions a month and its envelope (null: off).
      reader_ai_questions_month: config.PAID_ACCESS_ENABLED && config.ACCOUNTS_ENABLED && config.READER_AI_QUESTIONS_MONTH > 0 ? config.READER_AI_QUESTIONS_MONTH : null,
      reader_ai_eur_month: config.PAID_ACCESS_ENABLED && config.ACCOUNTS_ENABLED && config.READER_AI_QUESTIONS_MONTH > 0 && config.READER_AI_BUDGET_EUR_MONTH > 0 ? config.READER_AI_BUDGET_EUR_MONTH : null,
      online_payment: Boolean(paymentOf()),
    },
    processors: { model: modelOf(), mail: mailOf(), payment: paymentOf() },
  };
};

module.exports = { legalFacts, REQUIRED, _internals: { clean, emailOf, httpsOf, modelOf } };
