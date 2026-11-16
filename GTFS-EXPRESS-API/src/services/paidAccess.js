/**
 * The paid offer's rule (PAID_ACCESS_ENABLED): reading is free; editing ("edit") and the Change Studio and project
 * work ("studio") need the entitlement. Checked on every request, so a licence that ends closes them on the next one.
 * The trial opens both, the export of a modified network included.
 */

"use strict";

const config = require("../config");

// Routes of the studio's paths that also serve reading (method, path within /gtfs).
const READ_ROUTES = Object.freeze([
  ["GET", /^\/network\/catalog$/],
  ["POST", /^\/network\/catalog\/open$/],
  ["GET", /^\/network\/coherence(\.xlsx|\.pdf)?$/],
  // The same report with its clauses in the body: a read despite the POST.
  ["POST", /^\/network\/coherence(\.xlsx|\.pdf)?$/],
  ["GET", /^\/transform\/(operations|overview|quality)$/],
]);
const STUDIO_PATHS = /^\/(network|transform)(\/|$)/;
// The project's work in the workspace (method, path within /gtfs).
const WORKSPACE_WORK = Object.freeze([
  ["POST", /^\/workspace\/projects$/],
  ["PATCH", /^\/workspace\/projects\/[^/]+$/],
  ["POST", /^\/workspace\/projects\/[^/]+\/versions$/],
  ["POST", /^\/workspace\/projects\/[^/]+\/versions\/[^/]+\/(restore|package|delivered)$/],
  ["POST", /^\/workspace\/projects\/[^/]+\/network\/from-version$/],
  ["POST", /^\/workspace\/projects\/[^/]+\/take$/],
  ["POST", /^\/workspace\/projects\/[^/]+\/documents$/],
  ["POST", /^\/workspace\/projects\/[^/]+\/aggregate(\/|$)/],
  ["DELETE", /^\/workspace\/projects\/[^/]+\/aggregate(\/|$)/],
]);
// Documents read freely whose file is the licence's.
const DOCUMENT_FILES = Object.freeze([["POST", /^\/documents\/offer\/xlsx$/]]);
// Under /edit, what does not change the network: validating it, leaving edit mode.
const EDIT_FREE_WRITES = /^\/edit\/(validate|validate\.canonical|exit)$/;
// Under /edit, the reads that deliver an edited network.
const EDIT_DELIVERIES = /^\/edit\/export$/;

// The router answers HEAD with its GET handlers: a HEAD is the GET it runs.
const matches = (list, method, path) => {
  const m = method === "HEAD" ? "GET" : method;
  const p = routedPath(path);
  return list.some(([rm, re]) => rm === m && re.test(p));
};

// Express routes case-insensitively with an optional trailing slash, so /Edit/export/ reaches the export handler:
// the rule must read the same path, or such spellings would bypass the paid offer.
const routedPath = (path) => String(path || "").toLowerCase().replace(/\/+$/, "") || "/";

const isPaidModel = () => Boolean(config.PAID_ACCESS_ENABLED);

/** The entitlement a request needs under the paid offer: "edit", "studio" or null (free). */
const needOf = (method, path) => {
  const m = String(method || "GET").toUpperCase();
  const p = routedPath(path);
  if (STUDIO_PATHS.test(p)) return matches(READ_ROUTES, m, p) ? null : "studio";
  if (matches(WORKSPACE_WORK, m, p) || matches(DOCUMENT_FILES, m, p)) return "studio";
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

const paidAccessGuard = (req, res, next) => {
  if (!isPaidModel()) return next();
  const need = needOf(req.method, req.path);
  if (!need) return next();
  const state = paidStateOf(req, need);
  if (state === "ok") return next();
  if (state === "unavailable") {
    return res.status(503).json({ error: "ACCOUNTS_DISABLED", message: "The paid features need user accounts, which are off on this server." });
  }
  if (state === "sign_in_required") {
    return res.status(401).json({ error: "NOT_SIGNED_IN", message: "Sign in to continue: this feature is part of the licence.", entitlement: need, paid: true });
  }
  return res.status(402).json({
    error: "SUBSCRIPTION_REQUIRED",
    message: "Changing a network is part of the licence.",
    entitlement: need,
  });
};

module.exports = { isPaidModel, needOf, paidStateOf, paidAccessGuard, routedPath, _internals: { READ_ROUTES, STUDIO_PATHS, WORKSPACE_WORK } };
