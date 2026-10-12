/**
 * mailer — the e-mails the product sends (2026-10-08): the sign-in codes (accounts, no password) and the quote
 * requests (the licence bought on a quote). One function, `send({ to, subject, text, html? })`, and three
 * providers chosen by MAIL_PROVIDER:
 *
 *   brevo    Brevo's transactional HTTP API (a French provider, the data kept in the EU): MAIL_API_KEY, MAIL_FROM
 *   log      the message written to the server's log, its addressee masked (development, the lab: nothing leaves
 *            the machine)
 *   memory   the last 50 messages kept in the process, read by the administrator (GET /admin/mail/outbox) — the
 *            tests and the end-to-end runs read a code there
 *
 * Without a provider (production's default) `isAvailable()` is false and the callers answer 503 MAIL_UNAVAILABLE:
 * a sign-in that cannot send its code says so instead of waiting for a message that will never come. No model
 * provider ever sees these messages (rule 7 is about the model; the mail provider is a processor of its own,
 * named in the terms). The transport is replaceable in the tests (`_setTransport`), as billing's is.
 */

"use strict";

const config = require("../../config");

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const OUTBOX_MAX = 50;
const outbox = [];

/** a.b@example.org → a***@example.org (the log never carries a whole address). */
const maskEmail = (email) => {
  const [user, domain] = String(email || "").split("@");
  if (!domain) return "***";
  return `${user.slice(0, 1)}***@${domain}`;
};

const defaultTransport = async (url, init) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};
let transport = defaultTransport;

const provider = () => config.MAIL_PROVIDER || "";

/** Whether a message can be sent at all (a provider, and for Brevo its key and sender). */
const isAvailable = () => {
  const p = provider();
  if (p === "log" || p === "memory") return true;
  if (p === "brevo") return Boolean(config.MAIL_API_KEY && config.MAIL_FROM);
  return false;
};

const unavailable = () => Object.assign(new Error("No e-mail provider is configured on this server."), { status: 503, code: "MAIL_UNAVAILABLE" });

/**
 * Send one message. `to` is one address; `replyTo` optional. Resolves to { id } — rejects with
 * { status: 503, code: "MAIL_UNAVAILABLE" } (no provider) or { status: 502, code: "MAIL_PROVIDER_ERROR" }.
 */
const send = async ({ to, subject, text, html = null, replyTo = null }) => {
  if (!isAvailable()) throw unavailable();
  const p = provider();
  if (p === "memory") {
    outbox.unshift({ to, subject, text, html, reply_to: replyTo, at: new Date().toISOString() });
    outbox.length = Math.min(outbox.length, OUTBOX_MAX);
    return { id: `memory-${outbox.length}` };
  }
  if (p === "log") {
    console.info(`[mail] to=${maskEmail(to)} subject=${JSON.stringify(subject)}\n${text}`);
    return { id: "log" };
  }
  const body = {
    sender: { email: config.MAIL_FROM, name: config.MAIL_FROM_NAME || undefined },
    to: [{ email: to }],
    subject,
    textContent: text,
    ...(html ? { htmlContent: html } : {}),
    ...(replyTo ? { replyTo: { email: replyTo } } : {}),
  };
  let res;
  try {
    res = await transport(BREVO_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "api-key": config.MAIL_API_KEY },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw Object.assign(new Error(`The e-mail provider could not be reached: ${err.message}`), { status: 502, code: "MAIL_PROVIDER_ERROR" });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw Object.assign(new Error(`The e-mail provider refused the message (${res.status}). ${detail.slice(0, 200)}`.trim()), { status: 502, code: "MAIL_PROVIDER_ERROR" });
  }
  const json = await res.json().catch(() => ({}));
  return { id: json.messageId || null };
};

/** The "memory" provider's messages, newest first (the administrator's view; empty for the other providers). */
const outboxOf = () => (provider() === "memory" ? outbox.map((m) => ({ ...m })) : []);

module.exports = {
  send,
  isAvailable,
  maskEmail,
  outboxOf,
  _setTransport: (fn) => {
    transport = fn || defaultTransport;
  },
  _clearOutbox: () => {
    outbox.length = 0;
  },
};
