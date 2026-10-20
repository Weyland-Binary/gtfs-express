/**
 * trialWork — the networks changed under the free trial, which the trial lets one try but not take away (every
 * feature is open during the trial except getting the modified GTFS out, so that collecting e-mail addresses buys
 * nothing).
 *
 * A working copy (a session) changed by a request of a trial licence is marked by a file beside its database
 * (MARK), so that the mark lives and dies with the copy and still holds once the person has signed out; a copy a
 * trial request creates (a network built, a version restored) is marked from the answer's `sessionId`.
 *
 * The exits ask two things (services/paidAccess.js): the paid exits (the GTFS export, the built network's zip,
 * the delivery package, its marking and its download, a previewed plan's change list) are closed to a trial licence whatever the copy; the free exits (a share link and its new versions, the SQL console's CSV) are
 * closed for a marked copy unless the account's licence is not a trial — a subscription, the administrator's grant,
 * the operator. The work done during the trial is kept: it leaves once the licence is taken.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { GTFS_UPLOAD_DIR, validateSessionId } = require("./sessionManager");

const MARK = ".trial-work";

/** The request comes from an account whose running licence is the free trial (nothing better). */
const isTrial = (req) => Boolean(req && req.user && req.user.licence && req.user.licence.active && req.user.licence.source === "trial");

/** The request comes from an account holding a licence that delivers (any running source but the trial). */
const holdsDelivery = (req) => Boolean(req && req.user && req.user.licence && req.user.licence.active && req.user.licence.source !== "trial");

const markPath = (sessionId) => (validateSessionId(sessionId) ? path.join(GTFS_UPLOAD_DIR, sessionId, MARK) : null);

/** Mark a working copy as changed under the trial; false when it is not a copy of this server. */
const markSession = (sessionId) => {
  const file = markPath(sessionId);
  if (!file || !fs.existsSync(path.dirname(file))) return false;
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, new Date().toISOString(), "utf8");
    return true;
  } catch {
    return false;
  }
};

/** Whether a working copy was changed under the trial. */
const isMarked = (sessionId) => {
  const file = markPath(sessionId);
  return Boolean(file && fs.existsSync(file));
};

module.exports = { MARK, isTrial, holdsDelivery, markSession, isMarked };
