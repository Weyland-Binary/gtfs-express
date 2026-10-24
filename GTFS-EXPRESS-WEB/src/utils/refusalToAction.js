/**
 * A server refusal → its title, sentence and one or two actions in place. Anything outside the refusal
 * table (an unknown code, a status without a code, a fetch that threw) goes to the default branch with
 * retry and copy: no path renders nothing. A host handles the action ids it supports; the notice handles `copy`.
 */

import { humanError, hasRefusalText, isTechnical } from "./humanError";

const CODE_RE = /^[A-Z][A-Z0-9_]{2,}$/;
const MAX_DETAIL = 1200;

const codeOf = (v) => (typeof v === "string" && CODE_RE.test(v.trim()) && !/^HTTP_\d{3}$/.test(v.trim()) ? v.trim() : null);

// Primary first. A refusal-table code absent here gets its sentence with the default actions.
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
  BASELINE_ERRORS: ["focusItems"],
  CURRENT_ERRORS: ["focusItems"],
  OPEN_ITEMS_UNACCEPTED: ["focusItems", "copy"],
  PLAN_BLOCKED: ["answer"],
  INTEGRITY_FAILED: ["editOperation"],
  PREVIEW_STALE: ["resimulate"],
  PREVIEW_NOT_FOUND: ["resimulate"],
  PLAN_TOO_LARGE: ["copy"],
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
  AI_BUDGET_EXHAUSTED: ["byHand"],
  // Take the other copy, or write this one over it (journaled).
  AUTOSAVE_CONFLICT: ["reload", "keepMine"],
  TOO_MANY_PROJECTS: ["myWork", "retry"],
  COHERENCE_STALE: ["reload"],
  TOO_MANY_CLAUSES: ["copy"],
  // A project only a browser holds is attached from Home before it is shared or submitted.
  PROJECT_NOT_ATTACHED: ["myWork"],
  PACKAGE_NOT_FOUND: ["retry"],
  INVALID_TRANSITION: ["reload"],
  NOT_APPROVED: ["submitApproval", "reload"],
  ROLE_REQUIRED: ["copy", "reload"],
  VERSION_FROZEN: ["reload"],
  SUBSCRIPTION_REQUIRED: ["seeOffers"],
  AI_ALLOWANCE_EXHAUSTED: ["seeOffers", "byHand"],
  SUBSCRIPTION_NOT_FOUND: ["seeOffers"],
  BILLING_PROVIDER_ERROR: ["retry", "copy"],
  BILLING_UNAVAILABLE: ["requestAccess"],
  // A working copy with its draft open is edited in the draft; a draft is delivered once applied.
  DRAFT_OPEN: ["goDraft"],
  DRAFT_NOT_APPLIED: ["openDecision"],
};
const DEFAULT_ACTIONS = ["retry", "copy"];

// Where the focus goes after the refusal, when not on the notice itself.
const FOCUS = { ACKNOWLEDGEMENT_UNNAMED: "name", CLAUSES_FAILING: "items", CLAUSES_UNKNOWN: "items", SOURCES_UNVERIFIED: "items", BASELINE_ERRORS: "items", CURRENT_ERRORS: "items", OPEN_ITEMS_UNACCEPTED: "items" };

// A primary action takes the code's own `refusal.<CODE>.action`; the others take these shared labels.
const LABELS = {
  retry: "refusal.default.action",
  copy: "refusal.copyDetail",
  notifyAdmin: "gtfsCheck.notifyAdmin",
  requestAccess: "access.request",
  seeOffers: "access.seeOffers",
  byHand: "access.byHand",
  signIn: "status.user.signIn",
  backToChange: "ack.backToChange",
  resume: "recovery.resume",
  repair: "gtfsCheck.fix",
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
  // The server spreads the details next to `error` and `message`.
  const rest = Object.fromEntries(Object.entries(body && typeof body === "object" ? body : {}).filter(([k]) => !["error", "code", "message", "status", "body", "stack"].includes(k)));
  const details = err.details && typeof err.details === "object" ? { ...rest, ...err.details } : rest;
  return { code, status: st, message: phrase || "", details };
};

/** A body that is not JSON keeps the response's status. */
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

export const refusalToAction = (input, t) => {
  const r = input && typeof input === "object" && "details" in input && "code" in input && !(input instanceof Error) ? input : refusalOf(input);
  const known = hasRefusalText(r.code, t);
  const detail = detailText(r);
  if (!known) {
    // A server code with no text yet keeps the server's sentence over « the server answered 409 ».
    const body = r.code && r.message && r.status >= 400 && r.status < 500 && !isTechnical(r.message) ? r.message : r.status ? t("refusal.default.body", { status: r.status, code: r.code || "" }).replace(/\s+\./, ".") : t("refusal.default.noResponse");
    return { code: r.code, status: r.status, known: false, kind: "unknown", title: t("refusal.default.title"), body, actions: DEFAULT_ACTIONS.map((id) => ({ id, label: t(LABELS[id]) })), focus: null, detail, retryable: true, details: r.details };
  }
  const human = humanError({ code: r.code, status: r.status, message: r.message, body: { ...r.details, error: r.code } }, t);
  const ids = ACTIONS[r.code] || DEFAULT_ACTIONS;
  const primaryLabel = t(`refusal.${r.code}.action`, { ...r.details });
  const actions = ids.map((id, i) => ({ id, label: i === 0 && !["retry", "copy"].includes(id) ? primaryLabel : t(LABELS[id] || `refusal.${r.code}.action`) }));
  return { code: r.code, status: r.status, known: true, kind: human.kind, title: human.title, body: human.message, actions, focus: FOCUS[r.code] || null, detail, retryable: Boolean(human.retryable), details: r.details };
};

export default refusalToAction;
