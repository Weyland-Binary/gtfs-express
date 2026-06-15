import TableViewIcon from "@mui/icons-material/TableView";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import AccessibleIcon from "@mui/icons-material/Accessible";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import SchemaIcon from "@mui/icons-material/Schema";
import EditNoteIcon from "@mui/icons-material/EditNote";

// Files surfaced as the top "Browse files" chip strip, organised in
// sections so the core GTFS Schedule stays compact and the v11/v12
// extension tables (Fares v2, Flex, Booking) get their own row that
// can be hidden when the session DB has none of them populated.
//
// `BROWSE_GROUPS` is the source of truth. `BROWSE_FILES` keeps the
// flat list export for callers that still iterate every browseable
// table (e.g. keyboard shortcuts, schema panel sorting).
export const BROWSE_GROUPS = [
  {
    id: "schedule",
    labelKey: "sqlConsole.browseGroup.schedule",
    files: [
      { table: "agency", entity: "agency" },
      { table: "routes", entity: "route" },
      { table: "stops", entity: "stop" },
      { table: "trips", entity: "trip" },
      { table: "stop_times", entity: "stop_time" },
      { table: "calendar", entity: "calendar" },
      { table: "calendar_dates", entity: "calendar_date" },
      { table: "shapes", entity: "shape" },
      { table: "frequencies", entity: "frequency" },
      { table: "transfers", entity: "transfer" },
      { table: "pathways", entity: "pathway" },
      { table: "levels", entity: "level" },
      { table: "translations", entity: "translation" },
      { table: "feed_info", entity: "feed_info" },
      { table: "attributions", entity: "attribution" },
    ],
  },
  {
    id: "fares_v2",
    labelKey: "sqlConsole.browseGroup.faresV2",
    files: [
      { table: "areas", entity: "area" },
      { table: "stop_areas", entity: "stop_area" },
      { table: "networks", entity: "network" },
      { table: "route_networks", entity: "route_network" },
      { table: "fare_media", entity: "fare_media" },
      { table: "rider_categories", entity: "rider_category" },
      { table: "fare_products", entity: "fare_product" },
      { table: "timeframes", entity: "timeframe" },
      { table: "fare_leg_rules", entity: "fare_leg_rule" },
      { table: "fare_leg_join_rules", entity: "fare_leg_join_rule" },
      { table: "fare_transfer_rules", entity: "fare_transfer_rule" },
    ],
  },
  {
    id: "flex_drt",
    labelKey: "sqlConsole.browseGroup.flexDrt",
    files: [
      { table: "locations_geojson", entity: "location" },
      { table: "booking_rules", entity: "booking_rule" },
    ],
  },
];

export const BROWSE_FILES = BROWSE_GROUPS.flatMap((g) => g.files);

// First 9 files map to Ctrl+1..Ctrl+9 quick-jumps.
export const FILE_PRESET_SHORTCUTS = [
  "agency",
  "routes",
  "stops",
  "trips",
  "stop_times",
  "calendar",
  "shapes",
  "transfers",
  "frequencies",
];

// Built-in advanced presets — organised by group for the library menu.
export const PRESET_QUERIES = [
  {
    groupId: "network",
    groupLabelKey: "sqlConsole.presetGroup.network",
    items: [
      {
        id: "routes_trip_count",
        labelKey: "sqlConsole.preset.routesTripCount",
        sql:
          "SELECT r.route_id, r.route_short_name, r.route_long_name,\n" +
          "       COUNT(t.trip_id) AS trip_count\n" +
          "FROM routes r\n" +
          "LEFT JOIN trips t ON t.route_id = r.route_id\n" +
          "GROUP BY r.route_id\n" +
          "ORDER BY trip_count DESC\n" +
          "LIMIT 50;",
      },
      {
        id: "routes_per_agency",
        labelKey: "sqlConsole.preset.routesPerAgency",
        sql:
          "SELECT a.agency_id, a.agency_name,\n" +
          "       COUNT(r.route_id) AS route_count\n" +
          "FROM agency a\n" +
          "LEFT JOIN routes r ON r.agency_id = a.agency_id\n" +
          "GROUP BY a.agency_id\n" +
          "ORDER BY route_count DESC;",
      },
      {
        id: "agency_summary",
        labelKey: "sqlConsole.preset.agencySummary",
        sql:
          "SELECT a.agency_id, a.agency_name,\n" +
          "       COUNT(DISTINCT r.route_id) AS routes,\n" +
          "       COUNT(DISTINCT t.trip_id)  AS trips\n" +
          "FROM agency a\n" +
          "LEFT JOIN routes r ON r.agency_id = a.agency_id\n" +
          "LEFT JOIN trips  t ON t.route_id  = r.route_id\n" +
          "GROUP BY a.agency_id\n" +
          "ORDER BY trips DESC;",
      },
      {
        id: "route_service_hours",
        labelKey: "sqlConsole.preset.routeServiceHours",
        sql:
          "SELECT r.route_id, r.route_short_name,\n" +
          "       MIN(st.departure_time) AS first_departure,\n" +
          "       MAX(st.arrival_time)   AS last_arrival\n" +
          "FROM routes r\n" +
          "JOIN trips t       ON t.route_id  = r.route_id\n" +
          "JOIN stop_times st ON st.trip_id  = t.trip_id\n" +
          "GROUP BY r.route_id\n" +
          "ORDER BY first_departure;",
      },
      {
        id: "peak_hour_trips",
        labelKey: "sqlConsole.preset.peakHourTrips",
        sql:
          "SELECT SUBSTR(first_dep.dep, 1, 2) AS hour,\n" +
          "       COUNT(*) AS trips\n" +
          "FROM (\n" +
          "  SELECT t.trip_id,\n" +
          "         (SELECT departure_time FROM stop_times\n" +
          "          WHERE trip_id = t.trip_id ORDER BY stop_sequence LIMIT 1) AS dep\n" +
          "  FROM trips t\n" +
          ") first_dep\n" +
          "WHERE first_dep.dep IS NOT NULL\n" +
          "GROUP BY hour\n" +
          "ORDER BY hour;",
      },
      {
        id: "stops_per_route",
        labelKey: "sqlConsole.preset.stopsPerRoute",
        sql:
          "SELECT r.route_id, r.route_short_name,\n" +
          "       COUNT(DISTINCT st.stop_id) AS distinct_stops\n" +
          "FROM routes r\n" +
          "JOIN trips t       ON t.route_id = r.route_id\n" +
          "JOIN stop_times st ON st.trip_id = t.trip_id\n" +
          "GROUP BY r.route_id\n" +
          "ORDER BY distinct_stops DESC\n" +
          "LIMIT 50;",
      },
      {
        id: "stops_busiest",
        labelKey: "sqlConsole.preset.stopsBusiest",
        sql:
          "SELECT s.stop_id, s.stop_name,\n" +
          "       COUNT(st.trip_id) AS passages\n" +
          "FROM stops s\n" +
          "JOIN stop_times st ON st.stop_id = s.stop_id\n" +
          "GROUP BY s.stop_id\n" +
          "ORDER BY passages DESC\n" +
          "LIMIT 25;",
      },
      {
        id: "trips_longest",
        labelKey: "sqlConsole.preset.longestTrips",
        sql:
          "SELECT t.trip_id, t.route_id, t.trip_headsign, COUNT(st.stop_id) AS stops\n" +
          "FROM trips t\n" +
          "JOIN stop_times st ON st.trip_id = t.trip_id\n" +
          "GROUP BY t.trip_id\n" +
          "ORDER BY stops DESC\n" +
          "LIMIT 25;",
      },
      {
        id: "stop_times_first_last",
        labelKey: "sqlConsole.preset.stopTimesFirstLast",
        sql:
          "SELECT t.trip_id, t.route_id, t.trip_headsign,\n" +
          "       MIN(st.departure_time) AS first_departure,\n" +
          "       MAX(st.arrival_time)   AS last_arrival,\n" +
          "       COUNT(st.stop_id)      AS stops\n" +
          "FROM trips t\n" +
          "JOIN stop_times st ON st.trip_id = t.trip_id\n" +
          "GROUP BY t.trip_id\n" +
          "ORDER BY first_departure\n" +
          "LIMIT 50;",
      },
      {
        id: "services_active",
        labelKey: "sqlConsole.preset.activeServices",
        sql:
          "SELECT service_id, start_date, end_date,\n" +
          "  (monday + tuesday + wednesday + thursday + friday + saturday + sunday) AS days_per_week\n" +
          "FROM calendar\n" +
          "ORDER BY days_per_week DESC;",
      },
      {
        id: "calendar_exceptions",
        labelKey: "sqlConsole.preset.calendarExceptions",
        sql:
          "SELECT service_id, date, exception_type,\n" +
          "       CASE exception_type\n" +
          "         WHEN 1 THEN 'Added'\n" +
          "         WHEN 2 THEN 'Removed'\n" +
          "         ELSE '?'\n" +
          "       END AS type_label\n" +
          "FROM calendar_dates\n" +
          "ORDER BY date, service_id;",
      },
      {
        id: "route_type_summary",
        labelKey: "sqlConsole.preset.routeTypeSummary",
        sql:
          "SELECT route_type,\n" +
          "       CASE route_type\n" +
          "         WHEN 0  THEN 'Tram / Streetcar'\n" +
          "         WHEN 1  THEN 'Subway / Metro'\n" +
          "         WHEN 2  THEN 'Rail'\n" +
          "         WHEN 3  THEN 'Bus'\n" +
          "         WHEN 4  THEN 'Ferry'\n" +
          "         WHEN 5  THEN 'Cable tram'\n" +
          "         WHEN 6  THEN 'Aerial lift'\n" +
          "         WHEN 7  THEN 'Funicular'\n" +
          "         WHEN 11 THEN 'Trolleybus'\n" +
          "         WHEN 12 THEN 'Monorail'\n" +
          "         ELSE 'Extended (' || route_type || ')'\n" +
          "       END AS type_label,\n" +
          "       COUNT(*) AS route_count\n" +
          "FROM routes\n" +
          "GROUP BY route_type\n" +
          "ORDER BY route_count DESC;",
      },
      {
        id: "trips_per_weekday",
        labelKey: "sqlConsole.preset.tripsPerWeekday",
        sql:
          "SELECT 'Monday'    AS weekday, SUM(monday)    AS active_services FROM calendar\n" +
          "UNION ALL\n" +
          "SELECT 'Tuesday',               SUM(tuesday)   FROM calendar\n" +
          "UNION ALL\n" +
          "SELECT 'Wednesday',             SUM(wednesday) FROM calendar\n" +
          "UNION ALL\n" +
          "SELECT 'Thursday',              SUM(thursday)  FROM calendar\n" +
          "UNION ALL\n" +
          "SELECT 'Friday',                SUM(friday)    FROM calendar\n" +
          "UNION ALL\n" +
          "SELECT 'Saturday',              SUM(saturday)  FROM calendar\n" +
          "UNION ALL\n" +
          "SELECT 'Sunday',                SUM(sunday)    FROM calendar;",
      },
      {
        id: "frequencies_headways",
        labelKey: "sqlConsole.preset.frequenciesHeadways",
        sql:
          "SELECT f.trip_id, t.route_id, t.trip_headsign,\n" +
          "       f.start_time, f.end_time,\n" +
          "       f.headway_secs / 60 AS headway_min,\n" +
          "       CASE f.exact_times\n" +
          "         WHEN 1 THEN 'Exact'\n" +
          "         ELSE 'Frequency-based'\n" +
          "       END AS timing_type\n" +
          "FROM frequencies f\n" +
          "JOIN trips t ON t.trip_id = f.trip_id\n" +
          "ORDER BY headway_min, f.trip_id;",
      },
      {
        id: "trips_by_direction",
        labelKey: "sqlConsole.preset.tripsByDirection",
        sql:
          "SELECT r.route_id, r.route_short_name, r.route_long_name,\n" +
          "       t.direction_id,\n" +
          "       COUNT(t.trip_id) AS trip_count\n" +
          "FROM routes r\n" +
          "JOIN trips t ON t.route_id = r.route_id\n" +
          "GROUP BY r.route_id, t.direction_id\n" +
          "ORDER BY r.route_id, t.direction_id;",
      },
      {
        id: "network_kpi",
        labelKey: "sqlConsole.preset.networkKpi",
        sql:
          "-- One-row dashboard of every GTFS-required (and most optional) file.\n" +
          "-- Useful first query against any new feed: catches grossly empty tables\n" +
          "-- and mismatched expectations before drilling into the data.\n" +
          "SELECT\n" +
          "  (SELECT COUNT(*) FROM agency)                  AS agencies,\n" +
          "  (SELECT COUNT(*) FROM routes)                  AS routes,\n" +
          "  (SELECT COUNT(*) FROM trips)                   AS trips,\n" +
          "  (SELECT COUNT(*) FROM stops)                   AS stops,\n" +
          "  (SELECT COUNT(*) FROM stop_times)              AS stop_times,\n" +
          "  (SELECT COUNT(*) FROM calendar)                AS services,\n" +
          "  (SELECT COUNT(*) FROM calendar_dates)          AS service_exceptions,\n" +
          "  (SELECT COUNT(*) FROM frequencies)             AS frequency_entries,\n" +
          "  (SELECT COUNT(*) FROM transfers)               AS transfers,\n" +
          "  (SELECT COUNT(*) FROM pathways)                AS pathways,\n" +
          "  (SELECT COUNT(DISTINCT shape_id) FROM shapes)  AS distinct_shapes,\n" +
          "  (SELECT COUNT(*) FROM shapes)                  AS shape_points;",
      },
      {
        id: "interchange_stops",
        labelKey: "sqlConsole.preset.interchangeStops",
        sql:
          "-- Major transfer points: stops served by at least 3 distinct routes.\n" +
          "-- Useful for prioritising info displays / accessibility upgrades.\n" +
          "SELECT s.stop_id, s.stop_name,\n" +
          "       COUNT(DISTINCT t.route_id) AS routes_served\n" +
          "FROM stops s\n" +
          "JOIN stop_times st ON st.stop_id = s.stop_id\n" +
          "JOIN trips t       ON t.trip_id  = st.trip_id\n" +
          "GROUP BY s.stop_id\n" +
          "HAVING routes_served >= 3\n" +
          "ORDER BY routes_served DESC, s.stop_name\n" +
          "LIMIT 50;",
      },
      {
        id: "route_corridors",
        labelKey: "sqlConsole.preset.routeCorridors",
        sql:
          "-- Pairs of routes that share at least 10 stops (likely common corridor).\n" +
          "-- Pre-aggregating route x stop in a CTE keeps cost linear instead of\n" +
          "-- triggering a full self-join on stop_times.\n" +
          "WITH route_stops AS (\n" +
          "  SELECT DISTINCT t.route_id, st.stop_id\n" +
          "  FROM stop_times st\n" +
          "  JOIN trips t ON t.trip_id = st.trip_id\n" +
          ")\n" +
          "SELECT a.route_id AS route_a, b.route_id AS route_b,\n" +
          "       COUNT(*) AS shared_stops\n" +
          "FROM route_stops a\n" +
          "JOIN route_stops b ON a.stop_id = b.stop_id AND a.route_id < b.route_id\n" +
          "GROUP BY a.route_id, b.route_id\n" +
          "HAVING shared_stops >= 10\n" +
          "ORDER BY shared_stops DESC\n" +
          "LIMIT 50;",
      },
      {
        id: "terminus_stops",
        labelKey: "sqlConsole.preset.terminusStops",
        sql:
          "-- Network endpoints: distinct first/last stops aggregated per route.\n" +
          "-- High-occurrence rows for a given (route, position) are the canonical\n" +
          "-- terminus; lower-count rows often signal partial / short-turn trips.\n" +
          "WITH bounds AS (\n" +
          "  SELECT trip_id, MIN(stop_sequence) AS first_seq, MAX(stop_sequence) AS last_seq\n" +
          "  FROM stop_times GROUP BY trip_id\n" +
          "),\n" +
          "endpoints AS (\n" +
          "  SELECT t.route_id, st.stop_id, 'first' AS position\n" +
          "  FROM stop_times st\n" +
          "  JOIN bounds b ON b.trip_id = st.trip_id AND b.first_seq = st.stop_sequence\n" +
          "  JOIN trips  t ON t.trip_id  = st.trip_id\n" +
          "  UNION ALL\n" +
          "  SELECT t.route_id, st.stop_id, 'last'\n" +
          "  FROM stop_times st\n" +
          "  JOIN bounds b ON b.trip_id = st.trip_id AND b.last_seq = st.stop_sequence\n" +
          "  JOIN trips  t ON t.trip_id  = st.trip_id\n" +
          ")\n" +
          "SELECT e.route_id, e.position, e.stop_id, s.stop_name,\n" +
          "       COUNT(*) AS occurrences\n" +
          "FROM endpoints e\n" +
          "JOIN stops s ON s.stop_id = e.stop_id\n" +
          "GROUP BY e.route_id, e.position, e.stop_id\n" +
          "ORDER BY e.route_id, e.position, occurrences DESC;",
      },
      {
        id: "agency_revenue_metrics",
        labelKey: "sqlConsole.preset.agencyRevenueMetrics",
        sql:
          "-- Per-agency overview: routes, trips, and approximate revenue-hours\n" +
          "-- (sum of per-trip min(departure)..max(arrival) deltas — does not\n" +
          "-- multiply by service days; one trip = one revenue-hour count).\n" +
          "WITH trip_duration AS (\n" +
          "  SELECT t.trip_id, t.route_id,\n" +
          "    (CAST(SUBSTR(MAX(st.arrival_time), 1, 2) AS INTEGER) * 3600\n" +
          "    + CAST(SUBSTR(MAX(st.arrival_time), 4, 2) AS INTEGER) * 60\n" +
          "    + CAST(SUBSTR(MAX(st.arrival_time), 7, 2) AS INTEGER))\n" +
          "   - (CAST(SUBSTR(MIN(st.departure_time), 1, 2) AS INTEGER) * 3600\n" +
          "    + CAST(SUBSTR(MIN(st.departure_time), 4, 2) AS INTEGER) * 60\n" +
          "    + CAST(SUBSTR(MIN(st.departure_time), 7, 2) AS INTEGER)) AS duration_secs\n" +
          "  FROM trips t\n" +
          "  JOIN stop_times st ON st.trip_id = t.trip_id\n" +
          "  WHERE st.arrival_time IS NOT NULL AND st.departure_time IS NOT NULL\n" +
          "  GROUP BY t.trip_id\n" +
          ")\n" +
          "SELECT a.agency_id, a.agency_name,\n" +
          "       COUNT(DISTINCT r.route_id)  AS routes,\n" +
          "       COUNT(DISTINCT td.trip_id)  AS trips,\n" +
          "       ROUND(SUM(td.duration_secs) / 3600.0, 1) AS approx_revenue_hours\n" +
          "FROM agency a\n" +
          "LEFT JOIN routes r         ON r.agency_id  = a.agency_id\n" +
          "LEFT JOIN trip_duration td ON td.route_id  = r.route_id\n" +
          "GROUP BY a.agency_id\n" +
          "ORDER BY approx_revenue_hours DESC;",
      },
    ],
  },
  {
    groupId: "schedule",
    groupLabelKey: "sqlConsole.presetGroup.schedule",
    items: [
      {
        id: "trips_per_hour",
        labelKey: "sqlConsole.preset.tripsPerHour",
        sql:
          "SELECT SUBSTR(departure_time, 1, 2) AS hour,\n" +
          "       COUNT(DISTINCT trip_id) AS trips\n" +
          "FROM stop_times\n" +
          "WHERE departure_time IS NOT NULL\n" +
          "GROUP BY hour\n" +
          "ORDER BY hour;",
      },
      {
        id: "service_span_per_route",
        labelKey: "sqlConsole.preset.serviceSpanPerRoute",
        sql:
          "SELECT r.route_id, r.route_short_name,\n" +
          "       MIN(st.departure_time) AS first_dep,\n" +
          "       MAX(st.arrival_time)   AS last_arr,\n" +
          "       COUNT(DISTINCT t.trip_id) AS trips\n" +
          "FROM routes r\n" +
          "JOIN trips t       ON t.route_id = r.route_id\n" +
          "JOIN stop_times st ON st.trip_id = t.trip_id\n" +
          "GROUP BY r.route_id\n" +
          "ORDER BY trips DESC;",
      },
      {
        id: "headway_distribution",
        labelKey: "sqlConsole.preset.headwayDistribution",
        sql:
          "SELECT (headway_secs / 60) AS headway_min,\n" +
          "       COUNT(*) AS occurrences\n" +
          "FROM frequencies\n" +
          "WHERE headway_secs IS NOT NULL\n" +
          "GROUP BY headway_min\n" +
          "ORDER BY headway_min;",
      },
      {
        id: "longest_dwell",
        labelKey: "sqlConsole.preset.longestDwell",
        sql:
          "SELECT trip_id, stop_id, stop_sequence,\n" +
          "       arrival_time, departure_time,\n" +
          "       (CAST(SUBSTR(departure_time, 1, 2) AS INTEGER) * 3600\n" +
          "        + CAST(SUBSTR(departure_time, 4, 2) AS INTEGER) * 60\n" +
          "        + CAST(SUBSTR(departure_time, 7, 2) AS INTEGER))\n" +
          "     - (CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "        + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "        + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) AS dwell_seconds\n" +
          "FROM stop_times\n" +
          "WHERE arrival_time IS NOT NULL AND departure_time IS NOT NULL\n" +
          "  AND departure_time > arrival_time\n" +
          "ORDER BY dwell_seconds DESC\n" +
          "LIMIT 50;",
      },
      {
        id: "services_running_today",
        labelKey: "sqlConsole.preset.servicesRunningToday",
        sql:
          "SELECT service_id, start_date, end_date,\n" +
          "       monday, tuesday, wednesday, thursday, friday, saturday, sunday\n" +
          "FROM calendar\n" +
          "WHERE start_date <= strftime('%Y%m%d', 'now')\n" +
          "  AND end_date   >= strftime('%Y%m%d', 'now')\n" +
          "ORDER BY service_id;",
      },
      {
        id: "trips_starting_early",
        labelKey: "sqlConsole.preset.tripsStartingEarly",
        sql:
          "SELECT t.trip_id, t.route_id, t.trip_headsign,\n" +
          "       MIN(st.departure_time) AS first_dep\n" +
          "FROM trips t\n" +
          "JOIN stop_times st ON st.trip_id = t.trip_id\n" +
          "GROUP BY t.trip_id\n" +
          "HAVING first_dep < '05:00:00'\n" +
          "ORDER BY first_dep, t.trip_id;",
      },
      {
        id: "trips_ending_late",
        labelKey: "sqlConsole.preset.tripsEndingLate",
        sql:
          "SELECT t.trip_id, t.route_id, t.trip_headsign,\n" +
          "       MAX(st.arrival_time) AS last_arr\n" +
          "FROM trips t\n" +
          "JOIN stop_times st ON st.trip_id = t.trip_id\n" +
          "GROUP BY t.trip_id\n" +
          "HAVING last_arr >= '24:00:00'\n" +
          "ORDER BY last_arr DESC, t.trip_id;",
      },
      {
        id: "stop_arrivals_count",
        labelKey: "sqlConsole.preset.stopArrivalsCount",
        sql:
          "SELECT s.stop_id, s.stop_name,\n" +
          "       COUNT(*) AS arrivals\n" +
          "FROM stops s\n" +
          "JOIN stop_times st ON st.stop_id = s.stop_id\n" +
          "WHERE st.arrival_time IS NOT NULL\n" +
          "GROUP BY s.stop_id\n" +
          "ORDER BY arrivals DESC\n" +
          "LIMIT 50;",
      },
      {
        id: "route_avg_headway",
        labelKey: "sqlConsole.preset.routeAvgHeadway",
        sql:
          "-- Average headway (minutes) per route per hour, computed from successive\n" +
          "-- first-stop departures via LAG(). Hours with < 2 trips are dropped.\n" +
          "WITH first_dep AS (\n" +
          "  SELECT t.route_id, t.trip_id,\n" +
          "         (SELECT departure_time FROM stop_times\n" +
          "          WHERE trip_id = t.trip_id ORDER BY stop_sequence LIMIT 1) AS dep\n" +
          "  FROM trips t\n" +
          "),\n" +
          "ordered AS (\n" +
          "  SELECT route_id,\n" +
          "         (CAST(SUBSTR(dep, 1, 2) AS INTEGER) * 3600\n" +
          "        + CAST(SUBSTR(dep, 4, 2) AS INTEGER) * 60\n" +
          "        + CAST(SUBSTR(dep, 7, 2) AS INTEGER)) AS dep_secs,\n" +
          "         SUBSTR(dep, 1, 2) AS hour\n" +
          "  FROM first_dep\n" +
          "  WHERE dep IS NOT NULL\n" +
          "),\n" +
          "gaps AS (\n" +
          "  SELECT route_id, hour,\n" +
          "         dep_secs - LAG(dep_secs) OVER (PARTITION BY route_id ORDER BY dep_secs) AS gap_secs\n" +
          "  FROM ordered\n" +
          ")\n" +
          "SELECT route_id, hour,\n" +
          "       ROUND(AVG(gap_secs) / 60.0, 1) AS avg_headway_min,\n" +
          "       COUNT(*) AS samples\n" +
          "FROM gaps\n" +
          "WHERE gap_secs IS NOT NULL AND gap_secs > 0\n" +
          "GROUP BY route_id, hour\n" +
          "ORDER BY route_id, hour;",
      },
      {
        id: "route_speed",
        labelKey: "sqlConsole.preset.routeSpeed",
        sql:
          "-- Approximate commercial speed (km/h) per route: shape_dist_traveled\n" +
          "-- divided by trip duration. Assumes shape_dist is in metres (most common).\n" +
          "-- Trips without an associated shape carrying shape_dist are excluded.\n" +
          "WITH trip_metrics AS (\n" +
          "  SELECT t.route_id, t.trip_id, t.shape_id,\n" +
          "    (CAST(SUBSTR(MAX(st.arrival_time), 1, 2) AS INTEGER) * 3600\n" +
          "    + CAST(SUBSTR(MAX(st.arrival_time), 4, 2) AS INTEGER) * 60\n" +
          "    + CAST(SUBSTR(MAX(st.arrival_time), 7, 2) AS INTEGER))\n" +
          "   - (CAST(SUBSTR(MIN(st.departure_time), 1, 2) AS INTEGER) * 3600\n" +
          "    + CAST(SUBSTR(MIN(st.departure_time), 4, 2) AS INTEGER) * 60\n" +
          "    + CAST(SUBSTR(MIN(st.departure_time), 7, 2) AS INTEGER)) AS duration_secs\n" +
          "  FROM trips t\n" +
          "  JOIN stop_times st ON st.trip_id = t.trip_id\n" +
          "  WHERE st.arrival_time IS NOT NULL AND st.departure_time IS NOT NULL\n" +
          "  GROUP BY t.trip_id\n" +
          "),\n" +
          "shape_len AS (\n" +
          "  SELECT shape_id, MAX(shape_dist_traveled) AS dist_total\n" +
          "  FROM shapes\n" +
          "  WHERE shape_dist_traveled IS NOT NULL\n" +
          "  GROUP BY shape_id\n" +
          ")\n" +
          "SELECT tm.route_id,\n" +
          "       COUNT(*) AS trips_sampled,\n" +
          "       ROUND(AVG(sl.dist_total / NULLIF(tm.duration_secs, 0)) * 3.6, 2) AS avg_speed_kmh\n" +
          "FROM trip_metrics tm\n" +
          "JOIN shape_len sl ON sl.shape_id = tm.shape_id\n" +
          "WHERE tm.duration_secs > 0\n" +
          "GROUP BY tm.route_id\n" +
          "ORDER BY avg_speed_kmh DESC\n" +
          "LIMIT 50;",
      },
      {
        id: "peak_off_peak_compare",
        labelKey: "sqlConsole.preset.peakOffPeakCompare",
        sql:
          "-- Trips per route bucketed by AM peak (07-09), midday (12-14) and\n" +
          "-- PM peak (17-19). Imbalance points to coverage gaps; matching peak\n" +
          "-- counts is a sign of a high-frequency route running all day.\n" +
          "WITH first_dep AS (\n" +
          "  SELECT t.route_id, t.trip_id,\n" +
          "         CAST(SUBSTR(\n" +
          "           (SELECT departure_time FROM stop_times\n" +
          "            WHERE trip_id = t.trip_id ORDER BY stop_sequence LIMIT 1),\n" +
          "           1, 2) AS INTEGER) AS hour\n" +
          "  FROM trips t\n" +
          ")\n" +
          "SELECT route_id,\n" +
          "       SUM(CASE WHEN hour BETWEEN 7  AND 8  THEN 1 ELSE 0 END) AS am_peak,\n" +
          "       SUM(CASE WHEN hour BETWEEN 12 AND 13 THEN 1 ELSE 0 END) AS midday,\n" +
          "       SUM(CASE WHEN hour BETWEEN 17 AND 18 THEN 1 ELSE 0 END) AS pm_peak,\n" +
          "       COUNT(*) AS total_trips\n" +
          "FROM first_dep\n" +
          "WHERE hour IS NOT NULL\n" +
          "GROUP BY route_id\n" +
          "ORDER BY total_trips DESC;",
      },
    ],
  },
  {
    groupId: "accessibility",
    groupLabelKey: "sqlConsole.presetGroup.accessibility",
    items: [
      {
        id: "wheelchair_coverage_routes",
        labelKey: "sqlConsole.preset.wheelchairCoverageRoutes",
        sql:
          "SELECT r.route_id, r.route_short_name,\n" +
          "       SUM(CASE WHEN t.wheelchair_accessible = '1' THEN 1 ELSE 0 END) AS accessible,\n" +
          "       SUM(CASE WHEN t.wheelchair_accessible = '2' THEN 1 ELSE 0 END) AS not_accessible,\n" +
          "       SUM(CASE WHEN t.wheelchair_accessible IS NULL OR t.wheelchair_accessible = '' OR t.wheelchair_accessible = '0' THEN 1 ELSE 0 END) AS unknown\n" +
          "FROM routes r\n" +
          "JOIN trips t ON t.route_id = r.route_id\n" +
          "GROUP BY r.route_id\n" +
          "ORDER BY r.route_id;",
      },
      {
        id: "stops_wheelchair_status",
        labelKey: "sqlConsole.preset.stopsWheelchairStatus",
        sql:
          "SELECT wheelchair_boarding,\n" +
          "       CASE wheelchair_boarding\n" +
          "         WHEN '0' THEN 'No info / inherit'\n" +
          "         WHEN '1' THEN 'Accessible'\n" +
          "         WHEN '2' THEN 'Not accessible'\n" +
          "         ELSE COALESCE(wheelchair_boarding, '(NULL)')\n" +
          "       END AS label,\n" +
          "       COUNT(*) AS stops\n" +
          "FROM stops\n" +
          "GROUP BY wheelchair_boarding\n" +
          "ORDER BY stops DESC;",
      },
      {
        id: "trips_wheelchair_status",
        labelKey: "sqlConsole.preset.tripsWheelchairStatus",
        sql:
          "SELECT wheelchair_accessible,\n" +
          "       CASE wheelchair_accessible\n" +
          "         WHEN '0' THEN 'No info'\n" +
          "         WHEN '1' THEN 'Accessible'\n" +
          "         WHEN '2' THEN 'Not accessible'\n" +
          "         ELSE COALESCE(wheelchair_accessible, '(NULL)')\n" +
          "       END AS label,\n" +
          "       COUNT(*) AS trips\n" +
          "FROM trips\n" +
          "GROUP BY wheelchair_accessible\n" +
          "ORDER BY trips DESC;",
      },
      {
        id: "stations_without_children",
        labelKey: "sqlConsole.preset.stationsWithoutChildren",
        sql:
          "SELECT s.stop_id, s.stop_name\n" +
          "FROM stops s\n" +
          "LEFT JOIN stops c ON c.parent_station = s.stop_id\n" +
          "WHERE s.location_type = '1'\n" +
          "  AND c.stop_id IS NULL\n" +
          "ORDER BY s.stop_id;",
      },
      {
        id: "pathways_with_stairs",
        labelKey: "sqlConsole.preset.pathwaysWithStairs",
        sql:
          "SELECT pathway_id, from_stop_id, to_stop_id,\n" +
          "       pathway_mode, stair_count, max_slope\n" +
          "FROM pathways\n" +
          "WHERE stair_count IS NOT NULL AND stair_count > 0\n" +
          "ORDER BY stair_count DESC;",
      },
      {
        id: "pathways_unidirectional",
        labelKey: "sqlConsole.preset.pathwaysUnidirectional",
        sql:
          "SELECT pathway_id, from_stop_id, to_stop_id, pathway_mode\n" +
          "FROM pathways\n" +
          "WHERE is_bidirectional = 0\n" +
          "ORDER BY pathway_id;",
      },
      {
        id: "stops_access_forbidden",
        labelKey: "sqlConsole.preset.stopsAccessForbidden",
        sql:
          "SELECT stop_id, stop_name, location_type, parent_station, stop_access\n" +
          "FROM stops\n" +
          "WHERE stop_access IS NOT NULL AND stop_access != '' AND stop_access != '0'\n" +
          "ORDER BY stop_access, stop_id;",
      },
      {
        id: "accessibility_kpi_per_agency",
        labelKey: "sqlConsole.preset.accessibilityKpiPerAgency",
        sql:
          "-- Per-agency accessibility coverage: percentage of unique stops served\n" +
          "-- and trips marked wheelchair-accessible. NULL/empty/0 are treated as\n" +
          "-- 'no info' → not counted as accessible (matches GTFS spec semantics).\n" +
          "WITH agency_stop_access AS (\n" +
          "  SELECT DISTINCT a.agency_id, s.stop_id,\n" +
          "         CASE WHEN s.wheelchair_boarding = '1' THEN 1 ELSE 0 END AS accessible\n" +
          "  FROM agency a\n" +
          "  JOIN routes r      ON r.agency_id = a.agency_id\n" +
          "  JOIN trips t       ON t.route_id  = r.route_id\n" +
          "  JOIN stop_times st ON st.trip_id  = t.trip_id\n" +
          "  JOIN stops s       ON s.stop_id   = st.stop_id\n" +
          "),\n" +
          "stops_per_agency AS (\n" +
          "  SELECT agency_id,\n" +
          "         COUNT(*) AS stops,\n" +
          "         SUM(accessible) AS accessible_stops\n" +
          "  FROM agency_stop_access\n" +
          "  GROUP BY agency_id\n" +
          "),\n" +
          "trips_per_agency AS (\n" +
          "  SELECT a.agency_id,\n" +
          "         COUNT(*) AS trips,\n" +
          "         SUM(CASE WHEN t.wheelchair_accessible = '1' THEN 1 ELSE 0 END) AS accessible_trips\n" +
          "  FROM agency a\n" +
          "  JOIN routes r ON r.agency_id = a.agency_id\n" +
          "  JOIN trips t  ON t.route_id  = r.route_id\n" +
          "  GROUP BY a.agency_id\n" +
          ")\n" +
          "SELECT a.agency_id, a.agency_name,\n" +
          "       sp.stops, sp.accessible_stops,\n" +
          "       ROUND(100.0 * sp.accessible_stops / NULLIF(sp.stops, 0), 1) AS pct_stops,\n" +
          "       tp.trips, tp.accessible_trips,\n" +
          "       ROUND(100.0 * tp.accessible_trips / NULLIF(tp.trips, 0), 1) AS pct_trips\n" +
          "FROM agency a\n" +
          "LEFT JOIN stops_per_agency sp ON sp.agency_id = a.agency_id\n" +
          "LEFT JOIN trips_per_agency tp ON tp.agency_id = a.agency_id\n" +
          "ORDER BY pct_stops DESC;",
      },
      {
        id: "routes_fully_accessible",
        labelKey: "sqlConsole.preset.routesFullyAccessible",
        sql:
          "-- Routes where every single trip is marked wheelchair_accessible='1'.\n" +
          "-- A short list usually means the agency is granular about the field;\n" +
          "-- a long list often means the value was set as a default for everything.\n" +
          "SELECT r.route_id, r.route_short_name, r.route_long_name,\n" +
          "       COUNT(t.trip_id) AS trips\n" +
          "FROM routes r\n" +
          "JOIN trips t ON t.route_id = r.route_id\n" +
          "GROUP BY r.route_id\n" +
          "HAVING SUM(CASE WHEN t.wheelchair_accessible = '1' THEN 1 ELSE 0 END) = COUNT(*)\n" +
          "ORDER BY trips DESC;",
      },
      {
        id: "routes_zero_accessible",
        labelKey: "sqlConsole.preset.routesZeroAccessible",
        sql:
          "-- Routes where no trip carries wheelchair_accessible='1'. Worst-case\n" +
          "-- accessibility surface; usually means the field was never populated\n" +
          "-- rather than the service is genuinely inaccessible.\n" +
          "SELECT r.route_id, r.route_short_name, r.route_long_name,\n" +
          "       COUNT(t.trip_id) AS trips\n" +
          "FROM routes r\n" +
          "JOIN trips t ON t.route_id = r.route_id\n" +
          "GROUP BY r.route_id\n" +
          "HAVING SUM(CASE WHEN t.wheelchair_accessible = '1' THEN 1 ELSE 0 END) = 0\n" +
          "ORDER BY trips DESC;",
      },
      {
        id: "stations_no_pathways",
        labelKey: "sqlConsole.preset.stationsNoPathways",
        sql:
          "-- Stations (location_type=1) with zero pathways referencing any of\n" +
          "-- their members. For complex multi-level stations this means no\n" +
          "-- machine-readable wayfinding — accessibility apps cannot compute\n" +
          "-- accessible routes through them.\n" +
          "WITH station_members AS (\n" +
          "  SELECT s.stop_id AS station_id, s.stop_id AS member_id\n" +
          "  FROM stops s WHERE s.location_type = '1'\n" +
          "  UNION ALL\n" +
          "  SELECT s.stop_id, c.stop_id\n" +
          "  FROM stops s\n" +
          "  JOIN stops c ON c.parent_station = s.stop_id\n" +
          "  WHERE s.location_type = '1'\n" +
          "),\n" +
          "member_path_count AS (\n" +
          "  SELECT m.station_id, COUNT(DISTINCT p.pathway_id) AS pathways\n" +
          "  FROM station_members m\n" +
          "  LEFT JOIN pathways p\n" +
          "         ON p.from_stop_id = m.member_id\n" +
          "         OR p.to_stop_id   = m.member_id\n" +
          "  GROUP BY m.station_id\n" +
          ")\n" +
          "SELECT s.stop_id, s.stop_name,\n" +
          "       (SELECT COUNT(*) FROM stops c WHERE c.parent_station = s.stop_id) AS child_stops\n" +
          "FROM stops s\n" +
          "JOIN member_path_count mpc ON mpc.station_id = s.stop_id\n" +
          "WHERE mpc.pathways = 0\n" +
          "ORDER BY child_stops DESC, s.stop_id;",
      },
      {
        id: "elevators_spof",
        labelKey: "sqlConsole.preset.elevatorsSpof",
        sql:
          "-- Stations whose only accessible pathways are elevators (pathway_mode=5).\n" +
          "-- An elevator outage at such a station = total wheelchair lock-out from\n" +
          "-- the level. Top of the list = most safety-critical to monitor.\n" +
          "WITH station_members AS (\n" +
          "  SELECT c.stop_id AS member_id, c.parent_station AS station_id\n" +
          "  FROM stops c\n" +
          "  WHERE c.parent_station IS NOT NULL AND c.parent_station != ''\n" +
          "),\n" +
          "member_pathways AS (\n" +
          "  SELECT m.station_id, p.pathway_mode\n" +
          "  FROM station_members m\n" +
          "  JOIN pathways p\n" +
          "       ON p.from_stop_id = m.member_id\n" +
          "       OR p.to_stop_id   = m.member_id\n" +
          "),\n" +
          "station_path_summary AS (\n" +
          "  SELECT station_id,\n" +
          "         COUNT(*) AS total_paths,\n" +
          "         SUM(CASE WHEN pathway_mode = '5' THEN 1 ELSE 0 END) AS elevator_paths\n" +
          "  FROM member_pathways\n" +
          "  GROUP BY station_id\n" +
          ")\n" +
          "SELECT s.stop_id, s.stop_name,\n" +
          "       sps.total_paths, sps.elevator_paths\n" +
          "FROM station_path_summary sps\n" +
          "JOIN stops s ON s.stop_id = sps.station_id\n" +
          "WHERE sps.elevator_paths > 0\n" +
          "  AND sps.elevator_paths = sps.total_paths\n" +
          "ORDER BY sps.elevator_paths DESC, s.stop_name\n" +
          "LIMIT 50;",
      },
      {
        id: "stairs_without_elevator",
        labelKey: "sqlConsole.preset.stairsWithoutElevator",
        sql:
          "-- Stations that include stairs (pathway_mode=2) but no elevator (5)\n" +
          "-- alternative. Wheelchair users cannot navigate these — flag for\n" +
          "-- accessibility audit. Escalators (4) are NOT counted as wheelchair\n" +
          "-- alternatives per GTFS-Pathways guidance.\n" +
          "WITH station_members AS (\n" +
          "  SELECT c.stop_id AS member_id, c.parent_station AS station_id\n" +
          "  FROM stops c\n" +
          "  WHERE c.parent_station IS NOT NULL AND c.parent_station != ''\n" +
          "),\n" +
          "station_modes AS (\n" +
          "  SELECT m.station_id, p.pathway_mode\n" +
          "  FROM station_members m\n" +
          "  JOIN pathways p\n" +
          "       ON p.from_stop_id = m.member_id\n" +
          "       OR p.to_stop_id   = m.member_id\n" +
          "),\n" +
          "station_summary AS (\n" +
          "  SELECT station_id,\n" +
          "         SUM(CASE WHEN pathway_mode = '2' THEN 1 ELSE 0 END) AS stairs,\n" +
          "         SUM(CASE WHEN pathway_mode = '5' THEN 1 ELSE 0 END) AS elevators\n" +
          "  FROM station_modes\n" +
          "  GROUP BY station_id\n" +
          ")\n" +
          "SELECT s.stop_id, s.stop_name, ss.stairs, ss.elevators\n" +
          "FROM station_summary ss\n" +
          "JOIN stops s ON s.stop_id = ss.station_id\n" +
          "WHERE ss.stairs > 0 AND ss.elevators = 0\n" +
          "ORDER BY ss.stairs DESC\n" +
          "LIMIT 50;",
      },
      {
        id: "pathways_orphan_levels",
        labelKey: "sqlConsole.preset.pathwaysOrphanLevels",
        sql:
          "-- Pathways referencing a from/to stop whose level_id is missing from\n" +
          "-- levels.txt. Apps that compute accessible routes will fail to reason\n" +
          "-- about elevation changes for these pathways.\n" +
          "SELECT p.pathway_id, p.from_stop_id, p.to_stop_id, p.pathway_mode,\n" +
          "       sf.level_id AS from_level, st.level_id AS to_level\n" +
          "FROM pathways p\n" +
          "JOIN stops sf ON sf.stop_id = p.from_stop_id\n" +
          "JOIN stops st ON st.stop_id = p.to_stop_id\n" +
          "WHERE (\n" +
          "        (sf.level_id IS NOT NULL AND sf.level_id != ''\n" +
          "         AND sf.level_id NOT IN (SELECT level_id FROM levels))\n" +
          "     OR (st.level_id IS NOT NULL AND st.level_id != ''\n" +
          "         AND st.level_id NOT IN (SELECT level_id FROM levels))\n" +
          "      )\n" +
          "ORDER BY p.pathway_id;",
      },
      {
        id: "accessible_parent_inaccessible_children",
        labelKey: "sqlConsole.preset.accessibleParentInaccessibleChildren",
        sql:
          "-- Stations marked wheelchair-accessible at the parent level, but with\n" +
          "-- at least one child stop marked NOT accessible. Inconsistent — riders\n" +
          "-- relying on the station-level value will be misled when boarding from\n" +
          "-- those specific platforms.\n" +
          "SELECT p.stop_id   AS station_id,\n" +
          "       p.stop_name AS station_name,\n" +
          "       SUM(CASE WHEN c.wheelchair_boarding = '2' THEN 1 ELSE 0 END) AS not_accessible_children,\n" +
          "       SUM(CASE WHEN c.wheelchair_boarding = '1' THEN 1 ELSE 0 END) AS accessible_children,\n" +
          "       SUM(CASE WHEN c.wheelchair_boarding IS NULL\n" +
          "                  OR c.wheelchair_boarding = ''\n" +
          "                  OR c.wheelchair_boarding = '0' THEN 1 ELSE 0 END)  AS unknown_children\n" +
          "FROM stops p\n" +
          "JOIN stops c ON c.parent_station = p.stop_id\n" +
          "WHERE p.location_type = '1'\n" +
          "  AND p.wheelchair_boarding = '1'\n" +
          "GROUP BY p.stop_id\n" +
          "HAVING not_accessible_children > 0\n" +
          "ORDER BY not_accessible_children DESC;",
      },
    ],
  },
  {
    groupId: "quality",
    groupLabelKey: "sqlConsole.presetGroup.quality",
    items: [
      {
        id: "stops_orphans",
        labelKey: "sqlConsole.preset.orphanStops",
        sql:
          "-- Stops/platforms (location_type 0 or empty) never referenced by\n" +
          "-- stop_times. Stations (1), entrances (2), generic nodes (3) and\n" +
          "-- boarding areas (4) are excluded — they are not expected to\n" +
          "-- appear in stop_times by spec, see stations_without_children.\n" +
          "SELECT s.stop_id, s.stop_name, s.location_type\n" +
          "FROM stops s\n" +
          "LEFT JOIN stop_times st ON st.stop_id = s.stop_id\n" +
          "WHERE st.stop_id IS NULL\n" +
          "  AND (s.location_type IS NULL OR s.location_type = '' OR s.location_type = '0')\n" +
          "ORDER BY s.stop_id;",
      },
      {
        id: "routes_without_trips",
        labelKey: "sqlConsole.preset.routesWithoutTrips",
        sql:
          "SELECT r.route_id, r.route_short_name, r.route_long_name\n" +
          "FROM routes r\n" +
          "LEFT JOIN trips t ON t.route_id = r.route_id\n" +
          "WHERE t.trip_id IS NULL\n" +
          "ORDER BY r.route_id;",
      },
      {
        id: "trips_no_stop_times",
        labelKey: "sqlConsole.preset.tripsNoStopTimes",
        sql:
          "SELECT t.trip_id, t.route_id, t.trip_headsign\n" +
          "FROM trips t\n" +
          "LEFT JOIN stop_times st ON st.trip_id = t.trip_id\n" +
          "WHERE st.trip_id IS NULL\n" +
          "ORDER BY t.trip_id;",
      },
      {
        id: "trips_without_shape",
        labelKey: "sqlConsole.preset.tripsWithoutShape",
        sql:
          "SELECT trip_id, route_id, trip_headsign\n" +
          "FROM trips\n" +
          "WHERE shape_id IS NULL OR shape_id = ''\n" +
          "ORDER BY route_id, trip_id;",
      },
      {
        id: "shapes_without_trips",
        labelKey: "sqlConsole.preset.shapesWithoutTrips",
        sql:
          "SELECT DISTINCT s.shape_id\n" +
          "FROM shapes s\n" +
          "LEFT JOIN trips t ON t.shape_id = s.shape_id\n" +
          "WHERE t.trip_id IS NULL\n" +
          "ORDER BY s.shape_id;",
      },
      {
        id: "trips_invalid_service",
        labelKey: "sqlConsole.preset.tripsInvalidService",
        sql:
          "SELECT t.trip_id, t.route_id, t.service_id\n" +
          "FROM trips t\n" +
          "WHERE t.service_id NOT IN (SELECT service_id FROM calendar)\n" +
          "  AND t.service_id NOT IN (SELECT service_id FROM calendar_dates)\n" +
          "ORDER BY t.service_id, t.trip_id;",
      },
      {
        id: "stops_duplicate_coords",
        labelKey: "sqlConsole.preset.stopsDuplicateCoords",
        sql:
          "SELECT stop_lat, stop_lon,\n" +
          "       GROUP_CONCAT(stop_id, ', ') AS stop_ids,\n" +
          "       COUNT(*) AS cnt\n" +
          "FROM stops\n" +
          "WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL\n" +
          "GROUP BY stop_lat, stop_lon\n" +
          "HAVING cnt > 1\n" +
          "ORDER BY cnt DESC;",
      },
      {
        id: "duplicate_stop_names",
        labelKey: "sqlConsole.preset.duplicateStopNames",
        sql:
          "SELECT stop_name,\n" +
          "       GROUP_CONCAT(stop_id, ', ') AS stop_ids,\n" +
          "       COUNT(*) AS cnt\n" +
          "FROM stops\n" +
          "WHERE stop_name IS NOT NULL AND stop_name != ''\n" +
          "GROUP BY stop_name\n" +
          "HAVING cnt > 1\n" +
          "ORDER BY cnt DESC, stop_name;",
      },
      {
        id: "stops_without_zone",
        labelKey: "sqlConsole.preset.stopsWithoutZone",
        sql:
          "SELECT stop_id, stop_name\n" +
          "FROM stops\n" +
          "WHERE zone_id IS NULL OR zone_id = ''\n" +
          "ORDER BY stop_name;",
      },
      {
        id: "stops_without_wheelchair",
        labelKey: "sqlConsole.preset.stopsWithoutWheelchair",
        sql:
          "SELECT stop_id, stop_name, location_type\n" +
          "FROM stops\n" +
          "WHERE wheelchair_boarding IS NULL OR wheelchair_boarding = ''\n" +
          "ORDER BY stop_name;",
      },
      {
        id: "trips_without_headsign",
        labelKey: "sqlConsole.preset.tripsWithoutHeadsign",
        sql:
          "SELECT trip_id, route_id, service_id\n" +
          "FROM trips\n" +
          "WHERE trip_headsign IS NULL OR trip_headsign = '';",
      },
      {
        id: "routes_without_color",
        labelKey: "sqlConsole.preset.routesWithoutColor",
        sql:
          "SELECT route_id, route_short_name, route_long_name\n" +
          "FROM routes\n" +
          "WHERE route_color IS NULL OR route_color = '';",
      },
      {
        id: "trips_single_stop",
        labelKey: "sqlConsole.preset.tripsSingleStop",
        sql:
          "SELECT t.trip_id, t.route_id, t.trip_headsign,\n" +
          "       COUNT(st.stop_id) AS stop_count\n" +
          "FROM trips t\n" +
          "JOIN stop_times st ON st.trip_id = t.trip_id\n" +
          "GROUP BY t.trip_id\n" +
          "HAVING stop_count < 2\n" +
          "ORDER BY t.trip_id;",
      },
      {
        id: "routes_invalid_agency",
        labelKey: "sqlConsole.preset.routesInvalidAgency",
        sql:
          "-- Two failure modes:\n" +
          "--   (1) FK orphan: agency_id is set but doesn't exist in agency.txt\n" +
          "--   (2) Conditionally-required: agency_id NULL/empty when >= 2 agencies\n" +
          "SELECT r.route_id, r.route_short_name, r.agency_id,\n" +
          "       CASE\n" +
          "         WHEN r.agency_id IS NULL OR r.agency_id = '' THEN 'missing (required with >=2 agencies)'\n" +
          "         ELSE 'unknown agency_id'\n" +
          "       END AS issue\n" +
          "FROM routes r\n" +
          "LEFT JOIN agency a ON a.agency_id = r.agency_id\n" +
          "WHERE (\n" +
          "        -- (1) FK orphan\n" +
          "        (r.agency_id IS NOT NULL AND r.agency_id != '' AND a.agency_id IS NULL)\n" +
          "      )\n" +
          "   OR (\n" +
          "        -- (2) Conditionally required\n" +
          "        (r.agency_id IS NULL OR r.agency_id = '')\n" +
          "        AND (SELECT COUNT(*) FROM agency) > 1\n" +
          "      )\n" +
          "ORDER BY issue, r.route_id;",
      },
      {
        id: "stop_times_arrival_gt_departure",
        labelKey: "sqlConsole.preset.stopTimesArrivalGtDeparture",
        sql:
          "SELECT trip_id, stop_id, stop_sequence,\n" +
          "       arrival_time, departure_time\n" +
          "FROM stop_times\n" +
          "WHERE arrival_time IS NOT NULL\n" +
          "  AND departure_time IS NOT NULL\n" +
          "  AND arrival_time > departure_time\n" +
          "ORDER BY trip_id, stop_sequence\n" +
          "LIMIT 50;",
      },
      {
        id: "stops_invalid_parent",
        labelKey: "sqlConsole.preset.stopsInvalidParent",
        sql:
          "SELECT s.stop_id, s.stop_name,\n" +
          "       s.location_type, s.parent_station\n" +
          "FROM stops s\n" +
          "LEFT JOIN stops p ON p.stop_id = s.parent_station\n" +
          "WHERE s.parent_station IS NOT NULL\n" +
          "  AND s.parent_station != ''\n" +
          "  AND p.stop_id IS NULL\n" +
          "ORDER BY s.parent_station;",
      },
      {
        id: "stops_invalid_coordinates",
        labelKey: "sqlConsole.preset.stopsInvalidCoordinates",
        sql:
          "SELECT stop_id, stop_name, stop_lat, stop_lon\n" +
          "FROM stops\n" +
          "WHERE (stop_lat IS NOT NULL AND (stop_lat < -90 OR stop_lat > 90))\n" +
          "   OR (stop_lon IS NOT NULL AND (stop_lon < -180 OR stop_lon > 180))\n" +
          "ORDER BY stop_id;",
      },
      {
        id: "routes_color_invisible",
        labelKey: "sqlConsole.preset.routesColorInvisible",
        sql:
          "-- Compare effective colors after applying spec defaults:\n" +
          "--   route_color -> FFFFFF (white) if NULL/empty\n" +
          "--   route_text_color -> 000000 (black) if NULL/empty\n" +
          "-- Catches background==text in all 4 default/explicit combinations.\n" +
          "SELECT route_id, route_short_name,\n" +
          "       COALESCE(NULLIF(route_color, ''), 'FFFFFF') AS effective_color,\n" +
          "       COALESCE(NULLIF(route_text_color, ''), '000000') AS effective_text_color\n" +
          "FROM routes\n" +
          "WHERE LOWER(COALESCE(NULLIF(route_color, ''), 'FFFFFF'))\n" +
          "    = LOWER(COALESCE(NULLIF(route_text_color, ''), '000000'))\n" +
          "ORDER BY route_id;",
      },
      {
        id: "calendar_dead",
        labelKey: "sqlConsole.preset.calendarDead",
        sql:
          "SELECT service_id, start_date, end_date\n" +
          "FROM calendar\n" +
          "WHERE (monday + tuesday + wednesday + thursday + friday + saturday + sunday) = 0\n" +
          "ORDER BY service_id;",
      },
      {
        id: "calendar_invalid_window",
        labelKey: "sqlConsole.preset.calendarInvalidWindow",
        sql:
          "SELECT service_id, start_date, end_date\n" +
          "FROM calendar\n" +
          "WHERE start_date IS NOT NULL AND end_date IS NOT NULL\n" +
          "  AND start_date > end_date\n" +
          "ORDER BY service_id;",
      },
      {
        id: "frequencies_invalid_window",
        labelKey: "sqlConsole.preset.frequenciesInvalidWindow",
        sql:
          "SELECT trip_id, start_time, end_time, headway_secs\n" +
          "FROM frequencies\n" +
          "WHERE start_time IS NOT NULL AND end_time IS NOT NULL\n" +
          "  AND start_time >= end_time\n" +
          "ORDER BY trip_id;",
      },
      {
        id: "stop_times_null_times",
        labelKey: "sqlConsole.preset.stopTimesNullTimes",
        sql:
          "-- arrival_time/departure_time are Conditionally Required only on the FIRST\n" +
          "-- and LAST stop of a trip. Intermediate stops with NULL times are valid\n" +
          "-- per spec — interpolation is allowed. Restricting to bounds avoids 100s\n" +
          "-- of false positives on long trips.\n" +
          "WITH bounds AS (\n" +
          "  SELECT trip_id, MIN(stop_sequence) AS first_seq, MAX(stop_sequence) AS last_seq\n" +
          "  FROM stop_times\n" +
          "  GROUP BY trip_id\n" +
          ")\n" +
          "SELECT st.trip_id, st.stop_id, st.stop_sequence,\n" +
          "       CASE WHEN st.stop_sequence = b.first_seq THEN 'first'\n" +
          "            ELSE 'last' END AS position\n" +
          "FROM stop_times st\n" +
          "JOIN bounds b ON b.trip_id = st.trip_id\n" +
          "WHERE (st.arrival_time IS NULL OR st.arrival_time = '')\n" +
          "  AND (st.departure_time IS NULL OR st.departure_time = '')\n" +
          "  AND (st.stop_sequence = b.first_seq OR st.stop_sequence = b.last_seq)\n" +
          "ORDER BY st.trip_id, st.stop_sequence\n" +
          "LIMIT 50;",
      },
      {
        id: "stops_whitespace_names",
        labelKey: "sqlConsole.preset.stopsWhitespaceNames",
        sql:
          "SELECT stop_id, stop_name\n" +
          "FROM stops\n" +
          "WHERE stop_name IS NOT NULL\n" +
          "  AND stop_name != TRIM(stop_name)\n" +
          "ORDER BY stop_id;",
      },
      {
        id: "trips_orphan_shape",
        labelKey: "sqlConsole.preset.tripsOrphanShape",
        sql:
          "SELECT t.trip_id, t.route_id, t.shape_id\n" +
          "FROM trips t\n" +
          "LEFT JOIN (SELECT DISTINCT shape_id FROM shapes) s ON s.shape_id = t.shape_id\n" +
          "WHERE t.shape_id IS NOT NULL AND t.shape_id != ''\n" +
          "  AND s.shape_id IS NULL\n" +
          "ORDER BY t.shape_id, t.trip_id;",
      },
      {
        id: "stops_zero_coords",
        labelKey: "sqlConsole.preset.stopsZeroCoords",
        sql:
          "-- Catches the very common bug where stop_lat/stop_lon were set to 0\n" +
          "-- (default placeholder) instead of being left NULL or properly populated.\n" +
          "-- A real (0,0) coordinate is exceedingly rare (Gulf of Guinea, deep ocean).\n" +
          "SELECT stop_id, stop_name, stop_lat, stop_lon, location_type\n" +
          "FROM stops\n" +
          "WHERE stop_lat = 0 OR stop_lon = 0\n" +
          "ORDER BY stop_id;",
      },
      {
        id: "stop_times_non_monotonic_sequence",
        labelKey: "sqlConsole.preset.stopTimesNonMonotonicSequence",
        sql:
          "-- Per GTFS spec: stop_sequence MUST be unique within a trip.\n" +
          "-- Catches duplicate stop_sequence values (silent dataset corruption that\n" +
          "-- causes downstream tools to render stops in non-deterministic order).\n" +
          "SELECT trip_id, stop_sequence, COUNT(*) AS occurrences\n" +
          "FROM stop_times\n" +
          "GROUP BY trip_id, stop_sequence\n" +
          "HAVING COUNT(*) > 1\n" +
          "ORDER BY trip_id, stop_sequence\n" +
          "LIMIT 50;",
      },
      {
        id: "stop_times_non_monotonic_dist",
        labelKey: "sqlConsole.preset.stopTimesNonMonotonicDist",
        sql:
          "-- shape_dist_traveled MUST be non-decreasing along a trip (GTFS spec).\n" +
          "-- Catches rows where the distance regresses — usually indicates a swapped\n" +
          "-- stop_sequence or stale dist values not regenerated after a shape change.\n" +
          "WITH ordered AS (\n" +
          "  SELECT trip_id, stop_sequence, shape_dist_traveled,\n" +
          "         LAG(shape_dist_traveled) OVER (PARTITION BY trip_id ORDER BY stop_sequence) AS prev_dist\n" +
          "  FROM stop_times\n" +
          "  WHERE shape_dist_traveled IS NOT NULL\n" +
          ")\n" +
          "SELECT trip_id, stop_sequence, shape_dist_traveled, prev_dist\n" +
          "FROM ordered\n" +
          "WHERE prev_dist IS NOT NULL AND shape_dist_traveled < prev_dist\n" +
          "ORDER BY trip_id, stop_sequence\n" +
          "LIMIT 50;",
      },
      {
        id: "routes_long_eq_short",
        labelKey: "sqlConsole.preset.routesLongEqShort",
        sql:
          "-- GTFS best practice: route_short_name and route_long_name should differ.\n" +
          "-- MobilityData Canonical raises a WARNING for these rows. TRIM() catches\n" +
          "-- '12' vs ' 12 ' near-duplicates that look distinct but read identically.\n" +
          "SELECT route_id, route_short_name, route_long_name\n" +
          "FROM routes\n" +
          "WHERE route_short_name IS NOT NULL\n" +
          "  AND route_long_name  IS NOT NULL\n" +
          "  AND TRIM(route_short_name) = TRIM(route_long_name);",
      },
    ],
  },
  {
    groupId: "topology",
    groupLabelKey: "sqlConsole.presetGroup.topology",
    items: [
      {
        id: "calendar_wide_window",
        labelKey: "sqlConsole.preset.calendarWideWindow",
        sql:
          "SELECT service_id, start_date, end_date,\n" +
          "  (CAST(SUBSTR(end_date, 1, 4) AS INTEGER) -\n" +
          "   CAST(SUBSTR(start_date, 1, 4) AS INTEGER)) AS span_years\n" +
          "FROM calendar\n" +
          "WHERE span_years >= 1\n" +
          "ORDER BY span_years DESC;",
      },
      {
        id: "stop_sequence_gaps",
        labelKey: "sqlConsole.preset.stopSequenceGaps",
        sql:
          "SELECT a.trip_id,\n" +
          "       a.stop_sequence AS seq_a,\n" +
          "       b.stop_sequence AS seq_b,\n" +
          "       (b.stop_sequence - a.stop_sequence) AS gap\n" +
          "FROM stop_times a\n" +
          "JOIN stop_times b\n" +
          "  ON b.trip_id = a.trip_id\n" +
          "  AND b.stop_sequence = (\n" +
          "    SELECT MIN(c.stop_sequence)\n" +
          "    FROM stop_times c\n" +
          "    WHERE c.trip_id = a.trip_id\n" +
          "      AND c.stop_sequence > a.stop_sequence)\n" +
          "WHERE (b.stop_sequence - a.stop_sequence) > 1\n" +
          "ORDER BY gap DESC, a.trip_id\n" +
          "LIMIT 50;",
      },
      {
        id: "transfers_graph",
        labelKey: "sqlConsole.preset.transfersGraph",
        sql:
          "SELECT from_stop_id, to_stop_id, transfer_type,\n" +
          "       CASE transfer_type\n" +
          "         WHEN 0 THEN 'Recommended'\n" +
          "         WHEN 1 THEN 'Timed'\n" +
          "         WHEN 2 THEN 'Min time'\n" +
          "         WHEN 3 THEN 'Not possible'\n" +
          "         ELSE '?'\n" +
          "       END AS type_label,\n" +
          "       min_transfer_time\n" +
          "FROM transfers\n" +
          "ORDER BY transfer_type, from_stop_id;",
      },
      {
        id: "shapes_high_points",
        labelKey: "sqlConsole.preset.shapesHighPoints",
        sql:
          "SELECT shape_id, COUNT(*) AS pts\n" +
          "FROM shapes\n" +
          "GROUP BY shape_id\n" +
          "ORDER BY pts DESC\n" +
          "LIMIT 20;",
      },
      {
        id: "stops_station_hierarchy",
        labelKey: "sqlConsole.preset.stopsStationHierarchy",
        sql:
          "SELECT p.stop_id   AS station_id,\n" +
          "       p.stop_name AS station_name,\n" +
          "       s.stop_id   AS child_id,\n" +
          "       s.stop_name AS child_name,\n" +
          "       s.location_type\n" +
          "FROM stops p\n" +
          "JOIN stops s ON s.parent_station = p.stop_id\n" +
          "WHERE p.location_type = 1\n" +
          "ORDER BY p.stop_id, s.location_type, s.stop_id;",
      },
      {
        id: "pathways_completeness",
        labelKey: "sqlConsole.preset.pathwaysCompleteness",
        sql:
          "SELECT s.stop_id, s.stop_name,\n" +
          "       s.location_type,\n" +
          "       COUNT(p.pathway_id) AS pathway_count\n" +
          "FROM stops s\n" +
          "LEFT JOIN pathways p\n" +
          "       ON p.from_stop_id = s.stop_id\n" +
          "       OR p.to_stop_id   = s.stop_id\n" +
          "WHERE s.location_type IN (1, 2, 3, 4)\n" +
          "GROUP BY s.stop_id\n" +
          "ORDER BY pathway_count, s.stop_id;",
      },
      {
        id: "parent_station_chain",
        labelKey: "sqlConsole.preset.parentStationChain",
        sql:
          "SELECT s.stop_id, s.stop_name, s.parent_station,\n" +
          "       p.parent_station AS grandparent_station\n" +
          "FROM stops s\n" +
          "JOIN stops p ON p.stop_id = s.parent_station\n" +
          "WHERE p.parent_station IS NOT NULL AND p.parent_station != ''\n" +
          "ORDER BY s.stop_id;",
      },
      {
        id: "stations_with_parent_station",
        labelKey: "sqlConsole.preset.stationsWithParent",
        sql:
          "-- Stations (location_type=1) cannot have a parent_station — spec\n" +
          "-- forbidden. MobilityData Canonical raises an ERROR for these rows.\n" +
          "SELECT stop_id, stop_name, parent_station\n" +
          "FROM stops\n" +
          "WHERE location_type = '1'\n" +
          "  AND parent_station IS NOT NULL\n" +
          "  AND parent_station != ''\n" +
          "ORDER BY stop_id;",
      },
      {
        id: "stops_hierarchy_violation",
        labelKey: "sqlConsole.preset.stopsHierarchyViolation",
        sql:
          "-- Three hierarchy violations per GTFS spec:\n" +
          "--   1. location_type 2/3/4 (entrance/node/boarding-area) MUST have a parent_station\n" +
          "--   2. parent_station, when set, MUST point to a Station (location_type=1)\n" +
          "--   3. (cf. stations_with_parent_station preset for the location_type=1 + parent case)\n" +
          "SELECT s.stop_id, s.stop_name, s.location_type, s.parent_station,\n" +
          "       'missing-required-parent' AS violation\n" +
          "FROM stops s\n" +
          "WHERE s.location_type IN ('2', '3', '4')\n" +
          "  AND (s.parent_station IS NULL OR s.parent_station = '')\n" +
          "UNION ALL\n" +
          "SELECT s.stop_id, s.stop_name, s.location_type, s.parent_station,\n" +
          "       'parent-is-not-a-station' AS violation\n" +
          "FROM stops s\n" +
          "JOIN stops p ON p.stop_id = s.parent_station\n" +
          "WHERE p.location_type IS NOT NULL\n" +
          "  AND p.location_type != ''\n" +
          "  AND p.location_type != '1'\n" +
          "ORDER BY violation, stop_id;",
      },
      {
        id: "transfers_self_loop",
        labelKey: "sqlConsole.preset.transfersSelfLoop",
        sql:
          "-- Suspicious: from = to on stop-to-stop transfers. Excludes types 4/5\n" +
          "-- (in-seat continuation) where same-stop is legitimate (vehicle continues\n" +
          "-- on the same platform under a different trip_id).\n" +
          "SELECT id, from_stop_id, to_stop_id, transfer_type\n" +
          "FROM transfers\n" +
          "WHERE from_stop_id IS NOT NULL\n" +
          "  AND from_stop_id = to_stop_id\n" +
          "  AND (transfer_type IS NULL OR transfer_type NOT IN (4, 5))\n" +
          "ORDER BY id;",
      },
      {
        id: "pathways_self_loop",
        labelKey: "sqlConsole.preset.pathwaysSelfLoop",
        sql:
          "SELECT pathway_id, from_stop_id, to_stop_id, pathway_mode\n" +
          "FROM pathways\n" +
          "WHERE from_stop_id = to_stop_id\n" +
          "ORDER BY pathway_id;",
      },
      {
        id: "routes_per_network",
        labelKey: "sqlConsole.preset.routesPerNetwork",
        sql:
          "SELECT COALESCE(network_id, '(none)') AS network,\n" +
          "       COUNT(*) AS route_count\n" +
          "FROM routes\n" +
          "GROUP BY network_id\n" +
          "ORDER BY route_count DESC;",
      },
      {
        id: "network_bbox",
        labelKey: "sqlConsole.preset.networkBbox",
        sql:
          "-- Bounding box of every stop with valid coordinates plus the centroid.\n" +
          "-- Useful as a sanity check before producing maps — a single bad row can\n" +
          "-- inflate the bbox to whole-planet size and tank rendering performance.\n" +
          "SELECT\n" +
          "  MIN(stop_lat) AS min_lat,\n" +
          "  MAX(stop_lat) AS max_lat,\n" +
          "  MIN(stop_lon) AS min_lon,\n" +
          "  MAX(stop_lon) AS max_lon,\n" +
          "  ROUND(AVG(stop_lat), 6) AS center_lat,\n" +
          "  ROUND(AVG(stop_lon), 6) AS center_lon,\n" +
          "  COUNT(*) AS stops_with_coords\n" +
          "FROM stops\n" +
          "WHERE stop_lat IS NOT NULL AND stop_lon IS NOT NULL\n" +
          "  AND stop_lat BETWEEN -90  AND 90\n" +
          "  AND stop_lon BETWEEN -180 AND 180;",
      },
      {
        id: "routes_geographic_length",
        labelKey: "sqlConsole.preset.routesGeographicLength",
        sql:
          "-- Approximate geographic length of each route's longest shape, in km.\n" +
          "-- Uses MAX(shape_dist_traveled) when present. Assumes metres (most\n" +
          "-- common); divide by 1.609 if your feed encodes miles instead.\n" +
          "SELECT r.route_id, r.route_short_name, r.route_long_name,\n" +
          "       ROUND(MAX(s.shape_dist_traveled) / 1000.0, 2) AS approx_length_km\n" +
          "FROM routes r\n" +
          "JOIN trips t  ON t.route_id = r.route_id\n" +
          "JOIN shapes s ON s.shape_id = t.shape_id\n" +
          "WHERE s.shape_dist_traveled IS NOT NULL\n" +
          "GROUP BY r.route_id\n" +
          "ORDER BY approx_length_km DESC\n" +
          "LIMIT 50;",
      },
    ],
  },
  {
    groupId: "edit",
    groupLabelKey: "sqlConsole.presetGroup.edit",
    items: [
      {
        id: "trim_stop_names",
        labelKey: "sqlConsole.preset.trimStopNames",
        sql:
          "-- Trim leading/trailing whitespace from stop_name\n" +
          "UPDATE stops\n" +
          "SET stop_name = TRIM(stop_name)\n" +
          "WHERE stop_name IS NOT NULL\n" +
          "  AND stop_name != TRIM(stop_name);",
      },
      {
        id: "clear_empty_zones",
        labelKey: "sqlConsole.preset.clearEmptyZones",
        sql:
          "-- Replace empty-string zone_id by NULL (cleaner export)\n" +
          "UPDATE stops\n" +
          "SET zone_id = NULL\n" +
          "WHERE zone_id = '';",
      },
      {
        id: "set_default_wheelchair",
        labelKey: "sqlConsole.preset.setDefaultWheelchair",
        sql:
          "-- Set wheelchair_boarding = '0' (no info) for stops where it's NULL\n" +
          "UPDATE stops\n" +
          "SET wheelchair_boarding = '0'\n" +
          "WHERE wheelchair_boarding IS NULL OR wheelchair_boarding = '';",
      },
      {
        id: "fix_invalid_route_color",
        labelKey: "sqlConsole.preset.fixInvalidRouteColor",
        sql:
          "-- Clear route_color when it's not exactly 6 hex chars\n" +
          "UPDATE routes\n" +
          "SET route_color = NULL\n" +
          "WHERE route_color IS NOT NULL\n" +
          "  AND route_color != ''\n" +
          "  AND (LENGTH(route_color) != 6 OR route_color GLOB '*[!0-9A-Fa-f]*');",
      },
      {
        id: "round_shape_coords",
        labelKey: "sqlConsole.preset.roundShapeCoords",
        sql:
          "-- Round shape coordinates to 6 decimals (~10cm precision)\n" +
          "UPDATE shapes\n" +
          "SET shape_pt_lat = ROUND(shape_pt_lat, 6),\n" +
          "    shape_pt_lon = ROUND(shape_pt_lon, 6)\n" +
          "WHERE shape_pt_lat IS NOT NULL\n" +
          "  AND shape_pt_lon IS NOT NULL;",
      },
      {
        id: "delete_orphan_stops",
        labelKey: "sqlConsole.preset.deleteOrphanStops",
        sql:
          "-- Delete stops never referenced by stop_times (cascades nothing useful)\n" +
          "DELETE FROM stops\n" +
          "WHERE stop_id NOT IN (SELECT DISTINCT stop_id FROM stop_times WHERE stop_id IS NOT NULL)\n" +
          "  AND (location_type IS NULL OR location_type = '0' OR location_type = '');",
      },
      {
        id: "delete_shapes_without_trips",
        labelKey: "sqlConsole.preset.deleteShapesWithoutTrips",
        sql:
          "-- Delete shape points whose shape_id is not used by any trip\n" +
          "DELETE FROM shapes\n" +
          "WHERE shape_id NOT IN (\n" +
          "  SELECT DISTINCT shape_id FROM trips\n" +
          "  WHERE shape_id IS NOT NULL AND shape_id != ''\n" +
          ");",
      },
      {
        id: "update_route_color_template",
        labelKey: "sqlConsole.preset.updateRouteColorTemplate",
        sql:
          "-- Template: set the same color for all routes of an agency\n" +
          "-- Replace 'AGENCY_ID' and 'XXXXXX' before running\n" +
          "UPDATE routes\n" +
          "SET route_color = 'XXXXXX'\n" +
          "WHERE agency_id = 'AGENCY_ID';",
      },
      // ─── Schedule mass-edits ───────────────────────────────────────────
      {
        id: "shift_stop_times_template",
        labelKey: "sqlConsole.preset.shiftStopTimesTemplate",
        sql:
          "-- Template: shift stop_times by N seconds (positive or negative).\n" +
          "-- Replace OFFSET_SECS with the desired delta (e.g. 60 = +1 min, -300 = -5 min).\n" +
          "-- The 200 000-row pre-image cap is enforced per statement: large feeds\n" +
          "-- must batch by rowid. Run first:  SELECT MAX(rowid) FROM stop_times;\n" +
          "-- Then run successively with adjusted ranges (1..199999, 200000..399999, …).\n" +
          "UPDATE stop_times\n" +
          "SET arrival_time = printf('%02d:%02d:%02d',\n" +
          "      ((CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) / 3600,\n" +
          "      (((CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) / 60) % 60,\n" +
          "      ((CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) % 60),\n" +
          "    departure_time = printf('%02d:%02d:%02d',\n" +
          "      ((CAST(SUBSTR(departure_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(departure_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(departure_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) / 3600,\n" +
          "      (((CAST(SUBSTR(departure_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(departure_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(departure_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) / 60) % 60,\n" +
          "      ((CAST(SUBSTR(departure_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(departure_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(departure_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) % 60)\n" +
          "WHERE arrival_time IS NOT NULL\n" +
          "  AND departure_time IS NOT NULL\n" +
          "  AND rowid BETWEEN 1 AND 199999;",
      },
      {
        id: "shift_stop_times_by_route_template",
        labelKey: "sqlConsole.preset.shiftStopTimesByRouteTemplate",
        sql:
          "-- Template: shift stop_times by N seconds for ONE route only.\n" +
          "-- Replace ROUTE_ID and OFFSET_SECS before running.\n" +
          "-- Scoped per route → usually well under the 200 000-row cap.\n" +
          "UPDATE stop_times\n" +
          "SET arrival_time = printf('%02d:%02d:%02d',\n" +
          "      ((CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) / 3600,\n" +
          "      (((CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) / 60) % 60,\n" +
          "      ((CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) % 60),\n" +
          "    departure_time = printf('%02d:%02d:%02d',\n" +
          "      ((CAST(SUBSTR(departure_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(departure_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(departure_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) / 3600,\n" +
          "      (((CAST(SUBSTR(departure_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(departure_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(departure_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) / 60) % 60,\n" +
          "      ((CAST(SUBSTR(departure_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(departure_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(departure_time, 7, 2) AS INTEGER)) + (OFFSET_SECS)) % 60)\n" +
          "WHERE arrival_time IS NOT NULL\n" +
          "  AND departure_time IS NOT NULL\n" +
          "  AND trip_id IN (\n" +
          "    SELECT trip_id FROM trips WHERE route_id = 'ROUTE_ID'\n" +
          "  );",
      },
      {
        id: "truncate_stop_times_to_minute",
        labelKey: "sqlConsole.preset.truncateStopTimesToMinute",
        sql:
          "-- Round arrival_time/departure_time to whole minutes (HH:MM:00).\n" +
          "-- Useful when re-importing schedules whose seconds are noise.\n" +
          "-- Batch by rowid for feeds > 200 000 stop_times.\n" +
          "UPDATE stop_times\n" +
          "SET arrival_time   = SUBSTR(arrival_time,   1, 6) || '00',\n" +
          "    departure_time = SUBSTR(departure_time, 1, 6) || '00'\n" +
          "WHERE (\n" +
          "       (arrival_time   IS NOT NULL AND SUBSTR(arrival_time,   7, 2) != '00')\n" +
          "    OR (departure_time IS NOT NULL AND SUBSTR(departure_time, 7, 2) != '00')\n" +
          "  )\n" +
          "  AND rowid BETWEEN 1 AND 199999;",
      },
      {
        id: "ensure_min_dwell_template",
        labelKey: "sqlConsole.preset.ensureMinDwellTemplate",
        sql:
          "-- Template: ensure at least DWELL_SECS of dwell time at every stop\n" +
          "-- (departure_time = arrival_time + DWELL_SECS) when both fields are set.\n" +
          "-- Replace DWELL_SECS with desired minimum dwell (e.g. 20).\n" +
          "-- Batch by rowid for large feeds.\n" +
          "UPDATE stop_times\n" +
          "SET departure_time = printf('%02d:%02d:%02d',\n" +
          "      ((CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) + (DWELL_SECS)) / 3600,\n" +
          "      (((CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) + (DWELL_SECS)) / 60) % 60,\n" +
          "      ((CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "       + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "       + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER)) + (DWELL_SECS)) % 60)\n" +
          "WHERE arrival_time IS NOT NULL\n" +
          "  AND departure_time IS NOT NULL\n" +
          "  AND ((CAST(SUBSTR(departure_time, 1, 2) AS INTEGER) * 3600\n" +
          "        + CAST(SUBSTR(departure_time, 4, 2) AS INTEGER) * 60\n" +
          "        + CAST(SUBSTR(departure_time, 7, 2) AS INTEGER))\n" +
          "     - (CAST(SUBSTR(arrival_time, 1, 2) AS INTEGER) * 3600\n" +
          "        + CAST(SUBSTR(arrival_time, 4, 2) AS INTEGER) * 60\n" +
          "        + CAST(SUBSTR(arrival_time, 7, 2) AS INTEGER))) < (DWELL_SECS)\n" +
          "  AND rowid BETWEEN 1 AND 199999;",
      },
      {
        id: "clear_stop_times_shape_dist",
        labelKey: "sqlConsole.preset.clearStopTimesShapeDist",
        sql:
          "-- Wipe stop_times.shape_dist_traveled (regenerated downstream from shapes).\n" +
          "UPDATE stop_times\n" +
          "SET shape_dist_traveled = NULL\n" +
          "WHERE shape_dist_traveled IS NOT NULL\n" +
          "  AND rowid BETWEEN 1 AND 199999;",
      },
      {
        id: "extend_calendar_end_template",
        labelKey: "sqlConsole.preset.extendCalendarEndTemplate",
        sql:
          "-- Template: push calendar.end_date by N days (replace +30 below).\n" +
          "-- GTFS dates are YYYYMMDD: we re-format to ISO, shift, then strip dashes.\n" +
          "UPDATE calendar\n" +
          "SET end_date = strftime('%Y%m%d',\n" +
          "      SUBSTR(end_date, 1, 4) || '-' ||\n" +
          "      SUBSTR(end_date, 5, 2) || '-' ||\n" +
          "      SUBSTR(end_date, 7, 2),\n" +
          "      '+30 days')\n" +
          "WHERE end_date IS NOT NULL AND end_date != '';",
      },
      {
        id: "shrink_calendar_window_template",
        labelKey: "sqlConsole.preset.shrinkCalendarWindowTemplate",
        sql:
          "-- Template: clamp every calendar to the [BOUND_START, BOUND_END] window.\n" +
          "-- start_date is raised if too early, end_date is lowered if too late.\n" +
          "-- Replace BOUND_START / BOUND_END with YYYYMMDD literals.\n" +
          "UPDATE calendar\n" +
          "SET start_date = CASE WHEN start_date < 'BOUND_START' THEN 'BOUND_START' ELSE start_date END,\n" +
          "    end_date   = CASE WHEN end_date   > 'BOUND_END'   THEN 'BOUND_END'   ELSE end_date   END\n" +
          "WHERE start_date < 'BOUND_START' OR end_date > 'BOUND_END';",
      },
      {
        id: "bulk_add_calendar_exception_template",
        labelKey: "sqlConsole.preset.bulkAddCalendarExceptionTemplate",
        sql:
          "-- Template: mark a public holiday as removed (exception_type=2)\n" +
          "-- for every weekday calendar. Replace 'YYYYMMDD' with the holiday date.\n" +
          "INSERT INTO calendar_dates (service_id, date, exception_type)\n" +
          "SELECT service_id, 'YYYYMMDD', 2\n" +
          "FROM calendar\n" +
          "WHERE (monday + tuesday + wednesday + thursday + friday) > 0\n" +
          "  AND service_id NOT IN (\n" +
          "    SELECT service_id FROM calendar_dates WHERE date = 'YYYYMMDD'\n" +
          "  );",
      },
      {
        id: "round_frequency_headways",
        labelKey: "sqlConsole.preset.roundFrequencyHeadways",
        sql:
          "-- Round frequencies.headway_secs to the nearest 30 seconds.\n" +
          "-- Useful when GTFS-RT publishers expect aligned headways.\n" +
          "UPDATE frequencies\n" +
          "SET headway_secs = CAST(ROUND(headway_secs / 30.0) * 30 AS INTEGER)\n" +
          "WHERE headway_secs IS NOT NULL\n" +
          "  AND headway_secs % 30 != 0;",
      },
      // ─── Metadata mass-edits ──────────────────────────────────────────
      {
        id: "inherit_wheelchair_from_parent",
        labelKey: "sqlConsole.preset.inheritWheelchairFromParent",
        sql:
          "-- Copy parent_station's wheelchair_boarding into children stops\n" +
          "-- when the child is unset (NULL/empty/0) and the parent has a value.\n" +
          "UPDATE stops\n" +
          "SET wheelchair_boarding = (\n" +
          "  SELECT p.wheelchair_boarding FROM stops p WHERE p.stop_id = stops.parent_station\n" +
          ")\n" +
          "WHERE parent_station IS NOT NULL\n" +
          "  AND parent_station != ''\n" +
          "  AND (wheelchair_boarding IS NULL OR wheelchair_boarding = '' OR wheelchair_boarding = '0')\n" +
          "  AND EXISTS (\n" +
          "    SELECT 1 FROM stops p\n" +
          "    WHERE p.stop_id = stops.parent_station\n" +
          "      AND p.wheelchair_boarding IS NOT NULL\n" +
          "      AND p.wheelchair_boarding != ''\n" +
          "      AND p.wheelchair_boarding != '0'\n" +
          "  );",
      },
      {
        id: "inherit_zone_from_parent",
        labelKey: "sqlConsole.preset.inheritZoneFromParent",
        sql:
          "-- Inherit zone_id from parent station when the child has none.\n" +
          "UPDATE stops\n" +
          "SET zone_id = (\n" +
          "  SELECT p.zone_id FROM stops p WHERE p.stop_id = stops.parent_station\n" +
          ")\n" +
          "WHERE parent_station IS NOT NULL\n" +
          "  AND parent_station != ''\n" +
          "  AND (zone_id IS NULL OR zone_id = '')\n" +
          "  AND EXISTS (\n" +
          "    SELECT 1 FROM stops p\n" +
          "    WHERE p.stop_id = stops.parent_station\n" +
          "      AND p.zone_id IS NOT NULL\n" +
          "      AND p.zone_id != ''\n" +
          "  );",
      },
      {
        id: "normalize_urls_https",
        labelKey: "sqlConsole.preset.normalizeUrlsHttps",
        sql:
          "-- Force https:// on every stop_url, route_url and agency_url\n" +
          "-- starting with http://. Idempotent (LIKE 'http://%' filter).\n" +
          "UPDATE stops   SET stop_url   = 'https://' || SUBSTR(stop_url,   8) WHERE stop_url   LIKE 'http://%';\n" +
          "UPDATE routes  SET route_url  = 'https://' || SUBSTR(route_url,  8) WHERE route_url  LIKE 'http://%';\n" +
          "UPDATE agency  SET agency_url = 'https://' || SUBSTR(agency_url, 8) WHERE agency_url LIKE 'http://%';",
      },
      {
        id: "auto_pick_route_text_color",
        labelKey: "sqlConsole.preset.autoPickRouteTextColor",
        sql:
          "-- Auto-pick route_text_color (FFFFFF/000000) from route_color brightness.\n" +
          "-- Perceived brightness = (R*299 + G*587 + B*114) / 1000.\n" +
          "-- Threshold 128 → dark backgrounds get white text.\n" +
          "-- INSTR-based hex parsing avoids needing a SQL function.\n" +
          "UPDATE routes\n" +
          "SET route_text_color = CASE\n" +
          "  WHEN (\n" +
          "         ((INSTR('0123456789abcdef', LOWER(SUBSTR(route_color, 1, 1))) - 1) * 16\n" +
          "        +  (INSTR('0123456789abcdef', LOWER(SUBSTR(route_color, 2, 1))) - 1)) * 299\n" +
          "       + ((INSTR('0123456789abcdef', LOWER(SUBSTR(route_color, 3, 1))) - 1) * 16\n" +
          "        +  (INSTR('0123456789abcdef', LOWER(SUBSTR(route_color, 4, 1))) - 1)) * 587\n" +
          "       + ((INSTR('0123456789abcdef', LOWER(SUBSTR(route_color, 5, 1))) - 1) * 16\n" +
          "        +  (INSTR('0123456789abcdef', LOWER(SUBSTR(route_color, 6, 1))) - 1)) * 114\n" +
          "       ) >= 128000\n" +
          "  THEN '000000'\n" +
          "  ELSE 'FFFFFF'\n" +
          "END\n" +
          "WHERE route_color IS NOT NULL\n" +
          "  AND LENGTH(route_color) = 6\n" +
          "  AND route_color GLOB '[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]';",
      },
      {
        id: "set_bikes_allowed_by_route_type_template",
        labelKey: "sqlConsole.preset.setBikesAllowedByRouteTypeTemplate",
        sql:
          "-- Template: set bikes_allowed = 1 (allowed) on every trip whose route\n" +
          "-- has a given route_type. Replace ROUTE_TYPE_INT (e.g. 2 = Rail).\n" +
          "-- Values: 0 unknown / 1 allowed / 2 forbidden.\n" +
          "UPDATE trips\n" +
          "SET bikes_allowed = 1\n" +
          "WHERE route_id IN (\n" +
          "  SELECT route_id FROM routes WHERE route_type = ROUTE_TYPE_INT\n" +
          ")\n" +
          "  AND (bikes_allowed IS NULL OR bikes_allowed = '' OR bikes_allowed = '0');",
      },
      {
        id: "default_bidirectional_pathways",
        labelKey: "sqlConsole.preset.defaultBidirectionalPathways",
        sql:
          "-- Set is_bidirectional = 1 (bidirectional) where unset.\n" +
          "-- pathway_mode 1/2/3/4 (walkway/stairs/moving sidewalk/escalator) is\n" +
          "-- typically bidirectional; review elevators/doors before keeping.\n" +
          "UPDATE pathways\n" +
          "SET is_bidirectional = 1\n" +
          "WHERE is_bidirectional IS NULL OR is_bidirectional = '';",
      },
      // ─── Cleanup mass-edits ───────────────────────────────────────────
      {
        id: "empty_string_to_null_stops",
        labelKey: "sqlConsole.preset.emptyStringToNullStops",
        sql:
          "-- Replace '' by NULL on stops' optional fields. Cleaner round-trip\n" +
          "-- on export (the validator and downstream consumers prefer NULL\n" +
          "-- over the empty-string sentinel).\n" +
          "UPDATE stops\n" +
          "SET stop_code      = NULLIF(stop_code,      ''),\n" +
          "    stop_desc      = NULLIF(stop_desc,      ''),\n" +
          "    zone_id        = NULLIF(zone_id,        ''),\n" +
          "    stop_url       = NULLIF(stop_url,       ''),\n" +
          "    parent_station = NULLIF(parent_station, ''),\n" +
          "    stop_timezone  = NULLIF(stop_timezone,  ''),\n" +
          "    platform_code  = NULLIF(platform_code,  '')\n" +
          "WHERE stop_code = '' OR stop_desc = '' OR zone_id = ''\n" +
          "   OR stop_url = '' OR parent_station = '' OR stop_timezone = ''\n" +
          "   OR platform_code = '';",
      },
      {
        id: "delete_orphan_calendar_dates",
        labelKey: "sqlConsole.preset.deleteOrphanCalendarDates",
        sql:
          "-- Delete calendar_dates rows whose service_id is never used by any trip.\n" +
          "DELETE FROM calendar_dates\n" +
          "WHERE service_id NOT IN (\n" +
          "  SELECT DISTINCT service_id FROM trips WHERE service_id IS NOT NULL\n" +
          ");",
      },
      {
        id: "delete_trips_no_stop_times",
        labelKey: "sqlConsole.preset.deleteTripsNoStopTimes",
        sql:
          "-- Delete trips that have no stop_times (empty trips, often left\n" +
          "-- behind by partial imports). Cascades nothing since they're empty.\n" +
          "DELETE FROM trips\n" +
          "WHERE trip_id NOT IN (\n" +
          "  SELECT DISTINCT trip_id FROM stop_times WHERE trip_id IS NOT NULL\n" +
          ");",
      },
      {
        id: "clear_redundant_tts",
        labelKey: "sqlConsole.preset.clearRedundantTts",
        sql:
          "-- Remove tts_stop_name when it duplicates stop_name verbatim. The TTS\n" +
          "-- column is meant to override the visual name with a phonetic spelling;\n" +
          "-- copying the same value adds no value and pollutes the data.\n" +
          "UPDATE stops\n" +
          "SET tts_stop_name = NULL\n" +
          "WHERE tts_stop_name IS NOT NULL\n" +
          "  AND tts_stop_name = stop_name;",
      },
      {
        id: "reindex_route_sort_order",
        labelKey: "sqlConsole.preset.reindexRouteSortOrder",
        sql:
          "-- Renumber route_sort_order from 1 in current order (preserves the\n" +
          "-- relative ordering, just removes gaps). Useful after deleting routes\n" +
          "-- leaves holes in the sequence. NULL sort_orders are pushed to the end.\n" +
          "WITH ranked AS (\n" +
          "  SELECT route_id,\n" +
          "         ROW_NUMBER() OVER (\n" +
          "           ORDER BY COALESCE(route_sort_order, 999999), route_id\n" +
          "         ) AS new_order\n" +
          "  FROM routes\n" +
          ")\n" +
          "UPDATE routes\n" +
          "SET route_sort_order = (\n" +
          "  SELECT new_order FROM ranked WHERE ranked.route_id = routes.route_id\n" +
          ");",
      },
    ],
  },
];

// Icons for each preset group in the library panel.
export const GROUP_ICONS = {
  network: TableViewIcon,
  schedule: AccessTimeIcon,
  accessibility: AccessibleIcon,
  quality: WarningAmberIcon,
  topology: SchemaIcon,
  edit: EditNoteIcon,
};
