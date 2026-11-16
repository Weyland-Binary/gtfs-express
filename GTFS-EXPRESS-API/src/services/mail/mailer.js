/**
 * The e-mails the product sends, through the provider MAIL_PROVIDER names: `brevo` (EU-hosted), `log` (the server's
 * log, the address masked: nothing leaves the machine) or `memory` (the last 50 kept for GET /admin/mail/outbox,
 * where tests read a code). Without one, callers answer 503 MAIL_UNAVAILABLE rather than wait for a code that never
 * comes. The console's log records each message's kind and masked address, never its content (#3).
 */

"use strict";

const config = require("../../config");

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";
const OUTBOX_MAX = 50;
const outbox = [];

/** a.b@example.org → a***@example.org */
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

const isAvailable = () => {
  const p = provider();
  if (p === "log" || p === "memory") return true;
  if (p === "brevo") return Boolean(config.MAIL_API_KEY && config.MAIL_FROM);
  return false;
};

const unavailable = () => Object.assign(new Error("No e-mail provider is configured on this server."), { status: 503, code: "MAIL_UNAVAILABLE" });

/** `kind` is one of admin/opsData.MAIL_KINDS, for the console's log. */
const send = async ({ kind = null, ...message }) => {
  if (!isAvailable()) throw unavailable();
  try {
    const out = await deliver(message);
    require("../admin/opsData").logMail({ kind, to: message.to, ok: true });
    return out;
  } catch (err) {
    require("../admin/opsData").logMail({ kind, to: message.to, ok: false, error: err.code || "ERROR" });
    throw err;
  }
};

const deliver = async ({ to, subject, text, html = null, replyTo = null }) => {
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
