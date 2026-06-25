/**
 * SQLite schema mirroring GTFS + internal edit tables.
 *
 * ─ Source of truth during edit mode ─
 * Foreign keys with ON UPDATE CASCADE maintain referential integrity
 * without application code: renaming a stop_id propagates automatically
 * to stop_times, parent_station, etc.
 *
 * All tables use permissive types (TEXT) where GTFS is itself textual,
 * to support alphanumeric identifiers and avoid data loss on the
 * CSV → SQLite → CSV round-trip.
 */

const SCHEMA_VERSION = 13;

// Magic string inside `_project_meta.key='app_magic'`.
// Used to identify a valid `.gtfsproj` file on import.
//
// IMPORTANT: this value is intentionally kept as the legacy
// "gtfs-interpreter-project" string after the rebrand to GTFS Express.
// Changing it would break import of every .gtfsproj file already saved
// by users on disk. A future migration could add backward-compatible
// acceptance of multiple magic values.
const PROJECT_MAGIC = "gtfs-interpreter-project";

const DDL = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;
PRAGMA mmap_size = 268435456;
-- 64 MB page cache per DB handle (default is 2 MB). On a feed with
-- 10M stop_times the working set fits in cache, which removes most of
-- the disk reads on hot-path queries (getStopsAndTimes, statistics).
-- Negative value = absolute size in KB. 64 MB × ~5 active sessions
-- worst-case = 320 MB, well within the 2 GB API container limit.
PRAGMA cache_size = -65536;

CREATE TABLE IF NOT EXISTS agency (
  agency_id       TEXT PRIMARY KEY,
  agency_name     TEXT NOT NULL,
  agency_url      TEXT,
  agency_timezone TEXT,
  agency_lang     TEXT,
  agency_phone    TEXT,
  agency_fare_url TEXT,
  agency_email    TEXT,
  cemv_support    TEXT
);

CREATE TABLE IF NOT EXISTS routes (
  route_id          TEXT PRIMARY KEY,
  agency_id         TEXT REFERENCES agency(agency_id) ON UPDATE CASCADE,
  route_short_name  TEXT,
  route_long_name   TEXT,
  route_desc        TEXT,
  route_type        TEXT,
  route_url         TEXT,
  route_color       TEXT,
  route_text_color  TEXT,
  route_sort_order  TEXT,
  continuous_pickup TEXT,
  continuous_drop_off TEXT,
  network_id        TEXT,
  cemv_support      TEXT
);
CREATE INDEX IF NOT EXISTS idx_routes_agency ON routes(agency_id);

CREATE TABLE IF NOT EXISTS stops (
  stop_id             TEXT PRIMARY KEY,
  stop_code           TEXT,
  stop_name           TEXT,
  stop_desc           TEXT,
  stop_lat            REAL,
  stop_lon            REAL,
  zone_id             TEXT,
  stop_url            TEXT,
  location_type       TEXT,
  parent_station      TEXT REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE SET NULL,
  stop_timezone       TEXT,
  wheelchair_boarding TEXT,
  platform_code       TEXT,
  level_id            TEXT,
  tts_stop_name       TEXT,
  stop_access         TEXT
);
CREATE INDEX IF NOT EXISTS idx_stops_parent ON stops(parent_station);

CREATE TABLE IF NOT EXISTS calendar (
  service_id TEXT PRIMARY KEY,
  monday     INTEGER,
  tuesday    INTEGER,
  wednesday  INTEGER,
  thursday   INTEGER,
  friday     INTEGER,
  saturday   INTEGER,
  sunday     INTEGER,
  start_date TEXT,
  end_date   TEXT
);

CREATE TABLE IF NOT EXISTS calendar_dates (
  service_id     TEXT NOT NULL,
  date           TEXT NOT NULL,
  exception_type INTEGER NOT NULL,
  PRIMARY KEY (service_id, date)
);

CREATE TABLE IF NOT EXISTS trips (
  trip_id               TEXT PRIMARY KEY,
  route_id              TEXT REFERENCES routes(route_id) ON UPDATE CASCADE ON DELETE CASCADE,
  service_id            TEXT,
  trip_headsign         TEXT,
  trip_short_name       TEXT,
  direction_id          TEXT,
  block_id              TEXT,
  shape_id              TEXT,
  wheelchair_accessible TEXT,
  bikes_allowed         TEXT,
  cars_allowed          TEXT
);
CREATE INDEX IF NOT EXISTS idx_trips_route    ON trips(route_id);
CREATE INDEX IF NOT EXISTS idx_trips_service  ON trips(service_id);
CREATE INDEX IF NOT EXISTS idx_trips_shape    ON trips(shape_id);
-- Composite index used by getStopsAndTimes:
--   WHERE route_id = ? AND service_id IN (...)
-- Without this, SQLite picks one of the two single-column indexes and
-- table-scans the rest. On 500k-trip feeds this can be the difference
-- between 200 ms and 4 s per call.
CREATE INDEX IF NOT EXISTS idx_trips_route_service ON trips(route_id, service_id);

CREATE TABLE IF NOT EXISTS stop_times (
  trip_id                      TEXT NOT NULL REFERENCES trips(trip_id) ON UPDATE CASCADE ON DELETE CASCADE,
  arrival_time                 TEXT,
  departure_time               TEXT,
  stop_id                      TEXT REFERENCES stops(stop_id) ON UPDATE CASCADE,
  -- Schema v12: GTFS-Flex alternatives to stop_id. Either may be set instead
  -- of stop_id when the trip operates within a zone (locations.geojson) or
  -- a named group of stops (location_groups.txt). At most one of the three
  -- (stop_id, location_id, location_group_id) is populated per row; the
  -- validator's missing_required_field check on stop_id has been relaxed
  -- accordingly. We do not declare an FK on location_id because
  -- locations.geojson rows live in locations_geojson where the PK is
  -- feature_id (and we cannot enforce a cross-table FK to a JSON-derived
  -- table reliably across all GTFS-Flex feeds).
  location_id                  TEXT,
  location_group_id            TEXT,
  stop_sequence                INTEGER NOT NULL,
  stop_headsign                TEXT,
  pickup_type                  TEXT,
  drop_off_type                TEXT,
  continuous_pickup            TEXT,
  continuous_drop_off          TEXT,
  shape_dist_traveled          TEXT,
  timepoint                    TEXT,
  start_pickup_drop_off_window TEXT,
  end_pickup_drop_off_window   TEXT,
  PRIMARY KEY (trip_id, stop_sequence)
);
CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON stop_times(stop_id);
-- idx_stop_times_location_id and idx_stop_times_location_group_id are
-- created by migrateIfNeeded (v11→v12) AFTER the ALTER TABLE that adds
-- the columns. We can't create them here because on a v11 DB the
-- columns don't yet exist when this DDL block runs.

CREATE TABLE IF NOT EXISTS shapes (
  shape_id            TEXT NOT NULL,
  shape_pt_lat        REAL,
  shape_pt_lon        REAL,
  shape_pt_sequence   INTEGER NOT NULL,
  shape_dist_traveled REAL,
  PRIMARY KEY (shape_id, shape_pt_sequence)
);

CREATE TABLE IF NOT EXISTS feed_info (
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

CREATE TABLE IF NOT EXISTS frequencies (
  trip_id      TEXT NOT NULL REFERENCES trips(trip_id) ON UPDATE CASCADE ON DELETE CASCADE,
  start_time   TEXT NOT NULL,
  end_time     TEXT,
  headway_secs INTEGER,
  exact_times  INTEGER,
  PRIMARY KEY (trip_id, start_time)
);

CREATE TABLE IF NOT EXISTS levels (
  level_id    TEXT PRIMARY KEY,
  level_index REAL,
  level_name  TEXT
);

CREATE TABLE IF NOT EXISTS pathways (
  pathway_id              TEXT PRIMARY KEY,
  from_stop_id            TEXT NOT NULL REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE CASCADE,
  to_stop_id              TEXT NOT NULL REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE CASCADE,
  pathway_mode            INTEGER NOT NULL,
  is_bidirectional        INTEGER NOT NULL,
  length                  REAL,
  traversal_time          INTEGER,
  stair_count             INTEGER,
  max_slope               REAL,
  min_width               REAL,
  signposted_as           TEXT,
  reversed_signposted_as  TEXT
);
CREATE INDEX IF NOT EXISTS idx_pathways_from ON pathways(from_stop_id);
CREATE INDEX IF NOT EXISTS idx_pathways_to   ON pathways(to_stop_id);

CREATE TABLE IF NOT EXISTS transfers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  from_stop_id      TEXT REFERENCES stops(stop_id)   ON UPDATE CASCADE ON DELETE CASCADE,
  to_stop_id        TEXT REFERENCES stops(stop_id)   ON UPDATE CASCADE ON DELETE CASCADE,
  from_route_id     TEXT REFERENCES routes(route_id) ON UPDATE CASCADE ON DELETE CASCADE,
  to_route_id       TEXT REFERENCES routes(route_id) ON UPDATE CASCADE ON DELETE CASCADE,
  from_trip_id      TEXT REFERENCES trips(trip_id)   ON UPDATE CASCADE ON DELETE CASCADE,
  to_trip_id        TEXT REFERENCES trips(trip_id)   ON UPDATE CASCADE ON DELETE CASCADE,
  transfer_type     INTEGER,
  min_transfer_time INTEGER
);
CREATE INDEX IF NOT EXISTS idx_transfers_from_stop ON transfers(from_stop_id);
CREATE INDEX IF NOT EXISTS idx_transfers_to_stop   ON transfers(to_stop_id);

-- ─── Internal edit tables ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS _edit_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Project-level metadata (persisted inside .gtfsproj so the file is self-describing).
-- Free-form key/value store so fields can be added without schema bumps.
CREATE TABLE IF NOT EXISTS _project_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS _edit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  entity      TEXT NOT NULL,   -- 'stop', 'route', 'trip', 'calendar', ...
  entity_id   TEXT,            -- targeted id (stop_id, route_id, ...)
  action      TEXT NOT NULL,   -- 'update', 'create', 'delete'
  description TEXT,
  undo_ops    TEXT NOT NULL,   -- JSON: [{sql, params:[...]}]
  redo_ops    TEXT,            -- JSON: [{sql, params:[...]}] — NULL for legacy rows
  undone      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_edit_log_active ON _edit_log(undone, id);

CREATE TABLE IF NOT EXISTS translations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name      TEXT NOT NULL,
  field_name      TEXT NOT NULL,
  language        TEXT NOT NULL,
  translation     TEXT NOT NULL,
  record_id       TEXT,
  record_sub_id   TEXT,
  field_value     TEXT
);
CREATE INDEX IF NOT EXISTS idx_translations_lookup
  ON translations(table_name, field_name, language, record_id);
CREATE INDEX IF NOT EXISTS idx_translations_language ON translations(language);

CREATE TABLE IF NOT EXISTS attributions (
  rowid              INTEGER PRIMARY KEY AUTOINCREMENT,
  attribution_id     TEXT,
  agency_id          TEXT REFERENCES agency(agency_id) ON UPDATE CASCADE ON DELETE CASCADE,
  route_id           TEXT REFERENCES routes(route_id) ON UPDATE CASCADE ON DELETE CASCADE,
  trip_id            TEXT REFERENCES trips(trip_id)   ON UPDATE CASCADE ON DELETE CASCADE,
  organization_name  TEXT NOT NULL,
  is_producer        TEXT,
  is_operator        TEXT,
  is_authority       TEXT,
  attribution_url    TEXT,
  attribution_email  TEXT,
  attribution_phone  TEXT
);
CREATE INDEX IF NOT EXISTS idx_attributions_agency ON attributions(agency_id);
CREATE INDEX IF NOT EXISTS idx_attributions_route  ON attributions(route_id);
CREATE INDEX IF NOT EXISTS idx_attributions_trip   ON attributions(trip_id);

-- ═══════════════════════════════════════════════════════════════════════════
--  v10 → v11 — Fares v1 promotion + Fares v2 cluster + Booking rules + Flex
-- ═══════════════════════════════════════════════════════════════════════════
-- Until v10 these files were treated as passthrough: validated on disk, not
-- editable, blind to FK enforcement at the DB layer. v11 promotes them to
-- first-class managed tables so the editor experience is uniform across the
-- whole GTFS Schedule + Fares v2 + Flex + DRT booking surface.

-- ── Fares v1 (legacy, was passthrough) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS fare_attributes (
  fare_id            TEXT PRIMARY KEY,
  price              TEXT NOT NULL,
  currency_type      TEXT NOT NULL,
  payment_method     TEXT NOT NULL CHECK (payment_method IN ('0','1')),
  transfers          TEXT,
  agency_id          TEXT REFERENCES agency(agency_id) ON UPDATE CASCADE ON DELETE SET NULL,
  transfer_duration  TEXT
);

CREATE TABLE IF NOT EXISTS fare_rules (
  rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
  fare_id        TEXT NOT NULL REFERENCES fare_attributes(fare_id) ON UPDATE CASCADE ON DELETE CASCADE,
  route_id       TEXT REFERENCES routes(route_id) ON UPDATE CASCADE ON DELETE CASCADE,
  origin_id      TEXT,
  destination_id TEXT,
  contains_id    TEXT
);
CREATE INDEX IF NOT EXISTS idx_fare_rules_fare  ON fare_rules(fare_id);
CREATE INDEX IF NOT EXISTS idx_fare_rules_route ON fare_rules(route_id);

-- ── Fares v2 — Areas (zonal fare structure) ────────────────────────────────
-- https://gtfs.org/documentation/schedule/reference/#areastxt
CREATE TABLE IF NOT EXISTS areas (
  area_id   TEXT PRIMARY KEY,
  area_name TEXT
);

CREATE TABLE IF NOT EXISTS stop_areas (
  rowid   INTEGER PRIMARY KEY AUTOINCREMENT,
  area_id TEXT NOT NULL REFERENCES areas(area_id) ON UPDATE CASCADE ON DELETE CASCADE,
  stop_id TEXT NOT NULL REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE CASCADE,
  UNIQUE (area_id, stop_id)
);
CREATE INDEX IF NOT EXISTS idx_stop_areas_area ON stop_areas(area_id);
CREATE INDEX IF NOT EXISTS idx_stop_areas_stop ON stop_areas(stop_id);

-- ── Fares v2 — Networks (logical grouping of routes) ───────────────────────
CREATE TABLE IF NOT EXISTS networks (
  network_id   TEXT PRIMARY KEY,
  network_name TEXT
);

CREATE TABLE IF NOT EXISTS route_networks (
  rowid      INTEGER PRIMARY KEY AUTOINCREMENT,
  network_id TEXT NOT NULL REFERENCES networks(network_id) ON UPDATE CASCADE ON DELETE CASCADE,
  -- A route belongs to AT MOST ONE network per the spec; UNIQUE enforces it.
  route_id   TEXT NOT NULL UNIQUE REFERENCES routes(route_id) ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_route_networks_network ON route_networks(network_id);

-- ── Fares v2 — Fare media (cash, card, paper, cEMV, mobile) ────────────────
-- fare_media_type values:
--   0 = none (cash) | 1 = paper | 2 = transit card | 3 = cEMV | 4 = mobile app
CREATE TABLE IF NOT EXISTS fare_media (
  fare_media_id   TEXT PRIMARY KEY,
  fare_media_name TEXT,
  fare_media_type TEXT NOT NULL CHECK (fare_media_type IN ('0','1','2','3','4'))
);

-- ── Fares v2 — Rider categories (adult, child, senior, …) ──────────────────
CREATE TABLE IF NOT EXISTS rider_categories (
  rider_category_id        TEXT PRIMARY KEY,
  rider_category_name      TEXT NOT NULL,
  -- '0' / '1' / '' (empty defaulting to 0). NULL kept distinct for INSERT
  -- ergonomics; the field validator + check guarantee it's one of those.
  is_default_fare_category TEXT CHECK (is_default_fare_category IN ('0','1','') OR is_default_fare_category IS NULL),
  eligibility_url          TEXT
);

-- ── Fares v2 — Fare products (priced offerings) ────────────────────────────
-- Composite primary key (fare_product_id, rider_category_id, fare_media_id):
-- the same product appears once per (rider_category, media) tuple. Modeled
-- with a synthetic rowid + UNIQUE constraint because SQLite composite PK
-- with nullable columns doesn't enforce the desired uniqueness when one
-- field is NULL.
CREATE TABLE IF NOT EXISTS fare_products (
  rowid             INTEGER PRIMARY KEY AUTOINCREMENT,
  fare_product_id   TEXT NOT NULL,
  fare_product_name TEXT,
  rider_category_id TEXT REFERENCES rider_categories(rider_category_id) ON UPDATE CASCADE ON DELETE SET NULL,
  fare_media_id     TEXT REFERENCES fare_media(fare_media_id) ON UPDATE CASCADE ON DELETE SET NULL,
  amount            TEXT NOT NULL,
  currency          TEXT NOT NULL,
  UNIQUE (fare_product_id, rider_category_id, fare_media_id)
);
CREATE INDEX IF NOT EXISTS idx_fare_products_id ON fare_products(fare_product_id);

-- ── Fares v2 — Timeframes (was passthrough until v11) ──────────────────────
-- timeframe_group_id is repeated across rows (each row defines one window
-- for one service_id). No natural PK ⇒ synthetic rowid.
CREATE TABLE IF NOT EXISTS timeframes (
  rowid              INTEGER PRIMARY KEY AUTOINCREMENT,
  timeframe_group_id TEXT NOT NULL,
  start_time         TEXT,
  end_time           TEXT,
  service_id         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_timeframes_group   ON timeframes(timeframe_group_id);
CREATE INDEX IF NOT EXISTS idx_timeframes_service ON timeframes(service_id);

-- ── Fares v2 — Leg rules (per-leg pricing) ─────────────────────────────────
-- timeframe_group_id FKs are NOT enforced via REFERENCES because timeframes
-- groups are not a key of timeframes (rowid is). The validator's
-- foreign_key_violation rule handles it at validation time.
CREATE TABLE IF NOT EXISTS fare_leg_rules (
  rowid                   INTEGER PRIMARY KEY AUTOINCREMENT,
  leg_group_id            TEXT,
  network_id              TEXT REFERENCES networks(network_id) ON UPDATE CASCADE ON DELETE SET NULL,
  from_area_id            TEXT REFERENCES areas(area_id) ON UPDATE CASCADE ON DELETE SET NULL,
  to_area_id              TEXT REFERENCES areas(area_id) ON UPDATE CASCADE ON DELETE SET NULL,
  from_timeframe_group_id TEXT,
  to_timeframe_group_id   TEXT,
  fare_product_id         TEXT NOT NULL,
  rule_priority           TEXT
);
CREATE INDEX IF NOT EXISTS idx_fare_leg_rules_product ON fare_leg_rules(fare_product_id);
CREATE INDEX IF NOT EXISTS idx_fare_leg_rules_network ON fare_leg_rules(network_id);
CREATE INDEX IF NOT EXISTS idx_fare_leg_rules_leg     ON fare_leg_rules(leg_group_id);

-- ── Fares v2 — Leg join rules (transfers between networks at stops) ────────
CREATE TABLE IF NOT EXISTS fare_leg_join_rules (
  rowid           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_network_id TEXT NOT NULL REFERENCES networks(network_id) ON UPDATE CASCADE ON DELETE CASCADE,
  to_network_id   TEXT NOT NULL REFERENCES networks(network_id) ON UPDATE CASCADE ON DELETE CASCADE,
  from_stop_id    TEXT REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE SET NULL,
  to_stop_id      TEXT REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_fare_leg_join_from ON fare_leg_join_rules(from_network_id);
CREATE INDEX IF NOT EXISTS idx_fare_leg_join_to   ON fare_leg_join_rules(to_network_id);

-- ── Fares v2 — Transfer rules ──────────────────────────────────────────────
-- duration_limit_type values: 0..3 (or empty). fare_transfer_type: 0..2.
CREATE TABLE IF NOT EXISTS fare_transfer_rules (
  rowid               INTEGER PRIMARY KEY AUTOINCREMENT,
  from_leg_group_id   TEXT,
  to_leg_group_id     TEXT,
  transfer_count      TEXT,
  duration_limit      TEXT,
  duration_limit_type TEXT CHECK (
    duration_limit_type IS NULL OR duration_limit_type IN ('','0','1','2','3')
  ),
  fare_transfer_type  TEXT NOT NULL CHECK (fare_transfer_type IN ('0','1','2')),
  fare_product_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_fare_transfer_rules_from    ON fare_transfer_rules(from_leg_group_id);
CREATE INDEX IF NOT EXISTS idx_fare_transfer_rules_to      ON fare_transfer_rules(to_leg_group_id);
CREATE INDEX IF NOT EXISTS idx_fare_transfer_rules_product ON fare_transfer_rules(fare_product_id);

-- ── DRT / Flex — Booking rules ─────────────────────────────────────────────
-- booking_type values: 0 = real-time | 1 = same-day with prior notice |
--                     2 = up to a prior day
CREATE TABLE IF NOT EXISTS booking_rules (
  booking_rule_id            TEXT PRIMARY KEY,
  booking_type               TEXT NOT NULL CHECK (booking_type IN ('0','1','2')),
  prior_notice_duration_min  TEXT,
  prior_notice_duration_max  TEXT,
  prior_notice_last_day      TEXT,
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

-- ── GTFS-Flex — locations.geojson decomposed per Feature ───────────────────
-- Each FeatureCollection feature lands as one row. Geometry coordinates are
-- stored as a JSON blob (queryable via SQLite JSON1). Unknown top-level keys
-- and non-Flex properties are preserved in extra_properties so the export
-- round-trip stays loyal even for fields the editor doesn't expose.
CREATE TABLE IF NOT EXISTS locations_geojson (
  feature_id       TEXT PRIMARY KEY,
  geometry_type    TEXT NOT NULL CHECK (geometry_type IN ('Polygon','MultiPolygon')),
  coordinates      TEXT NOT NULL,
  stop_name        TEXT,
  stop_desc        TEXT,
  extra_properties TEXT
);

-- ── GTFS-Flex — location_groups (named stop groups for DRT booking) ────────
-- https://gtfs.org/documentation/schedule/reference/#location_groupstxt
-- A location_group is a named bag of stops that a Flex trip's stop_times
-- can target via location_group_id (introduced in stop_times at schema v12).
-- The group definition + group→stop mapping land in two managed tables here
-- so the editor can mutate them through standard CRUD endpoints rather than
-- forcing users into raw SQL or a passthrough .txt file.
CREATE TABLE IF NOT EXISTS location_groups (
  location_group_id   TEXT PRIMARY KEY,
  location_group_name TEXT
);

CREATE TABLE IF NOT EXISTS location_group_stops (
  location_group_id TEXT NOT NULL REFERENCES location_groups(location_group_id) ON UPDATE CASCADE ON DELETE CASCADE,
  stop_id           TEXT NOT NULL REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE CASCADE,
  PRIMARY KEY (location_group_id, stop_id)
);
CREATE INDEX IF NOT EXISTS idx_location_group_stops_group ON location_group_stops(location_group_id);
CREATE INDEX IF NOT EXISTS idx_location_group_stops_stop  ON location_group_stops(stop_id);
`;

/**
 * In-place migrations for DBs created with older SCHEMA_VERSION values.
 * Each step is idempotent (guarded by PRAGMA table_info / IF NOT EXISTS).
 *  - v1 → v2: `_edit_log.redo_ops` column
 *  - v2 → v3: `_project_meta` table (project-level metadata for .gtfsproj files)
 *  - v3 → v4: new GTFS v2.1 columns on stops, routes, stop_times
 *  - v4 → v5: `feed_info` table (GTFS feed metadata singleton)
 *  - v5 → v6: `transfers` table + indexes (GTFS transfers.txt now managed by SQLite)
 *  - v6 → v7: `levels` table + `pathways` table + indexes (accessibility / indoor navigation)
 *  - v7 → v8: `translations` table + indexes (GTFS multilingual translations)
 *  - v8 → v9: cars_allowed (trips), cemv_support (agency, routes), stop_access (stops) — GTFS Schedule spec recent additions
 *  - v9 → v10: `attributions` table + 3 indexes (GTFS attributions.txt — organization credits)
 *  - v10 → v11: Fares v1 promoted from passthrough to managed (`fare_attributes`,
 *    `fare_rules`); Fares v2 cluster (`areas`, `stop_areas`, `networks`,
 *    `route_networks`, `fare_media`, `rider_categories`, `fare_products`,
 *    `timeframes`, `fare_leg_rules`, `fare_leg_join_rules`,
 *    `fare_transfer_rules`); DRT/Flex (`booking_rules`); GTFS-Flex
 *    (`locations_geojson`). All new tables ship with FK + CHECK constraints
 *    aligned with the validator's enum / cardinality rules.
 *  - v11 → v12: GTFS-Flex stop_times alternatives — `location_id` and
 *    `location_group_id` columns on `stop_times`. Either may be set
 *    instead of `stop_id` when a trip serves a zone (locations.geojson)
 *    or a named stop group (location_groups.txt). Validator's
 *    missing_required_field on stop_id and missing_trip_edge on the
 *    arrival/departure pair were relaxed accordingly to align with the
 *    MobilityData Canonical Validator on Flex feeds.
 *  - v12 → v13: GTFS-Flex location_groups + location_group_stops promoted
 *    from passthrough .txt files to managed tables with FK enforcement
 *    (location_group_id ↔ stops). Editable through standard CRUD
 *    endpoints; stop_times.location_group_id now references
 *    location_groups, so cascade DELETE propagates to dependent
 *    stop_times rows.
 */
const migrateIfNeeded = (db) => {
  const cols = db.prepare("PRAGMA table_info(_edit_log)").all();
  const hasRedo = cols.some((c) => c.name === "redo_ops");
  if (!hasRedo) {
    db.exec("ALTER TABLE _edit_log ADD COLUMN redo_ops TEXT");
  }
  // `_project_meta` is created by the main DDL (IF NOT EXISTS) for v3+ DBs,
  // but a DB opened from a v1/v2 file also gets it here as a defensive double-check.
  db.exec(
    "CREATE TABLE IF NOT EXISTS _project_meta (key TEXT PRIMARY KEY, value TEXT)",
  );

  // v3 → v4: stops — level_id, tts_stop_name
  const stopsCols = db.prepare("PRAGMA table_info(stops)").all();
  if (!stopsCols.some((c) => c.name === "level_id")) {
    db.exec("ALTER TABLE stops ADD COLUMN level_id TEXT");
  }
  if (!stopsCols.some((c) => c.name === "tts_stop_name")) {
    db.exec("ALTER TABLE stops ADD COLUMN tts_stop_name TEXT");
  }

  // v3 → v4: routes — continuous_pickup, continuous_drop_off, network_id
  const routesCols = db.prepare("PRAGMA table_info(routes)").all();
  if (!routesCols.some((c) => c.name === "continuous_pickup")) {
    db.exec("ALTER TABLE routes ADD COLUMN continuous_pickup TEXT");
  }
  if (!routesCols.some((c) => c.name === "continuous_drop_off")) {
    db.exec("ALTER TABLE routes ADD COLUMN continuous_drop_off TEXT");
  }
  if (!routesCols.some((c) => c.name === "network_id")) {
    db.exec("ALTER TABLE routes ADD COLUMN network_id TEXT");
  }

  // v3 → v4: stop_times — continuous_pickup, continuous_drop_off
  const stopTimesCols = db.prepare("PRAGMA table_info(stop_times)").all();
  if (!stopTimesCols.some((c) => c.name === "continuous_pickup")) {
    db.exec("ALTER TABLE stop_times ADD COLUMN continuous_pickup TEXT");
  }
  if (!stopTimesCols.some((c) => c.name === "continuous_drop_off")) {
    db.exec("ALTER TABLE stop_times ADD COLUMN continuous_drop_off TEXT");
  }

  // v4 → v5: feed_info table (singleton, no PK — enforced at application level)
  db.exec(`CREATE TABLE IF NOT EXISTS feed_info (
    feed_publisher_name TEXT,
    feed_publisher_url  TEXT,
    feed_lang           TEXT,
    default_lang        TEXT,
    feed_start_date     TEXT,
    feed_end_date       TEXT,
    feed_version        TEXT,
    feed_contact_email  TEXT,
    feed_contact_url    TEXT
  )`);

  // v5 → v6: transfers table (GTFS optional file — stop/route/trip correspondence)
  db.exec(`CREATE TABLE IF NOT EXISTS transfers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    from_stop_id      TEXT REFERENCES stops(stop_id)   ON UPDATE CASCADE ON DELETE CASCADE,
    to_stop_id        TEXT REFERENCES stops(stop_id)   ON UPDATE CASCADE ON DELETE CASCADE,
    from_route_id     TEXT REFERENCES routes(route_id) ON UPDATE CASCADE ON DELETE CASCADE,
    to_route_id       TEXT REFERENCES routes(route_id) ON UPDATE CASCADE ON DELETE CASCADE,
    from_trip_id      TEXT REFERENCES trips(trip_id)   ON UPDATE CASCADE ON DELETE CASCADE,
    to_trip_id        TEXT REFERENCES trips(trip_id)   ON UPDATE CASCADE ON DELETE CASCADE,
    transfer_type     INTEGER,
    min_transfer_time INTEGER
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_transfers_from_stop ON transfers(from_stop_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_transfers_to_stop   ON transfers(to_stop_id)");

  // v6 → v7: levels + pathways tables (accessibility / indoor navigation)
  db.exec(`CREATE TABLE IF NOT EXISTS levels (
    level_id    TEXT PRIMARY KEY,
    level_index REAL,
    level_name  TEXT
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS pathways (
    pathway_id              TEXT PRIMARY KEY,
    from_stop_id            TEXT NOT NULL REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE CASCADE,
    to_stop_id              TEXT NOT NULL REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE CASCADE,
    pathway_mode            INTEGER NOT NULL,
    is_bidirectional        INTEGER NOT NULL,
    length                  REAL,
    traversal_time          INTEGER,
    stair_count             INTEGER,
    max_slope               REAL,
    min_width               REAL,
    signposted_as           TEXT,
    reversed_signposted_as  TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_pathways_from ON pathways(from_stop_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_pathways_to   ON pathways(to_stop_id)");

  // v7 → v8: translations table (GTFS multilingual translations)
  db.exec(`CREATE TABLE IF NOT EXISTS translations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name      TEXT NOT NULL,
    field_name      TEXT NOT NULL,
    language        TEXT NOT NULL,
    translation     TEXT NOT NULL,
    record_id       TEXT,
    record_sub_id   TEXT,
    field_value     TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_translations_lookup ON translations(table_name, field_name, language, record_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_translations_language ON translations(language)");

  // v8 → v9: cars_allowed (trips), cemv_support (agency, routes), stop_access (stops)
  const tripsCols = db.prepare("PRAGMA table_info(trips)").all();
  if (!tripsCols.some((c) => c.name === "cars_allowed")) {
    db.exec("ALTER TABLE trips ADD COLUMN cars_allowed TEXT");
  }

  const agencyColsV9 = db.prepare("PRAGMA table_info(agency)").all();
  if (!agencyColsV9.some((c) => c.name === "cemv_support")) {
    db.exec("ALTER TABLE agency ADD COLUMN cemv_support TEXT");
  }

  const routesColsV9 = db.prepare("PRAGMA table_info(routes)").all();
  if (!routesColsV9.some((c) => c.name === "cemv_support")) {
    db.exec("ALTER TABLE routes ADD COLUMN cemv_support TEXT");
  }

  const stopsColsV9 = db.prepare("PRAGMA table_info(stops)").all();
  if (!stopsColsV9.some((c) => c.name === "stop_access")) {
    db.exec("ALTER TABLE stops ADD COLUMN stop_access TEXT");
  }

  // v9 → v10: attributions table (GTFS optional — organization credits)
  db.exec(`CREATE TABLE IF NOT EXISTS attributions (
    rowid              INTEGER PRIMARY KEY AUTOINCREMENT,
    attribution_id     TEXT,
    agency_id          TEXT REFERENCES agency(agency_id) ON UPDATE CASCADE ON DELETE CASCADE,
    route_id           TEXT REFERENCES routes(route_id)  ON UPDATE CASCADE ON DELETE CASCADE,
    trip_id            TEXT REFERENCES trips(trip_id)    ON UPDATE CASCADE ON DELETE CASCADE,
    organization_name  TEXT NOT NULL,
    is_producer        TEXT,
    is_operator        TEXT,
    is_authority       TEXT,
    attribution_url    TEXT,
    attribution_email  TEXT,
    attribution_phone  TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_attributions_agency ON attributions(agency_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_attributions_route  ON attributions(route_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_attributions_trip   ON attributions(trip_id)");

  // v10 → v11: Fares v1 promotion + Fares v2 cluster + Booking + Flex.
  // All idempotent (CREATE TABLE IF NOT EXISTS). Existing v10 .gtfsproj
  // files open without error: tables are simply created empty alongside
  // the existing data, and the schema_version row in _edit_meta is bumped
  // to 11 by applySchema after this migration runs.
  db.exec(`CREATE TABLE IF NOT EXISTS fare_attributes (
    fare_id            TEXT PRIMARY KEY,
    price              TEXT NOT NULL,
    currency_type      TEXT NOT NULL,
    payment_method     TEXT NOT NULL CHECK (payment_method IN ('0','1')),
    transfers          TEXT,
    agency_id          TEXT REFERENCES agency(agency_id) ON UPDATE CASCADE ON DELETE SET NULL,
    transfer_duration  TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS fare_rules (
    rowid          INTEGER PRIMARY KEY AUTOINCREMENT,
    fare_id        TEXT NOT NULL REFERENCES fare_attributes(fare_id) ON UPDATE CASCADE ON DELETE CASCADE,
    route_id       TEXT REFERENCES routes(route_id) ON UPDATE CASCADE ON DELETE CASCADE,
    origin_id      TEXT,
    destination_id TEXT,
    contains_id    TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_rules_fare  ON fare_rules(fare_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_rules_route ON fare_rules(route_id)");

  db.exec("CREATE TABLE IF NOT EXISTS areas (area_id TEXT PRIMARY KEY, area_name TEXT)");
  db.exec(`CREATE TABLE IF NOT EXISTS stop_areas (
    rowid   INTEGER PRIMARY KEY AUTOINCREMENT,
    area_id TEXT NOT NULL REFERENCES areas(area_id) ON UPDATE CASCADE ON DELETE CASCADE,
    stop_id TEXT NOT NULL REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE CASCADE,
    UNIQUE (area_id, stop_id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_stop_areas_area ON stop_areas(area_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_stop_areas_stop ON stop_areas(stop_id)");

  db.exec("CREATE TABLE IF NOT EXISTS networks (network_id TEXT PRIMARY KEY, network_name TEXT)");
  db.exec(`CREATE TABLE IF NOT EXISTS route_networks (
    rowid      INTEGER PRIMARY KEY AUTOINCREMENT,
    network_id TEXT NOT NULL REFERENCES networks(network_id) ON UPDATE CASCADE ON DELETE CASCADE,
    route_id   TEXT NOT NULL UNIQUE REFERENCES routes(route_id) ON UPDATE CASCADE ON DELETE CASCADE
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_route_networks_network ON route_networks(network_id)");

  db.exec(`CREATE TABLE IF NOT EXISTS fare_media (
    fare_media_id   TEXT PRIMARY KEY,
    fare_media_name TEXT,
    fare_media_type TEXT NOT NULL CHECK (fare_media_type IN ('0','1','2','3','4'))
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS rider_categories (
    rider_category_id        TEXT PRIMARY KEY,
    rider_category_name      TEXT NOT NULL,
    is_default_fare_category TEXT CHECK (is_default_fare_category IS NULL OR is_default_fare_category IN ('0','1','')),
    eligibility_url          TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS fare_products (
    rowid             INTEGER PRIMARY KEY AUTOINCREMENT,
    fare_product_id   TEXT NOT NULL,
    fare_product_name TEXT,
    rider_category_id TEXT REFERENCES rider_categories(rider_category_id) ON UPDATE CASCADE ON DELETE SET NULL,
    fare_media_id     TEXT REFERENCES fare_media(fare_media_id) ON UPDATE CASCADE ON DELETE SET NULL,
    amount            TEXT NOT NULL,
    currency          TEXT NOT NULL,
    UNIQUE (fare_product_id, rider_category_id, fare_media_id)
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_products_id ON fare_products(fare_product_id)");

  db.exec(`CREATE TABLE IF NOT EXISTS timeframes (
    rowid              INTEGER PRIMARY KEY AUTOINCREMENT,
    timeframe_group_id TEXT NOT NULL,
    start_time         TEXT,
    end_time           TEXT,
    service_id         TEXT NOT NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_timeframes_group   ON timeframes(timeframe_group_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_timeframes_service ON timeframes(service_id)");

  db.exec(`CREATE TABLE IF NOT EXISTS fare_leg_rules (
    rowid                   INTEGER PRIMARY KEY AUTOINCREMENT,
    leg_group_id            TEXT,
    network_id              TEXT REFERENCES networks(network_id) ON UPDATE CASCADE ON DELETE SET NULL,
    from_area_id            TEXT REFERENCES areas(area_id) ON UPDATE CASCADE ON DELETE SET NULL,
    to_area_id              TEXT REFERENCES areas(area_id) ON UPDATE CASCADE ON DELETE SET NULL,
    from_timeframe_group_id TEXT,
    to_timeframe_group_id   TEXT,
    fare_product_id         TEXT NOT NULL,
    rule_priority           TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_leg_rules_product ON fare_leg_rules(fare_product_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_leg_rules_network ON fare_leg_rules(network_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_leg_rules_leg     ON fare_leg_rules(leg_group_id)");

  db.exec(`CREATE TABLE IF NOT EXISTS fare_leg_join_rules (
    rowid           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_network_id TEXT NOT NULL REFERENCES networks(network_id) ON UPDATE CASCADE ON DELETE CASCADE,
    to_network_id   TEXT NOT NULL REFERENCES networks(network_id) ON UPDATE CASCADE ON DELETE CASCADE,
    from_stop_id    TEXT REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE SET NULL,
    to_stop_id      TEXT REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE SET NULL
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_leg_join_from ON fare_leg_join_rules(from_network_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_leg_join_to   ON fare_leg_join_rules(to_network_id)");

  db.exec(`CREATE TABLE IF NOT EXISTS fare_transfer_rules (
    rowid               INTEGER PRIMARY KEY AUTOINCREMENT,
    from_leg_group_id   TEXT,
    to_leg_group_id     TEXT,
    transfer_count      TEXT,
    duration_limit      TEXT,
    duration_limit_type TEXT CHECK (
      duration_limit_type IS NULL OR duration_limit_type IN ('','0','1','2','3')
    ),
    fare_transfer_type  TEXT NOT NULL CHECK (fare_transfer_type IN ('0','1','2')),
    fare_product_id     TEXT
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_transfer_rules_from    ON fare_transfer_rules(from_leg_group_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_transfer_rules_to      ON fare_transfer_rules(to_leg_group_id)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_fare_transfer_rules_product ON fare_transfer_rules(fare_product_id)");

  db.exec(`CREATE TABLE IF NOT EXISTS booking_rules (
    booking_rule_id            TEXT PRIMARY KEY,
    booking_type               TEXT NOT NULL CHECK (booking_type IN ('0','1','2')),
    prior_notice_duration_min  TEXT,
    prior_notice_duration_max  TEXT,
    prior_notice_last_day      TEXT,
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
  )`);

  db.exec(`CREATE TABLE IF NOT EXISTS locations_geojson (
    feature_id       TEXT PRIMARY KEY,
    geometry_type    TEXT NOT NULL CHECK (geometry_type IN ('Polygon','MultiPolygon')),
    coordinates      TEXT NOT NULL,
    stop_name        TEXT,
    stop_desc        TEXT,
    extra_properties TEXT
  )`);

  // v11 → v12: GTFS-Flex alternatives to stop_id on stop_times rows
  // (location_id, location_group_id). Additive non-destructive migration:
  // existing rows keep stop_id, new rows can use either alternative.
  // Indexes added for FK-style lookups on the alternatives.
  const stopTimesColsV12 = db.prepare("PRAGMA table_info(stop_times)").all();
  if (!stopTimesColsV12.some((c) => c.name === "location_id")) {
    db.exec("ALTER TABLE stop_times ADD COLUMN location_id TEXT");
  }
  if (!stopTimesColsV12.some((c) => c.name === "location_group_id")) {
    db.exec("ALTER TABLE stop_times ADD COLUMN location_group_id TEXT");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_stop_times_location_id ON stop_times(location_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_stop_times_location_group_id ON stop_times(location_group_id)",
  );

  // v12 → v13: GTFS-Flex location_groups + location_group_stops. Promotes
  // these two files from passthrough (in pre-v13 deployments they ended up
  // in the export ZIP via the generic .txt copy path but were not editable
  // and not validated through the FK chain) to first-class managed tables.
  // Stop_times.location_group_id (added in v12) now FK-references this.
  db.exec(`CREATE TABLE IF NOT EXISTS location_groups (
    location_group_id   TEXT PRIMARY KEY,
    location_group_name TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS location_group_stops (
    location_group_id TEXT NOT NULL REFERENCES location_groups(location_group_id) ON UPDATE CASCADE ON DELETE CASCADE,
    stop_id           TEXT NOT NULL REFERENCES stops(stop_id) ON UPDATE CASCADE ON DELETE CASCADE,
    PRIMARY KEY (location_group_id, stop_id)
  )`);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_location_group_stops_group ON location_group_stops(location_group_id)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_location_group_stops_stop ON location_group_stops(stop_id)",
  );
};

/**
 * Apply the schema to a fresh SQLite connection.
 * Idempotent: uses CREATE TABLE IF NOT EXISTS throughout.
 */
const applySchema = (db) => {
  db.exec(DDL);
  migrateIfNeeded(db);
  // Defensive: if `value` is missing, non-numeric, or the row is somehow
  // gone (manually-edited DB, aborted migration), we still want the DB
  // to be marked at the current SCHEMA_VERSION so future migrations
  // behave correctly. Wrapping the SELECT in try-catch covers the case
  // where _edit_meta itself ended up with an unexpected schema and the
  // query throws — INSERT OR REPLACE then rebuilds a clean row.
  let current = null;
  try {
    current = db
      .prepare("SELECT value FROM _edit_meta WHERE key = 'schema_version'")
      .get();
  } catch (err) {
    console.warn(
      `_edit_meta read failed, will rebuild schema_version row: ${err.message}`,
    );
  }
  const currentNum = current ? Number(current.value) : NaN;
  const needsBump =
    !current || !Number.isFinite(currentNum) || currentNum < SCHEMA_VERSION;
  if (needsBump) {
    db.prepare(
      "INSERT OR REPLACE INTO _edit_meta (key, value) VALUES ('schema_version', ?)",
    ).run(String(SCHEMA_VERSION));
  }
};

module.exports = { applySchema, SCHEMA_VERSION, PROJECT_MAGIC };
