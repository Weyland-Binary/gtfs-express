/**
 * trialMail — the free trial's three e-mails (a trial is followed, not left to be found again): « started » when it begins (its end, the assistant's envelope, what stays for the licence),
 * « ending » REMIND_DAYS before its end, « ended » once it has ended and no other licence runs. Service messages
 * about the person's own trial, in the language the trial was started in, linking the site it was started from.
 *
 * Each is sent once (users.trial_reminded_at / trial_ended_mailed_at stamp it, before the send: a mail lost is
 * never sent twice); an account disabled, or holding a licence that is not the trial, gets none; a trial that
 * ended more than LATE_DAYS ago gets no « ended » (a server that was down a week does not wake old trials up).
 * Without a mail provider nothing is sent and nothing is stamped. A failure is logged, never thrown: the trial
 * itself never depends on its e-mails.
 *
 *   sendStarted(user)   the first message, from POST /billing/trial
 *   sweep(now)          the reminders and the ends due now → { ending, ended }
 *   start()             the hourly sweep, started once by the server (src/app.js), never under Jest
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

/** The trial's first message, once it runs. */
const sendStarted = async (user) => {
  if (!user || !user.trial_until || !mailer.isAvailable()) return false;
  return deliver(user, "started");
};

/** The reminders and the ends due at `now`, each sent once. */
const sweep = async (now = Date.now()) => {
  const out = { ending: 0, ended: 0 };
  if (!config.ACCOUNTS_ENABLED || !mailer.isAvailable()) return out;
  for (const user of store.trialAccounts(now, LATE_DAYS)) {
    const end = Date.parse(user.trial_until);
    if (!Number.isFinite(end)) continue;
    const licence = store.licenceOf(user, undefined, now);
    // A licence that is not the trial runs (bought, granted, the operator's): nothing to remind of.
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
