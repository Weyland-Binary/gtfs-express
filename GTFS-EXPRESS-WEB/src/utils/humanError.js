/**
 * Any failure (a fetch error, an API envelope in any of its forms, an SSE `error` event, the AI provider's
 * "401 {…}" text) becomes one plain sentence; the technical text is kept apart for a folded "Details".
 * Refusal codes read their `refusal.<CODE>.*` texts before any fallback by status, so a code never gets
 * another failure's sentence; a code with texts in translations.js but not listed here still reads them (`t`
 * says whether a key has a text); a server code with no text yet shows the server's own sentence; anything
 * else falls to a retryable "unexpected error", never a blank.
 * With `context: "assistant"`, an access refusal means the assistant is unavailable, not a missing right.
 */

const NETWORK_RE = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR|socket hang up|fetch failed|failed to fetch|networkerror|network error|load failed|timed? ?out|timeout|bad gateway|gateway time/i;
const ACCESS_RE = /authentication_error|permission_error|invalid x-api-key|x-api-key|api key|unauthori[sz]ed|forbidden/i;
const OVERLOADED_RE = /overloaded/i;
const RATE_RE = /rate.?limit|too many requests/i;
const CAPACITY_RE = /at capacity/i;
// A server code is an UPPER_SNAKE token; anything else in `error` is a sentence.
const CODE_RE = /^[A-Z][A-Z0-9_]{2,}$/;
const UNAVAILABLE_CODES = new Set(["NETWORK_ERROR", "FEED_UNAVAILABLE", "CATALOG_UNAVAILABLE", "PAN_UNAVAILABLE", "UPSTREAM_UNAVAILABLE"]);
const ACCESS_CODES = new Set(["UNAUTHORIZED", "FORBIDDEN"]);
// Their sentence is the account's; ACCOUNT_DISABLED has no refusal.<CODE>.* texts (title and action: the default's).
const ACCOUNT_CODES = {
  NOT_SIGNED_IN: "account.error.notSignedIn",
  ENTITLEMENT_REQUIRED: "account.error.entitlementRequired",
  ACCOUNT_DISABLED: "account.error.disabled",
  ACCOUNTS_DISABLED: "account.error.off",
};
// Size refusals without a refusal.<CODE> text of their own.
const TOO_LARGE_CODES = new Set(["FEED_TOO_LARGE", "FILE_TOO_LARGE"]);
const MAX_DETAIL = 600;

/**
 * Refusals that read their own `refusal.<CODE>.body`, with the kind a caller can act on. Every code here has its
 * three texts in translations.js (scripts/i18n-check.js does not know this table: a code added here needs them).
 */
const REFUSAL_KINDS = {
  VALIDATOR_UNAVAILABLE: "validator",
  VALIDATOR_FAILED: "validator",
  VALIDATION_ERRORS: "validation",
  VALIDATION_NEW_ERRORS: "validation",
  ACKNOWLEDGEMENT_UNNAMED: "invalid",
  CLAUSES_FAILING: "acknowledge",
  CHANGES_NOT_ASKED: "acknowledge",
  CLAUSES_UNKNOWN: "acknowledge",
  SOURCES_UNVERIFIED: "acknowledge",
  BASELINE_ERRORS: "acknowledge",
  CURRENT_ERRORS: "acknowledge",
  OPEN_ITEMS_UNACCEPTED: "acknowledge",
  PROOF_MISSING: "locked",
  PACKAGE_REQUIRED: "locked",
  PLAN_BLOCKED: "blocked",
  INTEGRITY_FAILED: "integrity",
  PREVIEW_STALE: "stale",
  PREVIEW_NOT_FOUND: "stale",
  PLAN_TOO_LARGE: "too_large",
  NO_SESSION: "session_lost",
  NO_FEED_LOADED: "session_lost",
  SESSION_NOT_FOUND: "session_lost",
  INVALID_SESSION: "session_lost",
  SESSION_NOT_IN_EDIT_MODE: "edit_required",
  UNDO_TARGET_NOT_LATEST: "stale",
  AUTOSAVE_CONFLICT: "conflict",
  CLIENT_TOKEN_REQUIRED: "session_lost",
  WORKSPACE_DISABLED: "off",
  TOO_MANY_PROJECTS: "limit",
  PROJECT_TOO_LARGE: "too_large",
  VERSION_TOO_LARGE: "too_large",
  VERSION_PROTECTED: "locked",
  // A second freeze under a version's id is refused: its approval covers those bytes.
  VERSION_FROZEN: "locked",
  NOTHING_TO_FREEZE: "invalid",
  VERSION_CORRUPT: "invalid",
  ROLE_REQUIRED: "access",
  HISTORY_TOO_LONG: "too_large",
  DOCUMENT_TOO_LARGE: "too_large",
  DOCUMENT_TOO_LONG: "too_large",
  UNREADABLE_DOCUMENT: "invalid",
  UNSUPPORTED_DOCUMENT: "invalid",
  EMPTY_DOCUMENT: "invalid",
  TOO_MANY_DOCUMENTS: "limit",
  TOO_MANY_STOPS: "limit",
  NO_SERVICE_DATES: "invalid",
  TOO_MANY_VERSIONS: "limit",
  PROJECT_NOT_FOUND: "not_found",
  VERSION_NOT_FOUND: "not_found",
  DOCUMENT_NOT_FOUND: "not_found",
  SHARE_NOT_FOUND: "not_found",
  INVALID_TRANSITION: "approval",
  NOT_APPROVED: "approval",
  VERSION_MISSING: "approval",
  PROJECT_NOT_ATTACHED: "approval",
  PACKAGE_NOT_FOUND: "not_found",
  USER_NOT_FOUND: "not_found",
  MEMBER_NOT_FOUND: "not_found",
  COHERENCE_STALE: "stale",
  TOO_MANY_CLAUSES: "limit",
  INVALID_ID: "invalid",
  CONFIRMATION_REQUIRED: "invalid",
  ACCOUNT_PROJECTS_SHARED: "locked",
  SUBSCRIPTION_REQUIRED: "access",
  SUBSCRIPTION_ACTIVE: "locked",
  SUBSCRIPTION_NOT_FOUND: "not_found",
  BILLING_UNAVAILABLE: "off",
  BILLING_PROVIDER_ERROR: "off",
  ACCOUNT_SUBSCRIPTION_ACTIVE: "locked",
  LOGIN_CODE_INVALID: "invalid",
  LOGIN_CODE_EXPIRED: "invalid",
  LOGIN_CODE_LOCKED: "locked",
  LOGIN_CODE_TOO_SOON: "locked",
  MAIL_UNAVAILABLE: "off",
  MAIL_PROVIDER_ERROR: "off",
  TRIAL_USED: "access",
  AI_ALLOWANCE_EXHAUSTED: "access",
  TRIAL_UNAVAILABLE: "off",
  LICENCE_ACTIVE: "locked",
  EMAIL_UNVERIFIED: "access",
  QUOTE_UNAVAILABLE: "off",
  TRIAL_NO_DELIVERY: "access",
  TRIAL_EMAIL_REFUSED: "invalid",
  SESSION_NOT_YOURS: "access",
  SQL_TIMEOUT: "too_large",
  SQL_UNBOUNDED: "invalid",
  DRAFT_VIEW_READ_ONLY: "locked",
  UPSTREAM_INCOMPLETE: "unavailable",
  TURN_BUDGET: "too_large",
  // The commit wrote something other than the preview showed, so nothing was applied: simulate again.
  COMMIT_DIVERGED: "stale",
  // A working copy with its draft open is edited in the draft; a draft is delivered once applied.
  DRAFT_OPEN: "locked",
  DRAFT_NOT_APPLIED: "approval",
  DRAFT_NOT_FOUND: "not_found",
  DRAFT_REWIND_FAILED: "stale",
  // A change delivered on its review: the review concluded and its report accepted under a name.
  REVIEW_INCOMPLETE: "stale",
  NO_REVIEW_TO_RUN: "stale",
  DIRECT_REPORT_UNACCEPTED: "acknowledge",
};
// Refusals whose action opens the offer.
const OFFER_CODES = new Set(["AI_ALLOWANCE_EXHAUSTED", "TRIAL_USED", "TRIAL_UNAVAILABLE", "TRIAL_NO_DELIVERY", "SUBSCRIPTION_REQUIRED", "FREE_QUOTA_EXHAUSTED"]);
// Every code with refusal.<CODE>.* texts in translations.js.
const REFUSAL_CODES = new Set([...Object.keys(REFUSAL_KINDS), "INVALID_INPUT", "PLACE_NOT_FOUND", "ENTITLEMENT_REQUIRED", "NOT_SIGNED_IN", "ACCOUNTS_DISABLED", "NL2SQL_CHAT_DISABLED", "FREE_QUOTA_EXHAUSTED", "RATE_LIMITED", "DAILY_LIMIT_REACHED", "BUDGET_EXHAUSTED", "AT_CAPACITY"]);
const RETRYABLE_REFUSALS = new Set(["MAIL_PROVIDER_ERROR", "VALIDATOR_UNAVAILABLE", "VALIDATOR_FAILED", "PREVIEW_STALE", "PREVIEW_NOT_FOUND", "SCENARIO_CHANGED", "SESSION_NOT_FOUND", "NO_SESSION", "NO_FEED_LOADED", "COMMIT_DIVERGED", "UPSTREAM_INCOMPLETE", "REVIEW_INCOMPLETE"]);
// `t` gives a key back when it has no text (LanguageContext): that is how a text's presence is read.
const hasText = (t, key) => t(key) !== key;
const COUNTED_LISTS = ["errors", "new_errors", "unacknowledged", "clauses", "operations", "assumptions", "steps", "issues", "blockers", "integrity", "uncovered"];
// An unknown role is shown as sent.
const ROLE_KEYS = { reader: "status.role.reader", contributor: "status.role.contributor", approver: "status.role.approver" };
const roleName = (role, t) => (ROLE_KEYS[role] ? t(ROLE_KEYS[role]) : String(role ?? ""));

const normalize = (err) => {
  if (err == null) return null;
  if (typeof err === "string") return { code: null, status: null, message: err, retryAfterSec: null, details: null };
  const body = err.body && typeof err.body === "object" ? err.body : null;
  // Envelopes: `{ code }`, `{ error: CODE }`, `{ error: <phrase>, code }`; a phrase in `error` is the message.
  const codeOf = (v) => (typeof v === "string" && CODE_RE.test(v.trim()) ? v.trim() : null);
  const code = codeOf(err.code) || codeOf(err.error) || codeOf(body?.code) || codeOf(body?.error) || null;
  const phrase = [err.message, err.raw, err.error, err.error?.message, body?.message, body?.error].find((v) => typeof v === "string" && v && !codeOf(v));
  const message = phrase || "";
  const retry = Number(err.retryAfterSec ?? body?.retryAfterSec ?? err.retry_after ?? body?.retry_after);
  let status = Number.isFinite(err.status) ? err.status : Number.isFinite(body?.status) ? body.status : null;
  if (status == null) {
    // "401 {…}" (the AI provider's text), "HTTP 502", code "HTTP_504".
    const m = /^(\d{3})\b/.exec(message) || /\bHTTP[ _](\d{3})\b/.exec(message) || /^HTTP_(\d{3})$/.exec(code || "");
    status = m ? Number(m[1]) : null;
  }
  const details = err.details && typeof err.details === "object" ? err.details : body || (typeof err === "object" ? err : null);
  return { code, status, message, retryAfterSec: Number.isFinite(retry) && retry > 0 ? retry : null, details };
};

const TECHNICAL_RE = /[{}[\]]|^\s*\d{3}\b|\b(?:ECONN\w+|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR\w*)\b|fetch failed|[Ff]ailed to fetch|\bHTTP[ _]\d{3}\b|\b\w+Error\b|_error\b/;

/** Whether a text is technical (JSON, an HTTP status, a socket code, an exception) rather than a sentence for people. */
export const isTechnical = (text) => TECHNICAL_RE.test(String(text || ""));

export const formatWait = (seconds, t) => {
  const s = Math.max(1, Math.round(Number(seconds) || 0));
  if (s < 90) return t("error.human.wait.seconds", { count: s });
  if (s < 90 * 60) return t("error.human.wait.minutes", { count: Math.round(s / 60) });
  return t("error.human.wait.hours", { count: Math.round(s / 3600) });
};

// A VALIDATION_* refusal's details.by_rule ({ rule: count }) as "invalid_url ×2, …".
const rulesOf = (e) => {
  const byRule = e.details && typeof e.details.by_rule === "object" ? e.details.by_rule : null;
  return byRule ? Object.entries(byRule).map(([rule, n]) => `${rule} ×${n}`).join(", ") : "";
};

const detailOf = (e) => {
  const text = [e.code, e.status && !String(e.message).startsWith(String(e.status)) ? `HTTP ${e.status}` : null, e.message, rulesOf(e)].filter(Boolean).join(" · ");
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
};

// A refusal text's placeholders, read from the details under the names the server sends.
const paramsOf = (e, t) => {
  const d = e.details || {};
  const list = COUNTED_LISTS.map((k) => d[k]).find(Array.isArray);
  // VALIDATION_ERRORS sends a number under `errors`, the others a list.
  const count = Number.isFinite(Number(d.count)) ? Number(d.count) : typeof d.errors === "number" ? d.errors : list ? list.length : 0;
  return {
    count,
    status: e.status ?? "",
    code: e.code ?? "",
    message: e.message || "",
    wait: e.retryAfterSec ? formatWait(e.retryAfterSec, t) : "",
    lines: d.lines ?? d.plan?.lines ?? "",
    max: d.max ?? d.plan?.max_lines ?? d.max_lines ?? "",
    entitlement: d.entitlement ?? "",
    role: d.role ? roleName(d.role, t) : "",
    // `required` is also ACKNOWLEDGEMENT_UNNAMED's list of missing fields: only a role name is a role.
    required: roleName(typeof d.needed === "string" ? d.needed : typeof d.required === "string" ? d.required : "", t),
    n: d.n ?? d.version ?? d.max ?? "",
    detail: Array.isArray(d.integrity) ? d.integrity.map((i) => (i && i.code ? `${i.code} ×${i.count ?? 1}` : String(i))).join(", ") : e.message || "",
  };
};

export const humanError = (err, t, { context = null } = {}) => {
  const e = normalize(err);
  if (!e) return null;
  const assistant = context === "assistant";
  const { code, status, message } = e;
  const params = paramsOf(e, t);
  // The code's own text when it has one (listed or not), else the default's: a raw key is never shown.
  const listed = REFUSAL_CODES.has(code);
  const own = (part) => (code && (listed || hasText(t, `refusal.${code}.${part}`)) ? `refusal.${code}.${part}` : `refusal.default.${part}`);
  const title = t(own("title"));
  const action = t(own("action"), params);
  const out = (kind, text, retryable = false, extra = {}) => ({ kind, code, status, title, message: text, action, offer: OFFER_CODES.has(code), detail: detailOf(e), retryable, retryAfterSec: e.retryAfterSec, ...extra });
  if (code === "ABORTED") return out("aborted", t("network.stopped"));
  if (ACCOUNT_CODES[code]) return out("account", t(ACCOUNT_CODES[code]));
  if (code === "FREE_QUOTA_EXHAUSTED") return out("trial", t("error.human.trial"));
  if (code === "BUDGET_EXHAUSTED") return out("budget", t("error.human.budget"));
  if (code === "RATE_LIMITED" || code === "DAILY_LIMIT_REACHED" || code === "UPSTREAM_RATE_LIMIT" || status === 429 || RATE_RE.test(message)) {
    return out("quota", e.retryAfterSec ? t("error.human.quota", { wait: formatWait(e.retryAfterSec, t) }) : t("error.human.quotaLater"), true);
  }
  if (code === "NL2SQL_CHAT_DISABLED") return out("off", t("error.human.off"));
  if (code === "PLACE_NOT_FOUND") return out("not_found", t("territory.notFound"));
  if (code === "REFUSAL") return out("refused", t("error.human.refused"));
  if (code === "OUTPUT_LIMIT") return out("too_large", t("error.human.outputLimit"));
  // Before any fallback by status, so a 413 or 400 with its own code says what that code means.
  if (REFUSAL_KINDS[code]) return out(REFUSAL_KINDS[code], t(`refusal.${code}.body`, params), RETRYABLE_REFUSALS.has(code));
  if (TOO_LARGE_CODES.has(code) || status === 413) return out("too_large", t("error.human.tooLarge"));
  if (code === "REQUIRED_FIELDS_MISSING" || code === "INVALID_FEED") return out("invalid", t("error.human.invalidFeed"));
  // An upstream source's own "HTTP 403" is not the user's access.
  if (UNAVAILABLE_CODES.has(code)) return out("unavailable", t("error.human.unavailable"), true);
  if (OVERLOADED_RE.test(message) || status === 529) return out("busy", t(assistant ? "error.human.overloaded" : "error.human.busy"), true);
  if (code === "AT_CAPACITY" || CAPACITY_RE.test(message)) return out("busy", t("error.human.busy"), true);
  if (ACCESS_CODES.has(code) || status === 401 || status === 403 || ACCESS_RE.test(message)) return out("access", t(assistant ? "error.human.access" : "error.human.accessData"));
  if ([408, 502, 504].includes(status) || NETWORK_RE.test(message) || NETWORK_RE.test(code || "")) return out("unavailable", t("error.human.unavailable"), true);
  if (status === 503) return out("busy", t(assistant ? "error.human.overloaded" : "error.human.busy"), true);
  if (status === 404) return out("not_found", t("error.human.notFound"), true);
  if (code === "INVALID_INPUT") return out("invalid", t("error.human.invalid"));
  // A code with texts of its own that the table above does not list yet: they are read all the same.
  if (code && hasText(t, `refusal.${code}.body`)) return out("refused", t(`refusal.${code}.body`, params));
  // A refusal (4xx) whose code has no text yet: the server's own sentence says what was refused, where « unexpected
  // error » would not. A 500's message is masked in production.
  if (code && message && status >= 400 && status < 500 && !isTechnical(message)) return out("refused", message);
  if (status === 400) return out("invalid", t("error.human.invalid"));
  return out("unknown", t("error.human.unknown"), true);
};

/** The codes with a sentence of their own: the refusal table's, and the account's. */
export const REFUSAL_CODES_WITH_TEXT = new Set([...REFUSAL_CODES, ...Object.keys(ACCOUNT_CODES)]);
/** Whether `code` has a sentence of its own: listed, or with texts in the dictionary `t` reads. */
export const hasRefusalText = (code, t) => Boolean(code && (REFUSAL_CODES_WITH_TEXT.has(code) || hasText(t, `refusal.${code}.body`)));
