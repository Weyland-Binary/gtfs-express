/**
 * plansService — the offer: Free, Pro, Team.
 *
 *   GET /gtfs/config/plans   → { current, plans }
 *
 * Plans are a catalogue (limits, prices, checkout links) read from config;
 * entitlement comes from the access code (codes.json `tier`: beta | pro |
 * team | unlimited) sent as X-Beta-Code — the same key that unlocks the
 * assistant. Stripe Checkout links are plain URLs (STRIPE_CHECKOUT_URL_PRO /
 * _TEAM): when they are unset the UI falls back to a contact request, so the
 * product works before billing is wired.
 *
 * `resolvePlan(req)` is what the gated features consult (network line cap).
 */

"use strict";

const config = require("../config");
const { validateCode } = require("./betaGate");
const { LIMITS } = require("./network/networkSpec");

const TIER_TO_PLAN = { beta: "pro", pro: "pro", team: "team", unlimited: "team" };

const catalogue = () => [
  {
    id: "free",
    price_eur: 0,
    period: "month",
    limits: { network_lines: config.NETWORK_FREE_MAX_LINES, ai_messages: config.NL2SQL_FREE_MESSAGES_PER_SESSION, seats: 1 },
    features: ["explore", "validate", "edit", "export", "studio_small", "ai_trial"],
    checkout_url: null,
  },
  {
    id: "pro",
    price_eur: config.PLAN_PRO_PRICE_EUR,
    period: "month",
    limits: { network_lines: config.NETWORK_PRO_MAX_LINES, ai_messages: config.BETA_NL2SQL_DAILY_LIMIT_PER_CODE, seats: 1 },
    features: ["everything_free", "studio_full", "ai_unlimited", "planner_model", "release_notes", "netex", "priority_support"],
    checkout_url: config.STRIPE_CHECKOUT_URL_PRO || null,
  },
  {
    id: "team",
    price_eur: config.PLAN_TEAM_PRICE_EUR,
    period: "month",
    limits: { network_lines: LIMITS.lines, ai_messages: config.BETA_NL2SQL_DAILY_LIMIT_PER_CODE * 3, seats: 5 },
    features: ["everything_pro", "seats", "shared_projects", "api", "onboarding"],
    checkout_url: config.STRIPE_CHECKOUT_URL_TEAM || null,
  },
];

/** The plan a request is entitled to, from its access code. */
const resolvePlan = (req) => {
  if (config.BETA_GATE_DISABLED) return { name: "team", source: "gate_disabled", tier: "unlimited" };
  const raw = req.headers && req.headers["x-beta-code"];
  if (!raw) return { name: "free", source: "anonymous", tier: null };
  const v = validateCode(String(raw));
  if (!v.ok) return { name: "free", source: "invalid_code", tier: null, error: v.code };
  return { name: TIER_TO_PLAN[v.tier] || "pro", source: "code", tier: v.tier, label: v.label || null };
};

const limitsFor = (planName) => (catalogue().find((p) => p.id === planName) || catalogue()[0]).limits;

const getPlans = (req, res) => {
  const current = resolvePlan(req);
  res.json({
    current: { ...current, limits: limitsFor(current.name) },
    plans: catalogue(),
    contact_email: config.PLAN_CONTACT_EMAIL,
    billing_enabled: Boolean(config.STRIPE_CHECKOUT_URL_PRO || config.STRIPE_CHECKOUT_URL_TEAM),
  });
};

module.exports = { getPlans, resolvePlan, limitsFor, catalogue, TIER_TO_PLAN };
