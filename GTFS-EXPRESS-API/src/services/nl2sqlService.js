/**
 * nl2sqlService — Natural language to SQL query generation
 * via the Anthropic Claude API.
 *
 * Architecture
 * ────────────
 * 1. The frontend (SQL Console) sends a natural-language text + the
 *    target mode (`read` or `edit`) + UI language. The feature is gated by
 *    `betaGate("sql/nl2sql")` at the route level — this module does not re-check.
 * 2. We call Claude with a carefully built system prompt that contains:
 *      - the full SQLite schema of the 30 GTFS tables (exact DDL)
 *      - GTFS-specific constraints (times > 24:00:00, FKs, formats)
 *      - 12 pre-installed analytics queries as few-shot examples
 *      - the SQLite dialect (not PostgreSQL, not MySQL)
 *    The system prompt is marked `cache_control: ephemeral` → cost of
 *    subsequent calls is reduced by ~10×.
 * 3. Claude returns a JSON object `{sql, explanation}`. We parse, validate
 *    the shape, and forward it to the frontend.
 * 4. The generated SQL is NEVER executed automatically — it is inserted
 *    into the editor; the user reviews and runs it manually.
 *
 * Models
 * ───────
 * By default we use `claude-haiku-4-5` (optimal cost/quality ratio
 * for NL2SQL with a dense few-shot context). For more complex queries,
 * switch to `claude-sonnet-4-6` or `claude-opus-4-7` via
 * the `NL2SQL_MODEL` environment variable.
 *
 * Modes
 * ─────
 * - `read`   → SELECT / WITH / EXPLAIN only (consistent with
 *              POST /gtfs/sql, which rejects mutations).
 * - `edit`   → allows UPDATE / INSERT / DELETE (mutations go through
 *              via POST /gtfs/edit/sql which requires edit mode).
 *
 * The mode is injected into the user prompt — Claude decides which
 * SQL verb to produce accordingly.
 */

const { Anthropic } = require("@anthropic-ai/sdk");
const config = require("../config");

// ─── Singleton client (lazy init) ─────────────────────────────────────────
// Lazy init to avoid crashing at boot when the API key is not configured
// — only fail at call time.
let _client = null;
const getClient = () => {
  // Hard no-billing safety net: the test suite must NEVER reach the real
  // Anthropic client (mock this service instead). Any test that forgets
  // fails loudly here rather than making an outbound API call. Opt-out is
  // explicit and deliberate (eval-style integration runs only).
  if (
    process.env.JEST_WORKER_ID !== undefined &&
    process.env.ALLOW_ANTHROPIC_IN_TESTS !== "true"
  ) {
    throw Object.assign(
      new Error(
        "Anthropic client blocked under Jest — mock the AI service in this test " +
          "(set ALLOW_ANTHROPIC_IN_TESTS=true only for deliberate token-spending runs).",
      ),
      { code: "ANTHROPIC_BLOCKED_IN_TESTS", status: 503 },
    );
  }
  if (_client) return _client;
  if (!config.ANTHROPIC_API_KEY) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured — set it in .env to enable NL2SQL.",
    );
  }
  _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return _client;
};

// ─── DDL of the 30 GTFS tables (extracted from services/db/schema.js) ─────
// We duplicate the DDL here rather than re-importing `schema.js` because:
//   1. schema.js's DDL contains PRAGMAs and indexes that don't help
//      Claude understand the schema and pollute cached tokens.
//   2. We want to freeze the string sent to Claude to maximise cache hits
//      (any change to schema.js would invalidate the cache).
//   3. We can add inline comments explaining GTFS conventions
//      without bloating the production code.
const GTFS_SCHEMA_DDL = `
-- AGENCY (agency.txt) — transport operator
CREATE TABLE agency (
  agency_id       TEXT PRIMARY KEY,   -- unique id (may be absent for single-agency feeds)
  agency_name     TEXT NOT NULL,
  agency_url      TEXT,
  agency_timezone TEXT,                -- IANA tz (e.g. "Europe/Paris")
  agency_lang     TEXT,                -- BCP-47 language code
  agency_phone    TEXT,
  agency_fare_url TEXT,
  agency_email    TEXT,
  cemv_support    TEXT                 -- CEMV support (GTFS-FR extension)
);

-- ROUTES (routes.txt) — transport lines
CREATE TABLE routes (
  route_id          TEXT PRIMARY KEY,
  agency_id         TEXT REFERENCES agency(agency_id),
  route_short_name  TEXT,              -- e.g. "1", "RER A"
  route_long_name   TEXT,              -- e.g. "Chatelet to La Defense"
  route_desc        TEXT,
  route_type        TEXT,              -- 0=Tram, 1=Metro, 2=Rail, 3=Bus, 4=Ferry, 5=CableTram,
                                       -- 6=AerialLift, 7=Funicular, 11=Trolleybus, 12=Monorail
  route_url         TEXT,
  route_color       TEXT,              -- hex colour without # (e.g. "FF0000")
  route_text_color  TEXT,
  route_sort_order  TEXT,
  continuous_pickup TEXT,
  continuous_drop_off TEXT,
  network_id        TEXT,
  cemv_support      TEXT
);

-- STOPS (stops.txt) — stops, stations, platforms, entrances
CREATE TABLE stops (
  stop_id             TEXT PRIMARY KEY,
  stop_code           TEXT,            -- short passenger-visible code
  stop_name           TEXT,
  stop_desc           TEXT,
  stop_lat            REAL,
  stop_lon            REAL,
  zone_id             TEXT,
  stop_url            TEXT,
  location_type       TEXT,            -- 0=Stop, 1=Station, 2=Entrance/Exit, 3=GenericNode, 4=BoardingArea
  parent_station      TEXT REFERENCES stops(stop_id),  -- recursive self-FK
  stop_timezone       TEXT,
  wheelchair_boarding TEXT,            -- 0=NoInfo, 1=Accessible, 2=NotAccessible
  platform_code       TEXT,
  level_id            TEXT REFERENCES levels(level_id),
  tts_stop_name       TEXT,            -- TTS pronunciation
  stop_access         TEXT             -- extension: access type
);

-- CALENDAR (calendar.txt) — weekly pattern of a service
CREATE TABLE calendar (
  service_id TEXT PRIMARY KEY,
  monday     INTEGER,                  -- 0 or 1
  tuesday    INTEGER,
  wednesday  INTEGER,
  thursday   INTEGER,
  friday     INTEGER,
  saturday   INTEGER,
  sunday     INTEGER,
  start_date TEXT,                     -- YYYYMMDD format (e.g. "20260101")
  end_date   TEXT
);

-- CALENDAR_DATES (calendar_dates.txt) — calendar exceptions
CREATE TABLE calendar_dates (
  service_id     TEXT NOT NULL,
  date           TEXT NOT NULL,        -- YYYYMMDD
  exception_type INTEGER NOT NULL,     -- 1=service added on this day 2=service removed
  PRIMARY KEY (service_id, date)
);

-- TRIPS (trips.txt) — trips (instances of a route on a given schedule)
CREATE TABLE trips (
  trip_id               TEXT PRIMARY KEY,
  route_id              TEXT REFERENCES routes(route_id),
  service_id            TEXT,           -- → calendar.service_id or calendar_dates.service_id
  trip_headsign         TEXT,           -- displayed destination
  trip_short_name       TEXT,
  direction_id          TEXT,           -- "0" or "1" (outbound/inbound)
  block_id              TEXT,
  shape_id              TEXT,           -- → shapes.shape_id (no explicit FK)
  wheelchair_accessible TEXT,
  bikes_allowed         TEXT,
  cars_allowed          TEXT
);

-- STOP_TIMES (stop_times.txt) — a trip's stop visits
CREATE TABLE stop_times (
  trip_id                      TEXT NOT NULL REFERENCES trips(trip_id),
  arrival_time                 TEXT,    -- HH:MM:SS format, may exceed 24:00:00 (e.g. "25:30:00")
  departure_time               TEXT,    -- same format as arrival_time
  stop_id                      TEXT REFERENCES stops(stop_id),
  -- GTFS-Flex (since schema v12): stop_id alternatives for demand-responsive
  -- trips operating on a zone (locations.geojson) or a named stop group.
  -- At most one of the three (stop_id, location_id, location_group_id)
  -- is populated per row.
  location_id                  TEXT,
  location_group_id            TEXT,
  stop_sequence                INTEGER NOT NULL,  -- stop order within the trip
  stop_headsign                TEXT,
  pickup_type                  TEXT,    -- 0=Regular 1=NoPickup 2=PhoneAgency 3=CoordinateDriver
  drop_off_type                TEXT,    -- same values as pickup_type
  continuous_pickup            TEXT,
  continuous_drop_off          TEXT,
  shape_dist_traveled          TEXT,
  timepoint                    TEXT,    -- 0=Approximate, 1=Exact
  -- GTFS-Flex: pickup/drop-off time window — used INSTEAD OF
  -- arrival_time/departure_time for demand-responsive trips.
  start_pickup_drop_off_window TEXT,
  end_pickup_drop_off_window   TEXT,
  PRIMARY KEY (trip_id, stop_sequence)
);

-- SHAPES (shapes.txt) — geographic traces of trips
CREATE TABLE shapes (
  shape_id            TEXT NOT NULL,
  shape_pt_lat        REAL,
  shape_pt_lon        REAL,
  shape_pt_sequence   INTEGER NOT NULL,
  shape_dist_traveled REAL,
  PRIMARY KEY (shape_id, shape_pt_sequence)
);

-- FEED_INFO (feed_info.txt) — feed metadata (singleton, ≤1 row)
CREATE TABLE feed_info (
  feed_publisher_name TEXT,
  feed_publisher_url  TEXT,
  feed_lang           TEXT,
  default_lang        TEXT,
  feed_start_date     TEXT,
  feed_end_date       TEXT,
  feed_version        TEXT,
  feed_contact_email  TEXT,
  feed_contact_url    TEXT
);

-- FREQUENCIES (frequencies.txt) — high-frequency headway-based services
CREATE TABLE frequencies (
  trip_id      TEXT NOT NULL REFERENCES trips(trip_id),
  start_time   TEXT NOT NULL,            -- HH:MM:SS, may exceed 24:00:00
  end_time     TEXT,
  headway_secs INTEGER,                   -- intervalle entre passages, en secondes
  exact_times  INTEGER,                   -- 0=approximate, 1=exact
  PRIMARY KEY (trip_id, start_time)
);

-- LEVELS (levels.txt) — station floor levels (accessibility)
CREATE TABLE levels (
  level_id    TEXT PRIMARY KEY,
  level_index REAL,                       -- 0=street +1=floor_above -1=underground
  level_name  TEXT
);

-- PATHWAYS (pathways.txt) — indoor navigation graph
CREATE TABLE pathways (
  pathway_id              TEXT PRIMARY KEY,
  from_stop_id            TEXT NOT NULL REFERENCES stops(stop_id),
  to_stop_id              TEXT NOT NULL REFERENCES stops(stop_id),
  pathway_mode            INTEGER NOT NULL,  -- 1=Walkway, 2=Stairs, 3=MovingSidewalk,
                                             -- 4=Escalator, 5=Elevator, 6=FareGate, 7=ExitGate
  is_bidirectional        INTEGER NOT NULL,  -- 0=unidirectional, 1=bidirectional
  length                  REAL,
  traversal_time          INTEGER,           -- secondes
  stair_count             INTEGER,
  max_slope               REAL,
  min_width               REAL,
  signposted_as           TEXT,
  reversed_signposted_as  TEXT
);

-- TRANSFERS (transfers.txt) — correspondence between stops/routes/trips
CREATE TABLE transfers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  from_stop_id      TEXT REFERENCES stops(stop_id),
  to_stop_id        TEXT REFERENCES stops(stop_id),
  from_route_id     TEXT REFERENCES routes(route_id),
  to_route_id       TEXT REFERENCES routes(route_id),
  from_trip_id      TEXT REFERENCES trips(trip_id),
  to_trip_id        TEXT REFERENCES trips(trip_id),
  transfer_type     INTEGER,               -- 0=Recommended, 1=Timed, 2=MinTime, 3=NotPossible,
                                           -- 4=InSeat, 5=ReBoard
  min_transfer_time INTEGER                -- seconds (when transfer_type=2)
);

-- TRANSLATIONS (translations.txt) — multilingual translations
CREATE TABLE translations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name      TEXT NOT NULL,           -- "stops" | "routes" | "trips" | ...
  field_name      TEXT NOT NULL,           -- name of the translated field (e.g. "stop_name")
  language        TEXT NOT NULL,           -- BCP-47 language code (e.g. "fr", "en-US")
  translation     TEXT NOT NULL,
  record_id       TEXT,                    -- PK of the targeted row
  record_sub_id   TEXT,                    -- sub-key (e.g. stop_sequence for stop_times)
  field_value     TEXT                     -- source value (text matching)
);

-- ATTRIBUTIONS (attributions.txt) — organisation credits
CREATE TABLE attributions (
  rowid              INTEGER PRIMARY KEY AUTOINCREMENT,
  attribution_id     TEXT,
  agency_id          TEXT REFERENCES agency(agency_id),
  route_id           TEXT REFERENCES routes(route_id),
  trip_id            TEXT REFERENCES trips(trip_id),
  organization_name  TEXT NOT NULL,
  is_producer        TEXT,                 -- "0" or "1"
  is_operator        TEXT,
  is_authority       TEXT,
  attribution_url    TEXT,
  attribution_email  TEXT,
  attribution_phone  TEXT
);

-- ─── Fares v1 (legacy — managed since schema v11) ────────────────────────────
-- FARE_ATTRIBUTES (fare_attributes.txt) — legacy GTFS v1 flat-fare entries
CREATE TABLE fare_attributes (
  fare_id            TEXT PRIMARY KEY,
  price              TEXT NOT NULL,         -- text format (e.g. "1.50")
  currency_type      TEXT NOT NULL,         -- ISO 4217 alpha-3 (USD, EUR, JPY, …)
  payment_method     TEXT NOT NULL,         -- "0"=onboard, "1"=before-board
  transfers          TEXT,                  -- "0"=none, "1"=once, "2"=twice, ""=unlimited
  agency_id          TEXT REFERENCES agency(agency_id),
  transfer_duration  TEXT                   -- seconds (string)
);

-- FARE_RULES (fare_rules.txt) — fare v1 application rules
CREATE TABLE fare_rules (
  rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
  fare_id        TEXT NOT NULL REFERENCES fare_attributes(fare_id),
  route_id       TEXT REFERENCES routes(route_id),
  origin_id      TEXT,                      -- value from stops.zone_id
  destination_id TEXT,
  contains_id    TEXT
);

-- ─── Fares v2 cluster (managed since schema v11) ─────────────────────────────
-- AREAS (areas.txt) — fare zones
CREATE TABLE areas (
  area_id   TEXT PRIMARY KEY,
  area_name TEXT
);

-- STOP_AREAS (stop_areas.txt) — stop membership in a fare zone
CREATE TABLE stop_areas (
  rowid   INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id TEXT NOT NULL REFERENCES areas(area_id),
  stop_id TEXT NOT NULL REFERENCES stops(stop_id),
  UNIQUE (area_id, stop_id)
);

-- NETWORKS (networks.txt) — logical grouping of routes
CREATE TABLE networks (
  network_id   TEXT PRIMARY KEY,
  network_name TEXT
);

-- ROUTE_NETWORKS (route_networks.txt) — route → network assignment
CREATE TABLE route_networks (
  rowid      INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id TEXT NOT NULL REFERENCES networks(network_id),
  route_id   TEXT NOT NULL UNIQUE REFERENCES routes(route_id)  -- at most one network per route
);

-- FARE_MEDIA (fare_media.txt) — fare payment media
CREATE TABLE fare_media (
  fare_media_id   TEXT PRIMARY KEY,
  fare_media_name TEXT,
  fare_media_type TEXT NOT NULL              -- "0"=cash, "1"=paper, "2"=transit_card,
                                             -- "3"=cEMV, "4"=mobile_app
);

-- RIDER_CATEGORIES (rider_categories.txt) — passenger categories (adult, child, …)
CREATE TABLE rider_categories (
  rider_category_id        TEXT PRIMARY KEY,
  rider_category_name      TEXT NOT NULL,
  is_default_fare_category TEXT,             -- "0" | "1" | ""
  eligibility_url          TEXT
);

-- FARE_PRODUCTS (fare_products.txt) — fare products (composite key)
CREATE TABLE fare_products (
  rowid             INTEGER PRIMARY KEY AUTOINCREMENT,
  fare_product_id   TEXT NOT NULL,
  fare_product_name TEXT,
  rider_category_id TEXT REFERENCES rider_categories(rider_category_id),
  fare_media_id     TEXT REFERENCES fare_media(fare_media_id),
  amount            TEXT NOT NULL,           -- decimal (precision depends on currency)
  currency          TEXT NOT NULL,           -- ISO 4217
  UNIQUE (fare_product_id, rider_category_id, fare_media_id)
);

-- TIMEFRAMES (timeframes.txt) — Fares v2 time windows
CREATE TABLE timeframes (
  rowid              INTEGER PRIMARY KEY AUTOINCREMENT,
  timeframe_group_id TEXT NOT NULL,          -- logical grouping
  start_time         TEXT,                   -- HH:MM:SS (empty = 00:00:00)
  end_time           TEXT,                   -- HH:MM:SS (empty = 24:00:00)
  service_id         TEXT NOT NULL           -- FK calendar / calendar_dates
);

-- FARE_LEG_RULES (fare_leg_rules.txt) — per-leg fare rules
CREATE TABLE fare_leg_rules (
  rowid                   INTEGER PRIMARY KEY AUTOINCREMENT,
  leg_group_id            TEXT,
  network_id              TEXT REFERENCES networks(network_id),
  from_area_id            TEXT REFERENCES areas(area_id),
  to_area_id              TEXT REFERENCES areas(area_id),
  from_timeframe_group_id TEXT,              -- logical FK to timeframes.timeframe_group_id
  to_timeframe_group_id   TEXT,
  fare_product_id         TEXT NOT NULL,
  rule_priority           TEXT
);

-- FARE_LEG_JOIN_RULES (fare_leg_join_rules.txt) — joins between networks
CREATE TABLE fare_leg_join_rules (
  rowid           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_network_id TEXT NOT NULL REFERENCES networks(network_id),
  to_network_id   TEXT NOT NULL REFERENCES networks(network_id),
  from_stop_id    TEXT REFERENCES stops(stop_id),
  to_stop_id      TEXT REFERENCES stops(stop_id)
);

-- FARE_TRANSFER_RULES (fare_transfer_rules.txt) — fare transfer rules
CREATE TABLE fare_transfer_rules (
  rowid               INTEGER PRIMARY KEY AUTOINCREMENT,
  from_leg_group_id   TEXT,
  to_leg_group_id     TEXT,
  transfer_count      TEXT,                  -- positive integer or "-1" (unlimited)
  duration_limit      TEXT,                  -- seconds
  duration_limit_type TEXT,                  -- "0"|"1"|"2"|"3"|""
  fare_transfer_type  TEXT NOT NULL,         -- "0"|"1"|"2"
  fare_product_id     TEXT
);

-- ─── DRT / GTFS-Flex (managed since schema v11) ──────────────────────────────
-- BOOKING_RULES (booking_rules.txt) — demand-responsive booking rules
CREATE TABLE booking_rules (
  booking_rule_id            TEXT PRIMARY KEY,
  booking_type               TEXT NOT NULL,  -- "0"=realtime "1"=same-day-notice "2"=prior-day-notice
  prior_notice_duration_min  TEXT,           -- required when booking_type=1
  prior_notice_duration_max  TEXT,
  prior_notice_last_day      TEXT,           -- required when booking_type=2
  prior_notice_last_time     TEXT,
  prior_notice_start_day     TEXT,
  prior_notice_start_time    TEXT,
  prior_notice_service_id    TEXT,
  message                    TEXT,
  pickup_message             TEXT,
  drop_off_message           TEXT,
  phone_number               TEXT,
  info_url                   TEXT,
  booking_url                TEXT
);

-- LOCATIONS_GEOJSON (locations.geojson decomposed) — GTFS-Flex zones
-- Note: not a .txt CSV originally; each feature of the
-- FeatureCollection becomes a row. \`coordinates\` and \`extra_properties\`
-- are JSON blobs (queryable via SQLite JSON1 — e.g. json_extract).
CREATE TABLE locations_geojson (
  feature_id       TEXT PRIMARY KEY,
  geometry_type    TEXT NOT NULL,            -- "Polygon" | "MultiPolygon"
  coordinates      TEXT NOT NULL,            -- JSON
  stop_name        TEXT,
  stop_desc        TEXT,
  extra_properties TEXT                      -- JSON blob for non-spec properties
);

-- LOCATION_GROUPS (location_groups.txt) — named stop groups for DRT booking
-- Promoted to a managed table at schema v13 with FK enforcement to stops via
-- location_group_stops. stop_times.location_group_id (added in v12)
-- references this table.
CREATE TABLE location_groups (
  location_group_id   TEXT PRIMARY KEY,
  location_group_name TEXT
);

-- LOCATION_GROUP_STOPS (location_group_stops.txt) — many-to-many junction
-- between location_groups and stops. PK is the composite (location_group_id,
-- stop_id); both columns are required and FK CASCADE on update/delete.
CREATE TABLE location_group_stops (
  location_group_id TEXT NOT NULL,           -- FK location_groups(location_group_id)
  stop_id           TEXT NOT NULL,           -- FK stops(stop_id)
  PRIMARY KEY (location_group_id, stop_id)
);
`.trim();

// ─── GTFS-specific constraints ─────────────────────────────────────────
const GTFS_CONSTRAINTS = `
GTFS-specific constraints to ALWAYS respect:

1. **Times can exceed 24:00:00.** GTFS allows times like "25:30:00" or
   "27:15:00" for trips that span midnight while still belonging to the
   *previous* service day. NEVER truncate or modulo times. To extract the
   hour bucket, use SUBSTR(departure_time, 1, 2) — a service starting at
   "25:00:00" is still meaningful.

2. **Dates are stored as TEXT in YYYYMMDD format** (no separators).
   Use SQLite's strftime: \`strftime('%Y%m%d', 'now')\` for "today".

3. **Foreign keys CASCADE on UPDATE** for IDs (renaming a stop_id propagates
   to stop_times, parent_station, transfers, pathways, attributions).
   ON DELETE behavior varies — see the DDL above.

4. **calendar.monday..sunday are INTEGER 0/1**, not booleans. Sum them to
   compute days_per_week.

5. **calendar_dates.exception_type**: 1 = service ADDED that day,
   2 = service REMOVED that day.

6. **Effective service on a date** = (calendar pattern matches AND no
   exception_type=2) OR (calendar_dates exception_type=1).

7. **route_type values** (the 7 standard ones used in 99% of feeds):
   0=Tram, 1=Metro/Subway, 2=Rail, 3=Bus, 4=Ferry, 5=CableTram, 7=Funicular.
   Extended values: 11=Trolleybus, 12=Monorail. Treat unknown values as
   strings — never assume a specific integer set.

8. **Stop hierarchy**: stops.location_type=1 are "stations" (parents);
   location_type=0 (or NULL) are physical stops. parent_station references
   the station's stop_id. Always check location_type when filtering "real"
   passenger stops vs entrances/nodes.

9. **stop_times sorting**: always ORDER BY trip_id, stop_sequence — the PK
   guarantees uniqueness but rows are not physically ordered.

10. **Identifiers are TEXT, not INTEGER** — even when they look numeric.
    \`route_id = '42'\` not \`route_id = 42\`. Comparison with integer literals
    silently fails in SQLite (returns 0 rows without error).

11. **Empty optional fields are NULL or empty string** — use
    \`COALESCE(field, '')\` or \`field IS NOT NULL AND field != ''\` when
    filtering.

12. **Tables outside the schema above are off-limits.** Internal tables
    \`_edit_log\`, \`_edit_meta\`, \`_project_meta\` are off-limits — they
    are not GTFS data.

13. **Fares v2 semantics**:
    - \`fare_products\` is a composite key (fare_product_id, rider_category_id,
      fare_media_id). The same fare_product_id can appear multiple times,
      once per (rider, media) tuple. Aggregate by fare_product_id only when
      the question is product-level (e.g. "list distinct products"); join
      otherwise.
    - \`amount\` is TEXT — cast with CAST(amount AS REAL) for arithmetic.
    - \`currency\` is ISO 4217 alpha-3. Don't assume EUR / USD without
      checking — feeds from Asia commonly use JPY (0 decimals) or KRW.
    - \`fare_transfer_rules.transfer_count\` of "-1" means unlimited.

14. **Booking rules conditional fields**: with booking_type=0 (real-time),
    the prior_notice_* fields MUST be empty. With booking_type=1, only
    duration-based fields are valid. With booking_type=2, only day-based
    fields. Use these constraints when interpreting user questions about
    advance-booking requirements.

15. **locations_geojson** holds GTFS-Flex demand-responsive service zones.
    \`coordinates\` is a JSON blob — extract with json_extract(coordinates, '$[0][0][0]')
    for the first lon, etc. The geometry_type is always 'Polygon' or
    'MultiPolygon'.
`.trim();

// ─── Few-shot examples (12 analytics queries) ──────────────────────────
// Picked from the ~25 PRESET_QUERIES in the frontend to cover the
// typical patterns: aggregation, multi-table JOINs, time filters,
// CASE WHEN, subqueries, UNION, calendar+calendar_dates, etc.
// Ordered from simplest to most complex — Claude learns better that way.
const FEW_SHOT_EXAMPLES = [
  {
    request: "List all fare products with their currency and minimum amount",
    sql: `SELECT fare_product_id,
       MIN(CAST(amount AS REAL)) AS min_amount,
       currency
FROM fare_products
GROUP BY fare_product_id, currency
ORDER BY fare_product_id;`,
  },
  {
    request:
      "Find booking_rules that require more than 1 hour of advance notice",
    sql: `SELECT booking_rule_id, booking_type, prior_notice_duration_min,
       prior_notice_duration_max
FROM booking_rules
WHERE booking_type = '1'
  AND CAST(prior_notice_duration_min AS INTEGER) > 3600;`,
  },
  {
    request:
      "List all stops belonging to the 'CITY_CENTRE' fare area",
    sql: `SELECT s.stop_id, s.stop_name
FROM stop_areas sa
JOIN stops s ON s.stop_id = sa.stop_id
WHERE sa.area_id = 'CITY_CENTRE'
ORDER BY s.stop_name;`,
  },
  {
    request: "List all routes with their trip count, sorted by busiest first",
    sql: `SELECT r.route_id, r.route_short_name, r.route_long_name,
       COUNT(t.trip_id) AS trip_count
FROM routes r
LEFT JOIN trips t ON t.route_id = r.route_id
GROUP BY r.route_id
ORDER BY trip_count DESC
LIMIT 50;`,
  },
  {
    request: "Show how many routes each agency operates",
    sql: `SELECT a.agency_id, a.agency_name,
       COUNT(r.route_id) AS route_count
FROM agency a
LEFT JOIN routes r ON r.agency_id = a.agency_id
GROUP BY a.agency_id
ORDER BY route_count DESC;`,
  },
  {
    request: "Find the 25 busiest stops (by number of stop_times passages)",
    sql: `SELECT s.stop_id, s.stop_name,
       COUNT(st.trip_id) AS passages
FROM stops s
JOIN stop_times st ON st.stop_id = s.stop_id
GROUP BY s.stop_id
ORDER BY passages DESC
LIMIT 25;`,
  },
  {
    request: "What is the service span (first departure / last arrival) for each route?",
    sql: `SELECT r.route_id, r.route_short_name,
       MIN(st.departure_time) AS first_departure,
       MAX(st.arrival_time)   AS last_arrival
FROM routes r
JOIN trips t       ON t.route_id  = r.route_id
JOIN stop_times st ON st.trip_id  = t.trip_id
GROUP BY r.route_id
ORDER BY first_departure;`,
  },
  {
    request: "Distribution of trips by departure hour (peak hours)",
    sql: `SELECT SUBSTR(first_dep.dep, 1, 2) AS hour,
       COUNT(*) AS trips
FROM (
  SELECT t.trip_id,
         (SELECT departure_time FROM stop_times
          WHERE trip_id = t.trip_id ORDER BY stop_sequence LIMIT 1) AS dep
  FROM trips t
) first_dep
WHERE first_dep.dep IS NOT NULL
GROUP BY hour
ORDER BY hour;`,
  },
  {
    request: "Show calendar exceptions with human-readable type labels",
    sql: `SELECT service_id, date, exception_type,
       CASE exception_type
         WHEN 1 THEN 'Added'
         WHEN 2 THEN 'Removed'
         ELSE '?'
       END AS type_label
FROM calendar_dates
ORDER BY date, service_id;`,
  },
  {
    request: "Count routes by route_type with human-readable labels",
    sql: `SELECT route_type,
       CASE route_type
         WHEN '0'  THEN 'Tram / Streetcar'
         WHEN '1'  THEN 'Subway / Metro'
         WHEN '2'  THEN 'Rail'
         WHEN '3'  THEN 'Bus'
         WHEN '4'  THEN 'Ferry'
         WHEN '5'  THEN 'Cable tram'
         WHEN '7'  THEN 'Funicular'
         WHEN '11' THEN 'Trolleybus'
         WHEN '12' THEN 'Monorail'
         ELSE 'Other (' || route_type || ')'
       END AS type_label,
       COUNT(*) AS route_count
FROM routes
GROUP BY route_type
ORDER BY route_count DESC;`,
  },
  {
    request: "Number of active services per weekday across the calendar",
    sql: `SELECT 'Monday'    AS weekday, SUM(monday)    AS active_services FROM calendar
UNION ALL
SELECT 'Tuesday',               SUM(tuesday)   FROM calendar
UNION ALL
SELECT 'Wednesday',             SUM(wednesday) FROM calendar
UNION ALL
SELECT 'Thursday',              SUM(thursday)  FROM calendar
UNION ALL
SELECT 'Friday',                SUM(friday)    FROM calendar
UNION ALL
SELECT 'Saturday',              SUM(saturday)  FROM calendar
UNION ALL
SELECT 'Sunday',                SUM(sunday)    FROM calendar;`,
  },
  {
    request: "Find services running today (calendar pattern + start/end dates)",
    sql: `SELECT service_id, start_date, end_date,
       monday, tuesday, wednesday, thursday, friday, saturday, sunday
FROM calendar
WHERE start_date <= strftime('%Y%m%d', 'now')
  AND end_date   >= strftime('%Y%m%d', 'now')
ORDER BY service_id;`,
  },
  {
    request: "Top 50 stop_times entries with longest dwell time (departure - arrival)",
    sql: `SELECT trip_id, stop_id, stop_sequence,
       arrival_time, departure_time,
       (CAST(SUBSTR(departure_time, 1, 2) AS INTEGER) * 3600
        + CAST(SUBSTR(departure_time, 4, 2) AS INTEGER) * 60
        + CAST(SUBSTR(departure_time, 7, 2) AS INTEGER))
     - (CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600
        + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60
        + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) AS dwell_seconds
FROM stop_times
WHERE arrival_time IS NOT NULL AND departure_time IS NOT NULL
  AND departure_time > arrival_time
ORDER BY dwell_seconds DESC
LIMIT 50;`,
  },
  {
    request: "Trips that start before 5 AM (early morning service)",
    sql: `SELECT t.trip_id, t.route_id, t.trip_headsign,
       MIN(st.departure_time) AS first_dep
FROM trips t
JOIN stop_times st ON st.trip_id = t.trip_id
GROUP BY t.trip_id
HAVING first_dep < '05:00:00'
ORDER BY first_dep, t.trip_id;`,
  },
  {
    request: "Frequency-based services with their headways in minutes",
    sql: `SELECT f.trip_id, t.route_id, t.trip_headsign,
       f.start_time, f.end_time,
       f.headway_secs / 60 AS headway_min,
       CASE f.exact_times
         WHEN 1 THEN 'Exact'
         ELSE 'Frequency-based'
       END AS timing_type
FROM frequencies f
JOIN trips t ON t.trip_id = f.trip_id
ORDER BY headway_min, f.trip_id;`,
  },
];

// ─── System prompt builder ────────────────────────────────────────────────
const buildSystemPrompt = () => {
  const fewShot = FEW_SHOT_EXAMPLES.map(
    (ex, i) => `### Example ${i + 1}
Request: ${ex.request}
SQL:
\`\`\`sql
${ex.sql}
\`\`\``,
  ).join("\n\n");

  return `You are a SQL expert specialised in the GTFS Schedule specification (https://gtfs.org/documentation/schedule/reference/) and the SQLite 3 dialect.

Your single task: translate a transit-operator's natural-language request into ONE valid SQLite query against the GTFS database described below.

# SQLite dialect (NOT PostgreSQL, NOT MySQL)

You produce SQL for **SQLite 3** exclusively. Use only constructs supported by SQLite:
- Date/time: \`strftime()\`, \`date()\`, \`time()\`, \`datetime()\` — never \`TO_CHAR\`, \`DATE_FORMAT\`, \`EXTRACT\`.
- String: \`SUBSTR()\`, \`||\` for concatenation — never \`SUBSTRING\`, \`CONCAT()\`.
- Cast: \`CAST(x AS INTEGER)\` / \`CAST(x AS REAL)\` — never \`::integer\`.
- LIMIT clause comes last (no \`TOP n\`, no \`ROWNUM\`).
- No window-function fallback — SQLite supports OVER() but be conservative.
- Identifiers are double-quoted ("foo"), strings are single-quoted ('bar').
- Boolean literals: \`1\` / \`0\` (not \`TRUE\` / \`FALSE\`).
- No \`RETURNING\` on UPDATE/DELETE before SQLite 3.35 — assume it works (modern SQLite).
- No stored procedures, no \`WITH RECURSIVE\` unless strictly necessary.

# GTFS database schema (SQLite — 30 tables, including Fares v1, Fares v2, GTFS-Flex and DRT booking rules)

\`\`\`sql
${GTFS_SCHEMA_DDL}
\`\`\`

# ${GTFS_CONSTRAINTS}

# Few-shot examples

The user has these analytical queries pre-installed in their console. Use them as a reference for style, formatting, and idiomatic patterns:

${fewShot}

# Output format

You ALWAYS respond with a single JSON object with EXACTLY these two keys:
- \`"sql"\`: a string containing the SQL query (single statement, ends with \`;\`). Format with newlines and 2-space indentation for readability.
- \`"explanation"\`: a short (1-3 sentences) explanation of what the query does, in the language requested by the user. Use neutral technical wording — no salesy tone.

NO markdown fences around the JSON. NO prose before or after. ONLY the JSON object.

# Hard rules

- Produce ONE SQL statement only. If the user asks for multiple, pick the most likely one and explain you've narrowed scope.
- For \`mode: read\`: ONLY produce SELECT / WITH ... SELECT / EXPLAIN. Never UPDATE / INSERT / DELETE / DROP / ALTER / CREATE / PRAGMA write. If the user asks for a mutation in read mode, explain in the explanation field that they must enable Edit Mode and produce a SELECT preview instead.
- For \`mode: edit\`: UPDATE / INSERT / DELETE allowed, but ALWAYS include a precise WHERE clause. NEVER produce \`UPDATE table SET col = ...\` without WHERE — that would silently update the entire table. If the request is ambiguous, produce a SELECT preview instead and explain why.
- NEVER reference tables outside the 15 listed above. NEVER reference \`_edit_log\`, \`_edit_meta\`, \`_project_meta\`, \`fare_attributes\`, \`fare_rules\` — they don't exist or are off-limits.
- NEVER invent column names. If the user asks for a column you don't see in the schema, explain that the field doesn't exist and suggest the closest match.
- Default a \`LIMIT\` clause on potentially large result sets (no LIMIT on aggregations that return ≤100 rows).`;
};

// Memoize the system prompt — it's immutable across requests, so we build
// it once at module load. ~3-5K tokens — well above the 4K minimum cacheable
// prefix on Haiku 4.5 / Sonnet 4.6.
const SYSTEM_PROMPT = buildSystemPrompt();

// ─── Chat system prompt (multi-turn conversational mode) ──────────────────
// Reuses the entire base prompt (schema + constraints + few-shot) and
// appends a chat-specific suffix. Kept byte-stable across requests so the
// Anthropic prompt cache key remains a hit on the second call onwards.
const CHAT_SUFFIX = `

# Conversation mode (multi-turn assistant)

You are a multi-turn data assistant for a transit operator. The conversation
history above is the source of truth for entities the user has already
referenced — do NOT re-introduce them unless asked.

## Output contract for THIS turn — STRICT

Phase 1 (current turn) — your job is to produce ONE SQL query the server
will execute on the user's behalf. Your response MUST contain BOTH blocks
below, in this EXACT order, every time:

  <preamble>One short sentence acknowledging the request, in the user's language.</preamble>
  <sql>
  SELECT ...;
  </sql>

CRITICAL — ABSOLUTE RULES:
  1. The <sql> block is MANDATORY. The server has NO other way to act on
     the user's request. If you emit ONLY the <preamble> and STOP, the user
     gets a useless half-response and the feature appears broken.
  2. NEVER end your turn after </preamble>. The very next characters MUST
     be "<sql>" (a literal newline is OK, prose is NOT).
  3. NEVER use markdown fences (no triple-backtick sql blocks) — only the
     <sql>...</sql> tags.
  4. NEVER emit prose between </preamble> and <sql>. No "Here is the query:",
     no "The query is:", no blank explanations.

The server will:
  - Parse the <sql> block (extract content between <sql> and </sql>)
  - Reject if not a SELECT/WITH/EXPLAIN (read-only mode)
  - Execute it, fetch the result, then call you again in Phase 2

In Phase 2, the user message will contain the JSON result. You will then
write a short natural-language summary (2-4 sentences) referencing concrete
numbers from the result. NO code, NO markdown headings, NO <sql> block in
Phase 2 — only plain prose in the language the user is writing.

## Clarifying questions (RARE — only when truly necessary)

If the user's request is GENUINELY AMBIGUOUS AND the ambiguity MATERIALLY
changes the SQL (e.g. "the busiest stops" without a time window), you MAY
ask a short clarifying question INSTEAD of guessing. In that case ONLY,
format:

  <preamble>Quick question — do you mean X or Y?</preamble>

and OMIT the <sql> block entirely. Use this VERY SPARINGLY — for any
request with an obvious default interpretation (e.g. "how many routes?",
"list the agencies", "trips on Mondays"), you MUST emit a <sql> block,
not a clarifying question.

## Mutations — the guided repair flow

The server NEVER executes a mutation directly from this conversation.
When the user asks to FIX or CHANGE something (UPDATE/INSERT/DELETE):
  - Emit the <sql> block with the draft mutation — confidently, this is the
    expected behaviour, not a policy violation.
  - The app then walks the user through a guided flow on YOUR draft:
    server-side dry-run preview (affected row counts + foreign-key cascade),
    an explicit confirmation click, a transactional apply with one-click
    undo, and an automatic re-validation of the whole feed.
  - In the preamble, say in one sentence what the fix does and that they
    can preview and apply it right here.
  - Prefer ONE well-scoped statement with a precise WHERE clause over
    multi-statement batches. Never touch _edit_log, _edit_meta or
    _project_meta.

## Repair playbook (session context → fix patterns)

A [Session context] block in the user message may list the feed's current
validation findings (rule codes + counts). When the user asks to fix them,
draft mutations following these patterns:

invalid_url (scheme missing):
  UPDATE stops SET stop_url = 'https://' || stop_url
  WHERE stop_url IS NOT NULL AND stop_url != '' AND stop_url NOT LIKE '%://%';

invalid_color (leading # or lowercase):
  UPDATE routes SET route_color = UPPER(REPLACE(route_color, '#', ''))
  WHERE route_color IS NOT NULL AND route_color != '';

start_and_end_range_out_of_order (reversed service dates — swap):
  UPDATE calendar SET start_date = end_date, end_date = start_date
  WHERE start_date > end_date;

invalid_timezone (agency timezone casing):
  UPDATE agency SET agency_timezone = 'Europe/Paris'
  WHERE LOWER(agency_timezone) = 'europe/paris';

foreign_key_violation (orphan stop_times → remove rows pointing nowhere):
  DELETE FROM stop_times
  WHERE trip_id NOT IN (SELECT trip_id FROM trips);

leading_or_trailing_whitespaces:
  UPDATE stops SET stop_name = TRIM(stop_name) WHERE stop_name != TRIM(stop_name);

For rules that need information NOT present in the feed (real coordinates,
missing required names), do NOT invent values: explain what is missing and
draft a template with an explicit placeholder the user must edit.`;

const CHAT_SYSTEM_PROMPT = SYSTEM_PROMPT + CHAT_SUFFIX;

const buildChatSystemPrompt = () => CHAT_SYSTEM_PROMPT;

// ─── User prompt builder ──────────────────────────────────────────────────
const buildUserPrompt = (naturalLanguage, mode, language) => {
  const langName =
    {
      en: "English",
      fr: "French",
      es: "Spanish",
      de: "German",
      pt: "Portuguese",
      zh: "Chinese (Simplified)",
      ar: "Arabic",
      hi: "Hindi",
    }[language] || "English";

  return `Mode: ${mode}
Explanation language: ${langName}

Request:
${naturalLanguage.trim()}

Respond ONLY with the JSON object as specified.`;
};

// ─── JSON parser robustness layer ─────────────────────────────────────────
// Claude usually respects the "no fences, no prose" rule, but not 100% of
// the time. Strip code fences and surrounding whitespace before JSON.parse.
const extractJson = (text) => {
  if (!text) return null;
  let cleaned = text.trim();
  // Strip ```json … ``` or ``` … ``` fences if present.
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    cleaned = cleaned.trim();
  }
  // If still surrounded by prose, find the first { and last }.
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
};

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Generate a SQLite query from natural language.
 *
 * @param {Object} opts
 * @param {string} opts.naturalLanguage — user's request, any supported language
 * @param {"read"|"edit"} [opts.mode] — defaults to "read"
 * @param {string} [opts.language] — UI language code for the explanation
 *                                    (en, fr, es, de, pt, zh, ar, hi)
 * @returns {Promise<{sql: string, explanation: string, model: string,
 *                    usage: {input_tokens, output_tokens,
 *                            cache_creation_input_tokens, cache_read_input_tokens}}>}
 */
const generateSql = async ({
  naturalLanguage,
  mode = "read",
  language = "en",
}) => {
  if (!naturalLanguage || typeof naturalLanguage !== "string") {
    throw Object.assign(new Error("naturalLanguage is required"), {
      code: "INVALID_INPUT",
    });
  }
  const trimmed = naturalLanguage.trim();
  if (trimmed.length < 3) {
    throw Object.assign(
      new Error("naturalLanguage is too short (min 3 chars)"),
      { code: "INVALID_INPUT" },
    );
  }
  if (trimmed.length > 2000) {
    throw Object.assign(
      new Error("naturalLanguage is too long (max 2000 chars)"),
      { code: "INVALID_INPUT" },
    );
  }
  if (mode !== "read" && mode !== "edit") {
    throw Object.assign(new Error("mode must be 'read' or 'edit'"), {
      code: "INVALID_INPUT",
    });
  }

  const client = getClient();
  const model = config.NL2SQL_MODEL;

  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: 1024,
      // System as an array of TextBlock so we can attach cache_control.
      // The system prompt is invariant across requests → cache_read_input_tokens
      // should be ~3-5K on the 2nd call onwards (~10× cost reduction).
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: buildUserPrompt(trimmed, mode, language),
        },
      ],
    });
  } catch (err) {
    // Map Anthropic SDK errors to our error envelope.
    const status = err?.status || err?.response?.status;
    const code =
      status === 401
        ? "UPSTREAM_AUTH_ERROR"
        : status === 429
          ? "UPSTREAM_RATE_LIMIT"
          : status >= 500
            ? "UPSTREAM_ERROR"
            : "UPSTREAM_ERROR";
    throw Object.assign(
      new Error(err?.message || "Anthropic API call failed"),
      { code, status: status || 502 },
    );
  }

  // Extract the first text block from the response.
  const textBlock = (response.content || []).find((b) => b.type === "text");
  const rawText = textBlock?.text || "";
  const parsed = extractJson(rawText);

  if (!parsed || typeof parsed.sql !== "string") {
    throw Object.assign(
      new Error("Model returned an unparseable response"),
      { code: "PARSE_ERROR", raw: rawText.slice(0, 500) },
    );
  }

  return {
    sql: parsed.sql.trim(),
    explanation:
      typeof parsed.explanation === "string" ? parsed.explanation.trim() : "",
    model: response.model || model,
    usage: {
      input_tokens: response.usage?.input_tokens ?? 0,
      output_tokens: response.usage?.output_tokens ?? 0,
      cache_creation_input_tokens:
        response.usage?.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: response.usage?.cache_read_input_tokens ?? 0,
    },
  };
};

module.exports = {
  generateSql,
  // Public — used by nl2sqlChatService for streaming multi-turn chat.
  buildChatSystemPrompt,
  CHAT_SYSTEM_PROMPT,
  // Exported for tests and diagnostics — DO NOT call from request path.
  _internals: {
    buildSystemPrompt,
    buildUserPrompt,
    extractJson,
    SYSTEM_PROMPT,
  },
};
