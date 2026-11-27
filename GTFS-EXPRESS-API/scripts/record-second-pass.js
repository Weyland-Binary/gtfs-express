#!/usr/bin/env node
/**
 * Records what the canonical validator answers on small feeds holding a value or a row it cannot read, into
 * src/__tests__/fixtures/validatorSecondPass.json: the feed as given (`first`), the same with what it cannot read set
 * aside as the service does (`second`: a value blanked or, for a web address, given its stand-in; the line of a row
 * refused whole left empty; a column without a name lent one, and `third` what its rows then need set aside), and
 * with it well-formed (`truth`). validatorSecondPass.test.js reads the service's second
 * pass against these outputs without starting a JVM. The validation date is pinned and the log's clock read out, so a later run of the same validator
 * writes the same file. Run again when GTFS_VALIDATOR_VERSION changes:
 *   GTFS_CANONICAL_VALIDATOR_JAR=… JAVA_BIN=… node scripts/record-second-pass.js
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const jar = process.env.GTFS_CANONICAL_VALIDATOR_JAR;
const java = process.env.JAVA_BIN || "java";
if (!jar || !fs.existsSync(jar)) {
  console.error("GTFS_CANONICAL_VALIDATOR_JAR must name the validator's JAR.");
  process.exit(1);
}

const DATE = "2026-11-13";

const BASE = {
  "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nA,Probe Transit,https://example.org,Europe/Paris\n",
  "routes.txt": "route_id,agency_id,route_short_name,route_long_name,route_type\nR1,A,1,Line one,3\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\nST,Hub,48.85,2.35,1,\nS1,Alpha,48.8501,2.3501,0,ST\nS2,Beta,48.86,2.36,0,\nS3,Gamma,48.87,2.37,0,\n",
  "calendar.txt": "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nWK,1,1,1,1,1,0,0,20261101,20271031\n",
  "trips.txt": "route_id,service_id,trip_id,shape_id\nR1,WK,T1,SH1\nR1,WK,T2,SH1\n",
  "stop_times.txt":
    "trip_id,arrival_time,departure_time,stop_id,stop_sequence,shape_dist_traveled\n" +
    "T1,08:00:00,08:00:00,S1,1,0\nT1,08:10:00,08:10:00,S2,2,1.5\nT1,08:20:00,08:20:00,S3,3,3.0\n" +
    "T2,09:00:00,09:00:00,S1,1,0\nT2,09:10:00,09:10:00,S2,2,1.5\nT2,09:20:00,09:20:00,S3,3,3.0\n",
  "shapes.txt": "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\nSH1,48.8501,2.3501,1,0\nSH1,48.86,2.36,2,1.5\nSH1,48.87,2.37,3,3.0\n",
  "feed_info.txt": "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version,feed_contact_email\nProbe,https://example.org,fr,20261101,20271031,1,contact@example.org\n",
};

// The feed of the defect: an unknown stop and a time going backwards on T1, which only the checks reading stop_times see.
const BROKEN_T1 = BASE["stop_times.txt"].replace("T1,08:10:00,08:10:00,S2,2,1.5", "T1,08:10:00,08:10:00,S9,2,1.5").replace("T1,08:20:00,08:20:00,S3,3,3.0", "T1,06:05:00,06:05:00,S3,3,3.0");

// A line of an agency the feed does not hold: only the checks reading agency.txt see it.
const UNKNOWN_AGENCY = BASE["routes.txt"].replace("R1,A,1,Line one,3", "R1,B,1,Line one,3");

const swap = (text, from, to) => {
  if (!text.includes(from)) throw new Error(`not found: ${from}`);
  return text.replace(from, to);
};
// stops.txt with one more column after stop_name: `name` in its header, a note on every row but the last.
const NOTES = ["hub", "north side", "", ""];
const withColumn = (text, name) =>
  text
    .trimEnd()
    .split("\n")
    .map((line, i) => {
      const cells = line.split(",");
      cells.splice(2, 0, i === 0 ? name : NOTES[i - 1]);
      return cells.join(",");
    })
    .join("\n") + "\n";
// The same file with a comma closing its header and every row.
const closedByComma = (text, name) =>
  text
    .trimEnd()
    .split("\n")
    .map((line, i) => `${line},${i === 0 ? name : ""}`)
    .join("\n") + "\n";
const unreadableLat = (text) => swap(text, ",48.86,2.36,0,", ',"48,86",2.36,0,');
const blankedLat = (text) => swap(text, ",48.86,2.36,0,", ",,2.36,0,");

// One case: the file changed, its text with the value well-formed (`truth`), unreadable (`first`), blanked (`second`).
const variant = (file, base, wellFormed, unreadable, blanked) => ({
  truth: { [file]: base },
  first: { [file]: swap(base, wellFormed, unreadable) },
  second: { [file]: swap(base, wellFormed, blanked) },
});

const CASES = {
  // One time written « 9h10 » on T2: the unknown stop and the backwards time of T1 are found by the second pass.
  time: variant("stop_times.txt", BROKEN_T1, "T2,09:10:00,09:10:00,S2,2,1.5", "T2,9h10,9h10,S2,2,1.5", "T2,,,S2,2,1.5"),
  // The unreadable time on the very row of the unknown stop: the foreign key names another field of that row.
  same_row: variant("stop_times.txt", BROKEN_T1, "T1,08:10:00,08:10:00,S9,2,1.5", "T1,8h10,8h10,S9,2,1.5", "T1,,,S9,2,1.5"),
  // A terminus without its arrival is the blanking's own finding.
  edge_time: variant("stop_times.txt", BASE["stop_times.txt"], "T2,09:20:00,09:20:00,S3,3,3.0", "T2,9h20,09:20:00,S3,3,3.0", "T2,,09:20:00,S3,3,3.0"),
  // A stop without its latitude: what the shape checks say of that stop is the blanking's.
  stop_position: variant("stops.txt", BASE["stops.txt"], "S2,Beta,48.86,2.36,0,", 'S2,Beta,"48,86",2.36,0,', "S2,Beta,,2.36,0,"),
  // A station without its type reads as a stop: its child's finding is the blanking's.
  station_type: variant("stops.txt", BASE["stops.txt"], "ST,Hub,48.85,2.35,1,", "ST,Hub,48.85,2.35,station,", "ST,Hub,48.85,2.35,,"),
  // A shape without its last distance: what the trips of that shape are told is the blanking's.
  shape_distance: variant("shapes.txt", BASE["shapes.txt"], "SH1,48.87,2.37,3,3.0", 'SH1,48.87,2.37,3,"3,0"', "SH1,48.87,2.37,3,"),
  feed_end_date: variant("feed_info.txt", BASE["feed_info.txt"], "20261101,20271031,1,", "20261101,31/10/2027,1,", "20261101,,1,"),
  // A web address the feed must give: blanked its row is refused again, so the copy holds a stand-in address.
  required_url: {
    truth: { "routes.txt": UNKNOWN_AGENCY },
    first: { "agency.txt": swap(BASE["agency.txt"], "https://example.org", "https:\\\\example.org"), "routes.txt": UNKNOWN_AGENCY },
    second: { "agency.txt": swap(BASE["agency.txt"], "https://example.org", "https://example.org/unreadable/agency.txt/2/agency_url"), "routes.txt": UNKNOWN_AGENCY },
  },
  // A value the parser requires, unreadable: blanked its row would be refused again, so the row's line is left empty.
  required: variant("stop_times.txt", BROKEN_T1, "T2,09:10:00,09:10:00,S2,2,1.5", "T2,09:10:00,09:10:00,S2,two,1.5", ""),
  // A row longer than its header: its line is left empty, and the calls at that stop are told it is not there.
  row_length: variant("stops.txt", BASE["stops.txt"], "S2,Beta,48.86,2.36,0,", "S2,Beta,48,86,2.36,0,", ""),
  // The same in a file whose lines end in CR LF: the emptied line keeps its end.
  crlf_row: variant("stops.txt", BASE["stops.txt"].replace(/\n/g, "\r\n"), "S2,Beta,48.86,2.36,0,", "S2,Beta,48,86,2.36,0,", ""),
  // A call without its trip, a trip without its id: rows the parser refuses for a required value left empty.
  call_row: variant("stop_times.txt", BROKEN_T1, "T2,09:10:00,09:10:00,S2,2,1.5", ",09:10:00,09:10:00,S2,2,1.5", ""),
  trip_row: variant("trips.txt", BASE["trips.txt"], "R1,WK,T2,SH1", "R1,WK,,SH1", ""),
  // A row left empty and a value blanked in the same file.
  rows_and_cells: {
    truth: { "stop_times.txt": BROKEN_T1 },
    first: { "stop_times.txt": swap(swap(BROKEN_T1, "T2,09:10:00,09:10:00,S2,2,1.5", "T2,9h10,9h10,S2,2,1.5"), "T2,09:20:00,09:20:00,S3,3,3.0", ",09:20:00,09:20:00,S3,3,3.0") },
    second: { "stop_times.txt": swap(swap(BROKEN_T1, "T2,09:10:00,09:10:00,S2,2,1.5", "T2,,,S2,2,1.5"), "T2,09:20:00,09:20:00,S3,3,3.0", "") },
  },
  // A call without its stop is a check's finding on a row the parser read, in a file another row leaves unread: its
  // line stays.
  check_field: {
    truth: { "stop_times.txt": swap(BROKEN_T1, "T2,09:00:00,09:00:00,S1,1,0", "T2,09:00:00,09:00:00,,1,0") },
    first: { "stop_times.txt": swap(swap(BROKEN_T1, "T2,09:00:00,09:00:00,S1,1,0", "T2,09:00:00,09:00:00,,1,0"), "T2,09:10:00,09:10:00,S2,2,1.5", "T2,9h10,9h10,S2,2,1.5") },
    second: { "stop_times.txt": swap(swap(BROKEN_T1, "T2,09:00:00,09:00:00,S1,1,0", "T2,09:00:00,09:00:00,,1,0"), "T2,09:10:00,09:10:00,S2,2,1.5", "T2,,,S2,2,1.5") },
  },
  // A header naming a column twice: nothing a second pass can set aside.
  header: { truth: {}, first: { "stops.txt": swap(BASE["stops.txt"], "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station", "stop_id,stop_name,stop_lat,stop_lat,location_type,parent_station") } },
  // An empty file is left out of the second pass.
  empty_file: { truth: {}, first: { "feed_info.txt": "" }, second: { "feed_info.txt": null } },
  // A column without a name holding values: its header is refused, the file left unread. Lent a name in the copy, the
  // column is an unknown one and the checks reading stops.txt find T1's unknown stop and its time going backwards.
  unnamed_column: {
    truth: { "stop_times.txt": BROKEN_T1 },
    first: { "stops.txt": withColumn(BASE["stops.txt"], ""), "stop_times.txt": BROKEN_T1 },
    second: { "stops.txt": withColumn(BASE["stops.txt"], "gtfsexpress_unnamed_3"), "stop_times.txt": BROKEN_T1 },
  },
  // A header and every row closed by a comma: a column without a name that holds nothing.
  unnamed_trailing: {
    truth: { "stop_times.txt": BROKEN_T1 },
    first: { "stops.txt": closedByComma(BASE["stops.txt"], ""), "stop_times.txt": BROKEN_T1 },
    second: { "stops.txt": closedByComma(BASE["stops.txt"], "gtfsexpress_unnamed_7"), "stop_times.txt": BROKEN_T1 },
  },
  // A column without a name in a file one of whose values cannot be read: the validator reads the rows only once the
  // header is read, so the value is found by the second pass and blanked for a third.
  unnamed_and_value: {
    truth: { "stop_times.txt": BROKEN_T1 },
    first: { "stops.txt": unreadableLat(withColumn(BASE["stops.txt"], "")), "stop_times.txt": BROKEN_T1 },
    second: { "stops.txt": unreadableLat(withColumn(BASE["stops.txt"], "gtfsexpress_unnamed_3")), "stop_times.txt": BROKEN_T1 },
    third: { "stops.txt": blankedLat(withColumn(BASE["stops.txt"], "gtfsexpress_unnamed_3")), "stop_times.txt": BROKEN_T1 },
  },
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), "gtfs-second-pass-"));

// A java.util.logging record starts with its date and the method that logs; the list of the validators and the
// parser's cache figures are left out, everything a warning or an error says and the closing summary are kept.
const recordsOf = (stderr) => stderr.split(/\n(?=[A-Z][a-z]{2} \d{1,2}, \d{4} )/);
// The same text at every recording: the temp folder, the clock and the run's length are not the validator's answer.
const steady = (stderr) =>
  stderr
    .split(work)
    .join("/recorded")
    .replace(/^Picked up [^\n]*\n/, "")
    .replace(/^[A-Z][a-z]{2} \d{1,2}, \d{4} \d{1,2}:\d{2}:\d{2} [AP]M /gm, "Nov 13, 2026 12:00:00 PM ")
    .replace(/Validation took [\d.]+ seconds/, "Validation took 0.000 seconds");
const reduced = (stderr) => {
  const records = recordsOf(stderr);
  const kept = records.filter((record, i) => i >= records.length - 2 || /\n(?:SEVERE|WARNING): /.test(record));
  return kept.join("\n");
};

const validate = (name, files, { fullLog = false } = {}) => {
  const dir = path.join(work, name, "feed");
  const out = path.join(work, name, "out");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  for (const [file, text] of Object.entries(files)) if (text != null) fs.writeFileSync(path.join(dir, file), text);
  const run = spawnSync(java, ["-Xmx512m", "-jar", jar, "-i", dir, "-o", out, "-svu", "-d", DATE], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0) throw new Error(`${name}: the validator exited ${run.status}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8"));
  const system = JSON.parse(fs.readFileSync(path.join(out, "system_errors.json"), "utf8"));
  if (system.notices.length) throw new Error(`${name}: the validator crashed on a check`);
  const stderr = steady(run.stderr);
  return { version: report.summary.validatorVersion, notices: report.notices, log: fullLog ? stderr : reduced(stderr) };
};

try {
  const cases = {};
  let version = null;
  for (const [name, c] of Object.entries(CASES)) {
    const first = validate(`${name}-first`, { ...BASE, ...c.first }, { fullLog: name === "time" });
    version = first.version;
    const recorded = { files: c.first, first: { notices: first.notices, log: first.log } };
    if (c.second) {
      const second = validate(`${name}-second`, { ...BASE, ...c.second });
      recorded.blanked = c.second;
      recorded.second = { notices: second.notices, log: second.log };
    }
    if (c.third) {
      const third = validate(`${name}-third`, { ...BASE, ...c.third });
      recorded.blankedAgain = c.third;
      recorded.third = { notices: third.notices, log: third.log };
    }
    recorded.truth = validate(`${name}-truth`, { ...BASE, ...c.truth }).notices;
    cases[name] = recorded;
    console.log(`${name}: first ${first.notices.map((n) => `${n.code}×${n.totalNotices}`).join(", ") || "clean"}${recorded.second ? ` | second ${recorded.second.notices.map((n) => `${n.code}×${n.totalNotices}`).join(", ") || "clean"}` : ""} | truth ${recorded.truth.map((n) => `${n.code}×${n.totalNotices}`).join(", ") || "clean"}`);
  }
  const target = path.join(__dirname, "..", "src", "__tests__", "fixtures", "validatorSecondPass.json");
  fs.writeFileSync(target, JSON.stringify({ validator: version, date: DATE, base: BASE, cases }, null, 1) + "\n");
  console.log(`written to ${path.relative(process.cwd(), target)} (${Math.round(fs.statSync(target).size / 1024)} KB)`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
