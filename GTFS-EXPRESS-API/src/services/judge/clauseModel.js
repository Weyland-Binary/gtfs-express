/**
 * clauseModel — the clauses of a brief: what each kind promises, and how a
 * clause is recorded (normalised, merged, linted) before it is measured.
 *
 *
 * The brief becomes a list of CLAUSES, each a checkable promise:
 *
 *   { id, kind, level: "must" | "should", status: "stated" | "assumed" |
 *     "confirmed" | "waived", source?, text?, quote?, page?, document?, params,
 *     decided_by?: "user", decision?: { by: { name, user_id? }, at?, action?: keep|correct|waive, reason? } }
 *
 * "confirmed" and "waived" are the user's decisions: a clause keeps one of
 * them only with `decided_by: "user"` AND a named `decision`; otherwise it is
 * normalised to "stated" and measured (see normalizeClause).
 *
 *   line_exists  { line }                         a line of that name exists
 *   termini      { line, from, to }               it runs from … to … (either direction)
 *   via          { line, stops: [names] }         it serves these places, in any order
 *   serves       { place, lat?, lon?, radius_m?, line? }  a stop within radius (400 m)
 *   headway_max  { line?, day, from, to, minutes, direction?, stop?, occurrence? } every ≤ minutes in the window
 *                (stop: measured on the departures at that stop — a timetable that states its headway at a timing stop)
 *                (a feed: at each direction's trunk stop, named in `measured` when the trips start elsewhere)
 *                (occurrence: which call the stop is when a trip bears that name several times — first, last or
 *                 its rank; without it the first call: callOf — the sheet reader writes it where its
 *                 grid repeats the name)
 *   span         { line?, day, first_before?, first_after?, last_after?, last_before?, amplitude_h?, direction? }
 *                 first/last departure, each bound one-sided (first_after: no departure
 *                 earlier; last_before: none later), amplitude_h: the first to the last
 *                 departure lasts at least that many hours
 *                 (direction "0" or "1": that direction only — e.g. short-turns
 *                 that reinforce one way; otherwise each direction must hold)
 *   days         { line?, days: [...] }           runs on each of these days
 *   no_service   { line?, days: [...] }           runs on none of them
 *   mode         { line, mode }
 *   lines_max    { count } / lines_min { count }
 *   fleet_max    { vehicles } / budget_max { amount }  (the operations estimate)
 *   od_max_time  { from, to, day?, depart_at? | arrive_by?, max_minutes }
 *                 a typical trip, measured on the timetable (walk included)
 *   running_time { line, from_stop, to_stop, minutes ± tolerance_min | min_minutes / max_minutes, measure? }
 *                 the scheduled time from one stop to another, each trip (or the median)
 *   trips_count  { line, min? max? exactly?, per?, direction? | towards?, at_stop?, occurrence?, from?, to? }
 *                 trips a day, per direction or in total
 *   departure_at { line, stop, occurrence?, times, towards?, event?, tolerance_min?, present? }
 *                 a trip leaves (or no longer leaves) that stop at each time
 *   stop_pattern { line, stops?: [names in order], avoid?: [names], trips?, ends?, exact?, direction? }
 *                 the trips from the first listed stop to the last serve the list in order
 *   same_as      { line | lines, like_date | like_week, like_in? }  the timetable of a reference day
 *   unchanged_except { line | lines, except?: { lines, from, to, direction, stops, beyond: { stop, towards }, trips } }
 *                 nothing changes compared with the feed before the plan, except what is named; except.trips:
 *                 [{ lines?, direction?, days?, from_date?, to_date?, dates?, period?, from?, to?, times?,
 *                 tolerance_min?, at_stop? }], the trips of each scope — its lines, direction, days and dates,
 *                 leaving in its window or at one of its times (each within a minute, as the operators match
 *                 a time; read at its stop when it names one), all day without either: what each operation
 *                 of a plan may change, which « le reste de la journée est inchangé » leaves out
 *                 (unchangedClauses)
 *   transfer_max_wait { stop, radius_m?, from_line | from_times, to_line | to_times, max_wait, min_wait?, each?, from?, to? }
 *                 a guaranteed connection: every arrival of the feeder at the stop (a
 *                 line, or an external timetable's arrival times — a TER) has a
 *                 departure of the other service between min_wait and max_wait minutes
 *                 later (each: "departure" — every departure has a feeder arrival before)
 *   accessibility { stops? | line?, measure?: stops|trips, min_pct? (100) }
 *                 the share of stops with wheelchair_boarding = 1 (a platform inherits
 *                 its station's) or of trips with wheelchair_accessible = 1
 *   line_identity { line?, short_name?, long_name?, color?, text_color?, unchanged?, except? }
 *                 the line's public identity (renumbering, renaming, colour); without a
 *                 line, unchanged: no line renumbered, renamed or recoloured
 *   stop_identity { stop?, name?, code?, unchanged?, except? }  a stop keeps or gets a name,
 *                 a code; without a stop, unchanged: no stop renamed
 *   feed_validity { from?, to?, unchanged? }        the feed's service covers [from, to]
 *                 (calendar coverage and feed_info), or keeps the validity it had
 *   population_coverage { min_pct, radius_m? (400), line? }  residents within radius of a
 *                 served stop (the territory's population grid; unknown without it)
 *   service_km_max { km, line? } / vehicle_hours_max { hours, line? }
 *                 commercial vehicle-km / vehicle-hours a year (the operations estimate)
 *   table_rows   { table, line?, where?: { column: value | [values] }, expect?: { column: value | [values] },
 *                  min? max? exactly? | absent?, changed?: true | false }
 *                 the rows of any GTFS table the product edits (transform/fieldWays): those where selects
 *                 hold expect, number min…max (absent: none), or differ from / equal the feed before the plan
 *                 (checks/tables; a real feed only)
 *
 * A clause of a kind this checker does not know is kept and reported
 * "unknown" ("unsupported clause kind: …"), counted in summary.unsupported.
 *
 * A brief without clauses still gets checked: its `lines_requested` (name,
 * from, to, via) are turned into line_exists / termini / via clauses.
 *
 * The time kinds (TIME_KINDS) are measured on every timetable of their scope
 * (calendar), the relational ones against the feed before the plan
 * (checks/comparison); each kind by its check (checks/*), merged in verdict.
 */

"use strict";

const networkSpec = require("../network/networkSpec");
const { str, num, clip, given, listOf, timesOf, clockOf, clockText } = require("./values");
const { parseYmd, dayWordsOf } = require("./calendar");
const { tableOf, paramProblems } = require("./tableParams");

const { nameKey } = networkSpec._internals;

const KINDS = ["line_exists", "termini", "via", "serves", "headway_max", "span", "days", "no_service", "mode", "lines_max", "lines_min", "fleet_max", "budget_max", "od_max_time", "running_time", "trips_count", "departure_at", "stop_pattern", "same_as", "unchanged_except", "transfer_max_wait", "accessibility", "line_identity", "stop_identity", "feed_validity", "population_coverage", "service_km_max", "vehicle_hours_max", "pickup_dropoff", "shape_follows", "changed_in_scope", "table_rows"];
// The kinds a designed network can be held to: unchanged_except and changed_in_scope need a feed before the plan,
// table_rows a feed's tables.
const NETWORK_KINDS = KINDS.filter((k) => k !== "unchanged_except" && k !== "changed_in_scope" && k !== "table_rows");
// The kinds of the network's shape, identity and totals: measured once, never on dates.
const STRUCTURAL_KINDS = ["line_exists", "termini", "via", "serves", "mode", "lines_max", "lines_min", "fleet_max", "budget_max", "accessibility", "line_identity", "stop_identity", "feed_validity", "population_coverage", "service_km_max", "vehicle_hours_max", "table_rows"];
// The kinds measured on dates (the full grid): all but the network's shape, identity and totals.
const TIME_KINDS = KINDS.filter((k) => !STRUCTURAL_KINDS.includes(k));
/**
 * What the models read about each kind (the extractor, the Network Studio's
 * planner, the direct mode's measure): its params, what it promises, and a
 * French example (the clauseText line). The prompts'
 * kinds lists are generated from this one table (kindsText), so a kind the
 * checker measures is a kind the model is told about, in the same words.
 * `dates…` stands for dates / from_date / to_date / period (+ region).
 */
const KIND_DOCS = {
  line_exists: { params: "{line}", doc: "a line of that name exists", fr: "« Ligne C »" },
  termini: { params: "{line, from, to}", doc: "it runs from … to … (either direction)", fr: "« Ligne A : de Gare à Hôpital »" },
  via: { params: "{line, stops: [names]}", doc: "it serves these places, in any order (for an order, stop_pattern)", fr: "« Ligne A : dessert Mairie, Hôpital »" },
  serves: { params: "{place, lat?, lon?, radius_m? (400), line?}", doc: "a place that must have a stop nearby", fr: "« Un arrêt à moins de 400 m de Lycée Balzac »" },
  headway_max: { params: '{line?, day ("weekday"|"saturday"|"sunday"|"mon"…), from "07:00", to "09:00", minutes, direction? ("0"|"1"), stop?, occurrence? (first|last|a rank), dates…}', doc: "every ≤ minutes in the window, from its start (07:00 → the first departure counts) to its end (no line = every line; no direction = each direction must hold: give one when the brief reinforces one way only, e.g. short-turns towards the centre); on the loaded feed each direction is measured at the terminus most of its trips leave from (the window is clock time there: « de 7h à 8h » is read at the departure terminus, short workings from a stop down the line are extras), or at its trunk — the stop most of its trips pass — only when its trips leave from several origins in comparable shares (branches meeting); the verdict names the stop when the trips do not all start there, and set_headway's at_stop reads its window there; with stop (a headway the brief states AT a stop, e.g. a timing point mid-line), on the departures at that stop; when a trip calls at that name several times (« Centre Bourg » in two villages), occurrence says which call the brief means — first, last or its rank among them — without it, the first call", fr: "« Ligne C : un départ au moins toutes les 10 min de 7h00 à 9h00, du lundi au vendredi »" },
  span: { params: "{line?, day, first_before?, first_after?, last_after?, last_before?, amplitude_h?, direction?, dates…}", doc: "the first departure no later than first_before (and no earlier than first_after), the last no earlier than last_after (and no later than last_before); amplitude_h: from the first to the last departure at least that many hours. « Amplitude de 6h30 à 20h30 » → first_before 06:30, last_after 20:30; « premier départ à 6h30 » exactly → first_before and first_after 06:30", fr: "« Ligne A : premier départ au plus tard à 6h30, du lundi au vendredi »" },
  days: { params: "{line?, days: [...], dates…}", doc: "runs on each of these days", fr: "« Ligne A : circule le samedi »" },
  no_service: { params: "{line?, days: [...], dates…}", doc: "runs on none of them", fr: "« Ligne A : ne circule pas le dimanche »" },
  mode: { params: "{line, mode}", doc: "the line's mode (bus, tram…)", fr: "« Ligne T1 : tram »" },
  lines_max: { params: "{count}", doc: "at most that many lines", fr: "« Au plus 5 lignes »" },
  lines_min: { params: "{count}", doc: "at least that many lines", fr: "« Au moins 3 lignes »" },
  fleet_max: { params: "{vehicles}", doc: "vehicles at the peak", fr: "« Au plus 12 véhicules »" },
  budget_max: { params: "{amount}", doc: "yearly operating cost, in the operations currency", fr: "« Un budget annuel d'au plus 1 000 000 »" },
  od_max_time: { params: "{from, to, day?, depart_at? | arrive_by?, max_minutes, dates…}", doc: "a typical trip, walk included (places as names of stops or of the territory's places, or {name, lat, lon}); at most 12 distinct timetables are measured: give dates or a period for more", fr: "« De Gare à Lycée en 30 min au plus, du lundi au vendredi »" },
  running_time: { params: "{line, from_stop, to_stop, minutes + tolerance_min (default 2) | min_minutes / max_minutes | like_day: saturday|weekday|sunday|a date (the bounds are that day's own running times over the same stops, ± tolerance_min), measure: each|median, from?, to? (window on the departure at from_stop), day?, dates…}", doc: "the scheduled time from the departure at from_stop to the arrival at to_stop, on every trip that runs from_stop then to_stop (one clause per direction). « 38 minutes environ de bout en bout » → {from_stop: first terminus, to_stop: last terminus, minutes: 38}; « en moins de 30 min » → max_minutes 30; « avec les temps de parcours du samedi » for a new Sunday timetable → {day: sunday, like_day: saturday, from_stop / to_stop: the termini} (the Saturday's own range, read before the plan)", fr: "« Ligne K : de Rue Hélène Boucher à Bois Joly en 38 min (± 2 min), chaque course, tous les jours »" },
  trips_count: { params: "{line, min? max? exactly?, per: direction|total (default each direction), direction? | towards?, at_stop?, occurrence? (first|last|a rank), from?, to?, day (default weekday), dates…}", doc: "trips a day on every timetable of the scope. « 10 allers-retours par jour » → exactly 10 per direction; « les renforts scolaires sont conservés » → at_stop of the reinforced stop, min the current count; occurrence: which call at_stop is when a trip bears that name several times (first, last or its rank), else the first call. A timetable given in full (« les départs sont … », « sans autre course », a list that replaces the old one) is also a count: exactly N per direction (at_stop, from or to for a branch), else the old trips left beside the new pass unseen", fr: "« Ligne D : au moins 7 courses par jour et par sens desservant Montebourg, du lundi au vendredi »" },
  departure_at: { params: '{line, stop, occurrence? (first|last|a rank), times: ["HH:MM"…], towards?, event: departure|arrival, tolerance_min (default 0), present (default true), day (default weekday), dates…}', doc: "a trip leaves (or arrives at) that stop at each time, going towards that stop; present false: no such trip any more (a removed trip). Always give towards when the brief names where the trip goes; occurrence: which call the stop is when a trip bears that name several times (a terminus « Centre Bourg » after two villages of that name → last), else the first call. A time that only names the trip to change (« la course de 7h40 doit arriver à 7h50 ») is not a clause: the clause is the new time the brief asks (the 07:50 arrival), never the old departure kept", fr: "« Ligne B : départs de Cherbourg-Gare à 19h35 et 20h35 vers Siouville-Hague Place des Tamaris, du lundi au vendredi à partir du 31 août 2026 »" },
  stop_pattern: { params: "{line, stops: [names in the brief's order], avoid?: [names], trips: through|all|any (default through), ends?, exact?, direction?, day?, dates…}", doc: "every trip running from the first listed stop to the last one serves the listed stops in this order (the other direction is not concerned: write its own clause when the brief states its order); avoid: stops no trip serves any more (a stop time counts as a call, whatever its pickup/drop-off type). Use it whenever the brief lists stops in an order (« A, B puis C »): `via` ignores the order", fr: "« Ligne 1 : chaque course de Bathilde Bernard à Marcel Pagnol dessert Gare SNCF, Cœur d'O puis Marché Nord, dans cet ordre, tous les jours »" },
  same_as: { params: "{line | lines, like_date | like_week, like_in?: before|after, day / dates / from_date / to_date / period (required)}", doc: "on those dates the lines run exactly the timetable of the reference day (like_week: the same weekday of that week). « y compris pendant les vacances scolaires » for a new line → {day: weekday, period: school_holidays, like_week: a school week}; « comme en juin » → like_week of a June week (before)", fr: "« Ligne K : du lundi au vendredi pendant les vacances scolaires, les mêmes horaires que la semaine du 6 octobre 2025 (jour pour jour) »" },
  unchanged_except: { params: "{line | lines (default all), except?: {lines?, from?, to?, to_included? (true | false, only when the brief says whether a departure at `to` itself is in the window), direction?, stops?, beyond?: {stop, towards}}, day / dates / from_date / to_date / period?}", doc: "(Change Studio) compared with the feed before the plan, nothing changes on those dates except what `except` names (from included; `to` read both ways unless to_included says it: a verdict that holds under one reading only is a question); except.beyond: a truncation — the stops past `stop` towards `towards` (« limitées à Portes d'Albi, aux mêmes horaires aux autres arrêts » → beyond {stop: Portes d'Albi, towards: the dropped terminus}). « le reste de la journée est inchangé » → the line, except {from, to} of the change; « aucune autre ligne ne change » → except {lines: the lines the plan changes}; « les vacances ne changent pas » → period school_holidays. Not for a new network", fr: "« Ligne C : horaires inchangés sauf entre 7h00 et 9h00 (bornes comprises), du lundi au vendredi en période scolaire à partir du 2 novembre 2026 »" },
  changed_in_scope: { params: "{line | lines, direction?, from? / to? (HH:MM: a call within the window), to_included? (true | false, only when the brief says whether a departure at `to` itself is in the window), stops?, day / dates / from_date / to_date / period?}", doc: "(Change Studio) compared with the feed before the plan on the first date of the scope — one witness date per day type —, the trips of the lines named differ in some passing: in the direction, within the window and at the stops named when the clause names them. The test of a change the brief asks: a plan that leaves what the demand names as it was fails it, whatever else it changes.", fr: "« la ligne 6 change en semaine à partir du 2 novembre, après 20h40, vers Görlitz »" },
  transfer_max_wait: { params: '{stop, radius_m? (0: the stops of that name), from_line | from_times: ["HH:MM"…], to_line | to_times, max_wait, min_wait? (default 0), each: arrival|departure (default arrival), from_direction?, to_direction?, from?, to? (window on the guaranteed calls), day (default weekday), dates…}', doc: "a guaranteed connection: every arrival of the feeder at the stop (a line, or an external timetable's arrival times, e.g. the TER arrivals the brief lists) has a departure of the other service (a line, or the external departures) between min_wait and max_wait minutes later; each departure: every departure of the other service has a feeder arrival that much earlier (a bus before every TER departure). « correspondance garantie avec le TER, 10 min au plus » → the TER times as from_times (arrivals) or to_times (departures); without the times the clause is not measurable: ask for them", fr: "« À Gare SNCF : chaque arrivée de la ligne A est suivie d'un départ de la ligne B entre 2 et 10 min plus tard, du lundi au vendredi »" },
  pickup_dropoff: { params: "{line, stops: [names] | from_stop, to_stop, direction?, on_demand: true | false | pickup, drop_off, day?, dates…}", doc: "how the calls are served (a real feed only): every trip of the line (its direction) calling at the stops named — or running the stretch from_stop → to_stop, inclusive, in its order; from_stop alone to the terminus — has the promised pickup_type and drop_off_type there. on_demand true: served on demand, by booking (TAD, transport à la demande, sur réservation, dial-a-ride: pickup or drop-off 2, a terminus keeping its none); on_demand false: regular calls (0); pickup / drop_off: regular | none | on_demand | driver (0–3) exactly, « descente seulement » → pickup none, « montée seulement » → drop_off none. « Les arrêts TAD sont prolongés jusqu'à X » towards the terminus → from_stop X, on_demand true, with the period the brief states", fr: "« Ligne 9 (direction Les Tilleuls) : arrêts desservis à la demande (sur réservation) de Moulin Neuf au terminus, pendant les vacances scolaires »" },
  shape_follows: { params: "{line, direction?, from_stop, to_stop, like_line, like_direction?, tolerance_m (default 30), day?, dates…}", doc: "(a real feed only) between the two stops, the shape of every trip of the line running from_stop then to_stop stays within tolerance_m of the reference line's shape between the same stops, both ways round (a straight line where the reference bends fails; a trip without a shape fails); the reference is read in the feed before the plan when there is one. « La ligne 13 reprend l'itinéraire de la N4 entre Görlitz et Bel Air » → {line: 13, from_stop: Görlitz, to_stop: Bel Air, like_line: N4}, one clause per direction", fr: "« Ligne 13 (vers Glisy) : entre Görlitz et Bel Air, le tracé suit celui de la ligne N4 (à 30 m près) »" },
  accessibility: { params: "{stops?: [names] | line?, measure: stops|trips (default stops), min_pct (default 100), day / dates / from_date / to_date / period? (measure trips: the trips running then), unchanged?: true (measure trips: as in the feed before the plan on those dates)}", doc: "stops: the share of the stops named (a station counts with its platforms; a platform without its own value takes its station's) or served by the line (every line without either) with wheelchair_boarding 1; trips: the share of the line's trips with wheelchair_accessible 1 (a real feed only) — dated, the trips running on those dates; unchanged: every trip running on those dates keeps the accessibility it had before the plan (« inchangé avant le 4 janvier » → {line, measure: trips, unchanged: true, to_date: 2027-01-03})", fr: "« Arrêts Gare et Mairie accessibles en fauteuil roulant »" },
  line_identity: { params: "{line?, short_name?, long_name?, color? (6-digit hex), text_color?, unchanged?: true | [fields], except?: [lines]}", doc: "the line's public number, name and colours are the values given (unchanged: as in the feed before the plan; without a line, unchanged holds every line but those except names: none renumbered, renamed or recoloured). A renumbered line is found by its new number, its route id or its old number in the feed before: « la ligne R devient la ligne 5 (même couleur) » → {line: R, short_name: 5, unchanged: [color]}", fr: "« Ligne R : numéro 5, couleur inchangée »" },
  stop_identity: { params: "{stop? (name or id), name?, code?, unchanged?: true | [name, code], except?: [stops]}", doc: "every stop of that name or id (a station with its platforms) bears the name or code given (unchanged: as in the feed before the plan; without a stop, unchanged holds every stop but those except names: none renamed); a renamed stop is found by its old name in the feed before", fr: "« L'arrêt Hôpital - Médiathèque s'appelle Hôpital – Pôle Santé »" },
  feed_validity: { params: "{from?, to? (YYYY-MM-DD), unchanged?: true}", doc: "the feed's service covers the period: its calendars run from no later than `from` to no earlier than `to`, and feed_info (when given) agrees; unchanged: the validity stays the one of the feed before the plan. « prolongée jusqu'au 31 août 2027 » → to 2027-08-31", fr: "« Données valables jusqu'au 31 août 2027 »" },
  population_coverage: { params: "{min_pct, radius_m? (400), line?}", doc: "the share of the territory's residents living within radius_m of a stop the network (or the line) serves is at least min_pct (the territory's population grid; unknown without it)", fr: "« 80 % des habitants à moins de 400 m d'un arrêt »" },
  service_km_max: { params: "{km, line?}", doc: "commercial vehicle-km a year, from the operations estimate (a line: its own share when the estimate gives one)", fr: "« Au plus 750 000 km commerciaux par an »" },
  vehicle_hours_max: { params: "{hours, line?}", doc: "vehicle-hours a year, from the operations estimate", fr: "« Au plus 40 000 heures de service par an »" },
  table_rows: { params: "{table, line?, where?: {column: value | [values]}, expect?: {column: value | [values]}, min? max? exactly? | absent: true, changed?: true | false}", doc: "(a real feed only) the rows of a GTFS table the product edits, the table and its columns by their GTFS names (trips, trip_headsign; a name the product does not edit makes the clause not measurable) — those where selects by equality (a list: any of its values; no where: every row; line: the rows of that line, a table with route_id or trip_id) — hold every value of expect (no row selected fails), number min…max (exactly; absent: none), or differ from (changed true) / equal (changed false) the feed before the plan, every column of every row. Values read as GTFS text: trimmed, empty and missing alike, numbers as numbers (ids as text), dates as YYYYMMDD. For what no other kind reads: a fare's price or a free fare (fare_attributes, fare_products), a headsign (trips.trip_headsign, stop_times.stop_headsign), a trip's short name or direction_id, a timepoint, continuous stops, a stop's zone, platform, level or parent station, levels and pathways, networks and route_networks, translations, attributions, GTFS-Flex booking rules and location groups. An id renamed: two clauses, the old id absent and the new one present (min 1); « les tarifs ne changent pas » → {table: fare_attributes, changed: false}", fr: "« trips de la ligne 5 : chaque enregistrement a trip_headsign = « Gare SNCF » »" },
};

/**
 * The kinds list the prompts insert: one line per kind, "- kind {params} —
 * what it promises. e.g. « French line »", for `kinds` (default: every kind).
 */
const kindsText = ({ kinds = KINDS, examples = true } = {}) =>
  [...kinds.filter((k) => KIND_DOCS[k]).map((k) => `- ${k} ${KIND_DOCS[k].params} — ${KIND_DOCS[k].doc}${examples && KIND_DOCS[k].fr ? `. e.g. ${KIND_DOCS[k].fr}` : ""}`), "(dates… = dates [YYYY-MM-DD…], from_date / to_date (inclusive), period: school_days | school_holidays | public_holidays | a period of the plan's calendars, with region for a school zone.)"].join("\n");

/** How the brief's weekdays become clauses: the sentence every prompt carries. */
const WEEKDAY_RULE = "Weekdays: « du lundi au vendredi » is day weekday, which includes the school holidays; « en période scolaire » adds period school_days (and region); « pendant les vacances » adds period school_holidays. Never leave out a period the brief states, never add one it does not.";
const LEVELS = ["must", "should"];
const STATUSES = ["stated", "assumed", "confirmed", "waived"];
// A contract read from offer sheets (a specification per line: its times at each timing stop, its headways, its
// counts, per direction and day type) holds some thirty clauses a line: the cap leaves room for a network's worth.
const MAX_CLAUSES = 240;

// ── Normalisation ─────────────────────────────────────────────────────────

// A stable id from a clause's content: the same clause sent again (without
// an id) upserts itself instead of piling up under a fresh number.
const contentId = (kind, params) => {
  const text = JSON.stringify(params || {}, Object.keys(params || {}).sort());
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `${kind}_${h.toString(36)}`;
};

// The NAMED decision of a user on a clause (a waiver or a confirmation): kept
// only when it names who decided (services/acknowledgement.NAME_OK — required
// lazily, that module reads unmetMust from here).
const decisionOf = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const name = raw.by && typeof raw.by === "object" ? raw.by.name : null;
  if (!require("../acknowledgement").NAME_OK(name)) return null;
  const userId = raw.by.user_id;
  return {
    by: { name: name.trim(), ...(typeof userId === "string" && userId.trim() ? { user_id: clip(userId.trim(), 64) } : {}) },
    ...(str(raw.at) ? { at: clip(str(raw.at), 40) } : {}),
    ...(DECISION_ACTIONS.includes(raw.action) ? { action: raw.action } : {}),
    ...(str(raw.reason) ? { reason: clip(str(raw.reason), 200) } : {}),
  };
};
// What a person did with a clause at ② (the contract): kept as extracted, corrected, or waived.
const DECISION_ACTIONS = ["keep", "correct", "waive"];

// The kinds whose params are put in one canonical form (the others' params
// are kept as sent, so their content ids stay what they were).
const CANONICAL_KINDS = ["running_time", "trips_count", "departure_at", "stop_pattern", "same_as", "unchanged_except", "transfer_max_wait", "accessibility", "line_identity", "pickup_dropoff", "shape_follows", "changed_in_scope", "table_rows"];

/**
 * The params of the trip-level kinds in one form, before the content id is
 * computed (the same promise written twice upserts itself): a name list
 * given as a string becomes a list; line + lines merge into lines for the
 * relational kinds; running_time's from / to that are not times are its
 * stops; exactly becomes min = max; like holding a date is like_date;
 * times written « 7h40 » or « 7:40 » become "07:40" (an external
 * timetable's from_times / to_times too); a colour loses its « # » and is
 * written in capitals; table_rows names its table in lower case (« trips.txt »
 * is trips), writes its count as min / max (count: { min, max, exactly } or a
 * number, absent: true as none) and its changed as a boolean.
 */
const canonicalParams = (kind, params) => {
  if (!CANONICAL_KINDS.includes(kind)) return params;
  const p = { ...params };
  const asList = (o, k) => {
    if (typeof o[k] === "string" && o[k].trim()) o[k] = [o[k].trim()];
  };
  const clock = (o, k) => {
    if (typeof o[k] === "string" && clockText(o[k])) o[k] = clockText(o[k]);
  };
  if (kind === "same_as" || kind === "unchanged_except") {
    asList(p, "lines");
    if (str(p.line)) {
      p.lines = [...new Set([...(Array.isArray(p.lines) ? p.lines : []), str(p.line)])];
      delete p.line;
    }
  }
  ["stops", "avoid"].forEach((k) => asList(p, k));
  for (const k of ["times", "from_times", "to_times"]) if (given(p[k])) p[k] = timesOf(p[k]).map((t) => clockText(t) || t);
  for (const k of ["color", "text_color"]) if (kind === "line_identity" && typeof p[k] === "string") p[k] = p[k].trim().replace(/^#/, "").toUpperCase();
  if (kind === "table_rows") tableRowsForm(p);
  if (kind === "running_time") {
    for (const [k, stop] of [["from", "from_stop"], ["to", "to_stop"]]) {
      if (given(p[k]) && clockOf(p[k]) == null && !given(p[stop])) {
        p[stop] = p[k];
        delete p[k];
      }
    }
  }
  if (num(p.exactly) != null) {
    p.min = num(p.exactly);
    p.max = num(p.exactly);
    delete p.exactly;
  }
  if (given(p.like) && !given(p.like_date) && !given(p.like_week) && parseYmd(p.like)) {
    p.like_date = p.like;
    delete p.like;
  }
  ["from", "to"].forEach((k) => clock(p, k));
  // unchanged_except's carve-out is an object; the identity kinds' `except` a list of names.
  if (typeof p.except === "string" && p.except.trim()) p.except = [p.except.trim()];
  if (p.except && typeof p.except === "object" && !Array.isArray(p.except)) {
    p.except = { ...p.except };
    ["lines", "stops"].forEach((k) => asList(p.except, k));
    ["from", "to"].forEach((k) => clock(p.except, k));
    // The scopes of except.trips in the same form, each its own lines and window.
    if (Array.isArray(p.except.trips)) {
      p.except.trips = p.except.trips.filter((x) => x && typeof x === "object").map((x) => {
        const y = { ...x };
        asList(y, "lines");
        ["from", "to"].forEach((k) => clock(y, k));
        if (given(y.times)) y.times = timesOf(y.times).map((t) => clockText(t) || t);
        return y;
      });
    }
  }
  return p;
};

// table_rows' count as min / max (the generic rule below turns exactly into both), its table and changed in one form.
const tableRowsForm = (p) => {
  if (typeof p.table === "string") p.table = tableOf(p);
  if (p.count != null) {
    const n = p.count && typeof p.count === "object" && !Array.isArray(p.count) ? p.count : { exactly: p.count };
    for (const k of ["min", "max", "exactly"]) if (!given(p[k]) && given(n[k])) p[k] = n[k];
    delete p.count;
  }
  if (p.absent === true || p.absent === "true") {
    if (!given(p.min)) p.min = 0;
    p.max = 0;
  }
  delete p.absent;
  if (p.changed === "true" || p.changed === "false") p.changed = p.changed === "true";
};

// A kind this checker does not know is KEPT (a promise of the brief never
// vanishes silently): it is reported "unknown", "unsupported clause kind".
// A user's decision travels as `decided_by: "user"` plus the record of who
// decided, `decision: { by: { name, user_id? }, at?, reason? }`: a waiver or
// a confirmation stays one ONLY with both — an anonymous waiver (no named
// decision, or not the user's) is demoted to "stated" and measured like any
// other clause, so nothing lifts a promise of the brief without a name (G4).
const normalizeClause = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const kind = str(raw.kind)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (!kind) return null;
  const params = canonicalParams(kind, raw.params && typeof raw.params === "object" ? JSON.parse(JSON.stringify(raw.params)) : {});
  const decision = decisionOf(raw.decision);
  return {
    id: clip(str(raw.id) || contentId(kind, params), 48),
    kind,
    level: LEVELS.includes(raw.level) ? raw.level : "must",
    status: raw.status === "waived" || raw.status === "confirmed" ? (raw.decided_by === "user" && decision ? raw.status : "stated") : raw.status === "assumed" ? "assumed" : "stated",
    ...(str(raw.text) ? { text: clip(str(raw.text), 200) } : {}),
    ...(str(raw.source) ? { source: clip(str(raw.source), 120) } : {}),
    ...(raw.decided_by === "user" ? { decided_by: "user" } : {}),
    ...(decision ? { decision } : {}),
    ...(str(raw.reason) ? { reason: clip(str(raw.reason), 200) } : {}),
    // The words of the brief the clause comes from (the coverage detector, G5, maps them onto its sentences).
    ...(str(raw.quote) ? { quote: clip(str(raw.quote), 400) } : {}),
    ...(Number.isInteger(raw.page) && raw.page > 0 ? { page: raw.page } : {}),
    ...(str(raw.document) ? { document: clip(str(raw.document), 160) } : {}),
    params,
  };
};

// What the model may say of a clause: its statement or assumption, never a
// decision (a waiver, a confirmation, who decided).
const modelClause = (raw) => (raw && typeof raw === "object" ? { ...raw, status: raw.status === "assumed" ? "assumed" : "stated", decided_by: undefined, decision: undefined } : raw);

/**
 * Merge the clauses a turn sends into those already recorded: upsert by id,
 * `remove` drops ids. A clause the USER decided (confirmed or waived) is
 * returned whole: nothing overturns or reshapes it. With `{ by: "model" }`
 * (the Network Studio planner's set_requirements) the sender is the
 * model: its statuses are forced to stated | assumed and its decisions
 * stripped, an existing clause never drops from must to should, the KIND of
 * a recorded must clause never changes (the upsert is dropped and its id
 * pushed to `kindKept`: a new promise is a new clause), and `remove` drops
 * only clauses that are neither user-decided nor must-level (a promise of
 * the brief never vanishes silently — the model corrects a wrong extraction
 * by upserting its params or text instead). With `lang`, a clause sent
 * without text gets its line in that language (clauseText). The record holds
 * MAX_CLAUSES: the recorded clauses come first, in their order, then the new
 * ones in theirs, and what lies past the bound is never left out in silence —
 * its ids are pushed to `leftOut` when the caller gives that list (the caller
 * refuses the proposal with them), else said in the server log.
 */
const mergeClauses = (previous = [], incoming = [], remove = [], { by = "user", lang = null, kindKept = null, leftOut = null } = {}) => {
  const model = by === "model";
  const out = new Map((previous || []).filter(Boolean).map((c) => [c.id, c]));
  for (const id of remove || []) {
    const prev = out.get(id);
    if (!prev || prev.decided_by === "user" || (model && prev.level === "must")) continue;
    out.delete(id);
  }
  (incoming || []).forEach((raw) => {
    const c = normalizeClause(model ? modelClause(raw) : raw);
    if (!c) return;
    const prev = out.get(c.id);
    if (prev && prev.decided_by === "user") return;
    if (model && prev && prev.level === "must" && prev.kind !== c.kind) {
      if (Array.isArray(kindKept) && !kindKept.includes(c.id)) kindKept.push(c.id);
      return;
    }
    if (model && prev && prev.level === "must" && c.level === "should") c.level = "must";
    if (lang && !c.text) {
      const text = require("../transform/clauseText").clauseText(c, lang);
      if (text) c.text = clip(text, 200);
    }
    out.set(c.id, c);
  });
  const all = [...out.values()];
  const dropped = all.slice(MAX_CLAUSES).map((c) => c.id);
  if (dropped.length) {
    if (Array.isArray(leftOut)) leftOut.push(...dropped);
    else console.warn(`conformanceService.mergeClauses: ${dropped.length} clause(s) past the bound of ${MAX_CLAUSES} left out of the record: ${dropped.join(", ")}`);
  }
  return all.slice(0, MAX_CLAUSES);
};

/**
 * The must clauses a verdict does not meet — failing, or not measurable
 * ("unknown": a place not located, a kind this checker does not know, a
 * checker that threw) — as acknowledgement items. The single definition of
 * "not met" for the gates (change commit, network compile, project approval)
 * and the verdict: a clause that cannot be measured is not met.
 *   → [{ kind: "clause", id, status: "fail" | "unknown", text, expected, measured, note }]
 */
const unmetMust = (conformance) =>
  (conformance?.results || [])
    .filter((r) => r && r.level === "must" && (r.status === "fail" || r.status === "unknown"))
    .map((r) => ({ kind: "clause", id: r.id, status: r.status, text: r.text || null, expected: r.expected ?? null, measured: r.measured ?? null, note: r.note || null }));

/** The clauses to check: the explicit ones, plus those implied by lines_requested. */
const clausesOf = (requirements) => {
  if (!requirements || typeof requirements !== "object") return [];
  const explicit = (Array.isArray(requirements.clauses) ? requirements.clauses : []).map(normalizeClause).filter(Boolean);
  const have = new Set(explicit.map((c) => c.id));
  const coveredLines = new Set(explicit.filter((c) => ["line_exists", "termini", "via"].includes(c.kind)).map((c) => nameKey(c.params.line)));
  const derived = [];
  for (const l of Array.isArray(requirements.lines_requested) ? requirements.lines_requested : []) {
    const name = str(l?.name);
    if (!name || coveredLines.has(nameKey(name))) continue;
    const base = `req_${nameKey(name).replace(/ /g, "_")}`;
    const push = (c) => !have.has(c.id) && derived.push({ level: "must", status: "stated", source: "brief", ...c });
    push({ id: `${base}_exists`, kind: "line_exists", params: { line: name }, text: `Line ${name}` });
    if (str(l.from) && str(l.to)) push({ id: `${base}_termini`, kind: "termini", params: { line: name, from: str(l.from), to: str(l.to) }, text: `Line ${name}: ${str(l.from)} ↔ ${str(l.to)}` });
    const via = (Array.isArray(l.via) ? l.via : []).map(str).filter(Boolean);
    if (via.length) push({ id: `${base}_via`, kind: "via", params: { line: name, stops: via }, text: `Line ${name} via ${via.join(", ")}` });
  }
  return [...explicit, ...derived];
};

// ── Lints: what the model is told about its clauses, never a block ─────────

const DATING = ["dates", "from_date", "to_date", "period"];
const datingOf = (params) => DATING.filter((k) => given(params?.[k]));

// What each trip-level kind needs to be measured (else it is unknown).
const MISSING = {
  running_time: (p) => [!str(p.line) && "line", !given(p.from_stop) && "from_stop", !given(p.to_stop) && "to_stop", num(p.minutes) == null && num(p.min_minutes) == null && num(p.max_minutes) == null && !given(p.like_day) && "minutes (or min_minutes / max_minutes, or like_day)"].filter(Boolean),
  shape_follows: (p) => [!str(p.line) && "line", !given(p.from_stop) && "from_stop", !given(p.to_stop) && "to_stop", !str(p.like_line) && "like_line"].filter(Boolean),
  trips_count: (p) => [!str(p.line) && "line", num(p.min) == null && num(p.max) == null && num(p.exactly) == null && "min, max or exactly"].filter(Boolean),
  departure_at: (p) => [!str(p.line) && "line", !given(p.stop) && "stop", !timesOf(p.times).length && "times"].filter(Boolean),
  stop_pattern: (p) => [!str(p.line) && "line", listOf(p.stops).length < 2 && !listOf(p.avoid).length && "stops (at least two) or avoid"].filter(Boolean),
  same_as: (p) => [!given(p.like_date) && !given(p.like_week) && "like_date or like_week", !given(dayWordsOf(p)) && !datingOf(p).length && "a day, dates or period"].filter(Boolean),
  changed_in_scope: (p) => [!listOf(p.lines).length && !str(p.line) && "line or lines"].filter(Boolean),
  transfer_max_wait: (p) => [!given(p.stop) && "stop", !str(p.from_line) && !given(p.from_times) && "from_line or from_times (the arrivals: an external timetable's times when the brief lists them)", !str(p.to_line) && !given(p.to_times) && "to_line or to_times", num(p.max_wait) == null && "max_wait"].filter(Boolean),
  line_identity: (p) => [!str(p.line) && !given(p.unchanged) && "line (or unchanged, for every line)", !["short_name", "long_name", "color", "text_color"].some((k) => given(p[k])) && !given(p.unchanged) && "short_name, long_name, color, text_color or unchanged"].filter(Boolean),
  stop_identity: (p) => [!given(p.stop) && !given(p.unchanged) && "stop (or unchanged, for every stop)", !given(p.name) && !given(p.code) && !given(p.unchanged) && "name, code or unchanged"].filter(Boolean),
  feed_validity: (p) => [!given(p.from) && !given(p.to) && !given(p.from_date) && !given(p.to_date) && !given(p.unchanged) && "from, to or unchanged"].filter(Boolean),
  population_coverage: (p) => [num(p.min_pct) == null && "min_pct"].filter(Boolean),
  service_km_max: (p) => [num(p.km) == null && "km"].filter(Boolean),
  vehicle_hours_max: (p) => [num(p.hours) == null && "hours"].filter(Boolean),
  table_rows: (p) => paramProblems(p),
};
// The kinds whose `unchanged` compares with the feed before the plan (none on a new network).
const UNCHANGED_KINDS = ["line_identity", "stop_identity", "feed_validity", "accessibility"];

/**
 * Non-blocking lints on a turn's clauses, for the model's tool result:
 * incomplete params per kind and, on a designed network (`network`), the
 * kinds that need a feed before the plan (unchanged_except, changed_in_scope,
 * table_rows, an `unchanged` identity). They never change a clause.
 */
const clauseLints = (clauses, { network = false } = {}) => {
  const out = [];
  for (const raw of clauses || []) {
    const c = normalizeClause(raw);
    if (!c) continue;
    const p = c.params || {};
    const missing = MISSING[c.kind] ? MISSING[c.kind](p) : [];
    if (missing.length) out.push(`${c.kind} ${c.id} needs ${missing.join(" and ")}: it is not measurable without`);
    if (network && c.kind === "table_rows") out.push(`table_rows ${c.id} is not measurable on a new network (a designed network has no GTFS tables to read): write what must hold with the network's kinds`);
    if (network && (c.kind === "unchanged_except" || c.kind === "changed_in_scope")) out.push(`${c.kind} ${c.id} is not measurable on a new network (no feed before the plan to compare with): write what must hold instead`);
    if (network && UNCHANGED_KINDS.includes(c.kind) && given(p.unchanged) && p.unchanged !== false) out.push(`${c.kind} ${c.id} says unchanged, which a new network cannot be measured on (no feed before the plan): give the values instead`);
  }
  return out;
};

module.exports = { KINDS, NETWORK_KINDS, STRUCTURAL_KINDS, TIME_KINDS, KIND_DOCS, kindsText, WEEKDAY_RULE, LEVELS, STATUSES, MAX_CLAUSES, normalizeClause, mergeClauses, unmetMust, clausesOf, datingOf, clauseLints };
