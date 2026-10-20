/**
 * sessionCountry — the ISO country of a session's network, when known (a
 * network built in the Studio on a territory). The canonical validator
 * takes it (`-c`) to apply the country's rules, e.g. phone numbers; every
 * validation of the session — build, re-validation, export — passes it.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { GTFS_UPLOAD_DIR } = require("./sessionManager");

const CC_RE = /^[a-z]{2}$/;

const normalizeCountryCode = (raw) => {
  const cc = String(raw || "").trim().toLowerCase();
  return CC_RE.test(cc) ? cc : null;
};

/** The session's country code (lowercase ISO 3166-1 alpha-2) or null. */
const sessionCountryCode = (sessionId) => {
  if (!sessionId) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(GTFS_UPLOAD_DIR, sessionId, "_session_meta.json"), "utf8"));
    return normalizeCountryCode(meta.country_code);
  } catch {
    return null;
  }
};

/**
 * The school region of a session's network (a French région by name, a zone letter…), when known: the place the
 * catalogue was searched for names it. The engine resolves the school periods with it (calendars.named); without
 * it, a regional country's school periods are asked.
 */
const sessionSchoolRegion = (sessionId) => {
  if (!sessionId) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(GTFS_UPLOAD_DIR, sessionId, "_session_meta.json"), "utf8"));
    const r = typeof meta.school_region === "string" ? meta.school_region.trim() : "";
    return r ? r.slice(0, 80) : null;
  } catch {
    return null;
  }
};

module.exports = { sessionCountryCode, normalizeCountryCode, sessionSchoolRegion };
