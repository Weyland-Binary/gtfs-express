/**
 * humanError — a failure in the user's words.
 *
 * Whatever went wrong — a thrown fetch error, an API envelope in any of its
 * three forms (`{ error: CODE, message, …details }`, `{ error: <phrase>,
 * code: CODE }`, a bare 4xx without a code), a planner SSE `error` event,
 * the AI provider's "401 {"type":"error",…}" text, a territory dossier's
 * source warnings — becomes ONE plain sentence, never raw JSON or a socket
 * code. The technical text is kept apart for a folded "Details"
 * (ErrorNotice).
 *
 *   humanError(err, t, { context })  → { kind, code, status, title, message, action, detail, retryable, retryAfterSec }
 *   territoryGaps(warnings, t)       → { message, detail, sources, osm } | null
 *   formatWait(seconds, t)           → "45 s" | "3 min" | "2 h"
 *
 * Every refusal the server can emit (§7.2 of the target design) has its
 * `refusal.<CODE>.title|body|action` triplet in translations.js; `title`
 * and `action` come from it, and the message too for the codes that have no
 * older sentence of their own. The table is read before the generic
 * fallbacks by status (413, 400, 404…): a code with its own sentence never
 * gets a sentence meant for another failure. The placeholders are filled
 * from what the server really sends (`needed` for a role, `max` for a
 * limit, `lines` for the offer's cap), a role by its name on screen. A code
 * outside the table, a status without a code, a fetch exception: the
 * default branch (D43) — "Unexpected error", retryable, the detail folded —
 * so no refusal is ever a blank.
 *
 * `context: "assistant"` marks a failure of the planner: an access refusal
 * then means the assistant is unavailable (not that the user lacks a
 * right). Deterministic: the same failure always reads the same way.
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
// The account endpoints (ACCOUNTS_ENABLED): each code has its own sentence.
const ACCOUNT_CODES = {
  NOT_SIGNED_IN: "account.error.notSignedIn",
  ENTITLEMENT_REQUIRED: "account.error.entitlementRequired",
  ACCOUNT_DISABLED: "account.error.disabled",
  ACCOUNTS_DISABLED: "account.error.off",
};
// The size refusals without a refusal.<CODE> sentence of their own (the others are in REFUSAL_KINDS).
const TOO_LARGE_CODES = new Set(["FEED_TOO_LARGE", "FILE_TOO_LARGE"]);
const MAX_DETAIL = 600;

/**
 * The server's refusals (§7.2) that read from their own `refusal.<CODE>.body`
 * sentence, with the kind a caller can act on. Codes handled by an older
 * branch above them (quota, trial, budget, off, account) keep their
 * sentence and get their title and action from the table; this lookup comes
 * before every fallback by status, so a 413 or a 400 with a code of its own
 * says what that code means.
 */
const REFUSAL_KINDS = {
  VALIDATOR_UNAVAILABLE: "validator",
  VALIDATOR_FAILED: "validator",
  VALIDATION_ERRORS: "validation",
  VALIDATION_NEW_ERRORS: "validation",
  ACKNOWLEDGEMENT_UNNAMED: "invalid",
  CLAUSES_FAILING: "acknowledge",
  CLAUSES_UNKNOWN: "acknowledge",
  SOURCES_UNVERIFIED: "acknowledge",
  ASSUMPTIONS_UNVALIDATED: "acknowledge",
  // G5: a requirement of the brief answered by no clause — back to ② (a clause, « à vérifier à la main », or a named dismissal).
  REQUIREMENTS_UNCOVERED: "acknowledge",
  // The owner's rule of 2026-10-05 (nothing leaves unnamed): no ready contract (back to ②); the reference GTFS's own
  // errors and whatever stays open, accepted by name; a version frozen without a gate; a delivery without its package.
  CONTRACT_REQUIRED: "locked",
  BASELINE_ERRORS: "acknowledge",
  OPEN_ITEMS_UNACCEPTED: "acknowledge",
  PROOF_MISSING: "locked",
  PACKAGE_REQUIRED: "locked",
  PLAN_BLOCKED: "blocked",
  INTEGRITY_FAILED: "integrity",
  PREVIEW_STALE: "stale",
  PREVIEW_NOT_FOUND: "stale",
  PLAN_LIMIT: "plan_limit",
  SPEC_INVALID: "invalid",
  SPEC_TOO_LARGE: "too_large",
  PLAN_TOO_LARGE: "too_large",
  // More assumptions than a named person can be shown at once: the change is split, never committed with some unread.
  ASSUMPTIONS_TOO_MANY: "too_large",
  SIMPLIFIED_BASELINE: "study_only",
  NO_SPEC: "not_found",
  NO_REPORT: "not_found",
  // A built network edited since its build (GET /network/:buildId/export.zip): delivered from edit mode instead.
  BUILD_EDITED: "locked",
  NO_SESSION: "session_lost",
  NO_FEED_LOADED: "session_lost",
  SESSION_NOT_FOUND: "session_lost",
  INVALID_SESSION: "session_lost",
  SESSION_NOT_IN_EDIT_MODE: "edit_required",
  UNDO_TARGET_NOT_LATEST: "stale",
  AUTOSAVE_CONFLICT: "conflict",
  // The workspace (WP7): the browser's token, its quota, the project's size, the protected versions.
  CLIENT_TOKEN_REQUIRED: "session_lost",
  WORKSPACE_DISABLED: "off",
  TOO_MANY_PROJECTS: "limit",
  PROJECT_TOO_LARGE: "too_large",
  VERSION_TOO_LARGE: "too_large",
  VERSION_PROTECTED: "locked",
  // WP10: a version is frozen once — a second freeze under its id is refused (its approval covers those bytes).
  VERSION_FROZEN: "locked",
  NOTHING_TO_FREEZE: "invalid",
  VERSION_CORRUPT: "invalid",
  ROLE_REQUIRED: "access",
  PROJECT_STUDIO_DISABLED: "off",
  HISTORY_TOO_LONG: "too_large",
  DOCUMENT_TOO_LARGE: "too_large",
  DOCUMENT_TOO_LONG: "too_large",
  UNREADABLE_DOCUMENT: "invalid",
  // A file in a format not read here, or holding nothing to read: an offer sheet (mission step 6) or a brief
  // document of ① (briefDocumentService) — the sentences say neither, so both journeys read them right.
  UNSUPPORTED_DOCUMENT: "invalid",
  EMPTY_DOCUMENT: "invalid",
  TOO_MANY_DOCUMENTS: "limit",
  TOO_MANY_OBJECTIVES: "limit",
  TOO_MANY_SCENARIOS: "limit",
  TOO_MANY_VERSIONS: "limit",
  TOO_MANY_COMMENTS: "limit",
  PROJECT_NOT_FOUND: "not_found",
  VERSION_NOT_FOUND: "not_found",
  SCENARIO_NOT_FOUND: "not_found",
  DOCUMENT_NOT_FOUND: "not_found",
  SHARE_NOT_FOUND: "not_found",
  SCENARIO_LOCKED: "locked",
  SCENARIO_CHANGED: "stale",
  NO_REFERENCE: "invalid",
  REFERENCE_UNREADABLE: "invalid",
  INVALID_TRANSITION: "approval",
  NOT_APPROVED: "approval",
  LAST_APPROVER: "approval",
  VERSION_MISSING: "approval",
  // WP10 — sharing and approval need a project an account holds; a package is kept 24 hours; the members' accounts.
  PROJECT_NOT_ATTACHED: "approval",
  PACKAGE_NOT_FOUND: "not_found",
  USER_NOT_FOUND: "not_found",
  MEMBER_NOT_FOUND: "not_found",
  INVALID_CLAUSE: "invalid",
  // « Chaque ligne cochée devient une clause » (mission step 7): a contract nobody decided yet (② first), rows of
  // another version, a row the report has not, a contract full.
  CONTRACT_UNDECIDED: "locked",
  COHERENCE_STALE: "stale",
  COHERENCE_ROW_UNKNOWN: "invalid",
  TOO_MANY_CLAUSES: "limit",
  INVALID_PLAN: "invalid",
  INVALID_ID: "invalid",
  NETEX_DISABLED: "off",
  INVALID_PARTICIPANT: "invalid",
  // « Mes données »: the account's deletion asks for its e-mail typed, and never deletes a project shared with others
  // (each is handed over to a member first, in place).
  CONFIRMATION_REQUIRED: "invalid",
  ACCOUNT_PROJECTS_SHARED: "locked",
  // The paid offer (the API's services/paidAccess and services/billing): editing and the studio are the
  // subscription's; a subscription that runs is managed, not doubled; payments not set up, or not answering.
  SUBSCRIPTION_REQUIRED: "access",
  SUBSCRIPTION_ACTIVE: "locked",
  SUBSCRIPTION_NOT_FOUND: "not_found",
  BILLING_UNAVAILABLE: "off",
  BILLING_PROVIDER_ERROR: "off",
  ACCOUNT_SUBSCRIPTION_ACTIVE: "locked",
  // Signing in by a code sent by e-mail, and the licence's trial and quote (2026-10-08).
  LOGIN_CODE_INVALID: "invalid",
  LOGIN_CODE_EXPIRED: "invalid",
  LOGIN_CODE_LOCKED: "locked",
  LOGIN_CODE_TOO_SOON: "locked",
  MAIL_UNAVAILABLE: "off",
  MAIL_PROVIDER_ERROR: "off",
  TRIAL_USED: "access",
  // The assistant's envelope in euros spent (the trial's, or a licence's month: services/aiCostLimiter, 2026-10-12).
  AI_ALLOWANCE_EXHAUSTED: "access",
  TRIAL_UNAVAILABLE: "off",
  LICENCE_ACTIVE: "locked",
  EMAIL_UNVERIFIED: "access",
  QUOTE_UNAVAILABLE: "off",
};
// Every code with a refusal.<CODE>.* triplet in translations.js (the older branches included).
const REFUSAL_CODES = new Set([...Object.keys(REFUSAL_KINDS), "INVALID_INPUT", "PLACE_NOT_FOUND", "ENTITLEMENT_REQUIRED", "NOT_SIGNED_IN", "ACCOUNTS_DISABLED", "NL2SQL_CHAT_DISABLED", "FREE_QUOTA_EXHAUSTED", "RATE_LIMITED", "DAILY_LIMIT_REACHED", "BUDGET_EXHAUSTED"]);
const RETRYABLE_REFUSALS = new Set(["MAIL_PROVIDER_ERROR", "VALIDATOR_UNAVAILABLE", "VALIDATOR_FAILED", "PREVIEW_STALE", "PREVIEW_NOT_FOUND", "SCENARIO_CHANGED", "SESSION_NOT_FOUND", "NO_SESSION", "NO_FEED_LOADED"]);
const COUNTED_LISTS = ["errors", "new_errors", "unacknowledged", "clauses", "operations", "assumptions", "steps", "issues", "blockers", "integrity", "uncovered"];
// A project role (projectStore ROLES) → its name on screen; an unknown role is shown as sent.
const ROLE_KEYS = { reader: "status.role.reader", contributor: "status.role.contributor", approver: "status.role.approver" };
const roleName = (role, t) => (ROLE_KEYS[role] ? t(ROLE_KEYS[role]) : String(role ?? ""));

/** Any thrown value or event payload → { code, status, message, retryAfterSec, details }. */
const normalize = (err) => {
  if (err == null) return null;
  if (typeof err === "string") return { code: null, status: null, message: err, retryAfterSec: null, details: null };
  const body = err.body && typeof err.body === "object" ? err.body : null;
  // The three envelopes: `{ code }`, `{ error: CODE }`, `{ error: <phrase>, code }`; a phrase in `error` is the message.
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

/** Seconds → a short wait in the reader's words. */
export const formatWait = (seconds, t) => {
  const s = Math.max(1, Math.round(Number(seconds) || 0));
  if (s < 90) return t("error.human.wait.seconds", { count: s });
  if (s < 90 * 60) return t("error.human.wait.minutes", { count: Math.round(s / 60) });
  return t("error.human.wait.hours", { count: Math.round(s / 3600) });
};

// The validator rules behind a VALIDATION_* refusal (details.by_rule, { rule: count }), e.g. "invalid_url ×2".
const rulesOf = (e) => {
  const byRule = e.details && typeof e.details.by_rule === "object" ? e.details.by_rule : null;
  return byRule ? Object.entries(byRule).map(([rule, n]) => `${rule} ×${n}`).join(", ") : "";
};

const detailOf = (e) => {
  const text = [e.code, e.status && !String(e.message).startsWith(String(e.status)) ? `HTTP ${e.status}` : null, e.message, rulesOf(e)].filter(Boolean).join(" · ");
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
};

/**
 * The placeholders a refusal sentence may carry, read from the server's
 * details under the names the server sends: `role` / `needed` (ROLE_REQUIRED,
 * projectController), `max` (the TOO_MANY_* limits, a document's size or
 * length), `lines` and `plan.max_lines` (PLAN_LIMIT, networkController).
 */
const paramsOf = (e, t) => {
  const d = e.details || {};
  const list = COUNTED_LISTS.map((k) => d[k]).find(Array.isArray);
  // VALIDATION_ERRORS sends its count as a number under `errors` (validatorGate.assertCreationValid), the others a list.
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
  const known = REFUSAL_CODES.has(code);
  // The title and the action in place come from the refusal table, or from its default branch (D43).
  const title = t(known ? `refusal.${code}.title` : "refusal.default.title");
  const action = t(known ? `refusal.${code}.action` : "refusal.default.action", params);
  const out = (kind, text, retryable = false, extra = {}) => ({ kind, code, status, title, message: text, action, detail: detailOf(e), retryable, retryAfterSec: e.retryAfterSec, ...extra });
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
  // The server's other refusals (§7.2): their own sentence, with what the server counted — before any fallback by status.
  if (REFUSAL_KINDS[code]) return out(REFUSAL_KINDS[code], t(`refusal.${code}.body`, params), RETRYABLE_REFUSALS.has(code));
  if (TOO_LARGE_CODES.has(code) || status === 413) return out("too_large", t("error.human.tooLarge"));
  if (code === "REQUIRED_FIELDS_MISSING" || code === "INVALID_FEED") return out("invalid", t("error.human.invalidFeed"));
  // An upstream source that failed (its own "HTTP 403" is not the user's access).
  if (UNAVAILABLE_CODES.has(code)) return out("unavailable", t("error.human.unavailable"), true);
  if (OVERLOADED_RE.test(message) || status === 529) return out("busy", t(assistant ? "error.human.overloaded" : "error.human.busy"), true);
  if (code === "AT_CAPACITY" || CAPACITY_RE.test(message)) return out("busy", t("error.human.busy"), true);
  if (ACCESS_CODES.has(code) || status === 401 || status === 403 || ACCESS_RE.test(message)) return out("access", t(assistant ? "error.human.access" : "error.human.accessData"));
  if ([408, 502, 504].includes(status) || NETWORK_RE.test(message) || NETWORK_RE.test(code || "")) return out("unavailable", t("error.human.unavailable"), true);
  if (status === 503) return out("busy", t(assistant ? "error.human.overloaded" : "error.human.busy"), true);
  if (status === 404) return out("not_found", t("error.human.notFound"), true);
  if (code === "INVALID_INPUT" || status === 400) return out("invalid", t("error.human.invalid"));
  // The default branch, always: anything else is "unexpected", retryable, the technical text kept apart.
  return out("unknown", t("error.human.unknown"), true);
};

// The dossier's warnings are "<source label>: <reason>" (territoryService).
const GAP_KEY = [
  [/^overpass stops/i, "stops"],
  [/^overpass pois/i, "pois"],
  [/^overpass residential/i, "residential"],
  [/^overpass lines/i, "lines"],
  [/^overpass works/i, "works"],
  [/^nager/i, "holidays"],
  [/^openholidays/i, "schoolHolidays"],
  [/^wikidata/i, "population"],
  [/^open-meteo/i, "timezone"],
];

/**
 * A partial territory dossier in plain words: which data is missing (by
 * name, not by endpoint) and one sentence saying the dossier is incomplete.
 */
export const territoryGaps = (warnings, t) => {
  const list = (Array.isArray(warnings) ? warnings : []).map((w) => String(w || "")).filter(Boolean);
  if (!list.length) return null;
  const keys = list.map((w) => (GAP_KEY.find(([re]) => re.test(w)) || [null, "other"])[1]);
  const osm = list.filter((w) => /^overpass\b/i.test(w)).length;
  const others = list.length - osm;
  const message = osm && !others ? t("error.human.partialOsm") : osm ? t("error.human.partialOsmAndOthers", { count: others }) : t("territory.partial", { count: others });
  const sources = [...new Set(keys)].map((k) => t(`territory.gap.${k}`));
  return { message, detail: list.join("\n"), sources, osm };
};

/** Whether the dossier holds anything to design on: existing stops, places or a population grid. */
export const territoryHasData = (d) => Boolean(d && ((d.existing_stops || []).length || (d.pois?.items || []).length || (d.population_grid?.cells || []).length));

export const REFUSAL_CODES_WITH_TEXT = REFUSAL_CODES;
