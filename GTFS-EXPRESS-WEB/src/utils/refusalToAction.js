/**
 * refusalToAction — one refusal of the server → what the screen says and
 * what the person can do about it, right there.
 *
 * ApplyDialog, the Network Studio and the export preflight all read it
 * rather than a `switch` of their own: each code of the server's table (services/refusal,
 * the gates, the engine) has a title, a sentence and one or two actions in
 * place, and anything else — a code outside the table, a status without a
 * code, a fetch that threw — goes to the MANDATORY default branch: "Unexpected
 * error — the server answered {status} {code}" with Try again · Copy the
 * details, the technical text folded. There is no path that renders nothing.
 *
 *   refusalOf(errOrBody, status?) → { code, status, message, details } — the
 *       envelope normalised: the code is `body.code ?? body.error` when it is
 *       an UPPER_SNAKE code (the API answers `{ error: CODE, message, …details }`
 *       from services/refusal, `{ error: <phrase>, code: CODE }` from
 *       _editCore, or a bare 400/404 without a code), the status is the one the
 *       response carried (never guessed), the details are the body's fields
 *   readRefusal(res) → Promise of refusalOf(body, res.status) for a fetch
 *       Response that is not ok (a body that is not JSON keeps the status)
 *   refusalToAction(refusal, t) → { code, status, known, kind, title, body,
 *       actions: [{ id, label }], focus: "name" | "items" | null, detail,
 *       retryable }
 *
 * The action ids are what a host handles (RefusalNotice's `onAction`):
 * retry · copy · notifyAdmin · requestAccess · focusName · focusItems ·
 * backToChange · backToDesign · resimulate · answer · editOperation ·
 * enterEdit · resume · signIn · seeOffers · byHand · askAdmin · showIssues · repair · deliver · reload · keepMine · myWork ·
 * openContract (back to ②, the contract) · submitApproval (⑤'s « Soumettre à
 * l'approbation »). `copy` is handled by the notice
 * itself; a host lists the others it supports and the notice shows only
 * those (plus the default branch's retry when the host can retry).
 */

import { humanError, REFUSAL_CODES_WITH_TEXT } from "./humanError";

const CODE_RE = /^[A-Z][A-Z0-9_]{2,}$/;
const MAX_DETAIL = 1200;

const codeOf = (v) => (typeof v === "string" && CODE_RE.test(v.trim()) && !/^HTTP_\d{3}$/.test(v.trim()) ? v.trim() : null);

/**
 * The actions in place of each refusal, primary first. A code absent
 * from this table but present in the refusal table gets its sentence and the
 * default actions; a code absent from both is the default branch.
 */
const ACTIONS = {
  VALIDATOR_UNAVAILABLE: ["retry", "notifyAdmin"],
  VALIDATOR_FAILED: ["retry", "copy"],
  VALIDATION_ERRORS: ["repair", "copy"],
  VALIDATION_NEW_ERRORS: ["backToChange"],
  ACKNOWLEDGEMENT_UNNAMED: ["focusName"],
  INVALID_INPUT: ["retry", "copy"],
  CLAUSES_FAILING: ["focusItems"],
  CLAUSES_UNKNOWN: ["focusItems"],
  SOURCES_UNVERIFIED: ["focusItems"],
  ASSUMPTIONS_UNVALIDATED: ["focusItems"],
  REQUIREMENTS_UNCOVERED: ["openContract"],
  // No ready contract → ② decides it; the reference GTFS's own errors are accepted by name in the form.
  CONTRACT_REQUIRED: ["openContract"],
  BASELINE_ERRORS: ["focusItems"],
  OPEN_ITEMS_UNACCEPTED: ["focusItems", "copy"],
  PLAN_BLOCKED: ["answer"],
  INTEGRITY_FAILED: ["editOperation"],
  PREVIEW_STALE: ["resimulate"],
  PREVIEW_NOT_FOUND: ["resimulate"],
  PLAN_TOO_LARGE: ["copy"],
  PLAN_LIMIT: ["seeOffers"],
  SPEC_INVALID: ["showIssues"],
  SIMPLIFIED_BASELINE: ["backToDesign"],
  BUILD_EDITED: ["deliver"],
  ENTITLEMENT_REQUIRED: ["askAdmin", "byHand"],
  NOT_SIGNED_IN: ["signIn"],
  SESSION_NOT_IN_EDIT_MODE: ["enterEdit"],
  NO_FEED_LOADED: ["resume"],
  NO_SESSION: ["resume"],
  SESSION_NOT_FOUND: ["resume"],
  INVALID_SESSION: ["resume"],
  NL2SQL_CHAT_DISABLED: ["byHand"],
  FREE_QUOTA_EXHAUSTED: ["seeOffers", "byHand"],
  RATE_LIMITED: ["retry", "byHand"],
  DAILY_LIMIT_REACHED: ["retry", "byHand"],
  BUDGET_EXHAUSTED: ["byHand"],
  // The project changed elsewhere: take the other copy, or write this one over it (journaled).
  AUTOSAVE_CONFLICT: ["reload", "keepMine"],
  // The server refused to keep a project: make room among the works (delete one there), or try again.
  TOO_MANY_PROJECTS: ["myWork", "retry"],
  // The coherence report's rows as clauses: read the report again; the contract is full — ② makes
  // room; the contract is a draft — ② decides it first.
  CONTRACT_UNDECIDED: ["openContract"],
  COHERENCE_STALE: ["reload"],
  COHERENCE_ROW_UNKNOWN: ["reload", "copy"],
  TOO_MANY_CLAUSES: ["openContract"],
  // A project only a browser holds is attached from Home (« Mes travaux ») before it is shared or submitted;
  // a package past its 24 hours is built again.
  PROJECT_NOT_ATTACHED: ["myWork"],
  PACKAGE_NOT_FOUND: ["retry"],
  // The approval moved elsewhere (another approver, another tab): the project read again shows where it stands; a
  // version not approved is submitted; a role that changed is read again too. A version frozen already: read again.
  INVALID_TRANSITION: ["reload"],
  NOT_APPROVED: ["submitApproval", "reload"],
  ROLE_REQUIRED: ["copy", "reload"],
  VERSION_FROZEN: ["reload"],
  // The paid offer: the plans (the paywall opens them too); the payment service again; the operator's address.
  SUBSCRIPTION_REQUIRED: ["seeOffers"],
  AI_ALLOWANCE_EXHAUSTED: ["seeOffers", "byHand"],
  SUBSCRIPTION_NOT_FOUND: ["seeOffers"],
  BILLING_PROVIDER_ERROR: ["retry", "copy"],
  BILLING_UNAVAILABLE: ["requestAccess"],
};
const DEFAULT_ACTIONS = ["retry", "copy"];

// Where the focus goes after the refusal, when not on the notice itself.
const FOCUS = { ACKNOWLEDGEMENT_UNNAMED: "name", CLAUSES_FAILING: "items", CLAUSES_UNKNOWN: "items", SOURCES_UNVERIFIED: "items", ASSUMPTIONS_UNVALIDATED: "items", BASELINE_ERRORS: "items", OPEN_ITEMS_UNACCEPTED: "items" };

// The label of an action: the code's own `refusal.<CODE>.action` for its primary action, else a shared word.
const LABELS = {
  retry: "refusal.default.action",
  copy: "refusal.copyDetail",
  notifyAdmin: "gtfsCheck.notifyAdmin",
  requestAccess: "access.request",
  seeOffers: "access.seeOffers",
  byHand: "access.byHand",
  signIn: "status.user.signIn",
  backToChange: "ack.backToChange",
  backToDesign: "ack.backToDesign",
  resume: "recovery.resume",
  repair: "gtfsCheck.fix",
  deliver: "status.deliver",
  keepMine: "refusal.AUTOSAVE_CONFLICT.keep",
  myWork: "home.projects",
  reload: "refusal.AUTOSAVE_CONFLICT.action",
  submitApproval: "approval.submit",
};

/** Any thrown value, API body or event payload → { code, status, message, details }. */
export const refusalOf = (err, status = null) => {
  if (err == null) return { code: null, status: Number.isFinite(status) ? status : null, message: "", details: {} };
  if (typeof err === "string") return { code: codeOf(err), status: Number.isFinite(status) ? status : null, message: codeOf(err) ? "" : err, details: {} };
  const body = err.body && typeof err.body === "object" ? err.body : err;
  const code = codeOf(body.code) || codeOf(body.error) || codeOf(err.code) || codeOf(err.error) || null;
  const st = Number.isFinite(status) ? status : Number.isFinite(err.status) ? err.status : Number.isFinite(body.status) ? body.status : null;
  const phrase = [body.message, typeof body.error === "string" && !codeOf(body.error) ? body.error : null, err.message].find((v) => typeof v === "string" && v && !codeOf(v) && !/^HTTP \d{3}$/.test(v));
  // The details are the body's other fields (services/refusal spreads them next to `error` and `message`).
  const rest = Object.fromEntries(Object.entries(body && typeof body === "object" ? body : {}).filter(([k]) => !["error", "code", "message", "status", "body", "stack"].includes(k)));
  const details = err.details && typeof err.details === "object" ? { ...rest, ...err.details } : rest;
  return { code, status: st, message: phrase || "", details };
};

/** A fetch Response that is not ok → its refusal (the status read on the response itself). */
export const readRefusal = async (res) => {
  const body = await res.json().catch(() => null);
  return refusalOf(body && typeof body === "object" ? body : { message: "" }, res.status);
};

const detailText = (r) => {
  const head = [r.code, r.status ? `HTTP ${r.status}` : null, r.message].filter(Boolean).join(" · ");
  let extra = "";
  try {
    extra = r.details && Object.keys(r.details).length ? JSON.stringify(r.details) : "";
  } catch {
    extra = "";
  }
  const text = [head, extra].filter(Boolean).join("\n");
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
};

/** The refusal in the reader's words, with its actions in place; the default branch for anything else. */
export const refusalToAction = (input, t) => {
  const r = input && typeof input === "object" && "details" in input && "code" in input && !(input instanceof Error) ? input : refusalOf(input);
  const known = Boolean(r.code && REFUSAL_CODES_WITH_TEXT.has(r.code));
  const detail = detailText(r);
  if (!known) {
    // The default branch: a code outside the table, a status without a code, a fetch that threw — never a blank.
    const body = r.status ? t("refusal.default.body", { status: r.status, code: r.code || "" }).replace(/\s+\./, ".") : t("refusal.default.noResponse");
    return { code: r.code, status: r.status, known: false, kind: "unknown", title: t("refusal.default.title"), body, actions: DEFAULT_ACTIONS.map((id) => ({ id, label: t(LABELS[id]) })), focus: null, detail, retryable: true, details: r.details };
  }
  const human = humanError({ code: r.code, status: r.status, message: r.message, body: { ...r.details, error: r.code } }, t);
  const ids = ACTIONS[r.code] || DEFAULT_ACTIONS;
  const primaryLabel = t(`refusal.${r.code}.action`, { ...r.details });
  const actions = ids.map((id, i) => ({ id, label: i === 0 && !["retry", "copy"].includes(id) ? primaryLabel : t(LABELS[id] || `refusal.${r.code}.action`) }));
  return { code: r.code, status: r.status, known: true, kind: human.kind, title: human.title, body: human.message, actions, focus: FOCUS[r.code] || null, detail, retryable: Boolean(human.retryable), details: r.details };
};

export default refusalToAction;
