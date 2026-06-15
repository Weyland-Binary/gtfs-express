/**
 * fieldValidators.js — Shared field-level validation predicates.
 *
 * Pure functions, no I/O, no side effects. Used by `editService.js`
 * (pre-commit validation in `validateXPatch`) and the SQL Console
 * (`validateAfterMutation` in `sqlConsoleService.js`). Post-export
 * rule checking is delegated to the MobilityData canonical validator.
 *
 * All regex constants are declared at module scope to avoid re-compilation
 * on every call (important for bulk edit which calls predicates per-row).
 *
 * Design rules:
 *   - Predicates return boolean (true = valid, false = invalid).
 *   - Higher-level helpers (validateXFields) return string[] of error messages.
 *   - Error messages are kept verbatim from editService.js to preserve
 *     wire-compatibility with the frontend.
 */

"use strict";

// ── Regex constants (exported for consumers that need them directly) ──────────

/** Exactly 6 hex characters, no leading '#'. */
const HEX_COLOR_RE = /^[0-9A-Fa-f]{6}$/;

/** Exactly 8 decimal digits (YYYYMMDD). Does not validate calendar correctness. */
const DATE_YYYYMMDD_RE = /^\d{8}$/;

/**
 * GTFS time: any number of hour digits (supports >24h overnight services),
 * followed by :MM:SS where MM and SS are exactly 2 digits each.
 * Examples: 8:30:00, 25:01:30, 100:00:00.
 */
const TIME_HHMMSS_RE = /^\d+:[0-5]\d:[0-5]\d$/;

/**
 * Pragmatic BCP 47 regex.
 * Accepts 'en', 'fr', 'fr-CA', 'zh-Hant-TW'. Rejects obvious typos but
 * does not catch all invalid tags (full registry lookup not feasible here).
 */
const BCP47_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4}){0,2}$/;

// ── Enum value sets ──────────────────────────────────────────────────────────

/**
 * Accepted string values for 3-state GTFS enum fields (e.g. bikes_allowed,
 * cars_allowed, cemv_support): 0, 1, 2 plus absent/empty.
 */
const ENUM_0_1_2 = new Set(["0", "1", "2", "", null, undefined]);

/**
 * Accepted string values for 2-state GTFS enum fields (e.g. stop_access):
 * 0, 1 plus absent/empty.
 */
const ENUM_0_1 = new Set(["0", "1", "", null, undefined]);

/**
 * Returns true if val is absent/empty OR its string form is in allowedSet.
 * Null, undefined, and "" are always treated as "not provided" = valid.
 */
const isEnumValue = (val, allowedSet) => {
  if (val === null || val === undefined || val === "") return true;
  return allowedSet.has(String(val));
};

// ── IANA timezone memoisation cache ─────────────────────────────────────────

const _tzCache = new Map();

// ── Predicates ───────────────────────────────────────────────────────────────

/**
 * True if value is a finite number in [-90, 90].
 * Accepts numeric type only (does NOT coerce strings).
 */
const isValidLat = (value) =>
  typeof value === "number" && isFinite(value) && value >= -90 && value <= 90;

/**
 * True if value is a finite number in [-180, 180].
 * Accepts numeric type only (does NOT coerce strings).
 */
const isValidLon = (value) =>
  typeof value === "number" &&
  isFinite(value) &&
  value >= -180 &&
  value <= 180;

/**
 * True if value is exactly 6 hex chars with no '#' prefix.
 * Case-insensitive. Empty string → false (caller decides if field is optional).
 */
const isValidHexColor = (value) =>
  typeof value === "string" && HEX_COLOR_RE.test(value);

/**
 * True if value is 0 or 1 (number or numeric string).
 * Used for calendar day fields (monday…sunday).
 */
const isValidServiceDay = (value) => {
  const n = Number(value);
  return (n === 0 || n === 1) && !isNaN(n);
};

/**
 * True if value matches YYYYMMDD format (8 decimal digits).
 * Does NOT validate calendar correctness (Feb 30 would pass).
 * For real-date validation use isValidRealDate which is stricter.
 */
const isValidYYYYMMDDDate = (value) =>
  typeof value === "string"
    ? DATE_YYYYMMDD_RE.test(value)
    : DATE_YYYYMMDD_RE.test(String(value));

/**
 * True if value represents 0 or 1 (direction_id field).
 * Accepts string or number. Empty/null → false.
 */
const isValidDirectionId = (value) => ["0", "1"].includes(String(value));

/**
 * True if value represents 0, 1, 2, or empty string (wheelchair_boarding /
 * wheelchair_accessible fields).
 * Null/undefined are NOT accepted (caller should guard for those separately).
 */
const isValidWheelchairBoarding = (value) =>
  ["0", "1", "2", ""].includes(String(value));

/**
 * True if value is 0, 1, 2, 3, or empty string (continuous_pickup /
 * continuous_drop_off fields). Null is treated as empty string.
 */
const isValidContinuousPickupDropOff = (value) => {
  const s = value === null ? "" : String(value);
  return ["", "0", "1", "2", "3"].includes(s);
};

/**
 * True if value is a BCP 47-ish language tag (lenient check).
 * Empty string → false. Null/undefined → false.
 */
const isValidLanguageCode = (value) => {
  if (!value || typeof value !== "string") return false;
  return BCP47_RE.test(value.trim());
};

/**
 * True if value is a valid IANA timezone name recognised by the platform.
 * Uses Intl.DateTimeFormat and memoises results.
 * Empty/null → false.
 */
const isValidTimezone = (tz) => {
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
 * True if value is 0, 1, 2, 3, or empty/null (pickup_type / drop_off_type).
 * Mirrors the CONTINUOUS_VALUES check used in editService.js.
 */
const isValidPickupDropOffType = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return ["", "0", "1", "2", "3"].includes(s);
};

/**
 * True if value is a non-negative integer (route_type).
 * Accepts number or numeric string. Empty/null → false.
 */
const isValidRouteType = (value) => {
  if (value === null || value === "" || value === undefined) return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0;
};

/**
 * True if value is a valid GTFS time string (H:MM:SS or HH:MM:SS or HHH:MM:SS,
 * supports >24h overnight services). Minutes and seconds must be 00-59.
 */
const isValidGtfsTime = (value) => {
  if (typeof value !== "string") return false;
  return TIME_HHMMSS_RE.test(value);
};

// ── Higher-level field-group validators ──────────────────────────────────────
// These mirror the validateXPatch functions in editService.js exactly,
// keeping the same error message strings for wire-compatibility.

/**
 * Validate stop fields present in a patch/body object.
 * Returns an array of error message strings (empty = valid).
 */
const validateStopFields = (body) => {
  const errors = [];

  if ("stop_lat" in body && body.stop_lat !== null) {
    // Reject booleans/arrays/objects that would be silently coerced by
    // Number(): `true` → 1, `[48]` → 48, `{}` → NaN. Only number or
    // numeric string is accepted.
    if (!_isNumericLike(body.stop_lat) || !isValidLat(Number(body.stop_lat))) {
      errors.push("stop_lat must be a number between -90 and 90");
    }
  }

  if ("stop_lon" in body && body.stop_lon !== null) {
    if (!_isNumericLike(body.stop_lon) || !isValidLon(Number(body.stop_lon))) {
      errors.push("stop_lon must be a number between -180 and 180");
    }
  }

  if ("stop_name" in body) {
    // NULL is acceptable for location_type ∈ {3 (generic node), 4 (boarding
    // area)} per spec; the conditional-required check below is what enforces
    // it for the stop/station/entrance trio. Reject only non-null non-string
    // values (e.g. accidental numeric assignment via SQL).
    if (body.stop_name !== null && typeof body.stop_name !== "string") {
      errors.push("stop_name must be a string");
    } else {
      const trimmed =
        body.stop_name === null || body.stop_name === undefined
          ? ""
          : body.stop_name.trim();
      if (trimmed === "") {
        // Cross-field check: enforce only when the location_type tells us a
        // name is required. Single-entity PATCH handlers in `_editCore.js`
        // merge the patch with the pre-existing row before validating; the
        // SQL console path passes the post-mutation row, which always
        // carries every column.
        const lt = _resolveLocationType(body);
        if (_STOP_NAME_REQUIRED_TYPES.has(lt)) {
          errors.push(
            "stop_name is required for stops with location_type 0 (stop), 1 (station), or 2 (entrance/exit) and cannot be empty",
          );
        }
      }
    }
  }

  if ("wheelchair_boarding" in body) {
    const v = String(body.wheelchair_boarding);
    if (!["0", "1", "2", ""].includes(v)) {
      errors.push("wheelchair_boarding must be 0, 1 or 2");
    }
  }

  if ("stop_access" in body && !isEnumValue(body.stop_access, ENUM_0_1)) {
    errors.push({ field: "stop_access", message: "Must be 0 or 1 if specified" });
  }

  // GTFS spec: stop_access is Conditionally Forbidden — only allowed on
  // stops/platforms (location_type 0 or empty) that have a parent_station.
  //
  // We only enforce this branch when the body already carries the row-level
  // context (`location_type` and `parent_station` are both present as keys).
  // Otherwise the patch is partial — the canonical place to enforce the rule
  // is the single-entity PATCH handler in `_editCore.js`, which combines the
  // patch with the pre-existing row before deciding. This branch is what
  // fires for the SQL console path where `postRow` is the full row.
  if (
    "stop_access" in body &&
    body.stop_access !== null &&
    body.stop_access !== undefined &&
    body.stop_access !== "" &&
    "location_type" in body &&
    "parent_station" in body
  ) {
    const locType = String(body.location_type ?? "").trim();
    const parentSt = String(body.parent_station ?? "").trim();
    if (locType !== "0" && locType !== "") {
      errors.push(
        `stop_access is forbidden when location_type is not 0 (current: ${locType})`,
      );
    } else if (parentSt === "") {
      errors.push("stop_access requires parent_station to be set");
    }
  }

  return errors;
};

/**
 * Validate route fields present in a patch/body object.
 * Returns an array of error message strings (empty = valid).
 */
const validateRouteFields = (body) => {
  const errors = [];

  if (
    "route_color" in body &&
    body.route_color &&
    !isValidHexColor(body.route_color)
  ) {
    errors.push("route_color must be a 6-char hex value (no #)");
  }

  if (
    "route_text_color" in body &&
    body.route_text_color &&
    !isValidHexColor(body.route_text_color)
  ) {
    errors.push("route_text_color must be a 6-char hex value (no #)");
  }

  if (
    "route_type" in body &&
    body.route_type !== null &&
    body.route_type !== ""
  ) {
    const n = Number(body.route_type);
    if (!Number.isInteger(n) || n < 0) {
      errors.push("route_type must be a non-negative integer");
    }
  }

  if (
    "continuous_pickup" in body &&
    body.continuous_pickup !== null &&
    !isValidContinuousPickupDropOff(body.continuous_pickup)
  ) {
    errors.push("continuous_pickup must be 0, 1, 2 or 3");
  }

  if (
    "continuous_drop_off" in body &&
    body.continuous_drop_off !== null &&
    !isValidContinuousPickupDropOff(body.continuous_drop_off)
  ) {
    errors.push("continuous_drop_off must be 0, 1, 2 or 3");
  }

  if ("cemv_support" in body && !isEnumValue(body.cemv_support, ENUM_0_1_2)) {
    errors.push({ field: "cemv_support", message: "Must be 0, 1 or 2 if specified" });
  }

  return errors;
};

/**
 * Validate trip fields present in a patch/body object.
 * Returns an array of error message strings (empty = valid).
 */
const validateTripFields = (body) => {
  const errors = [];

  if (
    "direction_id" in body &&
    body.direction_id !== null &&
    body.direction_id !== "" &&
    !["0", "1"].includes(String(body.direction_id))
  ) {
    errors.push("direction_id must be 0 or 1");
  }

  if (
    "wheelchair_accessible" in body &&
    body.wheelchair_accessible !== null &&
    !["0", "1", "2", ""].includes(String(body.wheelchair_accessible))
  ) {
    errors.push("wheelchair_accessible must be 0, 1 or 2");
  }

  if ("cars_allowed" in body && !isEnumValue(body.cars_allowed, ENUM_0_1_2)) {
    errors.push({ field: "cars_allowed", message: "Must be 0, 1 or 2 if specified" });
  }

  return errors;
};

/**
 * Validate calendar fields present in a patch/body object.
 * Returns an array of error message strings (empty = valid).
 */
const validateCalendarFields = (body) => {
  const errors = [];

  for (const day of [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ]) {
    if (day in body && !_SERVICE_DAY_VALUES.has(Number(body[day]))) {
      errors.push(`${day} must be 0 or 1`);
    }
  }

  for (const d of ["start_date", "end_date"]) {
    if (d in body && !DATE_YYYYMMDD_RE.test(String(body[d]))) {
      errors.push(`${d} must match YYYYMMDD`);
    }
  }

  return errors;
};

/**
 * Validate agency fields present in a patch/body object.
 * Returns an array of error message strings (empty = valid).
 *
 * Aligned with the catalogued GTFS spec rules (`rules.json`) :
 *   - agency_url, agency_fare_url       → must be parseable HTTP(S) URL
 *   - agency_timezone                   → must be IANA tz (Intl.DateTimeFormat)
 *   - agency_lang                       → must be BCP 47-ish (isValidLanguageCode)
 *   - agency_email                      → simple format check
 *
 * Note : required-field checks (agency_name, agency_url, agency_timezone non
 * empty) remain in the `createAgency` handler because they depend on
 * the mode (create vs patch).
 */
const validateAgencyFields = (body) => {
  const errors = [];

  if ("agency_url" in body && body.agency_url !== null && body.agency_url !== "") {
    if (!isValidHttpUrl(body.agency_url)) {
      errors.push("agency_url must be a valid HTTP/HTTPS URL");
    }
  }

  if (
    "agency_fare_url" in body &&
    body.agency_fare_url !== null &&
    body.agency_fare_url !== ""
  ) {
    if (!isValidHttpUrl(body.agency_fare_url)) {
      errors.push("agency_fare_url must be a valid HTTP/HTTPS URL");
    }
  }

  if (
    "agency_timezone" in body &&
    body.agency_timezone !== null &&
    body.agency_timezone !== ""
  ) {
    if (!isValidTimezone(body.agency_timezone)) {
      errors.push("agency_timezone must be a valid IANA timezone name");
    }
  }

  if (
    "agency_lang" in body &&
    body.agency_lang !== null &&
    body.agency_lang !== ""
  ) {
    if (!isValidLanguageCode(body.agency_lang)) {
      errors.push("agency_lang must be a valid BCP 47 language tag (e.g. 'en', 'fr-CA')");
    }
  }

  if (
    "agency_email" in body &&
    body.agency_email !== null &&
    body.agency_email !== ""
  ) {
    if (!isValidEmail(body.agency_email)) {
      errors.push("agency_email must be a valid email address");
    }
  }

  if ("cemv_support" in body && !isEnumValue(body.cemv_support, ENUM_0_1_2)) {
    errors.push({ field: "cemv_support", message: "Must be 0, 1 or 2 if specified" });
  }

  return errors;
};

/**
 * Lenient HTTP/HTTPS URL check using the WHATWG URL parser. Empty/null is
 * the caller's responsibility (this returns false for those).
 * Accepts http:// and https:// only — other schemes (ftp:, file:) rejected.
 */
const isValidHttpUrl = (value) => {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
};

/**
 * Pragmatic email format check — accepts the common forms (local@domain.tld)
 * without being a full RFC 5322 parser. Same level of strictness as common
 * web frameworks (Django, Rails). Empty/null returns false.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (value) =>
  typeof value === "string" && EMAIL_RE.test(value.trim());

// ── Numeric helpers ──────────────────────────────────────────────────────────

/**
 * Type-strict numeric pre-check used by every isValidX helper below.
 *
 * Rejects booleans, arrays, plain objects — even though `Number(true) === 1`
 * and `Number([42]) === 42` would otherwise sneak through. Only `number` and
 * `string` values are forwarded to the actual range/format checks. This keeps
 * silent coercion ("stop_lat: true" → 1, "stop_lat: [42]" → 42) from passing
 * validation and ending up in the DB as 1 or 42.
 */
const _isNumericLike = (value) => {
  if (value === null || value === undefined || value === "") return false;
  return typeof value === "number" || typeof value === "string";
};

/**
 * True if value is a finite number ≥ 0 (integer or fractional).
 * Accepts numeric strings; null / undefined / "" / booleans / arrays / objects
 * are NOT accepted.
 */
const isValidNonNegativeNumber = (value) => {
  if (!_isNumericLike(value)) return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
};

/**
 * True if value is a finite integer ≥ 0.
 * Accepts numeric strings; null / undefined / "" / booleans / arrays / objects
 * are NOT accepted.
 */
const isValidNonNegativeInt = (value) => {
  if (!_isNumericLike(value)) return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0;
};

/**
 * True if value is any finite number (positive, negative, integer or fractional).
 * Accepts numeric strings; null / undefined / "" / booleans / arrays / objects
 * are NOT accepted.
 */
const isValidNumber = (value) => {
  if (!_isNumericLike(value)) return false;
  const n = Number(value);
  return Number.isFinite(n);
};

// ── GTFS-specific enum predicates ────────────────────────────────────────────

/**
 * pathway_mode (pathways.txt) — 1..7 (walkway, stairs, moving sidewalk,
 * escalator, elevator, fare gate, exit gate). Required field, NOT optional.
 */
const isValidPathwayMode = (value) => {
  if (value === null || value === undefined || value === "") return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 7;
};

/**
 * is_bidirectional (pathways.txt) — 0 or 1 only. Required.
 */
const isValidBidirectional = (value) => {
  if (value === null || value === undefined || value === "") return false;
  return ["0", "1"].includes(String(value));
};

/**
 * transfer_type (transfers.txt) — 0..5
 *   0/empty: recommended transfer
 *   1: timed transfer (vehicles wait)
 *   2: minimum time required (min_transfer_time)
 *   3: not possible
 *   4: in-seat transfer
 *   5: must re-board
 */
const isValidTransferType = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return ["", "0", "1", "2", "3", "4", "5"].includes(s);
};

/**
 * exception_type (calendar_dates.txt) — 1 (added) or 2 (removed). Required.
 */
const isValidExceptionType = (value) => {
  if (value === null || value === undefined || value === "") return false;
  return ["1", "2"].includes(String(value));
};

/**
 * exact_times (frequencies.txt) — 0 or 1 / empty.
 */
const isValidExactTimes = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return ["", "0", "1"].includes(s);
};

/**
 * timepoint (stop_times.txt) — 0 or 1 / empty.
 */
const isValidTimepoint = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return ["", "0", "1"].includes(s);
};

/**
 * is_producer / is_operator / is_authority (attributions.txt) — 0 or 1 / empty.
 */
const isValidAttributionRole = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return ["", "0", "1"].includes(s);
};

// ── Higher-level field-group validators (extended set) ──────────────────────

/**
 * Validate stop_times fields present in a patch/body/row object.
 * Spec : pickup_type, drop_off_type, continuous_pickup, continuous_drop_off
 * are 0..3. timepoint is 0|1. arrival_time/departure_time are H:MM:SS.
 * stop_sequence is non-negative integer; shape_dist_traveled is non-negative.
 */
const validateStopTimeFields = (body) => {
  const errors = [];

  for (const f of ["pickup_type", "drop_off_type"]) {
    if (f in body && !isValidPickupDropOffType(body[f])) {
      errors.push(`${f} must be 0, 1, 2 or 3`);
    }
  }

  for (const f of ["continuous_pickup", "continuous_drop_off"]) {
    if (f in body && !isValidContinuousPickupDropOff(body[f])) {
      errors.push(`${f} must be 0, 1, 2 or 3`);
    }
  }

  if ("timepoint" in body && !isValidTimepoint(body.timepoint)) {
    errors.push("timepoint must be 0 or 1");
  }

  for (const f of ["arrival_time", "departure_time"]) {
    if (f in body && body[f] !== null && body[f] !== "") {
      if (!isValidGtfsTime(String(body[f]))) {
        errors.push(`${f} must be a GTFS time string (HH:MM:SS, ≥24h allowed)`);
      }
    }
  }

  if (
    "stop_sequence" in body &&
    body.stop_sequence !== null &&
    body.stop_sequence !== "" &&
    !isValidNonNegativeInt(body.stop_sequence)
  ) {
    errors.push("stop_sequence must be a non-negative integer");
  }

  if (
    "shape_dist_traveled" in body &&
    body.shape_dist_traveled !== null &&
    body.shape_dist_traveled !== "" &&
    !isValidNonNegativeNumber(body.shape_dist_traveled)
  ) {
    errors.push("shape_dist_traveled must be a non-negative number");
  }

  return errors;
};

/**
 * Validate calendar_dates fields. Spec: date is YYYYMMDD, exception_type ∈ {1,2}.
 */
const validateCalendarDateFields = (body) => {
  const errors = [];

  if ("date" in body && body.date !== null && body.date !== "") {
    if (!isValidYYYYMMDDDate(String(body.date))) {
      errors.push("date must match YYYYMMDD");
    }
  }

  if ("exception_type" in body) {
    if (!isValidExceptionType(body.exception_type)) {
      errors.push("exception_type must be 1 (service added) or 2 (service removed)");
    }
  }

  return errors;
};

/**
 * Validate shapes fields. Spec: lat/lon valid, shape_pt_sequence is non-negative
 * integer, shape_dist_traveled is non-negative.
 */
const validateShapeFields = (body) => {
  const errors = [];

  if (
    "shape_pt_lat" in body &&
    body.shape_pt_lat !== null &&
    body.shape_pt_lat !== ""
  ) {
    if (
      !_isNumericLike(body.shape_pt_lat) ||
      !isValidLat(Number(body.shape_pt_lat))
    ) {
      errors.push("shape_pt_lat must be a number between -90 and 90");
    }
  }

  if (
    "shape_pt_lon" in body &&
    body.shape_pt_lon !== null &&
    body.shape_pt_lon !== ""
  ) {
    if (
      !_isNumericLike(body.shape_pt_lon) ||
      !isValidLon(Number(body.shape_pt_lon))
    ) {
      errors.push("shape_pt_lon must be a number between -180 and 180");
    }
  }

  if (
    "shape_pt_sequence" in body &&
    body.shape_pt_sequence !== null &&
    body.shape_pt_sequence !== "" &&
    !isValidNonNegativeInt(body.shape_pt_sequence)
  ) {
    errors.push("shape_pt_sequence must be a non-negative integer");
  }

  if (
    "shape_dist_traveled" in body &&
    body.shape_dist_traveled !== null &&
    body.shape_dist_traveled !== "" &&
    !isValidNonNegativeNumber(body.shape_dist_traveled)
  ) {
    errors.push("shape_dist_traveled must be a non-negative number");
  }

  return errors;
};

/**
 * Validate frequencies fields. Spec: start_time/end_time are GTFS time,
 * headway_secs > 0, exact_times ∈ {0,1}.
 */
const validateFrequencyFields = (body) => {
  const errors = [];

  for (const f of ["start_time", "end_time"]) {
    if (f in body && body[f] !== null && body[f] !== "") {
      if (!isValidGtfsTime(String(body[f]))) {
        errors.push(`${f} must be a GTFS time string (HH:MM:SS, ≥24h allowed)`);
      }
    }
  }

  if (
    "headway_secs" in body &&
    body.headway_secs !== null &&
    body.headway_secs !== ""
  ) {
    const n = Number(body.headway_secs);
    if (!Number.isInteger(n) || n <= 0) {
      errors.push("headway_secs must be a positive integer");
    }
  }

  if ("exact_times" in body && !isValidExactTimes(body.exact_times)) {
    errors.push("exact_times must be 0 or 1");
  }

  return errors;
};

/**
 * Validate transfers fields. Spec: transfer_type ∈ {0,1,2,3,4,5},
 * min_transfer_time ≥ 0 if present.
 */
const validateTransferFields = (body) => {
  const errors = [];

  if ("transfer_type" in body && !isValidTransferType(body.transfer_type)) {
    errors.push("transfer_type must be 0, 1, 2, 3, 4 or 5");
  }

  if (
    "min_transfer_time" in body &&
    body.min_transfer_time !== null &&
    body.min_transfer_time !== ""
  ) {
    if (!isValidNonNegativeInt(body.min_transfer_time)) {
      errors.push("min_transfer_time must be a non-negative integer");
    }
  }

  return errors;
};

/**
 * Validate levels fields. Spec: level_index is any finite number (negative
 * allowed for basements). level_id is required string but that's a row-level
 * check (PK) handled by SQLite, not field-level here.
 */
const validateLevelFields = (body) => {
  const errors = [];

  if (
    "level_index" in body &&
    body.level_index !== null &&
    body.level_index !== ""
  ) {
    if (!isValidNumber(body.level_index)) {
      errors.push("level_index must be a finite number");
    }
  }

  return errors;
};

/**
 * Validate pathways fields. Spec: pathway_mode ∈ {1..7}, is_bidirectional
 * ∈ {0,1}, length / traversal_time / stair_count / max_slope / min_width
 * have type-specific constraints.
 */
const validatePathwayFields = (body) => {
  const errors = [];

  if ("pathway_mode" in body && !isValidPathwayMode(body.pathway_mode)) {
    errors.push("pathway_mode must be 1, 2, 3, 4, 5, 6 or 7");
  }

  if (
    "is_bidirectional" in body &&
    !isValidBidirectional(body.is_bidirectional)
  ) {
    errors.push("is_bidirectional must be 0 or 1");
  }

  // length: non-negative number (metres)
  if ("length" in body && body.length !== null && body.length !== "") {
    if (!isValidNonNegativeNumber(body.length)) {
      errors.push("length must be a non-negative number (metres)");
    }
  }

  // traversal_time: non-negative integer (seconds)
  if (
    "traversal_time" in body &&
    body.traversal_time !== null &&
    body.traversal_time !== ""
  ) {
    if (!isValidNonNegativeInt(body.traversal_time)) {
      errors.push("traversal_time must be a non-negative integer (seconds)");
    }
  }

  // stair_count: integer (negative = down). Accept any integer.
  if (
    "stair_count" in body &&
    body.stair_count !== null &&
    body.stair_count !== ""
  ) {
    const n = Number(body.stair_count);
    if (!Number.isInteger(n)) {
      errors.push("stair_count must be an integer");
    }
  }

  // max_slope: any finite number (rise/run).
  if ("max_slope" in body && body.max_slope !== null && body.max_slope !== "") {
    if (!isValidNumber(body.max_slope)) {
      errors.push("max_slope must be a finite number");
    }
  }

  // min_width: non-negative number (metres).
  if ("min_width" in body && body.min_width !== null && body.min_width !== "") {
    if (!isValidNonNegativeNumber(body.min_width)) {
      errors.push("min_width must be a non-negative number (metres)");
    }
  }

  return errors;
};

/**
 * Validate translations fields. Spec: language is BCP 47.
 * record_id, table_name, field_name, translation are required strings —
 * existence is enforced by NOT NULL columns at the DB level.
 */
const validateTranslationFields = (body) => {
  const errors = [];

  if ("language" in body && body.language !== null && body.language !== "") {
    if (!isValidLanguageCode(body.language)) {
      errors.push("language must be a valid BCP 47 language tag (e.g. 'en', 'fr-CA')");
    }
  }

  return errors;
};

/**
 * Validate feed_info fields. Spec: feed_lang/default_lang BCP 47,
 * feed_start_date/feed_end_date YYYYMMDD, feed_publisher_url and
 * feed_contact_url are HTTP URLs, feed_contact_email is a valid email.
 */
const validateFeedInfoFields = (body) => {
  const errors = [];

  for (const f of ["feed_lang", "default_lang"]) {
    if (f in body && body[f] !== null && body[f] !== "") {
      if (!isValidLanguageCode(body[f])) {
        errors.push(`${f} must be a valid BCP 47 language tag`);
      }
    }
  }

  for (const f of ["feed_start_date", "feed_end_date"]) {
    if (f in body && body[f] !== null && body[f] !== "") {
      if (!isValidYYYYMMDDDate(String(body[f]))) {
        errors.push(`${f} must match YYYYMMDD`);
      }
    }
  }

  for (const f of ["feed_publisher_url", "feed_contact_url"]) {
    if (f in body && body[f] !== null && body[f] !== "") {
      if (!isValidHttpUrl(body[f])) {
        errors.push(`${f} must be a valid HTTP/HTTPS URL`);
      }
    }
  }

  if (
    "feed_contact_email" in body &&
    body.feed_contact_email !== null &&
    body.feed_contact_email !== ""
  ) {
    if (!isValidEmail(body.feed_contact_email)) {
      errors.push("feed_contact_email must be a valid email address");
    }
  }

  return errors;
};

/**
 * Validate attributions fields. Spec: is_producer / is_operator / is_authority
 * are 0|1, organization_name required (NOT NULL — DB-level), attribution_url
 * is HTTP, attribution_email is email.
 */
const validateAttributionFields = (body) => {
  const errors = [];

  for (const f of ["is_producer", "is_operator", "is_authority"]) {
    if (f in body && !isValidAttributionRole(body[f])) {
      errors.push(`${f} must be 0 or 1`);
    }
  }

  if (
    "organization_name" in body &&
    typeof body.organization_name === "string" &&
    body.organization_name.trim() === ""
  ) {
    errors.push("organization_name must not be empty");
  }

  if (
    "attribution_url" in body &&
    body.attribution_url !== null &&
    body.attribution_url !== ""
  ) {
    if (!isValidHttpUrl(body.attribution_url)) {
      errors.push("attribution_url must be a valid HTTP/HTTPS URL");
    }
  }

  if (
    "attribution_email" in body &&
    body.attribution_email !== null &&
    body.attribution_email !== ""
  ) {
    if (!isValidEmail(body.attribution_email)) {
      errors.push("attribution_email must be a valid email address");
    }
  }

  return errors;
};

// ── Fares v1 — fare_attributes ─────────────────────────────────────────────

const VALID_PAYMENT_METHODS = new Set(["0", "1"]);
const ISO_4217_RE = /^[A-Z]{3}$/;

const validateFareAttributeFields = (body) => {
  const errors = [];
  if ("fare_id" in body && (!body.fare_id || String(body.fare_id).trim() === "")) {
    errors.push("fare_id must not be empty");
  }
  if ("price" in body && (body.price === null || body.price === "")) {
    errors.push("price must not be empty");
  }
  if (
    "currency_type" in body &&
    (typeof body.currency_type !== "string" || !ISO_4217_RE.test(body.currency_type.toUpperCase()))
  ) {
    errors.push("currency_type must be an ISO 4217 alpha-3 code (e.g. EUR, USD, JPY)");
  }
  if (
    "payment_method" in body &&
    !VALID_PAYMENT_METHODS.has(String(body.payment_method ?? ""))
  ) {
    errors.push("payment_method must be 0 (onboard) or 1 (before-board)");
  }
  return errors;
};

// ── Fares v1 — fare_rules ──────────────────────────────────────────────────

const validateFareRuleFields = (body) => {
  const errors = [];
  if ("fare_id" in body && (!body.fare_id || String(body.fare_id).trim() === "")) {
    errors.push("fare_id is required (FK to fare_attributes)");
  }
  return errors;
};

// ── Fares v2 — generic non-empty PK helpers ────────────────────────────────

const _requireNonEmpty = (body, field, label, errors) => {
  if (field in body && (body[field] === null || String(body[field]).trim() === "")) {
    errors.push(`${label} must not be empty`);
  }
};

const validateAreaFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "area_id", "area_id", errors);
  return errors;
};

const validateStopAreaFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "area_id", "area_id", errors);
  _requireNonEmpty(body, "stop_id", "stop_id", errors);
  return errors;
};

const validateNetworkFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "network_id", "network_id", errors);
  return errors;
};

const validateRouteNetworkFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "network_id", "network_id", errors);
  _requireNonEmpty(body, "route_id", "route_id", errors);
  return errors;
};

// ── Fares v2 — fare_media (type enum) ──────────────────────────────────────

const VALID_FARE_MEDIA_TYPES = new Set(["0", "1", "2", "3", "4"]);

// Returns true when the value should be treated as "not provided" (validators
// only complain when a value IS provided AND fails — otherwise the absent /
// null / empty case is handled by NOT NULL on the DDL or the
// REQUIRED_FIELDS_BY_TABLE pre-check).
const _isAbsent = (v) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const validateFareMediaFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "fare_media_id", "fare_media_id", errors);
  if (
    "fare_media_type" in body &&
    !_isAbsent(body.fare_media_type) &&
    !VALID_FARE_MEDIA_TYPES.has(String(body.fare_media_type))
  ) {
    errors.push(
      "fare_media_type must be 0 (cash), 1 (paper), 2 (transit card), 3 (cEMV) or 4 (mobile app)",
    );
  }
  return errors;
};

// ── Fares v2 — rider_categories ────────────────────────────────────────────

const validateRiderCategoryFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "rider_category_id", "rider_category_id", errors);
  _requireNonEmpty(body, "rider_category_name", "rider_category_name", errors);
  if (
    "is_default_fare_category" in body &&
    !_isAbsent(body.is_default_fare_category) &&
    String(body.is_default_fare_category) !== "0" &&
    String(body.is_default_fare_category) !== "1"
  ) {
    errors.push("is_default_fare_category must be 0 or 1");
  }
  if (
    "eligibility_url" in body &&
    body.eligibility_url !== null &&
    body.eligibility_url !== "" &&
    !isValidHttpUrl(body.eligibility_url)
  ) {
    errors.push("eligibility_url must be a valid HTTP/HTTPS URL");
  }
  return errors;
};

// ── Fares v2 — fare_products (currency-amount precision) ───────────────────

const validateFareProductFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "fare_product_id", "fare_product_id", errors);
  _requireNonEmpty(body, "amount", "amount", errors);
  _requireNonEmpty(body, "currency", "currency", errors);
  if (
    "amount" in body &&
    body.amount != null &&
    String(body.amount).trim() !== "" &&
    !/^\d+(\.\d+)?$/.test(String(body.amount).trim())
  ) {
    errors.push("amount must be a non-negative decimal number (e.g. 1.50)");
  }
  if (
    "currency" in body &&
    typeof body.currency === "string" &&
    body.currency.trim() !== "" &&
    !ISO_4217_RE.test(body.currency.toUpperCase())
  ) {
    errors.push("currency must be an ISO 4217 alpha-3 code (e.g. EUR, USD, JPY)");
  }
  return errors;
};

// ── Fares v2 — timeframes ──────────────────────────────────────────────────

const validateTimeframeFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "timeframe_group_id", "timeframe_group_id", errors);
  _requireNonEmpty(body, "service_id", "service_id", errors);
  for (const f of ["start_time", "end_time"]) {
    if (f in body && body[f] != null && String(body[f]).trim() !== "" && !TIME_HHMMSS_RE.test(body[f])) {
      errors.push(`${f} must be HH:MM:SS`);
    }
  }
  return errors;
};

// ── Fares v2 — fare_leg_rules / fare_leg_join_rules ────────────────────────

const validateFareLegRuleFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "fare_product_id", "fare_product_id", errors);
  return errors;
};

const validateFareLegJoinRuleFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "from_network_id", "from_network_id", errors);
  _requireNonEmpty(body, "to_network_id", "to_network_id", errors);
  return errors;
};

// ── Fares v2 — fare_transfer_rules ─────────────────────────────────────────

const VALID_FARE_TRANSFER_TYPES = new Set(["0", "1", "2"]);
const VALID_DURATION_LIMIT_TYPES = new Set(["", "0", "1", "2", "3"]);

const validateFareTransferRuleFields = (body) => {
  const errors = [];
  if (
    "fare_transfer_type" in body &&
    !_isAbsent(body.fare_transfer_type) &&
    !VALID_FARE_TRANSFER_TYPES.has(String(body.fare_transfer_type))
  ) {
    errors.push("fare_transfer_type must be 0, 1, or 2");
  }
  if (
    "duration_limit_type" in body &&
    !_isAbsent(body.duration_limit_type) &&
    !VALID_DURATION_LIMIT_TYPES.has(String(body.duration_limit_type))
  ) {
    errors.push("duration_limit_type must be 0, 1, 2, or 3");
  }
  if (
    "transfer_count" in body &&
    body.transfer_count != null &&
    String(body.transfer_count).trim() !== ""
  ) {
    const tc = String(body.transfer_count).trim();
    if (tc !== "-1" && !/^\d+$/.test(tc)) {
      errors.push("transfer_count must be -1 (unlimited) or a positive integer");
    } else if (/^\d+$/.test(tc) && Number(tc) < 1) {
      errors.push("transfer_count must be -1 (unlimited) or a positive integer");
    }
  }
  return errors;
};

// ── Phone-number predicate (used by booking_rules contact field) ──────────
// Pragmatic match: digits with optional +, spaces, dashes, parens, dots —
// 4 to 30 chars after trim. Matches realistic phone numbers internationally
// without false-positiving on obvious garbage like emails or URLs.
const PHONE_RE = /^[+]?[\d\s\-().]{4,30}$/;
const isValidPhone = (val) =>
  typeof val === "string" && PHONE_RE.test(val.trim());

// ── DRT / Flex — booking_rules ─────────────────────────────────────────────

const VALID_BOOKING_TYPES = new Set(["0", "1", "2"]);

const validateBookingRuleFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "booking_rule_id", "booking_rule_id", errors);
  if (
    "booking_type" in body &&
    !_isAbsent(body.booking_type) &&
    !VALID_BOOKING_TYPES.has(String(body.booking_type))
  ) {
    errors.push(
      "booking_type must be 0 (real-time), 1 (same-day with prior notice) or 2 (prior day)",
    );
  }
  if (
    "phone_number" in body &&
    body.phone_number !== null &&
    body.phone_number !== "" &&
    !isValidPhone(body.phone_number)
  ) {
    errors.push("phone_number must be a valid phone number");
  }
  for (const f of ["info_url", "booking_url"]) {
    if (f in body && body[f] !== null && body[f] !== "" && !isValidHttpUrl(body[f])) {
      errors.push(`${f} must be a valid HTTP/HTTPS URL`);
    }
  }
  return errors;
};

// ── GTFS-Flex — locations_geojson row ──────────────────────────────────────

const VALID_GEOMETRY_TYPES = new Set(["Polygon", "MultiPolygon"]);

// ── GTFS-Flex location_groups (managed since schema v13) ──────────────────
//
// location_groups.txt:
//   location_group_id   (Required, string, unique PK)
//   location_group_name (Optional, string)
//
// location_group_stops.txt:
//   location_group_id (Required, FK to location_groups)
//   stop_id           (Required, FK to stops)
//
// Validators are intentionally minimal — the FK / NOT NULL / PK invariants
// are enforced at the DB layer, here we just reject empty PK strings.

const validateLocationGroupFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "location_group_id", "location_group_id", errors);
  return errors;
};

const validateLocationGroupStopFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "location_group_id", "location_group_id", errors);
  _requireNonEmpty(body, "stop_id", "stop_id", errors);
  return errors;
};

const validateLocationsGeojsonFields = (body) => {
  const errors = [];
  _requireNonEmpty(body, "feature_id", "feature_id", errors);
  if (
    "geometry_type" in body &&
    !_isAbsent(body.geometry_type) &&
    !VALID_GEOMETRY_TYPES.has(body.geometry_type)
  ) {
    errors.push("geometry_type must be 'Polygon' or 'MultiPolygon'");
  }
  // coordinates is stored as a JSON string blob in SQLite. Accept only
  // strings that parse as JSON. Rejecting anything else (numbers, arrays
  // passed raw, etc.) keeps the DB invariant clean.
  if ("coordinates" in body) {
    if (body.coordinates === null || body.coordinates === "") {
      errors.push("coordinates must not be empty (JSON array of rings)");
    } else if (typeof body.coordinates !== "string") {
      errors.push("coordinates must be a JSON string");
    } else if (body.coordinates.trim() !== "") {
      try {
        JSON.parse(body.coordinates);
      } catch (_) {
        errors.push("coordinates must be valid JSON");
      }
    }
  }
  if (
    "extra_properties" in body &&
    body.extra_properties !== null &&
    body.extra_properties !== ""
  ) {
    if (typeof body.extra_properties !== "string") {
      errors.push("extra_properties must be a JSON string if present");
    } else if (body.extra_properties.trim() !== "") {
      try {
        JSON.parse(body.extra_properties);
      } catch (_) {
        errors.push("extra_properties must be valid JSON if present");
      }
    }
  }
  return errors;
};

// ── Internal helpers (not exported) ─────────────────────────────────────────

/**
 * GTFS spec §stops.txt: stop_name is REQUIRED for location_type 0 (stop),
 * 1 (station) and 2 (entrance/exit). Optional for 3 (generic node) and
 * 4 (boarding area).
 */
const _STOP_NAME_REQUIRED_TYPES = new Set([0, 1, 2]);

/** Valid service-day values (0 or 1 as numbers). */
const _SERVICE_DAY_VALUES = new Set([0, 1]);

/**
 * Returns the effective location_type as a number from a patch/body object.
 * Defaults to 0 (stop) when not supplied, matching the GTFS spec default.
 */
const _resolveLocationType = (body) => {
  if (
    body.location_type === undefined ||
    body.location_type === null ||
    body.location_type === ""
  ) {
    return 0;
  }
  return Number(body.location_type);
};

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Regex constants
  HEX_COLOR_RE,
  DATE_YYYYMMDD_RE,
  TIME_HHMMSS_RE,

  // Enum value sets
  ENUM_0_1_2,
  ENUM_0_1,
  isEnumValue,

  // Predicates
  isValidLat,
  isValidLon,
  isValidHexColor,
  isValidServiceDay,
  isValidYYYYMMDDDate,
  isValidDirectionId,
  isValidWheelchairBoarding,
  isValidContinuousPickupDropOff,
  isValidLanguageCode,
  isValidTimezone,
  isValidPickupDropOffType,
  isValidRouteType,
  isValidGtfsTime,
  isValidHttpUrl,
  isValidEmail,
  isValidPhone,
  isValidNonNegativeNumber,
  isValidNonNegativeInt,
  isValidNumber,
  isValidPathwayMode,
  isValidBidirectional,
  isValidTransferType,
  isValidExceptionType,
  isValidExactTimes,
  isValidTimepoint,
  isValidAttributionRole,

  // Higher-level field-group validators
  validateStopFields,
  validateRouteFields,
  validateTripFields,
  validateCalendarFields,
  validateAgencyFields,
  validateStopTimeFields,
  validateCalendarDateFields,
  validateShapeFields,
  validateFrequencyFields,
  validateTransferFields,
  validateLevelFields,
  validatePathwayFields,
  validateTranslationFields,
  validateFeedInfoFields,
  validateAttributionFields,
  // Schema v11: Fares v1 + Fares v2 + Booking + Flex
  validateFareAttributeFields,
  validateFareRuleFields,
  validateAreaFields,
  validateStopAreaFields,
  validateNetworkFields,
  validateRouteNetworkFields,
  validateFareMediaFields,
  validateRiderCategoryFields,
  validateFareProductFields,
  validateTimeframeFields,
  validateFareLegRuleFields,
  validateFareLegJoinRuleFields,
  validateFareTransferRuleFields,
  validateBookingRuleFields,
  validateLocationGroupFields,
  validateLocationGroupStopFields,
  validateLocationsGeojsonFields,

  // Exported for use by editService.js (internal helpers needed there)
  _STOP_NAME_REQUIRED_TYPES,
  _SERVICE_DAY_VALUES,
  _resolveLocationType,
};
