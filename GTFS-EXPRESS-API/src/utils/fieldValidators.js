/**
 * Field-level validation shared by the edit services and the SQL console: the predicates
 * return a boolean, the validateXFields helpers the error messages the web shows as they are.
 */

"use strict";

// ── Regex constants

const HEX_COLOR_RE = /^[0-9A-Fa-f]{6}$/;

const DATE_YYYYMMDD_RE = /^\d{8}$/;

const TIME_HHMMSS_RE = /^\d+:[0-5]\d:[0-5]\d$/;

/** Lenient BCP 47: catches obvious typos, not every invalid tag. */
const BCP47_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4}){0,2}$/;

/** Three-state enums (bikes_allowed, cars_allowed, cemv_support); absent is valid. */
const ENUM_0_1_2 = new Set(["0", "1", "2", "", null, undefined]);

/** Two-state enums (stop_access); absent is valid. */
const ENUM_0_1 = new Set(["0", "1", "", null, undefined]);

/** location_type: stop, station, entrance, generic node, boarding area; absent is valid. */
const ENUM_0_TO_4 = new Set(["0", "1", "2", "3", "4", "", null, undefined]);

const isEnumValue = (val, allowedSet) => {
  if (val === null || val === undefined || val === "") return true;
  return allowedSet.has(String(val));
};

const _tzCache = new Map();
// Canonical IANA names; absent (older runtimes) or incomplete (no UTC, no links such as US/Eastern), so only a
// positive lookup counts.
const _tzCanonical = (() => {
  try {
    return new Set(Intl.supportedValuesOf("timeZone"));
  } catch (_) {
    return new Set();
  }
})();
// Every segment of an IANA name starts with a capital or a digit: Europe/Paris, Etc/GMT+1, US/Eastern, W-SU.
const TZ_SHAPE_RE = /^[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z0-9][A-Za-z0-9_+-]*)*$/;

/** GTFS route types: the basic 0-12 and the extended (Hierarchical Vehicle Type) set, 100-1702. */
const ROUTE_TYPE_RANGES = [
  [0, 12], [100, 117], [200, 209], [300, 300], [400, 405], [500, 500], [600, 600], [700, 717], [800, 800],
  [900, 906], [1000, 1021], [1100, 1114], [1200, 1200], [1300, 1307], [1400, 1400], [1500, 1507], [1600, 1604],
  [1700, 1702],
];

// ── Predicates ───────────────────────────────────────────────────────────────

/** Numbers only: a string is not coerced. */
const isValidLat = (value) =>
  typeof value === "number" && isFinite(value) && value >= -90 && value <= 90;

/** Numbers only: a string is not coerced. */
const isValidLon = (value) =>
  typeof value === "number" &&
  isFinite(value) &&
  value >= -180 &&
  value <= 180;

/** No '#'. An empty string is invalid: the caller decides whether the field is optional. */
const isValidHexColor = (value) =>
  typeof value === "string" && HEX_COLOR_RE.test(value);

const isValidServiceDay = (value) => {
  const n = Number(value);
  return (n === 0 || n === 1) && !isNaN(n);
};

/** A real calendar day written YYYYMMDD: 20260230 is refused. */
const isValidYYYYMMDDDate = (value) => {
  const s = String(value);
  if (!DATE_YYYYMMDD_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
};

const isValidDirectionId = (value) => ["0", "1"].includes(String(value));

/** Absent (null, undefined, empty) is valid. */
const isValidWheelchairBoarding = (value) => isEnumValue(value, ENUM_0_1_2);

/** Null counts as empty. */
const isValidContinuousPickupDropOff = (value) => {
  const s = value === null ? "" : String(value);
  return ["", "0", "1", "2", "3"].includes(s);
};

const isValidLanguageCode = (value) => {
  if (!value || typeof value !== "string") return false;
  return BCP47_RE.test(value.trim());
};

/**
 * An IANA name in its exact case: Intl accepts "america/new_york" and resolves it to America/New_York, so a name
 * is valid when it is canonical, or resolves to itself, or is a link (US/Eastern) in IANA capitalisation.
 */
const isValidTimezone = (tz) => {
  if (!tz || typeof tz !== "string") return false;
  const key = tz.trim();
  if (key === "") return false;
  if (_tzCache.has(key)) return _tzCache.get(key);
  let ok = false;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: key }).resolvedOptions().timeZone;
    ok =
      TZ_SHAPE_RE.test(key) &&
      (_tzCanonical.has(key) || resolved === key || resolved.toLowerCase() !== key.toLowerCase());
  } catch (_) {
    ok = false;
  }
  _tzCache.set(key, ok);
  return ok;
};

const isValidPickupDropOffType = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return ["", "0", "1", "2", "3"].includes(s);
};

const isValidRouteType = (value) => {
  if (!_isNumericLike(value)) return false;
  const n = Number(value);
  return Number.isInteger(n) && ROUTE_TYPE_RANGES.some(([lo, hi]) => n >= lo && n <= hi);
};

/** Hours past 24 are valid (overnight service). */
const isValidGtfsTime = (value) => {
  if (typeof value !== "string") return false;
  return TIME_HHMMSS_RE.test(value);
};

// ── Field-group validators: their messages reach the web as they are

const validateStopFields = (body) => {
  const errors = [];

  if ("stop_lat" in body && body.stop_lat !== null) {
    // Number() would let through true as 1 and [48] as 48.
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
    // Null is valid for location_type 3 and 4; the required check below covers 0, 1 and 2.
    if (body.stop_name !== null && typeof body.stop_name !== "string") {
      errors.push("stop_name must be a string");
    } else {
      const trimmed =
        body.stop_name === null || body.stop_name === undefined
          ? ""
          : body.stop_name.trim();
      if (trimmed === "") {
        // The single-entity handlers pass the patch merged with the stored row and the
        // SQL console the whole row, so location_type is known here.
        const lt = _resolveLocationType(body);
        if (_STOP_NAME_REQUIRED_TYPES.has(lt)) {
          errors.push(
            "stop_name is required for stops with location_type 0 (stop), 1 (station), or 2 (entrance/exit) and cannot be empty",
          );
        }
      }
    }
  }

  if ("wheelchair_boarding" in body && !isEnumValue(body.wheelchair_boarding, ENUM_0_1_2)) {
    errors.push("wheelchair_boarding must be 0, 1 or 2");
  }

  if ("location_type" in body && !isEnumValue(body.location_type, ENUM_0_TO_4)) {
    errors.push("location_type must be 0, 1, 2, 3 or 4");
  }

  if ("stop_timezone" in body && !_isAbsent(body.stop_timezone) && !isValidTimezone(body.stop_timezone)) {
    errors.push("stop_timezone must be a valid IANA timezone name");
  }

  if ("stop_url" in body && !_isAbsent(body.stop_url) && !isValidHttpUrl(body.stop_url)) {
    errors.push("stop_url must be a valid HTTP/HTTPS URL");
  }

  if ("stop_access" in body && !isEnumValue(body.stop_access, ENUM_0_1)) {
    errors.push({ field: "stop_access", message: "Must be 0 or 1 if specified" });
  }

  // stop_access is allowed only on a stop (location_type 0 or empty) with a parent_station.
  // Checked only when the body carries both columns: `_editCore.js` checks a partial patch
  // against the stored row.
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

  if ("route_type" in body && !_isAbsent(body.route_type) && !isValidRouteType(body.route_type)) {
    errors.push("route_type must be a GTFS route type (0-12) or an extended route type (100-1702)");
  }

  if ("route_url" in body && !_isAbsent(body.route_url) && !isValidHttpUrl(body.route_url)) {
    errors.push("route_url must be a valid HTTP/HTTPS URL");
  }

  if ("route_sort_order" in body && !_isAbsent(body.route_sort_order) && !isValidNonNegativeInt(body.route_sort_order)) {
    errors.push("route_sort_order must be a non-negative integer");
  }

  if ("continuous_pickup" in body && !isValidContinuousPickupDropOff(body.continuous_pickup)) {
    errors.push("continuous_pickup must be 0, 1, 2 or 3");
  }

  if ("continuous_drop_off" in body && !isValidContinuousPickupDropOff(body.continuous_drop_off)) {
    errors.push("continuous_drop_off must be 0, 1, 2 or 3");
  }

  if ("cemv_support" in body && !isEnumValue(body.cemv_support, ENUM_0_1_2)) {
    errors.push({ field: "cemv_support", message: "Must be 0, 1 or 2 if specified" });
  }

  return errors;
};

const validateTripFields = (body) => {
  const errors = [];

  if ("direction_id" in body && !isEnumValue(body.direction_id, ENUM_0_1)) {
    errors.push("direction_id must be 0 or 1");
  }

  if ("wheelchair_accessible" in body && !isEnumValue(body.wheelchair_accessible, ENUM_0_1_2)) {
    errors.push("wheelchair_accessible must be 0, 1 or 2");
  }

  if ("bikes_allowed" in body && !isEnumValue(body.bikes_allowed, ENUM_0_1_2)) {
    errors.push("bikes_allowed must be 0, 1 or 2");
  }

  if ("cars_allowed" in body && !isEnumValue(body.cars_allowed, ENUM_0_1_2)) {
    errors.push({ field: "cars_allowed", message: "Must be 0, 1 or 2 if specified" });
  }

  return errors;
};

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

  let datesOk = true;
  for (const d of ["start_date", "end_date"]) {
    if (d in body && !isValidYYYYMMDDDate(body[d])) {
      errors.push(`${d} must be a valid date written YYYYMMDD`);
      datesOk = false;
    }
  }

  // The single-entity handlers merge the patch with the stored row, so both dates are known here.
  if (
    datesOk &&
    !_isAbsent(body.start_date) &&
    !_isAbsent(body.end_date) &&
    String(body.end_date) < String(body.start_date)
  ) {
    errors.push("end_date must not be before start_date");
  }

  return errors;
};

/** The required agency fields are checked by createAgency: they depend on create or patch. */
const validateAgencyFields = (body) => {
  const errors = [];

  if ("agency_name" in body && (typeof body.agency_name !== "string" || body.agency_name.trim() === "")) {
    errors.push("agency_name must not be empty");
  }

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

/** http(s) only; empty is invalid. */
const isValidHttpUrl = (value) => {
  if (typeof value !== "string" || value.trim() === "") return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
};

/** Pragmatic (local@domain.tld), not an RFC 5322 parser. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isValidEmail = (value) =>
  typeof value === "string" && EMAIL_RE.test(value.trim());

// ── Numeric helpers ──────────────────────────────────────────────────────────

/** A number or a decimal string: Number(true) is 1, Number([42]) is 42 and Number("0x10") is 16. */
const DECIMAL_RE = /^\s*[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$/;
const _isNumericLike = (value) => {
  if (value === null || value === undefined || value === "") return false;
  return typeof value === "number" || (typeof value === "string" && DECIMAL_RE.test(value));
};

const isValidNonNegativeNumber = (value) => {
  if (!_isNumericLike(value)) return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
};

const isValidNonNegativeInt = (value) => {
  if (!_isNumericLike(value)) return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0;
};

const isValidNumber = (value) => {
  if (!_isNumericLike(value)) return false;
  const n = Number(value);
  return Number.isFinite(n);
};

// ── GTFS-specific enum predicates ────────────────────────────────────────────

/** 1 to 7; required, so empty is invalid. */
const isValidPathwayMode = (value) => {
  if (value === null || value === undefined || value === "") return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 7;
};

/** Required, so empty is invalid. */
const isValidBidirectional = (value) => {
  if (value === null || value === undefined || value === "") return false;
  return ["0", "1"].includes(String(value));
};

/** 0 to 5, empty meaning 0. */
const isValidTransferType = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return ["", "0", "1", "2", "3", "4", "5"].includes(s);
};

/** Required, so empty is invalid. */
const isValidExceptionType = (value) => {
  if (value === null || value === undefined || value === "") return false;
  return ["1", "2"].includes(String(value));
};

const isValidExactTimes = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return ["", "0", "1"].includes(s);
};

const isValidTimepoint = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return ["", "0", "1"].includes(s);
};

const isValidAttributionRole = (value) => {
  const s = value === null || value === undefined ? "" : String(value);
  return ["", "0", "1"].includes(s);
};

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

const validateCalendarDateFields = (body) => {
  const errors = [];

  if ("date" in body && body.date !== null && body.date !== "") {
    if (!isValidYYYYMMDDDate(String(body.date))) {
      errors.push("date must be a valid date written YYYYMMDD");
    }
  }

  if ("exception_type" in body) {
    if (!isValidExceptionType(body.exception_type)) {
      errors.push("exception_type must be 1 (service added) or 2 (service removed)");
    }
  }

  return errors;
};

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

const validateFrequencyFields = (body) => {
  const errors = [];

  for (const f of ["start_time", "end_time"]) {
    if (f in body && body[f] !== null && body[f] !== "") {
      if (!isValidGtfsTime(String(body[f]))) {
        errors.push(`${f} must be a GTFS time string (HH:MM:SS, ≥24h allowed)`);
      }
    }
  }

  // Both bound a frequency window: neither may be cleared.
  for (const f of ["start_time", "end_time"]) {
    if (f in body && _isAbsent(body[f])) errors.push(`${f} is required`);
  }

  if (
    "headway_secs" in body &&
    body.headway_secs !== null &&
    body.headway_secs !== ""
  ) {
    const n = Number(body.headway_secs);
    if (!_isNumericLike(body.headway_secs) || !Number.isInteger(n) || n <= 0) {
      errors.push("headway_secs must be a positive integer");
    }
  }

  if ("exact_times" in body && !isValidExactTimes(body.exact_times)) {
    errors.push("exact_times must be 0 or 1");
  }

  return errors;
};

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

/** level_index may be negative (basements); level_id is the table's key, held by SQLite. */
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

  if ("length" in body && body.length !== null && body.length !== "") {
    if (!isValidNonNegativeNumber(body.length)) {
      errors.push("length must be a non-negative number (metres)");
    }
  }

  if (
    "traversal_time" in body &&
    body.traversal_time !== null &&
    body.traversal_time !== ""
  ) {
    if (!isValidNonNegativeInt(body.traversal_time)) {
      errors.push("traversal_time must be a non-negative integer (seconds)");
    }
  }

  // A negative stair_count counts stairs going down.
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

  if ("max_slope" in body && body.max_slope !== null && body.max_slope !== "") {
    if (!isValidNumber(body.max_slope)) {
      errors.push("max_slope must be a finite number");
    }
  }

  if ("min_width" in body && body.min_width !== null && body.min_width !== "") {
    if (!isValidNonNegativeNumber(body.min_width)) {
      errors.push("min_width must be a non-negative number (metres)");
    }
  }

  return errors;
};

/** The required translation columns are NOT NULL in the schema. */
const validateTranslationFields = (body) => {
  const errors = [];

  if ("language" in body && body.language !== null && body.language !== "") {
    if (!isValidLanguageCode(body.language)) {
      errors.push("language must be a valid BCP 47 language tag (e.g. 'en', 'fr-CA')");
    }
  }

  return errors;
};

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

// ── Fares v1

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

const validateFareRuleFields = (body) => {
  const errors = [];
  if ("fare_id" in body && (!body.fare_id || String(body.fare_id).trim() === "")) {
    errors.push("fare_id is required (FK to fare_attributes)");
  }
  return errors;
};

// ── Fares v2

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

const VALID_FARE_MEDIA_TYPES = new Set(["0", "1", "2", "3", "4"]);

// An absent value passes here: NOT NULL in the schema or the required-fields check refuses it.
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

// Lenient: digits and phone separators, 4 to 30 characters, which still refuses an e-mail or a URL.
const PHONE_RE = /^[+]?[\d\s\-().]{4,30}$/;
const isValidPhone = (val) =>
  typeof val === "string" && PHONE_RE.test(val.trim());

// ── Flex: booking rules, locations and location groups

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

const VALID_GEOMETRY_TYPES = new Set(["Polygon", "MultiPolygon"]);

// The schema holds the location groups' keys and references; here only an empty key is refused.

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
  // coordinates is stored as a JSON string.
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

// ── Internal helpers

/** The location_type values whose stop_name is required: stop, station, entrance. */
const _STOP_NAME_REQUIRED_TYPES = new Set([0, 1, 2]);

const _SERVICE_DAY_VALUES = new Set([0, 1]);

/** location_type as a number, 0 (the spec's default) when absent. */
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

module.exports = {
  // Regex constants
  HEX_COLOR_RE,
  DATE_YYYYMMDD_RE,
  TIME_HHMMSS_RE,

  // Enum value sets
  ENUM_0_1_2,
  ENUM_0_1,
  ENUM_0_TO_4,
  ROUTE_TYPE_RANGES,
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
  // Fares, booking rules and Flex
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

  // Internal helpers
  _STOP_NAME_REQUIRED_TYPES,
  _SERVICE_DAY_VALUES,
  _resolveLocationType,
};
