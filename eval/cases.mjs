/**
 * eval/cases.mjs — golden repair cases for the AI companion.
 *
 * Each case seeds a tiny broken feed, asks the assistant the question a
 * real operator would ask, and measures the EFFECT of the generated SQL:
 * `violating(db)` counts the bad rows before and after execution. A case
 * passes when the count drops to zero (or `expectAtMost`) without
 * collateral damage (`invariant(db)` must stay true).
 *
 * Keep cases REALISTIC and small — this harness measures repair accuracy,
 * not SQL trivia.
 */

// Minimal consistent graph most cases build upon.
export const seedBase = (db) => {
  db.exec(`
    INSERT INTO agency (agency_id, agency_name, agency_url, agency_timezone)
      VALUES ('A1', 'Metro City Transit', 'https://metro.example.com', 'Europe/Paris');
    INSERT INTO routes (route_id, agency_id, route_short_name, route_long_name, route_type)
      VALUES ('R1', 'A1', '12', 'Crosstown Express', '3');
    INSERT INTO stops (stop_id, stop_name, stop_lat, stop_lon)
      VALUES ('S1', 'Central Station', 48.85, 2.35),
             ('S2', 'Market Square', 48.86, 2.36);
    INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
      VALUES ('WK', 1,1,1,1,1,0,0, '20260101', '20261231');
    INSERT INTO trips (trip_id, route_id, service_id) VALUES ('T1', 'R1', 'WK');
    INSERT INTO stop_times (trip_id, stop_id, stop_sequence, arrival_time, departure_time)
      VALUES ('T1', 'S1', 1, '08:00:00', '08:00:00'),
             ('T1', 'S2', 2, '08:10:00', '08:10:00');
  `);
};

const count = (db, sql) => db.prepare(sql).get().c;

export const CASES = [
  {
    id: "invalid_url_scheme",
    rule: "invalid_url",
    question:
      "Fix the invalid_url errors: several stop_url values are missing the https:// scheme.",
    seed: (db) => {
      db.exec(`
        UPDATE stops SET stop_url = 'www.metro.example.com/s1' WHERE stop_id = 'S1';
        UPDATE stops SET stop_url = 'metro.example.com/s2' WHERE stop_id = 'S2';
      `);
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM stops WHERE stop_url IS NOT NULL AND stop_url != '' AND stop_url NOT LIKE '%://%'",
      ),
    invariant: (db) => count(db, "SELECT COUNT(*) c FROM stops") === 2,
  },
  {
    id: "invalid_color_format",
    rule: "invalid_color",
    question:
      "Fix the invalid_color findings on routes: colors must be 6 uppercase hex digits without a leading #.",
    seed: (db) => {
      db.exec(
        "UPDATE routes SET route_color = '#ff0000', route_text_color = 'ffffff' WHERE route_id = 'R1';",
      );
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM routes WHERE (route_color IS NOT NULL AND route_color != '' AND (route_color LIKE '#%' OR route_color != UPPER(route_color)))",
      ),
    invariant: (db) => count(db, "SELECT COUNT(*) c FROM routes") === 1,
  },
  {
    id: "reversed_service_dates",
    rule: "start_and_end_range_out_of_order",
    question:
      "The validator reports start_and_end_range_out_of_order on calendar: some services have start_date after end_date. Fix them.",
    seed: (db) => {
      db.exec(`
        INSERT INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date)
          VALUES ('BAD', 1,1,1,1,1,1,1, '20261231', '20260101');
      `);
    },
    violating: (db) =>
      count(db, "SELECT COUNT(*) c FROM calendar WHERE start_date > end_date"),
    invariant: (db) => count(db, "SELECT COUNT(*) c FROM calendar") === 2,
  },
  {
    id: "timezone_casing",
    rule: "invalid_timezone",
    question:
      "agency_timezone has invalid casing ('europe/paris'). Normalize it to the valid IANA form.",
    seed: (db) => {
      db.exec(
        "UPDATE agency SET agency_timezone = 'europe/paris' WHERE agency_id = 'A1';",
      );
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM agency WHERE agency_timezone != 'Europe/Paris'",
      ),
    invariant: (db) => count(db, "SELECT COUNT(*) c FROM agency") === 1,
  },
  {
    id: "orphan_stop_times",
    rule: "foreign_key_violation",
    question:
      "There are stop_times rows referencing trips that do not exist (foreign_key_violation). Remove these orphan rows.",
    seed: (db) => {
      db.exec(`
        INSERT INTO stop_times (trip_id, stop_id, stop_sequence) VALUES
          ('GHOST', 'S1', 1), ('GHOST', 'S2', 2);
      `);
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM stop_times WHERE trip_id NOT IN (SELECT trip_id FROM trips)",
      ),
    invariant: (db) =>
      count(db, "SELECT COUNT(*) c FROM stop_times WHERE trip_id = 'T1'") === 2,
  },
  {
    id: "whitespace_stop_names",
    rule: "leading_or_trailing_whitespaces",
    question:
      "Several stop_name values have leading or trailing whitespace. Trim them.",
    seed: (db) => {
      db.exec(`
        UPDATE stops SET stop_name = '  Central Station ' WHERE stop_id = 'S1';
        UPDATE stops SET stop_name = 'Market Square  ' WHERE stop_id = 'S2';
      `);
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM stops WHERE stop_name != TRIM(stop_name)",
      ),
    invariant: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM stops WHERE TRIM(stop_name) IN ('Central Station','Market Square')",
      ) === 2,
  },
  {
    id: "short_name_too_long",
    rule: "route_short_name_too_long",
    question:
      "route_short_name_too_long: some route_short_name values exceed 12 characters. Truncate them to the first 12 characters.",
    seed: (db) => {
      db.exec(`
        INSERT INTO routes (route_id, agency_id, route_short_name, route_type)
          VALUES ('R2', 'A1', 'SUPERLONGROUTENAME99', '3');
      `);
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM routes WHERE LENGTH(route_short_name) > 12",
      ),
    invariant: (db) => count(db, "SELECT COUNT(*) c FROM routes") === 2,
  },
  {
    id: "duplicate_desc",
    rule: "same_name_and_description_for_route",
    question:
      "same_name_and_description_for_route: route_desc duplicates route_long_name. Clear the redundant descriptions.",
    seed: (db) => {
      db.exec(
        "UPDATE routes SET route_desc = 'Crosstown Express' WHERE route_id = 'R1';",
      );
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM routes WHERE route_desc IS NOT NULL AND route_desc = route_long_name",
      ),
    invariant: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM routes WHERE route_long_name = 'Crosstown Express'",
      ) === 1,
  },
  {
    id: "bikes_allowed_range",
    rule: "number_out_of_range",
    question:
      "number_out_of_range: trips.bikes_allowed has values outside 0-2. Reset the invalid ones to 0 (no information).",
    seed: (db) => {
      db.exec("UPDATE trips SET bikes_allowed = '7' WHERE trip_id = 'T1';");
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM trips WHERE bikes_allowed IS NOT NULL AND bikes_allowed != '' AND bikes_allowed NOT IN ('0','1','2')",
      ),
    invariant: (db) => count(db, "SELECT COUNT(*) c FROM trips") === 1,
  },
  {
    id: "stop_url_equals_agency",
    rule: "same_stop_and_agency_url",
    question:
      "same_stop_and_agency_url: some stops reuse the agency_url as their stop_url. Clear those stop_url values.",
    seed: (db) => {
      db.exec(
        "UPDATE stops SET stop_url = 'https://metro.example.com' WHERE stop_id = 'S1';",
      );
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM stops WHERE stop_url IN (SELECT agency_url FROM agency)",
      ),
    invariant: (db) => count(db, "SELECT COUNT(*) c FROM stops") === 2,
  },
  {
    id: "orphan_trips_service",
    rule: "foreign_key_violation",
    question:
      "Some trips reference a service_id that exists neither in calendar nor calendar_dates. Delete these orphan trips and their stop_times.",
    seed: (db) => {
      db.exec(`
        INSERT INTO trips (trip_id, route_id, service_id) VALUES ('TBAD', 'R1', 'NOSVC');
        INSERT INTO stop_times (trip_id, stop_id, stop_sequence) VALUES ('TBAD', 'S1', 1);
      `);
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM trips WHERE service_id NOT IN (SELECT service_id FROM calendar) AND service_id NOT IN (SELECT service_id FROM calendar_dates)",
      ),
    invariant: (db) =>
      count(db, "SELECT COUNT(*) c FROM trips WHERE trip_id = 'T1'") === 1,
  },
  {
    id: "empty_wheelchair_boarding",
    rule: "missing_recommended_field",
    question:
      "Set wheelchair_boarding to '0' (unknown) on every stop where it is NULL or empty.",
    seed: (db) => {
      // Base stops already have NULL wheelchair_boarding.
    },
    violating: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM stops WHERE wheelchair_boarding IS NULL OR wheelchair_boarding = ''",
      ),
    invariant: (db) => count(db, "SELECT COUNT(*) c FROM stops") === 2,
  },
  {
    id: "negative_sequence",
    rule: "invalid_field_value",
    question:
      "One stop_times row has stop_sequence = -1 which is invalid; it should be 1 (it is the first stop of trip T1bis). Fix it.",
    seed: (db) => {
      db.exec(`
        INSERT INTO trips (trip_id, route_id, service_id) VALUES ('T1bis', 'R1', 'WK');
        INSERT INTO stop_times (trip_id, stop_id, stop_sequence) VALUES ('T1bis', 'S1', -1);
      `);
    },
    violating: (db) =>
      count(db, "SELECT COUNT(*) c FROM stop_times WHERE stop_sequence < 0"),
    invariant: (db) =>
      count(
        db,
        "SELECT COUNT(*) c FROM stop_times WHERE trip_id = 'T1bis' AND stop_sequence = 1",
      ) === 1,
  },
];
