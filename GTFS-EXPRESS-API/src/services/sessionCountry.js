/**
 * A session's country and school region, when known. Every validation of the session passes the country to the
 * canonical validator (`-c`), which applies that country's rules (phone numbers, for one).
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

/** Lowercase ISO 3166-1 alpha-2, or null. */
const sessionCountryCode = (sessionId) => {
  if (!sessionId) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(GTFS_UPLOAD_DIR, sessionId, "_session_meta.json"), "utf8"));
    return normalizeCountryCode(meta.country_code);
  } catch {
    return null;
  }
};

// The place the catalogue was searched for (a région, a zone letter): without it, a regional country's school
// periods are asked of the person.
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
