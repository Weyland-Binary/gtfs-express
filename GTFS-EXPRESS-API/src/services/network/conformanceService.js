/**
 * conformanceService — does the network do what the user asked?
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
 *                 (transform/unchangedClauses)
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
 *
 * The time clauses (every kind but line_exists, termini, via, serves, mode,
 * lines_max, lines_min, fleet_max, budget_max and the identity, accessibility,
 * validity, coverage and volume kinds) are measured on EVERY
 * distinct timetable of their scope, never a sample (gridOf): the dates of
 * their window — `dates`, `from_date` / `to_date` (inclusive), `period`
 * (school_days, school_holidays, public_holidays or a period the plan's
 * calendars define) or, undated, the whole validity from `today` — whose day
 * type they ask, grouped by the services the measured line runs that date.
 * The worst timetable decides; `measured_on` lists one date per timetable
 * and `grid` counts them. A Monday is a Monday: a weekday of the school
 * holidays is a weekday (only a public holiday is retyped, feedView). On a
 * designed network without dates, the grid is structural: the calendars of
 * a day word, split into school term and school holidays when the design
 * has school calendars. The relational kinds (same_as, unchanged_except, and
 * the identity and validity kinds with `unchanged`) compare with a BASELINE,
 * the feed before the plan (ctx.baseline); without one they are unknown.
 * A clause of a kind this checker does not know is kept and reported
 * "unknown" ("unsupported clause kind: …"), counted in summary.unsupported.
 *
 * Directions: a clause's `direction` (except.direction, from_direction,
 * to_direction, and a `towards` written « Origin → Destination ») is read on
 * the line's own patterns (directionIn): its id ("0", "1"), a destination
 * (the direction whose trips end there or bear it as their headsign: « vers
 * … », « direction de Pélissier », « en direction de la Gare » — the « de »
 * after a direction word is an article, never an origin), an
 * origin (« depuis Les Tilleuls », « au départ de … », « from … », « A → »:
 * the direction whose trips start there) or a label « Renaudié → Portes
 * d'Albi » (whose trips run from the one to the other); the verdict names the
 * id beside the words. A direction no trip reaches, or one every direction
 * reaches, makes the clause unknown with its reason — a promise about one
 * direction is never measured over all of them (an except.direction
 * compared with the ids "0" and "1" would carve nothing out and fail on the
 * very trips the plan was asked to change), nor over the other one: a name
 * is a stop's when the words hold it whole, never a stop whose name is only
 * a part of them (read as a destination, « depuis Les Tilleuls » would be
 * the way back).
 * At a stop, a departure is a call a trip leaves from — never its last call,
 * where it arrives and ends — and an arrival one it reaches, never its first
 * (on a loop, its return): a headway or a departure time at a terminus is
 * never read on the arrivals of the trips that end there, and a headway at a
 * stop the trips only end at has nothing to measure — unknown, said why,
 * unless the line left from it before the plan (then it fails).
 *
 * `checkConformance(spec, requirements, { tables, operations, territory, today, baseline })`
 * returns a verdict per clause — pass, fail, unknown (cannot be measured
 * here, e.g. a place that cannot be located) or waived (the user lifted
 * it) — with what was expected, what was measured and the lines/stops
 * concerned, plus a summary and `conforms` (no "must" clause failing).
 * Deterministic and offline: the same spec and brief give the same verdict,
 * so it serves as the planner's objective, the Studio's checklist, the
 * built network's report and an evaluation oracle.
 *
 * Places (serves, via, termini, od_max_time) are located on authority, and
 * each verdict says which (`located_by`): the clause's coordinates, then the
 * territory's named places and existing stops, then the places the designer
 * located on purpose (referenceStops), then the network's stops of that
 * name — ground truth on a real feed ("feed"), a mere candidate on a
 * designed plan ("plan_stop"). A stop named after a place never outweighs
 * an authoritative location of it: `serves` fails when the nearest served
 * stop is beyond the radius, whatever its name, and is "unknown" when only
 * the plan's own homonymous stop locates the place.
 *
 * A brief without clauses still gets checked: its `lines_requested` (name,
 * from, to, via) are turned into line_exists / termini / via clauses.
 */

"use strict";

const networkSpec = require("./networkSpec");
const { haversineMeters } = require("../../utils/geoUtils");
const { tripsOf, tripsOnDate: tripsOnDateOf, patternTrips, stopKeys, indexIn, passings, multisetDiff } = require("./clauseTrips");

const { departuresOf, _internals: specInternals } = networkSpec;
const { timeToSec, secToTime, nameKey } = specInternals;

const KINDS = ["line_exists", "termini", "via", "serves", "headway_max", "span", "days", "no_service", "mode", "lines_max", "lines_min", "fleet_max", "budget_max", "od_max_time", "running_time", "trips_count", "departure_at", "stop_pattern", "same_as", "unchanged_except", "transfer_max_wait", "accessibility", "line_identity", "stop_identity", "feed_validity", "population_coverage", "service_km_max", "vehicle_hours_max", "pickup_dropoff", "shape_follows"];
// The kinds a designed network can be held to: unchanged_except needs a feed before the plan.
const NETWORK_KINDS = KINDS.filter((k) => k !== "unchanged_except");
// The kinds of the network's shape, identity and totals: measured once, never on dates.
const STRUCTURAL_KINDS = ["line_exists", "termini", "via", "serves", "mode", "lines_max", "lines_min", "fleet_max", "budget_max", "accessibility", "line_identity", "stop_identity", "feed_validity", "population_coverage", "service_km_max", "vehicle_hours_max"];
// The kinds measured on dates (the full grid): all but the network's shape, identity and totals.
const TIME_KINDS = KINDS.filter((k) => !STRUCTURAL_KINDS.includes(k));
/**
 * What the planners and the extractor read about each kind: its params, what
 * it promises, and a French example (the clauseText line). The prompts'
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
  unchanged_except: { params: "{line | lines (default all), except?: {lines?, from?, to?, direction?, stops?, beyond?: {stop, towards}}, day / dates / from_date / to_date / period?}", doc: "(Change Studio) compared with the feed before the plan, nothing changes on those dates except what `except` names (bounds inclusive); except.beyond: a truncation — the stops past `stop` towards `towards` (« limitées à Portes d'Albi, aux mêmes horaires aux autres arrêts » → beyond {stop: Portes d'Albi, towards: the dropped terminus}). « le reste de la journée est inchangé » → the line, except {from, to} of the change; « aucune autre ligne ne change » → except {lines: the lines the plan changes}; « les vacances ne changent pas » → period school_holidays. Not for a new network", fr: "« Ligne C : horaires inchangés sauf entre 7h00 et 9h00 (bornes comprises), du lundi au vendredi en période scolaire à partir du 2 novembre 2026 »" },
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
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_WORDS = { weekday: null, weekdays: null, workday: null, saturday: ["sat"], sunday: ["sun"], weekend: null, daily: DAY_KEYS };
const PLACE_RADIUS_M = 400;
const TERMINUS_RADIUS_M = 300;
const DAY_S = 24 * 3600;
// The minute within which the trip operators match a time given (transform/selection.js: ± 60 s).
const OPERATOR_MINUTE_S = 60;
// A contract read from offer sheets (a specification per line: its times at each timing stop, its headways, its
// counts, per direction and day type) holds some thirty clauses a line: the cap leaves room for a network's worth.
const MAX_CLAUSES = 240;

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

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
const CANONICAL_KINDS = ["running_time", "trips_count", "departure_at", "stop_pattern", "same_as", "unchanged_except", "transfer_max_wait", "accessibility", "line_identity", "pickup_dropoff", "shape_follows"];

/**
 * The params of the trip-level kinds in one form, before the content id is
 * computed (the same promise written twice upserts itself): a name list
 * given as a string becomes a list; line + lines merge into lines for the
 * relational kinds; running_time's from / to that are not times are its
 * stops; exactly becomes min = max; like holding a date is like_date;
 * times written « 7h40 » or « 7:40 » become "07:40" (an external
 * timetable's from_times / to_times too); a colour loses its « # » and is
 * written in capitals.
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
 * (the planners' set_requirements / set_plan / patch_plan) the sender is the
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
 * its ids are pushed to `leftOut` when the caller gives that list (the planners
 * refuse the proposal with them), else said in the server log.
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

// ── Resolution: lines, places, days ───────────────────────────────────────

// A line the brief names: its public number first, then its id, then its long name. The number
// wins over an id: in a real feed a route's id can be another line's number (Cholet: route id 4
// is line 3, route id 2 is line 4), and a brief names the number.
const findLine = (spec, ref) => {
  const k = nameKey(ref);
  if (!k) return null;
  const lines = spec.lines || [];
  const found = lines.find((l) => nameKey(l.short_name) === k) || lines.find((l) => nameKey(l.id) === k) || lines.find((l) => nameKey(l.long_name) === k);
  if (found) return found;
  // The labels the engine's question about a line offers (resolve.route), written back as the answer: « 3 —
  // Gare ↔ Hôpital » (its number and long name), « 3 (R3a) » or « 3 — Gare ↔ Hôpital (R3a) » where two lines share
  // a label — the line they name, its id read against the ids the feed has (an id may hold brackets of its own).
  const label = (l) => `${l.short_name || l.id}${l.long_name ? ` — ${l.long_name}` : ""}`;
  const raw = String(ref).trim();
  const withId = raw.endsWith(")") ? lines.find((l) => raw.endsWith(` (${l.id})`) && [label(l), l.short_name || l.id].some((x) => nameKey(x) === nameKey(raw.slice(0, -` (${l.id})`.length)))) : null;
  if (withId) return withId;
  const labelled = lines.filter((l) => l.long_name && nameKey(label(l)) === k);
  if (labelled.length === 1) return labelled[0];
  // The forms the engine's own resolver reads (transform/resolve route: a clause names a line as the plan does, so
  // the measure finds « Ligne 1 » and « Rapid'Ouest » where the plan runs on them, never « no such line »): the
  // number once « ligne » is taken off (« Ligne 1 » is line 1; « L1 » read as written first, a line may be called
  // so), the number in brackets after a name (« Rapid'Ouest (RO) »), then a name the long name holds as whole words
  // (« Rapid'Ouest » in « RAPID OUEST DUNKERQUE GARE - … »), one line only — never a guess between two.
  const bare = nameKey(raw.replace(/^(ligne|line|route|l)\s*/i, ""));
  if (bare && bare !== k) {
    const byBare = lines.find((l) => nameKey(l.short_name) === bare) || lines.find((l) => nameKey(l.id) === bare);
    if (byBare) return byBare;
  }
  const bracket = raw.match(/^(.*\S)\s*\(([^()]+)\)\s*$/);
  if (bracket) {
    const num = nameKey(bracket[2]);
    const byNumber = lines.filter((l) => nameKey(l.short_name) === num || nameKey(l.id) === num);
    if (byNumber.length === 1) return byNumber[0];
    const byName = findLine(spec, bracket[1]);
    if (byName) return byName;
  }
  if (k.length >= 4) {
    const within = lines.filter((l) => l.long_name && ` ${nameKey(l.long_name)} `.includes(` ${k} `));
    if (within.length === 1) return within[0];
  }
  return null;
};
/** The same line in another feed (the feed before a plan): by its id, else by its number. */
const pairedLine = (spec, line) => (spec.lines || []).find((l) => l.id === line.id) || findLine(spec, line.short_name);

const nameMatches = (a, b) => {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && ` ${long} `.includes(` ${short} `);
};

// Who says where a place is, strongest first. The first three are
// AUTHORITATIVE: they overrule a stop's name. The feed's own stops are
// ground truth for a real feed; a designed plan's own stop named after a
// place is only a candidate (a plan cannot prove it serves the hospital by
// naming a stop "Hospital").
const AUTHORITIES = ["coordinates", "territory", "design", "feed", "plan_stop"];
const AUTHORITATIVE = new Set(["coordinates", "territory", "design"]);
const PLAN_STOP_NOTE = "place located only by the plan's own stop: confirm its position";
const weakest = (list) => list.filter(Boolean).sort((a, b) => AUTHORITIES.indexOf(b) - AUTHORITIES.indexOf(a))[0] || null;

// Every entry of a list named like the place: exact names first, else the partial matches.
const namedLike = (list, name) => {
  const k = nameKey(name);
  const located = (list || []).filter((s) => s && Number.isFinite(num(s.lat)) && Number.isFinite(num(s.lon)));
  const exact = located.filter((s) => nameKey(s.name) === k || (s.id != null && nameKey(s.id) === k));
  return exact.length ? exact : located.filter((s) => nameMatches(s.name, name));
};

/**
 * A place of the brief as a point, and on whose authority (`via`):
 * explicit coordinates → a named place or existing stop of the territory
 * (the OSM dossier) → a place the designer located on purpose
 * (referenceStops) → the stops of the network of that name: "feed" when
 * they are a real feed's (ground truth), "plan_stop" when they are the
 * designed plan's own (a candidate only). `points` lists every match (a
 * name may stand for both sides of a street). null when it cannot be
 * located: the clause is then "unknown", never a guess.
 */
const locate = (ref, spec, territory, referenceStops = null, stopsAuthority = "plan") => {
  let name = ref;
  if (ref && typeof ref === "object") {
    const lat = num(ref.lat);
    const lon = num(ref.lon);
    if (lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) return { lat, lon, name: str(ref.name) || null, via: "coordinates", points: [{ lat, lon, name: str(ref.name) || null }] };
    name = ref.name;
  }
  name = str(name);
  if (!name) return null;
  const hit = (list, via) => {
    const found = namedLike(list, name);
    if (!found.length) return null;
    const points = found.map((s) => ({ lat: num(s.lat), lon: num(s.lon), name: s.name, ...(s.id != null ? { id: s.id } : {}) }));
    return { lat: points[0].lat, lon: points[0].lon, name: points[0].name, via, points };
  };
  return hit([...(territory?.pois?.items || []), ...(territory?.existing_stops || [])], "territory") || hit(referenceStops, "design") || hit(spec.stops, stopsAuthority === "feed" ? "feed" : "plan_stop");
};

/** Metres from a stop to the nearest point of a located place. */
const distanceTo = (stop, place) => Math.min(...place.points.map((p) => haversineMeters(stop.lat, stop.lon, p.lat, p.lon)));

/** locate() with the check's context: a real feed's stops are ground truth. */
const locateIn = (ctx, ref) => locate(ref, ctx.spec, ctx.territory, ctx.referenceStops, ctx.stopsAuthority);

/** The stop of a list nearest to a located place: { stop, d } | null. */
const nearestTo = (stops, place) => {
  let best = null;
  for (const s of stops) {
    if (!s || s.lat == null) continue;
    const d = distanceTo(s, place);
    if (!best || d < best.d) best = { stop: s, d };
  }
  return best;
};

/** Days a day word names, following the local weekend. */
const daysOf = (raw, spec) => {
  const weekend = Array.isArray(spec.weekend) && spec.weekend.length ? spec.weekend : ["sat", "sun"];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = new Set();
  for (const r of list) {
    const k = str(r).toLowerCase();
    if (!k) continue;
    if (["weekday", "weekdays", "workday", "workdays"].includes(k)) DAY_KEYS.filter((d) => !weekend.includes(d)).forEach((d) => out.add(d));
    else if (k === "weekend") weekend.forEach((d) => out.add(d));
    else if (DAY_WORDS[k]) DAY_WORDS[k].forEach((d) => out.add(d));
    else if (DAY_KEYS.includes(k.slice(0, 3))) out.add(k.slice(0, 3));
  }
  return [...out];
};

// Departures (seconds, at the first stop) of a line on a day, per direction:
// the services whose calendar runs that day (`runs(calendar)`, by default
// the calendar's weekly days). A feed view (transform/feedView) measures the
// real timetable instead: headways at the trunk, spans at the termini, on
// the representative date.
const departuresByDirection = (line, spec, day, purpose = "headway", runs = null) => {
  if (!runs && typeof spec.departuresOf === "function") return spec.departuresOf(line, day, purpose);
  const runsOn = runs || ((c) => (c.days || []).includes(day));
  const cal = new Map((spec.calendars || []).map((c) => [c.id, c]));
  const out = new Map((line.directions || []).map((d) => [d.id, []]));
  for (const svc of line.services || []) {
    const c = cal.get(svc.calendar_id);
    if (!c || !runsOn(c)) continue;
    const deps = departuresOf(svc);
    for (const d of line.directions || []) {
      if (svc.direction !== "both" && svc.direction !== d.id) continue;
      let times = deps;
      if (d.id === "1" && svc.direction === "both" && svc.reverse_offset_min != null) times = deps.map((t) => t + Math.round(svc.reverse_offset_min * 60));
      out.get(d.id).push(...times);
    }
  }
  for (const [k, v] of out) out.set(k, [...new Set(v)].sort((a, b) => a - b));
  return out;
};

/** The departures of the directions a clause measures: all, or the one it names (its id, directionIn). */
const directionsOf = (byDirection, params) => {
  const d = params.direction == null || params.direction === "" || params.direction === "both" ? null : String(params.direction);
  if (!d) return [...byDirection.values()];
  return byDirection.has(d) ? [byDirection.get(d)] : [];
};
/** The direction as an expected text says it: ", direction 0"; named by words, its id beside them (", direction 0 (La Baute)"). */
const directionLabel = (params, resolved = null) => {
  if (resolved) return `, direction ${resolved.label}`;
  const written = str(params.direction);
  return !written || EVERY_DIRECTION.has(written.toLowerCase()) ? "" : `, direction ${written}`;
};

const linesFor = (spec, params) => {
  if (str(params.line)) {
    const l = findLine(spec, params.line);
    return l ? [l] : null;
  }
  return spec.lines || [];
};

/**
 * The stop sequences of a line: every pattern of a feed view; on a design,
 * its directions and (when the spec module knows them) its variants.
 */
const patternsOfLine = (line, spec) => {
  if (spec.kind !== "feed" && typeof networkSpec.patternsOf === "function") {
    try {
      const p = networkSpec.patternsOf(line);
      if (Array.isArray(p) && p.length) return p;
    } catch {
      /* fall back to the directions */
    }
  }
  return line.directions || [];
};
const servedStopIds = (line, spec) => [...new Set(patternsOfLine(line, spec).flatMap((p) => p.stops || []))];

/**
 * The directions trips_count counts, each starting at 0: the one the clause
 * names (even when the line has no pattern in it, a loop line say), else
 * those of the line's patterns, else "0" — a line without any trip left
 * still counts 0, never nothing (an empty count would pass every bound).
 */
const countedDirections = (patterns, direction = null) => {
  if (direction != null) return [String(direction)];
  const dirs = [...new Set(patterns.map((d) => String(d.direction ?? d.id ?? "0")))].sort();
  return dirs.length ? dirs : ["0"];
};

const fmt = (s) => secToTime(s).slice(0, 5);

// ── When: every distinct timetable of the clause's scope ──────────────────
//
// A time clause is measured on its SCOPE: the dates of its window (`dates`,
// `from_date` / `to_date`, `period`; undated, the validity from `today`)
// whose day type it asks (scopeOf), grouped by the timetable the measured
// line runs that date (gridOf: the sorted ids of its services — a design:
// its calendars). EVERY group is measured, on its first date, with no cap:
// the worst decides, `measured_on` lists every group's date and `grid`
// counts them. A clause without a line is gridded per line. Only
// od_max_time (a CSA run per timetable) is capped: above MAX_OD_TIMETABLES
// it is unknown, never passed on a sample. An undated clause on a designed
// network is gridded on its calendars (structuralPoints).

const MAX_OD_TIMETABLES = 12;
const MAX_WINDOW_DAYS = 800;
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ymdDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
const dowOfYmd = (ymd) => DOW[ymdDate(ymd).getUTCDay()];
const nextYmd = (ymd) => {
  const d = ymdDate(ymd);
  d.setUTCDate(d.getUTCDate() + 1);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};
const iso = (ymd) => (/^\d{8}$/.test(String(ymd || "")) ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : String(ymd || ""));
const given = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
const parseYmd = (v) => require("../transform/calendars").parseDate(v);
const canonicalPeriod = (name) => require("../transform/calendars").canonical(name);

/**
 * The dates a clause names, or null when it names none. A named period is
 * resolved by the caller (transform/feedView.resolveClausePeriods) into
 * ctx.periods[clause id] = { dates, label } | { error }; on a designed
 * network, school_days / school_holidays select the calendars of that
 * period (calendar.period) and public_holidays the spec's holidays.
 */
const windowOf = (c, ctx) => {
  const p = c.params || {};
  if (!given(p.dates) && !given(p.from_date) && !given(p.to_date) && !given(p.period)) return null;
  const w = { from: null, to: null, dates: null, periodDates: null, calendarFilter: null, labels: [] };
  for (const [k, key] of [["from_date", "from"], ["to_date", "to"]]) {
    if (!given(p[k])) continue;
    const y = parseYmd(p[k]);
    if (!y) return { error: `${k} "${p[k]}" is not a date (YYYY-MM-DD)` };
    w[key] = y;
  }
  if (w.from && w.to && w.to < w.from) return { error: `the window ends (${iso(w.to)}) before it starts (${iso(w.from)})` };
  if (w.from || w.to) w.labels.push(`${w.from ? iso(w.from) : "…"} → ${w.to ? iso(w.to) : "…"}`);
  if (given(p.dates)) {
    const list = Array.isArray(p.dates) ? p.dates : String(p.dates).split(/[\s,;]+/).filter(Boolean);
    const set = new Set();
    for (const d of list.slice(0, 400)) {
      const y = parseYmd(d);
      if (!y) return { error: `"${d}" is not a date (YYYY-MM-DD)` };
      set.add(y);
    }
    w.dates = set;
    w.labels.push(set.size === 1 ? iso([...set][0]) : `${set.size} dates`);
  }
  if (given(p.period)) {
    const name = str(p.period);
    const kind = canonicalPeriod(name);
    if (ctx.spec.kind === "feed") {
      const r = ctx.periods?.[c.id];
      if (!r) return { error: `the period "${name}" could not be resolved: give its dates (from_date/to_date or dates)` };
      if (r.error) return { error: `the period "${name}" could not be resolved (${r.error}): give its dates` };
      w.periodDates = r.dates instanceof Set ? r.dates : new Set(r.dates || []);
      w.labels.push(r.label || name);
    } else if (kind === "school_days" || kind === "school_holidays") {
      // A design's calendars say which period they run in (none: all year).
      w.calendarFilter = (cal) => !cal.period || canonicalPeriod(cal.period) === kind;
      w.labels.push(kind.replace("_", " "));
    } else if (kind === "public_holidays") {
      w.periodDates = new Set((ctx.spec.holidays || []).map(String));
      w.labels.push("public holidays");
    } else return { error: `the period "${name}" is not defined for a designed network: give its dates (from_date/to_date or dates)` };
  }
  return w;
};

// The day type a public holiday runs like: the compiler's rule
// (compiler.holidayDayType) — "sunday"/"saturday" name the local rest days.
const holidayDayOf = (spec) => {
  if (spec.holiday_service === "none") return null;
  const named = spec.holiday_service === "saturday" ? "sat" : "sun";
  const weekend = Array.isArray(spec.weekend) && spec.weekend.length ? spec.weekend : ["sat", "sun"];
  if (weekend.includes(named)) return named;
  return spec.holiday_service === "saturday" ? weekend[weekend.length - 1] : weekend[0];
};

/** The services of compiled tables running on a date (calendar + calendar_dates). */
const tableServicesOn = (tables, ymd) => {
  const col = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" }[dowOfYmd(ymd)];
  const out = new Set((tables?.calendar || []).filter((c) => String(c[col]) === "1" && String(c.start_date) <= ymd && ymd <= String(c.end_date)).map((c) => c.service_id));
  for (const d of tables?.calendar_dates || []) {
    if (String(d.date) !== ymd) continue;
    if (String(d.exception_type) === "1") out.add(d.service_id);
    else out.delete(d.service_id);
  }
  return out;
};

/**
 * The dates of a designed network: a calendar runs on a date inside its
 * validity when the date is one of its weekly days — unless the date is
 * explicitly excluded or included (exclude_dates / include_dates), or a
 * public holiday of the spec (it then runs like the holiday day type).
 * networkSpec.runsOnSpecCalendar decides the weekly part when it exists.
 */
const designCalendar = (spec) => {
  const holidays = new Set((spec.holidays || []).map(String));
  const holidayDay = holidayDayOf(spec);
  const runsOn = (cal, ymd) => {
    if (Array.isArray(cal.include_dates) && cal.include_dates.map(String).includes(ymd)) return true;
    if (Array.isArray(cal.exclude_dates) && cal.exclude_dates.map(String).includes(ymd)) return false;
    const start = cal.start_date || spec.feed?.start_date;
    const end = cal.end_date || spec.feed?.end_date;
    if ((start && ymd < start) || (end && ymd > end)) return false;
    if (holidays.has(ymd)) return holidayDay ? (cal.days || []).includes(holidayDay) : false;
    if (typeof networkSpec.runsOnSpecCalendar === "function") {
      const runs = networkSpec.runsOnSpecCalendar(cal, ymd);
      // A school calendar whose dates are not known yet: the clause cannot be measured on dates (unknown, never a guess).
      if (runs === null) throw new Error(`the dates of calendar ${cal.id} (${cal.period}${cal.region ? `, zone ${cal.region}` : ""}) are not known yet: they come from the territory's school holidays`);
      return runs;
    }
    return (cal.days || []).includes(dowOfYmd(ymd));
  };
  const cals = new Map((spec.calendars || []).map((c) => [c.id, c]));
  return {
    validity: spec.feed?.start_date && spec.feed?.end_date ? { start: spec.feed.start_date, end: spec.feed.end_date } : null,
    representativeDate: () => null,
    // A holiday counts as the day type it runs like (none: not a service day).
    dateTypeOf: (ymd) => (holidays.has(ymd) ? holidayDay : dowOfYmd(ymd)),
    dateSignature: (ymd, lines, filter) =>
      [...new Set(lines.flatMap((l) => (l.services || []).map((s) => s.calendar_id)))]
        .filter((id) => cals.has(id) && (!filter || filter(cals.get(id))) && runsOn(cals.get(id), ymd))
        .sort()
        .join(","),
    departuresOnDate: (line, ymd, purpose, filter) => departuresByDirection(line, spec, null, purpose, (cal) => (!filter || filter(cal)) && runsOn(cal, ymd)),
    serviceIdsOnDate: (ymd, tables) => tableServicesOn(tables, ymd),
  };
};

/** The calendar a check reads dates from: a feed view brings its own. */
const calendarOf = (spec) => (spec.kind === "feed" && typeof spec.departuresOnDate === "function" ? spec : designCalendar(spec));

const hashOf = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

// The day words of a clause: `day`, else `days` (the list days / no_service take).
const dayWordsOf = (p) => (given(p.day) ? p.day : given(p.days) ? p.days : null);
const WEEKDAY_SET = (spec) => daysOf("weekday", spec).join(",");
/** A list of day keys as the brief says it: weekday, daily, saturday… or the keys. */
const dayLabel = (days, spec) => {
  const k = [...days].sort((a, b) => DAY_KEYS.indexOf(a) - DAY_KEYS.indexOf(b)).join(",");
  if (k === WEEKDAY_SET(spec)) return "weekday";
  if (k === DAY_KEYS.join(",")) return "daily";
  if (k === daysOf("weekend", spec).sort((a, b) => DAY_KEYS.indexOf(a) - DAY_KEYS.indexOf(b)).join(",")) return "weekend";
  if (k === "sat") return "saturday";
  if (k === "sun") return "sunday";
  return k;
};

/**
 * The dates a clause is measured on (the full grid):
 *   window  its dates, from_date / to_date and period (windowOf); undated,
 *           the measured feed's validity from ctx.today (when inside it)
 *   days    the dates whose day type (calendar.dateTypeOf) is one of the
 *           clause's day words, else of `defaultDay`; listed dates without
 *           a day word, a public-holidays period without one, or
 *           `everyDate` keep every date as it is
 * → { dates, days, label, labels, from, to, key } | { structural, days, label }
 *   (an undated clause on a design) | { error } | { note }
 * `validity` overrides the calendar's (unchanged_except: both feeds').
 */
const scopeOf = (c, ctx, { defaultDay = null, everyDate = false, validity = null } = {}) => {
  const { spec } = ctx;
  const cal = calendarOf(spec);
  const p = c.params || {};
  const w = windowOf(c, ctx);
  if (w && w.error) return { error: w.error };
  const said = dayWordsOf(p);
  const publicPeriod = Boolean(w?.periodDates) && canonicalPeriod(str(p.period)) === "public_holidays";
  // Listed dates are measured as they are; so are a public-holidays period and a dated clause of a kind without a default day.
  const unfiltered = !said && (Boolean(w?.dates) || publicPeriod || everyDate || (Boolean(w) && !defaultDay));
  const days = said ? daysOf(said, spec) : unfiltered ? null : defaultDay ? daysOf(defaultDay, spec) : null;
  if (said && !days.length) return { note: "no day named" };
  if (!days && !unfiltered) return { note: "no day named" };
  if (!w && spec.kind !== "feed") {
    if (!days) return { note: "no day named: a design is measured on day types" };
    return { structural: true, days, label: days.join(","), labels: [] };
  }
  const v = validity || cal.validity;
  let from;
  let to;
  if (!w) {
    from = v?.start || null;
    to = v?.end || null;
    if (ctx.today && v && ctx.today >= v.start && ctx.today <= v.end) from = ctx.today;
  } else {
    from = w.from || v?.start || null;
    to = w.to || v?.end || null;
  }
  let candidates;
  if (w?.periodDates) candidates = [...w.periodDates].filter((d) => (!from || d >= from) && (!to || d <= to) && (!w.dates || w.dates.has(d)));
  else if (w?.dates) candidates = [...w.dates].filter((d) => (!w.from || d >= w.from) && (!w.to || d <= w.to));
  else {
    candidates = [];
    if (from && to) for (let d = from, i = 0; d <= to && i < MAX_WINDOW_DAYS; d = nextYmd(d), i++) candidates.push(d);
  }
  candidates = [...new Set(candidates)].sort();
  const dates = days ? candidates.filter((d) => {
    const type = cal.dateTypeOf(d);
    return type != null && days.includes(type); // another day type, or a public holiday left out
  }) : candidates;
  const labels = w?.labels || [];
  const label = [days ? days.join(",") : null, ...labels].filter(Boolean).join(", ");
  if (!dates.length) return { note: `no ${days ? days.join(",") : "service"} date in the window (${labels.join(", ") || "validity"})` };
  return { dates, days, label, labels, from: dates[0], to: dates[dates.length - 1], key: `${dates.length}|${dates[0]}|${dates[dates.length - 1]}|${hashOf(dates.join(""))}`, filter: w?.calendarFilter || null };
};

// A design's calendar is a school one: its period, canonical.
const schoolPeriodOf = (cal) => {
  const k = cal && cal.period ? canonicalPeriod(cal.period) : null;
  return k === "school_days" || k === "school_holidays" ? k : null;
};

/**
 * The timetables of an undated clause on a design, for these lines: for
 * each day word, the calendars running it — split into school term (the
 * all-year calendars and the school_days ones) and school holidays (the
 * all-year ones and the school_holidays ones) when the design has school
 * calendars, even when no calendar runs in the holidays (a line whose only
 * weekday calendar is a school one then has no holiday service, which a
 * weekday clause must see). Days with the same calendars are one timetable.
 */
const structuralPoints = (ctx, lines, days) => {
  const { spec } = ctx;
  const cals = spec.calendars || [];
  const ofLines = new Set(lines.flatMap((l) => (l.services || []).map((s) => s.calendar_id)));
  const schools = cals.some((cl) => schoolPeriodOf(cl));
  const groups = new Map();
  for (const d of days) {
    const runs = (cl) => (cl.days || []).includes(d);
    const all = cals.filter((cl) => !schoolPeriodOf(cl) && runs(cl));
    const sets = schools
      ? [
          ["term", [...all, ...cals.filter((cl) => schoolPeriodOf(cl) === "school_days" && runs(cl))]],
          ["holidays", [...all, ...cals.filter((cl) => schoolPeriodOf(cl) === "school_holidays" && runs(cl))]],
        ]
      : [["all", all]];
    for (const [kind, set] of sets) {
      const ids = [...new Set(set.map((cl) => cl.id))].filter((id) => ofLines.has(id)).sort();
      const key = ids.join(",");
      if (!groups.has(key)) groups.set(key, { ids, days: new Set(), kinds: new Set() });
      groups.get(key).days.add(d);
      groups.get(key).kinds.add(kind);
    }
  }
  return [...groups.values()].map((g) => {
    const dayList = [...g.days];
    const period = g.kinds.has("all") || (g.kinds.has("term") && g.kinds.has("holidays")) ? "" : g.kinds.has("term") ? ", school term" : ", school holidays";
    const idSet = new Set(g.ids);
    return {
      key: g.ids.join(","),
      date: null,
      structural: true,
      split: Boolean(period),
      dates: [],
      dates_count: 0,
      label: `${dayLabel(dayList, spec)}${period}`,
      day: dayList[0],
      calendarIds: g.ids,
      deps: (line, purpose) => departuresByDirection(line, spec, dayList[0], purpose, (cl) => idSet.has(cl.id)),
      serviceIds: () => new Set(g.ids),
    };
  });
};

/**
 * The timetables of a scope for these lines, each measured once:
 *   → [{ key, date|null, dates, dates_count, label, day, calendarIds?,
 *        deps(line, purpose), serviceIds() }]
 * Dates: grouped by the lines' services (a design: calendars) running that
 * date, in date order, memoised per model, lines and scope on a feed.
 * `splitBy(date)`: a further key (same_as like_week: the weekday).
 */
const gridOf = (scope, ctx, lines, { splitBy = null } = {}) => {
  if (scope.structural) return structuralPoints(ctx, lines, scope.days);
  const { spec } = ctx;
  const cal = calendarOf(spec);
  const filter = scope.filter || null;
  const group = () => {
    const groups = new Map();
    for (const d of scope.dates) {
      const sig = cal.dateSignature(d, lines, filter);
      const key = splitBy ? `${sig}|${splitBy(d)}` : sig;
      if (!groups.has(key)) groups.set(key, { sig, dates: [] });
      groups.get(key).dates.push(d);
    }
    return [...groups.entries()].map(([key, g]) => ({ key, sig: g.sig, dates: g.dates }));
  };
  const groups = spec.kind === "feed" && typeof spec.memo === "function" && !splitBy ? spec.memo(`grid|${lines.map((l) => l.id).join(",")}|${scope.key}`, group) : group();
  return groups.map((g) => {
    const date = g.dates[0];
    return {
      key: g.key,
      date,
      dates: g.dates,
      dates_count: g.dates.length,
      label: iso(date),
      day: dowOfYmd(date),
      calendarIds: spec.kind === "feed" ? null : g.sig.split(",").filter(Boolean),
      deps: (line, purpose) => cal.departuresOnDate(line, date, purpose, filter),
      serviceIds: () => cal.serviceIdsOnDate(date, ctx.tables),
    };
  });
};

/**
 * What a grid measured, as the result reports it: every timetable of every
 * line (add), the failing ones (add(..., true)).
 *   grid()    → { timetables, dates, failing, from, to }
 *   suffix()  → " — 1 of 2 timetables fails (29 dates)" | " — 2 timetables, 169 dates";
 *               nothing for a single structural timetable (a design's day type, as always)
 *   measuredOn() → one date per timetable, all of them, sorted
 *   lines()   → the ids of the lines measured, in order (a verdict's anchors: never a line the measure skipped)
 */
const gridTally = (scope) => {
  const seen = [];
  const failing = [];
  const lines = [];
  const add = (line, point, bad = false) => {
    seen.push(point);
    if (bad) failing.push(point);
    if (line && line.id != null && !lines.includes(line.id)) lines.push(line.id);
  };
  const failDates = () => new Set(failing.flatMap((pt) => pt.dates || [])).size;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return {
    add,
    count: () => seen.length,
    failingCount: () => failing.length,
    lines: () => [...lines],
    grid: () => ({ timetables: seen.length, dates: scope.dates ? scope.dates.length : 0, failing: failing.length, from: scope.from || null, to: scope.to || null }),
    suffix: () => {
      if (scope.structural) {
        if (seen.length <= 1) return "";
        return failing.length ? ` — ${failing.length} of ${seen.length} timetables fail${failing.length === 1 ? "s" : ""}` : ` — ${plural(seen.length, "timetable")}`;
      }
      return failing.length ? ` — ${failing.length} of ${plural(seen.length, "timetable")} fail${failing.length === 1 ? "s" : ""} (${plural(failDates(), "date")})` : ` — ${plural(seen.length, "timetable")}, ${plural(scope.dates.length, "date")}`;
    },
    measuredOn: () => [...new Set(seen.map((pt) => pt.date).filter(Boolean))].sort(),
  };
};

/**
 * Where a measure was taken, in a measured text: " on 2026-11-18" for a
 * date, " (weekday, school holidays)" for a design's school timetable
 * (`always`: any design timetable), nothing for a design's day type.
 */
const where = (point, always = false) => (point?.date ? ` on ${iso(point.date)}` : point?.structural && (point.split || always) ? ` (${point.label})` : "");

/**
 * The longest wait of a window [from, to] on sorted departures, and which
 * one it is: the edges count (from → first, last → to), so a promise of a
 * bus within N minutes of `from` holds from `from`.
 *   → { gap, kind: "inner" | "start" | "end" | "none", first, last }
 */
const gapOf = (deps, from, to) => {
  const inWin = deps.filter((t) => t >= from && t <= to);
  if (!inWin.length) return { gap: to - from + 1, kind: "none", first: null, last: null };
  const pts = [from, ...inWin, to];
  let gap = -1;
  let kind = "inner";
  for (let i = 1; i < pts.length; i++) {
    const g = pts[i] - pts[i - 1];
    if (g > gap) {
      gap = g;
      kind = i === 1 ? "start" : i === pts.length - 1 ? "end" : "inner";
    }
  }
  return { gap, kind, first: inWin[0], last: inWin[inWin.length - 1] };
};

/**
 * The worst wait as a measured text: which gap it is, and where. `exact`: to
 * the second — a wait whose whole minutes would read on the other side of the
 * bound is said as it is (10 min 08 s fails « every 10 min », 9 min 44 s holds
 * « every 9.75 min »: neither is said as « 10 min »).
 */
const gapText = (w, from, to, { exact = false } = {}) => {
  if (!w) return "no timetable";
  const seconds = Math.round(w.gap % 60);
  const wait = exact && seconds ? `${Math.floor(w.gap / 60)} min ${String(seconds).padStart(2, "0")} s` : `${Math.round(w.gap / 60)} min`;
  if (w.kind === "none") return `no service in the window${where(w.point)}`;
  const at = where(w.point);
  const on = at.startsWith(" on") ? `,${at}` : at;
  const stop = w.stop ? ` at ${w.stop}` : "";
  if (w.kind === "start") return `first departure ${fmt(w.first)}${stop}, ${wait} after ${fmt(from)}${on}`;
  if (w.kind === "end") return `last departure ${fmt(w.last)}${stop}, ${wait} before ${fmt(to)}${on}`;
  return `longest wait ${wait}${stop}${where(w.point)}`;
};

/**
 * The name of the stop a feed measures a direction's headway at, when it is
 * not where the direction's trips start (feedModel.departures' trunk: a line
 * whose branches or short workings meet down the line). null otherwise, and
 * for a design (its departures are its termini's).
 */
const trunkName = (spec, byDirection, deps) => {
  const trunk = byDirection && byDirection.trunk;
  if (!trunk || !trunk.size) return null;
  const dir = [...byDirection.entries()].find(([, v]) => v === deps)?.[0];
  const id = dir != null ? trunk.get(dir) : null;
  if (!id) return null;
  return stopNamesOf(spec).get(id) || id;
};

/** The names of a network's stops by id, read once per spec (a memo that never serialises: a spec measured is never changed). */
const stopNamesOf = (spec) => {
  if (spec._stopNames) return spec._stopNames;
  const names = new Map((spec.stops || []).map((x) => [x.id, x.name]));
  if (Object.isExtensible(spec)) Object.defineProperty(spec, "_stopNames", { value: names, enumerable: false });
  return names;
};

// ── Helpers of the trip-level kinds ────────────────────────────────────────

/** A list the brief gives: names (a string is one name) as trimmed strings. */
const listOf = (v) => (Array.isArray(v) ? v : given(v) ? [v] : []).map((x) => str(x && typeof x === "object" ? x.name : x)).filter(Boolean);
/** Times as the brief writes them: a list, or one string ("19:35, 20:35", "7h40 et 8h10"). */
const timesOf = (v) => listOf(v).flatMap((x) => x.split(/\s*[,;]\s*|\s+(?:et|and)\s+|\s+/i)).filter(Boolean);

/** A clock time ("07:40", "7:40", "7h40", "19h", "07:40:00") → seconds (past 24:00 kept); null when it is not one. */
const clockOf = (v) => {
  const m = /^(\d{1,2})(?:[h:](\d{2})?(?::(\d{2}))?)?$/i.exec(str(v).toLowerCase().replace(/\s+/g, ""));
  if (!m || +(m[2] || 0) > 59) return null;
  return +m[1] * 3600 + +(m[2] || 0) * 60 + +(m[3] || 0);
};
/** "HH:MM" of a clock time as the brief writes it, or null. */
const clockText = (v) => {
  const s = clockOf(v);
  return s == null ? null : fmt(s);
};

/** The window of a clause on a trip's departure (from / to, HH:MM, inclusive). */
const clockWindow = (p) => {
  const from = given(p.from) ? clockOf(p.from) : null;
  const to = given(p.to) ? clockOf(p.to) : null;
  if (given(p.from) && from == null) return { error: `incomplete clause (from "${p.from}" is not a time, HH:MM)` };
  if (given(p.to) && to == null) return { error: `incomplete clause (to "${p.to}" is not a time, HH:MM)` };
  const all = from == null && to == null;
  return { all, has: (t) => t != null && (from == null || t >= from) && (to == null || t <= to), text: all ? "" : `, leaving ${from != null ? fmt(from) : "…"}–${to != null ? fmt(to) : "…"}` };
};

/** Bounds as a text: "36–40 min", "≥ 20 min", "≤ 30 min". */
const boundsText = (lo, hi, unit) => {
  if (Number.isFinite(lo) && Number.isFinite(hi)) return lo === hi ? `${lo}${unit}` : `${lo}–${hi}${unit}`;
  return Number.isFinite(lo) ? `≥ ${lo}${unit}` : `≤ ${hi}${unit}`;
};

const listText = (items, n = 3) => `${items.slice(0, n).join(", ")}${items.length > n ? ` (+${items.length - n} more)` : ""}`;
const medianOf = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
/**
 * The trips of a line that are the way back of a stop_pattern clause naming no direction: on a two-way
 * line, « toutes les courses vont de A à B » is said of the trips going from A to B — a trip serving B before A runs
 * the other way, and so does a trip whose direction id no trip serving A then B bears (a return by other streets
 * that never passes A). A trip of the clause's own direction that serves A but not B stays its (a short working).
 * Without it, such a clause would fail on every trip of the way back, each read on both directions.
 *   → { has(t, i) }: i the index of A in the trip, or -1
 */
const wayBackOf = (trips, S) => {
  const first = S[0].keys;
  const last = S[S.length - 1].keys;
  const forward = new Set();
  for (const t of trips) {
    const i = indexIn(t, first);
    if (i >= 0 && indexIn(t, last, i + 1) >= 0) forward.add(String(t.direction));
  }
  return {
    has: (t, i) => {
      const j = indexIn(t, last);
      if (j >= 0 && i >= 0 && j < i) return true;
      return forward.size > 0 && !forward.has(String(t.direction));
    },
  };
};
const sameDirection = (t, p) => !given(p.direction) || p.direction === "both" || String(t.direction) === String(p.direction);

// ── Directions: the id a clause's words name on a line (see the header) ────

// The words naming no direction (each one is measured), and those a direction is introduced with.
const EVERY_DIRECTION = new Set(["both", "all", "any", "les deux", "les deux sens", "tous", "tous les sens", "toutes"]);
const DIRECTION_WORD = /^(?:en\s+direction|[àa]\s+destination|vers|direction|dir\.?|sens|towards|to)\s+/i;
// After a direction word, « de / du / des / d' » is the article of the destination's name: « direction de
// Pélissier », « en direction de la Gare » go there — read as an origin, they would be measured on the way back.
const DEST_ARTICLE = /^(?:(?:de|du|des)\s+|d['’]\s*)/i;
// The words a direction is named with by where its trips START (« depuis Les Tilleuls », « au départ de … », « from
// … »): an origin, never its destination — read as one, « le sens depuis Les Tilleuls » would be the way back. A bare
// « de / du / des » says it only as written (« des Tilleuls »), never after a direction word (DEST_ARTICLE).
const ORIGIN_WORD = /^(?:(?:au\s+d[ée]part|en\s+provenance)\s+)?(?:(?:depuis|from|leaving|du|des|de)\s+|d['’]\s*)/i;
const ORIGIN_EXPLICIT = /^(?:(?:au\s+d[ée]part|en\s+provenance)\s+(?:(?:du|des|de)\s+|d['’]\s*)|(?:depuis|from|leaving)\s+)/i;
// Between an origin and a destination in words: « depuis Cantepau vers Parking Mézard », « from A to B ».
const TO_WORD = /\s+(?:vers|towards|to|jusqu['’]\s*(?:à|a|au|aux))\s+/i;
// An article a stop's name may not bear: « vers la Gare », « de la Gare » name the stop « Gare ».
const ARTICLE = /^(?:(?:la|le|les|the)\s+|l['’]\s*)/i;
// The arrow a timetable writes between a direction's two ends: « Renaudié → Portes d'Albi ».
const LABEL_ARROW = /\s*(?:→|⟶|➔|➜|⇒|->|=>)\s*|\s+>\s+/;
/** Whether a value names a direction by its two ends (« Origin → Destination ») rather than a stop. */
const isDirectionLabel = (v) => LABEL_ARROW.test(str(v && typeof v === "object" ? v.name : v));

/**
 * The patterns a direction is read on, each side's main ones first (a feed's
 * patterns come by their trips, a design's directions before its variants):
 * the line in the network measured and, for a relational clause, in the feed
 * before the plan → [{ dir, keys, last, headsigns }].
 */
const directionPatterns = (sides) =>
  sides.flatMap(({ spec, line }) =>
    (line ? patternsOfLine(line, spec) : [])
      .filter((p) => Array.isArray(p.stops) && p.stops.length)
      .map((p) => {
        const names = p.stops.map((id) => stopNamesOf(spec).get(id) || String(id));
        return { dir: str(p.direction ?? p.id) || "0", keys: names.map(nameKey), last: names[names.length - 1], headsigns: [p.headsign, ...(Array.isArray(p.headsigns) ? p.headsigns : [])].map(str).filter(Boolean) };
      }),
  );

/** Each direction with the terminus of its main pattern, as a verdict lists them: « 0 → La Baute, 1 → Pélissier ». */
const directionsText = (patterns) => {
  const main = new Map();
  for (const p of patterns) if (!main.has(p.dir)) main.set(p.dir, p.last);
  return [...main].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, last]) => `${d} → ${last}`).join(", ") || "none";
};

/**
 * The ways a direction's words may be read, the most literal first: as
 * written — an id, a destination, or a label « A → B » (one end left empty
 * names the other alone: « A → » is where the trips start) —, then without
 * the word introducing them (« vers … », « sens 1 », « en direction de … »:
 * the « de » after it is the destination's article, « direction de Pélissier »
 * is the way to Pélissier), then, introduced by where the trips start
 * (« depuis … », « au départ de … », « from … », and as written only « de … »),
 * an origin, or both ends in words (« depuis A vers B »).
 *   → [{ id } | { origin, dest }] (origin or dest null: that end is not named)
 */
const readingsOf = (raw) => {
  const out = [];
  const asWritten = (w) => {
    if (!w) return;
    if (!LABEL_ARROW.test(w)) return out.push({ id: w }, { origin: null, dest: w });
    const parts = w.split(LABEL_ARROW).map((x) => x.trim());
    out.push({ origin: parts[0] || null, dest: parts[parts.length - 1] || null });
  };
  asWritten(raw);
  const bare = raw.replace(DIRECTION_WORD, "").trim();
  const introduced = bare !== raw;
  if (introduced) {
    asWritten(bare);
    // « direction de / du / des / d' X »: the destination X, never where the trips start.
    if (!ORIGIN_EXPLICIT.test(bare)) {
      const dest = bare.replace(DEST_ARTICLE, "").trim();
      if (dest !== bare) asWritten(dest);
    }
  }
  // An origin: as written (« depuis », « au départ de », « de Les Tilleuls »), and after a direction word only by
  // the words that name one (« le sens depuis Les Tilleuls »).
  for (const [w, word] of [[raw, ORIGIN_WORD], ...(introduced ? [[bare, ORIGIN_EXPLICIT]] : [])]) {
    if (!word.test(w) || LABEL_ARROW.test(w)) continue;
    const ends = w.replace(word, "").trim().split(TO_WORD).map((x) => x.trim());
    if (ends[0]) out.push({ origin: ends[0], dest: ends.length > 1 ? ends[ends.length - 1] || null : null });
  }
  return out;
};

/**
 * The directions one reading reaches (`partial`: false, by exact names only;
 * "within", also the stops and headsigns whose name holds the words whole):
 * with both ends, those whose patterns call at the origin and later at the
 * destination, else those the destination alone names; a destination, those
 * whose patterns end there or bear it as their headsign; an origin alone,
 * those whose patterns start there. → [ids]
 */
const directionsNamed = (sides, patterns, { origin, dest }, partial) => {
  // A name, and the same without an article the stop's own name may not bear (« la Gare »).
  const namesOf = (name) => [...new Set([name, name.replace(ARTICLE, "").trim()])].filter(Boolean);
  // The stops a name stands for, in every network read (clauseTrips.stopKeys), the first of its forms that names one.
  const keysOf = (name) => {
    for (const n of namesOf(name)) {
      const keys = new Set(sides.flatMap(({ spec }) => [...(stopKeys({ spec }, n, { partial })?.keys || [])]));
      if (keys.size) return keys;
    }
    return new Set();
  };
  const signs = (h, name) =>
    namesOf(name).some((n) => {
      const [a, b] = [nameKey(h), nameKey(n)];
      return a === b || (partial === "within" && b.length >= 4 && a.length > b.length && ` ${a} `.includes(` ${b} `));
    });
  const dirs = (test) => [...new Set(patterns.filter(test).map((p) => p.dir))].sort();
  const from = origin ? keysOf(origin) : null;
  const to = dest ? keysOf(dest) : null;
  if (from?.size && to?.size) {
    const found = dirs((p) => p.keys.some((k, i) => from.has(k) && p.keys.slice(i + 1).some((x) => to.has(x))));
    if (found.length) return found;
  }
  if (dest) return dirs((p) => to.has(p.keys[p.keys.length - 1]) || p.headsigns.some((h) => signs(h, dest)));
  return from ? dirs((p) => from.has(p.keys[0])) : [];
};
/** What a reading asked of the trips, as a verdict says none does. */
const readingText = (r) =>
  !r ? null : r.origin && r.dest ? `runs from ${r.origin} to ${r.dest}, ends at ${r.dest} or bears it as its headsign` : r.dest ? `ends at ${r.dest} or bears it as its headsign` : r.origin ? `starts at ${r.origin}` : null;

/**
 * The direction a clause names on a line, as the id its trips bear: an id
 * ("0", "1"), a destination (« La Baute », « vers La Baute »: the direction
 * whose trips end there or bear it as their headsign), an origin (« depuis
 * Pélissier », « Pélissier → »: the direction whose trips start there) or a
 * label « Renaudié → Portes d'Albi » (whose trips run from the one to the
 * other), read on the line in each network of `sides` ([{ spec, line }]).
 * Every reading (readingsOf) is tried by exact names first, then by the stops
 * whose name holds the words whole: a destination named « Sens Gare » stays
 * one, « sens 1 » is never a stop « Sens », « depuis Les Tilleuls » never the
 * way to Les Tilleuls.
 *   → null (none named: each direction is measured) | { id, label } |
 *     { error, none? } — a direction no trip reaches (none) or that names
 *     every direction is never measured over all of them.
 */
const directionIn = (sides, value) => {
  const raw = str(value && typeof value === "object" ? value.name ?? value.id : value);
  if (!raw || EVERY_DIRECTION.has(raw.toLowerCase())) return null;
  const patterns = directionPatterns(sides);
  const line = sides.find((x) => x.line)?.line;
  const of = `direction "${raw}" of line ${line?.short_name || line?.id || "?"}`;
  const readings = readingsOf(raw);
  for (const partial of [false, "within"]) {
    for (const r of readings) {
      if (r.id != null) {
        if (partial) continue;
        if (r.id === "0" || r.id === "1" || patterns.some((p) => p.dir === r.id)) return { id: r.id, label: r.id };
        // A number that is none of the line's ids names no stop either.
        if (/^\d+$/.test(r.id)) return { error: `${of}: not one of its directions (${directionsText(patterns)})`, none: true };
        continue;
      }
      const found = directionsNamed(sides, patterns, r, partial);
      if (found.length === 1) return { id: found[0], label: `${found[0]} (${raw})` };
      if (found.length > 1) return { error: `${of} names ${found.length === 2 ? "both directions" : `directions ${found.join(", ")}`} (${directionsText(patterns)}): give the direction's id` };
    }
  }
  // Said by the most specific reading of the words (an origin when they name where the trips start).
  const asked = readingText([...readings].reverse().find((r) => r.id == null));
  return { error: `${of}: ${asked ? `no trip ${asked}` : "names neither where its trips start nor where they end"} (its directions: ${directionsText(patterns)})`, none: true };
};

/** The params a clause is measured with on a line: its direction read (directionIn) as an id, or none. */
const withDirection = (p, resolved, key = "direction") => ({ ...p, [key]: resolved ? resolved.id : null });
/** A direction read as an expected text names it: null when none was named, or it could not be read. */
const readDirection = (d) => (d && d.id != null ? d : null);
/**
 * Whether the call at position i of a trip is where it ends (its last call: an
 * arrival, no departure) or where it starts (its first: a departure, no
 * arrival). A trip of a single call — some published feeds carry one — does
 * both there.
 */
const endsThere = (t, i) => i > 0 && i === t.keys.length - 1;
const startsThere = (t, i) => i === 0 && t.keys.length > 1;
/**
 * How a line's patterns (in the direction read, when one is) call at a stop,
 * at the call a clause reads there (occurrence, callOf): "leaves" when one
 * leaves from it, "ends" when they only end there, null when none calls there.
 */
const callKind = (spec, line, keys, dir, occurrence = null) => {
  let ends = false;
  for (const p of directionPatterns([{ spec, line }])) {
    if (dir && p.dir !== dir.id) continue;
    const i = callOf(p, keys, occurrence);
    if (i < 0) continue;
    if (!endsThere(p, i)) return "leaves";
    ends = true;
  }
  return ends ? "ends" : null;
};

/**
 * The direction a clause of one line measures (trips_count, departure_at):
 * its `direction`, and a `towards` written « Origin → Destination » — a
 * direction named by its two ends, whose stops are never read as one (read
 * so, « vers Renaudié → Portes d'Albi » would count the trips of both
 * directions, each reaching one of the two). Both given, they must name the same direction.
 *   → { dir: null | { id, label } } | { error }
 */
const clauseDirection = (spec, line, p) => {
  const dir = directionIn([{ spec, line }], p.direction);
  if (dir?.error) return { error: dir.error };
  if (!isDirectionLabel(p.towards)) return { dir };
  const words = str(p.towards?.name ?? p.towards);
  const by = directionIn([{ spec, line }], words);
  if (!by || by.error) return by ? { error: by.error } : { dir };
  if (dir && by.id !== dir.id) return { error: `direction ${dir.label} and towards "${words}" (direction ${by.id}) name two directions of line ${line.short_name || line.id}` };
  return { dir: dir || by };
};
/**
 * Whether a direction that cannot be read on a line is the clause's verdict:
 * on a line the clause names, always; said of every line, only when it names
 * both of the line's directions — a line none of whose trips go that way is
 * not the clause's (the lines that do are measured; none: unknown).
 */
const unreadDirection = (d, named) => Boolean(d?.error) && (named || !d.none);

// The name keys of the stops a line serves (every pattern), memoised per spec.
const _servedKeys = new WeakMap();
const servedKeysOf = (spec, line) => {
  if (!_servedKeys.has(spec)) _servedKeys.set(spec, new Map());
  const cache = _servedKeys.get(spec);
  if (!cache.has(line.id)) {
    const byId = new Map((spec.stops || []).map((s) => [s.id, s]));
    cache.set(line.id, new Set(servedStopIds(line, spec).map((id) => nameKey(byId.get(id)?.name || id))));
  }
  return cache.get(line.id);
};

/**
 * The stops a clause names on a line, resolved (clauseTrips.stopKeys): a
 * null ref stays null. A name no stop of the network matches is unknown; a
 * stop the line never serves fails ("line K does not serve X").
 *   → { stops: [{ keys, name } | null] } | { result: (clause) => verdict }
 */
const stopsOfClause = (ctx, line, refs) => {
  const stops = [];
  for (const ref of refs) {
    if (ref == null) {
      stops.push(null);
      continue;
    }
    const k = stopKeys(ctx, ref);
    const name = str(ref && typeof ref === "object" ? ref.name : ref);
    if (!k) return { result: (c) => result(c, "unknown", { note: `no stop named ${name} in the network` }) };
    const served = servedKeysOf(ctx.spec, line);
    if (![...k.keys].some((x) => served.has(x))) return { result: (c) => result(c, "fail", { expected: `line ${line.short_name} at ${k.name}`, measured: `line ${line.short_name} does not serve ${k.name}`, lines: [line.id] }) };
    stops.push(k);
  }
  return { stops };
};

/**
 * Which call of a trip a clause's stop is, as the clause says it
 * (`occurrence`): "first", "last" or the call's rank among those bearing the
 * name (1 = the first); null when the clause says nothing; { error } when it
 * says something else.
 */
const occurrenceOf = (p) => {
  const v = p.occurrence;
  if (v == null || v === "") return null;
  const word = str(v).toLowerCase();
  if (word === "first" || word === "last") return word;
  const n = num(v);
  return Number.isInteger(n) && n >= 1 ? n : { error: `incomplete clause (occurrence "${str(v)}": first, last or the call's rank from 1)` };
};
/** The occurrence as the verdict's expected text says it: " (last call)", " (call 2)"; nothing without one. */
const occurrenceText = (occurrence) => (occurrence == null ? "" : typeof occurrence === "number" ? ` (call ${occurrence})` : ` (${occurrence} call)`);

/**
 * The call of a trip the clause's stop means. A name borne by ONE call of the
 * trip is that call. Borne by several (a line through two villages' « Centre
 * Bourg », a loop through the station twice), it is the one `occurrence`
 * names — first, last or its rank among the calls of that name — and, when
 * the clause names none, the first call: the reading the recorded verdicts
 * rest on (the sheet reader writes the occurrence where its grid repeats a
 * name, a planner may too).
 *   → position in the trip | -1 (no such call on this trip)
 */
const callOf = (trip, keys, occurrence = null) => {
  if (occurrence == null) return indexIn(trip, keys);
  const all = [];
  for (let i = 0; i < trip.keys.length; i++) if (keys.has(trip.keys[i])) all.push(i);
  const i = occurrence === "first" ? all[0] : occurrence === "last" ? all[all.length - 1] : all[occurrence - 1];
  return i == null ? -1 : i;
};

/**
 * How many calls of the trip bear the clause's stop (callsOfStop). Where the clause names no occurrence and a trip calls there
 * several times, the measure reads the first: a verdict that fails says so (repeatedNote) — the clause may mean
 * another call (a terminus after a village of the same name), and nothing tells it but its occurrence.
 */
const callsOfStop = (trip, keys) => {
  let n = 0;
  for (const k of trip.keys) if (keys.has(k)) n += 1;
  return n;
};
const repeatedNote = (name, n, past = false) =>
  `measured at the first of ${n} calls at ${name}${past ? " past the trip's origin (no one arrives where it starts)" : ""}: the clause names no occurrence (first, last or a rank tells another call)`;
/** Said of a failure at a stop where trips end: their arrival there was not read as a departure. */
const endingNote = (name, n) => `${n} trip${n === 1 ? " ends" : "s end"} at ${name}: an arrival there is no departure (not counted)`;
/** Said of a headway at a stop that is only where the trips end (callKind "ends"): nothing leaves to measure. */
const terminusNote = (name, occurrence, dir) =>
  `no trip leaves from ${name}${occurrenceText(occurrence)}${dir ? ` in direction ${dir.label}` : ""}: the trips end there, and an arrival is no departure — no headway to measure there`;

/** The lines a relational clause names (line / lines), or every line of the measured network. */
const linesOfClause = (spec, p) => {
  const names = [...new Set([...listOf(p.lines), ...listOf(p.line)])];
  if (!names.length) return { list: spec.lines || [], label: "every line" };
  const list = [];
  for (const n of names) {
    const l = findLine(spec, n);
    if (!l) return { missing: n };
    list.push(l);
  }
  return { list, label: list.length === 1 ? `line ${list[0].short_name}` : `lines ${list.map((l) => l.short_name).join(", ")}` };
};

/** The date of the week of `anyDate` (Monday to Sunday) that falls on `dow`. */
const weekDay = (anyDate, dow) => {
  const d = ymdDate(anyDate);
  const monday = (d.getUTCDay() + 6) % 7;
  const target = (DOW.indexOf(dow) + 6) % 7;
  d.setUTCDate(d.getUTCDate() - monday + target);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
};
const weekDates = (anyDate) => DAY_KEYS.map((d) => weekDay(anyDate, d));

/**
 * Which feed a same_as clause reads its reference day in: `like_in`
 * "before" (the feed before the plan: ctx.baseline) or "after" (the feed
 * measured); by default the feed before when there is one and the lines
 * run on the reference date in it, else the feed measured.
 *   → { spec: the reference view (null: the measured one), word, baseline } | { error }
 */
const refSide = (ctx, p, lines, refDates) => {
  const base = ctx.baseline;
  const before = () => ({ spec: base.self ? null : base.spec, word: "before", baseline: "before" });
  if (p.like_in === "before") return base ? before() : { error: "compares with the feed before the plan: none here" };
  if (p.like_in === "after" || !base) return { spec: null, word: "after", baseline: "self" };
  const runs = lines.some((l) => {
    const bl = pairedLine(base.spec, l);
    return bl && refDates.some((d) => base.spec.tripsOnDate(bl.id, d).length);
  });
  return runs ? before() : { spec: null, word: "after", baseline: "self" };
};

/**
 * The trips of a line on a timetable (a grid point) or on a date: a feed's
 * or compiled tables' trips; a design without tables, its departures at
 * the first stop as trips without stops (same_as compares them).
 */
const timetableTrips = (ctx, line, point, date) => {
  const { spec } = ctx;
  if (spec.kind === "feed") return point ? tripsOf(ctx, line, point) : spec.tripsOnDate(line.id, date);
  const cal = designCalendar(spec);
  const ids = point ? point.calendarIds : cal.dateSignature(date, [line]).split(",").filter(Boolean);
  if (ctx.tables) return tripsOnDateOf(ctx, line, date, ids);
  const deps = point ? point.deps(line, "span") : cal.departuresOnDate(line, date, "span");
  return [...deps].flatMap(([dir, list]) => list.map((t) => ({ id: `${dir}@${t}`, direction: String(dir), keys: [], names: [], arr: [t], dep: [t], first: t })));
};

/** The same trip within a tolerance: direction, stops and every time. */
const sameTrip = (x, y, tol) => x.direction === y.direction && x.keys.length === y.keys.length && x.keys.every((k, i) => k === y.keys[i]) && x.dep.length === y.dep.length && x.dep.every((v, i) => (v == null ? y.dep[i] == null : y.dep[i] != null && Math.abs(v - y.dep[i]) <= tol));

/** Two lists of trips compared as multisets (clauseTrips.multisetDiff), bucketed by direction and stops. */
const diffTrips = (a, b, tol) => {
  const bucket = (t) => `${t.direction}|${t.keys.join(">")}`;
  const pool = new Map();
  for (const t of b) pool.set(bucket(t), [...(pool.get(bucket(t)) || []), t]);
  const missing = [];
  for (const t of a) {
    const list = pool.get(bucket(t)) || [];
    const i = list.findIndex((y) => sameTrip(t, y, tol));
    if (i >= 0) list.splice(i, 1);
    else missing.push(t);
  }
  return { missing, extra: [...pool.values()].flat() };
};

/**
 * The lines unchanged_except compares, paired between the feed measured
 * and the feed before: the lines it names, or every line of either feed
 * (by id, then by short name), less `except.lines`. A named line is found
 * in the feed measured and paired with the feed before by its id, as
 * same_as pairs it (pairedLine): a renumbered line keeps its route id, so
 * « la ligne R devient la ligne 5 » is measured on line 5 against line R;
 * a line only the feed before has is found there by its name.
 *   → { list: [{ after, before, name }], label } | { error }
 */
const linePairs = (after, before, p) => {
  const names = [...new Set([...listOf(p.lines), ...listOf(p.line)])];
  // The lines left out, as findLine reads them (a label the engine's question offered names its line too).
  const exclude = listOf(p.except?.lines);
  const excluded = (l) => l && exclude.some((n) => findLine({ lines: [l] }, n) === l);
  let list;
  if (names.length) {
    list = names.map((n) => {
      const a = findLine(after, n);
      return { after: a, before: a ? pairedLine(before, a) : findLine(before, n), name: n };
    });
    const none = list.find((x) => !x.after && !x.before);
    if (none) return { error: `no line ${none.name} in the feed before or after the plan` };
  } else {
    const left = new Map((before.lines || []).map((l) => [l.id, l]));
    list = (after.lines || []).map((l) => {
      const b = left.get(l.id) || null;
      if (b) left.delete(l.id);
      return { after: l, before: b, name: l.short_name };
    });
    for (const x of list) {
      if (x.before) continue;
      const b = [...left.values()].find((y) => nameKey(y.short_name) === nameKey(x.after.short_name));
      if (b) {
        x.before = b;
        left.delete(b.id);
      }
    }
    for (const b of left.values()) list.push({ after: null, before: b, name: b.short_name });
  }
  list = list.filter((x) => !excluded(x.after) && !excluded(x.before));
  const label = names.length === 1 ? `line ${names[0]}` : names.length ? `lines ${names.join(", ")}` : exclude.length ? `every line but ${listOf(p.except.lines).join(", ")}` : "every line";
  return { list, label };
};

/**
 * The scopes of unchanged_except's except.trips (see the header), each read
 * once: its lines, direction (read on each line later), days, dates and
 * departures, as spans of seconds (win.spans) — a window from / to, `to`
 * holding its whole minute as a published time does, and one ending before
 * it starts running past midnight (« 23:00–01:00 » ends at 25:00, as
 * remove_trips and shift_trips read it; read literally it holds nothing); or each of its
 * `times` within the minute the operators match a time in (selection.js
 * ± 60 s; add_trips shifts a template timed to the second by whole minutes) —
 * never the span between them, which would hold a trip left between two of them;
 * `tolerance_min` widens either (a series of departures added). A time or a
 * window before midnight is read past it on the dates where only that reading
 * finds a trip (scopeOnDay). A named period comes resolved by the caller
 * (feedView.resolveClausePeriods: ctx.periods["<clause id>#trips<k>"]); one
 * that could not be leaves the scope out on its every date (more left out,
 * never a change of the scope measured as collateral), said in `notes`.
 *   → { parts: [{ label, lines, direction, days, from, to, dates, period, win, at, raw }], notes } | { error }
 */
const tripScopesOf = (c, ctx) => {
  const list = Array.isArray(c.params?.except?.trips) ? c.params.except.trips : [];
  const parts = [];
  const notes = [];
  for (const [k, raw] of list.entries()) {
    const x = raw && typeof raw === "object" ? raw : {};
    // Named by its rank and its lines, as a note says it — never by the operation's id (`op`: the engine's, not shown).
    const label = `#${k + 1} (${linesText(listOf(x.lines))})`;
    const bad = (what) => ({ error: `incomplete clause (except.trips ${label}: ${what})` });
    const days = given(x.days) ? new Set(daysOf(x.days, ctx.spec)) : null;
    if (days && !days.size) return bad(`no day named in "${listOf(x.days).join(", ")}"`);
    const [from, to] = ["from_date", "to_date"].map((key) => (given(x[key]) ? parseYmd(x[key]) : null));
    for (const [key, v] of [["from_date", from], ["to_date", to]]) if (given(x[key]) && !v) return bad(`${key} "${x[key]}" is not a date (YYYY-MM-DD)`);
    let dates = null;
    if (given(x.dates)) {
      dates = new Set((Array.isArray(x.dates) ? x.dates : String(x.dates).split(/[\s,;]+/).filter(Boolean)).map(parseYmd));
      if (dates.has(null)) return bad("dates as YYYY-MM-DD");
    }
    let period = null;
    if (given(x.period)) {
      const r = ctx.periods?.[`${c.id}#trips${k}`];
      if (r && !r.error) period = r.dates instanceof Set ? r.dates : new Set(r.dates || []);
      else notes.push(`the period "${str(x.period)}" of ${label} could not be resolved${r?.error ? ` (${r.error})` : ""}: its trips are left out on every date of its days`);
    }
    const [wFrom, wTo] = ["from", "to"].map((key) => (given(x[key]) ? clockOf(x[key]) : null));
    if ((given(x.from) && wFrom == null) || (given(x.to) && wTo == null)) return bad("from / to as HH:MM");
    const times = given(x.times) ? [...new Set(timesOf(x.times).map(clockOf))].sort((u, v) => u - v) : null;
    if (times && (!times.length || times.includes(null))) return bad("times as HH:MM");
    const minutes = given(x.tolerance_min) ? num(x.tolerance_min) : null;
    if (given(x.tolerance_min) && !(minutes >= 0)) return bad("tolerance_min in minutes");
    // The operators' minute around each time given; a window's own bounds unless the scope widens them.
    const tol = minutes != null ? minutes * 60 : times ? OPERATOR_MINUTE_S : 0;
    let spans = null;
    if (times) spans = times.map((t) => ({ from: t - tol, to: t + tol }));
    else if (wFrom != null || wTo != null) {
      const across = wFrom != null && wTo != null && wTo < wFrom ? DAY_S : 0;
      spans = [{ from: wFrom == null ? -Infinity : wFrom - tol, to: wTo == null ? Infinity : wTo + across + Math.max(59, tol) }];
    }
    const win = spans ? { spans, from: wFrom, to: wTo, times } : null;
    parts.push({ label, lines: listOf(x.lines), direction: given(x.direction) ? x.direction : null, days, from, to, dates, period, win, at: str(x.at_stop?.name ?? x.at_stop) || null, raw: x });
  }
  return { parts, notes };
};

/** The lines a scope of except.trips names, as a text says them: « line D », « lines D, F », « every line ». */
const linesText = (lines) => (lines.length ? `line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}` : "every line");
/**
 * A scope of except.trips as an expected text says it: « line D (direction 0,
 * weekday, 2027-01-04 → 2027-07-03, all day) » — by what it holds, never by
 * the id of the operation it comes from (« op2 », « order_d »: the engine's
 * identifiers, which a person reading the verdict never sees elsewhere).
 */
const tripScopeText = (x, spec) => {
  // Its times as given, or its window's bounds as written (« 23:00–01:00 »).
  const when = !x.win ? null : x.win.times ? listText(x.win.times.map(fmt), 6) : `${x.win.from != null ? fmt(x.win.from) : "…"}–${x.win.to != null ? fmt(x.win.to) : "…"}`;
  const window = when ? `${x.at ? `at ${x.at}` : "leaving"} ${when}` : "all day";
  const bits = [
    x.direction != null ? `direction ${str(x.direction)}` : null,
    x.days ? dayLabel(x.days, spec) : null,
    x.from || x.to ? `${x.from ? iso(x.from) : "…"} → ${x.to ? iso(x.to) : "…"}` : null,
    x.dates ? `${x.dates.size} date${x.dates.size === 1 ? "" : "s"}` : null,
    given(x.raw.period) ? str(x.raw.period) : null,
    window,
  ].filter(Boolean);
  return `${linesText(x.lines)} (${bits.join(", ")})`;
};

/**
 * Whether a date is in a scope's dates (its range, dates and period), and how
 * its days hold there: "0" not in them; "1" in them, its weekday or its day
 * type (a holiday retyped) one of the scope's days; "2" in them, but only a
 * trip's service may make it one — a Saturday service added on a holiday
 * weekday runs as a Saturday (transform/scope.dayTypeOf), and taking the
 * Saturdays away takes it there too.
 */
const scopeOnDate = (x, d, spec, before) => {
  if ((x.from && d < x.from) || (x.to && d > x.to) || (x.dates && !x.dates.has(d)) || (x.period && !x.period.has(d))) return "0";
  if (!x.days || x.days.has(dowOfYmd(d))) return "1";
  return [spec, before].some((s) => x.days.has(calendarOf(s).dateTypeOf(d))) ? "1" : "2";
};

/** Whether a trip running on a date (`bit`: scopeOnDate) is in a scope's direction and of its day (bit "2": its service's own day type, in the feed it runs in). */
const scopeTakes = (x, bit, t, d, feed) => (x.dir == null || String(t.direction) === x.dir) && (bit !== "2" || (typeof feed.dayTypeOn === "function" && x.days.has(feed.dayTypeOn(t.service_id, d))));
/** When a trip leaves where a scope reads its times: at the scope's stop when it names one (null: the trip does not call there), else at its origin. */
const departureIn = (x, t) => {
  if (!x.atKeys) return t.first;
  const i = indexIn(t, x.atKeys);
  return i < 0 ? null : t.dep[i] ?? t.arr[i];
};
/**
 * Whether a trip running on a date (`bit`: scopeOnDate) is one of a scope's:
 * in its direction, of its day, leaving in one of its spans (scopeOnDay) — at
 * the scope's stop when it names one (a trip not calling there is not the
 * scope's), else at its origin.
 */
const scopeHolds = (x, bit, t, d, feed) => {
  if (!scopeTakes(x, bit, t, d, feed)) return false;
  if (!x.win) return true;
  const at = departureIn(x, t);
  return at != null && x.win.spans.some((s) => at >= s.from && at <= s.to);
};
/**
 * A scope's spans as the operators read them on a date, in the two feeds'
 * trips of that date (`sides`: [[feed, trips]…]): a time or a window before
 * midnight at which no trip of the scope leaves in either feed, while one
 * leaves 24 h later, is read past midnight — remove_trips and shift_trips
 * read « 00:30 » as 24:30 when only the trip after midnight leaves then (and
 * « 00:00–01:00 » as 24:00–25:00), add_trips reads it so at the end of an
 * evening service. Held literally, the trip the operation withdrew or added
 * there would count as the rest of the day's, and the guarantee would fail
 * on it.
 */
const scopeOnDay = (x, bit, d, sides) => {
  if (!x.win) return x;
  const deps = sides.flatMap(([feed, trips]) => trips.filter((t) => scopeTakes(x, bit, t, d, feed)).map((t) => departureIn(x, t))).filter((v) => v != null);
  const leaves = (s) => deps.some((v) => v >= s.from && v <= s.to);
  let late = false;
  const spans = x.win.spans.map((s) => {
    if (!Number.isFinite(s.from) || !Number.isFinite(s.to) || s.to >= DAY_S || leaves(s)) return s;
    const next = { from: s.from + DAY_S, to: s.to + DAY_S };
    if (!leaves(next)) return s;
    late = true;
    return next;
  });
  return late ? { ...x, win: { ...x.win, spans } } : x;
};

// ── Helpers of the identity, accessibility, validity and transfer kinds ───

/** A colour as GTFS writes it: six hex digits in capitals, without « # »; "" when none. */
const colorOf = (v) => str(v).replace(/^#/, "").toUpperCase();
/** A public name as the brief writes it: trimmed, inner spaces made one (case and dashes kept: « – » is not « - »). */
const plainName = (v) => str(v).replace(/\s+/g, " ");
/** The fields an `unchanged` param names: true → all of them; a list (or one name) → those of `all` it names. */
const unchangedFields = (v, all) => (v === true || v === "true" ? all : v == null || v === false || v === "false" ? [] : listOf(v).filter((f) => all.includes(f)));
const NO_BASELINE = "compares with the feed before the plan: none here";

/** The feed before the plan as a spec to compare with: null without one, or when the measured feed is that feed. */
const baseSpecOf = (ctx) => (ctx.baseline && !ctx.baseline.self ? ctx.baseline.spec : null);

/**
 * The line an identity clause names. In the network measured by its number,
 * its id or its long name (findLine); else in the feed before the plan by its
 * old number, then the same route by id in the network measured (a renumbered
 * line keeps its route id: « la ligne R devient la ligne 5 » is measured on
 * line R's route). `before` is its counterpart in the feed before (itself
 * when the measured feed is that feed).
 *   → { line: line | null (gone), before: line | null } | null (named nowhere)
 */
const identityLine = (ctx, ref) => {
  const base = baseSpecOf(ctx);
  const a = findLine(ctx.spec, ref);
  if (a) return { line: a, before: base ? pairedLine(base, a) || null : ctx.baseline?.self ? a : null };
  const b = base ? findLine(base, ref) : null;
  if (!b) return null;
  return { line: (ctx.spec.lines || []).find((l) => l.id === b.id) || null, before: b };
};

/** Every stop and station of a spec, each once: [{ id, name, code?, wheelchair?, parent?, station }]. */
const allStopsOf = (spec) => [...(spec.stops || []).map((s) => ({ ...s, station: false })), ...(spec.stations || []).map((s) => ({ ...s, station: true }))];

/**
 * The stops a clause names in a spec, a named station with its platforms:
 * by id, else by exact name (accents, case and punctuation aside), else —
 * with `partial` — by a whole-word part of the name (clauseTrips' rule).
 */
const stopsNamedIn = (spec, ref, { partial = true } = {}) => {
  const name = str(ref && typeof ref === "object" ? ref.name ?? ref.id : ref);
  const k = nameKey(name);
  if (!k) return [];
  const all = allStopsOf(spec);
  const byId = all.filter((s) => s.id != null && String(s.id) === name);
  let hits = byId.length ? byId : all.filter((s) => nameKey(s.name) === k);
  if (!hits.length && partial) hits = all.filter((s) => nameMatches(s.name, name));
  const ids = new Set(hits.map((s) => s.id));
  const stations = new Set(hits.filter((s) => s.station).map((s) => s.id));
  for (const s of all) {
    if (ids.has(s.id) || !s.parent || !stations.has(s.parent)) continue;
    hits.push(s);
    ids.add(s.id);
  }
  return hits;
};

/**
 * The stops an identity clause names, paired with the feed before the plan
 * by id: found in the network measured by id or exact name; else in the feed
 * before by id or exact name (a renamed stop keeps its id); else by a part
 * of the name, measured first.
 *   → [{ id, after: stop | null (removed), before: stop | null }] (empty: named nowhere)
 */
const identityStops = (ctx, ref) => {
  const base = baseSpecOf(ctx);
  const afterById = new Map(allStopsOf(ctx.spec).map((s) => [s.id, s]));
  const beforeById = base ? new Map(allStopsOf(base).map((s) => [s.id, s])) : ctx.baseline?.self ? afterById : null;
  const pair = (list, side) => list.map((s) => ({ id: s.id, after: side === "after" ? s : afterById.get(s.id) || null, before: beforeById ? beforeById.get(s.id) || null : null }));
  for (const partial of [false, true]) {
    const a = stopsNamedIn(ctx.spec, ref, { partial });
    if (a.length) return pair(a, "after");
    const b = base ? stopsNamedIn(base, ref, { partial }) : [];
    if (b.length) return pair(b, "before");
  }
  return [];
};

/** The wheelchair_boarding a stop really has: its own 1 or 2, else its station's (GTFS: a platform without a value inherits). */
const wheelchairOf = (stop, stationsById) => {
  const own = str(stop?.wheelchair);
  if (own === "1" || own === "2") return own;
  const parent = stop?.parent ? stationsById.get(stop.parent) : null;
  const up = str(parent?.wheelchair);
  return up === "1" || up === "2" ? up : "";
};

/** The service validity of a network: a feed view's calendars, a design's feed dates. → { start, end } | null */
const validityOfSpec = (spec) => (spec.kind === "feed" ? spec.validity || null : designCalendar(spec).validity);

/**
 * The calls of a line's trips at a stop on one timetable, minute-rounded (a
 * published time is to the minute): `arr` the arrivals (not where a trip
 * starts: nobody arrives on it), `dep` the departures (not where it ends).
 * null: a design without compiled tables.
 */
const callsAt = (ctx, line, point, keys, which, direction = null) => {
  const trips = tripsOf(ctx, line, point);
  if (trips === null) return null;
  const out = [];
  for (const t of trips) {
    if (direction != null && direction !== "" && direction !== "both" && String(t.direction) !== String(direction)) continue;
    for (let i = 0; i < t.keys.length; i++) {
      if (!keys.has(t.keys[i])) continue;
      if (which === "arr" ? i === 0 : i === t.keys.length - 1) continue;
      const at = which === "arr" ? t.arr[i] : t.dep[i];
      if (at != null) out.push({ at: Math.floor(at / 60) * 60, trip: t });
    }
  }
  return out.sort((a, b) => a.at - b.at);
};

/** The served stops of some lines, located: [{ id, name, lat, lon }]. */
const servedStopsOf = (spec, lines) => {
  const byId = new Map((spec.stops || []).map((s) => [s.id, s]));
  const ids = new Set(lines.flatMap((l) => servedStopIds(l, spec)));
  return [...ids]
    .map((id) => byId.get(id))
    .filter((s) => s && Number.isFinite(num(s.lat)) && Number.isFinite(num(s.lon)))
    .map((s) => ({ id: s.id, name: s.name, lat: num(s.lat), lon: num(s.lon) }));
};

/**
 * line_identity / stop_identity without a line or a stop: every line (stop,
 * station) of the feed before the plan that is still there, paired by id,
 * keeps the fields `keep` names, but those the clause's `except` lists. A
 * line or stop the plan removes is not judged here (the timetable clauses
 * measure a removal).
 */
const everyIdentity = (c, ctx, keep, what) => {
  const p = c.params;
  const line = what === "line";
  if (!keep.length || (line ? ["short_name", "long_name", "color", "text_color"] : ["name", "code"]).some((f) => given(p[f]))) return result(c, "unknown", { note: `incomplete clause (${what}; without one, unchanged only)` });
  const except = listOf(p.except).map(nameKey);
  const label = `every ${what}${except.length ? ` but ${listOf(p.except).join(", ")}` : ""}`;
  const expected = `${label}: ${keep.map((f) => f.replace("_", " ")).join(", ")} unchanged`;
  if (!ctx.baseline) return result(c, "unknown", { expected, note: NO_BASELINE });
  if (ctx.baseline.self) return result(c, "pass", { expected, measured: "the feed before the plan (reference)", baseline: "self" });
  const before = ctx.baseline.spec;
  const value = (x, f) => (f === "color" || f === "text_color" ? colorOf(x?.[f]) : f === "code" ? str(x?.code) : plainName(x?.[f]));
  const skip = (x) => except.length && [x.short_name, x.long_name, x.name, x.id].some((v) => v != null && except.includes(nameKey(v)));
  const after = new Map((line ? ctx.spec.lines || [] : allStopsOf(ctx.spec)).map((x) => [x.id, x]));
  const pairs = (line ? before.lines || [] : allStopsOf(before)).filter((b) => !skip(b) && after.has(b.id)).map((b) => [b, after.get(b.id)]);
  const wrong = [];
  for (const [b, a] of pairs) for (const f of keep) if (value(a, f) !== value(b, f)) wrong.push(`${line ? `line ${b.short_name || b.id}` : b.id}: ${f.replace("_", " ")} "${value(a, f)}" (was "${value(b, f)}")`);
  const measured = wrong.length ? `${listText(wrong)}` : `${pairs.length} ${what}${pairs.length === 1 ? "" : "s"} compared, none changed`;
  return result(c, wrong.length ? "fail" : "pass", { expected, measured, baseline: "before" });
};

/** A line's figure in the operations estimate (per_line), or null when the estimate has none. */
const perLineFigure = (operations, line, key) => {
  const row = (operations?.per_line || []).find((x) => x && (x.id === line.id || (x.short_name != null && nameKey(x.short_name) === nameKey(line.short_name))));
  return row && Number.isFinite(row[key]) ? row[key] : null;
};

// ── Checks ────────────────────────────────────────────────────────────────

// `located_by`: the weakest authority a place of the clause rests on;
// `measured_on`: the service dates the verdict was measured on (a feed).
// `grid`: the timetables a time clause was measured on; `baseline`: what a
// relational clause compared with ("before": the feed before the plan,
// "self": the measured feed or design itself).
const result = (clause, status, { expected = null, measured = null, lines = [], stops = [], note = null, located_by = null, places = null, measured_on = null, unsupported = false, grid = null, baseline = null } = {}) => ({
  id: clause.id,
  kind: clause.kind,
  level: clause.level,
  text: clause.text || null,
  params: clause.params,
  status,
  expected,
  measured,
  anchors: { lines, stops },
  ...(note ? { note } : {}),
  ...(located_by ? { located_by } : {}),
  ...(places ? { places } : {}),
  ...(measured_on && measured_on.length ? { measured_on } : {}),
  ...(grid ? { grid } : {}),
  ...(baseline ? { baseline } : {}),
  ...(unsupported ? { unsupported: true } : {}),
});

const missingLine = (c) => result(c, "fail", { expected: `line ${c.params.line}`, measured: "no such line" });

// ── The calls' pickup and drop-off types (pickup_dropoff) ───────────────
// What a brief promises of a call: on demand (TAD, sur réservation: pickup or drop-off by booking, 2; or on request
// to the driver, 3), regular (0), drop-off only (pickup 1), pickup only (drop-off 1). Words or GTFS codes.
const ACCESS_WORDS = { regular: "0", normal: "0", none: "1", no: "1", on_demand: "2", phone: "2", booking: "2", reservation: "2", tad: "2", driver: "3", coordinate: "3" };
const ACCESS_NAMES = { 0: "regular", 1: "none", 2: "on demand", 3: "on request to the driver" };
const accessCode = (v) => {
  const s = str(v).toLowerCase().replace(/[\s-]+/g, "_");
  return /^[0-3]$/.test(s) ? s : ACCESS_WORDS[s] ?? null;
};
const onDemandOf = (p) => (p.on_demand === true || p.on_demand === "true" ? true : p.on_demand === false || p.on_demand === "false" ? false : null);
/** What the clause wants of each call → { text, check(pickup, dropOff) → the problem's words | null } | { error }. */
const accessWanted = (p) => {
  const od = onDemandOf(p);
  const demand = (pk, dk) => pk === "2" || pk === "3" || dk === "2" || dk === "3";
  // A call on demand: no regular pickup or drop-off left, and one of the two by booking (a terminus keeps its « none »).
  if (od === true) return { text: "calls on demand (pickup or drop-off by booking)", check: (pk, dk) => (pk === "0" && dk === "0" ? "regular call" : pk === "0" || dk === "0" || !demand(pk, dk) ? "call not on demand" : null) };
  if (od === false) return { text: "regular calls", check: (pk, dk) => (demand(pk, dk) ? "call on demand" : null) };
  if (!given(p.pickup) && !given(p.drop_off)) return { error: "incomplete clause (on_demand, or pickup / drop_off)" };
  const pk = given(p.pickup) ? accessCode(p.pickup) : null;
  const dk = given(p.drop_off) ? accessCode(p.drop_off) : null;
  if (given(p.pickup) && pk == null) return { error: "incomplete clause (pickup: regular | none | on_demand | driver, or 0–3)" };
  if (given(p.drop_off) && dk == null) return { error: "incomplete clause (drop_off: regular | none | on_demand | driver, or 0–3)" };
  const text = [pk != null ? `pickup ${ACCESS_NAMES[pk]}` : null, dk != null ? `drop-off ${ACCESS_NAMES[dk]}` : null].filter(Boolean).join(", ");
  return { text, check: (a, b) => (pk != null && a !== pk ? `pickup ${ACCESS_NAMES[a]} (${a})` : dk != null && b !== dk ? `drop-off ${ACCESS_NAMES[b]} (${b})` : null) };
};
/** A trip's pickup and drop-off types at its call i (feedView: the non-regular calls only). */
const accessAt = (t, i) => {
  const e = (t.access || []).find((x) => x[0] === i);
  return e ? [e[1], e[2]] : ["0", "0"];
};
/** The calls of a trip from the from stop (or its origin) to the to stop (or its terminus), in its order: [a, b] | null when it does not run them. */
const stretchIn = (t, from, to) => {
  const a = from ? indexIn(t, from.keys) : 0;
  if (a < 0) return null;
  let b = t.keys.length - 1;
  if (to) {
    b = -1;
    for (let i = t.keys.length - 1; i >= a; i--) if (to.keys.has(t.keys[i])) {
      b = i;
      break;
    }
    if (b < 0) return null;
  }
  return [a, b];
};

// ── Reference days and reference shapes (running_time like_day, shape_follows) ───────────────

// The representative dates a day word stands for on a feed's view (its representative DOW dates), or a date.
const refDatesOf = (view, word) => {
  const w = String(word || "").toLowerCase();
  const ymd = parseYmd(w);
  if (ymd) return [ymd];
  const dows = w === "weekday" || w === "weekdays" ? ["mon", "tue", "wed", "thu", "fri"] : w === "saturday" ? ["sat"] : w === "sunday" ? ["sun"] : w === "weekend" ? ["sat", "sun"] : DOW.includes(w.slice(0, 3)) ? [w.slice(0, 3)] : null;
  if (!dows) return null;
  return dows.map((d) => (typeof view.representativeDate === "function" ? view.representativeDate(d) : null)).filter(Boolean);
};

/**
 * The running times of the reference day (like_day) from A to B on the line, read in the feed before the plan when
 * there is one (and the line still has a counterpart there), else on the measured feed. → { min, max, count, word }
 * | { error }
 */
const likeDayRunningTimes = (ctx, p, line, A, B, q, likeDay) => {
  const useBefore = Boolean(ctx.baseline && !ctx.baseline.self && p.like_in !== "after");
  const view = useBefore ? ctx.baseline.spec : ctx.spec;
  const rl = useBefore ? pairedLine(view, line) : line;
  if (!rl) return { error: `line ${line.short_name} has no counterpart in the feed before the plan` };
  if (typeof view.tripsOnDate !== "function") return { error: "a designed network has no reference day to read" };
  const dates = refDatesOf(view, likeDay);
  if (!dates) return { error: `"${likeDay}" is not a day (saturday, weekday, sunday, a weekday or a date)` };
  if (!dates.length) return { error: `no ${likeDay} date to read the running times on` };
  const values = [];
  for (const date of dates) {
    for (const t of view.tripsOnDate(rl.id, date)) {
      if (!sameDirection(t, q)) continue;
      const i = indexIn(t, A.keys);
      const j = i < 0 ? -1 : indexIn(t, B.keys, i + 1);
      if (j < 0 || t.dep[i] == null || t.arr[j] == null) continue;
      values.push(Math.round((t.arr[j] - t.dep[i]) / 60));
    }
  }
  if (!values.length) return { error: `no trip of line ${rl.short_name} from ${A.name} to ${B.name} on ${likeDay}${useBefore ? " in the feed before the plan" : ""}` };
  return { min: Math.min(...values), max: Math.max(...values), count: values.length, word: useBefore ? "before the plan" : "" };
};

// Distances in metres on a small area (equirectangular), the polyline tools shape_follows needs.
const M_PER_DEG = 111320;
const pointToSegmentM = (pt, a, b) => {
  const kx = Math.cos((pt[0] * Math.PI) / 180) * M_PER_DEG;
  const ax = (a[1] - pt[1]) * kx;
  const ay = (a[0] - pt[0]) * M_PER_DEG;
  const bx = (b[1] - pt[1]) * kx;
  const by = (b[0] - pt[0]) * M_PER_DEG;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
};
const pointToPolylineM = (pt, poly) => {
  if (poly.length === 1) return pointToSegmentM(pt, poly[0], poly[0]).d;
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) best = Math.min(best, pointToSegmentM(pt, poly[i], poly[i + 1]).d);
  return best;
};
/** The Hausdorff distance of two polylines, in metres: the farthest any point of one lies from the other. */
const hausdorffM = (a, b) => {
  if (!a.length || !b.length) return Infinity;
  let worst = 0;
  for (const pt of a) worst = Math.max(worst, pointToPolylineM(pt, b));
  for (const pt of b) worst = Math.max(worst, pointToPolylineM(pt, a));
  return worst;
};
/** The section of a shape between the projections of two stops on it (the stops' order on the shape kept). */
const shapeSectionBetween = (poly, from, to) => {
  const nearest = (pt) => {
    let best = { i: 0, t: 0, d: Infinity };
    for (let i = 0; i + 1 < poly.length; i++) {
      const r = pointToSegmentM(pt, poly[i], poly[i + 1]);
      if (r.d < best.d) best = { i, t: r.t, d: r.d };
    }
    const a = poly[best.i];
    const b = poly[best.i + 1] || a;
    return { ...best, at: [a[0] + best.t * (b[0] - a[0]), a[1] + best.t * (b[1] - a[1])] };
  };
  if (poly.length < 2) return poly.slice();
  const pa = nearest(from);
  const pb = nearest(to);
  const forward = pa.i < pb.i || (pa.i === pb.i && pa.t <= pb.t);
  const [x, y] = forward ? [pa, pb] : [pb, pa];
  return [x.at, ...poly.slice(x.i + 1, y.i + 1), y.at];
};
const stopCoord = (view, stopId) => {
  const byId = typeof view.memo === "function" ? view.memo("stopsById", () => new Map((view.stops || []).map((s) => [s.id, s]))) : new Map((view.stops || []).map((s) => [s.id, s]));
  const st = byId.get(stopId);
  return st ? [Number(st.lat), Number(st.lon)] : null;
};
/** The reference line's shape between A and B: the first trip of the line (any representative day) serving A then B with a shape. */
const referenceShapeSection = (view, line, A, B, likeDirection = null) => {
  if (typeof view.shapeOf !== "function" || typeof view.tripsOnDate !== "function") return { error: "the reference feed has no shapes" };
  const dir = given(likeDirection) ? directionIn([{ spec: view, line }], likeDirection) : null;
  if (dir?.error) return { error: dir.error };
  const q = withDirection({}, dir);
  for (const d of ["mon", "sat", "sun", "tue", "wed", "thu", "fri"]) {
    const date = view.representativeDate(d);
    if (!date) continue;
    for (const t of view.tripsOnDate(line.id, date)) {
      if (!sameDirection(t, q)) continue;
      const i = indexIn(t, A.keys);
      const j = i < 0 ? -1 : indexIn(t, B.keys, i + 1);
      if (j < 0 || !t.shape_id) continue;
      const pts = view.shapeOf(t.shape_id);
      const from = stopCoord(view, t.stops[i]);
      const to = stopCoord(view, t.stops[j]);
      if (!pts || pts.length < 2 || !from || !to) continue;
      return { points: shapeSectionBetween(pts, from, to), shape_id: t.shape_id, trip: t.id };
    }
  }
  return { error: `no trip of line ${line.short_name} from ${A.name} to ${B.name} with a shape` };
};

const CHECKS = {
  line_exists(c, { spec }) {
    const l = findLine(spec, c.params.line);
    return l ? result(c, "pass", { expected: `line ${c.params.line}`, measured: `line ${l.short_name}`, lines: [l.id] }) : missingLine(c);
  },

  // A terminus matches a place when it lies within 300 m of an
  // authoritative location of it; without one, its name (or the network's
  // own stop of that name) decides.
  termini(c, ctx) {
    const { spec } = ctx;
    const l = findLine(spec, c.params.line);
    if (!l) return missingLine(c);
    const byId = new Map(spec.stops.map((s) => [s.id, s]));
    const a = locateIn(ctx, c.params.from);
    const b = locateIn(ctx, c.params.to);
    const fromName = str(c.params.from?.name ?? c.params.from);
    const toName = str(c.params.to?.name ?? c.params.to);
    const near = (stop, name, place) => {
      if (!stop) return false;
      if (place && AUTHORITATIVE.has(place.via)) return stop.lat != null && distanceTo(stop, place) <= TERMINUS_RADIUS_M;
      if (nameMatches(stop.name, name)) return true;
      return Boolean(place && stop.lat != null && distanceTo(stop, place) <= TERMINUS_RADIUS_M);
    };
    const ends = patternsOfLine(l, spec).filter((d) => (d.stops || []).length).map((d) => [byId.get(d.stops[0]), byId.get(d.stops[d.stops.length - 1])]);
    const ok = ends.some(([s, e]) => (near(s, fromName, a) && near(e, toName, b)) || (near(s, toName, b) && near(e, fromName, a)));
    const expected = `${fromName} ↔ ${toName}`;
    const located_by = weakest([a?.via, b?.via]);
    const places = [
      { name: fromName, located_by: a?.via || null },
      { name: toName, located_by: b?.via || null },
    ];
    let measured = ends.length ? `${ends[0][0]?.name || "?"} ↔ ${ends[0][1]?.name || "?"}` : "no direction";
    if (ok) return result(c, "pass", { expected, measured, lines: [l.id], located_by, places });
    // Neither end locatable nor matching by name: say it cannot be told.
    if (!a && !b && !ends.some(([s, e]) => nameMatches(s?.name, fromName) || nameMatches(e?.name, toName))) return result(c, "unknown", { expected, measured, lines: [l.id], note: "termini not located" });
    // How far each authoritatively located place is from the nearest terminus.
    const termini = ends.flat().filter(Boolean);
    const far = [];
    places.forEach((p, i) => {
      const place = i === 0 ? a : b;
      if (!place || !AUTHORITATIVE.has(place.via)) return;
      const n = nearestTo(termini, place);
      if (n) p.distance_m = Math.round(n.d);
      if (n && n.d > TERMINUS_RADIUS_M) far.push(`${p.name} is ${Math.round(n.d)} m from the nearest terminus (${n.stop.name})`);
    });
    if (far.length) measured += `; ${far.join("; ")}`;
    return result(c, "fail", { expected, measured, lines: [l.id], located_by, places });
  },

  // Each place must be served: within 400 m of an authoritative location of
  // it (a stop merely named after it does not count against that); without
  // one, a stop of that name on the line, or within 400 m of the network's
  // own stop of that name.
  via(c, ctx) {
    const { spec } = ctx;
    const l = findLine(spec, c.params.line);
    if (!l) return missingLine(c);
    const byId = new Map(spec.stops.map((s) => [s.id, s]));
    const served = servedStopIds(l, spec).map((id) => byId.get(id)).filter(Boolean);
    const places = [];
    for (const raw of Array.isArray(c.params.stops) ? c.params.stops : []) {
      const name = str(raw?.name ?? raw);
      const p = locateIn(ctx, raw);
      const nearest = p ? nearestTo(served, p) : null;
      const within = Boolean(nearest && nearest.d <= PLACE_RADIUS_M);
      const entry = { name, located_by: p?.via || null, ...(nearest ? { distance_m: Math.round(nearest.d), nearest: nearest.stop.name } : {}) };
      if (p && AUTHORITATIVE.has(p.via)) entry.ok = within;
      else if (served.some((s) => nameMatches(s.name, name))) {
        entry.ok = true;
        entry.distance_m = 0;
      } else entry.ok = p ? within : null;
      places.push(entry);
    }
    const expected = places.map((x) => x.name).join(", ");
    const located_by = weakest(places.map((x) => x.located_by));
    const missing = places.filter((x) => x.ok === false);
    if (missing.length) return result(c, "fail", { expected, measured: `not served: ${missing.map((x) => (x.distance_m != null ? `${x.name} (nearest stop ${x.nearest}, ${x.distance_m} m)` : x.name)).join(", ")}`, lines: [l.id], located_by, places });
    const unknown = places.filter((x) => x.ok === null).length;
    if (unknown) return result(c, "unknown", { expected, measured: `${unknown} place(s) not located`, lines: [l.id], located_by, places });
    return result(c, "pass", { expected, measured: "all served", lines: [l.id], located_by, places });
  },

  // A served stop within the radius of the place. Located only by the
  // plan's own stop of that name, the check would prove nothing (the stop
  // is always "0 m" from itself): unknown until the position is confirmed.
  serves(c, ctx) {
    const { spec } = ctx;
    const place = str(c.params.place);
    const p = locateIn(ctx, c.params.lat != null ? { lat: c.params.lat, lon: c.params.lon, name: place } : place);
    const radius = num(c.params.radius_m) || PLACE_RADIUS_M;
    const expected = `${place} within ${radius} m`;
    if (!p) return result(c, "unknown", { expected, measured: "place not located", note: "give its position (lat/lon) or pick it on the map" });
    const lines = str(c.params.line) ? [findLine(spec, c.params.line)].filter(Boolean) : spec.lines || [];
    if (str(c.params.line) && !lines.length) return missingLine(c);
    const byId = new Map(spec.stops.map((s) => [s.id, s]));
    let best = null;
    for (const l of lines) {
      for (const id of servedStopIds(l, spec)) {
        const s = byId.get(id);
        if (!s || s.lat == null) continue;
        const d = distanceTo(s, p);
        if (!best || d < best.d) best = { d, stop: s, line: l };
      }
    }
    const anchors = { lines: best ? [best.line.id] : [], stops: best ? [best.stop.id] : [] };
    if (p.via === "plan_stop") return result(c, "unknown", { expected, measured: best ? `nearest ${best.stop.name}, ${Math.round(best.d)} m from the plan's stop "${p.name}"` : "no stop", ...anchors, note: PLAN_STOP_NOTE, located_by: p.via });
    if (best && best.d <= radius) return result(c, "pass", { expected, measured: `${best.stop.name}, ${Math.round(best.d)} m`, ...anchors, located_by: p.via });
    return result(c, "fail", { expected, measured: best ? `nearest ${best.stop.name}, ${Math.round(best.d)} m` : "no stop", ...anchors, located_by: p.via });
  },

  headway_max(c, ctx) {
    const { spec } = ctx;
    const lines = linesFor(spec, c.params);
    if (!lines) return missingLine(c);
    const from = timeToSec(c.params.from || "07:00");
    const to = timeToSec(c.params.to || "09:00");
    const max = num(c.params.minutes);
    if (from == null || to == null || !(max > 0)) return result(c, "unknown", { note: "incomplete clause (day, from, to, minutes)" });
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    if (scope.error || scope.note) return result(c, "unknown", { expected: `every ${max} min or better, ${fmt(from)}–${fmt(to)}`, note: scope.error || scope.note });
    const limit = max * 60;
    const tally = gridTally(scope);
    let worst = null;
    const failing = [];
    // The most calls a measured trip makes at the stop (callsOfStop): read at the first when the clause names no occurrence.
    let repeated = 0;
    // A headway stated AT a stop (a desserte grid writes its band on its timing stop's row): the departures there —
    // at the call the clause means when a trip bears that name several times (occurrence), else the first (callOf).
    const atStop = str(c.params.stop?.name ?? c.params.stop) ? c.params.stop : null;
    const occurrence = atStop ? occurrenceOf(c.params) : null;
    if (occurrence?.error) return result(c, "unknown", { note: occurrence.error });
    // The direction read on each line (directionIn): the id of the one the clause names, said beside its words.
    const dirs = new Map(lines.map((l) => [l.id, directionIn([{ spec, line: l }], c.params.direction)]));
    const named = Boolean(str(c.params.line));
    const expected = `every ${max} min or better, ${fmt(from)}–${fmt(to)}${atStop ? ` at ${str(atStop?.name ?? atStop)}${occurrenceText(occurrence)}` : ""} (${scope.label}${directionLabel(c.params, named ? readDirection(dirs.get(lines[0].id)) : null)})`;
    // Said for several lines (« every line », a list): the ones that call at the stop are measured there; a line
    // that does not serve it is not the clause's — unless none does, which is then said as for one line. So is a
    // line none of whose trips go the way the clause names (unreadDirection).
    let elsewhere = null;
    let undirected = null;
    const candidates = [];
    for (const l of lines) {
      const dir = dirs.get(l.id);
      if (dir?.error) {
        if (unreadDirection(dir, named)) return result(c, "unknown", { expected, note: dir.error });
        undirected = undirected || dir;
        continue;
      }
      let at = null;
      if (atStop) {
        const stops = stopsOfClause(ctx, l, [atStop]);
        if (stops.result) {
          if (lines.length === 1) return stops.result(c);
          elsewhere = elsewhere || stops;
          continue;
        }
        [at] = stops.stops;
      }
      candidates.push({ l, dir, at });
    }
    // Nor is a line whose trips, the way the clause reads them, only end at the stop: no departure leaves from there
    // (the way back of a line to its terminus) — unless no line leaves from it.
    const leaving = candidates.filter((x) => !x.at || callKind(spec, x.l, x.at.keys, x.dir, occurrence) === "leaves");
    // Then the stop is only where the trips end (a band written on a grid's terminus row, a loop's last call): no
    // departure to measure, which is said, unknown — never a failure the network could not avoid. A line that left
    // from it before the plan is measured: the plan took its departures away, and it fails.
    if (atStop && !leaving.length && candidates.some((x) => callKind(spec, x.l, x.at.keys, x.dir, occurrence) === "ends")) {
      const base = baseSpecOf(ctx);
      const leftBefore = base && candidates.some((x) => {
        const b = pairedLine(base, x.l);
        return b && callKind(base, b, x.at.keys, x.dir, occurrence) === "leaves";
      });
      const dir = lines.length === 1 ? readDirection(dirs.get(lines[0].id)) : null;
      if (!leftBefore) return result(c, "unknown", { expected, note: terminusNote(str(atStop?.name ?? atStop), occurrence, dir) });
    }
    const targets = lines.length > 1 && leaving.length ? leaving : candidates;
    // The trips whose call at the stop is their last: they arrive there and end, which is no departure.
    const ending = new Set();
    for (const { l, dir, at } of targets) {
      const q = withDirection(c.params, dir);
      for (const point of gridOf(scope, ctx, [l])) {
        let byDirection = null;
        let directions;
        if (at) {
          const trips = tripsOf(ctx, l, point);
          if (trips === null) return result(c, "unknown", { expected: `every ${max} min or better, ${fmt(from)}–${fmt(to)} at ${at.name}`, note: "timetable not compiled" });
          const by = new Map();
          for (const t of trips) {
            if (!sameDirection(t, q)) continue;
            const i = callOf(t, at.keys, occurrence);
            if (i < 0 || t.dep[i] == null) continue;
            if (occurrence == null) repeated = Math.max(repeated, callsOfStop(t, at.keys));
            // A departure is a call the trip leaves from: at its last call it arrives (counting a terminus' arrivals,
            // the way back's, would make a 36-minute wait of a ten-minute headway) — but for a trip of a single call
            // (endsThere).
            if (endsThere(t, i)) {
              ending.add(`${l.id}|${t.id}`);
              continue;
            }
            if (!by.has(String(t.direction))) by.set(String(t.direction), []);
            by.get(String(t.direction)).push(t.dep[i]);
          }
          directions = [...by.values()].map((d) => d.sort((a, b) => a - b));
        } else {
          byDirection = point.deps(l, "headway");
          directions = directionsOf(byDirection, q);
        }
        // A day without any departure: the whole window is a wait.
        if (!directions.length) directions.push([]);
        let bad = false;
        for (const deps of directions) {
          const g = gapOf(deps, from, to);
          // Where it is measured: the stop the clause names, else a feed's trunk stop, named when the direction's trips do not all start there.
          if (!worst || g.gap > worst.gap) worst = { ...g, point, stop: at ? at.name : trunkName(spec, byDirection, deps) };
          if (g.gap > limit) bad = true;
        }
        tally.add(l, point, bad);
        if (bad && !failing.includes(l.id)) failing.push(l.id);
      }
    }
    if (!tally.count() && elsewhere) return elsewhere.result(c);
    if (!tally.count() && undirected) return result(c, "unknown", { expected, note: undirected.error });
    if (!tally.count()) return result(c, "unknown", { expected, note: "no line to measure" });
    // A wait whose whole minutes would read on the other side of the bound is said to the second: a failing
    // 10 min 08 s against « every 10 min », a passing 9 min 44 s against « every 9.75 min ».
    const exact = Boolean(worst) && (Math.round(worst.gap / 60) * 60 <= limit) !== (worst.gap <= limit);
    const measured = `${gapText(worst, from, to, { exact })}${tally.suffix()}`;
    // A failure says which call it read where the name recurs, and the trips that end at the stop it did not count.
    const stopName = str(atStop?.name ?? atStop);
    const notes = failing.length ? [repeated > 1 ? repeatedNote(stopName, repeated) : null, ending.size ? endingNote(stopName, ending.size) : null].filter(Boolean) : [];
    // The anchors: the failing lines, else the lines measured (never one the stop took out of the measure).
    return result(c, failing.length ? "fail" : "pass", { expected, measured, lines: failing.length ? failing : tally.lines(), measured_on: tally.measuredOn(), grid: tally.grid(), ...(notes.length ? { note: notes.join("; ") } : {}) });
  },

  // Every timetable must start and end within the clause's bounds (the worst
  // decides). Each bound is one-sided: first_before / last_after ask for
  // service early / late enough (a timetable without service fails them),
  // first_after / last_before forbid a departure earlier / later (a
  // timetable without service has none), amplitude_h asks the first to the
  // last departure to last that long. The bounds apply to the earliest first
  // and the latest last departure of the directions measured.
  span(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const lines = linesFor(spec, p);
    if (!lines) return missingLine(c);
    const bound = (k) => (given(p[k]) ? timeToSec(clockText(p[k]) || p[k]) : null);
    const firstBefore = bound("first_before");
    const firstAfter = bound("first_after");
    const lastAfter = bound("last_after");
    const lastBefore = bound("last_before");
    const amplitude = num(p.amplitude_h);
    const unreadable = ["first_before", "first_after", "last_after", "last_before"].filter((k) => given(p[k]) && bound(k) == null);
    if (unreadable.length) return result(c, "unknown", { note: `incomplete clause (${unreadable.join(", ")} as HH:MM)` });
    if (given(p.amplitude_h) && !(amplitude > 0)) return result(c, "unknown", { note: "incomplete clause (amplitude_h in hours)" });
    if (firstBefore == null && firstAfter == null && lastAfter == null && lastBefore == null && amplitude == null) return result(c, "unknown", { note: "incomplete clause (day, first_before, first_after, last_after, last_before or amplitude_h)" });
    const hours = (s) => `${Math.round((s / 3600) * 10) / 10} h`;
    // The direction read on each line (directionIn), as headway_max reads it.
    const dirs = new Map(lines.map((l) => [l.id, directionIn([{ spec, line: l }], p.direction)]));
    const named = Boolean(str(p.line));
    const expected =
      [firstBefore != null ? `first ≤ ${fmt(firstBefore)}` : null, firstAfter != null ? `first ≥ ${fmt(firstAfter)}` : null, lastAfter != null ? `last ≥ ${fmt(lastAfter)}` : null, lastBefore != null ? `last ≤ ${fmt(lastBefore)}` : null, amplitude != null ? `amplitude ≥ ${hours(amplitude * 3600)}` : null].filter(Boolean).join(", ") + directionLabel(p, named ? readDirection(dirs.get(lines[0].id)) : null);
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const tally = gridTally(scope);
    const failing = [];
    let worst = null;
    let undirected = null;
    const measuredLines = [];
    for (const l of lines) {
      const dir = dirs.get(l.id);
      if (dir?.error) {
        if (unreadDirection(dir, named)) return result(c, "unknown", { expected, note: dir.error });
        undirected = undirected || dir;
        continue;
      }
      const q = withDirection(p, dir);
      measuredLines.push(l.id);
      for (const point of gridOf(scope, ctx, [l])) {
        let lf = Infinity;
        let ll = -Infinity;
        for (const deps of directionsOf(point.deps(l, "span"), q)) {
          if (!deps.length) continue;
          lf = Math.min(lf, deps[0]);
          ll = Math.max(ll, deps[deps.length - 1]);
        }
        const service = Number.isFinite(lf);
        const span_ = service ? ll - lf : -Infinity;
        const bad = (firstBefore != null && !(lf <= firstBefore)) || (firstAfter != null && service && lf < firstAfter) || (lastAfter != null && !(ll >= lastAfter)) || (lastBefore != null && service && ll > lastBefore) || (amplitude != null && !(span_ >= amplitude * 3600));
        // The margin to the clause: the smallest decides which timetable is shown.
        const margins = [firstBefore != null ? firstBefore - lf : Infinity, firstAfter != null && service ? lf - firstAfter : Infinity, lastAfter != null ? ll - lastAfter : Infinity, lastBefore != null && service ? lastBefore - ll : Infinity, amplitude != null ? span_ - amplitude * 3600 : Infinity];
        const margin = Math.min(...margins);
        if (!worst || margin < worst.margin) worst = { lf, ll, point, margin };
        tally.add(l, point, bad);
        if (bad && !failing.includes(l.id)) failing.push(l.id);
      }
    }
    if (!tally.count() && undirected) return result(c, "unknown", { expected, note: undirected.error });
    if (!tally.count()) return result(c, "unknown", { expected, note: "no line to measure" });
    const measured = `${Number.isFinite(worst.lf) ? `${fmt(worst.lf)}–${fmt(worst.ll)}${amplitude != null ? ` (${hours(worst.ll - worst.lf)})` : ""}` : "no service"}${where(worst.point)}${tally.suffix()}`;
    return result(c, failing.length ? "fail" : "pass", { expected, measured, lines: failing.length ? failing : measuredLines, measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // Every timetable of the scope has a departure.
  days(c, ctx) {
    const { spec } = ctx;
    const lines = linesFor(spec, c.params);
    if (!lines) return missingLine(c);
    const scope = scopeOf(c, ctx);
    if (scope.error || scope.note) return result(c, "unknown", { note: scope.error || scope.note || "no day named" });
    const tally = gridTally(scope);
    const failing = [];
    const missing = [];
    for (const l of lines) {
      for (const point of gridOf(scope, ctx, [l])) {
        const any = [...point.deps(l, "headway").values()].some((d) => d.length);
        tally.add(l, point, !any);
        if (any) continue;
        missing.push(...(point.date ? point.dates : [point.label]));
        if (!failing.includes(l.id)) failing.push(l.id);
      }
    }
    if (!tally.count()) return result(c, "unknown", { expected: `runs on ${scope.label}`, note: "no line to measure" });
    const shown = [...new Set(missing)].sort().map((d) => (/^\d{8}$/.test(d) ? iso(d) : d));
    const more = shown.length > 3 ? ` (+${shown.length - 3} more)` : "";
    return result(c, failing.length ? "fail" : "pass", { expected: `runs on ${scope.label}`, measured: failing.length ? `no service on ${shown.slice(0, 3).join(", ")}${more}${tally.suffix()}` : `runs every listed day${tally.suffix()}`, lines: failing.length ? failing : lines.map((l) => l.id), measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // No timetable of the scope has a departure.
  no_service(c, ctx) {
    const { spec } = ctx;
    const lines = linesFor(spec, c.params);
    if (!lines) return missingLine(c);
    const scope = scopeOf(c, ctx);
    if (scope.error || scope.note) return result(c, "unknown", { note: scope.error || scope.note || "no day named" });
    const tally = gridTally(scope);
    const failing = [];
    let runs = null;
    for (const l of lines) {
      for (const point of gridOf(scope, ctx, [l])) {
        const any = [...point.deps(l, "headway").values()].some((d) => d.length);
        tally.add(l, point, any);
        if (!any) continue;
        if (!runs) runs = point;
        if (!failing.includes(l.id)) failing.push(l.id);
      }
    }
    if (!tally.count()) return result(c, "unknown", { expected: `no service on ${scope.label}`, note: "no line to measure" });
    return result(c, failing.length ? "fail" : "pass", { expected: `no service on ${scope.label}`, measured: failing.length ? `runs on a day it should not${where(runs, true)}${tally.suffix()}` : `no service${tally.suffix()}`, lines: failing, measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  mode(c, { spec }) {
    const l = findLine(spec, c.params.line);
    if (!l) return missingLine(c);
    const want = str(c.params.mode).toLowerCase();
    const ok = l.mode === want || (want === "subway" && l.mode === "metro") || (want === "train" && l.mode === "rail");
    return result(c, ok ? "pass" : "fail", { expected: want, measured: l.mode, lines: [l.id] });
  },

  lines_max(c, { spec }) {
    const n = num(c.params.count);
    if (n == null) return result(c, "unknown", { note: "no count" });
    return result(c, spec.lines.length <= n ? "pass" : "fail", { expected: `≤ ${n} lines`, measured: `${spec.lines.length} lines` });
  },

  lines_min(c, { spec }) {
    const n = num(c.params.count);
    if (n == null) return result(c, "unknown", { note: "no count" });
    return result(c, spec.lines.length >= n ? "pass" : "fail", { expected: `≥ ${n} lines`, measured: `${spec.lines.length} lines` });
  },

  // The operations estimate's fleet: on a feed, the one fleet figure
  // (vehicles at the peak, each line with its own vehicles: transform/impact.peakFleet).
  fleet_max(c, { operations }) {
    const n = num(c.params.vehicles);
    if (n == null) return result(c, "unknown", { note: "no vehicle count" });
    if (!operations) return result(c, "unknown", { expected: `≤ ${n} vehicles`, note: "operations not estimated" });
    return result(c, operations.fleet_total <= n ? "pass" : "fail", { expected: `≤ ${n} vehicles`, measured: `${operations.fleet_total} vehicles at peak${operations.fleet_date ? ` on ${iso(operations.fleet_date)}` : ""}`, ...(operations.fleet_date ? { measured_on: [operations.fleet_date] } : {}) });
  },

  budget_max(c, { operations }) {
    const n = num(c.params.amount);
    if (n == null) return result(c, "unknown", { note: "no amount" });
    if (!operations) return result(c, "unknown", { expected: `≤ ${n}/year`, note: "operations not estimated" });
    // A cost the plan did not state is an assumption: said, never silent.
    const a = operations.assumptions || {};
    const note = a.cost_defaulted ? `cost at the default ${a.cost_per_km} ${operations.currency}/km${a.cost_per_hour ? ` + ${a.cost_per_hour} ${operations.currency}/h` : ""}: give the plan's costs (cost_per_km, cost_per_hour)` : null;
    return result(c, operations.cost_year <= n ? "pass" : "fail", { expected: `≤ ${Math.round(n)} ${operations.currency}/year`, measured: `${Math.round(operations.cost_year)} ${operations.currency}/year`, note });
  },

  // Measured between the places as located; a place located only by the
  // plan's own stop is measured from that stop, and the result says so. On
  // every timetable of the whole network in the scope (the trip may use any
  // line): the slowest decides; above MAX_OD_TIMETABLES, unknown.
  od_max_time(c, ctx) {
    const { spec, tables } = ctx;
    const max = num(c.params.max_minutes);
    const a = locateIn(ctx, c.params.from);
    const b = locateIn(ctx, c.params.to);
    const label = `${str(c.params.from?.name ?? c.params.from)} → ${str(c.params.to?.name ?? c.params.to)}`;
    if (!(max > 0)) return result(c, "unknown", { note: "no max_minutes" });
    const located_by = weakest([a?.via, b?.via]);
    if (!a || !b) return result(c, "unknown", { expected: `${label} ≤ ${max} min`, measured: "place not located", note: "give the positions or pick them on the map", located_by });
    if (!tables) return result(c, "unknown", { expected: `${label} ≤ ${max} min`, note: "timetable not compiled", located_by });
    const note = located_by === "plan_stop" ? PLAN_STOP_NOTE : null;
    const expected = `${label} ≤ ${max} min`;
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note, located_by });
    const points = gridOf(scope, ctx, spec.lines || []);
    if (points.length > MAX_OD_TIMETABLES) return result(c, "unknown", { expected, note: `${points.length} distinct timetables in the scope: give dates or a period (at most ${MAX_OD_TIMETABLES} are measured)`, located_by });
    const tally = gridTally(scope);
    let worst = null;
    let none = null;
    for (const point of points) {
      const trip = fastestTrip(tables, spec, a, b, c.params, point.serviceIds());
      tally.add(null, point, !trip || trip.minutes > max);
      if (!trip) none = none || point;
      else if (!worst || trip.minutes > worst.trip.minutes) worst = { trip, point };
    }
    if (none) return result(c, "fail", { expected, measured: `no connection${where(none)}${tally.suffix()}`, note, located_by, measured_on: tally.measuredOn(), grid: tally.grid() });
    return result(c, worst.trip.minutes <= max ? "pass" : "fail", { expected, measured: `${worst.trip.minutes} min (leave ${fmt(worst.trip.depart)})${where(worst.point)}${tally.suffix()}`, stops: worst.trip.stops, note, located_by, measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // ── The trip-level kinds (clauseTrips) ──────────────────────────────────

  // The scheduled time from a stop to a later one, on every trip that runs
  // them in that order (one clause is one direction): each trip, or the
  // timetable's median, within the bounds on every timetable of the scope.
  running_time(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const need = [["line", p.line], ["from_stop", p.from_stop], ["to_stop", p.to_stop]].filter(([, v]) => !str(v?.name ?? v)).map(([k]) => k);
    if (need.length) return result(c, "unknown", { note: `incomplete clause (${need.join(", ")})` });
    const minutes = num(p.minutes);
    const tol = num(p.tolerance_min) ?? 2;
    const likeDay = given(p.like_day) ? str(p.like_day).toLowerCase() : null;
    if (minutes == null && num(p.min_minutes) == null && num(p.max_minutes) == null && !likeDay) return result(c, "unknown", { note: "incomplete clause (minutes, min_minutes, max_minutes or like_day)" });
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    const ends = stopsOfClause(ctx, l, [p.from_stop, p.to_stop]);
    if (ends.result) return ends.result(c);
    const [A, B] = ends.stops;
    const win = clockWindow(p);
    if (win.error) return result(c, "unknown", { note: win.error });
    const dir = directionIn([{ spec, line: l }], p.direction);
    if (dir?.error) return result(c, "unknown", { note: dir.error });
    const q = withDirection(p, dir);
    const median_ = p.measure === "median";
    // « Like Saturday »: the bounds are the reference day's own running times over the same stops (read before the
    // plan when there is a feed before: the day the brief points at is the one the network runs today).
    let lo;
    let hi;
    let likeWords = "";
    if (likeDay) {
      const ref = likeDayRunningTimes(ctx, p, l, A, B, q, likeDay);
      if (ref.error) return result(c, "unknown", { note: ref.error });
      lo = ref.min - tol;
      hi = ref.max + tol;
      likeWords = ` (${likeDay}${ref.word ? ` ${ref.word}` : ""}: ${ref.min}–${ref.max} min, ${ref.count} trips)`;
    } else {
      lo = minutes != null ? minutes - tol : num(p.min_minutes) ?? -Infinity;
      hi = minutes != null ? minutes + tol : num(p.max_minutes) ?? Infinity;
    }
    const bounds = boundsText(lo, hi, " min") + likeWords;
    const scope = scopeOf(c, ctx, { defaultDay: "daily" });
    const expected = `${A.name} → ${B.name} in ${bounds}, ${median_ ? "median" : "each trip"}${win.text} (${scope.label || "…"}${directionLabel(p, dir)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const tally = gridTally(scope);
    const values = [];
    const noTrip = [];
    let perDay = 0;
    let worst = null;
    for (const point of gridOf(scope, ctx, [l])) {
      const trips = tripsOf(ctx, l, point);
      if (trips === null) return result(c, "unknown", { expected, note: "timetable not compiled" });
      const runs = [];
      for (const t of trips) {
        if (!sameDirection(t, q)) continue;
        const i = indexIn(t, A.keys);
        const j = i < 0 ? -1 : indexIn(t, B.keys, i + 1);
        if (j < 0 || t.dep[i] == null || t.arr[j] == null) continue;
        if (!win.has(t.dep[i])) continue;
        runs.push({ at: t.dep[i], v: Math.round((t.arr[j] - t.dep[i]) / 60) });
      }
      if (!runs.length) {
        noTrip.push(point);
        tally.add(l, point, false);
        continue;
      }
      const vs = runs.map((r) => r.v);
      const out = runs.filter((r) => r.v < lo || r.v > hi);
      const med = medianOf(vs);
      const bad = median_ ? med < lo || med > hi : out.length > 0;
      values.push(...vs);
      perDay = Math.max(perDay, runs.length);
      tally.add(l, point, bad);
      if (bad && !worst) worst = { point, runs, out, med, vs };
    }
    const note = noTrip.length ? `no trip on ${listText(noTrip.map((pt) => (pt.date ? iso(pt.date) : pt.label)))}` : null;
    if (!values.length) return result(c, "fail", { expected, measured: `no trip from ${A.name} to ${B.name}${tally.suffix()}`, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
    const range = (xs) => `${Math.min(...xs)}–${Math.max(...xs)} min`;
    let measured;
    if (!worst) measured = `${range(values)} (${perDay} trips)${tally.suffix()}`;
    else if (median_) measured = `median ${worst.med} min${where(worst.point, true)}, outside ${bounds}${tally.suffix()}`;
    else measured = `${range(worst.vs)}${where(worst.point, true)}: ${worst.out.length} of ${worst.runs.length} trips outside ${bounds} (${worst.out.slice(0, 3).map((r) => `${fmt(r.at)} ${r.v} min`).join(", ")}${worst.out.length > 3 ? ", …" : ""})${tally.suffix()}`;
    return result(c, worst ? "fail" : "pass", { expected, measured, note, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // Trips a day on every timetable: in each direction of the line (a
  // direction without trips counts 0), or in total.
  trips_count(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    if (!str(p.line)) return result(c, "unknown", { note: "incomplete clause (line)" });
    const exactly = num(p.exactly);
    const lo = exactly != null ? exactly : num(p.min) ?? -Infinity;
    const hi = exactly != null ? exactly : num(p.max) ?? Infinity;
    if (lo === -Infinity && hi === Infinity) return result(c, "unknown", { note: "incomplete clause (min, max or exactly)" });
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    // A towards written « Origin → Destination » is the direction (clauseDirection), never a stop.
    const named = stopsOfClause(ctx, l, [p.at_stop, isDirectionLabel(p.towards) ? null : p.towards].map((x) => (str(x?.name ?? x) ? x : null)));
    if (named.result) return named.result(c);
    const [at, towards] = named.stops;
    const win = clockWindow(p);
    if (win.error) return result(c, "unknown", { note: win.error });
    // Which call at_stop is when a trip bears its name several times (callOf); without it the first.
    const occurrence = at ? occurrenceOf(p) : null;
    if (occurrence?.error) return result(c, "unknown", { note: occurrence.error });
    const way = clauseDirection(spec, l, p);
    if (way.error) return result(c, "unknown", { note: way.error });
    const dir = way.dir;
    const per = p.per === "total" || p.per === "direction" ? p.per : dir || towards ? "total" : "direction";
    const dirs = countedDirections(patternsOfLine(l, spec), dir ? dir.id : null);
    const bounds = lo === hi ? `exactly ${lo}` : boundsText(lo, hi, "");
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    const expected = `${bounds} trips a day${per === "direction" ? " in each direction" : ""}${at ? ` at ${at.name}${occurrenceText(occurrence)}` : ""}${towards ? ` towards ${towards.name}` : ""}${win.text} (${scope.label || "…"}${directionLabel(p, dir)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    // A design counts its departures without compiled tables, unless a stop or a window is named.
    const simple = spec.kind !== "feed" && !at && !towards && win.all;
    const tally = gridTally(scope);
    const all = [];
    let worst = null;
    let repeated = 0;
    for (const point of gridOf(scope, ctx, [l])) {
      const counts = new Map(dirs.map((d) => [d, 0]));
      if (simple) {
        for (const [d, deps] of point.deps(l, "span")) if (counts.has(String(d))) counts.set(String(d), deps.length);
      } else {
        const trips = tripsOf(ctx, l, point);
        if (trips === null) return result(c, "unknown", { expected, note: "timetable not compiled" });
        for (const t of trips) {
          if (dir && String(t.direction) !== dir.id) continue;
          // The call counted: the trip's origin, or its call at at_stop (towards `towards`, when given, later on).
          const i = at ? callOf(t, at.keys, occurrence) : 0;
          if (i < 0) continue;
          if (at && occurrence == null) repeated = Math.max(repeated, callsOfStop(t, at.keys));
          if (towards && indexIn(t, towards.keys, i + 1) < 0) continue;
          if (!win.has(t.dep[i])) continue;
          counts.set(String(t.direction), (counts.get(String(t.direction)) || 0) + 1);
        }
      }
      const values = per === "total" ? [["", [...counts.values()].reduce((a, b) => a + b, 0)]] : [...counts.entries()];
      const bad = values.find(([, v]) => v < lo || v > hi);
      all.push(...values.map(([, v]) => v));
      tally.add(l, point, Boolean(bad));
      if (bad && !worst) worst = { point, dir: bad[0], v: bad[1] };
    }
    if (!all.length) return result(c, "unknown", { expected, note: "no timetable to measure" });
    const unit = per === "direction" ? "a direction" : "a day";
    // Nothing counted anywhere while trips are required: the line does not run in the scope.
    const none = lo > 0 && all.every((v) => v === 0);
    const measured = none ? `no trip of line ${l.short_name || l.id} in the scope${tally.suffix()}` : worst ? `${worst.dir !== "" ? `dir ${worst.dir}: ` : ""}${worst.v}${where(worst.point, true)} (expected ${bounds})${tally.suffix()}` : `${Math.min(...all)}–${Math.max(...all)} ${unit}${tally.suffix()}`;
    return result(c, worst || none ? "fail" : "pass", { expected, measured, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid(), ...((worst || none) && repeated > 1 ? { note: repeatedNote(at.name, repeated) } : {}) });
  },

  // A trip at each stated time at that stop (towards a stop when named), on
  // every timetable; present: false — no such trip any more.
  departure_at(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const need = [["line", p.line], ["stop", p.stop], ["times", timesOf(p.times).join("")]].filter(([, v]) => !str(v?.name ?? v)).map(([k]) => k);
    if (need.length) return result(c, "unknown", { note: `incomplete clause (${need.join(", ")})` });
    const times = timesOf(p.times).map(clockOf);
    if (times.some((x) => x == null)) return result(c, "unknown", { note: "incomplete clause (times as HH:MM)" });
    const tol = (num(p.tolerance_min) ?? 0) * 60;
    const arrival = p.event === "arrival";
    const present = !(p.present === false || p.present === "false");
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    // A towards written « Origin → Destination » is the direction (clauseDirection), never a stop.
    const named = stopsOfClause(ctx, l, [p.stop, str(p.towards?.name ?? p.towards) && !isDirectionLabel(p.towards) ? p.towards : null]);
    if (named.result) return named.result(c);
    const [S, T] = named.stops;
    // Which call the stop is when a trip bears its name several times (a grid's terminus row « Centre Bourg » after
    // two villages of that name: last); without it the first (callOf).
    const occurrence = occurrenceOf(p);
    if (occurrence?.error) return result(c, "unknown", { note: occurrence.error });
    const way = clauseDirection(spec, l, p);
    if (way.error) return result(c, "unknown", { note: way.error });
    const q = withDirection(p, way.dir);
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    const what = `${present ? "" : "no "}${arrival ? "arrival" : "departure"}${times.length > 1 ? "s" : ""} at ${S.name}${occurrenceText(occurrence)} at ${times.map(fmt).join(", ")}${T ? ` towards ${T.name}` : ""}${tol ? ` (± ${tol / 60} min)` : ""}`;
    const expected = `${what} (${scope.label || "…"}${directionLabel(p, way.dir)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const tally = gridTally(scope);
    let problem = null;
    let repeated = 0;
    // Whether an arrival was read past a trip's origin (a loop's return), as the note on a failure says.
    let past = false;
    for (const point of gridOf(scope, ctx, [l])) {
      const trips = tripsOf(ctx, l, point);
      if (trips === null) return result(c, "unknown", { expected, note: "timetable not compiled" });
      const calls = [];
      // The arrivals of the trips that end at the stop: a time asked as a departure that is one is said so.
      const ends = [];
      for (const t of trips) {
        if (!sameDirection(t, q)) continue;
        let i = callOf(t, S.keys, occurrence);
        if (i < 0) continue;
        if (occurrence == null) repeated = Math.max(repeated, callsOfStop(t, S.keys));
        // Without an occurrence, an arrival is read where the trip first reaches the stop: past its origin on a loop
        // (it starts there and comes back), never at the origin no one arrives on.
        if (arrival && occurrence == null && startsThere(t, i)) {
          const back = indexIn(t, S.keys, i + 1);
          if (back >= 0) {
            i = back;
            past = true;
          }
        }
        // A departure is a call the trip leaves from — never its last, where it arrives and ends; an arrival, a call
        // it reaches — never its first, where it starts (a trip of a single call is both).
        if (arrival ? startsThere(t, i) : endsThere(t, i)) {
          if (!arrival && t.arr[i] != null) ends.push(Math.floor(t.arr[i] / 60) * 60);
          continue;
        }
        // A published time is to the minute: 06:38:38 departs at 06:38.
        const at = arrival ? t.arr[i] : t.dep[i];
        if (at == null) continue;
        // Towards T: T later in the trip — or, for an arrival, T itself (arriving at the terminus « towards » it).
        calls.push({ t, at: Math.floor(at / 60) * 60, ok: !T || indexIn(t, T.keys, arrival ? i : i + 1) >= 0 });
      }
      let bad = null;
      for (const x of times) {
        const near = calls.filter((k) => Math.abs(k.at - x) <= tol);
        if (present && near.some((k) => k.ok)) continue;
        if (!present) {
          if (near.some((k) => k.ok)) bad = bad || `${fmt(x)} still runs at ${S.name}${where(point, true)}`;
          continue;
        }
        if (T && near.length) {
          const at = where(point, true);
          bad = bad || `${fmt(x)} at ${S.name} goes to ${near[0].t.names[near[0].t.names.length - 1]}, not ${T.name}${at.startsWith(" on") ? `,${at}` : at}`;
          continue;
        }
        if (ends.some((y) => Math.abs(y - x) <= tol)) {
          bad = bad || `${fmt(x)} at ${S.name} is an arrival${where(point, true)}: its trip ends there, no departure`;
          continue;
        }
        const ok = calls.filter((k) => k.ok).map((k) => k.at);
        const before = ok.filter((y) => y < x).sort((a, b) => b - a)[0];
        const after = ok.filter((y) => y > x).sort((a, b) => a - b)[0];
        const nearest = [before, after].filter((y) => y != null).map(fmt);
        bad = bad || `${fmt(x)} missing at ${S.name}${where(point, true)} (${nearest.length ? `nearest ${nearest.join(", ")}` : "no trip"})`;
      }
      tally.add(l, point, Boolean(bad));
      if (bad && !problem) problem = bad;
    }
    const measured = problem ? `${problem}${tally.suffix()}` : `${present ? "" : "none at "}${times.map(fmt).join(", ")} at ${S.name}${T ? ` towards ${T.name}` : ""}${tally.suffix()}`;
    return result(c, problem ? "fail" : "pass", { expected, measured, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid(), ...(problem && repeated > 1 ? { note: repeatedNote(S.name, repeated, past) } : {}) });
  },

  // The trips from the first listed stop to the last one (later in the
  // trip: the order is directional) serve the listed stops in that order;
  // `avoid`: no trip in scope serves those stops.
  stop_pattern(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const listed = listOf(p.stops);
    const avoid = listOf(p.avoid);
    if (!(listed.length >= 2) && !avoid.length) return result(c, "unknown", { note: "incomplete clause (stops: at least two, or avoid)" });
    if (!str(p.line)) return result(c, "unknown", { note: "incomplete clause (line)" });
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    const named = stopsOfClause(ctx, l, listed.length >= 2 ? listed : []);
    if (named.result) return named.result(c);
    const S = named.stops;
    const V = [];
    for (const ref of avoid) {
      const k = stopKeys(ctx, ref);
      if (!k) return result(c, "unknown", { note: `no stop named ${ref} in the network` });
      V.push(k);
    }
    const dir = directionIn([{ spec, line: l }], p.direction);
    if (dir?.error) return result(c, "unknown", { note: dir.error });
    const q = withDirection(p, dir);
    const mode = ["through", "all", "any"].includes(p.trips) ? p.trips : "through";
    const exact = p.exact === true || p.exact === "true";
    const ends = p.ends === true || p.ends === "true";
    const scope = scopeOf(c, ctx, { defaultDay: "daily" });
    const order = S.map((x) => x.name).join(" > ");
    const expected = `${S.length ? `${mode === "any" ? "a trip" : mode === "all" ? "every trip" : `every trip from ${S[0].name} to ${S[S.length - 1].name}`} serves ${order}${exact ? ", no other stop between" : ""}${ends ? ", terminus to terminus" : ""}` : "no trip"}${V.length ? `${S.length ? "; " : " "}not serving ${V.map((x) => x.name).join(", ")}` : ""} (${scope.label || "…"}${directionLabel(p, dir)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const matches = (e) => {
      if (!S.length) return true;
      if (e.i < 0 || e.j < 0) return false;
      if (ends && (e.i !== 0 || e.j !== e.t.keys.length - 1)) return false;
      if (exact) return e.j - e.i === S.length - 1 && S.every((x, k) => x.keys.has(e.t.keys[e.i + k]));
      let k = 1;
      for (let x = e.i + 1; x < e.j && k < S.length - 1; x++) if (S[k].keys.has(e.t.keys[x])) k++;
      return k === S.length - 1;
    };
    const tally = gridTally(scope);
    let seen = 0;
    let perDay = 0;
    let problem = null;
    for (const point of gridOf(scope, ctx, [l])) {
      const trips = spec.kind === "feed" || ctx.tables ? tripsOf(ctx, l, point) : patternTrips(ctx, l, point);
      const inScope = [];
      // No direction named: the trips running the stops the other way round are the way back, not the clause's (wayBackOf).
      const back = !dir && S.length >= 2 ? wayBackOf(trips || [], S) : null;
      for (const t of trips || []) {
        if (!sameDirection(t, q)) continue;
        if (!S.length) {
          inScope.push({ t, i: -1, j: -1 });
          continue;
        }
        const i = indexIn(t, S[0].keys);
        const j = i < 0 ? -1 : indexIn(t, S[S.length - 1].keys, i + 1);
        if (mode === "through" && j < 0) continue;
        if (back && j < 0 && back.has(t, i)) continue;
        inScope.push({ t, i, j });
      }
      seen += inScope.length;
      perDay = Math.max(perDay, inScope.length);
      const wrong = inScope.filter((e) => !matches(e));
      const orderBad = mode === "any" ? inScope.length > 0 && wrong.length === inScope.length : wrong.length > 0;
      const served = V.map((v) => ({ v, n: inScope.filter((e) => e.t.keys.some((k) => v.keys.has(k))).length })).filter((x) => x.n);
      tally.add(l, point, orderBad || served.length > 0);
      if (problem) continue;
      if (orderBad) {
        const e = wrong[0];
        const names = e.i >= 0 && e.j > e.i ? e.t.names.slice(e.i, e.j + 1) : e.t.names;
        problem = `${wrong.length} trip${wrong.length === 1 ? "" : "s"}${where(point, true)} run${wrong.length === 1 ? "s" : ""} ${names.join(" > ")} (${e.t.first != null ? `first ${fmt(e.t.first)}, ` : ""}dir ${e.t.direction})`;
      } else if (served.length) problem = `${served[0].v.name} still served by ${served[0].n} trip${served[0].n === 1 ? "" : "s"}${where(point, true)}`;
    }
    if (!seen) return result(c, "fail", { expected, measured: `${S.length ? `no trip runs from ${S[0].name} to ${S[S.length - 1].name}` : "no trip"}${tally.suffix()}`, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
    const measured = problem ? `${problem}${tally.suffix()}` : `${perDay} trips a day${S.length ? " in this order" : ""}${V.length ? `, none serving ${V.map((x) => x.name).join(", ")}` : ""}${tally.suffix()}`;
    return result(c, problem ? "fail" : "pass", { expected, measured, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // On the scope's dates the lines run exactly the timetable of a reference
  // day (like_week: the same weekday of that week), in the feed before the
  // plan or the feed measured (see refSide).
  same_as(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const likeDate = given(p.like_date) ? parseYmd(p.like_date) : null;
    const likeWeek = given(p.like_week) ? parseYmd(p.like_week) : null;
    if (!likeDate && !likeWeek) return result(c, "unknown", { note: given(p.like_date) || given(p.like_week) ? `"${p.like_date || p.like_week}" is not a date (YYYY-MM-DD)` : "incomplete clause (like_date or like_week)" });
    if (!given(dayWordsOf(p)) && !["dates", "from_date", "to_date", "period"].some((k) => given(p[k]))) return result(c, "unknown", { note: "say when the timetable must be the same (a day, dates or a period)" });
    const lines = linesOfClause(spec, p);
    if (lines.missing) return result(c, "fail", { expected: `line ${lines.missing}`, measured: "no such line" });
    const design = spec.kind !== "feed";
    const scope = scopeOf(c, ctx);
    const refOf = (d) => (likeDate || (d ? weekDay(likeWeek, dowOfYmd(d)) : null));
    const refText = likeDate ? iso(likeDate) : `the week of ${iso(likeWeek)}`;
    // A design compares within itself (like_in does not apply).
    const side = design ? { spec: null, word: "", baseline: "self" } : refSide(ctx, p, lines.list, likeDate ? [likeDate] : weekDates(likeWeek));
    if (side.error) return result(c, "unknown", { note: side.error });
    const sideWord = design ? "" : ` (${side.word})`;
    const refSpec = side.spec || spec;
    // The direction read on each line and on its reference (directionIn): the lines named are held to it.
    const named = listOf(p.lines).length + listOf(p.line).length > 0;
    const dirs = new Map(lines.list.map((l) => [l.id, directionIn([{ spec, line: l }, ...(side.spec ? [{ spec: refSpec, line: pairedLine(refSpec, l) }] : [])], p.direction)]));
    const expected = `${lines.label}: the same trips as ${refText}${sideWord} (${scope.label || "…"}${directionLabel(p, lines.list.length === 1 ? readDirection(dirs.get(lines.list[0].id)) : null)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    if (scope.structural && !likeDate) return result(c, "unknown", { expected, note: "like_week needs dates on a design: give from_date/to_date or dates" });
    const refCtx = side.spec ? { spec: side.spec, tables: null } : ctx;
    const refCal = calendarOf(refSpec);
    const win = clockWindow(p);
    if (win.error) return result(c, "unknown", { expected, note: win.error });
    const tolS = (num(p.tolerance_min) ?? 0) * 60;
    const tally = gridTally(scope);
    let problem = null;
    let shownRef = null;
    let missingRef = null;
    let undirected = null;
    const measuredLines = [];
    for (const l of lines.list) {
      const dir = dirs.get(l.id);
      if (dir?.error) {
        if (unreadDirection(dir, named)) return result(c, "unknown", { expected, note: dir.error });
        undirected = undirected || dir;
        continue;
      }
      const q = withDirection(p, dir);
      measuredLines.push(l.id);
      const refLine = side.spec ? pairedLine(refSpec, l) : l;
      for (const point of gridOf(scope, ctx, [l], { splitBy: likeWeek ? dowOfYmd : null })) {
        const r = refOf(point.date);
        if (!r) return result(c, "unknown", { expected, note: "like_week needs dates on a design" });
        const v = refCal.validity;
        if (v && (r < v.start || r > v.end)) return result(c, "unknown", { expected, note: `the reference date ${iso(r)} is outside the validity of the feed ${side.word || ""} (${iso(v.start)} → ${iso(v.end)})`.replace("  ", " ") });
        const mine = timetableTrips(ctx, l, point, null);
        const theirs = refLine ? timetableTrips(refCtx, refLine, null, r) : [];
        // No reference trip: this timetable cannot be compared (a failure elsewhere still decides).
        if (!theirs || !theirs.length) {
          missingRef = missingRef || `nothing to compare with: line ${l.short_name} has no trip on ${iso(r)}`;
          continue;
        }
        const keep = (t) => sameDirection(t, q) && win.has(t.first);
        const a = theirs.filter(keep);
        const b = (mine || []).filter(keep);
        const diff = diffTrips(a, b, tolS);
        const bad = diff.missing.length > 0 || diff.extra.length > 0;
        tally.add(l, point, bad);
        if (!shownRef) shownRef = r;
        if (bad && !problem) {
          const firstOf = (xs) => (xs.length ? fmt(Math.min(...xs.map((t) => t.first))) : "none");
          const sample = diff.missing.slice(0, 3).map((t) => fmt(t.first)).join(", ");
          problem = `${lines.list.length > 1 ? `line ${l.short_name} ` : ""}${point.date ? `on ${iso(point.date)}` : `(${point.label})`}: ${b.length} trips vs ${a.length} on ${iso(r)}${sideWord}; first departure ${firstOf(b)} vs ${firstOf(a)}; ${diff.missing.length} missing${diff.missing.length ? ` (${sample}${diff.missing.length > 3 ? ", …" : ""})` : ""}, ${diff.extra.length} extra`;
        }
      }
    }
    if (!problem && missingRef) return result(c, "unknown", { expected, note: missingRef, baseline: side.baseline });
    if (!tally.count() && undirected) return result(c, "unknown", { expected, note: undirected.error });
    if (!tally.count()) return result(c, "unknown", { expected, note: "no line to measure" });
    const measured = problem ? `${problem}${tally.suffix()}` : `same trips as ${likeDate ? iso(likeDate) : iso(shownRef)}${sideWord}${tally.suffix()}`;
    return result(c, problem ? "fail" : "pass", { expected, measured, lines: measuredLines, measured_on: tally.measuredOn(), grid: tally.grid(), baseline: side.baseline });
  },

  // Compared with the feed before the plan (ctx.baseline), nothing changes
  // on the scope's dates except what `except` names: lines, trips leaving
  // in [from, to] (bounds inclusive), a direction, passings at some stops,
  // and the trips of each scope except.trips lists (tripScopesOf). The
  // directions (the clause's own, except.direction, a scope's) are read on
  // each line in both feeds (directionIn).
  unchanged_except(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    if (spec.kind !== "feed") return result(c, "unknown", { note: "no reference network to compare with" });
    if (!ctx.baseline) return result(c, "unknown", { note: "compares with the feed before the plan: none here" });
    if (ctx.baseline.self) return result(c, "pass", { expected: "unchanged", measured: "the feed before the plan (reference)", baseline: "before" });
    const ex = p.except && typeof p.except === "object" ? p.except : {};
    // except.direction is read on each line below: the carve holds its id there.
    const carve = { from: given(ex.from) ? clockOf(ex.from) : null, to: given(ex.to) ? clockOf(ex.to) : null, direction: null, stops: null };
    if ((given(ex.from) && carve.from == null) || (given(ex.to) && carve.to == null)) return result(c, "unknown", { note: "incomplete clause (except.from / except.to as HH:MM)" });
    const scopes = tripScopesOf(c, ctx);
    if (scopes.error) return result(c, "unknown", { note: scopes.error });
    if (carve.from != null && carve.to == null) carve.to = Infinity;
    if (carve.to != null && carve.from == null) carve.from = -Infinity;
    const exStops = listOf(ex.stops);
    if (exStops.length) {
      carve.stops = new Set();
      for (const ref of exStops) {
        const k = stopKeys(ctx, ref) || stopKeys({ spec: ctx.baseline.spec }, ref);
        if (!k) return result(c, "unknown", { note: `no stop named ${ref} in the network` });
        k.keys.forEach((x) => carve.stops.add(x));
      }
    }
    const before = ctx.baseline.spec;
    const pairs = linePairs(spec, before, p);
    if (pairs.error) return result(c, "unknown", { note: pairs.error });
    // A truncation (except.beyond { stop, towards }): the passings past `stop` on the side of `towards`, on the
    // feed before's patterns of the lines compared, are left out — « limitées à Portes d'Albi, aux mêmes horaires
    // aux autres arrêts » names the stop the trips now end at, not every stop they no longer reach.
    const beyond = ex.beyond && typeof ex.beyond === "object" ? ex.beyond : null;
    if (beyond) {
      const at = stopKeys({ spec: before }, beyond.stop);
      const towards = stopKeys({ spec: before }, beyond.towards);
      if (!at || !towards) return result(c, "unknown", { note: `no stop named ${!at ? str(beyond.stop) : str(beyond.towards)} in the feed before the plan (except.beyond)` });
      carve.stops = carve.stops || new Set();
      const names = new Map((before.stops || []).map((s) => [s.id, s.name]));
      for (const { before: b } of pairs.list) {
        if (!b) continue;
        for (const pattern of patternsOfLine(b, before)) {
          const keys = (pattern.stops || []).map((id) => nameKey(names.get(id) || id));
          const i = keys.findIndex((k) => at.keys.has(k));
          const j = keys.findIndex((k) => towards.keys.has(k));
          if (i < 0 || j < 0 || i === j) continue;
          (j > i ? keys.slice(i + 1) : keys.slice(0, i)).forEach((k) => carve.stops.add(k));
        }
      }
      // The stop the trips are cut at stays compared (its passings must keep their times).
      at.keys.forEach((k) => carve.stops.delete(k));
    }
    const bv = calendarOf(before).validity;
    const av = calendarOf(spec).validity;
    const inter = bv && av ? { start: bv.start > av.start ? bv.start : av.start, end: bv.end < av.end ? bv.end : av.end } : av;
    const scope = scopeOf(c, ctx, { everyDate: true, validity: inter });
    // A direction read on a line in both feeds (a line the plan rebuilt still goes where it went).
    const readOn = (pair, value) => directionIn([{ spec, line: pair.after }, { spec: before, line: pair.before }], value);
    const one = pairs.list.length === 1 ? pairs.list[0] : null;
    const exDirection = given(ex.direction) ? readDirection(one ? readOn(one, ex.direction) : null)?.label || str(ex.direction) : null;
    const exceptText = [
      listOf(ex.lines).length && (listOf(p.lines).length || listOf(p.line).length) ? `lines ${listOf(ex.lines).join(", ")}` : null,
      carve.from != null || carve.to != null ? `trips leaving ${Number.isFinite(carve.from) ? fmt(carve.from) : "…"}–${Number.isFinite(carve.to) ? fmt(carve.to) : "…"} (bounds included)${exDirection != null ? `, direction ${exDirection}` : ""}` : exDirection != null ? `trips in direction ${exDirection}` : null,
      exStops.length ? `passings at ${exStops.join(", ")}` : null,
      beyond ? `passings past ${str(beyond.stop)} towards ${str(beyond.towards)}` : null,
      scopes.parts.length ? `the trips of ${listText(scopes.parts.map((x) => tripScopeText(x, spec)))}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    const expected = `${pairs.label} unchanged compared with the feed before the plan${exceptText ? `, except ${exceptText}` : ""} (${scope.label || "every date"}${directionLabel(p, one ? readDirection(readOn(one, p.direction)) : null)})`;
    // Nothing left to compare is never a pass (except.lines naming every line in scope).
    if (!pairs.list.length) return result(c, "unknown", { expected, note: "no line left to compare (every line named is excepted)", baseline: "before" });
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note, baseline: "before" });
    // Dates past the feed before's validity (a plan that extended it, e.g. « le samedi reste à 30 min (inchangé) »
    // over a September the feed before does not reach): « inchangé »
    // there is the timetable the line ran before the plan on the same weekday of the same scope (its day and period
    // words read over that validity: a school Monday with a school Monday) — each such date is compared with the
    // latest date the feed before covers on that weekday. A weekday it never ran in the scope stays unknown.
    const outside = bv ? scope.dates.filter((d) => d < bv.start || d > bv.end) : [];
    const likeOf = new Map();
    if (outside.length) {
      const { from_date: _from, to_date: _to, dates: _dates, ...rest } = p; // eslint-disable-line no-unused-vars
      const covered = scopeOf({ ...c, params: rest }, { ...ctx, today: null }, { everyDate: true, validity: bv });
      const span = `${iso(outside[0])} → ${iso(outside[outside.length - 1])}`;
      if (covered.error || covered.note) return result(c, "unknown", { expected, note: `the feed before does not cover ${span} (${covered.error || covered.note})`, baseline: "before" });
      for (const d of outside) {
        const like = covered.dates.filter((x) => dowOfYmd(x) === dowOfYmd(d)).at(-1);
        if (!like) return result(c, "unknown", { expected, note: `the feed before does not cover ${span} and ran no ${dowOfYmd(d)} of this scope`, baseline: "before" });
        likeOf.set(d, like);
      }
    }
    const tally = gridTally(scope);
    const failing = [];
    let problem = null;
    let undirected = null;
    const named = listOf(p.lines).length + listOf(p.line).length > 0;
    for (const pair of pairs.list) {
      const { after: a, before: b, name } = pair;
      // The clause's own direction (only its trips are compared) and except's (its trips are left out), on this line.
      const own = readOn(pair, p.direction);
      const out = readOn(pair, ex.direction);
      const unread = [own, out].find((d) => unreadDirection(d, named));
      if (unread) return result(c, "unknown", { expected, note: unread.error, baseline: "before" });
      // Said of every line: a line no trip of which goes the clause's way has nothing to compare, one none of whose
      // trips go except's way nothing to leave out.
      if (own?.error) {
        undirected = undirected || own;
        continue;
      }
      const keep = (t) => sameDirection(t, withDirection(p, own));
      const lineCarve = out?.error ? { ...carve, from: null, to: null } : { ...carve, direction: out ? out.id : null };
      // The scopes of except.trips on this line: those naming it (or no line), their direction and stop read here.
      const here = [];
      for (const x of scopes.parts) {
        if (x.lines.length && !x.lines.some((n) => [a, b].some((l) => l && findLine({ lines: [l] }, n) === l))) continue;
        const dir = readOn(pair, x.direction);
        if (dir?.error) {
          if (x.lines.length || !dir.none) return result(c, "unknown", { expected, note: `except.trips ${x.label}: ${dir.error}`, baseline: "before" });
          continue;
        }
        const atKeys = x.at ? new Set([...(stopKeys(ctx, x.at)?.keys || []), ...(stopKeys({ spec: before }, x.at)?.keys || [])]) : null;
        if (atKeys && !atKeys.size) return result(c, "unknown", { expected, note: `except.trips ${x.label}: no stop named ${x.at} in the network`, baseline: "before" });
        here.push({ ...x, dir: dir ? dir.id : null, atKeys });
      }
      // The same trips on the same dates in both feeds: unchanged on every date, its timetables only counted.
      if (a && b && typeof spec.fingerprintOf === "function" && typeof before.fingerprintOf === "function" && spec.fingerprintOf(a.id) === before.fingerprintOf(b.id)) {
        for (const point of gridOf(scope, ctx, [a])) tally.add(a, point, false);
        continue;
      }
      // Dates compared once per timetable of both feeds — and per the scopes they fall in (scopeOnDate).
      const onDate = (d) => here.map((x) => scopeOnDate(x, d, spec, before)).join("");
      const groups = new Map();
      for (const d of scope.dates) {
        const like = likeOf.get(d) || null;
        const key = `${like ? `~${b ? before.dateSignature(like, [b]) : ""}` : b ? before.dateSignature(d, [b]) : ""}#${a ? spec.dateSignature(d, [a]) : ""}#${onDate(d)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
      }
      const bad = [];
      for (const dates of groups.values()) {
        const d = dates[0];
        const bits = onDate(d);
        // A date past the feed before's validity reads the feed before on its like date (likeOf).
        const like = likeOf.get(d) || null;
        const tb = b ? before.tripsOnDate(b.id, like || d) : [];
        const ta = a ? spec.tripsOnDate(a.id, d) : [];
        // The scopes of the date, their times read as the operators read them there (past midnight: scopeOnDay).
        const on = here.map((x, i) => (bits[i] === "0" ? null : scopeOnDay(x, bits[i], d, [[before, tb], [spec, ta]])));
        // The trips a scope of the date leaves out, in the feed they run in.
        const kept = (feed, trips) => trips.filter((t) => keep(t) && !on.some((x, i) => x && scopeHolds(x, bits[i], t, d, feed)));
        const names = new Map();
        const pb = passings(kept(before, tb), lineCarve, names);
        const pa = passings(kept(spec, ta), lineCarve, names);
        const diff = multisetDiff(pb, pa);
        const changed = diff.missing.length > 0 || diff.extra.length > 0;
        tally.add(a || b, { date: d, dates }, changed);
        if (changed) bad.push({ d, dates, diff, names, like });
      }
      if (!bad.length) continue;
      failing.push((a || b).id);
      if (problem) continue;
      const first = bad[0];
      const others = new Set(bad.flatMap((x) => x.dates));
      others.delete(first.d);
      const show = (x) => {
        const [dir, key, t] = x.split("|");
        return `dir ${dir} ${first.names.get(key) || key} ${fmt(Number(t))}`;
      };
      problem = `line ${name} changed on ${iso(first.d)}${first.like ? ` (compared with ${iso(first.like)}, the same weekday the feed before covers)` : ""}${others.size ? ` (+ ${others.size} dates, ${bad.length} timetable${bad.length === 1 ? "" : "s"})` : ""}: ${first.diff.missing.length} passings missing${first.diff.missing.length ? ` (${first.diff.missing.slice(0, 3).map(show).join(", ")}${first.diff.missing.length > 3 ? ", …" : ""})` : ""}, ${first.diff.extra.length} new`;
    }
    if (!problem && !tally.count() && undirected) return result(c, "unknown", { expected, note: undirected.error, baseline: "before" });
    if (!problem && !tally.count()) return result(c, "unknown", { expected, note: "no timetable to compare on the scope's dates", baseline: "before" });
    const compared = tally.lines().length || pairs.list.length;
    const measured = problem || `unchanged — ${compared} line${compared === 1 ? "" : "s"}, ${tally.count()} timetable${tally.count() === 1 ? "" : "s"}, ${scope.dates.length} dates${likeOf.size ? ` (${likeOf.size} past the feed before's validity, compared with the same weekday it covers)` : ""}`;
    // A scope whose period could not be read was left out on its every date: said beside the verdict.
    return result(c, problem ? "fail" : "pass", { expected, measured, lines: failing, measured_on: tally.measuredOn(), grid: tally.grid(), baseline: "before", ...(scopes.notes.length ? { note: scopes.notes.join("; ") } : {}) });
  },

  // ── The connection, accessibility, identity, validity, coverage and volume kinds ──

  // A guaranteed connection at a stop: on every timetable of the scope, each
  // arrival of the feeder (a line's trips arriving there, or the external
  // arrival times the brief lists) in the window has a departure of the
  // other service (a line's trips leaving there, or the external departure
  // times) between min_wait and max_wait minutes later — or, `each:
  // "departure"`, each departure of the other service in the window has an
  // arrival of the feeder that much earlier (a bus for every TER departure:
  // not every bus has a train to catch). radius_m widens the stop to the
  // stops within that distance of it (a bus stop in front of the station). A
  // line whose guaranteed events never happen there in the scope fails; a
  // design without compiled tables cannot be measured.
  transfer_max_wait(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const stopRef = str(p.stop?.name ?? p.stop);
    const maxWait = num(p.max_wait);
    const minWait = num(p.min_wait) ?? 0;
    const side = (lineKey, timesKey) => ({ line: str(p[lineKey]) ? str(p[lineKey]) : null, times: given(p[timesKey]) ? timesOf(p[timesKey]).map(clockOf) : null });
    const feeder = side("from_line", "from_times");
    const onward = side("to_line", "to_times");
    const need = [!stopRef && "stop", !feeder.line && !feeder.times && "from_line or from_times", !onward.line && !onward.times && "to_line or to_times", maxWait == null && "max_wait"].filter(Boolean);
    if (need.length) return result(c, "unknown", { note: `incomplete clause (${need.join(", ")})` });
    if ((feeder.line && feeder.times) || (onward.line && onward.times)) return result(c, "unknown", { note: "each side of the connection is a line or a list of times, not both" });
    if ([feeder.times, onward.times].some((t) => t && (!t.length || t.some((x) => x == null)))) return result(c, "unknown", { note: "incomplete clause (from_times / to_times as HH:MM)" });
    if (!feeder.line && !onward.line) return result(c, "unknown", { note: "nothing of the network to measure: name a line on one side at least" });
    if (!(maxWait >= 0) || minWait < 0 || minWait > maxWait) return result(c, "unknown", { note: "incomplete clause (0 ≤ min_wait ≤ max_wait, in minutes)" });
    const fromLine = feeder.line ? findLine(spec, feeder.line) : null;
    const toLine = onward.line ? findLine(spec, onward.line) : null;
    if (feeder.line && !fromLine) return result(c, "fail", { expected: `line ${feeder.line}`, measured: "no such line" });
    if (onward.line && !toLine) return result(c, "fail", { expected: `line ${onward.line}`, measured: "no such line" });
    const k = stopKeys(ctx, stopRef);
    if (!k) return result(c, "unknown", { note: `no stop named ${stopRef} in the network` });
    const keys = new Set(k.keys);
    const radius = num(p.radius_m) || 0;
    if (radius > 0) {
      const anchors = (spec.stops || []).filter((s) => k.keys.has(nameKey(s.name)) && Number.isFinite(num(s.lat)));
      for (const s of spec.stops || []) if (Number.isFinite(num(s.lat)) && anchors.some((a) => haversineMeters(a.lat, a.lon, s.lat, s.lon) <= radius)) keys.add(nameKey(s.name));
    }
    for (const l of [fromLine, toLine].filter(Boolean)) {
      const served = servedKeysOf(spec, l);
      if (![...keys].some((x) => served.has(x))) return result(c, "fail", { expected: `line ${l.short_name} at ${k.name}`, measured: `line ${l.short_name} does not serve ${k.name}${radius ? ` (nor a stop within ${radius} m)` : ""}`, lines: [l.id] });
    }
    const win = clockWindow(p);
    if (win.error) return result(c, "unknown", { note: win.error });
    // Each side's direction read on its line (directionIn), as its id.
    const fromDir = fromLine ? directionIn([{ spec, line: fromLine }], p.from_direction) : null;
    const toDir = toLine ? directionIn([{ spec, line: toLine }], p.to_direction) : null;
    const unread = [fromDir, toDir].find((d) => d?.error);
    if (unread) return result(c, "unknown", { note: unread.error });
    const scope = scopeOf(c, ctx, { defaultDay: "weekday" });
    const label = (l, times, dir) => (l ? `line ${l.short_name}${dir ? ` (direction ${dir.label})` : ""}` : `the external timetable (${times.length} time${times.length === 1 ? "" : "s"})`);
    // Which side is guaranteed: every arrival of the feeder (default), or every departure of the onward service.
    const byDeparture = p.each === "departure";
    const ofFrom = label(fromLine, feeder.times, fromDir);
    const ofTo = label(toLine, onward.times, toDir);
    const expected = `at ${k.name}${radius ? ` (or within ${radius} m)` : ""}: ${byDeparture ? `every departure of ${ofTo} has an arrival of ${ofFrom} ${minWait}–${maxWait} min before` : `every arrival of ${ofFrom} has a departure of ${ofTo} ${minWait}–${maxWait} min later`}${win.text} (${scope.label || "…"})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const lines = [...new Map([fromLine, toLine].filter(Boolean).map((l) => [l.id, l])).values()];
    const lo = minWait * 60;
    const hi = maxWait * 60;
    const tally = gridTally(scope);
    const word = byDeparture ? "departure" : "arrival";
    let guarded = 0;
    let longest = null;
    let problem = null;
    for (const point of gridOf(scope, ctx, lines)) {
      const arr = fromLine ? callsAt(ctx, fromLine, point, keys, "arr", fromDir?.id ?? null) : feeder.times.map((at) => ({ at, trip: null }));
      const dep = toLine ? callsAt(ctx, toLine, point, keys, "dep", toDir?.id ?? null) : onward.times.map((at) => ({ at, trip: null }));
      if (arr === null || dep === null) return result(c, "unknown", { expected, note: "timetable not compiled" });
      const events = (byDeparture ? dep : arr).filter((e) => win.has(e.at));
      guarded += events.length;
      const missed = [];
      for (const e of events) {
        // The partner the transfer time allows, nearest first (a departure of the same trip is no connection):
        // after an arrival, the first departure at least min_wait later; before a departure, the last arrival at least min_wait earlier.
        const partner = byDeparture ? [...arr].reverse().find((a) => e.at - a.at >= lo && (!e.trip || a.trip !== e.trip)) : dep.find((d) => d.at - e.at >= lo && (!e.trip || d.trip !== e.trip));
        const wait = partner ? Math.abs(partner.at - e.at) : null;
        if (partner && wait <= hi) {
          if (!longest || wait > longest.wait) longest = { wait, e, partner, point };
        } else missed.push({ e, partner, wait });
      }
      tally.add(null, point, missed.length > 0);
      if (missed.length && !problem) {
        const shown = missed.slice(0, 3).map((x) => `${fmt(x.e.at)} ${byDeparture ? "←" : "→"} ${x.partner ? `${fmt(x.partner.at)} (${Math.round(x.wait / 60)} min)` : `no ${byDeparture ? "arrival" : "departure"}`}`).join(", ");
        problem = `${missed.length} of ${events.length} ${word}${events.length === 1 ? "" : "s"}${where(point, true)} without a connection within ${minWait}–${maxWait} min (${shown}${missed.length > 3 ? ", …" : ""})`;
      }
    }
    if (!tally.count()) return result(c, "unknown", { expected, note: "no timetable to measure" });
    if (!guarded) {
      // An external timetable with nothing in the window says nothing; a line whose guaranteed calls never happen there fails.
      const l = byDeparture ? toLine : fromLine;
      if (!l) return result(c, "unknown", { expected, note: `no ${word} time in the window` });
      return result(c, "fail", { expected, measured: `no ${word} of line ${l.short_name} at ${k.name} in the scope${win.text}${tally.suffix()}`, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
    }
    const measured = problem ? `${problem}${tally.suffix()}` : `${guarded} ${word}${guarded === 1 ? "" : "s"} connected, longest wait ${Math.round(longest.wait / 60)} min (${fmt(longest.e.at)} ${byDeparture ? "←" : "→"} ${fmt(longest.partner.at)}${where(longest.point)})${tally.suffix()}`;
    return result(c, problem ? "fail" : "pass", { expected, measured, lines: lines.map((l) => l.id), measured_on: tally.measuredOn(), grid: tally.grid() });
  },

  // The share of stops (the stops named — a station with its platforms, a
  // platform without its own value taking its station's — or those the
  // lines serve) whose wheelchair_boarding is 1, or of the lines' trips
  // whose wheelchair_accessible is 1 (a real feed: a design does not say).
  // A stop without information counts as not accessible.
  // ── The calls' pickup and drop-off types: on demand (TAD), regular, drop-off only, pickup only ──
  // Every trip of the line (its direction when given) that calls at the stops named, or that runs the stretch
  // from_stop → to_stop (both inclusive, in the trip's order; from_stop alone to the terminus, to_stop alone from the
  // origin), has the promised types at those calls, on every timetable of the scope. A real feed only.
  pickup_dropoff(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    if (!str(p.line)) return result(c, "unknown", { note: "incomplete clause (line)" });
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    const want = accessWanted(p);
    if (want.error) return result(c, "unknown", { note: want.error });
    const listed = listOf(p.stops);
    const stretch = given(p.from_stop) || given(p.to_stop);
    if (!listed.length && !stretch) return result(c, "unknown", { note: "incomplete clause (stops, or from_stop / to_stop)" });
    const named = stopsOfClause(ctx, l, listed.length ? listed : [given(p.from_stop) ? p.from_stop : null, given(p.to_stop) ? p.to_stop : null]);
    if (named.result) return named.result(c);
    const S = named.stops;
    const dir = directionIn([{ spec, line: l }], p.direction);
    if (dir?.error) return result(c, "unknown", { note: dir.error });
    const q = withDirection(p, dir);
    const whereText = listed.length ? `at ${listText(S.map((x) => x.name), 5)}` : S[0] && S[1] ? `from ${S[0].name} to ${S[1].name}` : S[0] ? `from ${S[0].name} to the terminus` : `from the origin to ${S[1].name}`;
    const label = l.short_name || l.id;
    const expected = `${want.text} ${whereText} on line ${label}${dir ? ` (direction ${dir.id})` : ""}`;
    if (spec.kind !== "feed") return result(c, "unknown", { expected, note: "a designed network does not say how its calls are served (pickup and drop-off types)" });
    const scope = scopeOf(c, ctx, { defaultDay: "daily" });
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const tally = gridTally(scope);
    let calls = 0;
    let bad = 0;
    let first = null;
    let anyTrip = false;
    const badStops = new Set();
    for (const point of gridOf(scope, ctx, [l])) {
      let pointBad = false;
      for (const t of (tripsOf(ctx, l, point) || []).filter((x) => sameDirection(x, q))) {
        const range = listed.length ? null : stretchIn(t, S[0], S[1]);
        if (!listed.length && !range) continue;
        anyTrip = true;
        for (let i = 0; i < t.keys.length; i++) {
          if (!(listed.length ? S.some((x) => x.keys.has(t.keys[i])) : i >= range[0] && i <= range[1])) continue;
          calls += 1;
          const [pk, dk] = accessAt(t, i);
          const problem = want.check(pk, dk);
          if (!problem) continue;
          bad += 1;
          pointBad = true;
          badStops.add(t.stops?.[i] ?? t.keys[i]);
          if (!first) first = `${problem} at ${t.names[i]}${where(point, true)}`;
        }
      }
      tally.add(l, point, pointBad);
    }
    if (!anyTrip) return result(c, "unknown", { expected, note: listed.length ? `no trip of line ${label}${dir ? ` in direction ${dir.id}` : ""} on ${scope.label}` : `no trip of line ${label} runs ${whereText}${dir ? ` in direction ${dir.id}` : ""}` });
    if (!calls) return result(c, "unknown", { expected, note: "no call to measure" });
    return result(c, bad ? "fail" : "pass", { expected, measured: bad ? `${first} (${bad} of ${calls} calls)${tally.suffix()}` : `every call as promised (${calls} calls)${tally.suffix()}`, lines: [l.id], stops: [...badStops].slice(0, 20) });
  },

  // The shape of a line between two stops follows a reference line's: every trip running from_stop then to_stop has a
  // shape whose section between the two stops stays within tolerance_m of the reference section, both ways round
  // (Hausdorff): a straight line drawn where the reference bends fails, as does a trip without a shape.
  shape_follows(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const need = [["line", p.line], ["from_stop", p.from_stop], ["to_stop", p.to_stop], ["like_line", p.like_line]].filter(([, v]) => !str(v?.name ?? v)).map(([k]) => k);
    if (need.length) return result(c, "unknown", { note: `incomplete clause (${need.join(", ")})` });
    if (spec.kind !== "feed" || typeof spec.shapeOf !== "function") return result(c, "unknown", { note: "a designed network has no shapes to compare" });
    const tol = num(p.tolerance_m) ?? 30;
    const l = findLine(spec, p.line);
    if (!l) return missingLine(c);
    const ends = stopsOfClause(ctx, l, [p.from_stop, p.to_stop]);
    if (ends.result) return ends.result(c);
    const [A, B] = ends.stops;
    const dir = directionIn([{ spec, line: l }], p.direction);
    if (dir?.error) return result(c, "unknown", { note: dir.error });
    const q = withDirection(p, dir);
    // The reference line as it was before the plan when there is a feed before (the plan may have touched it too).
    const useBefore = Boolean(ctx.baseline && !ctx.baseline.self && p.like_in !== "after");
    const refSpec = useBefore ? ctx.baseline.spec : spec;
    const rl = findLine(refSpec, p.like_line);
    if (!rl) return result(c, "fail", { expected: `line ${str(p.like_line)}`, measured: `no such line${useBefore ? " in the feed before the plan" : ""}` });
    const ref = referenceShapeSection(refSpec, rl, A, B, p.like_direction);
    if (ref.error) return result(c, "unknown", { note: ref.error, ...(useBefore ? { baseline: "before" } : {}) });
    const scope = scopeOf(c, ctx, { defaultDay: "daily" });
    const expected = `${A.name} → ${B.name}: the route within ${tol} m of line ${rl.short_name}'s (${scope.label || "…"}${directionLabel(p, dir)})`;
    if (scope.error || scope.note) return result(c, "unknown", { expected, note: scope.error || scope.note });
    const tally = gridTally(scope);
    const noShape = [];
    let worst = null;
    let maxOk = 0;
    let count = 0;
    for (const point of gridOf(scope, ctx, [l])) {
      const trips = tripsOf(ctx, l, point);
      if (trips === null) return result(c, "unknown", { expected, note: "timetable not compiled" });
      let bad = false;
      for (const t of trips) {
        if (!sameDirection(t, q)) continue;
        const i = indexIn(t, A.keys);
        const j = i < 0 ? -1 : indexIn(t, B.keys, i + 1);
        if (j < 0) continue;
        count += 1;
        const pts = t.shape_id ? spec.shapeOf(t.shape_id) : null;
        if (!pts || pts.length < 2) {
          if (!noShape.includes(t.id)) noShape.push(t.id);
          bad = true;
          continue;
        }
        const sec = shapeSectionBetween(pts, stopCoord(spec, t.stops[i]), stopCoord(spec, t.stops[j]));
        const d = hausdorffM(sec, ref.points);
        if (d > tol) {
          bad = true;
          if (!worst || d > worst.d) worst = { d, trip: t.id, point };
        } else maxOk = Math.max(maxOk, d);
      }
      tally.add(l, point, bad);
    }
    if (!count) return result(c, "fail", { expected, measured: `no trip from ${A.name} to ${B.name}${tally.suffix()}`, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid() });
    const measured = worst
      ? `${Math.round(worst.d)} m from line ${rl.short_name}'s route (trip ${worst.trip}${where(worst.point, true)})${tally.suffix()}`
      : noShape.length
        ? `${noShape.length} trip(s) without a shape (${listText(noShape)})${tally.suffix()}`
        : `within ${Math.round(maxOk)} m of line ${rl.short_name}'s route (${count} trips)${tally.suffix()}`;
    return result(c, worst || noShape.length ? "fail" : "pass", { expected, measured, lines: [l.id], measured_on: tally.measuredOn(), grid: tally.grid(), ...(useBefore ? { baseline: "before" } : {}) });
  },

  accessibility(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const measure = p.measure === "trips" ? "trips" : "stops";
    const minPct = given(p.min_pct) ? num(p.min_pct) : 100;
    if (minPct == null || minPct < 0 || minPct > 100) return result(c, "unknown", { note: "incomplete clause (min_pct between 0 and 100)" });
    const named = listOf(p.stops);
    const lines = linesOfClause(spec, p);
    if (lines.missing) return result(c, "fail", { expected: `line ${lines.missing}`, measured: "no such line" });
    const share = (ok, total) => Math.round((ok / total) * 1000) / 10;
    const what = minPct >= 100 ? "every" : `at least ${minPct} % of the`;
    if (measure === "trips") {
      const keepUnchanged = p.unchanged === true || str(p.unchanged) === "true";
      const dated = datingOf(p).length > 0 || given(dayWordsOf(p));
      if (named.length) return result(c, "unknown", { note: "trips are measured per line: give a line, not stops" });
      if (spec.kind !== "feed" || typeof spec.lineTrips !== "function") return result(c, "unknown", { note: "a designed network does not say which trips are wheelchair accessible" });
      // Dated: the trips running on the dates named (every timetable of the scope); else every trip of the line.
      let scope = null;
      if (dated) {
        scope = scopeOf(c, ctx, { everyDate: true });
        if (scope.error || scope.note) return result(c, "unknown", { note: scope.error || scope.note });
      }
      const scopeWords = scope ? ` (${scope.label || "the dates named"})` : "";
      if (keepUnchanged) {
        // As in the feed before the plan: every trip running on those dates keeps its accessibility, trips matched
        // by what they are (direction, stops, times: a service the plan split renames its trips).
        const expected = `trips of ${lines.label}: wheelchair accessibility as in the feed before the plan${scopeWords}`;
        if (!ctx.baseline || ctx.baseline.self) return result(c, "unknown", { expected, note: NO_BASELINE });
        const base = ctx.baseline.spec;
        const points = scope ? gridOf(scope, ctx, lines.list) : ["mon", "sat", "sun"].map((d) => spec.representativeDate(d)).filter(Boolean).map((date) => ({ date, dates: [date] }));
        const changed = [];
        const changedIds = new Set();
        const comparedIds = new Set();
        let compared = 0;
        for (const l of lines.list) {
          const bl = pairedLine(base, l);
          if (!bl) return result(c, "unknown", { expected, note: `line ${l.short_name} has no counterpart in the feed before the plan`, baseline: "before" });
          const wcAfter = new Map(spec.lineTrips(l.id).map((t) => [t.id, str(t.wheelchair)]));
          const wcBefore = new Map(base.lineTrips(bl.id).map((t) => [t.id, str(t.wheelchair)]));
          const sigOf = (t) => `${t.direction}|${t.stops.join(">")}|${t.dep.join(",")}`;
          const baseId = (t) => String(t.id).split("#")[0];
          for (const pt of points) {
            if (!pt.date) continue;
            const before = new Map(base.tripsOnDate(bl.id, pt.date).map((t) => [sigOf(t), wcBefore.get(baseId(t)) ?? ""]));
            for (const t of spec.tripsOnDate(l.id, pt.date)) {
              const was = before.get(sigOf(t));
              if (was === undefined) continue;
              if (!comparedIds.has(baseId(t))) {
                comparedIds.add(baseId(t));
                compared += 1;
              }
              const now = wcAfter.get(baseId(t)) ?? "";
              if (now !== was && !changedIds.has(baseId(t))) {
                changedIds.add(baseId(t));
                changed.push(`${baseId(t)} on ${iso(pt.date)} (${was || "none"} → ${now || "none"})`);
              }
            }
          }
        }
        if (!compared) return result(c, "unknown", { expected, note: `no trip of ${lines.label} to compare with the feed before${scopeWords}`, baseline: "before" });
        return result(c, changed.length ? "fail" : "pass", { expected, measured: changed.length ? `${changed.length} of ${compared} trips changed: ${listText(changed)}` : `${compared} trips as before`, lines: lines.list.map((l) => l.id), baseline: "before" });
      }
      const expected = `${what} trip of ${lines.label} wheelchair accessible${scopeWords}`;
      let trips = lines.list.flatMap((l) => spec.lineTrips(l.id));
      if (scope) {
        const running = new Set();
        for (const l of lines.list) for (const pt of gridOf(scope, ctx, [l])) for (const t of pt.date ? spec.tripsOnDate(l.id, pt.date) : []) running.add(String(t.id).split("#")[0]);
        trips = trips.filter((t) => running.has(t.id));
      }
      if (!trips.length) return result(c, "unknown", { expected, note: `no trip of ${lines.label} to measure${scopeWords}` });
      const ok = trips.filter((t) => str(t.wheelchair) === "1").length;
      const pct = share(ok, trips.length);
      return result(c, pct + 1e-9 >= minPct ? "pass" : "fail", { expected, measured: `${ok} of ${trips.length} trips accessible (${pct} %)${scopeWords}`, lines: lines.list.map((l) => l.id) });
    }
    const stationsById = new Map((spec.stations || []).map((s) => [s.id, s]));
    let set;
    if (named.length) {
      const seen = new Map();
      for (const name of named) {
        const hits = stopsNamedIn(spec, name);
        if (!hits.length) return result(c, "unknown", { note: `no stop named ${name} in the network` });
        for (const h of hits) seen.set(h.id, h);
      }
      set = [...seen.values()];
    } else {
      const byId = new Map((spec.stops || []).map((s) => [s.id, s]));
      set = [...new Set(lines.list.flatMap((l) => servedStopIds(l, spec)))].map((id) => byId.get(id)).filter(Boolean);
    }
    const expected = `${what} stop ${named.length ? `named ${listText(named)}` : `served by ${lines.label}`} wheelchair accessible`;
    if (!set.length) return result(c, "unknown", { expected, note: "no stop to measure" });
    const bad = set.filter((s) => wheelchairOf(s, stationsById) !== "1");
    const silent = bad.filter((s) => wheelchairOf(s, stationsById) === "").length;
    const pct = share(set.length - bad.length, set.length);
    const names = [...new Set(bad.map((s) => s.name))];
    const measured = `${set.length - bad.length} of ${set.length} stops accessible (${pct} %)${bad.length ? `; not: ${listText(names)}${silent ? ` (${silent} without information)` : ""}` : ""}`;
    return result(c, pct + 1e-9 >= minPct ? "pass" : "fail", { expected, measured, stops: bad.slice(0, 20).map((s) => s.id), lines: named.length ? [] : lines.list.map((l) => l.id) });
  },

  // A line's public identity: its number, long name and colours are the
  // values the clause gives (names exactly as written, colours as six hex
  // digits), and those `unchanged` names are the feed before the plan's.
  // Without a line, `unchanged` holds every line of the feed before (but
  // those `except` names): none is renumbered, renamed or recoloured.
  line_identity(c, ctx) {
    const p = c.params;
    const FIELDS = ["short_name", "long_name", "color", "text_color"];
    const keep = unchangedFields(p.unchanged, FIELDS);
    if (!str(p.line)) return everyIdentity(c, ctx, keep, "line");
    const want = Object.fromEntries(FIELDS.filter((f) => given(p[f])).map((f) => [f, f === "color" || f === "text_color" ? colorOf(p[f]) : plainName(p[f])]));
    if (!Object.keys(want).length && !keep.length) return result(c, "unknown", { note: "incomplete clause (short_name, long_name, color, text_color or unchanged)" });
    const show = (f, v) => (f === "color" || f === "text_color" ? `${f === "color" ? "colour" : "text colour"} #${v || "none"}` : `${f === "short_name" ? "number" : "name"} "${v}"`);
    const expected = `line ${str(p.line)}: ${[...Object.entries(want).map(([f, v]) => show(f, v)), ...keep.filter((f) => !(f in want)).map((f) => `${f.replace("_", " ")} unchanged`)].join(", ")}`;
    if (keep.length && !ctx.baseline) return result(c, "unknown", { expected, note: NO_BASELINE });
    const found = identityLine(ctx, p.line);
    if (!found) return result(c, "fail", { expected, measured: `no line ${str(p.line)}` });
    if (!found.line) return result(c, "fail", { expected, measured: `line ${str(p.line)} is gone (route ${found.before.id} of the feed before)` });
    const l = found.line;
    const value = (line, f) => (f === "color" || f === "text_color" ? colorOf(line[f]) : plainName(line[f]));
    const wrong = Object.entries(want)
      .filter(([f, v]) => value(l, f) !== v)
      .map(([f, v]) => `${show(f, value(l, f))} (expected ${f === "color" || f === "text_color" ? `#${v}` : `"${v}"`})`);
    if (keep.length && !found.before) return result(c, "unknown", { expected, measured: `line ${l.short_name}`, lines: [l.id], note: `line ${l.short_name} has no counterpart in the feed before the plan`, baseline: "before" });
    for (const f of keep) if (!(f in want) && value(l, f) !== value(found.before, f)) wrong.push(`${show(f, value(l, f))} (was ${f === "color" || f === "text_color" ? `#${value(found.before, f) || "none"}` : `"${value(found.before, f)}"`})`);
    const measured = wrong.length ? wrong.join(", ") : `route ${l.id}: ${FIELDS.filter((f) => f in want || keep.includes(f)).map((f) => show(f, value(l, f))).join(", ")}`;
    return result(c, wrong.length ? "fail" : "pass", { expected, measured, lines: [l.id], ...(keep.length ? { baseline: ctx.baseline?.self ? "self" : "before" } : {}) });
  },

  // Every stop of that name or id (a station with its platforms) bears the
  // name and code the clause gives, and keeps those `unchanged` names. A
  // renamed stop is found by its old name in the feed before the plan.
  stop_identity(c, ctx) {
    const p = c.params;
    const ref = str(p.stop?.name ?? p.stop);
    const FIELDS = ["name", "code"];
    const keep = unchangedFields(p.unchanged, FIELDS);
    if (!ref) return everyIdentity(c, ctx, keep, "stop");
    const want = Object.fromEntries(FIELDS.filter((f) => given(p[f])).map((f) => [f, f === "name" ? plainName(p[f]) : str(p[f])]));
    if (!Object.keys(want).length && !keep.length) return result(c, "unknown", { note: "incomplete clause (name, code or unchanged)" });
    const expected = `stop ${ref}: ${[...Object.entries(want).map(([f, v]) => `${f} "${v}"`), ...keep.filter((f) => !(f in want)).map((f) => `${f} unchanged`)].join(", ")}`;
    if (keep.length && !ctx.baseline) return result(c, "unknown", { expected, note: NO_BASELINE });
    const pairs = identityStops(ctx, ref);
    if (!pairs.length) return result(c, "unknown", { expected, note: `no stop named ${ref} in the network` });
    const value = (s, f) => (f === "name" ? plainName(s?.name) : str(s?.code));
    const wrong = [];
    for (const x of pairs) {
      if (!x.after) {
        wrong.push(`${x.id} removed`);
        continue;
      }
      for (const [f, v] of Object.entries(want)) if (value(x.after, f) !== v) wrong.push(`${x.id}: ${f} "${value(x.after, f)}"`);
      for (const f of keep) if (!(f in want) && x.before && value(x.after, f) !== value(x.before, f)) wrong.push(`${x.id}: ${f} "${value(x.after, f)}" (was "${value(x.before, f)}")`);
    }
    const measured = wrong.length ? `${listText(wrong)} — ${pairs.length} stop${pairs.length === 1 ? "" : "s"} named so` : `${pairs.length} stop${pairs.length === 1 ? "" : "s"}: ${[...new Set(pairs.map((x) => `"${value(x.after, "name")}"${x.after.code ? ` (${x.after.code})` : ""}`))].join(", ")}`;
    return result(c, wrong.length ? "fail" : "pass", { expected, measured, stops: pairs.map((x) => x.id).slice(0, 20), ...(keep.length ? { baseline: ctx.baseline?.self ? "self" : "before" } : {}) });
  },

  // The feed's service covers [from, to]: its calendars' validity starts no
  // later than `from` and ends no earlier than `to`, and feed_info, when it
  // gives dates, says so too; `unchanged`: the validity is the one of the
  // feed before the plan (neither extended nor cut).
  feed_validity(c, ctx) {
    const { spec } = ctx;
    const p = c.params;
    const raw = { from: p.from ?? p.from_date, to: p.to ?? p.to_date };
    const want = {};
    for (const k of ["from", "to"]) {
      if (!given(raw[k])) continue;
      want[k] = parseYmd(raw[k]);
      if (!want[k]) return result(c, "unknown", { note: `${k} "${raw[k]}" is not a date (YYYY-MM-DD)` });
    }
    const keep = p.unchanged === true || p.unchanged === "true";
    if (!want.from && !want.to && !keep) return result(c, "unknown", { note: "incomplete clause (from, to or unchanged)" });
    const expected = [want.from || want.to ? `service from ${want.from ? `${iso(want.from)} or earlier` : "…"} to ${want.to ? `${iso(want.to)} or later` : "…"}` : null, keep ? "the validity of the feed before the plan" : null].filter(Boolean).join("; ");
    if (keep && !ctx.baseline) return result(c, "unknown", { expected, note: NO_BASELINE });
    const v = validityOfSpec(spec);
    if (!v || !v.start || !v.end) return result(c, "unknown", { expected, note: "the network has no validity (service start and end dates)" });
    const ymd = (x) => (/^\d{8}$/.test(str(x)) ? str(x) : null);
    const info = spec.kind === "feed" && spec.feedInfo ? { start: ymd(spec.feedInfo.feed_start_date), end: ymd(spec.feedInfo.feed_end_date) } : null;
    const wrong = [];
    if (want.from && v.start > want.from) wrong.push(`the service starts on ${iso(v.start)}`);
    if (want.to && v.end < want.to) wrong.push(`the service ends on ${iso(v.end)}`);
    if (want.from && info?.start && info.start > want.from) wrong.push(`feed_info starts on ${iso(info.start)}`);
    if (want.to && info?.end && info.end < want.to) wrong.push(`feed_info ends on ${iso(info.end)}`);
    if (keep) {
      const bv = ctx.baseline.self ? v : validityOfSpec(ctx.baseline.spec);
      if (!bv) return result(c, "unknown", { expected, note: "the feed before the plan has no validity" });
      if (bv.start !== v.start || bv.end !== v.end) wrong.push(`the validity was ${iso(bv.start)} → ${iso(bv.end)}`);
    }
    const measured = `service ${iso(v.start)} → ${iso(v.end)}${info && (info.start || info.end) ? `, feed_info ${info.start ? iso(info.start) : "…"} → ${info.end ? iso(info.end) : "…"}` : ""}${wrong.length ? `: ${wrong.join("; ")}` : ""}`;
    return result(c, wrong.length ? "fail" : "pass", { expected, measured, ...(keep ? { baseline: ctx.baseline.self ? "self" : "before" } : {}) });
  },

  // The residents of the territory's population grid living within radius_m
  // of a stop the network (or the line) serves, as a share of all of them.
  population_coverage(c, ctx) {
    const { spec, territory } = ctx;
    const p = c.params;
    const minPct = num(p.min_pct);
    if (minPct == null || minPct < 0 || minPct > 100) return result(c, "unknown", { note: "incomplete clause (min_pct between 0 and 100)" });
    const radius = num(p.radius_m) || PLACE_RADIUS_M;
    const lines = linesFor(spec, p);
    if (!lines) return missingLine(c);
    const expected = `at least ${minPct} % of the residents within ${radius} m of a stop${str(p.line) ? ` of line ${str(p.line)}` : ""}`;
    const grid = territory?.population_grid;
    const cells = Array.isArray(grid?.cells) ? grid.cells.filter((x) => x && Number.isFinite(num(x.lat)) && Number.isFinite(num(x.lon)) && num(x.pop) > 0) : [];
    if (!cells.length) return result(c, "unknown", { expected, note: "no population grid for the territory: the residents cannot be counted" });
    const stops = servedStopsOf(spec, lines);
    const dLat = radius / 111320;
    let total = 0;
    let covered = 0;
    for (const cell of cells) {
      const pop = num(cell.pop);
      const lat = num(cell.lat);
      const lon = num(cell.lon);
      total += pop;
      const dLon = dLat / Math.max(0.1, Math.cos((lat * Math.PI) / 180));
      if (stops.some((s) => Math.abs(s.lat - lat) <= dLat && Math.abs(s.lon - lon) <= dLon && haversineMeters(s.lat, s.lon, lat, lon) <= radius)) covered += pop;
    }
    const pct = Math.round((covered / total) * 1000) / 10;
    const note = grid.estimated ? "population estimated from a default density (no known population for the place)" : null;
    return result(c, pct + 1e-9 >= minPct ? "pass" : "fail", { expected, measured: `${pct} % (${Math.round(covered)} of ${Math.round(total)} residents, ${stops.length} stops)`, lines: lines.map((l) => l.id), note });
  },

  // Commercial vehicle-km a year, from the operations estimate (a line: its
  // own figure when the estimate gives one per line).
  service_km_max(c, { spec, operations }) {
    const n = num(c.params.km);
    if (n == null) return result(c, "unknown", { note: "no km" });
    const expected = `≤ ${Math.round(n)} km/year${str(c.params.line) ? ` on line ${str(c.params.line)}` : ""}`;
    if (!operations) return result(c, "unknown", { expected, note: "operations not estimated" });
    let value = operations.veh_km_commercial ?? operations.veh_km_year;
    let lines = [];
    if (str(c.params.line)) {
      const l = findLine(spec, c.params.line);
      if (!l) return missingLine(c);
      value = perLineFigure(operations, l, "veh_km_year");
      lines = [l.id];
      if (value == null) return result(c, "unknown", { expected, lines, note: "the estimate gives no figure per line here" });
    }
    if (!Number.isFinite(value)) return result(c, "unknown", { expected, note: "the estimate gives no vehicle-km" });
    return result(c, value <= n ? "pass" : "fail", { expected, measured: `${Math.round(value)} km/year`, lines });
  },

  vehicle_hours_max(c, { spec, operations }) {
    const n = num(c.params.hours);
    if (n == null) return result(c, "unknown", { note: "no hours" });
    const expected = `≤ ${Math.round(n)} vehicle-hours/year${str(c.params.line) ? ` on line ${str(c.params.line)}` : ""}`;
    if (!operations) return result(c, "unknown", { expected, note: "operations not estimated" });
    let value = operations.veh_h_year;
    let lines = [];
    if (str(c.params.line)) {
      const l = findLine(spec, c.params.line);
      if (!l) return missingLine(c);
      value = perLineFigure(operations, l, "veh_h_year");
      lines = [l.id];
      if (value == null) return result(c, "unknown", { expected, lines, note: "the estimate gives no figure per line here" });
    }
    if (!Number.isFinite(value)) return result(c, "unknown", { expected, note: "the estimate gives no vehicle-hours" });
    return result(c, value <= n ? "pass" : "fail", { expected, measured: `${Math.round(value)} vehicle-hours/year`, lines });
  },
};

/**
 * The fastest trip between two points on the compiled timetable: walk to a
 * stop (≤ 800 m), ride with transfers (the accessibility engine's CSA), walk
 * from a stop. `arrive_by` searches departures in the hour before; else it
 * leaves at `depart_at` (08:00 by default).
 */
const fastestTrip = (tables, spec, a, b, params, onServices = null) => {
  const access = require("./accessibilityService");
  const { buildConnections, earliestArrivals, walkGraph, stopsNear } = access._internals;
  const stops = new Map();
  for (const s of tables.stops || []) {
    const lat = Number(s.stop_lat);
    const lon = Number(s.stop_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) stops.set(s.stop_id, { id: s.stop_id, name: s.stop_name, lat, lon });
  }
  const day = daysOf(params.day || "weekday", spec)[0] || "mon";
  const col = { mon: "monday", tue: "tuesday", wed: "wednesday", thu: "thursday", fri: "friday", sat: "saturday", sun: "sunday" }[day];
  // The services of a measured date when given; else those of the day type.
  const serviceIds = onServices || (typeof spec.serviceIdsOn === "function" ? spec.serviceIdsOn(day) : new Set((tables.calendar || []).filter((c) => c[col] === "1").map((c) => c.service_id)));
  const conns = buildConnections(tables, serviceIds);
  const walk = walkGraph(stops);
  const starts = stopsNear(stops, a.lat, a.lon);
  const ends = stopsNear(stops, b.lat, b.lon);
  if (!starts.length || !ends.length) return null;
  const direct = haversineMeters(a.lat, a.lon, b.lat, b.lon);
  const walkOnly = direct <= 800 ? Math.round(direct / 1.2) : Infinity;
  const arriveBy = params.arrive_by ? timeToSec(params.arrive_by) : null;
  // arrive_by: try departures every 5 min over the allowed time (≥ 1 h) before it.
  const windowS = Math.max(3600, (num(params.max_minutes) || 60) * 60);
  const departs = arriveBy != null ? Array.from({ length: Math.floor(windowS / 300) + 1 }, (_, i) => arriveBy - windowS + i * 300) : [timeToSec(params.depart_at || "08:00") ?? 8 * 3600];
  let best = null;
  for (const t0 of departs) {
    const origins = new Map(starts.map((s) => [s.id, t0 + s.walkS]));
    const arr = earliestArrivals(conns, walk, origins, t0 + 3 * 3600);
    let at = Infinity;
    let endStop = null;
    for (const e of ends) {
      const t = (arr.get(e.id) ?? Infinity) + e.walkS;
      if (t < at) {
        at = t;
        endStop = e.id;
      }
    }
    at = Math.min(at, t0 + walkOnly);
    if (!Number.isFinite(at)) continue;
    if (arriveBy != null && at > arriveBy) continue;
    // For arrive_by, the latest departure that still makes it is the trip
    // (departures are tried in order, so a later one replaces an earlier one).
    const minutes = Math.round((at - t0) / 60);
    if (!best || (arriveBy != null ? t0 >= best.depart : minutes < best.minutes)) best = { minutes, depart: t0, stops: endStop ? [endStop] : [] };
  }
  return best;
};

// ── Lints: what the model is told about its clauses, never a block ─────────

const DATING = ["dates", "from_date", "to_date", "period"];
const datingOf = (params) => DATING.filter((k) => given(params?.[k]));
const datingText = (params) =>
  [given(params.from_date) ? `from ${iso(parseYmd(params.from_date) || params.from_date)}` : null, given(params.to_date) ? `to ${iso(parseYmd(params.to_date) || params.to_date)}` : null, given(params.dates) ? "on listed dates" : null, given(params.period) ? str(params.period) : null].filter(Boolean).join(", ");

// What each trip-level kind needs to be measured (else it is unknown).
const MISSING = {
  running_time: (p) => [!str(p.line) && "line", !given(p.from_stop) && "from_stop", !given(p.to_stop) && "to_stop", num(p.minutes) == null && num(p.min_minutes) == null && num(p.max_minutes) == null && !given(p.like_day) && "minutes (or min_minutes / max_minutes, or like_day)"].filter(Boolean),
  shape_follows: (p) => [!str(p.line) && "line", !given(p.from_stop) && "from_stop", !given(p.to_stop) && "to_stop", !str(p.like_line) && "like_line"].filter(Boolean),
  trips_count: (p) => [!str(p.line) && "line", num(p.min) == null && num(p.max) == null && num(p.exactly) == null && "min, max or exactly"].filter(Boolean),
  departure_at: (p) => [!str(p.line) && "line", !given(p.stop) && "stop", !timesOf(p.times).length && "times"].filter(Boolean),
  stop_pattern: (p) => [!str(p.line) && "line", listOf(p.stops).length < 2 && !listOf(p.avoid).length && "stops (at least two) or avoid"].filter(Boolean),
  same_as: (p) => [!given(p.like_date) && !given(p.like_week) && "like_date or like_week", !given(dayWordsOf(p)) && !datingOf(p).length && "a day, dates or period"].filter(Boolean),
  transfer_max_wait: (p) => [!given(p.stop) && "stop", !str(p.from_line) && !given(p.from_times) && "from_line or from_times (the arrivals: an external timetable's times when the brief lists them)", !str(p.to_line) && !given(p.to_times) && "to_line or to_times", num(p.max_wait) == null && "max_wait"].filter(Boolean),
  line_identity: (p) => [!str(p.line) && !given(p.unchanged) && "line (or unchanged, for every line)", !["short_name", "long_name", "color", "text_color"].some((k) => given(p[k])) && !given(p.unchanged) && "short_name, long_name, color, text_color or unchanged"].filter(Boolean),
  stop_identity: (p) => [!given(p.stop) && !given(p.unchanged) && "stop (or unchanged, for every stop)", !given(p.name) && !given(p.code) && !given(p.unchanged) && "name, code or unchanged"].filter(Boolean),
  feed_validity: (p) => [!given(p.from) && !given(p.to) && !given(p.from_date) && !given(p.to_date) && !given(p.unchanged) && "from, to or unchanged"].filter(Boolean),
  population_coverage: (p) => [num(p.min_pct) == null && "min_pct"].filter(Boolean),
  service_km_max: (p) => [num(p.km) == null && "km"].filter(Boolean),
  vehicle_hours_max: (p) => [num(p.hours) == null && "hours"].filter(Boolean),
};
// The kinds whose `unchanged` compares with the feed before the plan (none on a new network).
const UNCHANGED_KINDS = ["line_identity", "stop_identity", "feed_validity", "accessibility"];

/**
 * Non-blocking lints on a plan's clauses, for the model's tool result:
 * incomplete params per kind; a clause an operation relies on (its
 * `clauses`) that has no dates while the operation applies on some dates —
 * it is then measured on every date of the validity from today; a clause
 * measured in another period than every operation it relies on; and, on a
 * designed network (`network`), unchanged_except, which needs a feed
 * before the plan. They never change a clause.
 */
const clauseLints = (clauses, operations = [], { network = false } = {}) => {
  const out = [];
  for (const raw of clauses || []) {
    const c = normalizeClause(raw);
    if (!c) continue;
    const p = c.params || {};
    const missing = MISSING[c.kind] ? MISSING[c.kind](p) : [];
    if (missing.length) out.push(`${c.kind} ${c.id} needs ${missing.join(" and ")}: it is not measurable without`);
    if (network && c.kind === "unchanged_except") out.push(`unchanged_except ${c.id} is not measurable on a new network (no feed before the plan to compare with): write what must hold instead`);
    if (network && UNCHANGED_KINDS.includes(c.kind) && given(p.unchanged) && p.unchanged !== false) out.push(`${c.kind} ${c.id} says unchanged, which a new network cannot be measured on (no feed before the plan): give the values instead`);
    const ops = (operations || []).filter((o) => Array.isArray(o?.clauses) && o.clauses.includes(c.id));
    const dated = ops.filter((o) => datingOf(o.params).length);
    if (TIME_KINDS.includes(c.kind) && c.kind !== "unchanged_except" && !datingOf(p).length && dated.length) {
      const o = dated[0];
      out.push(`${c.id} has no dates while ${o.id || o.type} applies ${datingText(o.params)}: the clause is measured on every date of its days in the validity from today — give it the operation's from_date/to_date, dates or period when the promise is about the change`);
    }
    if (given(p.period) && ops.length && ops.every((o) => given(o.params?.period) && canonicalPeriod(str(o.params.period)) !== canonicalPeriod(str(p.period)))) {
      out.push(`${c.id} is measured in ${str(p.period)} while ${ops.map((o) => o.id || o.type).join(", ")} change${ops.length === 1 ? "s" : ""} ${ops.map((o) => str(o.params.period)).join(", ")}`);
    }
  }
  return out;
};

// ── Verdict ───────────────────────────────────────────────────────────────

/**
 * @param {object} spec normalised spec (or a feed's view: transform/feedView)
 * @param {object} requirements the recorded brief (clauses and/or lines_requested)
 * @param {{ tables?: object, operations?: object, territory?: object, referenceStops?: object[], stopsAuthority?: "plan" | "feed", periods?: object, today?: string, baseline?: { spec, model?, self? } }} ctx
 *   stopsAuthority: "feed" when the spec's stops are a real feed's (ground truth for places);
 *   "plan" (default) when they are a design's own (candidates only).
 *   periods: { [clause id]: { dates: Set<YYYYMMDD>, label } | { error } } — the named
 *   periods of the clauses, resolved by the caller (transform/feedView.resolveClausePeriods).
 *   today: an undated clause is measured from that date (inside the validity) to its end.
 *   baseline: { spec, model?, self? } — the feed before the plan (feedView.checkFeedConformance
 *   builds it), which same_as and unchanged_except compare with; `self` when it is the measured feed.
 */
const checkConformance = (spec, requirements, { tables = null, operations = null, territory = null, referenceStops = null, stopsAuthority = "plan", periods = null, today = null, baseline = null } = {}) => {
  const clauses = clausesOf(requirements);
  if (!clauses.length || !spec) return null;
  // School calendars are measured on the dates they run: resolved from the territory's dossier when the spec does not carry them yet.
  if (territory && (spec.calendars || []).some((c) => c && c.period && !c.resolved)) {
    try {
      const resolved = require("./schoolCalendar").resolveCalendarsSync(spec, { territory });
      if (resolved?.spec) spec = resolved.spec;
    } catch {
      /* measured as it is: dated clauses on those calendars stay unknown */
    }
  }
  const ctx = { spec, tables, operations, territory, referenceStops, stopsAuthority: stopsAuthority === "feed" ? "feed" : "plan", periods, today: today ? parseYmd(today) : null, baseline: baseline && baseline.spec ? baseline : null };
  const results = clauses.map((c) => {
    if (c.status === "waived") return result(c, "waived", { note: c.reason || null, unsupported: !CHECKS[c.kind] });
    if (!CHECKS[c.kind]) return result(c, "unknown", { note: `unsupported clause kind: ${c.kind}`, unsupported: true });
    try {
      return CHECKS[c.kind](c, ctx);
    } catch (err) {
      return result(c, "unknown", { note: `could not be checked: ${err.message}` });
    }
  });
  const summary = summaryOf(results);
  return { results, summary, conforms: summary.must.fail === 0, checkedAt: new Date().toISOString() };
};

/** What a list of results adds up to: per level, how many are met, fail or cannot be measured; the waived; the unsupported. */
const summaryOf = (results) => {
  const count = (level, status) => results.filter((r) => r.level === level && r.status === status).length;
  return {
    must: { total: results.filter((r) => r.level === "must" && r.status !== "waived").length, pass: count("must", "pass"), fail: count("must", "fail"), unknown: count("must", "unknown") },
    should: { total: results.filter((r) => r.level === "should" && r.status !== "waived").length, pass: count("should", "pass"), fail: count("should", "fail"), unknown: count("should", "unknown") },
    waived: results.filter((r) => r.status === "waived").length,
    // Clauses of a kind this checker does not know (counted as unknown too).
    unsupported: results.filter((r) => r.unsupported && r.status !== "waived").length,
  };
};

/**
 * A measure with results the checker did not produce itself (the « inchangé » clauses the change engine settles:
 * not derivable — unknown, with the reason — or met by the plan's own nature): its summary and `conforms` are
 * counted again from every result. Without a measure (no other clause could be checked) those results are the
 * measure: a must clause nobody could measure is never left out of what a named person accepts.
 */
const withResults = (conformance, extra) => {
  const more = (extra || []).filter(Boolean);
  if (!more.length) return conformance;
  const results = [...(conformance?.results || []), ...more];
  const summary = summaryOf(results);
  return { ...(conformance || {}), results, summary, conforms: summary.must.fail === 0, checkedAt: conformance?.checkedAt || new Date().toISOString() };
};

/** One block of text for the planner. */
const summarizeConformance = (c) => {
  if (!c) return "Brief conformance: no checkable clause recorded (add clauses to set_requirements).";
  const s = c.summary;
  const out = [`Brief conformance: ${s.must.pass}/${s.must.total} must clause(s) met${s.must.fail ? `, ${s.must.fail} FAILING` : ""}${s.must.unknown ? `, ${s.must.unknown} not measurable` : ""}; should ${s.should.pass}/${s.should.total}${s.waived ? `; ${s.waived} waived by the user` : ""}${s.unsupported ? `; ${s.unsupported} of a kind that cannot be checked (rewrite with a supported kind)` : ""}.`];
  for (const r of c.results.filter((x) => x.status === "fail")) out.push(`- FAIL [${r.level}] ${r.id} (${r.kind}): expected ${r.expected}; measured ${r.measured}.`);
  for (const r of c.results.filter((x) => x.status === "unknown").slice(0, 8)) out.push(`- UNKNOWN ${r.id} (${r.kind})${r.note ? `: ${r.note}` : ""}.`);
  if (s.must.fail || s.must.unknown) out.push("Fix every failing or not-measurable MUST clause; the plan is not deliverable while one fails or cannot be measured unless a named person acknowledges it. Never claim it is met.");
  return out.join("\n");
};

// Generic norms the brief overrides: a clause on days or span of a line lifts
// the matching generic finding (the brief is the law, the norm is a default).
const LIFTS = { span: ["short_span"], days: ["no_saturday"], no_service: ["no_saturday"], headway_max: ["peak_headway", "peak_headway_pop"], population_coverage: ["coverage_population"], feed_validity: ["short_validity"] };

/**
 * Drop from the quality report the generic findings a brief clause
 * contradicts; they are listed in `report.lifted_by_brief` instead.
 */
const liftGenericFindings = (report, requirements, spec) => {
  if (!report || !Array.isArray(report.dimensions)) return report;
  // A clause on some dates only (a temporary change) says nothing of the network's usual service.
  const clauses = clausesOf(requirements).filter((c) => LIFTS[c.kind] && !["dates", "from_date", "to_date", "period"].some((k) => given(c.params[k])));
  if (!clauses.length) return report;
  const lifted = [];
  const covers = (c, lineId) => !str(c.params.line) || findLine(spec, c.params.line)?.id === lineId;
  const dims = report.dimensions.map((d) => ({
    ...d,
    findings: (d.findings || []).filter((f) => {
      const by = clauses.find((c) => LIFTS[c.kind].includes(f.code) && covers(c, f.line));
      if (by) lifted.push({ code: f.code, line: f.line || null, level: f.level, clause: by.id, message: f.message });
      return !by;
    }),
  }));
  if (!lifted.length) return report;
  const majors = Math.max(0, (report.majors || 0) - lifted.filter((x) => x.level === "major").length);
  return { ...report, dimensions: dims, majors, lifted_by_brief: lifted };
};

module.exports = { checkConformance, withResults, clausesOf, mergeClauses, normalizeClause, unmetMust, summarizeConformance, liftGenericFindings, KINDS, NETWORK_KINDS, TIME_KINDS, STRUCTURAL_KINDS, KIND_DOCS, kindsText, clauseLints, WEEKDAY_RULE, LEVELS, STATUSES, MAX_CLAUSES, MAX_OD_TIMETABLES, PLAN_STOP_NOTE, _internals: { locate, daysOf, findLine, pairedLine, linePairs, directionIn, nameMatches, departuresByDirection, fastestTrip, windowOf, scopeOf, gridOf, structuralPoints, gapOf, designCalendar, holidayDayOf, clockOf, weekDay, stopsNamedIn, identityStops, identityLine, wheelchairOf, hausdorffM, shapeSectionBetween, likeDayRunningTimes, refDatesOf } };
