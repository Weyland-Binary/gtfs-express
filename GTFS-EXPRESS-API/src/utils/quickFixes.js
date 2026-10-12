/**
 * quickFixes.js — Registry of trivially auto-repairable validation rules.
 *
 * Each entry is keyed by the snake_case MobilityData canonical
 * ruleCode (matching `rules.json` keys) and describes:
 *   - entity      : "stop" | "route" | "trip" | "agency"
 *   - titleKey    : i18n key for the dialog title
 *   - descKey     : i18n key for the one-line description of the fix
 *   - scan(db)    : reads the edit DB and returns an array of proposals:
 *                   [{ id, current: {field: oldValue, ...}, patch: {field: newValue, ...} }]
 *
 * Proposals only include rows where the fix is SAFE and produces a
 * different value than the current one (no-op rows are filtered out by
 * the registry itself).
 *
 * CRITICAL: the validator's occurrence list lacks the original value,
 * so Quick Fix must re-scan the edit DB live at proposal time. This
 * also guarantees we never "fix" rows that were edited manually since
 * the validation report was generated.
 */

const HEX_COLOR_RE = /^[0-9A-Fa-f]{6}$/;

// Cache for IANA timezone names. Shared with the validator conceptually,
// but kept local to avoid circular deps.
const _tzCache = new Map();
const isValidIanaTimezone = (tz) => {
  if (!tz || typeof tz !== "string") return false;
  const key = tz.trim();
  if (key === "") return false;
  if (_tzCache.has(key)) return _tzCache.get(key);
  let ok = false;
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: key });
    ok = true;
  } catch (_) {
    ok = false;
  }
  _tzCache.set(key, ok);
  return ok;
};

/**
 * Try to normalize a loosely-cased IANA timezone like "europe/paris"
 * or "EUROPE/PARIS" into the canonical "Europe/Paris" form.
 * Returns null if the normalized form is not a valid IANA tz.
 */
const normalizeIanaTimezone = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Try a case-insensitive match against Intl.supportedValuesOf
  if (typeof Intl.supportedValuesOf === "function") {
    const all = Intl.supportedValuesOf("timeZone");
    const hit = all.find((tz) => tz.toLowerCase() === trimmed.toLowerCase());
    if (hit && hit !== raw) return hit;
  }
  // Fallback: title-case each segment of "Area/City"
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

// ── Scanners ────────────────────────────────────────────────────────────────

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
      const cleaned = String(raw).replace(/^#/, "").trim().toUpperCase();
      if (HEX_COLOR_RE.test(cleaned) && cleaned !== raw) {
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
  // Agencies
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
  // Stops
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
    // Canonical rule: long_name should not START WITH short_name
    // (optionally followed by a separator: space, dash, colon, bullet, etc.)
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

// Normalize wheelchair_boarding / wheelchair_accessible / bikes_allowed
// out-of-range numeric codes to "0" (= no info) per Canonical.
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

// ── Sprint 6 (chantier 2.B+ / B6): extended quickfix coverage ────────────────
//
// Each scanner below queries the edit DB for rows that match the rule
// and proposes a SAFE auto-repair patch. Proposals are filtered for
// no-op cases by the apply pipeline.

// missing_bike_allowance: trips.bikes_allowed empty → set to "0" (no info,
// the spec-default value when the column is omitted entirely). This is
// strictly an additive disambiguation — does not change semantics.
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

// same_route_and_agency_url: clear route_url when it equals the
// agency's agency_url for the same agency_id. Single-agency feeds
// also matched (the lone agency's URL is implicit).
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

// same_stop_and_agency_url: clear stop_url when it equals ANY
// agency_url. Skips stations / infrastructure (location_type 1-4) —
// matches the validator's gating to keep behaviour symmetric.
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

// same_stop_and_route_url: clear stop_url when it equals ANY route_url.
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

// route_networks_specified_in_more_than_one_file: clear routes.network_id
// (keep the route_networks.txt junction as the source of truth — the
// junction is more flexible since it supports many-to-many).
const scanRouteNetworksDualSource = (db) => {
  // route_networks.txt may not exist in older feeds. Probe via PRAGMA.
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

// ── Rescue-flow wave: fixes for export-blocking (ERROR) rules ────────────────

// start_and_end_range_out_of_order: calendar rows where start_date >
// end_date (GTFS dates are YYYYMMDD strings — lexical compare is correct).
// The safe deterministic repair is to swap the two bounds: the service
// window the producer intended is preserved, just re-ordered.
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

// invalid_url: the single most common producer mistake is a missing scheme
// ("www.example.com" instead of "https://www.example.com"). Repair ONLY that
// shape: host-like values without "://" get "https://" prepended, and the
// result must parse as a real URL. Anything else (typos, garbage) is left
// for a human — guessing would hide the error, not fix it.
const HOST_LIKE_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+([/?#:].*)?$/i;

const fixSchemelessUrl = (raw) => {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || t.includes("://")) return null;
  if (!HOST_LIKE_RE.test(t)) return null;
  const candidate = `https://${t}`;
  try {
    // eslint-disable-next-line no-new
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

// leading_or_trailing_whitespaces: trim display/text columns. Foreign-key
// and grouping columns (agency_id, parent_station, block_id, level_id,
// network_id, zone_id…) are deliberately EXCLUDED: trimming one side of a
// join silently breaks the reference it participates in.
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
  },
  trip: {
    table: "trips",
    pk: "trip_id",
    cols: ["trip_headsign", "trip_short_name"],
  },
};

const scanLeadingTrailingWhitespace = (db) => {
  const proposals = [];
  for (const [entity, cfg] of Object.entries(TRIM_COLUMNS_BY_ENTITY)) {
    const colList = cfg.cols.join(", ");
    const where = cfg.cols.map((c) => `${c} != TRIM(${c})`).join(" OR ");
    const rows = db
      .prepare(`SELECT ${cfg.pk}, ${colList} FROM ${cfg.table} WHERE ${where}`)
      .all();
    for (const r of rows) {
      const current = {};
      const patch = {};
      for (const col of cfg.cols) {
        const raw = r[col];
        if (typeof raw !== "string") continue;
        const trimmed = raw.trim();
        if (trimmed !== raw) {
          current[col] = raw;
          patch[col] = trimmed === "" ? null : trimmed;
        }
      }
      if (Object.keys(patch).length > 0) {
        proposals.push({ id: r[cfg.pk], entity, current, patch });
      }
    }
  }
  return proposals;
};

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * Registry of quick fixes keyed by Canonical ruleCode.
 * `entity` is the default target — fixes that span multiple entities
 * (e.g. invalid_timezone on agency + stop) embed per-row `entity` in scan().
 */
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
    entity: null, // multi-entity
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
    entity: null, // multi-entity (stop + trip)
    titleKey: "quickFix.number_out_of_range.title",
    descKey: "quickFix.number_out_of_range.desc",
    scan: scanNumberOutOfRangeAccessibility,
  },
  // ── Sprint 6 (chantier 2.B+ / B6): extended coverage ──────────────────
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
  // ── Rescue-flow wave: export-blocking (ERROR) rules ────────────────────
  start_and_end_range_out_of_order: {
    entity: "calendar",
    titleKey: "quickFix.start_and_end_range_out_of_order.title",
    descKey: "quickFix.start_and_end_range_out_of_order.desc",
    scan: scanStartEndRangeOutOfOrder,
  },
  invalid_url: {
    entity: null, // multi-entity (agency + route + stop)
    titleKey: "quickFix.invalid_url.title",
    descKey: "quickFix.invalid_url.desc",
    scan: scanInvalidUrl,
  },
  leading_or_trailing_whitespaces: {
    entity: null, // multi-entity (agency + route + stop + trip)
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
