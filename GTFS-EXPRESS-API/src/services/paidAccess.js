/**
 * paidAccess — the paid offer's rule, in one place (PAID_ACCESS_ENABLED).
 *
 * Reading stays free: exploring a network, validating it, sharing it,
 * opening a public feed, reading the coherence report.
 * Two things are paid, and need an account that holds the entitlement —
 * from an active subscription (billing/billingService) or granted by the
 * administrator (accounts/store.effectiveEntitlements):
 *
 *   edit    editing the open network (entering edit mode, every change made
 *           under /edit) and delivering an edited one (GET /edit/export)
 *   studio  the Network Studio, create and modify, with or without the
 *           assistant: every /network, /transform, /contract and
 *           /spreadsheet route, except the few that serve reading too (the
 *           public feeds' catalogue and opening one, the coherence report,
 *           the open network's operations, overview and health) — and the
 *           project's work in the workspace: creating a project, saving it,
 *           freezing or restoring a version, adding a document, building
 *           and marking the delivery package. Reading a project, approving
 *           a version (an approver needs no subscription), deleting what one
 *           owns and the workspace token stay free.
 *
 * The rule is checked on EVERY request (paidAccessGuard, mounted first on
 * the router), never only at the entry: a subscription that ends closes edit
 * mode and the studio on the next change, whatever session was open.
 *
 *   401 NOT_SIGNED_IN { entitlement, paid: true }     no account
 *   402 SUBSCRIPTION_REQUIRED { entitlement }          an account without it
 *   503 ACCOUNTS_DISABLED                               the paid offer on a
 *                                                       server without accounts
 *
 * The free trial opens both, but never lets the modified network out
 * (services/trialWork.js): the paid exits
 * (EXITS: the GTFS export, the built network's zip, the delivery package, its
 * marking and its download, a previewed plan's change list as CSV or JSON) answer
 * a trial licence 402 TRIAL_NO_DELIVERY { entitlement: "deliver" }; a working
 * copy a trial request changes is marked, and the free exits (MARKED_EXITS:
 * a share link and its new versions, the SQL console's CSV) refuse a
 * marked copy the same way unless the account's licence is not a trial.
 *
 * `paidStateOf(req, entitlement)` is what GET /config/features announces
 * before any work (accessService): "ok" | "sign_in_required" |
 * "subscription_required" | "unavailable". With the flag off nothing here
 * applies: the guard lets every request through.
 */

"use strict";

const config = require("../config");
const trialWork = require("./trialWork");

// Routes of the studio's paths that also serve reading (method, path within /gtfs).
const READ_ROUTES = Object.freeze([
  ["GET", /^\/network\/catalog$/],
  ["POST", /^\/network\/catalog\/open$/],
  ["GET", /^\/network\/coherence(\.xlsx|\.pdf)?$/],
  // The same report with a long contract's clauses in the body: a read whatever the transport.
  ["POST", /^\/network\/coherence(\.xlsx|\.pdf)?$/],
  ["GET", /^\/transform\/(operations|overview|quality)$/],
]);
const STUDIO_PATHS = /^\/(network|transform|contract|spreadsheet)(\/|$)/;
// The project's work in the workspace (method, path within /gtfs).
const WORKSPACE_WORK = Object.freeze([
  ["POST", /^\/workspace\/projects$/],
  ["PATCH", /^\/workspace\/projects\/[^/]+$/],
  ["POST", /^\/workspace\/projects\/[^/]+\/versions$/],
  ["POST", /^\/workspace\/projects\/[^/]+\/versions\/[^/]+\/(restore|package|delivered)$/],
  ["POST", /^\/workspace\/projects\/[^/]+\/documents$/],
]);
// Under /edit, what does not change the network: validating it, leaving edit mode.
const EDIT_FREE_WRITES = /^\/edit\/(validate|validate\.canonical|exit)$/;
// Under /edit, the reads that deliver an edited network.
const EDIT_DELIVERIES = /^\/edit\/export$/;

// The paid exits of a modified network (method, path within /gtfs): closed to a trial licence.
const EXITS = Object.freeze([
  ["GET", /^\/edit\/export$/],
  ["GET", /^\/network\/[^/]+\/export\.zip$/],
  ["POST", /^\/workspace\/projects\/[^/]+\/versions\/[^/]+\/(package|delivered)$/],
  // What carries the modified network out without being a GTFS: a package built by another member of a shared
  // project, and the change list of a previewed plan as CSV or JSON.
  ["GET", /^\/workspace\/projects\/[^/]+\/packages\/[^/]+$/],
  ["GET", /^\/transform\/preview\/[^/]+\/gtfs-diff\/[^/]+$/],
]);
// The free exits of the open network: closed for a copy changed under the trial.
const MARKED_EXITS = Object.freeze([
  ["POST", /^\/share$/],
  ["POST", /^\/share\/[^/]+\/versions$/],
  ["POST", /^\/sql\/export\.csv$/],
]);
// The router answers HEAD with its GET handlers: a HEAD is the GET it runs.
const matches = (list, method, path) => {
  const m = method === "HEAD" ? "GET" : method;
  const p = routedPath(path);
  return list.some(([rm, re]) => rm === m && re.test(p));
};

/**
 * The path as the router matches it. Express 4 routes without regard to case
 * and with an optional trailing slash (the router's defaults, kept: the web and
 * the deep links rely on them), so /Edit/export and /edit/export/ reach the
 * export handler; the rule reads the same path, or those spellings would pass
 * it unchecked (a bypass of the paid offer). The lists above
 * are written in lower case without a trailing slash.
 */
const routedPath = (path) => String(path || "").toLowerCase().replace(/\/+$/, "") || "/";

const isPaidModel = () => Boolean(config.PAID_ACCESS_ENABLED);

/** The entitlement a request needs under the paid offer: "edit", "studio" or null (free). */
const needOf = (method, path) => {
  const m = String(method || "GET").toUpperCase();
  const p = routedPath(path);
  if (STUDIO_PATHS.test(p)) return matches(READ_ROUTES, m, p) ? null : "studio";
  if (matches(WORKSPACE_WORK, m, p)) return "studio";
  if (!p.startsWith("/edit/")) return null;
  if (m === "GET" || m === "HEAD") return EDIT_DELIVERIES.test(p) ? "edit" : null;
  return EDIT_FREE_WRITES.test(p) ? null : "edit";
};

/** What a request holds of a paid entitlement: "ok" | "sign_in_required" | "subscription_required" | "unavailable". */
const paidStateOf = (req, entitlement) => {
  if (!config.ACCOUNTS_ENABLED) return "unavailable";
  if (!req || !req.user) return "sign_in_required";
  return Array.isArray(req.user.entitlements) && req.user.entitlements.includes(entitlement) ? "ok" : "subscription_required";
};

const refuseTrialDelivery = (res) =>
  res.status(402).json({
    error: "TRIAL_NO_DELIVERY",
    message: "The free trial lets you try everything but not take the modified network away: take the licence to export it (the work done is kept).",
    entitlement: "deliver",
  });

/**
 * A trial request that changes a network: its working copy is marked, and so is a copy its answer creates (a
 * network built, a version restored, a feed opened for the change).
 */
const markTrialWork = (req, res) => {
  trialWork.markSession(req.headers["x-session-id"]);
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body.sessionId === "string") trialWork.markSession(body.sessionId);
    return json(body);
  };
};

/** The router's first middleware: a pass-through unless the paid offer is on and the route needs an entitlement. */
const paidAccessGuard = (req, res, next) => {
  if (!isPaidModel()) return next();
  const method = String(req.method || "GET").toUpperCase();
  // A copy changed under the trial leaves by no free exit but for a licence that delivers.
  if (matches(MARKED_EXITS, method, req.path) && trialWork.isMarked(req.headers["x-session-id"]) && !trialWork.holdsDelivery(req)) return refuseTrialDelivery(res);
  // The paid exits are closed to the trial, whatever the copy.
  if (trialWork.isTrial(req) && matches(EXITS, method, req.path)) return refuseTrialDelivery(res);
  const need = needOf(req.method, req.path);
  if (!need) return next();
  const state = paidStateOf(req, need);
  if (state === "ok") {
    if (trialWork.isTrial(req) && method !== "GET" && method !== "HEAD") markTrialWork(req, res);
    return next();
  }
  if (state === "unavailable") {
    return res.status(503).json({ error: "ACCOUNTS_DISABLED", message: "The paid features need user accounts, which are off on this server." });
  }
  if (state === "sign_in_required") {
    return res.status(401).json({ error: "NOT_SIGNED_IN", message: "Sign in to continue: this feature is part of the licence.", entitlement: need, paid: true });
  }
  return res.status(402).json({
    error: "SUBSCRIPTION_REQUIRED",
    message: need === "studio" && config.NETWORK_STUDIO_ENABLED ? "The Network Studio is part of the licence." : "Changing a network is part of the licence.",
    entitlement: need,
  });
};

module.exports = { isPaidModel, needOf, paidStateOf, paidAccessGuard, routedPath, _internals: { READ_ROUTES, STUDIO_PATHS, WORKSPACE_WORK, EXITS, MARKED_EXITS } };
