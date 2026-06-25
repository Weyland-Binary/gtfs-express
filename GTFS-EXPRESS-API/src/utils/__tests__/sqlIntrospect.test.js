/**
 * sqlIntrospect.test.js
 *
 * Unit tests for the sqlIntrospect utility.
 * Covers all tables in EDITABLE_TABLES, edge cases for non-editable queries,
 * composite PKs, case insensitivity, backtick quoting, subqueries, and more.
 */

"use strict";

const { inspectQuery, EDITABLE_TABLES } = require("../sqlIntrospect");

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function editable(result) {
  expect(result.isEditable).toBe(true);
}
function notEditable(result, reason) {
  expect(result.isEditable).toBe(false);
  if (reason) expect(result.reason).toBe(reason);
}

// ---------------------------------------------------------------------------
// 1. All editable tables with SELECT *
// ---------------------------------------------------------------------------
describe("SELECT * FROM <each editable table>", () => {
  const cases = [
    ["agency", "agency", "agency_id"],
    ["stops", "stop", "stop_id"],
    ["routes", "route", "route_id"],
    ["trips", "trip", "trip_id"],
    ["stop_times", "stop_time", ["trip_id", "stop_sequence"]],
    ["calendar", "calendar", "service_id"],
    ["calendar_dates", "calendar_date", ["service_id", "date"]],
    ["shapes", "shape", ["shape_id", "shape_pt_sequence"]],
    ["frequencies", "frequency", ["trip_id", "start_time"]],
    ["transfers", "transfer", "id"],
    ["levels", "level", "level_id"],
    ["pathways", "pathway", "pathway_id"],
    ["translations", "translation", "id"],
    ["feed_info", "feedInfo", null],
    ["attributions", "attribution", "rowid"],
  ];

  test.each(cases)("%s → editable with correct entity and pk", (table, entity, pk) => {
    const r = inspectQuery(`SELECT * FROM ${table}`);
    editable(r);
    expect(r.table).toBe(table);
    expect(r.entity).toBe(entity);
    expect(r.pk).toEqual(pk);
    // SELECT * → pkPresentInColumns should be true (except feed_info which has pk=null)
    if (pk !== null) {
      expect(r.pkPresentInColumns).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. PK present in explicit column list
// ---------------------------------------------------------------------------
describe("PK present in explicit column list", () => {
  test("SELECT stop_id, stop_name FROM stops → pkPresentInColumns: true", () => {
    const r = inspectQuery("SELECT stop_id, stop_name FROM stops");
    editable(r);
    expect(r.pkPresentInColumns).toBe(true);
  });

  test("SELECT route_id, route_short_name FROM routes → pkPresentInColumns: true", () => {
    const r = inspectQuery("SELECT route_id, route_short_name FROM routes");
    editable(r);
    expect(r.pkPresentInColumns).toBe(true);
  });

  test("SELECT trip_id, stop_sequence, arrival_time FROM stop_times → pkPresentInColumns: true (composite)", () => {
    const r = inspectQuery("SELECT trip_id, stop_sequence, arrival_time FROM stop_times");
    editable(r);
    expect(r.pkPresentInColumns).toBe(true);
  });

  test("SELECT service_id, date, exception_type FROM calendar_dates → pkPresentInColumns: true (composite)", () => {
    const r = inspectQuery("SELECT service_id, date, exception_type FROM calendar_dates");
    editable(r);
    expect(r.pkPresentInColumns).toBe(true);
  });

  test("SELECT shape_id, shape_pt_sequence, shape_pt_lat FROM shapes → pkPresentInColumns: true (composite)", () => {
    const r = inspectQuery("SELECT shape_id, shape_pt_sequence, shape_pt_lat FROM shapes");
    editable(r);
    expect(r.pkPresentInColumns).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. PK absent from explicit column list
// ---------------------------------------------------------------------------
describe("PK absent from explicit column list", () => {
  test("SELECT stop_name FROM stops → editable but pkPresentInColumns: false", () => {
    const r = inspectQuery("SELECT stop_name FROM stops");
    editable(r);
    expect(r.pkPresentInColumns).toBe(false);
  });

  test("SELECT route_short_name FROM routes → editable but pkPresentInColumns: false", () => {
    const r = inspectQuery("SELECT route_short_name FROM routes");
    editable(r);
    expect(r.pkPresentInColumns).toBe(false);
  });

  test("SELECT stop_sequence FROM stop_times → editable but pkPresentInColumns: false (missing trip_id)", () => {
    const r = inspectQuery("SELECT stop_sequence, arrival_time FROM stop_times");
    editable(r);
    expect(r.pkPresentInColumns).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. JOIN queries — single-target SELECT is editable, multi-target is not
// ---------------------------------------------------------------------------
describe("JOIN queries", () => {
  test("INNER JOIN with SELECT * → editable on primary table (pragmatic convention)", () => {
    const r = inspectQuery(
      "SELECT * FROM stops s JOIN stop_times st ON s.stop_id = st.stop_id",
    );
    editable(r);
    expect(r.table).toBe("stops");
    expect(r.pkPresentInColumns).toBe(true);
  });

  test("LEFT JOIN with SELECT * → editable on primary table", () => {
    const r = inspectQuery(
      "SELECT * FROM routes r LEFT JOIN trips t ON r.route_id = t.route_id",
    );
    editable(r);
    expect(r.table).toBe("routes");
  });

  test("LEFT JOIN orphan-rows pattern (only primary cols selected) → editable", () => {
    const r = inspectQuery(
      "SELECT s.stop_id, s.stop_name FROM stops s LEFT JOIN stop_times st ON st.stop_id = s.stop_id WHERE st.stop_id IS NULL ORDER BY s.stop_id",
    );
    editable(r);
    expect(r.table).toBe("stops");
    expect(r.pkPresentInColumns).toBe(true);
  });

  test("LEFT JOIN with bare unqualified cols → editable (assumed primary)", () => {
    const r = inspectQuery(
      "SELECT stop_id, stop_name FROM stops s LEFT JOIN stop_times st ON st.stop_id = s.stop_id",
    );
    editable(r);
    expect(r.table).toBe("stops");
  });

  test("INNER JOIN projecting cols from another alias → multi_target_select", () => {
    notEditable(
      inspectQuery(
        "SELECT s.stop_id, st.trip_id FROM stops s JOIN stop_times st ON s.stop_id = st.stop_id",
      ),
      "multi_target_select",
    );
  });

  test("CROSS JOIN with SELECT * → still editable on primary (no multi-target)", () => {
    const r = inspectQuery("SELECT * FROM stops CROSS JOIN routes");
    editable(r);
    expect(r.table).toBe("stops");
  });

  test("Implicit join via comma in FROM → multi_table_join (Cartesian product)", () => {
    notEditable(
      inspectQuery("SELECT * FROM stops, routes"),
      "multi_table_join",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Non-editable: aggregation
// ---------------------------------------------------------------------------
describe("Aggregation queries → aggregation", () => {
  test("COUNT(*) with LEFT JOIN → still aggregation (not editable)", () => {
    notEditable(
      inspectQuery(
        "SELECT COUNT(*) FROM stops s LEFT JOIN stop_times st ON st.stop_id = s.stop_id",
      ),
      "aggregation",
    );
  });

  test("COUNT(*)", () => {
    notEditable(inspectQuery("SELECT COUNT(*) FROM stops"), "aggregation");
  });

  test("SUM()", () => {
    notEditable(inspectQuery("SELECT SUM(shape_pt_sequence) FROM shapes"), "aggregation");
  });

  test("AVG()", () => {
    notEditable(inspectQuery("SELECT AVG(stop_lat) FROM stops"), "aggregation");
  });

  test("MIN()", () => {
    notEditable(inspectQuery("SELECT MIN(departure_time) FROM stop_times"), "aggregation");
  });

  test("MAX()", () => {
    notEditable(inspectQuery("SELECT MAX(departure_time) FROM stop_times"), "aggregation");
  });

  test("GROUP BY on non-PK column → aggregation_other_group_by", () => {
    // trips PK is trip_id; GROUP BY route_id is not the primary PK so the
    // relaxation does not apply.
    notEditable(
      inspectQuery("SELECT route_id, COUNT(*) FROM trips GROUP BY route_id"),
      "aggregation_other_group_by",
    );
  });
});

// ---------------------------------------------------------------------------
// 5b. Editable: GROUP BY on primary PK (relaxation)
// ---------------------------------------------------------------------------
describe("GROUP BY on primary PK → editable", () => {
  test("GROUP BY on primary PK with alias and LEFT JOIN", () => {
    const sql = `SELECT r.route_id, r.route_short_name, COUNT(t.trip_id) AS n
                 FROM routes r LEFT JOIN trips t ON t.route_id = r.route_id
                 GROUP BY r.route_id`;
    const r = inspectQuery(sql);
    expect(r.isEditable).toBe(true);
    expect(r.table).toBe("routes");
    expect(r.entity).toBe("route");
    expect(r.pk).toBe("route_id");
    expect(r.pkPresentInColumns).toBe(true);
    expect(r.reason).toBe("primary_pk_grouped");
  });

  test("GROUP BY on primary table (no alias)", () => {
    const r = inspectQuery("SELECT route_id, COUNT(*) FROM routes GROUP BY route_id");
    expect(r.isEditable).toBe(true);
    expect(r.table).toBe("routes");
    expect(r.pkPresentInColumns).toBe(true);
  });

  test("GROUP BY with table-qualified PK", () => {
    const r = inspectQuery(
      "SELECT routes.route_id, COUNT(*) FROM routes GROUP BY routes.route_id",
    );
    expect(r.isEditable).toBe(true);
    expect(r.table).toBe("routes");
  });

  test("not editable: GROUP BY on non-PK column", () => {
    const r = inspectQuery(
      "SELECT route_short_name, COUNT(*) FROM routes GROUP BY route_short_name",
    );
    expect(r.isEditable).toBe(false);
    expect(r.reason).toBe("aggregation_other_group_by");
  });

  test("not editable: GROUP BY with HAVING", () => {
    const sql = `SELECT r.route_id, COUNT(t.trip_id) AS n
                 FROM routes r LEFT JOIN trips t ON t.route_id = r.route_id
                 GROUP BY r.route_id HAVING n > 5`;
    const r = inspectQuery(sql);
    expect(r.isEditable).toBe(false);
    expect(r.reason).toBe("aggregation_with_having");
  });

  test("not editable: GROUP BY with multiple columns", () => {
    const r = inspectQuery(
      "SELECT route_type, agency_id, COUNT(*) FROM routes GROUP BY route_type, agency_id",
    );
    expect(r.isEditable).toBe(false);
    expect(r.reason).toBe("aggregation_multi_group_by");
  });

  test("not editable: composite PK table with GROUP BY on one PK column", () => {
    // stop_times PK is composite (trip_id, stop_sequence) — relaxation doesn't apply
    const r = inspectQuery("SELECT trip_id, COUNT(*) FROM stop_times GROUP BY trip_id");
    expect(r.isEditable).toBe(false);
    expect(r.reason).toBe("aggregation_composite_pk");
  });
});

// ---------------------------------------------------------------------------
// 6. Non-editable: unknown table
// ---------------------------------------------------------------------------
describe("Unknown / internal tables → unknown_table", () => {
  test("SELECT * FROM unknown_table", () => {
    notEditable(inspectQuery("SELECT * FROM unknown_table"), "unknown_table");
  });

  test("SELECT * FROM _edit_log", () => {
    notEditable(inspectQuery("SELECT * FROM _edit_log"), "unknown_table");
  });

  test("SELECT * FROM _edit_meta", () => {
    notEditable(inspectQuery("SELECT * FROM _edit_meta"), "unknown_table");
  });

  test("SELECT * FROM _project_meta", () => {
    notEditable(inspectQuery("SELECT * FROM _project_meta"), "unknown_table");
  });

  test("SELECT * FROM fare_attributes", () => {
    notEditable(inspectQuery("SELECT * FROM fare_attributes"), "unknown_table");
  });
});

// ---------------------------------------------------------------------------
// 7. Non-editable: non-SELECT statements
// ---------------------------------------------------------------------------
describe("Non-SELECT statements → non_select", () => {
  test("INSERT", () => {
    notEditable(
      inspectQuery("INSERT INTO stops (stop_id) VALUES ('S1')"),
      "non_select",
    );
  });

  test("UPDATE", () => {
    notEditable(
      inspectQuery("UPDATE stops SET stop_name = 'X' WHERE stop_id = 'S1'"),
      "non_select",
    );
  });

  test("DELETE", () => {
    notEditable(
      inspectQuery("DELETE FROM stops WHERE stop_id = 'S1'"),
      "non_select",
    );
  });

  test("DROP", () => {
    notEditable(inspectQuery("DROP TABLE stops"), "non_select");
  });

  test("PRAGMA write", () => {
    notEditable(inspectQuery("PRAGMA foreign_keys = ON"), "non_select");
  });
});

// ---------------------------------------------------------------------------
// 8. Non-editable: subquery in FROM
// ---------------------------------------------------------------------------
describe("Subquery in FROM → subquery_select", () => {
  test("SELECT * FROM (SELECT * FROM stops)", () => {
    notEditable(
      inspectQuery("SELECT * FROM (SELECT * FROM stops)"),
      "subquery_select",
    );
  });

  test("SELECT * FROM (SELECT stop_id FROM stops) AS sub", () => {
    notEditable(
      inspectQuery("SELECT * FROM (SELECT stop_id FROM stops) AS sub"),
      "subquery_select",
    );
  });
});

// ---------------------------------------------------------------------------
// 9. Subquery in WHERE is OK (still editable)
// ---------------------------------------------------------------------------
describe("Subquery in WHERE → still editable", () => {
  test("SELECT * FROM stops WHERE stop_id IN (SELECT stop_id FROM stop_times)", () => {
    const r = inspectQuery(
      "SELECT * FROM stops WHERE stop_id IN (SELECT stop_id FROM stop_times)",
    );
    editable(r);
    expect(r.table).toBe("stops");
  });

  test("SELECT stop_id FROM stops WHERE stop_id NOT IN (SELECT stop_id FROM stop_times)", () => {
    const r = inspectQuery(
      "SELECT stop_id FROM stops WHERE stop_id NOT IN (SELECT stop_id FROM stop_times)",
    );
    editable(r);
    expect(r.pkPresentInColumns).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Edge cases: empty / whitespace / comment-only
// ---------------------------------------------------------------------------
describe("Empty / whitespace / comment-only → empty", () => {
  test("Empty string", () => {
    notEditable(inspectQuery(""), "empty");
  });

  test("Whitespace only", () => {
    notEditable(inspectQuery("   "), "empty");
  });

  test("Comment only", () => {
    notEditable(inspectQuery("-- this is a comment"), "empty");
  });

  test("Block comment only", () => {
    notEditable(inspectQuery("/* SELECT * FROM stops */"), "empty");
  });
});

// ---------------------------------------------------------------------------
// 11. Multiple statements → only first inspected
// ---------------------------------------------------------------------------
describe("Multiple statements → first only", () => {
  test("stops ; routes → inspects stops (editable)", () => {
    const r = inspectQuery("SELECT * FROM stops; SELECT * FROM routes");
    editable(r);
    expect(r.table).toBe("stops");
  });

  test("INSERT first → non_select", () => {
    notEditable(
      inspectQuery("INSERT INTO stops (stop_id) VALUES ('x'); SELECT * FROM stops"),
      "non_select",
    );
  });
});

// ---------------------------------------------------------------------------
// 12. Case insensitivity
// ---------------------------------------------------------------------------
describe("Case insensitivity", () => {
  test("select * from STOPS → editable", () => {
    const r = inspectQuery("select * from STOPS");
    editable(r);
    expect(r.table).toBe("stops");
  });

  test("SELECT * FROM Routes → editable", () => {
    const r = inspectQuery("SELECT * FROM Routes");
    editable(r);
    expect(r.table).toBe("routes");
  });

  test("SELECT STOP_ID, STOP_NAME FROM stops → pkPresentInColumns: true", () => {
    const r = inspectQuery("SELECT STOP_ID, STOP_NAME FROM stops");
    editable(r);
    expect(r.pkPresentInColumns).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. Backtick / double-quote quoting (optional support)
// ---------------------------------------------------------------------------
describe("Quoted table names (optional)", () => {
  test("SELECT * FROM `stops` → editable", () => {
    const r = inspectQuery("SELECT * FROM `stops`");
    editable(r);
    expect(r.table).toBe("stops");
  });

  test('SELECT * FROM "stops" → editable', () => {
    const r = inspectQuery('SELECT * FROM "stops"');
    editable(r);
    expect(r.table).toBe("stops");
  });
});

// ---------------------------------------------------------------------------
// 14. Composite PK details
// ---------------------------------------------------------------------------
describe("Composite PK structure", () => {
  test("calendar_dates → pk is array [service_id, date]", () => {
    const r = inspectQuery("SELECT * FROM calendar_dates");
    editable(r);
    expect(Array.isArray(r.pk)).toBe(true);
    expect(r.pk).toEqual(["service_id", "date"]);
  });

  test("shapes → pk is array [shape_id, shape_pt_sequence]", () => {
    const r = inspectQuery("SELECT * FROM shapes");
    editable(r);
    expect(r.pk).toEqual(["shape_id", "shape_pt_sequence"]);
  });

  test("frequencies → pk is array [trip_id, start_time]", () => {
    const r = inspectQuery("SELECT * FROM frequencies");
    editable(r);
    expect(r.pk).toEqual(["trip_id", "start_time"]);
  });

  test("stop_times → pk is array [trip_id, stop_sequence]", () => {
    const r = inspectQuery("SELECT * FROM stop_times");
    editable(r);
    expect(r.pk).toEqual(["trip_id", "stop_sequence"]);
  });
});

// ---------------------------------------------------------------------------
// 15. feed_info singleton (pk: null)
// ---------------------------------------------------------------------------
describe("feed_info singleton", () => {
  test("SELECT * FROM feed_info → editable, pk: null", () => {
    const r = inspectQuery("SELECT * FROM feed_info");
    editable(r);
    expect(r.pk).toBeNull();
    // pkPresentInColumns is false because pk is null (no PK concept)
    expect(r.pkPresentInColumns).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 16. WHERE, LIMIT, ORDER BY, OFFSET — all OK
// ---------------------------------------------------------------------------
describe("WHERE / LIMIT / ORDER BY / OFFSET are transparent", () => {
  test("WITH WHERE clause", () => {
    const r = inspectQuery(
      "SELECT stop_id, stop_name FROM stops WHERE stop_lat > 48.0",
    );
    editable(r);
    expect(r.table).toBe("stops");
  });

  test("WITH LIMIT", () => {
    const r = inspectQuery("SELECT * FROM trips LIMIT 10");
    editable(r);
    expect(r.table).toBe("trips");
  });

  test("WITH ORDER BY", () => {
    const r = inspectQuery("SELECT * FROM routes ORDER BY route_short_name");
    editable(r);
    expect(r.table).toBe("routes");
  });

  test("WITH OFFSET", () => {
    const r = inspectQuery(
      "SELECT * FROM stop_times LIMIT 100 OFFSET 200",
    );
    editable(r);
    expect(r.table).toBe("stop_times");
  });
});

// ---------------------------------------------------------------------------
// 17. Non-string input (fail-safe)
// ---------------------------------------------------------------------------
describe("Non-string input → fail-safe", () => {
  test("null → non-editable", () => {
    const r = inspectQuery(null);
    notEditable(r);
  });

  test("number → non-editable", () => {
    const r = inspectQuery(42);
    notEditable(r);
  });

  test("undefined → non-editable", () => {
    const r = inspectQuery(undefined);
    notEditable(r);
  });
});
