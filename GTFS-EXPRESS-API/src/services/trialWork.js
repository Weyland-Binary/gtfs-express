/**
 * The working copies changed under the free trial, which tries everything but lets no modified network leave it.
 * The mark is a file beside the copy's database, so it lives and dies with the copy and holds after sign-out.
 * services/paidAccess.js closes the paid exits to a trial licence, and the free ones (share, SQL console CSV) of a
 * marked copy to any account without a delivering licence.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { GTFS_UPLOAD_DIR, validateSessionId } = require("./sessionManager");

const MARK = ".trial-work";

const isTrial = (req) => Boolean(req && req.user && req.user.licence && req.user.licence.active && req.user.licence.source === "trial");

const holdsDelivery = (req) => Boolean(req && req.user && req.user.licence && req.user.licence.active && req.user.licence.source !== "trial");

const markPath = (sessionId) => (validateSessionId(sessionId) ? path.join(GTFS_UPLOAD_DIR, sessionId, MARK) : null);

/** False when the session is not a working copy of this server. */
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

const isMarked = (sessionId) => {
  const file = markPath(sessionId);
  return Boolean(file && fs.existsSync(file));
};

module.exports = { MARK, isTrial, holdsDelivery, markSession, isMarked };
