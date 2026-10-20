/* ------------------------------------------------------------------ */
/* Editable fields per table — single source of truth on the frontend  */
/* (mirrors backend EDITABLE_FIELDS; bulk inline mutator uses this).    */
/*                                                                     */
/* Also exports the table → entity / endpoint maps used to translate   */
/* an inline cell edit into the matching PATCH/PUT call, plus the      */
/* cascade hints surfaced before a destructive mutation.                */
/* ------------------------------------------------------------------ */

export const TABLE_TO_ENTITY = {
  stops: "stop",
  routes: "route",
  trips: "trip",
  agency: "agency",
  calendar: "calendar",
  levels: "level",
  pathways: "pathway",
  attributions: "attribution",
  translations: "translation",
  transfers: "transfer",
  stop_times: "stop_time",
  frequencies: "frequency",
  feed_info: "feedInfo",
  // Fares v1
  fare_attributes: "fare_attribute",
  fare_rules: "fare_rule",
  // Fares v2
  areas: "area",
  stop_areas: "stop_area",
  networks: "network",
  route_networks: "route_network",
  fare_media: "fare_media",
  rider_categories: "rider_category",
  fare_products: "fare_product",
  timeframes: "timeframe",
  fare_leg_rules: "fare_leg_rule",
  fare_leg_join_rules: "fare_leg_join_rule",
  fare_transfer_rules: "fare_transfer_rule",
  // Flex
  booking_rules: "booking_rule",
  locations_geojson: "location_geojson",
  location_groups: "location_group",
};

// Editing dialogs we can open directly from the result table.
export const EDITABLE_ENTITIES = new Set(["stop", "route", "trip"]);

/* ------------------------------------------------------------------ */
/* Backend PATCH endpoints map (entity → URL builder)                  */
/* Used by inline cell-editing to commit a single-field mutation.       */
/* If an entity is not listed here, cell editing falls back gracefully  */
/* (handler shows a snackbar telling the user to use the SQL editor).   */
/* ------------------------------------------------------------------ */

export const PATCH_ENDPOINTS = {
  stop: {
    method: "PATCH",
    url: (row) => `/edit/stops/${encodeURIComponent(row.stop_id)}`,
  },
  route: {
    method: "PATCH",
    url: (row) => `/edit/routes/${encodeURIComponent(row.route_id)}`,
  },
  trip: {
    method: "PATCH",
    url: (row) => `/edit/trips/${encodeURIComponent(row.trip_id)}`,
  },
  agency: {
    method: "PATCH",
    url: (row) => `/edit/agencies/${encodeURIComponent(row.agency_id)}`,
  },
  calendar: {
    method: "PATCH",
    url: (row) => `/edit/calendar/${encodeURIComponent(row.service_id)}`,
  },
  level: {
    method: "PATCH",
    url: (row) => `/edit/levels/${encodeURIComponent(row.level_id)}`,
  },
  pathway: {
    method: "PATCH",
    url: (row) => `/edit/pathways/${encodeURIComponent(row.pathway_id)}`,
  },
  attribution: {
    method: "PATCH",
    url: (row) =>
      row.rowid != null
        ? `/edit/attributions/${encodeURIComponent(row.rowid)}`
        : null,
  },
  translation: {
    method: "PATCH",
    url: (row) =>
      row.rowid != null
        ? `/edit/translations/${encodeURIComponent(row.rowid)}`
        : null,
  },
  // Composite-PK / specialised endpoints
  transfer: {
    method: "PATCH",
    url: (row) =>
      row.id != null ? `/edit/transfers/${encodeURIComponent(row.id)}` : null,
  },
  stop_time: {
    method: "PATCH",
    url: (row) =>
      row.trip_id != null && row.stop_sequence != null
        ? `/edit/stop_times/${encodeURIComponent(row.trip_id)}/${encodeURIComponent(row.stop_sequence)}`
        : null,
  },
  // frequencies: backend keeps start_time in the BODY because ":" can't safely
  // travel as a URL segment. We must therefore include start_time in the PATCH
  // payload alongside the patched field.
  frequency: {
    method: "PATCH",
    url: (row) =>
      row.trip_id != null
        ? `/edit/frequencies/${encodeURIComponent(row.trip_id)}`
        : null,
    augmentBody: (row, body) => ({ ...body, start_time: row.start_time }),
  },
  // feed_info: singleton — PUT performs an upsert. We must send the full row
  // alongside the patched field, otherwise non-touched columns get nulled.
  feedInfo: {
    method: "PUT",
    url: () => `/edit/feed_info`,
    augmentBody: (row, body) => ({ ...row, ...body }),
  },

  // ── Fares v1 ──────────────────────────────────────────────────────────────
  fare_attribute: {
    method: "PATCH",
    url: (row) =>
      row.fare_id != null
        ? `/edit/fare_attributes/${encodeURIComponent(row.fare_id)}`
        : null,
  },
  fare_rule: {
    method: "PATCH",
    url: (row) =>
      row.rowid != null
        ? `/edit/fare_rules/${encodeURIComponent(row.rowid)}`
        : null,
  },

  // ── Fares v2 referentials ────────────────────────────────────────────────
  area: {
    method: "PATCH",
    url: (row) =>
      row.area_id != null
        ? `/edit/areas/${encodeURIComponent(row.area_id)}`
        : null,
  },
  stop_area: {
    method: "PATCH",
    url: (row) =>
      row.rowid != null
        ? `/edit/stop_areas/${encodeURIComponent(row.rowid)}`
        : null,
  },
  network: {
    method: "PATCH",
    url: (row) =>
      row.network_id != null
        ? `/edit/networks/${encodeURIComponent(row.network_id)}`
        : null,
  },
  route_network: {
    method: "PATCH",
    url: (row) =>
      row.rowid != null
        ? `/edit/route_networks/${encodeURIComponent(row.rowid)}`
        : null,
  },
  fare_media: {
    method: "PATCH",
    url: (row) =>
      row.fare_media_id != null
        ? `/edit/fare_media/${encodeURIComponent(row.fare_media_id)}`
        : null,
  },
  rider_category: {
    method: "PATCH",
    url: (row) =>
      row.rider_category_id != null
        ? `/edit/rider_categories/${encodeURIComponent(row.rider_category_id)}`
        : null,
  },
  timeframe: {
    method: "PATCH",
    url: (row) =>
      row.rowid != null
        ? `/edit/timeframes/${encodeURIComponent(row.rowid)}`
        : null,
  },

  // ── Fares v2 products & rules (rowid PK) ─────────────────────────────────
  fare_product: {
    method: "PATCH",
    url: (row) =>
      row.rowid != null
        ? `/edit/fare_products/${encodeURIComponent(row.rowid)}`
        : null,
  },
  fare_leg_rule: {
    method: "PATCH",
    url: (row) =>
      row.rowid != null
        ? `/edit/fare_leg_rules/${encodeURIComponent(row.rowid)}`
        : null,
  },
  fare_leg_join_rule: {
    method: "PATCH",
    url: (row) =>
      row.rowid != null
        ? `/edit/fare_leg_join_rules/${encodeURIComponent(row.rowid)}`
        : null,
  },
  fare_transfer_rule: {
    method: "PATCH",
    url: (row) =>
      row.rowid != null
        ? `/edit/fare_transfer_rules/${encodeURIComponent(row.rowid)}`
        : null,
  },

  // ── Flex / DRT ───────────────────────────────────────────────────────────
  booking_rule: {
    method: "PATCH",
    url: (row) =>
      row.booking_rule_id != null
        ? `/edit/booking_rules/${encodeURIComponent(row.booking_rule_id)}`
        : null,
  },
  location_geojson: {
    method: "PATCH",
    url: (row) =>
      row.feature_id != null
        ? `/edit/locations_geojson/${encodeURIComponent(row.feature_id)}`
        : null,
  },
  location_group: {
    method: "PATCH",
    url: (row) =>
      row.location_group_id != null
        ? `/edit/location_groups/${encodeURIComponent(row.location_group_id)}`
        : null,
  },
};

// Tables for which we don't have a stable single-field PATCH endpoint and
// therefore fall back to a SQL UPDATE through /edit/sql. The backend logs
// each statement in _edit_log with proper undo/redo, so the user gets an
// identical Ctrl+Z entry. Composite PK columns are preserved as-is.
export const SQL_FALLBACK_TABLES = {
  calendar_dates: { pk: ["service_id", "date"] },
  shapes: { pk: ["shape_id", "shape_pt_sequence"] },
  // Pure junction table — PK is the composition; backend exposes only
  // POST + DELETE, no PATCH. Inline cell edit therefore routes through
  // /edit/sql with an UPDATE on the composite key.
  location_group_stops: { pk: ["location_group_id", "stop_id"] },
};

/* ------------------------------------------------------------------ */
/* Cascade hints (for delete confirmation dialog)                       */
/* Mirrors the FK graph wired in backend schema.js. We only expose the  */
/* IMMEDIATE children to the user — the backend cascades the rest      */
/* transitively via PRAGMA foreign_keys = ON. Display copy is kept     */
/* short to avoid a wall-of-text dialog.                                */
/* ------------------------------------------------------------------ */
export const PARENT_CASCADE_TABLES = {
  agency: ["routes", "attributions"],
  routes: ["trips", "transfers", "attributions", "fare_rules"],
  trips: ["stop_times", "frequencies", "transfers", "attributions"],
  stops: ["stop_times", "transfers", "pathways"],
  calendar: ["calendar_dates", "trips"],
};

/* GTFS-spec singleton-required tables: spec REQUIRES at least one row.  */
/* Backend rejects deletion of the last row — we add a frontend guard so  */
/* the user gets explicit warning copy before sending the request.        */
export const SINGLETON_REQUIRED_TABLES = new Set(["agency", "feed_info"]);

// Tables whose primary key is auto-assigned by the backend at INSERT
// time. The corresponding columns render as a disabled "auto" cell.
export const AUTO_ASSIGNED_PK_COLS = {
  transfers: new Set(["id"]),
  attributions: new Set(["attribution_id"]),
};

// Common GTFS enum signaled inline (route_type, location_type, …) — kept
// terse on purpose. The mapping mirrors EDITABLE_FIELDS' enum labels.
export const ENUM_HINTS = {
  route_type: {
    0: "Tram",
    1: "Subway",
    2: "Rail",
    3: "Bus",
    4: "Ferry",
    5: "Cable tram",
    6: "Aerial lift",
    7: "Funicular",
    11: "Trolleybus",
    12: "Monorail",
  },
  location_type: {
    0: "stop",
    1: "station",
    2: "entrance",
    3: "node",
    4: "boarding",
  },
  wheelchair_boarding: { 0: "no info", 1: "accessible", 2: "not accessible" },
  wheelchair_accessible: { 0: "no info", 1: "accessible", 2: "not accessible" },
  bikes_allowed: { 0: "no info", 1: "allowed", 2: "not allowed" },
  direction_id: { 0: "outbound", 1: "inbound" },
};

// Each entry: { key, type, options?, required?, min?, max?, hint? }.
//
// Field types — drives both the inline editor widget and client-side
// validation BEFORE the PATCH/SQL is sent to the backend:
//   - "text"        plain text input
//   - "number"      numeric input (validates Number.isFinite + min/max)
//   - "enum"        <select> with the supplied options
//   - "time"        HH:MM:SS, supports values > 24:00:00 (GTFS overnight trips)
//   - "date"        YYYYMMDD
//   - "url"         http(s) URL
//   - "email"       basic email shape
//   - "color"       6-digit hex color (no leading #)
//
// `required: true` means the cell rejects an empty string and the GTFS spec
// forbids NULL on this column (we don't send the PATCH at all and surface
// a Snackbar). For Optional fields, an empty input is treated as NULL.
//
// GTFS spec terms (route_type, location_type, pickup_type, …) are NEVER
// translated — surfaced raw in every language for power-user clarity.
export const EDITABLE_FIELDS = {
  stops: [
    { key: "stop_name", type: "text" },
    { key: "stop_code", type: "text" },
    { key: "stop_desc", type: "text" },
    { key: "tts_stop_name", type: "text" },
    { key: "zone_id", type: "text" },
    { key: "platform_code", type: "text" },
    { key: "parent_station", type: "text" },
    { key: "level_id", type: "text" },
    {
      key: "wheelchair_boarding",
      type: "enum",
      options: [
        { value: "0", label: "0 — no info" },
        { value: "1", label: "1 — accessible" },
        { value: "2", label: "2 — not accessible" },
      ],
    },
    {
      key: "location_type",
      type: "enum",
      options: [
        { value: "0", label: "0 — stop/platform" },
        { value: "1", label: "1 — station" },
        { value: "2", label: "2 — entrance/exit" },
        { value: "3", label: "3 — generic node" },
        { value: "4", label: "4 — boarding area" },
      ],
    },
    {
      key: "stop_access",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — accessible" },
        { value: "1", label: "1 — forbidden" },
      ],
    },
    { key: "stop_url", type: "url" },
    { key: "stop_timezone", type: "text" },
    { key: "stop_lat", type: "number", min: -90, max: 90 },
    { key: "stop_lon", type: "number", min: -180, max: 180 },
  ],
  routes: [
    { key: "route_short_name", type: "text" },
    { key: "route_long_name", type: "text" },
    { key: "route_desc", type: "text" },
    {
      key: "route_type",
      type: "enum",
      options: [
        { value: "0", label: "0 — Tram" },
        { value: "1", label: "1 — Subway" },
        { value: "2", label: "2 — Rail" },
        { value: "3", label: "3 — Bus" },
        { value: "4", label: "4 — Ferry" },
        { value: "5", label: "5 — Cable tram" },
        { value: "6", label: "6 — Aerial lift" },
        { value: "7", label: "7 — Funicular" },
        { value: "11", label: "11 — Trolleybus" },
        { value: "12", label: "12 — Monorail" },
      ],
    },
    { key: "route_url", type: "url" },
    { key: "route_color", type: "color" },
    { key: "route_text_color", type: "color" },
    { key: "route_sort_order", type: "number", min: 0 },
    {
      key: "continuous_pickup",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — continuous" },
        { value: "1", label: "1 — none" },
        { value: "2", label: "2 — phone agency" },
        { value: "3", label: "3 — coordinate with driver" },
      ],
    },
    {
      key: "continuous_drop_off",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — continuous" },
        { value: "1", label: "1 — none" },
        { value: "2", label: "2 — phone agency" },
        { value: "3", label: "3 — coordinate with driver" },
      ],
    },
    { key: "network_id", type: "text" },
    {
      key: "cemv_support",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — no" },
        { value: "1", label: "1 — yes" },
        { value: "2", label: "2 — only with companion" },
      ],
    },
  ],
  trips: [
    { key: "route_id", type: "text" },
    { key: "service_id", type: "text" },
    { key: "shape_id", type: "text" },
    { key: "trip_headsign", type: "text" },
    { key: "trip_short_name", type: "text" },
    { key: "block_id", type: "text" },
    {
      key: "direction_id",
      type: "enum",
      options: [
        { value: "0", label: "0" },
        { value: "1", label: "1" },
      ],
    },
    {
      key: "wheelchair_accessible",
      type: "enum",
      options: [
        { value: "0", label: "0 — no info" },
        { value: "1", label: "1 — accessible" },
        { value: "2", label: "2 — not accessible" },
      ],
    },
    {
      key: "bikes_allowed",
      type: "enum",
      options: [
        { value: "0", label: "0 — no info" },
        { value: "1", label: "1 — allowed" },
        { value: "2", label: "2 — not allowed" },
      ],
    },
    {
      key: "cars_allowed",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — no info" },
        { value: "1", label: "1 — allowed" },
        { value: "2", label: "2 — not allowed" },
      ],
    },
  ],
  calendar: [
    {
      key: "monday",
      type: "enum",
      options: [
        { value: "0", label: "0" },
        { value: "1", label: "1" },
      ],
    },
    {
      key: "tuesday",
      type: "enum",
      options: [
        { value: "0", label: "0" },
        { value: "1", label: "1" },
      ],
    },
    {
      key: "wednesday",
      type: "enum",
      options: [
        { value: "0", label: "0" },
        { value: "1", label: "1" },
      ],
    },
    {
      key: "thursday",
      type: "enum",
      options: [
        { value: "0", label: "0" },
        { value: "1", label: "1" },
      ],
    },
    {
      key: "friday",
      type: "enum",
      options: [
        { value: "0", label: "0" },
        { value: "1", label: "1" },
      ],
    },
    {
      key: "saturday",
      type: "enum",
      options: [
        { value: "0", label: "0" },
        { value: "1", label: "1" },
      ],
    },
    {
      key: "sunday",
      type: "enum",
      options: [
        { value: "0", label: "0" },
        { value: "1", label: "1" },
      ],
    },
    { key: "start_date", type: "date" },
    { key: "end_date", type: "date" },
  ],
  agency: [
    { key: "agency_name", type: "text", required: true },
    { key: "agency_url", type: "url", required: true },
    { key: "agency_timezone", type: "text", required: true },
    { key: "agency_lang", type: "text" },
    { key: "agency_phone", type: "text" },
    { key: "agency_fare_url", type: "url" },
    { key: "agency_email", type: "email" },
    {
      key: "cemv_support",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — no" },
        { value: "1", label: "1 — yes" },
        { value: "2", label: "2 — only with companion" },
      ],
    },
  ],
  stop_times: [
    { key: "arrival_time", type: "time" },
    { key: "departure_time", type: "time" },
    { key: "stop_id", type: "text" },
    { key: "stop_headsign", type: "text" },
    {
      key: "pickup_type",
      type: "enum",
      options: [
        { value: "0", label: "0 — regularly scheduled" },
        { value: "1", label: "1 — none" },
        { value: "2", label: "2 — phone agency" },
        { value: "3", label: "3 — coordinate with driver" },
      ],
    },
    {
      key: "drop_off_type",
      type: "enum",
      options: [
        { value: "0", label: "0 — regularly scheduled" },
        { value: "1", label: "1 — none" },
        { value: "2", label: "2 — phone agency" },
        { value: "3", label: "3 — coordinate with driver" },
      ],
    },
    {
      key: "continuous_pickup",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — continuous" },
        { value: "1", label: "1 — none" },
        { value: "2", label: "2 — phone agency" },
        { value: "3", label: "3 — coordinate with driver" },
      ],
    },
    {
      key: "continuous_drop_off",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — continuous" },
        { value: "1", label: "1 — none" },
        { value: "2", label: "2 — phone agency" },
        { value: "3", label: "3 — coordinate with driver" },
      ],
    },
    { key: "shape_dist_traveled", type: "number", min: 0 },
    {
      key: "timepoint",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — approximate" },
        { value: "1", label: "1 — exact" },
      ],
    },
    { key: "start_pickup_drop_off_window", type: "time" },
    { key: "end_pickup_drop_off_window", type: "time" },
    { key: "pickup_booking_rule_id", type: "text" },
    { key: "drop_off_booking_rule_id", type: "text" },
  ],
  calendar_dates: [
    {
      key: "exception_type",
      type: "enum",
      required: true,
      options: [
        { value: "1", label: "1 — service added" },
        { value: "2", label: "2 — service removed" },
      ],
    },
  ],
  frequencies: [
    { key: "end_time", type: "time", required: true },
    { key: "headway_secs", type: "number", required: true, min: 1 },
    {
      key: "exact_times",
      type: "enum",
      options: [
        { value: "0", label: "0 — frequency-based" },
        { value: "1", label: "1 — schedule-based" },
      ],
    },
  ],
  transfers: [
    { key: "from_stop_id", type: "text" },
    { key: "to_stop_id", type: "text" },
    { key: "from_route_id", type: "text" },
    { key: "to_route_id", type: "text" },
    { key: "from_trip_id", type: "text" },
    { key: "to_trip_id", type: "text" },
    {
      key: "transfer_type",
      type: "enum",
      required: true,
      options: [
        { value: "0", label: "0 — recommended" },
        { value: "1", label: "1 — timed" },
        { value: "2", label: "2 — minimum time" },
        { value: "3", label: "3 — not possible" },
        { value: "4", label: "4 — in-seat" },
        { value: "5", label: "5 — re-board" },
      ],
    },
    { key: "min_transfer_time", type: "number", min: 0 },
  ],
  levels: [
    { key: "level_index", type: "number", required: true },
    { key: "level_name", type: "text" },
  ],
  pathways: [
    { key: "from_stop_id", type: "text", required: true },
    { key: "to_stop_id", type: "text", required: true },
    {
      key: "pathway_mode",
      type: "enum",
      required: true,
      options: [
        { value: "1", label: "1 — walkway" },
        { value: "2", label: "2 — stairs" },
        { value: "3", label: "3 — moving sidewalk" },
        { value: "4", label: "4 — escalator" },
        { value: "5", label: "5 — elevator" },
        { value: "6", label: "6 — fare gate" },
        { value: "7", label: "7 — exit gate" },
      ],
    },
    {
      key: "is_bidirectional",
      type: "enum",
      required: true,
      options: [
        { value: "0", label: "0 — unidirectional" },
        { value: "1", label: "1 — bidirectional" },
      ],
    },
    { key: "length", type: "number", min: 0 },
    { key: "traversal_time", type: "number", min: 0 },
    { key: "stair_count", type: "number" },
    { key: "max_slope", type: "number" },
    { key: "min_width", type: "number", min: 0 },
    { key: "signposted_as", type: "text" },
    { key: "reversed_signposted_as", type: "text" },
  ],
  translations: [
    { key: "translation", type: "text", required: true },
    { key: "record_id", type: "text" },
    { key: "record_sub_id", type: "text" },
    { key: "field_value", type: "text" },
  ],
  feed_info: [
    { key: "feed_publisher_name", type: "text", required: true },
    { key: "feed_publisher_url", type: "url", required: true },
    { key: "feed_lang", type: "text", required: true },
    { key: "default_lang", type: "text" },
    { key: "feed_start_date", type: "date" },
    { key: "feed_end_date", type: "date" },
    { key: "feed_version", type: "text" },
    { key: "feed_contact_email", type: "email" },
    { key: "feed_contact_url", type: "url" },
  ],
  attributions: [
    { key: "attribution_id", type: "text" },
    { key: "agency_id", type: "text" },
    { key: "route_id", type: "text" },
    { key: "trip_id", type: "text" },
    { key: "organization_name", type: "text", required: true },
    {
      key: "is_producer",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — no" },
        { value: "1", label: "1 — yes" },
      ],
    },
    {
      key: "is_operator",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — no" },
        { value: "1", label: "1 — yes" },
      ],
    },
    {
      key: "is_authority",
      type: "enum",
      options: [
        { value: "", label: "(unset)" },
        { value: "0", label: "0 — no" },
        { value: "1", label: "1 — yes" },
      ],
    },
    { key: "attribution_url", type: "url" },
    { key: "attribution_email", type: "email" },
    { key: "attribution_phone", type: "text" },
  ],
  shapes: [
    { key: "shape_pt_lat", type: "number", required: true, min: -90, max: 90 },
    {
      key: "shape_pt_lon",
      type: "number",
      required: true,
      min: -180,
      max: 180,
    },
    { key: "shape_dist_traveled", type: "number", min: 0 },
  ],
};
