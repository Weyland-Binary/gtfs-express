/**
 * accountsController — the /gtfs/auth/* and /gtfs/admin/users* handlers
 * (behind ACCOUNTS_ENABLED; the routes answer 503 ACCOUNTS_DISABLED first).
 *
 * Sign-in by a code sent by e-mail (no password, the address verified by the code itself):
 *
 *   POST /auth/code         { email, language? }          → 202 { sent, expires_in_s, resend_after_s }
 *                           the same answer whether or not an account holds the address (no address oracle);
 *                           429 LOGIN_CODE_TOO_SOON { retry_after_s }, 503 MAIL_UNAVAILABLE, 502 MAIL_PROVIDER_ERROR
 *   POST /auth/code/verify  { email, code, display_name?, purpose? } → 200 { user, created: false } | 201 { user,
 *                           created: true } + the session cookie; the first verified code creates the account; 401
 *                           LOGIN_CODE_INVALID { attempts_left }, 410 LOGIN_CODE_EXPIRED, 429 LOGIN_CODE_LOCKED,
 *                           403 ACCOUNT_DISABLED. With `purpose: "admin"` (the operator's console) only an address of
 *                           ADMIN_EMAILS is signed in — created at its first code, as anywhere —; any other address,
 *                           known or not, gets 403 ADMIN_ACCESS_DENIED « Access denied. »: no account created, no
 *                           session opened, nothing said of the address. Every refusal of the console's sign-in is
 *                           recorded among the administrator's acts (console.denied, the address masked).
 *   PATCH /auth/me          { display_name }               → { user } (the name the person signs their acts with)
 *   POST /auth/logout       { everywhere? }                → 204: this session ends; with `everywhere`, every session of
 *                           the account (a lost or shared computer), each device signing in again by a code
 *
 * The licence (accounts/store.licenceOf) is in every user payload: its source, its end, whether the free trial is
 * still available. Reading a feed is free and needs no account.
 *
 * The session cookie: gtfs_session=<id>; HttpOnly; SameSite=Lax; Path=/;
 * Secure when the request came over https (trust proxy is on). Errors use
 * the { error: CODE, message } envelope. Nothing about the codes is ever
 * logged: events carry the hashed email only.
 *
 * The rights of the persons (accounts/accountRights): GET /auth/me/export
 * hands the account its data as JSON; DELETE /auth/me deletes it, typed
 * confirmation required, refused while it holds a project shared with others.
 */

"use strict";

const store = require("./store");
const mailer = require("../mail/mailer");
const { loginCodeMessage } = require("../mail/templates");
const { recordEvent, extractReqMeta, hashEmail } = require("../eventLogger");
const { COOKIE_NAME } = require("../../middleware/userContext");
const accountRights = require("./accountRights");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DISPLAY_NAME_MAX = 80;
const DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;

const invalid = (res, message) => res.status(400).json({ error: "INVALID_INPUT", message });

// Account payloads name the caller: never cacheable, by a proxy or the browser.
const noStore = (res) => res.setHeader("Cache-Control", "no-store");

// A sign-in replaces the session the browser was carrying (if any): one
// live session per cookie, so a stale id never outlives the sign-in that
// superseded it.
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

/** POST /gtfs/auth/code { email, language? } → 202: a six-digit code sent to the address (accounts/store). */
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
    const issued = store.issueLoginCode(email);
    if (!issued.ok) {
      res.set("Retry-After", String(issued.retry_after_s));
      return res.status(429).json({ error: "LOGIN_CODE_TOO_SOON", message: "A code was sent a moment ago: wait before asking for another one.", retry_after_s: issued.retry_after_s });
    }
    const language = typeof req.body.language === "string" ? req.body.language : "fr";
    await mailer.send({ kind: "login_code", to: email, ...loginCodeMessage(issued.code, language) });
    recordEvent("account.code_sent", { ...extractReqMeta(req), email_hash: hashEmail(email) });
    require("../admin/funnel").record(req, "signin.code_sent");
    return res.status(202).json(accepted);
  } catch (err) {
    if (err && err.code === "MAIL_PROVIDER_ERROR") return res.status(502).json({ error: "MAIL_PROVIDER_ERROR", message: "The code could not be sent: try again in a moment." });
    return next(err);
  }
};

/** A refusal of the console's sign-in, kept among the administrator's acts: when, which address (masked), why. */
const consoleDenied = (email, reason, user = null) =>
  require("../admin/opsData").logAdminAction({ via: "sign-in", user_id: user ? user.id : null }, "console.denied", null, { to: mailer.maskEmail(email), reason });

/** POST /gtfs/auth/code/verify { email, code, display_name?, purpose? } → the session; the first verified code creates the account. */
const verifyCode = (req, res) => {
  const body = req.body || {};
  const email = validateEmail(body.email);
  if (!email) return invalid(res, "A valid email address is required.");
  const code = typeof body.code === "string" || typeof body.code === "number" ? String(body.code).replace(/\D/g, "") : "";
  if (code.length !== 6) return invalid(res, "The code has six digits.");
  const forConsole = body.purpose === "admin";
  const checked = store.verifyLoginCode(email, code);
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

/** POST /gtfs/auth/logout → 204 and clears the cookie */
const logout = (req, res) => {
  // Every device of the account at once, when asked by a signed-in account; else this browser's session only.
  if (req.body && req.body.everywhere === true && req.user) {
    const ended = store.deleteSessionsForUser(req.user.id);
    recordEvent("auth.logout_everywhere", { ...eventMeta(req, req.user), sessions: ended });
  } else if (req.userSession) store.deleteSession(req.userSession.id);
  clearSessionCookie(req, res);
  return res.status(204).end();
};

/** GET /gtfs/auth/me → { user } (401 NOT_SIGNED_IN via requireUser) */
const me = (req, res) => {
  noStore(res);
  return res.json({ user: store.publicUser(req.user) });
};

/** PATCH /gtfs/auth/me { display_name } → { user }: the name the person's acts are signed with. */
const updateMe = (req, res) => {
  const body = req.body || {};
  if (body.display_name !== null && typeof body.display_name !== "string") return invalid(res, "display_name must be a string.");
  const updated = store.updateUser(req.user.id, { display_name: displayNameOf(body.display_name) });
  noStore(res);
  return res.json({ user: store.publicUser({ ...updated, subscription: req.user.subscription }) });
};

/**
 * GET /gtfs/auth/me/export → the account's data as a JSON file (accounts/accountRights.exportOf):
 * the profile and entitlements, the sessions' dates, the projects it holds or is a member of, the
 * journal lines, reviews, acknowledgements and contract decisions it signed in them.
 */
const exportMine = (req, res) => {
  const out = accountRights.exportOf(req.user);
  recordEvent("account.exported", eventMeta(req, req.user));
  noStore(res);
  res.setHeader("Content-Disposition", `attachment; filename="gtfs-express-mes-donnees-${out.exported_at.slice(0, 10)}.json"`);
  return res.json(out);
};

/**
 * DELETE /gtfs/auth/me { confirm } → the account deleted by its owner (accounts/accountRights.deleteAccount).
 * `confirm` is the account's e-mail, typed (400 CONFIRMATION_REQUIRED otherwise). A project it holds and shares
 * with others is never deleted under them: 409 ACCOUNT_PROJECTS_SHARED { projects, action: "hand_over" } until
 * each is handed over to a member (POST /workspace/projects/:id/owner) or its members removed. Then its
 * sessions are revoked, its projects deleted, its name in others' projects replaced by « compte supprimé »,
 * the cookie cleared → 200 { deleted: true, ...counts }.
 */
const deleteMine = (req, res) => {
  const typed = typeof req.body?.confirm === "string" ? store.normalizeEmail(req.body.confirm) : "";
  if (!typed || typed !== store.normalizeEmail(req.user.email)) {
    return res.status(400).json({ error: "CONFIRMATION_REQUIRED", message: "Type the account's email address to confirm its deletion.", required: ["confirm"] });
  }
  // A subscription that would still renew is cancelled first (the provider's portal): deleting the account here
  // would leave a payment running for an account that no longer exists.
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
  // The event names the account by its id only (its email hash too would outlive it in the log for nothing).
  recordEvent("account.deleted", { ...extractReqMeta(req), user_id: req.user.id, projects_deleted: counts.projects_deleted, projects_anonymised: counts.projects_anonymised });
  clearSessionCookie(req, res);
  noStore(res);
  return res.json({ deleted: true, ...counts });
};

/** GET /gtfs/admin/users → { users } (no hashes); the console lists them with more (admin/adminConsole.listUsers). */
const adminListUsers = (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return res.json({ users: store.listUsers().map(store.adminUser), ts: new Date().toISOString() });
};

/**
 * POST /gtfs/admin/users/{id}/entitlements { studio?, edit?, disabled?, until? } → { user }. `until` ends the
 * grant: a date ("2027-06-30", the licence bought on a quote) or null (no end); left out, the end is kept.
 */
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
    if (typeof body.until !== "string" || !DATE_RE.test(body.until) || Number.isNaN(Date.parse(body.until))) return invalid(res, "until must be a date (YYYY-MM-DD) or null.");
    // A date alone ends at the end of that day (UTC).
    until = body.until.length === 10 ? new Date(`${body.until}T23:59:59.999Z`).toISOString() : new Date(body.until).toISOString();
  }
  if (!store.getUserById(id)) {
    return res.status(404).json({ error: "USER_NOT_FOUND", message: "No account with this id." });
  }
  let user = store.setEntitlements(id, { studio: body.studio, edit: body.edit, until, kind: body.kind });
  if (typeof body.disabled === "boolean") {
    user = store.updateUser(id, { disabled: body.disabled });
    if (body.disabled) store.deleteSessionsForUser(id);
  }
  recordEvent("account.entitlements", { ...eventMeta(req, user), entitlements: user.entitlements, grant_until: user.grant_until, grant_kind: user.grant_kind || "client", disabled: user.disabled });
  require("../admin/opsData").logAdminAction(req.admin, "account.entitlements", id, { granted: user.entitlements, until: user.grant_until, kind: user.grant_kind || "client", disabled: user.disabled });
  return res.json({ user: store.adminUser(user) });
};

/** GET /gtfs/admin/mail/outbox → { provider, messages }: the "memory" provider's last messages (tests, end-to-end runs). */
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
