/**
 * A change on the demo network for the screens bench, by hand and with a brief. As in the product, the person's and
 * the reviewer's words are in the page's language and the engine's measures in English.
 */

export const LANG = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("lang") === "en" ? "en" : "fr";

const WORDS = {
  fr: {
    brief: "Ligne B1 : dernier départ de LaGuardia Terminal B à 23h00 (au lieu de 22h20), du lundi au vendredi, à partir du 4 janvier 2027.\nLigne B1 : un bus toutes les 30 minutes après le dernier départ actuel.\nLigne B2 : le samedi, un départ toutes les 20 minutes entre 7h00 et 9h00 depuis Hudson Yards.\nLigne B6 : circule le dimanche de 9h00 à 19h00, un départ par heure, avec les temps de parcours du samedi.\nLes autres lignes ne changent pas.",
    project: "Offre d'hiver 2027",
    document: "cahier-des-charges-hiver-2027.docx",
    demands: [
      ["Ligne B1 : dernier départ de LaGuardia Terminal B à 23h00 (au lieu de 22h20), du lundi au vendredi, à partir du 4 janvier 2027", "Dernier départ mesuré à 23h00 le lundi 4 janvier 2027 (22h20 avant)."],
      ["Ligne B1 : un bus toutes les 30 minutes après le dernier départ actuel", "Un intervalle de 40 min entre 22h20 et 23h00 le 4 janvier 2027."],
      ["Ligne B2 : le samedi, un départ toutes les 20 minutes entre 7h00 et 9h00 depuis Hudson Yards", "7 départs de 7h00 à 9h00 le samedi 9 janvier 2027, toutes les 20 min."],
      ["Ligne B6 : circule le dimanche de 9h00 à 19h00, un départ par heure", "11 départs par sens de 9h00 à 19h00 le dimanche 10 janvier 2027."],
      ["Ligne B6 : avec les temps de parcours du samedi", "Aucune course du samedi entre Harlem-125 St et Times Sq-42 St pour comparer."],
      ["Les autres lignes ne changent pas.", "Aucune course modifiée hors B1, B2 et B6."],
    ],
    doneB1: "Départs de 22h20, 22h50 et 23h00 le 4 janvier 2027 : 30 min au plus.",
    doneB6: "Temps de parcours du dimanche égaux à ceux du samedi 9 janvier 2027 (39 min).",
    notAsked: { what: "Ligne B2 : 2 courses du dimanche retirées", why: "aucune demande ne touche le dimanche de la B2" },
    question: { question: "Ligne B6, dimanche : quel tracé suivre entre Harlem-125 St et Times Sq-42 St ?", options: ["Le tracé principal (7 arrêts)", "La variante par Columbus Circle (9 arrêts)"], why: "La ligne a deux tracés le samedi ; le cahier des charges n'en nomme aucun." },
  },
  en: {
    brief: "Line B1: last departure from LaGuardia Terminal B at 23:00 (instead of 22:20), Monday to Friday, from 4 January 2027.\nLine B1: a bus every 30 minutes after the current last departure.\nLine B2: on Saturdays, a departure every 20 minutes between 07:00 and 09:00 from Hudson Yards.\nLine B6: runs on Sundays from 09:00 to 19:00, one departure an hour, with Saturday's running times.\nThe other lines do not change.",
    project: "Winter 2027 service",
    document: "winter-2027-brief.docx",
    demands: [
      ["Line B1: last departure from LaGuardia Terminal B at 23:00 (instead of 22:20), Monday to Friday, from 4 January 2027", "Last departure measured at 23:00 on Monday 4 January 2027 (22:20 before)."],
      ["Line B1: a bus every 30 minutes after the current last departure", "A 40-minute gap between 22:20 and 23:00 on 4 January 2027."],
      ["Line B2: on Saturdays, a departure every 20 minutes between 07:00 and 09:00 from Hudson Yards", "7 departures from 07:00 to 09:00 on Saturday 9 January 2027, every 20 min."],
      ["Line B6: runs on Sundays from 09:00 to 19:00, one departure an hour", "11 departures each way from 09:00 to 19:00 on Sunday 10 January 2027."],
      ["Line B6: with Saturday's running times", "No Saturday trip between Harlem-125 St and Times Sq-42 St to compare with."],
      ["The other lines do not change.", "No trip changed outside B1, B2 and B6."],
    ],
    doneB1: "Departures at 22:20, 22:50 and 23:00 on 4 January 2027: 30 min at most.",
    doneB6: "Sunday running times equal to those of Saturday 9 January 2027 (39 min).",
    notAsked: { what: "Line B2: 2 Sunday trips removed", why: "no demand touches B2 on Sundays" },
    question: { question: "Line B6, Sunday: which route between Harlem-125 St and Times Sq-42 St?", options: ["The main route (7 stops)", "The variant via Columbus Circle (9 stops)"], why: "The line has two routes on Saturdays; the brief names neither." },
  },
}[LANG];
export const benchProjectName = WORDS.project;

const handItems = [
  { code: "service_last", route: "B1", label: "B1", day: "weekday", date: "20270104", direction: "0", before: "22:20", after: "23:00" },
  { code: "service_trips", route: "B2", label: "B2", day: "saturday", date: "20270109", direction: "0", before: 4, after: 7 },
];
export const hand = {
  journal: [
    { id: 3, entity: "trip", entity_id: "B2-0720", action: "create", description: "trip B2-0720 created", reason: "manual", undone: 0, actor_name: "Nadia L.", ts: "2026-10-20T09:42:00Z" },
    { id: 2, entity: "stop", entity_id: "HY", action: "update", description: "stop HY updated", reason: "manual", undone: 0, actor_name: "Nadia L.", ts: "2026-10-20T09:38:00Z" },
    { id: 1, entity: "stop_time", entity_id: "B1-2215:1", action: "update", description: "stop time updated", reason: "manual", undone: 0, actor_name: "Nadia L.", ts: "2026-10-20T09:31:00Z" },
  ],
  operations: [{ id: "op4", type: "set_headway", params: { route: "B2", days: "saturday", from: "07:00", to: "09:00", headway_min: 20 }, source: { author: "assistant" } }],
  planPreview: {
    id: "0123456789abcdef02",
    empty: false,
    blocked: true,
    steps: [{ id: "op4", type: "set_headway", status: "blocked", ambiguities: [{ param: "days", code: "days_missing", message: "Which Saturdays?", options: ["saturday", "school_holidays_saturday"] }], warnings: [] }],
    diff: { items: [], empty: true },
  },
  preview: {
    id: "0123456789abcdef01",
    empty: false,
    steps: [],
    diff: { items: handItems, empty: false },
    impact: { currency: "EUR", totals: { km: { before: 182400, delta: 1260, pct: 0.7 }, cost: { before: 912000, delta: 6300 }, fleet: { before: 24, delta: 0 } } },
    gate: { can_commit: true, deliverable: true, blocking: [], acknowledgeable: [], validation: "passed" },
    validation: { status: "passed", after: { errors: 0, warnings: 12 }, before: { errors: 0, warnings: 12 } },
  },
};

const brief = WORDS.brief;

const routes = [
  { id: "B1", short_name: "B1", long_name: "LaGuardia Link SBS", color: "1F77B4" },
  { id: "B2", short_name: "B2", long_name: "14 St Crosstown", color: "7B4FA8" },
  { id: "B6", short_name: "B6", long_name: "Central Park Shuttle", color: "8C564B" },
];

// Minutes from the first stop; the other direction is the same stops reversed.
const LINES = {
  B1: { head: ["Chelsea Market", "LaGuardia Terminal B"], stops: [["LGA_B", "LaGuardia Terminal B", 0], ["JHX", "Jackson Heights", 14], ["SUN", "Sunnyside", 24], ["LIC_S", "Long Island City", 31], ["GCT_S", "Grand Central", 40], ["BRY", "Bryant Park", 42], ["TSQ_S", "Times Sq-42 St", 44], ["PSN", "Penn Station", 47], ["CHE", "Chelsea Market", 52]] },
  B2: { head: ["Lower East Side", "Hudson Yards"], stops: [["HYD", "Hudson Yards", 0], ["CHE", "Chelsea Market", 8], ["PSN", "Penn Station", 14], ["HSQ", "Herald Square", 19], ["MAD", "Madison Sq", 23], ["USQ", "Union Square", 26], ["EVL", "East Village", 32], ["LES", "Lower East Side", 37]] },
  B6: { head: ["Times Sq-42 St", "Harlem-125 St"], stops: [["HAR_S", "Harlem-125 St", 0], ["MMA", "Museum Mile", 15], ["UES", "Upper East Side 86 St", 19], ["5AV59", "5 Av / 59 St", 28], ["GCT_S", "Grand Central", 34], ["BRY", "Bryant Park", 37], ["TSQ_S", "Times Sq-42 St", 39]] },
};

const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`;
const every = (from, to, step) => {
  const out = [];
  for (let m = minutes(from); m <= minutes(to); m += step) out.push(clock(m).slice(0, 5));
  return out;
};

const B2_BEFORE = ["06:20", ...every("07:00", "22:20", 40)];
const departures = {
  B1: { weekday: { before: { 0: every("05:00", "22:20", 20), 1: every("05:30", "22:30", 20) }, after: { 0: [...every("05:00", "22:20", 20), "23:00"], 1: every("05:30", "22:30", 20) } } },
  B2: { saturday: { before: { 0: B2_BEFORE, 1: every("06:40", "22:40", 40) }, after: { 0: [...new Set([...B2_BEFORE.filter((t) => t < "07:00" || t > "09:00"), ...every("07:00", "09:00", 20)])].sort(), 1: every("06:40", "22:40", 40) } } },
  B6: { sunday: { before: { 0: [], 1: [] }, after: { 0: every("09:00", "19:00", 60), 1: every("09:40", "19:40", 60) } }, saturday: { before: { 0: every("07:00", "21:00", 30), 1: every("07:15", "21:15", 30) }, after: { 0: every("07:00", "21:00", 30), 1: every("07:15", "21:15", 30) } } },
};

const DAY_OF = { "20270104": "weekday", "20270109": "saturday", "20270110": "sunday" };
const stopsOf = (route, direction) => {
  const line = LINES[route];
  if (!line) return [];
  if (String(direction) === "0") return line.stops;
  const total = line.stops[line.stops.length - 1][2];
  return [...line.stops].reverse().map(([id, name, at]) => [id, name, total - at]);
};
const daysOf = (route, date) => departures[route]?.[DAY_OF[String(date).replace(/-/g, "")] || "weekday"] || null;

/** As GET /directions answers; the draft's when `after`. */
export const directionsOf = (route, date, after) => {
  const day = daysOf(route, date);
  if (!day) return [];
  const side = after ? day.after : day.before;
  return ["0", "1"].filter((d) => (side[d] || []).length).map((d) => ({ direction_id: d, label: `${d} — ${LINES[route].head[Number(d)]}`, headsigns: [{ name: LINES[route].head[Number(d)], count: side[d].length }], trip_count: side[d].length }));
};

/** As GET /stops_and_times answers; the draft's when `after`. */
export const timetableOf = (route, direction, date, after) => {
  const stops = stopsOf(route, direction);
  const day = daysOf(route, date);
  const list = day ? (after ? day.after : day.before)[String(direction)] || [] : [];
  const stopTimes = list.flatMap((dep) =>
    stops.map(([id], i) => {
      const at = clock(minutes(dep) + stops[i][2]);
      return { trip_id: `${route}_${direction}_${dep.replace(":", "")}`, arrival_time: at, departure_time: at, stop_id: id, stop_sequence: i + 1, pickup_type: "0", drop_off_type: "0", is_frequency_based: false };
    }),
  );
  return { stops: stops.map(([id, name]) => ({ stop_id: id, stop_name: name, location_type: "0", wheelchair_boarding: "1" })), stop_times: stopTimes, has_frequencies: false, has_normal_times: true, frequency_info: [], frequency_trip_count: 0, normal_trip_count: list.length, wheelchair_accessible_trips: list.length, total_trips: list.length };
};

const PREVIEW = "abcdef0123456789ab";
const B1_PATH = [[40.7754, -73.8724], [40.7465, -73.8913], [40.744, -73.9213], [40.7471, -73.9442], [40.7527, -73.9772], [40.7536, -73.9832], [40.758, -73.9855], [40.7506, -73.9935], [40.7424, -74.006]];
const B2_PATH = [[40.7557, -74.002], [40.7424, -74.006], [40.7506, -73.9935], [40.7497, -73.9877], [40.7425, -73.9877], [40.7359, -73.9911], [40.7265, -73.9815], [40.715, -73.9843]];
const B6_PATH = [[40.8075, -73.9465], [40.7856, -73.9572], [40.7794, -73.9555], [40.7637, -73.9727], [40.7527, -73.9772], [40.7536, -73.9832], [40.758, -73.9855]];
const DEMAND_SHAPES = [
  { status: "done", where: { line: "B1", date: "2027-01-04" } },
  { status: "not_done", where: { line: "B1", date: "2027-01-04", stop: "LaGuardia Terminal B" } },
  { status: "done", where: { line: "B2", date: "2027-01-09" } },
  { status: "done", where: { line: "B6", date: "2027-01-10" } },
  { status: "unproven", where: { line: "B6", date: "2027-01-10" } },
  { status: "done" },
];
const demands = DEMAND_SHAPES.map((shape, i) => ({ quote: WORDS.demands[i][0], evidence: WORDS.demands[i][1], ...shape }));
const facts = {
  preview_id: PREVIEW,
  diff: ["Line B1 · weekday · dir 0: last departure 22:20 → 23:00", "Line B2 · saturday · dir 0: 4 → 7 trips", "Line B6 · sunday · dir 0: 0 → 11 trips", "Line B6 · sunday · dir 1: 0 → 11 trips"],
  diff_more: 0,
  tables: [{ table: "calendar", added: 1, removed: 0, changed: 0 }, { table: "calendar_dates", added: 4, removed: 0, changed: 0 }, { table: "stop_times", added: 186, removed: 14, changed: 0 }, { table: "trips", added: 26, removed: 2, changed: 0 }],
  integrity: [],
  validator: { status: "passed", new_errors: [], errors_after: 0 },
};
const diff = {
  preview_id: PREVIEW,
  diff: {
    items: [
      { code: "service_last", route: "B1", label: "B1", day: "weekday", date: "20270104", direction: "0", before: "22:20", after: "23:00" },
      { code: "service_trips", route: "B2", label: "B2", day: "saturday", date: "20270109", direction: "0", before: 4, after: 7 },
      { code: "service_trips", route: "B6", label: "B6", day: "sunday", date: "20270110", direction: "0", before: 0, after: 11 },
      { code: "service_trips", route: "B6", label: "B6", day: "sunday", date: "20270110", direction: "1", before: 0, after: 11 },
    ],
    empty: false,
  },
  // A timetable change: the paths are the same before and after.
  geo: {
    routes: [
      { route_id: "B1", short_name: "B1", color: "1F77B4", status: "changed", before: B1_PATH, after: B1_PATH },
      { route_id: "B2", short_name: "B2", color: "7B4FA8", status: "changed", before: B2_PATH, after: B2_PATH },
      { route_id: "B6", short_name: "B6", color: "8C564B", status: "changed", before: B6_PATH, after: B6_PATH },
    ],
    stops: [],
    bbox: [40.712, -74.012, 40.81, -73.868],
  },
};

const done = { reason: "complete", previewId: PREVIEW, deliverable: true, report: { demands: demands.map((d) => (d.status === "done" ? d : { ...d, status: "done", evidence: d.status === "not_done" ? WORDS.doneB1 : WORDS.doneB6 })), not_asked: [], complete: true }, facts, corrections: { rounds: 1, max: 2 } };
const mixed = { reason: "complete", previewId: PREVIEW, deliverable: true, report: { demands, not_asked: [WORDS.notAsked], complete: true }, facts, corrections: { rounds: 2, max: 2 } };
const blocked = { ...done, deliverable: false, facts: { ...facts, validator: { status: "new_errors", new_errors: [{ code: "stop_time_timepoint_without_times", before: 0, after: 22 }, { code: "block_trips_with_overlapping_stop_times", before: 0, after: 3 }], errors_after: 25 } }, corrections: { rounds: 2, max: 2 } };

const question = WORDS.question;

// `hold`: the stream stays open at that moment.
const reading = [{ event: "step", data: { kind: "reading", by: "agent", documents: [WORDS.document] } }];
const changing = [...reading, { event: "step", data: { kind: "querying", by: "agent", purpose: "trips of B1 on weekdays" } }, { event: "step", data: { kind: "writing", by: "agent", intent: "B1 last departure" } }, { event: "step", data: { kind: "measuring", by: "agent", clause: "span" } }];
const reviewing = [...changing, { event: "step", data: { kind: "reviewing", by: "reviewer", round: 0 } }, { event: "step", data: { kind: "measuring", by: "reviewer", clause: "headway_max" } }];
const correcting = [...reviewing, { event: "step", data: { kind: "correcting", by: "agent", round: 1, findings: 2 } }, { event: "step", data: { kind: "writing", by: "agent", intent: "B1 evening headway" } }];
const finished = (result) => [...correcting, { event: "step", data: { kind: "reviewing", by: "reviewer", round: 1 } }, { event: "done", data: result }];
const scripts = {
  "progress-early": { events: reading, hold: true },
  "progress-review": { events: reviewing, hold: true },
  "progress-correction": { events: correcting, hold: true },
  question: { events: [...changing.slice(0, 2), { event: "question", data: question }, { event: "done", data: { reason: "asked", question, previewId: null, corrections: { rounds: 0, max: 2 } } }] },
  "decide-done": { events: finished(done) },
  "decide-mixed": { events: finished(mixed) },
  "decide-blocked": { events: finished(blocked) },
  delivering: { events: finished(mixed) },
  applied: { events: finished(done) },
  "error-turn": { events: [...reading, { event: "error", data: { code: "UPSTREAM_ERROR", status: 503, message: "Overloaded" } }, { event: "done", data: { reason: "error" } }] },
};

const document = { id: "0123456789abcdef01234567", name: WORDS.document, kind: "docx", size: 48213, pages: 6, kept: true, sent_to_assistant: true };

export const direct = { brief, routes, document, question, results: { done, mixed, blocked }, diff, scripts, previewId: PREVIEW, defaultDate: "2027-01-04" };
