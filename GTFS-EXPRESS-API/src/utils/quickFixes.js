/**
 * Validation rules repaired automatically. Each `scan(db)` reads the live edit database
 * (the validator's report lacks the original values, and rows may have changed since)
 * and proposes only safe repairs: [{ id, current, patch }].
 */

const { _STOP_NAME_REQUIRED_TYPES, _resolveLocationType } = require("./fieldValidators");

const HEX_COLOR_RE = /^[0-9A-Fa-f]{6}$/;

// Local rather than shared with the validator, to avoid a circular dependency.
const _tzCache = new Map();
const isValidIanaTimezone = (tz) => {
  if (!tz || typeof tz !== "string") return false;
  const key = tz.trim();
  if (key === "") return false;
  if (_tzCache.has(key)) return _tzCache.get(key);
  let ok = false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: key });
    ok = true;
  } catch (_) {
    ok = false;
  }
  _tzCache.set(key, ok);
  return ok;
};

/** A loosely cased IANA zone ("europe/paris") in its canonical form, else null. */
const normalizeIanaTimezone = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (typeof Intl.supportedValuesOf === "function") {
    const all = Intl.supportedValuesOf("timeZone");
    const hit = all.find((tz) => tz.toLowerCase() === trimmed.toLowerCase());
    if (hit && hit !== raw) return hit;
  }
  const titleCase = (s) =>
    s
      .split(/([_\- ])/g)
      .map((part) =>
        /^[_\- ]$/.test(part)
          ? part
          : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
      )
      .join("");
  const normalized = trimmed
    .split("/")
    .map((seg) => titleCase(seg))
    .join("/");
  if (normalized !== raw && isValidIanaTimezone(normalized)) return normalized;
  return null;
};

const scanInvalidColor = (db) => {
  const rows = db
    .prepare(
      "SELECT route_id, route_color, route_text_color FROM routes " +
        "WHERE (route_color IS NOT NULL AND route_color != '') " +
        "   OR (route_text_color IS NOT NULL AND route_text_color != '')",
    )
    .all();
  const proposals = [];
  for (const r of rows) {
    const current = {};
    const patch = {};
    for (const col of ["route_color", "route_text_color"]) {
      const raw = r[col];
      if (raw == null || raw === "") continue;
      // Hex is case-insensitive in the spec: a value that already passes is never touched.
      if (HEX_COLOR_RE.test(String(raw))) continue;
      const cleaned = String(raw).trim().replace(/^#/, "").toUpperCase();
      if (HEX_COLOR_RE.test(cleaned)) {
        current[col] = raw;
        patch[col] = cleaned;
      }
    }
    if (Object.keys(patch).length > 0) {
      proposals.push({ id: r.route_id, current, patch });
    }
  }
  return proposals;
};

const ROUTE_SHORT_NAME_MAX = 12;

const scanRouteShortNameTooLong = (db) => {
  const rows = db
    .prepare(
      "SELECT route_id, route_short_name FROM routes " +
        "WHERE route_short_name IS NOT NULL AND LENGTH(route_short_name) > ?",
    )
    .all(ROUTE_SHORT_NAME_MAX);
  return rows.map((r) => ({
    id: r.route_id,
    current: { route_short_name: r.route_short_name },
    patch: {
      route_short_name: String(r.route_short_name).slice(0, ROUTE_SHORT_NAME_MAX),
    },
  }));
};

const scanSameNameAndDescriptionForRoute = (db) => {
  const rows = db
    .prepare(
      "SELECT route_id, route_short_name, route_long_name, route_desc " +
        "FROM routes WHERE route_desc IS NOT NULL AND route_desc != ''",
    )
    .all();
  const proposals = [];
  for (const r of rows) {
    const desc = String(r.route_desc || "").trim();
    if (!desc) continue;
    const short = String(r.route_short_name || "").trim();
    const long = String(r.route_long_name || "").trim();
    if (desc === short || desc === long) {
      proposals.push({
        id: r.route_id,
        current: { route_desc: r.route_desc },
        patch: { route_desc: null },
      });
    }
  }
  return proposals;
};

const scanSameNameAndDescriptionForStop = (db) => {
  const rows = db
    .prepare(
      "SELECT stop_id, stop_name, stop_desc FROM stops " +
        "WHERE stop_desc IS NOT NULL AND stop_desc != ''",
    )
    .all();
  const proposals = [];
  for (const r of rows) {
    const desc = String(r.stop_desc || "").trim();
    const name = String(r.stop_name || "").trim();
    if (desc && name && desc === name) {
      proposals.push({
        id: r.stop_id,
        current: { stop_desc: r.stop_desc },
        patch: { stop_desc: null },
      });
    }
  }
  return proposals;
};

const scanInvalidTimezone = (db) => {
  const proposals = [];
  const agencies = db
    .prepare(
      "SELECT agency_id, agency_timezone FROM agency " +
        "WHERE agency_timezone IS NOT NULL AND agency_timezone != ''",
    )
    .all();
  for (const a of agencies) {
    if (isValidIanaTimezone(a.agency_timezone)) continue;
    const fixed = normalizeIanaTimezone(a.agency_timezone);
    if (fixed) {
      proposals.push({
        id: a.agency_id,
        entity: "agency",
        current: { agency_timezone: a.agency_timezone },
        patch: { agency_timezone: fixed },
      });
    }
  }
  const stops = db
    .prepare(
      "SELECT stop_id, stop_timezone FROM stops " +
        "WHERE stop_timezone IS NOT NULL AND stop_timezone != ''",
    )
    .all();
  for (const s of stops) {
    if (isValidIanaTimezone(s.stop_timezone)) continue;
    const fixed = normalizeIanaTimezone(s.stop_timezone);
    if (fixed) {
      proposals.push({
        id: s.stop_id,
        entity: "stop",
        current: { stop_timezone: s.stop_timezone },
        patch: { stop_timezone: fixed },
      });
    }
  }
  return proposals;
};

const scanRouteLongNameContainsShortName = (db) => {
  const rows = db
    .prepare(
      "SELECT route_id, route_short_name, route_long_name FROM routes " +
        "WHERE route_short_name IS NOT NULL AND route_short_name != '' " +
        "  AND route_long_name IS NOT NULL AND route_long_name != ''",
    )
    .all();
  const proposals = [];
  for (const r of rows) {
    const short = String(r.route_short_name || "").trim();
    const long = String(r.route_long_name || "").trim();
    if (!short || !long) continue;
    // The validator flags a long name that starts with the short name, with or without a separator.
    const re = new RegExp(
      `^${short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\-:—–·•]*`,
      "i",
    );
    if (re.test(long)) {
      const stripped = long.replace(re, "").trim();
      if (stripped && stripped !== long) {
        proposals.push({
          id: r.route_id,
          current: { route_long_name: r.route_long_name },
          patch: { route_long_name: stripped },
        });
      }
    }
  }
  return proposals;
};

// Out-of-range accessibility codes become "0" (no information).
const scanNumberOutOfRangeAccessibility = (db) => {
  const proposals = [];
  const ACCESSIBILITY_VALID = new Set(["0", "1", "2", "", null]);

  const stops = db
    .prepare(
      "SELECT stop_id, wheelchair_boarding FROM stops " +
        "WHERE wheelchair_boarding IS NOT NULL AND wheelchair_boarding != ''",
    )
    .all();
  for (const s of stops) {
    const v = String(s.wheelchair_boarding);
    if (ACCESSIBILITY_VALID.has(v)) continue;
    proposals.push({
      id: s.stop_id,
      entity: "stop",
      current: { wheelchair_boarding: s.wheelchair_boarding },
      patch: { wheelchair_boarding: "0" },
    });
  }

  const trips = db
    .prepare(
      "SELECT trip_id, wheelchair_accessible, bikes_allowed FROM trips " +
        "WHERE (wheelchair_accessible IS NOT NULL AND wheelchair_accessible != '') " +
        "   OR (bikes_allowed IS NOT NULL AND bikes_allowed != '')",
    )
    .all();
  for (const t of trips) {
    const current = {};
    const patch = {};
    for (const col of ["wheelchair_accessible", "bikes_allowed"]) {
      const raw = t[col];
      if (raw == null || raw === "") continue;
      const v = String(raw);
      if (!ACCESSIBILITY_VALID.has(v)) {
        current[col] = raw;
        patch[col] = "0";
      }
    }
    if (Object.keys(patch).length > 0) {
      proposals.push({
        id: t.trip_id,
        entity: "trip",
        current,
        patch,
      });
    }
  }
  return proposals;
};

// An empty bikes_allowed becomes "0" (no information), the value its absence already means.
const scanMissingBikeAllowance = (db) => {
  const rows = db
    .prepare(
      "SELECT trip_id, bikes_allowed FROM trips " +
        "WHERE bikes_allowed IS NULL OR TRIM(bikes_allowed) = ''",
    )
    .all();
  return rows.map((r) => ({
    id: r.trip_id,
    current: { bikes_allowed: r.bikes_allowed ?? "" },
    patch: { bikes_allowed: "0" },
  }));
};

const _normalizeUrl = (u) => {
  if (!u || typeof u !== "string") return null;
  const t = u.trim();
  if (t === "") return null;
  return t.replace(/\/+$/, "").toLowerCase();
};

const scanSameRouteAndAgencyUrl = (db) => {
  const agencies = db
    .prepare("SELECT agency_id, agency_url FROM agency WHERE agency_url IS NOT NULL")
    .all();
  if (agencies.length === 0) return [];
  const urlByAgency = new Map();
  let solo = null;
  for (const a of agencies) {
    const u = _normalizeUrl(a.agency_url);
    if (u) urlByAgency.set(a.agency_id, u);
  }
  // A single agency's URL applies to routes without an agency_id.
  if (agencies.length === 1) solo = _normalizeUrl(agencies[0].agency_url);

  const routes = db
    .prepare(
      "SELECT route_id, agency_id, route_url FROM routes " +
        "WHERE route_url IS NOT NULL AND route_url != ''",
    )
    .all();
  const proposals = [];
  for (const r of routes) {
    const ru = _normalizeUrl(r.route_url);
    if (!ru) continue;
    const own =
      r.agency_id && urlByAgency.has(r.agency_id)
        ? urlByAgency.get(r.agency_id)
        : solo;
    if (own && own === ru) {
      proposals.push({
        id: r.route_id,
        current: { route_url: r.route_url },
        patch: { route_url: null },
      });
    }
  }
  return proposals;
};

// Stations and infrastructure (location_type 1-4) are skipped, as the validator does.
const scanSameStopAndAgencyUrl = (db) => {
  const agencies = db
    .prepare("SELECT agency_url FROM agency WHERE agency_url IS NOT NULL")
    .all();
  const agencyUrls = new Set();
  for (const a of agencies) {
    const u = _normalizeUrl(a.agency_url);
    if (u) agencyUrls.add(u);
  }
  if (agencyUrls.size === 0) return [];

  const stops = db
    .prepare(
      "SELECT stop_id, stop_url, location_type FROM stops " +
        "WHERE stop_url IS NOT NULL AND stop_url != ''",
    )
    .all();
  const proposals = [];
  for (const s of stops) {
    const lt = (s.location_type ?? "").toString().trim();
    if (lt === "1" || lt === "2" || lt === "3" || lt === "4") continue;
    const su = _normalizeUrl(s.stop_url);
    if (su && agencyUrls.has(su)) {
      proposals.push({
        id: s.stop_id,
        current: { stop_url: s.stop_url },
        patch: { stop_url: null },
      });
    }
  }
  return proposals;
};

const scanSameStopAndRouteUrl = (db) => {
  const routes = db
    .prepare("SELECT route_url FROM routes WHERE route_url IS NOT NULL")
    .all();
  const routeUrls = new Set();
  for (const r of routes) {
    const u = _normalizeUrl(r.route_url);
    if (u) routeUrls.add(u);
  }
  if (routeUrls.size === 0) return [];

  const stops = db
    .prepare(
      "SELECT stop_id, stop_url, location_type FROM stops " +
        "WHERE stop_url IS NOT NULL AND stop_url != ''",
    )
    .all();
  const proposals = [];
  for (const s of stops) {
    const lt = (s.location_type ?? "").toString().trim();
    if (lt === "1" || lt === "2" || lt === "3" || lt === "4") continue;
    const su = _normalizeUrl(s.stop_url);
    if (su && routeUrls.has(su)) {
      proposals.push({
        id: s.stop_id,
        current: { stop_url: s.stop_url },
        patch: { stop_url: null },
      });
    }
  }
  return proposals;
};

// Clears routes.network_id: route_networks.txt stays the source, since it allows many-to-many.
const scanRouteNetworksDualSource = (db) => {
  let hasJunction = false;
  try {
    const cols = db.prepare("PRAGMA table_info(route_networks)").all();
    hasJunction = cols.length > 0;
  } catch (_) {
    return [];
  }
  if (!hasJunction) return [];

  const rows = db
    .prepare(
      "SELECT r.route_id, r.network_id " +
        "FROM routes r " +
        "WHERE r.network_id IS NOT NULL AND r.network_id != '' " +
        "  AND EXISTS (SELECT 1 FROM route_networks rn WHERE rn.route_id = r.route_id)",
    )
    .all();
  return rows.map((r) => ({
    id: r.route_id,
    current: { network_id: r.network_id },
    patch: { network_id: null },
  }));
};

// start_date after end_date: swapping the bounds keeps the window the producer meant.
// GTFS dates are YYYYMMDD, so a text comparison orders them.
const scanStartEndRangeOutOfOrder = (db) => {
  const rows = db
    .prepare(
      "SELECT service_id, start_date, end_date FROM calendar " +
        "WHERE start_date IS NOT NULL AND start_date != '' " +
        "  AND end_date IS NOT NULL AND end_date != '' " +
        "  AND start_date > end_date",
    )
    .all();
  return rows.map((r) => ({
    id: r.service_id,
    entity: "calendar",
    current: { start_date: r.start_date, end_date: r.end_date },
    patch: { start_date: r.end_date, end_date: r.start_date },
  }));
};

// Repairs only a missing scheme ("www.example.com"); any other bad URL is left to a person,
// since guessing would hide the error.
const HOST_LIKE_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+([/?#:].*)?$/i;

const fixSchemelessUrl = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.includes("://")) return null;
  if (!HOST_LIKE_RE.test(t)) return null;
  const candidate = `https://${t}`;
  try {
    new URL(candidate);
    return candidate;
  } catch (_) {
    return null;
  }
};

const URL_COLUMNS_BY_ENTITY = {
  agency: { table: "agency", pk: "agency_id", cols: ["agency_url", "agency_fare_url"] },
  route: { table: "routes", pk: "route_id", cols: ["route_url"] },
  stop: { table: "stops", pk: "stop_id", cols: ["stop_url"] },
};

const scanInvalidUrl = (db) => {
  const proposals = [];
  for (const [entity, cfg] of Object.entries(URL_COLUMNS_BY_ENTITY)) {
    const colList = cfg.cols.join(", ");
    const where = cfg.cols
      .map((c) => `(${c} IS NOT NULL AND ${c} != '')`)
      .join(" OR ");
    const rows = db
      .prepare(`SELECT ${cfg.pk}, ${colList} FROM ${cfg.table} WHERE ${where}`)
      .all();
    for (const r of rows) {
      const current = {};
      const patch = {};
      for (const col of cfg.cols) {
        const fixed = fixSchemelessUrl(r[col]);
        if (fixed) {
          current[col] = r[col];
          patch[col] = fixed;
        }
      }
      if (Object.keys(patch).length > 0) {
        proposals.push({ id: r[cfg.pk], entity, current, patch });
      }
    }
  }
  return proposals;
};

// Text columns only: trimming one side of a key or grouping column (agency_id, parent_station,
// block_id, zone_id…) would silently break the reference.
const TRIM_COLUMNS_BY_ENTITY = {
  agency: {
    table: "agency",
    pk: "agency_id",
    cols: ["agency_name", "agency_url", "agency_phone", "agency_email", "agency_fare_url"],
  },
  route: {
    table: "routes",
    pk: "route_id",
    cols: ["route_short_name", "route_long_name", "route_desc", "route_url"],
  },
  stop: {
    table: "stops",
    pk: "stop_id",
    cols: ["stop_name", "stop_desc", "stop_code", "stop_url", "platform_code", "tts_stop_name"],
    extra: ["location_type"],
  },
  trip: {
    table: "trips",
    pk: "trip_id",
    cols: ["trip_headsign", "trip_short_name"],
  },
};

// A column that trimming must not empty, given the row: the proposal reports it instead of patching it to NULL.
const blank = (v) => String(v ?? "").trim() === "";
const TRIM_REQUIRED = {
  agency: { agency_name: () => true },
  stop: { stop_name: (r) => _STOP_NAME_REQUIRED_TYPES.has(_resolveLocationType(r)) },
  route: { route_short_name: (r) => blank(r.route_long_name), route_long_name: (r) => blank(r.route_short_name) },
};

const scanLeadingTrailingWhitespace = (db) => {
  const proposals = [];
  for (const [entity, cfg] of Object.entries(TRIM_COLUMNS_BY_ENTITY)) {
    const colList = [...cfg.cols, ...(cfg.extra || [])].join(", ");
    const where = cfg.cols.map((c) => `${c} != TRIM(${c})`).join(" OR ");
    const rows = db
      .prepare(`SELECT ${cfg.pk}, ${colList} FROM ${cfg.table} WHERE ${where}`)
      .all();
    for (const r of rows) {
      const current = {};
      const patch = {};
      const skipped = {};
      for (const col of cfg.cols) {
        const raw = r[col];
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (trimmed === raw) continue;
        current[col] = raw;
        const required = TRIM_REQUIRED[entity]?.[col];
        if (trimmed === "" && required && required(r)) skipped[col] = "required";
        else patch[col] = trimmed === "" ? null : trimmed;
      }
      if (Object.keys(patch).length > 0 || Object.keys(skipped).length > 0) {
        proposals.push({ id: r[cfg.pk], entity, current, patch, ...(Object.keys(skipped).length ? { skipped } : {}) });
      }
    }
  }
  return proposals;
};

// ── Registry ────────────────────────────────────────────────────────────────

/** Keyed by the rule code; a fix that spans entities (`entity: null`) sets each proposal's own. */
const QUICK_FIXES = {
  invalid_color: {
    entity: "route",
    titleKey: "quickFix.invalid_color.title",
    descKey: "quickFix.invalid_color.desc",
    scan: scanInvalidColor,
  },
  route_short_name_too_long: {
    entity: "route",
    titleKey: "quickFix.route_short_name_too_long.title",
    descKey: "quickFix.route_short_name_too_long.desc",
    scan: scanRouteShortNameTooLong,
  },
  same_name_and_description_for_route: {
    entity: "route",
    titleKey: "quickFix.same_name_and_description_for_route.title",
    descKey: "quickFix.same_name_and_description_for_route.desc",
    scan: scanSameNameAndDescriptionForRoute,
  },
  same_name_and_description_for_stop: {
    entity: "stop",
    titleKey: "quickFix.same_name_and_description_for_stop.title",
    descKey: "quickFix.same_name_and_description_for_stop.desc",
    scan: scanSameNameAndDescriptionForStop,
  },
  invalid_timezone: {
    entity: null,
    titleKey: "quickFix.invalid_timezone.title",
    descKey: "quickFix.invalid_timezone.desc",
    scan: scanInvalidTimezone,
  },
  route_long_name_contains_short_name: {
    entity: "route",
    titleKey: "quickFix.route_long_name_contains_short_name.title",
    descKey: "quickFix.route_long_name_contains_short_name.desc",
    scan: scanRouteLongNameContainsShortName,
  },
  number_out_of_range: {
    entity: null,
    titleKey: "quickFix.number_out_of_range.title",
    descKey: "quickFix.number_out_of_range.desc",
    scan: scanNumberOutOfRangeAccessibility,
  },
  missing_bike_allowance: {
    entity: "trip",
    titleKey: "quickFix.missing_bike_allowance.title",
    descKey: "quickFix.missing_bike_allowance.desc",
    scan: scanMissingBikeAllowance,
  },
  same_route_and_agency_url: {
    entity: "route",
    titleKey: "quickFix.same_route_and_agency_url.title",
    descKey: "quickFix.same_route_and_agency_url.desc",
    scan: scanSameRouteAndAgencyUrl,
  },
  same_stop_and_agency_url: {
    entity: "stop",
    titleKey: "quickFix.same_stop_and_agency_url.title",
    descKey: "quickFix.same_stop_and_agency_url.desc",
    scan: scanSameStopAndAgencyUrl,
  },
  same_stop_and_route_url: {
    entity: "stop",
    titleKey: "quickFix.same_stop_and_route_url.title",
    descKey: "quickFix.same_stop_and_route_url.desc",
    scan: scanSameStopAndRouteUrl,
  },
  route_networks_specified_in_more_than_one_file: {
    entity: "route",
    titleKey: "quickFix.route_networks_specified_in_more_than_one_file.title",
    descKey: "quickFix.route_networks_specified_in_more_than_one_file.desc",
    scan: scanRouteNetworksDualSource,
  },
  start_and_end_range_out_of_order: {
    entity: "calendar",
    titleKey: "quickFix.start_and_end_range_out_of_order.title",
    descKey: "quickFix.start_and_end_range_out_of_order.desc",
    scan: scanStartEndRangeOutOfOrder,
  },
  invalid_url: {
    entity: null,
    titleKey: "quickFix.invalid_url.title",
    descKey: "quickFix.invalid_url.desc",
    scan: scanInvalidUrl,
  },
  leading_or_trailing_whitespaces: {
    entity: null,
    titleKey: "quickFix.leading_or_trailing_whitespaces.title",
    descKey: "quickFix.leading_or_trailing_whitespaces.desc",
    scan: scanLeadingTrailingWhitespace,
  },
};

const hasQuickFix = (ruleCode) =>
  Object.prototype.hasOwnProperty.call(QUICK_FIXES, ruleCode);

const getQuickFix = (ruleCode) => QUICK_FIXES[ruleCode] || null;

const listSupportedRuleCodes = () => Object.keys(QUICK_FIXES);

module.exports = {
  QUICK_FIXES,
  hasQuickFix,
  getQuickFix,
  listSupportedRuleCodes,
  normalizeIanaTimezone,
  isValidIanaTimezone,
};
