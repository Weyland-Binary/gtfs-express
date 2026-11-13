/**
 * Sign-in by a six-digit code sent by e-mail (no password: the code verifies the address; the first one creates the
 * account). Nothing about the codes is ever logged: events carry the hashed e-mail only (#3).
 */

"use strict";

const store = require("./store");
const mailer = require("../mail/mailer");
const { loginCodeMessage } = require("../mail/templates");
const { recordEvent, extractReqMeta, hashEmail, pseudonymiseUser, pseudonymOf } = require("../eventLogger");
const { COOKIE_NAME } = require("../../middleware/userContext");
const accountRights = require("./accountRights");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISPLAY_NAME_MAX = 80;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
// Date.parse rolls « 2026-02-30 » over to March 2: the calendar day must read back as written.
const isCalendarDate = (value) => DATE_RE.test(value) && !Number.isNaN(Date.parse(value)) && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);

const invalid = (res, message) => res.status(400).json({ error: "INVALID_INPUT", message });

// Account payloads name the caller: never cacheable, by a proxy or the browser.
const noStore = (res) => res.setHeader("Cache-Control", "no-store");

// One live session per cookie: a stale id never outlives the sign-in that superseded it.
const openSession = (req, res, user) => {
  if (req.userSession) store.deleteSession(req.userSession.id);
  const sessionId = store.createSession(user.id, { userAgent: req.headers["user-agent"] });
  setSessionCookie(req, res, sessionId);
};

const cookieOptions = (req) => ({
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  secure: Boolean(req.secure),
});

const setSessionCookie = (req, res, sessionId) => {
  res.cookie(COOKIE_NAME, sessionId, { ...cookieOptions(req), maxAge: store.SESSION_TTL_MS });
};

const clearSessionCookie = (req, res) => {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
};

const eventMeta = (req, user) => ({
  ...extractReqMeta(req),
  user_id: user ? user.id : null,
  email_hash: user ? hashEmail(user.email) : null,
});

const validateEmail = (raw) => {
  const email = store.normalizeEmail(raw);
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
};

const displayNameOf = (raw) => (typeof raw === "string" ? raw.trim().slice(0, DISPLAY_NAME_MAX) || null : null);

/** The same 202 whether or not an account holds the address: no address oracle. */
const requestCode = async (req, res, next) => {
  try {
    const email = validateEmail(req.body && req.body.email);
    if (!email) return invalid(res, "A valid email address is required.");
    if (!mailer.isAvailable()) {
      return res.status(503).json({ error: "MAIL_UNAVAILABLE", message: "This server cannot send e-mails yet: signing in is not possible for now." });
    }
    noStore(res);
    const accepted = { sent: true, expires_in_s: Math.round(store.LOGIN_CODE_TTL_MS / 1000), resend_after_s: 60 };
    const existing = store.findUserByEmail(email);
    // A disabled account gets the same answer and no code: nothing tells it apart from any other address.
    if (existing && existing.disabled) return res.status(202).json(accepted);
    const issued = store.issueLoginCode(email, Date.now(), { client: req.ip });
    if (!issued.ok) {
      res.set("Retry-After", String(issued.retry_after_s));
      return res.status(429).json({ error: "LOGIN_CODE_TOO_SOON", message: "A code was sent a moment ago: wait before asking for another one.", retry_after_s: issued.retry_after_s });
    }
    const language = typeof req.body.language === "string" ? req.body.language : "fr";
    await mailer.send({ kind: "login_code", to: email, ...loginCodeMessage(issued.code, language) });
    recordEvent("account.code_sent", { ...extractReqMeta(req), email_hash: hashEmail(email) });
    // The operator's own code requests stay out of the way to the licence, as its other steps do.
    if (!require("../../config").ADMIN_EMAILS.includes(email)) require("../admin/funnel").record(req, "signin.code_sent");
    return res.status(202).json(accepted);
  } catch (err) {
    if (err && err.code === "MAIL_PROVIDER_ERROR") return res.status(502).json({ error: "MAIL_PROVIDER_ERROR", message: "The code could not be sent: try again in a moment." });
    return next(err);
  }
};

// A refused address is no operator's: the record keeps its keyed hash only (#3).
const consoleDenied = (email, reason, user = null) =>
  require("../admin/opsData").logAdminAction({ via: "sign-in", user_id: user ? user.id : null }, "console.denied", null, { to_hash: hashEmail(email), reason });

const verifyCode = (req, res) => {
  const body = req.body || {};
  const email = validateEmail(body.email);
  if (!email) return invalid(res, "A valid email address is required.");
  const code = typeof body.code === "string" || typeof body.code === "number" ? String(body.code).replace(/\D/g, "") : "";
  if (code.length !== 6) return invalid(res, "The code has six digits.");
  const forConsole = body.purpose === "admin";
  const checked = store.verifyLoginCode(email, code, Date.now(), { client: req.ip });
  if (!checked.ok && forConsole) consoleDenied(email, checked.reason || "code");
  if (!checked.ok) {
    if (checked.reason === "invalid") return res.status(401).json({ error: "LOGIN_CODE_INVALID", message: "This code is not the one sent.", attempts_left: checked.attempts_left });
    if (checked.reason === "locked") return res.status(429).json({ error: "LOGIN_CODE_LOCKED", message: "Too many wrong codes: ask for a new one." });
    return res.status(410).json({ error: "LOGIN_CODE_EXPIRED", message: "This code is no longer valid: ask for a new one." });
  }
  let user = store.findUserByEmail(email);
  // The console signs in its operators only: another address gets the same refusal whether it has an account or not.
  if (forConsole && !require("../../config").ADMIN_EMAILS.includes(email)) {
    consoleDenied(email, "not_operator", user);
    noStore(res);
    return res.status(403).json({ error: "ADMIN_ACCESS_DENIED", message: "Access denied." });
  }
  let created = false;
  const displayName = displayNameOf(body.display_name);
  if (!user) {
    user = store.createUser({ email, display_name: displayName, verified: true });
    created = true;
  } else if (user.disabled) {
    return res.status(403).json({ error: "ACCOUNT_DISABLED", message: "This account has been disabled." });
  } else {
    const patch = {};
    if (!user.email_verified_at) patch.email_verified_at = new Date().toISOString();
    if (displayName && !user.display_name) patch.display_name = displayName;
    if (Object.keys(patch).length) user = store.updateUser(user.id, patch);
  }
  store.purgeExpiredSessions();
  store.purgeExpiredLoginCodes();
  store.purgeOldTrials();
  noStore(res);
  openSession(req, res, user);
  const updated = store.updateUser(user.id, { last_login_at: new Date().toISOString() });
  recordEvent(created ? "account.registered" : "account.login", eventMeta(req, updated));
  // The console's own sign-in is no step to the licence.
  if (!forConsole) require("../admin/funnel").record(req, "signin.done", created ? "new" : "returning", { userId: updated.id });
  return res.status(created ? 201 : 200).json({ user: store.publicUser(updated), created });
};

const logout = (req, res) => {
  if (req.body && req.body.everywhere === true && req.user) {
    const ended = store.deleteSessionsForUser(req.user.id);
    recordEvent("auth.logout_everywhere", { ...eventMeta(req, req.user), sessions: ended });
  } else if (req.userSession) store.deleteSession(req.userSession.id);
  clearSessionCookie(req, res);
  return res.status(204).end();
};

const me = (req, res) => {
  noStore(res);
  return res.json({ user: store.publicUser(req.user) });
};

const updateMe = (req, res) => {
  const body = req.body || {};
  if (body.display_name !== null && typeof body.display_name !== "string") return invalid(res, "display_name must be a string.");
  const updated = store.updateUser(req.user.id, { display_name: displayNameOf(body.display_name) });
  noStore(res);
  return res.json({ user: store.publicUser({ ...updated, subscription: req.user.subscription }) });
};

const exportMine = (req, res) => {
  const out = accountRights.exportOf(req.user);
  recordEvent("account.exported", eventMeta(req, req.user));
  noStore(res);
  res.setHeader("Content-Disposition", `attachment; filename="gtfs-express-mes-donnees-${out.exported_at.slice(0, 10)}.json"`);
  return res.json(out);
};

/** `confirm` is the account's e-mail, typed. A project shared with others is never deleted under them. */
const deleteMine = async (req, res) => {
  const typed = typeof req.body?.confirm === "string" ? store.normalizeEmail(req.body.confirm) : "";
  if (!typed || typed !== store.normalizeEmail(req.user.email)) {
    return res.status(400).json({ error: "CONFIRMATION_REQUIRED", message: "Type the account's email address to confirm its deletion.", required: ["confirm"] });
  }
  // A subscription that would still renew must be cancelled first: else a payment runs for an account that is gone.
  const sub = req.user.subscription || store.subscriptionOf(req.user.id);
  if (store.isEntitledSubscription(sub) && !sub.cancel_at_period_end) {
    return res.status(409).json({ error: "ACCOUNT_SUBSCRIPTION_ACTIVE", message: "This account's subscription is still running: cancel it from the subscription management page before deleting the account.", action: "cancel_subscription" });
  }
  const blockers = accountRights.blockersOf(req.user);
  if (blockers.length) {
    return res.status(409).json({
      error: "ACCOUNT_PROJECTS_SHARED",
      message: `${blockers.length} project(s) of this account are shared with other people: hand each over to one of its members (or remove its members) before deleting the account.`,
      projects: blockers,
      action: "hand_over",
    });
  }
  const counts = accountRights.deleteAccount(req.user);
  // The account's id leaves the event log: its lines, and this one, keep a pseudonym (its e-mail hash never written).
  await pseudonymiseUser(req.user.id).catch((err) => console.warn("[accounts] event log pseudonymisation failed:", err.message));
  recordEvent("account.deleted", { ...extractReqMeta(req), user_id: pseudonymOf(req.user.id), projects_deleted: counts.projects_deleted, projects_anonymised: counts.projects_anonymised });
  clearSessionCookie(req, res);
  noStore(res);
  return res.json({ deleted: true, ...counts });
};

const adminListUsers = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ users: store.listUsers().map(store.adminUser), ts: new Date().toISOString() });
};

/** `until` ends the grant: a date, or null for no end; left out, the end is kept. */
const adminSetEntitlements = (req, res) => {
  const id = String(req.params.id || "");
  const body = req.body || {};
  for (const key of ["studio", "edit", "disabled"]) {
    if (body[key] != null && typeof body[key] !== "boolean") return invalid(res, `${key} must be a boolean.`);
  }
  if (body.kind != null && !store.GRANT_KINDS.includes(body.kind)) return invalid(res, "kind must be client or tester.");
  let until;
  if (body.until === null) until = null;
  else if (body.until !== undefined) {
    if (typeof body.until !== "string" || !isCalendarDate(body.until)) return invalid(res, "until must be a calendar date (YYYY-MM-DD) or null.");
    // A date alone ends at the end of that day (UTC).
    until = body.until.length === 10 ? new Date(`${body.until}T23:59:59.999Z`).toISOString() : new Date(body.until).toISOString();
  }
  const before = store.getUserById(id);
  if (!before) {
    return res.status(404).json({ error: "USER_NOT_FOUND", message: "No account with this id." });
  }
  const touchesGrant = ["studio", "edit", "until", "kind"].some((key) => body[key] !== undefined);
  let user = store.setEntitlements(id, { studio: body.studio, edit: body.edit, until, kind: body.kind });
  if (typeof body.disabled === "boolean") {
    user = store.updateUser(id, { disabled: body.disabled });
    if (body.disabled) store.deleteSessionsForUser(id);
  }
  recordEvent("account.entitlements", { ...eventMeta(req, user), entitlements: user.entitlements, grant_until: user.grant_until, grant_kind: user.grant_kind || "client", disabled: user.disabled });
  // Each act under its own name, so the console never reads a disabling as a revoked licence.
  const opsData = require("../admin/opsData");
  const kind = user.grant_kind || "client";
  if (touchesGrant) {
    const had = (before.entitlements || []).length > 0;
    const has = (user.entitlements || []).length > 0;
    const action = !has ? "account.revoke" : had ? "account.extend" : "account.grant";
    opsData.logAdminAction(req.admin, action, id, has ? { until: user.grant_until, kind, previous_until: had ? before.grant_until || null : undefined, previous_kind: had && before.grant_kind !== user.grant_kind ? before.grant_kind || "client" : undefined } : { kind: before.grant_kind || "client" });
  }
  if (typeof body.disabled === "boolean" && Boolean(before.disabled) !== body.disabled) opsData.logAdminAction(req.admin, body.disabled ? "account.disable" : "account.enable", id, null);
  return res.json({ user: store.adminUser(user) });
};

const adminMailOutbox = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ provider: require("../../config").MAIL_PROVIDER || null, messages: mailer.outboxOf() });
};

module.exports = {
  requestCode,
  verifyCode,
  logout,
  me,
  updateMe,
  exportMine,
  deleteMine,
  adminListUsers,
  adminSetEntitlements,
  adminMailOutbox,
};
