/**
 * The free trial's three e-mails: « started », « ending » REMIND_DAYS before its end, « ended » once no licence runs.
 * Each is stamped before it is sent, so a lost mail is never sent twice; a trial ended more than LATE_DAYS ago gets no
 * « ended », so a server down for a week does not wake old trials. A failure is logged, never thrown:
 * the trial never depends on its e-mails.
 */

"use strict";

const config = require("../../config");
const store = require("./store");
const mailer = require("../mail/mailer");
const { trialMessage } = require("../mail/templates");

const DAY_MS = 24 * 60 * 60 * 1000;
const REMIND_DAYS = 3;
const LATE_DAYS = 7;

const varsOf = (user) => ({
  until: user.trial_until,
  aiEur: config.TRIAL_AI_BUDGET_EUR > 0 ? config.TRIAL_AI_BUDGET_EUR : null,
  url: user.site_origin || null,
  language: user.language || "fr",
});

const deliver = async (user, kind) => {
  try {
    await mailer.send({ kind: `trial_${kind}`, to: user.email, ...trialMessage(kind, varsOf(user)) });
    return true;
  } catch (err) {
    console.warn(`[trial mail] the « ${kind} » message was not sent: ${err.message}`);
    return false;
  }
};

const sendStarted = async (user) => {
  if (!user || !user.trial_until || !mailer.isAvailable()) return false;
  return deliver(user, "started");
};

const sweep = async (now = Date.now()) => {
  const out = { ending: 0, ended: 0 };
  if (!config.ACCOUNTS_ENABLED || !mailer.isAvailable()) return out;
  for (const user of store.trialAccounts(now, LATE_DAYS)) {
    const end = Date.parse(user.trial_until);
    if (!Number.isFinite(end)) continue;
    const licence = store.licenceOf(user, undefined, now);
    if (licence.active && licence.source !== "trial") continue;
    if (end > now) {
      if (user.trial_reminded_at || end - now > REMIND_DAYS * DAY_MS) continue;
      store.updateUser(user.id, { trial_reminded_at: new Date(now).toISOString() });
      if (await deliver(user, "ending")) out.ending += 1;
    } else if (!user.trial_ended_mailed_at) {
      store.updateUser(user.id, { trial_ended_mailed_at: new Date(now).toISOString() });
      if (await deliver(user, "ended")) out.ended += 1;
    }
  }
  return out;
};

let timer = null;
const start = () => {
  if (timer || process.env.NODE_ENV === "test" || !config.ACCOUNTS_ENABLED) return;
  const run = () =>
    sweep()
      .then((n) => {
        if (n.ending || n.ended) console.info(`[trial mail] ${n.ending} reminder(s), ${n.ended} end(s) sent`);
      })
      .catch((err) => console.warn("[trial mail] sweep failed:", err.message));
  timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
  setTimeout(run, 2 * 60 * 1000).unref();
};

module.exports = { sendStarted, sweep, start, REMIND_DAYS, LATE_DAYS };
