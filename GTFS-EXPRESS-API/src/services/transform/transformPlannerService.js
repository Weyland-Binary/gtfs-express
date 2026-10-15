/**
 * transformPlannerService — a brief (service-change notice, cahier des
 * charges, a few sentences) → a CHANGE PLAN on the loaded feed, grounded by
 * tools and checked by the engine.
 *
 *   POST /gtfs/transform/plan   (SSE, gated like the chat; session required)
 *   { brief, plan?, messages?, language?, documents? }
 *
 * The model never writes GTFS rows. It reads the feed (lookup,
 * route_timetable), writes typed operations from the catalogue (set_plan,
 * patch_plan) — each citing the words of the brief it comes from — and
 * the engine previews them on a sandbox: steps applied or BLOCKED with the
 * questions the engine cannot answer from the feed, the semantic diff,
 * integrity, and the clauses the brief makes measurable. What the brief
 * does not say is either an explicit, recorded assumption or a question to
 * the user (ask_user) — never a silent guess.
 *
 * The brief's REQUIREMENTS are protected (G4): the model's set_plan /
 * patch_plan MERGE clauses by id into those recorded (conformanceService.
 * mergeClauses { by: "model" }) — it may add or refine a clause, never drop
 * one, never set it waived or confirmed, never lower a must to should; a
 * clause the user decided is returned whole, and a proposal whose clauses the
 * record cannot hold (conformanceService.MAX_CLAUSES) is refused with their
 * ids, never cut. Assumptions are recorded as { text, operation, confidence }:
 * nothing the model says validates them. Nothing a tool receives is cut in
 * silence: set_plan hands the engine every operation (the engine fails each
 * step past its own bound, with why), and the model reads the plan without
 * the name of the person who assumed the contract (planForModel).
 *
 * CONTRACT FIRST: with a brief, the first turn is phase
 * "extract" only (contract/extractTurn: the objectives extractor, no plan),
 * and nothing is planned until the project's contract is decided, assumed or
 * recorded empty (`contract`, contractService.isReady). The contract then
 * travels with every turn: its clauses are merged into the plan's
 * requirements as the person's record (contractService.mergeInto — a clause a
 * person decided is returned whole by every later merge), its block is read by
 * the model above the conversation, an assumed contract adds the one
 * assumption a named person accepts at delivery, and the verdict carries the
 * coverage of the brief's requirement sentences by it (G5, contract/coverage).
 *
 * CORRECTIONS OF THE CONTRACT ARE THE PERSON'S: no tool of the model touches
 * the objectives, and none proposes a correction of them either — a clause the
 * model finds wrong is said in its answer, and the person settles it at ① under
 * their name; the engine measures the clauses as they stand. A sentence of the
 * answer claiming the contract was changed is struck (contractClaims, read
 * against the record).
 *
 * The VERDICT is the engine's, not the model's (G3): before `done`, the turn
 * emits `verdict` { verdict: verdict.verdictOf(conformance after), gate, prose:
 * verdict.contradictionsOf(the model's text) } so the UI shows it instead of
 * the prose and strikes a sentence that contradicts it.
 *
 * Events: meta, token, tool_pending, plan, preview, questions, correction,
 * usage, error, verdict, done { reason, ready, blocked, previewId, asked,
 * planChanged, gate, failingClauses, unknownClauses, pendingAssumptions,
 * verdict, corrections }.
 *
 * SELF-CORRECTION (llm/selfCorrection): when the model ends a turn in
 * which it changed the plan (or had a set_plan / patch_plan refused), the
 * engine's refusals on the last preview — failed steps, blocked steps with
 * their questions, what blocks the commit (integrity, the validator's new
 * errors), the must clauses failing or not measurable, the refused proposal —
 * go back to the model as a user message (`correction` { attempt, max,
 * phase: "retry", reasons }), at most PLANNER_CORRECTION_ATTEMPTS times. A
 * clean plan is then previewed once more WITH the canonical validator (as the
 * studio's own preview does), emitted as `preview`, so `done.gate.validation`
 * says passed or new_errors instead of not_run. What remains after the last
 * attempt is the person's: `correction` { phase: "escalated" } and the
 * server's `questions` (the engine's own for a blocked step). Not refusals:
 * quotes the server cannot read (a PDF), assumptions awaiting a named person,
 * uncovered requirement sentences, a server without the validator.
 */

"use strict";

const crypto = require("crypto");
const config = require("../../config");
const { withRollingCache } = require("../promptCache");
const aiCostLimiter = require("../aiCostLimiter");
const nl2sqlChatService = require("../nl2sqlChatService");
const eventLogger = require("../eventLogger");
const briefDocuments = require("../network/briefDocumentService");
const conformance = require("../network/conformanceService");
const { verdictOf, contradictionsOf } = require("../verdict");
const registry = require("./operators");
const engine = require("./engine");
const autoAnswers = require("./autoAnswers");
const autoAnswerPolicy = require("./autoAnswerPolicy");
const { feedQueryTool } = require("../llm/feedQueryTool");
const { verifyOperations, _internals: quoteInternals } = require("./quotes");
const R = require("./resolve");
const S = require("./scope");
const { buildFeedModel, routeStats, departures, _internals: fm } = require("./feedModel");
const { tr } = require("./i18n");
const references = require("./referenceFeeds");
const contractService = require("../contract/contractService");
const personalData = require("../llm/personalData");
const { refusal } = require("../refusal");
const { coverageForContract } = require("../contract/coverage");
const { runExtractTurn } = require("../contract/extractTurn");
const premisesService = require("../contract/premises");
const validatorGate = require("../validatorGate");
const correction = require("../llm/selfCorrection");
const { fieldIndexText } = require("./fieldWays");
const sqlConsole = require("../edit/sqlConsoleService");
const sqlSandbox = require("../edit/sqlSandbox");

// The query tool's bounds: the statement, the rows read, the text the model gets back, the time it may run.
// The tables that name people (the journal's actors, the acknowledgements): never read by the model, whatever the
// query's form — quoted, aliased, in a sub-query (chatAgentTools.run_sql reads them the same way).
const sheetGrid = require("./sheetGrid");
const { withContractClaims } = require("./contractClaims");
const { readWorkbook } = require("../spreadsheet/workbook");

const MAX_ROUNDS = 16;
const MAX_CONSECUTIVE_ERRORS = 4;
const MAX_TOKENS = 32000;
const MAX_BRIEF_CHARS = 60000;
const MAX_HISTORY = 20;
const MAX_OVERVIEW_ROUTES = 150;
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", zh: "Chinese", hi: "Hindi" };

// Injectable for tests.
const deps = { createRouter: () => require("../network/roadRouter").createRouter() };

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);
// The bounded parts of the model's context say what they cut (llm/clipText), never a bare « … ».
const { clipSaid } = require("../llm/clipText");
const hhmm = (s) => (s == null ? null : fm.secToTime(s).slice(0, 5));

// ── The catalogue, as the model reads it ────────────────────────────────────

const catalogueText = () =>
  registry
    .catalogue()
    .map((o) => {
      const params = (o.params || []).map((p) => `${p.name}${p.required ? "*" : ""}:${p.type}${p.enum ? `(${p.enum.join("|")})` : ""}`).join(", ");
      const oneOf = registry.oneOfText(o).map((g) => ` (one of ${g})`).join("");
      return `- ${o.type} [${o.category}] ${o.title}. ${o.description || ""}\n  params: ${params}${oneOf}\n  e.g. ${JSON.stringify(o.example || {})}`;
    })
    .join("\n");

/**
 * How real briefs map onto the catalogue (from service-change notices of
 * French and foreign networks, and the golden Albi cases): a brief, the
 * operations that implement it (placeholders in <>), and a note. A recipe
 * is shown only when every operator it uses is in the catalogue; a test
 * checks every parameter it names exists.
 */
const RECIPES = [
  { brief: "Un bus toutes les 10 min de 7h à 9h en période scolaire à partir du 2 novembre (contre 15 aujourd'hui)", steps: [{ type: "set_headway", params: { route: "<line>", days: "weekday", from: "07:00", to: "09:00", headway_min: 10, from_date: "2026-11-02", period: "school_days", region: "<zone>" } }], note: "Add a headway_max clause; the stated old value (15) is checked by an assert first when the catalogue has one." },
  { brief: "Les lignes X et Y circulent désormais le dimanche, de 9h à 19h, un départ par heure sur leur itinéraire principal", steps: [{ type: "copy_day_service", params: { routes: ["X", "Y"], from_day: "saturday", to_days: "sunday", from_date: "<date>" } }, { type: "set_headway", params: { route: "X", days: "sunday", from_date: "<date>", from: "09:00", to: "19:00", start: "09:00", headway_min: 60, patterns: "main_only" } }, { type: "set_span", params: { route: "X", days: "sunday", from_date: "<date>", first: "09:00", last: "18:00" } }], note: "set_headway and set_span for each line." },
  { brief: "Les jours fériés, ces lignes circulent comme le dimanche, sauf le 1er mai", steps: [{ type: "apply_holiday_rules", params: { routes: ["X", "Y"], rule: "sunday", period: "public_holidays", except: ["2027-05-01"] } }] },
  { brief: "Pendant les vacances scolaires, la ligne E circule en semaine selon ses horaires du samedi", steps: [{ type: "run_like", params: { routes: ["E"], like: "saturday", days: "weekday", period: "school_holidays", region: "<zone>" } }] },
  { brief: "Dernier départ à 21h30, un bus toutes les 30 min en soirée, du lundi au samedi", steps: [{ type: "set_span", params: { route: "<line>", days: ["mon", "tue", "wed", "thu", "fri", "sat"], last: "21:30", headway_min: 30 } }], note: "\"Premier départ à 6h30\" is first." },
  { brief: "Les courses limitées à A sont prolongées jusqu'à B ; horaires conservés aux arrêts desservis", steps: [{ type: "extend_route", params: { route: "<line>", beyond: "A", stops: ["<new stop 1>", "<…>", "B"], from_date: "<date>" } }] },
  { brief: "La desserte de X est supprimée : les courses sont limitées à Y", steps: [{ type: "truncate_route", params: { route: "<line>", at: "Y", drop: "X", from_date: "<date>" } }], note: "Only the patterns going beyond Y change." },
  { brief: "Travaux du … au … : arrêts A et B non desservis, arrêt provisoire C (lat, lon), temps de parcours inchangés", steps: [{ type: "reroute", params: { route: "<line>", from_stop: "<stop before A>", to_stop: "<stop after B>", via: [{ name: "C", lat: 0, lon: 0 }], from_date: "<date>", to_date: "<date>", mode: "absorb" } }], note: "One per line; where the two directions use different streets, one per direction (direction set, stops in that direction's order)." },
  { brief: "L'arrêt X n'est plus desservi par la ligne L ; nouvel arrêt Z (lat, lon) entre A et B", steps: [{ type: "remove_stop", params: { route: "L", stop: "X" } }, { type: "add_stop", params: { route: "L", stop: { name: "Z", lat: 0, lon: 0 }, after: "A", before: "B" } }], note: "A name standing for both sides of the street is fine: the engine takes each direction's side." },
  { brief: "En période scolaire, le collège X n'est desservi que par les départs de 11h45 et 12h25 de A vers B, entre C et D", steps: [{ type: "add_stop", params: { route: "<line>", stop: "X", after: "C", before: "D", direction: "B", days: "weekday", period: "school_days", times: ["11:45", "12:25"], at_stop: "A" } }], note: "Only the selected trips call at X; the others keep their route. When the brief gives the times at X, compare them with the step's and say where they differ. Trips that do not exist yet are added first (add_trips), then selected here. Trips the brief times by their ARRIVAL (\"arrivée à 8h05\") keep it: keep_arrival: true." },
  { brief: "La course de 7h40 au départ de A doit arriver à B à 7h50 (au lieu de 7h56)", steps: [{ type: "shift_trips", params: { route: "<line>", direction: "B", times: ["07:40"], at_stop: "A", target: { stop: "B", time: "07:50", event: "arrive", was: "07:56" } } }] },
  { brief: "Suppression de la course de 13h45 au départ de A ; ajout d'un départ à 7h37 de A vers B", steps: [{ type: "remove_trips", params: { route: "<line>", times: ["13:45"], at_stop: "A" } }, { type: "add_trips", params: { route: "<line>", direction: "B", days: "weekday", times: ["07:37"], at_stop: "A" } }], note: "Running times come from the nearest trip." },
  { brief: "La ligne R devient la ligne 5, en gris, texte blanc", steps: [{ type: "set_route_attributes", params: { changes: [{ route: "R", short_name: "5", color: "6E6E6E", text_color: "FFFFFF" }] } }], note: "With a date, whole_feed: true (GTFS cannot date a line's identity)." },
  { brief: "La ligne J est supprimée à compter du 4 janvier", steps: [{ type: "discontinue_route", params: { route: "J", from_date: "2027-01-04" } }] },
  { brief: "Prolonger les horaires jusqu'au 31 août", steps: [{ type: "extend_validity", params: { end_date: "2027-08-31", holidays: "public_holidays", holiday_rule: "sunday" } }] },
  { brief: "Le service est prolongé en soirée du lundi au samedi : dernier départ à 21h30, un bus toutes les 30 minutes après 19h30", steps: [{ type: "set_span", params: { route: "<line>", days: ["mon", "tue", "wed", "thu", "fri", "sat"], from_date: "<date>", last: "21:30", headway_min: 30 } }], note: "An extension keeps what runs: set_span continues the service after the existing last departure (a 19:33 stays, then 20:00…21:30); set_headway over 19:30–21:30 would rebuild the window and move the 19:33." },
  { brief: "Après ces changements, refaire les services voitures", steps: [{ type: "rebuild_blocks", params: {} }], note: "Only when the brief asks for it (or shows block overlaps and cares about vehicles): the blocks are THEORETICAL (no depot, no duties, simplified layovers). When the trips already run in the operator's blocks the step asks keep or replace: relay the question, never answer it yourself." },
  { brief: "Ligne 9, direction Les Tilleuls : les arrêts TAD (transport à la demande) sont prolongés jusqu'à l'arrêt Moulin Neuf, uniquement pendant les vacances scolaires", steps: [{ type: "set_fields", params: { route: "9", direction: "Les Tilleuls", stops: ["<the stops from the end of today's on-demand stretch up to Moulin Neuf, Moulin Neuf included>"], on_demand: true, period: "school_holidays", region: "<zone>" } }], note: "TAD = pickup_type and drop_off_type 2 (riders phone the agency). A stretch said relative to today's service (« prolongés jusqu'à X », « au-delà de X », « à partir de X ») is read on the feed, never from the words alone: lookup route_stops marks the calls on demand today ([on demand]); name in stops the calls between that stretch and X, X included, and say in your answer which stops change and that the rest stays. Never from_stop X alone: it marks every call from X to the terminus (the live test of 2026-10-12). The other dates keep their calls: the engine splits the trips. Never update_rows on stop_times for this." },
  { brief: "Descente seulement à Gare routière sur la ligne 3", steps: [{ type: "set_fields", params: { route: "3", stops: ["Gare routière"], set: { pickup_type: "none" } } }], note: "« montée seulement » is drop_off_type none; both directions unless the brief names one." },
  { brief: "Vélos admis sur la ligne 7 le week-end à compter du 1er mars", steps: [{ type: "set_fields", params: { route: "7", days: "weekend", from_date: "<date>", set: { bikes_allowed: "allowed" } } }], note: "Trips also running on other dates are split; a clause of kind accessibility measures stops and vehicles only." },
  { brief: "Les arrêts desservis par la seule ligne 9 passent en zone tarifaire 2", steps: [{ type: "sql", params: { statements: "UPDATE stops SET zone_id = '2' WHERE stop_id IN (SELECT st.stop_id FROM stop_times st JOIN trips t ON t.trip_id = st.trip_id GROUP BY st.stop_id HAVING COUNT(DISTINCT t.route_id) = 1 AND MAX(t.route_id) = '<route_id of line 9>')", intent: "<what it does, in the person's language>", expect: "<the count query gave>" } }], note: "No operation names stops by what serves them: query first (SELECT COUNT(*) … with the same WHERE), then sql with that WHERE and expect; say in one sentence how you read the brief. A change on some dates only would take a dated operation instead (17)." },
];
const recipesText = () =>
  RECIPES.filter((r) => r.steps.every((st) => registry.get(st.type)))
    .map((r) => `- "${r.brief}" → ${r.steps.map((st) => `${st.type} ${JSON.stringify(st.params)}`).join("; ")}${r.note ? `. ${r.note}` : ""}`)
    .join("\n");

const buildSystemPrompt = () => `You are the service-change planner of GTFS Express: a senior transit scheduler and GTFS expert. A transport authority or operator gives you a brief (a service-change notice, a contract amendment, a cahier des charges, or a few sentences) about THE FEED ALREADY LOADED. You turn it into a CHANGE PLAN: operations the engine applies deterministically on a sandbox, previews and checks — the typed operations of the catalogue below, which are shortcuts, and, when none says what the brief asks, the change written as SQL (the sql operation: the engine checks its rows like any other, 17). Nothing is written to the feed before the person applies the plan.

# Principles
1. The brief is the law. Every operation carries "source": { "quote": the exact words of the brief it implements (≤ 200 chars), "page"?, "document"? }. Do nothing the brief does not ask (no "improvements"). Quotes are checked against the brief, the user's messages and attached text documents: one found nowhere is refused — copy the words verbatim.
2. Never guess. Use the feed's real ids and names (lookup, route_timetable). When the brief does not say something an operation needs (the direction, the days, the stop a time refers to, the date it starts, the school zone, whether all trips or some…):
   - if the answer is conventional and low-impact, decide it and record it in "assumptions" (text, operation id, confidence low|medium|high);
   - otherwise leave the parameter out: the engine blocks the step and asks the user, with the options it knows. Do not invent coordinates, times or dates.
   What the brief DOES say is not a question: stops it lists in an order ("A, B puis C", "then") are served in that order, even when the other direction runs them differently; a time, a day or a count it states is the value. When the feed seems to disagree, follow the brief and say what the feed shows in "assumptions". The recommended default of any question is the brief's own reading, never an alternative that contradicts its words.
   Ask rather than guess what changes the result, and ask little: at most three questions in a turn, the ones whose answer changes what the plan does; everything else is an assumption, said. For example: "line 3 every 10 min" when the feed has 3A and 3B → ask_user which (options 3A, 3B, both; default: both); "from the start of the school year" with no date or zone the feed or the context gives → ask (default: the zone of the feed's agency); "keep the timetable unchanged" and "remove the 13:45 trip" in the same brief → say the two cannot both hold and ask which wins (default: the more specific sentence). A reading the brief's words settle is never a question: do it, and say in ONE sentence of your answer how you read them.
3. Scope: a change on some dates uses the scope parameters (days, from_date, to_date, dates, period, except, region) — "from 1 September" is from_date, "during the works from 20 Jan to 18 Jul" is from_date+to_date, "school days"/"school holidays"/"public holidays" are periods (the plan's "calendars" can define named periods with dates stated in the brief). Other dates keep the old timetable.
4. Measurable promises become clauses in "requirements.clauses", verified after the plan on EVERY distinct timetable of their dates (never a sample): see # Clause kinds. A clause without dates is measured on the whole validity from today, so a clause about a change that applies from a date, on some dates or in a period carries the same dates as its operation (from_date/to_date, dates or period). ${conformance.WEEKDAY_RULE} Stops listed in an order → stop_pattern; a stated time → departure_at (with towards); a running time → running_time; a number of trips → trips_count; a stop served on demand (TAD, sur réservation), drop-off only or pickup only → pickup_dropoff (the stops or the stretch, the direction, the period); « comme en période scolaire / comme en juin » → same_as; « le reste est inchangé », « aucune autre ligne ne change » → unchanged_except. Give each clause the operation ids it relies on in the operation's "clauses". Clauses are merged by id: you may add or refine one (never change its kind: a new promise is a new clause), never remove one; a clause the user decided is fixed — a wrong one is corrected by the person, on your proposal (13).
5. When the brief states the CURRENT value ("from 12 to 14 minutes", "instead of 7:50"), add an "assert" operation before the change when the catalogue has one, so a plan written for another version of the feed fails loudly instead of doing the wrong thing.
6. Order: validity/calendar first, then line structure (create, extend, truncate, reroute, split, merge), then stops, then timetables (headways, spans, trips, running times), then connections, fares, attributes. An assert on a CURRENT value (5) goes just before the step it protects; an assert on the result goes last.
7. After set_plan / patch_plan, read the preview. Fix what is YOUR mistake (a wrong id, a missing parameter the brief does state, a failed step). Leave the genuine questions to the user: call ask_user with them (reuse the engine's options) and stop. Do not loop more than needed. When you end your turn the application checks the plan itself; what it refuses comes back as a message starting with [Engine check — attempt n/N]: it is the engine, not the user — fix what is yours with patch_plan, ask the user what only they can decide.
8. Answer in the user's language, briefly: what the plan does, what you assumed, what you need. Never say whether the brief is met, a count of clauses met, or that the plan is ready: the engine's verdict is shown to the user next to your answer. Write for a transport planner, not a developer: never cite the engine's codes (requirements_uncovered, contract_required, blocked…), the ids of clauses, operations or sentences (c1, op2…), your tools' names, or tables and columns unless the person asks for them; name an objective by its words, an operation by what it does, a line and a stop as the network names them.
9. Data that is not in the feed (another operator's trains, a school's bell times, counts) is never invented. Another operator's timetable loaded as a REFERENCE feed (listed in the context) is read with reference_timetable and aligned on with align_connections { with: { times, name } }, one step per day timetable; say when its validity does not cover the dates. Otherwise ask for it (ask_user: the operator's GTFS, e.g. on transport.data.gouv.fr, or the times themselves) and change nothing that depends on it.
10. A brief that announces changes without detailing them ("several changes", a list, article or leaflet that is not attached, a new network without its timetables) is incomplete: implement what it does detail only when that detail stands on its own (a dated fare change, a stop renamed, a line withdrawn on a date), then ask_user for the missing document (the list, the timetables, the GTFS). When the brief is a redesign or a new network whose details hang on the missing part (the fares of the new network, the dates of timetables not attached, a line of the new plan), change nothing: ask_user for the missing document and stop — an empty plan with the question is the right answer, a partial plan is not. An ask_user about the data an operation needs and that operation in the same plan is the wrong answer: hold the operation until the answer comes. Never report such a brief as done, and never fill the gap from your own reading of the feed. Removing or adding trips, lines or stops is never a low-impact assumption: when the brief does not say it in words, ask.
11. Operations marked "pinned": true in [Current plan] are NOT yours: the application read them from the brief's spreadsheets, cell by cell (their timetable is shown as its size: the engine holds the cells), or the user wrote them. Never rewrite, duplicate or remove one unless the user asks it in words. In set_plan, name a pinned operation where it belongs in the order as { "id", "type", "params": {} } — the application puts the pinned one there, unchanged — or leave it out: it stays, first. What a pinned operation does is done (a line, direction and day type whose timetable it builds): add only what the brief asks beyond them (the validity, the calendars, stops, other lines…). When they already cover the brief, change nothing and say so in one sentence. "Settled by the application" in a preview lists the questions the engine answered by itself, each recorded as an assumption the user validates at delivery: they are not questions any more — do not ask them, do not undo them. A question the engine asks now about an operation — a pinned one too — whose answer the brief or the contract states (« cette grille remplace toutes les courses… » answers « replace or keep the other patterns' trips? ») is yours to answer: patch_plan answers with one of the question's options, the brief's words verbatim and one sentence in the person's language — never ask_user for it. A question the brief does not answer stays the person's.
12. A spreadsheet of the brief is attached with its cells: each row numbered, each column lettered. A timetable grid in it is never retyped: call read_grid with the sheet, the cells of the stop names in the order the trips run, the cells of the times, and which way a trip runs (a column or a row), leaving out with skip a column (or row) that is no trip (« puis toutes les 15 min », remarks). Read what it returns: the stops, the first trips, the trips read past midnight, and the cells kept as written because they are not times — the engine asks the user about each one left in the grid: carry out a remark with the right operation, write a band in timetable.bands beside the ref, or ask the user; never guess them. Then write the build_timetable operation with params.timetable = { "ref": "<the ref read_grid returned>" } and the route, direction and days the sheet states, source.quote a cell of the sheet verbatim (its title or its day type). An operation of yours shown with timetable { "ref" } keeps that ref when you write it again. A pinned operation read from a sheet of this turn names its document and the cells it was read from (sheet_cells): never rebuild it, nor build its grid again.
13. The contract's clauses are the person's record: no tool of yours changes one (set_plan and patch_plan return them whole), so never say a clause or an objective was changed, corrected or reformulated. When one is wrong — read from a grid the wrong way, a stop or a line the network does not have, a direction measured the other way, a count that contradicts another clause — or when the person asks in words to correct one, SAY SO in your answer, with the clause's id and the reason in the person's language: the person corrects it at the objectives step, you never apply, dismiss or work around it, and never ask about it with ask_user. A right clause the plan fails is met by changing the plan, never questioned.
14. An EXTENSION of the service (« prolongé en soirée », « dernier départ à 21h30 », « un bus toutes les 30 minutes après 19h30 », an earlier first departure) keeps every departure the line already runs: the new departures come after the last existing one (or before the first), never beside it. Use set_span with last (or first) and headway_min — it continues the service from the existing last departure on the asked rhythm — or add_trips after that departure; never set_headway over a window that already holds departures (it rebuilds the window and moves or withdraws them), and never a departure within a few minutes of one the line has (add_trips asks what to do: near_existing).
15. « Comme la ligne X », « identique à la ligne X », « aux mêmes horaires que la ligne X »: the change copies that line's own operation of this plan — the same via list stop for stop (both ways), the same times, the same dates — never a shorter list read from the sentence that follows, which names examples. When the two readings differ and the brief does not settle it, ask_user rather than assume.
16. A trip that must ARRIVE (or leave) at another time — « doit arriver au collège à 7h50 (au lieu de 7h56) », « arriver plus tôt », « partir 5 minutes plus tard » — is moved, its running times kept: shift_trips with target { stop, time, event: "arrive" | "depart" } (or minutes), never adjust_running_times, which changes how long the bus takes between stops. adjust_running_times is for a brief that says the running time itself changes (« temps de parcours porté à 14 minutes », a detour removed, an express leg): the engine warns when a running time moves by more than 30 %, and such a warning on a trip the brief only asked to arrive at a time is your mistake to fix.
17. The catalogue is a set of shortcuts, not of permissions: never refuse a brief for lack of an operation, never approximate it with an operation that does something else, never ask the person to work around it. An attribute of a trip or of a call is set_fields with the brief's own words: the line, the direction, the stops or the stretch (from_stop / to_stop), the trips, the days and the period, and the engine finds the rows (# Transit vocabulary below says which field a word means). What no operation of the catalogue says — a condition the brief states on the feed's own data (the stops served by one line only, the calls after a time, a field computed from another), a table the catalogue names by key only — is written as a sql operation: read the feed first with query (the ids and names the brief points at, the rows the WHERE names and their count, a value as the feed writes it), write UPDATE / INSERT / DELETE statements with that WHERE (sub-queries for the line, the direction and the service: a line is its route_id, a direction its direction_id, a service its service_id), give the count in expect and what it does in intent. The engine checks the rows written (formats, references, trips, keys, nothing left dangling), diffs them, measures the clauses and the guarantees on them, and asks about any problem they create: read its questions and fix what is yours. Two limits: SQL cannot date a change — a change on some dates only (a period, from a date, some days) takes the dated operation that splits the trips (set_fields with period / from_date / days, or the typed one), never sql; and never update_rows on stop_times or trips for a change of a line (its \`where\` knows neither the line, the direction nor the dates: 2026-10-12, 103 calls changed outside the line and the period the brief named) — set_fields, or sql with its sub-queries.

# Transit vocabulary → GTFS fields
A brief names a field by its meaning; the field is set with set_fields on the line, direction, stops or stretch, trips and dates the brief states, unless an operation of the catalogue does the whole change.
- TAD, transport à la demande, sur réservation, desserte à la demande, arrêt TAD, dial-a-ride, DRT, demand-responsive → the calls' pickup_type and drop_off_type 2 (riders phone the agency): set_fields { on_demand: true }; « à la demande auprès du conducteur » → 3. A stretch said relative to today's service (« les arrêts TAD sont prolongés jusqu'à X », « au-delà de X », « à partir de X ») is read on the feed: lookup route_stops marks the calls on demand today ([on demand]); name in stops the calls between that stretch and X, X included, and say in your answer which stops change and that the rest stays (never from_stop X alone: that marks every call from X to the terminus). Back to regular calls: on_demand: false.
- descente seulement, montée interdite → pickup_type 1 (none); montée seulement, descente interdite → drop_off_type 1; arrêt rétabli en montée et descente → 0 (regular).
- horaire indicatif, passage approximatif, « horaires donnés à titre indicatif entre A et B » → timepoint 0 (approximate) on that stretch; horaire garanti → 1.
- PMR, UFR, accessible en fauteuil (the vehicles) → wheelchair_accessible; vélos admis / interdits → bikes_allowed (set_accessibility sets stops and vehicles together); girouette, destination affichée → trip_headsign (the trips) or stop_headsign (the calls from a stop).
- the line's number, name, colour → set_route_attributes; a stop's name → rename_stop, its position → relocate_stop, its code, fare zone, platform, station → set_stop_attributes, its accessibility → set_accessibility; fares → update_fares; a transfer rule → set_transfer; any other field of a GTFS table, addressed by the row's key → update_rows (add_rows, delete_rows), addressed by a condition on the feed's data → sql (17).

# GTFS fields → operations
Every column of every GTFS table has one way, and this index is the whole of it: « by name » is the brief's own words (a line, a stop, a stop pair, a fare) that the operation resolves; « the structure » is the operation that rebuilds the thing (the calendar, a line's stops and times, its shape, the vehicle blocks); « by key » is update_rows / add_rows / delete_rows / rename_id with the row's id (the technical fields and the tables a brief never names otherwise). Values are GTFS codes or their words (regular, none, on_demand, driver; accessible; allowed; station, entrance; timed, guaranteed; bus, tram…).
${fieldIndexText()}

# Running times
New times are written at the feed's precision (to the minute unless the feed publishes seconds). Each re-timed step says what its times rest on (observed running times, the line's or the network's speed in the hour band, or a default speed): tell the user and invite them to check the estimated legs. A road leg more than twice the straight distance is flagged: suggest checking its path in the Shape Studio.

# Ridership and optimisation (estimate_ridership, propose_optimization)
When the brief or the user asks how many riders a line or the network carries, or what a change would gain or lose, call estimate_ridership (with the town as \`place\` when you know it). Its figures are ESTIMATES from a demand model: quote them rounded, with their calibration status and uncertainty as returned (e.g. "≈ 18 000 boardings a weekday — estimate, not calibrated, ±70 %: residents are a proxy"), never as counts or facts.
Only when the user asks to optimise frequencies (more riders for the same budget, a cheaper timetable, a fleet or budget cap), call propose_optimization with the matching objective (ridership, balanced or cost) and caps. It returns a candidate plan of set_headway operations, previewed, each with source.generated_by = "optimizer": they are PROPOSALS, not words of the brief — never add a quote to them, and never mix them silently with the brief's operations. Show the changes with their estimated effect (cost, vehicles, riders), adopt the plan with set_plan (operations unchanged) so the user sees it previewed, and say the user validates it: nothing is committed without them.

# Recipes (how real briefs map onto the catalogue)
${recipesText()}

# Change plan (set_plan)
{ "title", "operations": [{ "id": "op1", "type", "params": {…}, "source": { "quote", "page"? }, "clauses"?: [clause ids], "note"? }],
  "requirements"?: { "clauses": [{ "id", "kind": one of ${conformance.KINDS.join("|")}, "level": "must"|"should", "status": "stated"|"assumed", "text", "params": {…} }] },
  "calendars"?: { "<name>": { "from", "to" } | { "dates": [...] } | { "ranges": [{ "from", "to" }] } },
  "costs"?: { "cost_per_km", "cost_per_hour", "currency" },   // when the brief states them: the impact (km, hours, cost, fleet) uses them
  "assumptions"?: [{ "text", "operation"?, "confidence" }] }
The preview also gives the IMPACT: commercial km, service hours and cost over the real running days, vehicles at peak, stops that lose service, and "major service change" flags. When the brief sets a budget or a fleet cap, check it there (and add a fleet_max / budget_max clause).
Dates YYYY-MM-DD, times HH:MM (may exceed 24:00 for after-midnight trips of the same service day).

# Clause kinds (requirements.clauses[].kind and its params)
${conformance.kindsText()}

# Operation catalogue (* = required)
${S.BOUNDS_RULE}
${catalogueText()}
`;

let _prompt = null;
let _promptOps = null;
const systemPrompt = () => {
  const names = registry.names().join(",");
  if (!_prompt || _promptOps !== names) {
    _prompt = buildSystemPrompt();
    _promptOps = names;
  }
  return _prompt;
};

// ── The feed, as the model reads it ─────────────────────────────────────────

const DAY_TYPES = [
  ["weekday", ["tue", "mon", "wed", "thu", "fri"]],
  ["saturday", ["sat"]],
  ["sunday", ["sun"]],
];

const feedOverview = (model) => {
  const lines = [];
  lines.push(`[Loaded feed] ${model.counts.routes} lines, ${model.counts.stops} stops, ${model.counts.trips} trips, ${model.counts.services} services. Validity ${model.range ? `${model.range.start} → ${model.range.end}` : "unknown"}. Representative dates: ${Object.entries(model.representative).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  if (model.feedInfo) lines.push(`[feed_info] ${clip(JSON.stringify(model.feedInfo), 300)}`);
  lines.push("[Lines] id | short | long name | mode | termini | patterns | weekday trips first–last, peak headway | sat | sun");
  const routes = [...model.routes.values()].sort((a, b) => String(a.short_name || a.id).localeCompare(String(b.short_name || b.id), undefined, { numeric: true }));
  for (const r of routes.slice(0, MAX_OVERVIEW_ROUTES)) {
    const main = r.patterns[0];
    const termini = main ? `${model.stops.get(main.stops[0])?.name || "?"} ↔ ${model.stops.get(main.stops[main.stops.length - 1])?.name || "?"}` : "no trips";
    const days = DAY_TYPES.map(([label, dows]) => {
      const date = dows.map((d) => model.representative[d]).find(Boolean);
      if (!date) return `${label} -`;
      const s = routeStats(model, r.id, date);
      if (!s.trips) return `${label} none`;
      const d0 = Object.values(s.directions)[0];
      return label === "weekday" ? `${s.trips} ${d0?.first?.slice(0, 5) || "?"}–${d0?.last?.slice(0, 5) || "?"}, am ${d0?.headways?.am_peak ?? "-"} min` : `${s.trips}`;
    });
    lines.push(`${r.id} | ${r.short_name} | ${clip(r.long_name, 60)} | ${r.mode} | ${termini} | ${r.patterns.length} | ${days.join(" | ")}`);
  }
  if (routes.length > MAX_OVERVIEW_ROUTES) lines.push(`… and ${routes.length - MAX_OVERVIEW_ROUTES} more lines: use lookup.`);
  return lines.join("\n");
};

// ── Tools ───────────────────────────────────────────────────────────────────

const OPERATION_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    params: { type: "object" },
    source: { type: "object", properties: { quote: { type: "string" }, page: { type: "number" }, document: { type: "string" } } },
    clauses: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
  required: ["id", "type", "params"],
};

// What the model may say of a clause: a statement or an assumption of a known
// kind — never a decision (waived, confirmed, who decided): the merge strips those.
const REQUIREMENTS_SCHEMA = {
  type: "object",
  properties: {
    clauses: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          kind: { type: "string", enum: conformance.KINDS, description: "one of the kinds of the prompt" },
          level: { type: "string", enum: conformance.LEVELS },
          status: { type: "string", enum: ["stated", "assumed"] },
          text: { type: "string" },
          params: { type: "object", description: "the kind's params (see the kinds list); dates and period for a change on some dates" },
          source: { type: "string" },
        },
        required: ["id", "kind", "params"],
      },
    },
  },
};

const ASSUMPTIONS_SCHEMA = { type: "array", items: { type: "object", properties: { text: { type: "string" }, operation: { type: "string" }, confidence: { type: "string", enum: ["low", "medium", "high"] } }, required: ["text"] } };

// The clauses a model turn sends, as objects (the merge normalises and protects them, and says what lies past the bound).
const modelClauses = (list) => (Array.isArray(list) ? list.filter((c) => c && typeof c === "object") : []);

// An operation a model turn sends, with only what the model may say about its source: the
// words it cites and where they come from. The check's verdict (verified, verify_reason) is
// written by verifyOperations; an author is the client's record (an operation the user wrote
// is never gated at commit, so the model could otherwise exempt its own words with it).
const MODEL_SOURCE_KEYS = ["quote", "page", "document", "generated_by", "objective"];
const modelOperation = (op) => (op && typeof op === "object" && op.source && typeof op.source === "object" ? { ...op, source: Object.fromEntries(Object.entries(op.source).filter(([k]) => MODEL_SOURCE_KEYS.includes(k))) } : op);

// An assumption as the plan records it: nothing else the model (or a client) writes on it — a `validated` flag in particular — is kept.
// `keepAuto` (a client's plan): the answers the engine took by itself (autoAnswers: `auto`, sanitized) stay marked as
// such — the next `auto` simulation prunes or keeps them; the model never writes one (its tools normalize without it).
// The contract's own (`contract: true`) are the server's to add at every simulation (withContract): never kept twice.
// The engine's answers are kept up to the gate's own bound (engine.pendingAssumptions and acknowledgement.parse list
// and accept 2000): each one stays with the answer written in its operation, so none is dropped behind the person —
// a plan carrying more is refused, said (400), never cut.
const MAX_OWN_ASSUMPTIONS = 40;
const MAX_ENGINE_ASSUMPTIONS = 2000;
const normalizeAssumptions = (list, { keepAuto = false } = {}) => {
  const all = (Array.isArray(list) ? list : [])
    .map((a) => (typeof a === "string" ? { text: a } : a))
    .filter((a) => a && typeof a === "object" && typeof a.text === "string" && a.text.trim() && a.contract !== true);
  const shape = (a, auto) => ({ text: a.text.trim().slice(0, 300), ...(typeof a.operation === "string" ? { operation: a.operation.slice(0, 40) } : {}), ...(["low", "medium", "high"].includes(a.confidence) ? { confidence: a.confidence } : {}), ...(auto ? { auto } : {}) });
  const engineOwn = keepAuto ? all.filter((a) => autoAnswers.sanitize(a.auto)) : [];
  if (engineOwn.length > MAX_ENGINE_ASSUMPTIONS) throw Object.assign(new Error(`The plan carries ${engineOwn.length} answers taken by the engine; a change holds ${MAX_ENGINE_ASSUMPTIONS} at most: apply this change first, then continue in a new one.`), { code: "INVALID_INPUT", status: 400 });
  // The plan's own assumptions (the model's, the person's) past their bound are refused with the count — a tool call
  // reads the refusal and writes fewer; never a line dropped behind the person.
  const own = all.filter((a) => !engineOwn.includes(a));
  if (own.length > MAX_OWN_ASSUMPTIONS) throw Object.assign(new Error(`The plan carries ${own.length} assumptions of its own; a change holds ${MAX_OWN_ASSUMPTIONS} at most: keep the ones that matter and say the rest in the conversation.`), { status: 400, code: "INVALID_INPUT" });
  return [...own.map((a) => shape(a, null)), ...engineOwn.map((a) => shape(a, autoAnswers.sanitize(a.auto)))];
};

/**
 * The engine's questions the model answered from the brief (patch_plan answers): each line kept whatever the model
 * rewrites of the assumptions, while its operation still holds that answer — never an answer written without its line.
 */
const answeredAssumptions = (plan, operations) =>
  (Array.isArray(plan?.assumptions) ? plan.assumptions : []).filter((a) => {
    if (!a || typeof a !== "object" || typeof a.answer !== "string") return false;
    const op = (operations || []).find((o) => o && String(o.id) === String(a.operation));
    return Boolean(op && op.params && op.params[a.answer] != null);
  });

/** The answers the engine took by itself that a plan records (its `auto` assumptions): kept whatever the model rewrites. */
const engineAssumptions = (plan) => (Array.isArray(plan?.assumptions) ? plan.assumptions : []).filter((a) => a && typeof a === "object" && autoAnswers.sanitize(a.auto));

/**
 * The operations of a plan that are not the model's: the person's record (source.author "user" — an offer sheet's
 * timetable read cell by cell, a suggestion retained at ②, an operation written by hand). The model may neither
 * claim that mark (modelOperation strips it) nor rewrite them with set_plan.
 */
const isPinned = (op) => Boolean(op && typeof op === "object" && op.source && op.source.author === "user");
const pinnedOf = (plan) => (Array.isArray(plan?.operations) ? plan.operations : []).filter(isPinned);

/**
 * An assumption as the model reads it. The assumed contract's names who assumed it (`by`, and its sentence): the gate
 * and the acknowledgement form read that name from the server's own items, the model never does (llm/personalData,
 * rule 7) — it reads the same sentence for « a named person », without the `by` field. Every other assumption is
 * read as it is.
 */
const assumptionForModel = (a) => (a && typeof a === "object" && a.kind === "contract_assumed" ? { text: contractService.assumedText(personalData.PERSON_LABEL), contract: true, kind: "contract_assumed" } : a);

/**
 * The plan as the model reads it: a pinned operation is said by its scope and marked — a grid's cells are the
 * engine's to place, never the model's to copy (and a specification's grids would not fit the message) —, and the
 * contract's assumption names nobody (assumptionForModel).
 */
const CLOCK = /^(\d{1,2}):(\d{2})$/;
const minutesOf = (v) => {
  const m = CLOCK.exec(String(v ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
/**
 * A pinned timetable as the model may check it against its sheet, never its times to copy: its stops (the first and
 * the last), its timed trips, its first and last departure, its bands.
 */
const sizedTimetable = (tt) => {
  const stops = Array.isArray(tt.stops) ? tt.stops.map((x) => String(x ?? "").slice(0, 60)) : [];
  const firsts = (Array.isArray(tt.trips) ? tt.trips : []).map((row) => (Array.isArray(row) ? row.map(minutesOf).find((x) => x != null) : null)).filter((x) => x != null);
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const ends = stops.length ? ` (${stops[0]} → ${stops[stops.length - 1]})` : "";
  const span = firsts.length ? `, first departure ${hm(Math.min(...firsts))}, last ${hm(Math.max(...firsts))}` : "";
  return `<timetable kept by the application: ${stops.length} stops${ends} × ${firsts.length} timed trips${span}${Array.isArray(tt.bands) && tt.bands.length ? `, ${tt.bands.length} band(s)` : ""}>`;
};
/**
 * `documents`: the names of the documents the model reads in this turn — a pinned grid names its document and its
 * cells only when it reads that document (never one the person kept from the assistant).
 */
const planForModel = (plan, { documents = null } = {}) => {
  if (!plan || !Array.isArray(plan.operations)) return plan;
  const sized = sizedTimetable;
  const read = new Set(Array.isArray(documents) ? documents : []);
  return {
    ...plan,
    operations: plan.operations.map((o) => {
      const p = o && typeof o === "object" && o.params && typeof o.params === "object" ? o.params : {};
      // The model's own grid read by read_grid: its ref, never its times to copy again.
      if (!isPinned(o)) return typeof o?.source?.grid === "string" && p.timetable && typeof p.timetable === "object" ? { ...o, params: { ...p, timetable: { ref: o.source.grid, ...(Array.isArray(p.timetable.bands) && p.timetable.bands.length ? { bands: p.timetable.bands } : {}) } } } : o;
      // A pinned grid read from a sheet the model reads in this turn names it and the cells it was read from.
      const shown = typeof o.source?.document === "string" && read.has(o.source.document);
      const cells = shown && Array.isArray(o.source?.cells) ? o.source.cells.filter((c) => typeof c === "string").slice(0, 6) : [];
      return { id: o.id, type: o.type, ...(typeof o.label === "string" ? { label: o.label.slice(0, 120) } : {}), params: { ...p, ...(p.timetable && typeof p.timetable === "object" ? { timetable: sized(p.timetable) } : {}) }, pinned: true, ...(shown ? { document: o.source.document.slice(0, 120) } : {}), ...(cells.length ? { sheet_cells: cells } : {}) };
    }),
    ...(Array.isArray(plan.assumptions) ? { assumptions: plan.assumptions.map(assumptionForModel) } : {}),
  };
};

/**
 * The current plan as the model reads it: whole whenever it fits PLAN_CHARS. A
 * larger one (up to 100 operations, timetables written in full) is never cut in
 * the middle of its JSON — the model would not see its last operations and would
 * write them again or patch blind. Past the budget the operations are listed by
 * id, type and label, their parameters kept as they are, and the block says so
 * and how to change them.
 */
const PLAN_CHARS = 30000;
const planBlock = (plan, opts) => {
  const shown = planForModel(plan, opts);
  const whole = JSON.stringify(shown);
  if (whole.length <= PLAN_CHARS || !Array.isArray(shown?.operations)) return clipSaid(whole, PLAN_CHARS);
  const { operations, ...rest } = shown;
  const stubs = operations.map((op) => ({ id: op?.id, type: op?.type, ...(typeof op?.label === "string" ? { label: op.label.slice(0, 120) } : {}), params: "(not shown: kept as they are)" }));
  // Every operation is at least its stub; what remains past the rest of the plan and the stubs shows a prefix of them in full.
  let budget = PLAN_CHARS - JSON.stringify({ ...rest, operations: stubs }).length;
  let full = 0;
  while (full < operations.length) {
    const more = JSON.stringify(operations[full]).length - JSON.stringify(stubs[full]).length;
    if (more > budget) break;
    budget -= more;
    full += 1;
  }
  const out = [...operations.slice(0, full), ...stubs.slice(full)];
  return `${JSON.stringify({ ...rest, operations: out })}\n[The plan is larger than this context: ${full} operation(s) shown in full, the last ${operations.length - full} by id, type and label only — their parameters are kept as they are. Leave them, move or remove them by id with patch_plan, or rewrite one whole with patch_plan (upsert by id); set_plan would replace them with what you write.]`;
};

/**
 * The grids the model may name by their ref (timetable { ref }): the ones read_grid copied in this turn, and the
 * ones the plan already holds (an operation the model wrote from a grid keeps its ref in source.grid, its cells in
 * source.cells) — a ref is never a time the model wrote.
 */
const MAX_GRIDS = 60;
const SHEET_NAME = /\.(xlsx|xlsm|xls|ods|csv)$/i;
/**
 * What a grid's operation says of the cells it copied, beside the ranges it cites (source.cells): `times`, the range
 * of its times, and `left_out`, the cells of its ranges it did NOT copy (sheetGrid's left_out_cells: the times and
 * numbers of the trips skipped) — read by the web to say a point of the brief's sheets covered only where the grid
 * copied it (a grid of another day type sharing the stops' column, a remark in a skipped column, stay the person's).
 * Bounded: past MAX_LEFT_OUT ranges the rest is counted (`left_out_more`), and the web then claims nothing of it.
 * {} for an operation recorded without `times`: what it left out is not known.
 */
const MAX_LEFT_OUT = 120;
const gridCellsOf = (x) => {
  if (!x || typeof x.times !== "string") return {};
  const list = Array.isArray(x.left_out) ? x.left_out.filter((c) => typeof c === "string") : [];
  const more = (Number.isInteger(x.left_out_more) && x.left_out_more > 0 ? x.left_out_more : 0) + Math.max(0, list.length - MAX_LEFT_OUT);
  return { times: x.times, left_out: list.slice(0, MAX_LEFT_OUT), ...(more ? { left_out_more: more } : {}) };
};
const gridsOf = (plan) => {
  const grids = new Map();
  for (const o of Array.isArray(plan?.operations) ? plan.operations : []) {
    const ref = typeof o?.source?.grid === "string" ? o.source.grid : null;
    const tt = o?.params?.timetable;
    if (ref && /^g\d{1,4}$/.test(ref) && tt && typeof tt === "object" && Array.isArray(tt.stops) && !grids.has(ref)) grids.set(ref, { timetable: tt, cells: Array.isArray(o.source.cells) ? o.source.cells : [], document: o.source.document || null, ...gridCellsOf(o.source) });
  }
  return grids;
};
/**
 * The operations with the grid each one names put in place of its ref; an unknown ref is refused, never a grid
 * guessed. `current`: the plan's operations by id — one sent again with the ref it holds keeps its own grid (with
 * what the engine's answers wrote in it), never the first operation's of that ref.
 */
const withGrids = (operations, grids, current = null) => {
  const errors = [];
  const out = operations.map((o) => {
    const tt = o && typeof o === "object" && o.params && typeof o.params === "object" ? o.params.timetable : null;
    const ref = tt && typeof tt === "object" && typeof tt.ref === "string" ? tt.ref : null;
    if (!ref) return o;
    const own = current && o && o.id != null ? current.get(String(o.id)) : null;
    const g = own && own.source?.grid === ref && own.params?.timetable && typeof own.params.timetable === "object" && Array.isArray(own.params.timetable.stops) ? { timetable: own.params.timetable, cells: Array.isArray(own.source.cells) ? own.source.cells : [], document: own.source.document || null, ...gridCellsOf(own.source) } : grids.get(ref);
    if (!g) {
      errors.push(`${o.id}: no grid "${ref}" was read (${grids.size ? [...grids.keys()].join(", ") : "none"}): call read_grid with its cells first`);
      return o;
    }
    // The grid's own trips, stops and numbers; the timetable's bands (the operation's own) beside them. What it cites
    // and copied of the sheet is the grid's, never anything else the source carried — its document too: the cells
    // belong to the workbook read_grid read them from, whatever document the model filed the operation under (the web
    // finds a sheet's points by that document and those cells).
    const { ref: _ref, ...rest } = tt; // eslint-disable-line no-unused-vars
    const { bands: _bands, ...grid } = g.timetable; // eslint-disable-line no-unused-vars
    const { times: _times, left_out: _out, left_out_more: _more, ...source } = o.source || {}; // eslint-disable-line no-unused-vars
    return { ...o, params: { ...o.params, timetable: { ...grid, ...(Array.isArray(rest.bands) ? { bands: rest.bands } : {}) } }, source: { ...source, grid: ref, cells: g.cells, ...gridCellsOf(g), ...(g.document ? { document: g.document } : {}) } };
  });
  return { operations: out, errors };
};

// The requirements a client plan carries, as the engine measures them: every clause through
// normalizeClause (an anonymous waiver or confirmation is demoted to "stated").
// A client plan's clauses past the record's bound are refused with the count (409 TOO_MANY_CLAUSES, the contract's
// own refusal), never cut: a promise the person holds is never left out of the measure in silence.
const normalizeRequirements = (requirements) => {
  if (!requirements || typeof requirements !== "object") return undefined;
  const clauses = (Array.isArray(requirements.clauses) ? requirements.clauses : []).map(conformance.normalizeClause).filter(Boolean);
  if (clauses.length > conformance.MAX_CLAUSES) throw refusal(409, "TOO_MANY_CLAUSES", `The plan holds ${clauses.length} clauses: ${conformance.MAX_CLAUSES} at most are measured.`, { max: conformance.MAX_CLAUSES, count: clauses.length });
  return { ...requirements, clauses };
};

// The model's clauses merged into the recorded ones: never a removal, never a decision.
// `lang`: a clause sent without text gets its line in the user's language; `kindKept` collects the
// ids of recorded must clauses whose kind the turn tried to change (dropped: a new promise is a new clause);
// `leftOut` the ids of the clauses the record cannot hold (conformanceService.MAX_CLAUSES): the proposal is refused
// with them (boundErrors), so a promise the model wrote is never left out of the measure in silence.
const mergeRequirements = (previous, incoming, { lang = null, kindKept = null, leftOut = null } = {}) => ({ clauses: conformance.mergeClauses(previous?.clauses || [], modelClauses(incoming?.clauses), [], { by: "model", lang, kindKept, leftOut }) });
const boundErrors = (leftOut) => (leftOut.length ? [`requirements: the record holds ${conformance.MAX_CLAUSES} clauses at most and ${leftOut.length} of this proposal would exceed it (${leftOut.slice(0, 12).join(", ")}${leftOut.length > 12 ? ", …" : ""}): the recorded clauses already state the promise, or write fewer`] : []);

// A clause of a kind the checker does not know is KEPT (measured "unknown", acknowledgeable at commit) and said;
// the lints (incomplete params, a clause dated unlike the operations it relies on) are said too, never blocking.
const clauseWarnings = (plan) => [
  ...(plan?.requirements?.clauses || []).filter((c) => !conformance.KINDS.includes(c.kind)).map((c) => `${c.id}: unknown clause kind "${c.kind}" (known: ${conformance.KINDS.join(", ")}) — kept, reported as not measurable`),
  ...conformance.clauseLints((plan?.requirements?.clauses || []).filter((c) => conformance.KINDS.includes(c.kind)), plan?.operations || []),
];

// The ids of the recorded clauses the model's turn omitted (or tried to remove): the merge kept them.
const keptClauses = (previous, merged, incoming) => {
  const sent = new Set(modelClauses(incoming?.clauses).map((c) => conformance.normalizeClause(c)?.id).filter(Boolean));
  return (merged?.requirements?.clauses || []).filter((c) => !sent.has(c.id) && (previous?.requirements?.clauses || []).some((p) => p.id === c.id)).map((c) => c.id);
};

// What the tool result says besides the preview: the clauses kept from the record, the kinds the checker does not know.
const notesOf = (plan, kept, kindKept = []) => [...(kept.length ? [`Clauses kept from the record: ${kept.join(", ")} (clauses merge by id; none is removed).`] : []), ...kindKept.map((id) => `${id}: the kind of a must clause is not changed; write a new clause.`), ...(clauseWarnings(plan).length ? [`Clause warnings:\n- ${clauseWarnings(plan).join("\n- ")}`] : [])];

const summarizePreview = (p) => {
  const out = [];
  out.push(`Preview: ${p.steps.filter((s) => s.status === "applied").length} applied, ${p.steps.filter((s) => s.status === "blocked").length} blocked, ${p.steps.filter((s) => s.status === "failed").length} failed, ${p.steps.filter((s) => s.status === "skipped").length} skipped.`);
  for (const s of p.steps) {
    let line = `- ${s.id} ${s.type}: ${s.status}`;
    if (s.summary) line += ` — ${s.summary}`;
    if (s.error) line += ` — ERROR: ${s.error}`;
    // A step after a blocked step of its line: its questions read a feed that step has not changed yet — asked once
    // that step is answered, never answered now.
    if (Array.isArray(s.waiting_for) && s.waiting_for.length) {
      line += ` — waits for ${s.waiting_for.join(", ")}: its questions come once that step is answered (answer none of them now)`;
      out.push(line);
      continue;
    }
    for (const a of s.ambiguities || []) line += `\n    ? ${a.param}: [${a.code}] ${a.message}${a.options ? ` options: ${a.options.slice(0, 8).join(" | ")}` : ""}`;
    for (const w of (s.warnings || []).slice(0, 4)) line += `\n    ! ${clip(w, 200)}`;
    out.push(line);
  }
  const unverified = p.steps.filter((s) => s.quote_verified === false);
  if (unverified.length) out.push(`Quotes not verified against the brief: ${unverified.map((s) => `${s.id} (${s.quote_reason})`).join(", ")}${unverified.some((s) => s.quote_reason === "pdf") ? " — from a PDF the server cannot read: the user sees them marked" : ""}.`);
  if (p.lines?.length) out.push(`Changes:\n${p.lines.slice(0, 40).map((l) => `  ${l}`).join("\n")}${p.lines.length > 40 ? `\n  … ${p.lines.length - 40} more` : ""}`);
  if (p.integrity?.length) out.push(`Integrity problems introduced: ${p.integrity.map((i) => `${i.code} ×${i.count}`).join(", ")}`);
  if (p.checks?.length) out.push(`Consumer checks made worse (Google-style): ${p.checks.map((c) => `${c.code} ${c.before} → ${c.count}${c.examples?.[0] ? ` e.g. ${JSON.stringify(c.examples[0])}` : ""}`).join("; ")}`);
  const im = p.impact;
  if (im && im.totals) out.push(`Impact (${im.window.days} running days): km ${im.totals.km.before} → ${im.totals.km.after} (${im.totals.km.pct ?? 0}%), hours ${im.totals.hours.before} → ${im.totals.hours.after}, cost ${im.totals.cost.before} → ${im.totals.cost.after} ${im.currency}, vehicles at peak ${im.totals.fleet.before} → ${im.totals.fleet.after}${im.stops.lost.length ? `; stops no longer served: ${im.stops.lost.map((s) => s.name).slice(0, 10).join(", ")}` : ""}${im.flags.filter((f) => f.code !== "stop_unserved").length ? `; major-change flags: ${im.flags.filter((f) => f.code !== "stop_unserved").map((f) => `${f.code} ${f.label || ""}`).join(", ")}` : ""}`);
  if (p.passenger?.length) out.push(`Passenger information (GTFS-RT alerts the user can publish): ${p.passenger.slice(0, 8).map((a) => `${a.effect} ${a.routes.map((r) => r.label).join("+")} ${a.period?.from || ""}${a.open_ended ? "→" : `–${a.period?.to || ""}`}`).join("; ")}${p.passenger.length > 8 ? ` … +${p.passenger.length - 8}` : ""}`);
  const res = p.conformance?.after?.results || [];
  if (res.length) out.push(`Clauses after the plan: ${res.map((r) => `${r.id} ${r.status}${r.status === "unknown" ? ` (${r.note || "not measurable"})` : r.status !== "pass" ? ` (expected ${r.expected}, measured ${r.measured})` : ""}`).join("; ")}`);
  if (p.auto?.assumptions?.length) out.push(`Settled by the application (each recorded as an assumption the user validates at delivery — not questions: do not ask them, do not undo them): ${p.auto.assumptions.slice(0, 30).map((a) => clip(String(a.text || ""), 200)).join("; ")}${p.auto.assumptions.length > 30 ? `; … ${p.auto.assumptions.length - 30} more` : ""}`);
  const g = p.gate;
  if (g?.blocking?.length) out.push(`The commit is blocked: ${g.blocking.map((b) => b.code).join(", ")}.`);
  if (g?.acknowledgeable?.length) out.push(`The commit asks a named person to acknowledge: ${g.acknowledgeable.map((a) => a.code).join(", ")}.`);
  return out.join("\n");
};

const createTools = (ctx) => {
  // The grids the model may name (the plan's own, then the ones read_grid copies) and the workbooks parsed once.
  ctx.grids = ctx.grids || gridsOf(ctx.plan);
  ctx.books = ctx.books || new Map();
  // The clause ids the turn's accepted set_plan / patch_plan wrote: its own, and the contract's it tried to rewrite (the
  // merge returned them whole) — what the answer's claims of a changed contract are read against (contractClaims).
  ctx.written = ctx.written || { own: new Set(), contract: new Set() };
  const noteWritten = (requirements) => {
    const ofContract = new Set((ctx.contract?.clauses || []).map((c) => c?.id).filter(Boolean));
    for (const c of modelClauses(requirements?.clauses)) {
      const id = conformance.normalizeClause(c)?.id;
      if (!id) continue;
      (ofContract.has(id) ? ctx.written.contract : ctx.written.own).add(id);
    }
  };
  const lookup = {
    definition: {
      name: "lookup",
      description: "Find lines and stops of the loaded feed by what the brief calls them. routes: names/numbers to resolve (returns id, names, termini, patterns). stops: [{ query, route? }] (returns every matching stop with id, name, parent station, lines serving it). route_stops: a line → its patterns with their stops in order.",
      input_schema: {
        type: "object",
        properties: {
          routes: { type: "array", items: { type: "string" } },
          stops: { type: "array", items: { type: "object", properties: { query: { type: "string" }, route: { type: "string" } }, required: ["query"] } },
          route_stops: { type: "string" },
        },
      },
    },
    run(input) {
      const m = ctx.model;
      const out = [];
      for (const q of (input.routes || []).slice(0, 20)) {
        const r = R.route(m, q);
        if (r.value) {
          const pats = r.value.patterns.slice(0, 4).map((p) => `dir ${p.direction_id}: ${m.stops.get(p.stops[0])?.name} → ${m.stops.get(p.stops[p.stops.length - 1])?.name} (${p.stops.length} stops, ${p.trips.length} trips)`);
          out.push(`route "${q}" → ${r.value.id} (${R.routeLabel(r.value)}, ${r.value.mode}); patterns: ${pats.join("; ")}${r.value.patterns.length > 4 ? `; +${r.value.patterns.length - 4} more` : ""}`);
        } else out.push(`route "${q}" → ${r.ambiguity.code}: ${r.ambiguity.message}${r.ambiguity.options ? ` [${r.ambiguity.options.slice(0, 10).join(" | ")}]` : ""}`);
      }
      const servedBy = (id) => [...new Set([...m.patterns.values()].filter((p) => p.stops.includes(id)).map((p) => m.routes.get(p.route_id)?.short_name || p.route_id))];
      for (const s of (input.stops || []).slice(0, 30)) {
        const q = String(s.query || "");
        const route = s.route ? R.route(m, s.route).value : null;
        const k = q.toLowerCase();
        const hits = [...m.stops.values()].filter((x) => x.id === q || String(x.name).toLowerCase() === k || (k.length >= 3 && String(x.name).toLowerCase().includes(k))).slice(0, 12);
        const ranked = route ? hits.sort((a, b) => Number(servedBy(b.id).includes(route.short_name || route.id)) - Number(servedBy(a.id).includes(route.short_name || route.id))) : hits;
        out.push(`stop "${q}"${route ? ` (line ${route.short_name || route.id})` : ""} → ${ranked.length ? ranked.map((x) => `${x.id} "${x.name}"${x.location_type === "1" ? " [station]" : ""}${x.parent ? ` parent ${x.parent}` : ""} lines ${servedBy(x.id).join(",") || "none"}`).join("; ") : "no match"}`);
      }
      if (input.route_stops) {
        const r = R.route(m, input.route_stops);
        if (r.value) {
          for (const p of r.value.patterns.slice(0, 6)) {
            // How each call is served today (any trip of the pattern): on demand (pickup or drop-off 2/3), no pickup,
            // no drop-off — the marks a brief on TAD stops reads before writing a stretch (set_fields).
            const marks = new Map();
            for (const tid of p.trips.slice(0, 200)) {
              const t = m.trips.get(tid);
              if (!t?.flex) continue;
              for (const [i, pk, dk] of t.flex) {
                const set = marks.get(i) || new Set();
                if (pk === "2" || pk === "3" || dk === "2" || dk === "3") set.add("on demand");
                if (pk === "1") set.add("no pickup");
                if (dk === "1") set.add("no drop-off");
                marks.set(i, set);
              }
            }
            const headsign = m.trips.get(p.trips[0])?.headsign;
            out.push(`${r.value.short_name || r.value.id} dir ${p.direction_id}${headsign ? ` "${headsign}"` : ""} (${p.trips.length} trips): ${p.stops.map((id, i) => `${m.stops.get(id)?.name || id} [${id}]${marks.has(i) ? ` [${[...marks.get(i)].join(", ")}]` : ""}`).join(" → ")}`);
          }
        }
        else out.push(`route "${input.route_stops}" → ${r.ambiguity.message}`);
      }
      return { content: out.join("\n") || "Nothing asked." };
    },
  };

  // The feed read by SQL, before a sql operation is written (principle 17): one read-only statement on the feed as
  // loaded, in this process under the console's bounds (two full scans refused, stopped after its time), the first
  // rows as text. The journal's tables, which name people, are never read (personalData.PERSONAL_TABLES).
  // The feed read by one SELECT before the plan (llm/feedQueryTool: the console's sandbox, its limits).
  const query = feedQueryTool(ctx.db);

  const routeTimetable = {
    definition: {
      name: "route_timetable",
      description: "The timetable of a line on a day type (weekday, saturday, sunday, a weekday name or a YYYYMMDD date): per direction trips, first/last departure, headway per period (early, am_peak, midday, pm_peak, evening), running time, and the departures at the origin.",
      input_schema: { type: "object", properties: { route: { type: "string" }, day: { type: "string" } }, required: ["route"] },
    },
    run(input) {
      const m = ctx.model;
      const r = R.route(m, input.route);
      if (!r.value) return { content: `${r.ambiguity.code}: ${r.ambiguity.message}`, isError: true };
      const day = String(input.day || "weekday").toLowerCase();
      const dows = DAY_TYPES.find(([k]) => k === day)?.[1] || (R.DOW.includes(day.slice(0, 3)) ? [day.slice(0, 3)] : null);
      const date = /^\d{8}$/.test(day) ? day : (dows || []).map((d) => m.representative[d]).find(Boolean);
      if (!date) return { content: `No representative date for "${input.day}".`, isError: true };
      const s = routeStats(m, r.value.id, date);
      const deps = departures(m, r.value.id, date);
      const out = [`Line ${r.value.short_name || r.value.id} on ${date} (${day}): ${s.trips} trips, ${s.vehicles_peak} vehicles at peak.`];
      for (const [dir, d] of Object.entries(s.directions)) {
        const times = (deps.get(dir) || []).map(hhmm);
        out.push(`dir ${dir}: ${d.trips} trips ${d.first?.slice(0, 5)}–${d.last?.slice(0, 5)}, headways ${JSON.stringify(d.headways)}, running ${d.running_min} min. Departures: ${times.length > 120 ? `${times.slice(0, 120).join(" ")} … (+${times.length - 120})` : times.join(" ")}`);
      }
      return { content: out.join("\n") };
    },
  };

  // Other operators' timetables loaded next to the feed (references).
  const referenceTimetable = {
    definition: {
      name: "reference_timetable",
      description: "The calls at a station in a REFERENCE feed (another operator's timetable loaded next to this feed, e.g. the regional trains): departures (or arrivals) of the trips going on to `towards` (or coming from it, for arrivals), per date asked (YYYY-MM-DD) or typical day (weekday, saturday, sunday), within from–to. It says when the reference's validity does not cover the dates. Feed these times to align_connections as with: { times, name }, one step per day timetable.",
      input_schema: {
        type: "object",
        properties: { reference: { type: "string", description: "Reference id or name (default: the only one)." }, stop: { type: "string" }, towards: { type: "string" }, event: { type: "string", enum: ["depart", "arrive"] }, day: { type: "string" }, dates: { type: "array", items: { type: "string" } }, from: { type: "string" }, to: { type: "string" } },
        required: ["stop"],
      },
    },
    run(input) {
      const refs = ctx.sessionId ? references.listReferences(ctx.sessionId) : [];
      if (!refs.length) return { content: "No reference feed is loaded for this session: ask the user for the other operator's GTFS (a public URL, e.g. on transport.data.gouv.fr) to add as a reference, or for the times themselves. Change nothing that depends on them.", isError: true };
      const want = String(input.reference || "").toLowerCase();
      const ref = refs.find((r) => r.id === input.reference) || refs.find((r) => want && r.name.toLowerCase().includes(want)) || (refs.length === 1 ? refs[0] : null);
      if (!ref) return { content: `Which reference? ${refs.map((r) => `${r.id} (${r.name})`).join(", ")}`, isError: true };
      try {
        const out = references.referenceDepartures(ctx.sessionId, ref.id, { stop: input.stop, towards: input.towards || null, event: input.event === "arrive" ? "arrive" : "depart", day: input.day || "weekday", dates: Array.isArray(input.dates) ? input.dates : null, from: input.from || null, to: input.to || null });
        const lines = [`Reference "${ref.name}" (validity ${out.validity ? `${out.validity.start}–${out.validity.end}` : "none"}), ${out.event === "arrive" ? "arrivals" : "departures"} at ${out.stop.join(" / ")}${out.towards ? ` ${out.event === "arrive" ? "from" : "towards"} ${out.towards}` : ""}:`];
        for (const d of out.days) lines.push(`- ${d.asked || d.day} (times of ${d.date || "no date"}): ${d.times.join(" ") || "none"}`);
        for (const w of out.warnings) lines.push(`! ${w}`);
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `${err.code || "ERROR"}: ${err.message}`, isError: true };
      }
    },
  };

  // A timetable grid of an attached spreadsheet read by its cells (sheetGrid): the model says where it is, the server
  // copies the cells and keeps the grid under a ref (timetable { ref } in build_timetable) — never a time retyped.
  const readGridTool = {
    definition: {
      name: "read_grid",
      description: "Read a timetable grid of an attached spreadsheet by its cells — never retype its times. The spreadsheet is attached with its rows numbered and its columns lettered: give the sheet, the cells of the stop names (one column, or one row, in the order the trips run: written backwards, A20:A5, it is read from the bottom), the cells of the times (exactly those rows, or columns), which way a trip runs (columns: each column of times is a trip; rows: each row is a trip), the cells of the trip numbers if any, what a blank cell means (pass: the trip does not serve that stop — a fiche horaire; untimed: served, its time placed by the running times), and the trips to leave out (skip: the positions of the columns, or rows, of the times that are no trip — « puis toutes les 15 min », remarks). The server copies the cells and returns the grid's ref, its stops, its first trips, the trips read past midnight and the cells kept as written because they are not times (the engine asks the user about each); write build_timetable with params.timetable = { \"ref\": <ref> }.",
      input_schema: {
        type: "object",
        properties: {
          document: { type: "string", description: "The spreadsheet's name, as attached." },
          sheet: { type: "string" },
          stops: { type: "string", description: "Cells of the stop names in the order the trips run, e.g. A5:A20." },
          times: { type: "string", description: "Cells of the times, e.g. B5:H20." },
          trips: { type: "string", enum: ["columns", "rows"] },
          numbers: { type: "string", description: "Cells of the trip numbers, one per trip (optional)." },
          empty: { type: "string", enum: ["pass", "untimed"] },
          skip: { type: "array", items: { type: "integer" }, description: "Positions (1 = the first) of the columns, or rows, of the times to leave out: no trip." },
        },
        required: ["document", "sheet", "stops", "times"],
      },
    },
    run(input) {
      // A spreadsheet by its reading (sheet), or by its name when it was attached before the cells were kept.
      const sheets = (Array.isArray(ctx.documents) ? ctx.documents : []).filter((d) => d && (d.sheet === true || SHEET_NAME.test(String(d.name || ""))));
      const name = String(input.document || "").trim();
      const doc = sheets.find((d) => d.name === name) || sheets.find((d) => d.name.toLowerCase() === name.toLowerCase()) || null;
      if (!doc) return { content: `Error: no attached spreadsheet named "${clip(name, 80)}" (attached: ${sheets.map((d) => `"${d.name}"`).join(", ") || "none"}).`, isError: true };
      if (typeof doc.raw_b64 !== "string" || !doc.raw_b64) return { content: `Error: the cells of "${doc.name}" are not kept on the server (attached before this version): ask the user to attach the spreadsheet again.`, isError: true };
      if (ctx.grids.size >= MAX_GRIDS) return { content: `Error: ${MAX_GRIDS} grids at most in one plan.`, isError: true };
      let book = ctx.books.get(doc.id);
      if (!book) {
        try {
          book = readWorkbook(Buffer.from(doc.raw_b64, "base64"), { name: doc.name });
        } catch (err) {
          return { content: `Error: ${err.message}`, isError: true };
        }
        ctx.books.set(doc.id, book);
      }
      const out = sheetGrid.readGrid(book, { sheet: input.sheet, stops: input.stops, times: input.times, trips: input.trips || "columns", numbers: input.numbers || null, empty: input.empty || "pass", skip: Array.isArray(input.skip) && input.skip.length ? input.skip.slice(0, 400) : null });
      if (out.error) return { content: `Error: ${out.error}`, isError: true };
      let n = ctx.grids.size + 1;
      while (ctx.grids.has(`g${n}`)) n += 1;
      const ref = `g${n}`;
      ctx.grids.set(ref, { timetable: out.timetable, cells: out.cells, document: doc.name, ...gridCellsOf({ times: out.cells[1], left_out: out.left_out_cells }) });
      const tt = out.timetable;
      // A cell kept as written (no time) is shown in « », a stop served without its time ·.
      const shown = (x) => (x == null ? "·" : x === "pass" || /^\d{1,2}:\d{2}$/.test(x) ? x : `«${x}»`);
      const show = (row) => row.map(shown).join(" ");
      const lines = [
        `Grid ${ref} read from "${doc.name}" ${out.cells.join(", ")}: ${out.size.stops} stops × ${out.size.trips} trips (${out.size.timed} with a time)${tt.untimed ? "; a stop marked served without its time is shown ·" : ""}.`,
        `Stops: ${tt.stops.join(" | ")}`,
        ...tt.trips.slice(0, 6).map((r, j) => `Trip ${out.positions[j]}${tt.numbers?.[j] ? ` (${tt.numbers[j]})` : ""}: ${show(r)}`),
        ...(tt.trips.length > 6 ? [`… ${tt.trips.length - 6} more trips`] : []),
        ...(out.left_out.length ? [`Left out (skip): ${out.left_out.map((x) => `trip ${x.trip} (${x.cells})`).join(", ")}.`] : []),
        ...(out.after_midnight.length ? [`Read past midnight (a time before 06:00 after one past 18:00, as the same service day): trips ${out.after_midnight.join(", ")} — check the sheet means the same night.`] : []),
        ...(out.without_time.length ? [`Trips without any time: ${out.without_time.join(", ")} — the engine refuses a trip with no time: leave out a column that is no trip (skip) and write its band in timetable.bands, or ask the user.`] : []),
        ...(out.unread.length ? [`Cells kept as written, not times (the engine asks the user about each one left in the grid; never guessed): ${out.unread.map((u) => `${u.cell} « ${u.text} » (${u.reason})`).join("; ")}${out.unread_more ? `; +${out.unread_more} more` : ""}. A band's column: leave it out (skip) and write the band in timetable.bands; a remark (a footnote, « ne circule pas … »): carry it out with the right operation, or ask the user.`] : []),
        `Write it: build_timetable with params.timetable = { "ref": "${ref}" } (the server puts this grid there), the route, direction and days the sheet states, source.quote a cell of the sheet verbatim.`,
      ];
      return { content: lines.join("\n") };
    },
  };

  const runPreview = async () => {
    // The contract over whatever the model wrote (its decided clauses whole, the assumed contract's assumption).
    ctx.plan = withContract(ctx.plan, ctx.contract);
    // In the user's language: the Change Studio shows these steps as they are (codes and options do not change).
    const p = await engine.previewPlan(ctx.db, ctx.plan, previewOptions(ctx));
    // The answers the engine took by itself are the plan's from here on (its params, its assumptions).
    if (p.auto) ctx.plan = autoAnswers.withAuto(ctx.plan, p.auto);
    ctx.preview = p;
    ctx.emit("plan", ctx.plan);
    ctx.emit("preview", p);
    return p;
  };

  // Every quote is checked against what the user wrote (quotes.js) and the
  // verdict recorded on the operation (source.verified / verify_reason). A
  // quote found nowhere refuses the operations being written (`enforce`:
  // their ids; null = all) so the model cites the brief verbatim; one that
  // may come from an attached PDF is accepted, marked unverifiable.
  const validatePlan = (plan, { enforce = null } = {}) => {
    const errors = [];
    const ids = new Set();
    for (const op of plan.operations) {
      if (!op || typeof op !== "object") {
        errors.push("an operation is not an object");
        continue;
      }
      // Ids are read as the engine reads them, one string each (1 and "1" are one id).
      if (!op.id) errors.push(`an operation of type ${op.type} has no id`);
      else if (ids.has(String(op.id))) errors.push(`operation id ${op.id} is used twice`);
      ids.add(String(op.id));
      if (!registry.get(op.type)) errors.push(`${op.id}: unknown type "${op.type}" (known: ${registry.names().join(", ")})`);
      // The person's record (pinned) answers for itself: only what the model writes cites the brief.
      if (!isPinned(op) && !op.source?.quote && op.source?.generated_by !== "optimizer") errors.push(`${op.id}: no source.quote (cite the brief)`);
    }
    for (const q of verifyOperations(plan.operations.filter((op) => op && typeof op === "object" && !isPinned(op)), ctx.quoteSources || {})) {
      if (q.verified === false && q.reason === "not_found" && (!enforce || enforce.has(q.id))) errors.push(`${q.id}: quote not found in the brief: cite it verbatim ("${clip(String(q.quote || ""), 120)}")`);
    }
    return errors;
  };

  const setPlan = {
    definition: {
      name: "set_plan",
      description: "Write the whole change plan (replaces the previous operations; requirement clauses are MERGED by id into those already recorded — add or refine, never remove). The engine previews it on a sandbox of the loaded feed and returns each step's status (applied / blocked with questions / failed), the semantic diff, integrity problems and the clauses after the plan.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          operations: { type: "array", items: OPERATION_SCHEMA },
          requirements: REQUIREMENTS_SCHEMA,
          calendars: { type: "object" },
          costs: { type: "object", properties: { cost_per_km: { type: "number" }, cost_per_hour: { type: "number" }, currency: { type: "string" } } },
          assumptions: ASSUMPTIONS_SCHEMA,
        },
        required: ["title", "operations"],
      },
    },
    async run(input) {
      // The whole-plan replace never replaces the requirements: the model's clauses merge into the record.
      const kindKept = [];
      const leftOut = [];
      const requirements = mergeRequirements(ctx.plan?.requirements, input.requirements, { lang: ctx.lang, kindKept, leftOut });
      // The person's record is never rewritten by a whole-plan replace: a pinned operation the model names by its id
      // is put there unchanged (whatever it wrote under that id); the ones it leaves out stay, first, in their order.
      const pinned = new Map(pinnedOf(ctx.plan).map((o) => [String(o.id), o]));
      const named = new Set();
      const written = (Array.isArray(input.operations) ? input.operations : []).map((o) => {
        if (!o || typeof o !== "object" || !pinned.has(String(o.id))) return modelOperation(o);
        named.add(String(o.id));
        return pinned.get(String(o.id));
      });
      // Nothing is cut here: the whole list goes to the engine, which holds 100 operations and fails every step past
      // that bound with why — a pinned operation, or one of the model's, is never dropped by a tool in silence.
      const gridded = withGrids(written, ctx.grids, new Map((ctx.plan?.operations || []).filter(Boolean).map((o) => [String(o.id), o])));
      const operations = [...[...pinned.values()].filter((o) => !named.has(String(o.id))), ...gridded.operations];
      // The network's own answers (its school zone, its country) and the engine's assumptions are not the model's to drop.
      const plan = { title: String(input.title || "").slice(0, 160), operations, ...(requirements.clauses.length ? { requirements } : {}), ...(input.calendars ? { calendars: input.calendars } : {}), ...(input.costs ? { costs: input.costs } : {}), ...(ctx.plan?.region ? { region: ctx.plan.region } : {}), ...(ctx.plan?.country ? { country: ctx.plan.country } : {}), assumptions: [...normalizeAssumptions(input.assumptions), ...engineAssumptions(ctx.plan), ...answeredAssumptions(ctx.plan, operations)] };
      const errors = [...gridded.errors, ...validatePlan(plan), ...boundErrors(leftOut)];
      // A refused proposal is a refusal the engine check sends back if the turn ends on it (selfCorrection).
      if (errors.length) {
        ctx.refusedProposal = { tool: "set_plan", errors };
        return { content: `Plan refused:\n- ${errors.join("\n- ")}`, isError: true };
      }
      ctx.refusedProposal = null;
      noteWritten(input.requirements);
      const kept = keptClauses(ctx.plan, plan, input.requirements);
      ctx.plan = plan;
      ctx.planChanged = true;
      const p = await runPreview();
      return { content: [summarizePreview(p), ...notesOf(plan, kept, kindKept)].join("\n") };
    },
  };

  const patchPlan = {
    definition: {
      name: "patch_plan",
      description: "Change part of the current plan: upsert operations by id (the whole operation), remove operation ids, move an id before another, replace title / calendars / assumptions; requirement clauses are MERGED by id (add or refine, never remove). Previews again.",
      input_schema: {
        type: "object",
        properties: {
          upsert: { type: "array", items: OPERATION_SCHEMA },
          remove: { type: "array", items: { type: "string" } },
          before: { type: "object", description: "{ id: the id to insert before } for upserted NEW operations (default: at the end)." },
          title: { type: "string" },
          requirements: REQUIREMENTS_SCHEMA,
          calendars: { type: "object" },
          costs: { type: "object" },
          assumptions: ASSUMPTIONS_SCHEMA,
          answers: {
            type: "array",
            description: "Answer a question the engine asks NOW about an operation — a pinned one too — when the brief or the contract states the answer: { operation, param, value: one of the question's options, quote: the brief's words that give it, verbatim, said: one sentence in the person's language saying the answer and why }. Recorded as an assumption the person accepts at delivery; never for a question the brief does not answer.",
            items: { type: "object", properties: { operation: { type: "string" }, param: { type: "string" }, value: { type: "string" }, quote: { type: "string" }, said: { type: "string" } }, required: ["operation", "param", "value", "quote", "said"] },
          },
        },
      },
    },
    async run(input) {
      if (!ctx.plan) return { content: "No plan yet: call set_plan first.", isError: true };
      // The engine's questions the brief answers (rule 11): checked first — a question asked now, one of its options, the
      // brief's own words — then written into the operation, a pinned one included (only that parameter), each recorded
      // as an assumption. Otherwise the person would be asked « remplacer ou garder ? » of a grid whose brief says
      // « cette grille remplace toutes les courses », the assistant being unable to touch a pinned operation.
      const answers = [];
      const answerErrors = [];
      for (const a of (Array.isArray(input.answers) ? input.answers : []).slice(0, 20)) {
        const id = a && typeof a === "object" ? String(a.operation ?? "") : "";
        const op = (ctx.plan.operations || []).find((o) => o && String(o.id) === id);
        const asked = (ctx.preview?.steps || []).find((st) => String(st.id) === id)?.ambiguities || [];
        const q = asked.find((x) => x && x.param === a?.param);
        const options = Array.isArray(q?.options) ? q.options.map(String) : [];
        const said = typeof a?.said === "string" ? a.said.trim().slice(0, 300) : "";
        const quote = typeof a?.quote === "string" ? a.quote.trim() : "";
        const check = quote ? verifyOperations([{ id, source: { quote } }], ctx.quoteSources || {})[0] : null;
        if (!op) answerErrors.push(`${id || "?"}: no such operation`);
        else if (!q) answerErrors.push(`${id}: the engine asks nothing about ${a?.param || "?"} now (answer only a question of the current preview)`);
        else if (options.length && !options.includes(String(a.value))) answerErrors.push(`${id}: ${a.param} — answer with one of the question's options: ${options.slice(0, 8).join(" | ")}`);
        else if (!quote || (check && check.verified === false && check.reason !== "pdf")) answerErrors.push(`${id}: ${a.param} — cite verbatim the brief's words that give the answer`);
        else if (!said) answerErrors.push(`${id}: ${a.param} — say the answer in one sentence (said)`);
        else answers.push({ id: op.id, param: q.param, value: String(a.value), said, quote });
      }
      if (answerErrors.length) {
        ctx.refusedProposal = { tool: "patch_plan", errors: answerErrors };
        return { content: `Patch refused:\n- ${answerErrors.join("\n- ")}`, isError: true };
      }
      // The journey's own turn (nobody typed a request): the pinned operations are kept as they are.
      if (ctx.autopilot) {
        const kept = new Set(pinnedOf(ctx.plan).map((o) => o.id));
        const touched = [...new Set([...(input.remove || []), ...(input.upsert || []).map((o) => o?.id)].filter((id) => kept.has(id)))];
        if (touched.length) {
          const errors = touched.map((id) => `${id}: pinned (read by the application from the brief, or written by the user) — kept as it is on this turn; add what it does not cover`);
          ctx.refusedProposal = { tool: "patch_plan", errors };
          return { content: `Patch refused:\n- ${errors.join("\n- ")}`, isError: true };
        }
      }
      const plan = JSON.parse(JSON.stringify(ctx.plan));
      const remove = new Set(input.remove || []);
      plan.operations = plan.operations.filter((o) => !remove.has(o.id));
      // An upserted operation is the model's (source stripped to its words, a grid it names put in place); the
      // operations kept from ctx.plan are the client's record.
      const gridded = withGrids((input.upsert || []).map(modelOperation), ctx.grids, new Map((ctx.plan?.operations || []).filter(Boolean).map((o) => [String(o.id), o])));
      for (const op of gridded.operations) {
        const i = plan.operations.findIndex((o) => String(o.id) === String(op.id));
        if (i >= 0) plan.operations[i] = op;
        else {
          const at = input.before?.id ? plan.operations.findIndex((o) => o.id === input.before.id) : -1;
          if (at >= 0) plan.operations.splice(at, 0, op);
          else plan.operations.push(op);
        }
      }
      for (const k of ["title", "calendars", "costs"]) if (input[k] !== undefined) plan[k] = input[k];
      if (input.assumptions !== undefined) plan.assumptions = [...normalizeAssumptions(input.assumptions), ...engineAssumptions(ctx.plan), ...answeredAssumptions(ctx.plan, plan.operations)];
      // Each answer: that one parameter of its operation (whatever else the operation holds stays the person's), and its
      // sentence among the plan's assumptions — the same answer given again replaces its own line.
      for (const a of answers) {
        const op = plan.operations.find((o) => o && String(o.id) === String(a.id));
        if (!op) continue;
        op.params = { ...(op.params || {}), [a.param]: a.value };
        const text = `${a.said} (« ${clip(a.quote, 160)} »)`;
        const own = (plan.assumptions || []).filter((x) => !(x && x.operation === String(a.id) && x.answer === a.param));
        plan.assumptions = [...own, { text: text.slice(0, 300), operation: String(a.id), confidence: "high", answer: a.param }];
      }
      const kindKept = [];
      const leftOut = [];
      if (input.requirements !== undefined) plan.requirements = mergeRequirements(ctx.plan.requirements, input.requirements, { lang: ctx.lang, kindKept, leftOut });
      // Only the operations written now answer for their quotes (an older one's message may have left the history).
      const errors = [...gridded.errors, ...validatePlan(plan, { enforce: new Set((input.upsert || []).map((o) => o?.id)) }), ...boundErrors(leftOut)];
      if (errors.length) {
        ctx.refusedProposal = { tool: "patch_plan", errors };
        return { content: `Patch refused:\n- ${errors.join("\n- ")}`, isError: true };
      }
      ctx.refusedProposal = null;
      noteWritten(input.requirements);
      const kept = input.requirements !== undefined ? keptClauses(ctx.plan, plan, input.requirements) : [];
      ctx.plan = plan;
      ctx.planChanged = true;
      const p = await runPreview();
      return { content: [summarizePreview(p), ...notesOf(plan, kept, kindKept)].join("\n") };
    },
  };

  const askUser = {
    definition: {
      name: "ask_user",
      description: "Ask the user what only they can decide (the engine's blocked questions, or what the brief leaves open with a real impact). Each question: text, options (when enumerable), the operation and parameter it answers, and — only when it does one of the four things below — your recommended default with what it does (default_does): names (the one thing a word of the brief reads as), keeps (what exists where the brief says nothing), builds (what the brief states, the network's way), replaces (the trips a complete timetable stands for). A recommendation that would withdraw service the brief does not state, move a date it states or choose between two readings of its words has no default_does: give none. The turn ends after this call.",
      input_schema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, options: { type: "array", items: { type: "string" } }, operation: { type: "string" }, param: { type: "string" }, default: { type: "string" }, default_does: { type: "string", enum: autoAnswerPolicy.CATEGORIES } }, required: ["text"] },
          },
        },
        required: ["questions"],
      },
    },
    run(input) {
      // A recommendation follows the policy of the engine's own answers (autoAnswerPolicy): shown only when the model
      // says what it does and that is one of the four things an answer taken for the person may do; otherwise the
      // question stands without a default — a reading of the brief, a withdrawal or a moved date is the person's alone.
      const qs = (input.questions || []).slice(0, 12).map((q) => {
        if (!q || typeof q !== "object") return q;
        const { default_does: does, ...rest } = q;
        const allowed = rest.default != null && autoAnswerPolicy.CATEGORIES.includes(does);
        return allowed ? { ...rest, default_does: does } : { ...rest, default: null, ...(rest.default != null ? { default_withheld: true } : {}) };
      });
      ctx.asked = true;
      ctx.emit("questions", { questions: qs });
      return { content: `${qs.length} question(s) shown to the user. End your turn with one short sentence.` };
    },
  };

  // Ridership estimates and the frequency optimiser (proposals the user validates).
  const demandTools = Object.values(require("./plannerDemandTools").createChangeDemandTools(ctx, deps.demand || {}).byName);
  const tools = [lookup, query, routeTimetable, referenceTimetable, readGridTool, setPlan, patchPlan, askUser, ...demandTools];
  return { definitions: tools.map((t) => t.definition), byName: Object.fromEntries(tools.map((t) => [t.definition.name, t])) };
};

// ── Model loop ──────────────────────────────────────────────────────────────

const { supportsEffort } = require("../llm/provider");
const { streamRound } = require("../llm/streamRound");
const { turnBudget } = require("../llm/turnBudget");

const runRound = ({ client, model, messages, tools, signal, emit, toolChoice = null }) => {
  const effort = config.NETWORK_PLANNER_EFFORT;
  // One streamed call, retried on its own when its stream is cut or ends without its final message
  // (llm/streamRound: the reader is told by a `retry` event before each new attempt).
  return streamRound({
    client,
    signal,
    emit,
    body: {
      model,
      max_tokens: MAX_TOKENS,
      system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
      tools: tools.definitions,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(effort && supportsEffort(model) ? { output_config: { effort } } : {}),
      // The conversation cached as it grows: each round reads back the previous one (services/promptCache).
      messages: withRollingCache(messages),
    },
  });
};

const NO_ANSWER = "(No answer: that turn did not complete.)";

const buildMessages = ({ history, brief, plan, preview, overview, language, documents = [], context = [] }) => {
  const msgs = [];
  for (const h of (history || []).slice(-MAX_HISTORY)) {
    if (!h || (h.role !== "user" && h.role !== "assistant")) continue;
    const text = clipSaid(String(h.content || ""), 8000);
    if (!text.trim()) continue;
    const prev = msgs[msgs.length - 1];
    if (prev && prev.role === h.role) {
      if (h.role === "user") msgs.push({ role: "assistant", content: NO_ANSWER }, { role: "user", content: text });
      else prev.content += `\n\n${text}`;
    } else msgs.push({ role: h.role, content: text });
  }
  const blocks = [`[UI language: ${LANG_NAMES[language] || "English"}]`, ...context, overview];
  // What the model reads of each document: a spreadsheet with its cells numbered and lettered says so — and cut
  // short, it is the text the model reads that says « truncated ».
  if (documents.length) blocks.push(`[Attached documents] ${documents.map((d) => `"${d.name}"${d.sheet && d.model_text ? ` (spreadsheet, ${d.pages || 1} sheet(s): rows numbered, columns lettered — read its grids with read_grid)` : d.pages ? ` (${d.pages} pages)` : ""}${(d.model_text ? d.model_truncated : d.truncated) ? " (truncated)" : ""}`).join(", ")} — the brief: read them entirely; cite their pages in source.page.`);
  if (plan) blocks.push(`[Current plan]\n${planBlock(plan, { documents: documents.map((d) => d.name) })}`);
  if (preview) blocks.push(`[Last preview]\n${clipSaid(summarizePreview(preview), 8000)}`);
  blocks.push(brief);
  if (msgs.length && msgs[msgs.length - 1].role === "user") msgs.push({ role: "assistant", content: NO_ANSWER });
  msgs.push({ role: "user", content: blocks.join("\n\n") });
  if (msgs[0].role !== "user") msgs.shift();
  if (documents.length) {
    const last = msgs[msgs.length - 1];
    last.content = [...briefDocuments.toContentBlocks(documents), { type: "text", text: last.content }];
  }
  return msgs;
};

/**
 * The texts a quote may come from: the brief, the user's earlier messages,
 * the attached documents the server can read (Word, OpenDocument, text, and
 * a PDF's text layer read at ingestion — briefDocumentService.textOf; only a
 * PDF without one, a scan, is known by name alone: its quotes cannot be
 * checked here), and the quotes verified in an earlier turn (kept when their
 * message left the history).
 */
const quoteSourcesOf = ({ brief, history = [], documents = [], plan = null, contract = null }) => ({
  // …and the words the contract's clauses cite (a spreadsheet's cells read without the model are not among the
  // documents of the turn: an operation carrying out such a clause cites the clause's own quote).
  texts: [brief, ...(history || []).filter((h) => h && h.role === "user" && typeof h.content === "string").map((h) => h.content), ...(documents || []).map(briefDocuments.textOf).filter(Boolean), ...(documents || []).map((d) => (typeof d?.model_text === "string" ? d.model_text : null)).filter(Boolean), ...(contract?.clauses || []).map((c) => (typeof c?.quote === "string" ? c.quote : "")).filter((q) => q.trim().length >= 3)],
  textNames: (documents || []).filter((d) => briefDocuments.textOf(d)).map((d) => d.name),
  pdfNames: (documents || []).filter((d) => d.kind === "pdf" && !briefDocuments.textOf(d)).map((d) => d.name),
  trusted: new Set((plan?.operations || []).filter((o) => o?.source?.verified === true && typeof o.source.quote === "string").map((o) => quoteInternals.compact(o.source.quote))),
});

// The planner's today (YYYY-MM-DD): the clock, or a date a caller freezes (an evaluation world).
const todayIso = (d) => engine.todayIso(d);

/**
 * What every simulation of a turn is run with: the periods' country and school zone (the session's, else the feed's
 * own — ctx.calendar), and, on a turn that settles them (`ctx.auto`), the questions that carry their own answer.
 */
const previewOptions = (ctx, extra = {}) => ({ sessionId: ctx.sessionId, dataVersion: ctx.dataVersion, router: ctx.router, country: ctx.calendar ? ctx.calendar.country : ctx.country, countrySource: ctx.calendar?.country_source || null, fetchImpl: ctx.fetchImpl, lang: ctx.lang, today: ctx.today, coverage: ctx.coverage, contract: ctx.contract || null, requireContract: Boolean(ctx.contract), territory: ctx.territory || null, region: ctx.calendar?.region || ctx.region || null, regionSource: ctx.calendar?.region_source || null, auto: Boolean(ctx.auto), ...extra });

/**
 * The plan as the contract makes it: its requirements are the record's clauses with the contract's over them
 * (contractService.mergeInto: a clause a person decided is theirs, whole), and an assumed contract adds the
 * assumption a named person accepts at delivery, as does each assumption of the contract nobody confirmed
 * (engine pendingAssumptions → ASSUMPTIONS_UNVALIDATED). A draft adds only the clauses kept by default: a plan
 * written by hand is measured against them from its first simulation, never committed with them unsaid.
 * A plan without operations stays null (nothing to preview yet); the contract waits for the model's first set_plan.
 * The contract's clauses come first and are never cut; when the record's own clauses would take the measure past
 * conformanceService.MAX_CLAUSES, the plan is refused (409 TOO_MANY_CLAUSES, the ids left out named) rather than
 * measured without them — a promise is never dropped in silence. `plan.assumptions` is read as a list whatever a
 * client sent (a malformed plan is the handler's 400, never a 500 here).
 */
const withContract = (plan, contract) => {
  // A draft measures the clauses ② shows kept by default (the two « inchangé » clauses), nothing else.
  if (!plan || !contract || (!contractService.isReady(contract) && !contractService.keptByDefault(contract).length)) return plan;
  const leftOut = [];
  const clauses = contractService.mergeInto(plan.requirements?.clauses || [], contract, { leftOut });
  if (leftOut.length) throw refusal(409, "TOO_MANY_CLAUSES", `The contract and the plan would hold ${clauses.length + leftOut.length} clauses: ${conformance.MAX_CLAUSES} at most are measured. ${leftOut.length} clause(s) of the plan (${leftOut.slice(0, 12).join(", ")}${leftOut.length > 12 ? ", …" : ""}) could not be: remove clauses at step 2, or from the plan.`, { max: conformance.MAX_CLAUSES, count: clauses.length + leftOut.length, left_out: leftOut });
  // The contract's assumptions are the server's (the assumed contract, the ones nobody confirmed): whatever a client
  // or the model sent under their mark or their words is replaced.
  const items = contractService.pendingAssumptionsOf(contract);
  const assumptions = (Array.isArray(plan.assumptions) ? plan.assumptions : []).filter((a) => a?.contract !== true && !String(a?.text || "").startsWith(contractService.ASSUMED_PREFIX));
  return { ...plan, ...(clauses.length ? { requirements: { ...(plan.requirements || {}), clauses } } : {}), assumptions: [...assumptions, ...items.map((item) => ({ text: item.text, contract: true, ...(item.kind === "wish" ? { kind: "wish", quote: item.quote, ...(item.why ? { why: item.why } : {}) } : item.kind === "contract_assumption" ? { kind: item.kind, quote: item.quote } : item.kind === "contract_assumed" ? { kind: item.kind, by: item.by } : {}) }))] };
};

/**
 * What the engine still refuses at the end of a turn (selfCorrection): the
 * last set_plan / patch_plan refused, the preview's failed steps (their
 * error) and blocked steps (one per question the engine asks, its options
 * kept), what blocks the commit and is the plan's doing (integrity problems,
 * the canonical validator's new errors), and the must clauses failing or not
 * measurable after the plan. Never a
 * refusal: quotes the server cannot read (sources_unverified), assumptions
 * awaiting a named person, requirement sentences no clause answers (the
 * contract's), no validator on the server.
 */
const changeRefusals = (ctx) => {
  const out = [];
  if (ctx.refusedProposal) out.push({ source: "proposal", code: "plan_refused", id: ctx.refusedProposal.tool, message: ctx.refusedProposal.errors.slice(0, 8).join("; ") });
  const p = ctx.preview;
  if (!p) return out;
  for (const s of p.steps || []) {
    if (s.status === "failed") out.push({ source: "step", code: "step_failed", id: s.id, operation: s.id, message: s.error || null });
    // A step waiting for an earlier step of its line has nothing to correct yet (engine.previewPlan: waiting_for).
    else if (s.status === "blocked" && !(Array.isArray(s.waiting_for) && s.waiting_for.length)) {
      const asks = s.ambiguities || [];
      if (!asks.length) out.push({ source: "step", code: "step_blocked", id: s.id, operation: s.id, message: s.summary || null });
      for (const a of asks) out.push({ source: "step", code: a.code || "step_blocked", id: `${s.id}.${a.param || "?"}`, operation: s.id, param: a.param || null, message: a.message || null, ...(Array.isArray(a.options) && a.options.length ? { options: a.options.map(String) } : {}) });
    }
  }
  for (const b of p.gate?.blocking || []) {
    if (b.code === "integrity") for (const i of b.problems || []) out.push({ source: "gate", code: "integrity", id: i.code, message: `${i.code} ×${i.count}${i.examples?.[0] ? ` e.g. ${clip(JSON.stringify(i.examples[0]), 160)}` : ""}` });
    else if (b.code === "validation_new_errors") for (const e of b.new_errors || []) out.push({ source: "validator", code: e.code, count: e.after - e.before, expected: `${e.before} error(s), as before the plan`, measured: `${e.after} error(s)`, message: `${e.code}: ${e.before} → ${e.after} error(s) once the plan is applied` });
  }
  for (const a of p.gate?.acknowledgeable || []) {
    if (a.code !== "clauses_failing" && a.code !== "clauses_unknown") continue;
    for (const c of a.clauses || []) out.push({ source: "clause", code: c.status === "fail" ? "clause_failed" : "clause_unknown", status: c.status, id: c.id, kind: c.kind || null, text: c.text || null, expected: c.expected ?? null, measured: c.measured ?? null, message: c.note || null });
  }
  // What the person already settled in the conversation (accepted under a named acknowledgement, fixes by hand) is theirs.
  return out.filter((r) => !correction.settledByPerson(r, { lang: ctx.lang, shape: "transform", said: ctx.saidText }));
};

/**
 * The engine check: the refusals of the last preview; when there are none,
 * the plan previewed once more WITH the canonical validator, as the studio's
 * own preview does (transformController: validatorGate.validateDb with the
 * session's country) — emitted as `preview`, its new errors refusals in turn.
 */
const checkPlan = async (ctx) => {
  const refusals = changeRefusals(ctx);
  const p = ctx.preview;
  if (refusals.length) return refusals;
  // Nothing to validate (no plan, or already validated): nothing more to check.
  if (!p?.id || p.gate?.validation !== "not_run" || !validatorGate.isAvailable()) return [];
  const validated = await engine.previewPlan(ctx.db, ctx.plan, previewOptions(ctx, { validate: (db) => validatorGate.validateDb(db, ctx.country), validatorEnabled: true }));
  if (validated.auto) {
    const settled = autoAnswers.withAuto(ctx.plan, validated.auto);
    if (JSON.stringify(settled) !== JSON.stringify(ctx.plan)) {
      ctx.plan = settled;
      ctx.emit("plan", ctx.plan);
    }
  }
  ctx.preview = validated;
  ctx.emit("preview", validated);
  return changeRefusals(ctx);
};

/**
 * A tool call in the few words the wait screen shows (the `tool` event): the document and the cells a grid is read
 * from, the line a timetable is read for, what a lookup searches, how many operations or questions a plan or an ask
 * carries — strings cut short, nothing else of the input.
 */
const toolSummary = (name, input) => {
  const s = (v, n = 80) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);
  const out = {};
  if (name === "read_grid") {
    if (s(input.document)) out.document = s(input.document);
    if (s(input.sheet)) out.sheet = s(input.sheet, 40);
    const cells = [s(input.stops, 24), s(input.times, 24)].filter(Boolean);
    if (cells.length) out.cells = cells.join(" · ");
  } else if (name === "route_timetable" || name === "reference_timetable") {
    if (s(input.route)) out.route = s(input.route, 40);
    if (s(input.day)) out.day = s(input.day, 20);
  } else if (name === "lookup") {
    const q = [...(Array.isArray(input.routes) ? input.routes : []), ...(Array.isArray(input.stops) ? input.stops : [])].map((x) => s(typeof x === "string" ? x : x?.query, 40)).filter(Boolean);
    if (q.length) out.query = q.slice(0, 3).join(", ");
  } else if (name === "set_plan" || name === "patch_plan") {
    if (Array.isArray(input.operations)) out.operations = input.operations.length;
  } else if (name === "query") {
    const q = s(input.purpose, 60) || s(input.sql, 60);
    if (q) out.query = q;
  } else if (name === "ask_user") {
    if (Array.isArray(input.questions)) out.questions = input.questions.length;
  } else if (name === "set_requirements" || name === "record_objectives") {
    if (Array.isArray(input.clauses)) out.clauses = input.clauses.length;
  }
  return out;
};

/** The limiter's three windows as the `meta` event says them: { used, limit }, the limit null when there is none. */
const allowanceOf = (limit) =>
  Object.fromEntries(["hourly", "daily", "global"].map((w) => [w, { used: Number(limit?.[w]?.used) || 0, limit: Number.isFinite(limit?.[w]?.limit) && limit[w].limit > 0 ? limit[w].limit : null }]));

/** One planner turn on a session's feed. Emits SSE-style events through `emit`. */
const planChangesTurn = async ({ db, sessionId = null, dataVersion = null, country = null, fetchImpl = null, brief, plan = null, history = [], language = "en", documentIds = [], dataIds = [], contract = null, freeTier = false, rateKey, aiLimits = {}, signal, emit, req = null, today = null, maxCorrections = null, auto = false, autopilot = false }) => {
  const text = String(brief || "").trim();
  if (text.length < 3) throw Object.assign(new Error("brief is required (≥ 3 characters)."), { code: "INVALID_INPUT", status: 400 });
  if (text.length > MAX_BRIEF_CHARS) throw Object.assign(new Error(`brief is too long (max ${MAX_BRIEF_CHARS} characters).`), { code: "INVALID_INPUT", status: 400 });
  // The contract as the server reads it (400 for an anonymous decision): a draft, or none, means the extraction turn.
  const agreed = contractService.normalizeContract(contract);
  const limit = aiCostLimiter.check({ key: rateKey || "anon", scope: "chat", ...aiLimits });
  if (!limit.ok) throw Object.assign(new Error(limit.code === "BUDGET_EXHAUSTED" ? "The daily AI budget has been reached." : limit.code === "AI_ALLOWANCE_EXHAUSTED" ? "The AI envelope of this account is spent." : "AI request limit reached. Try again later."), { code: limit.code, status: limit.status || (limit.code === "BUDGET_EXHAUSTED" ? 503 : 429), retryAfterSec: limit.retryAfterSec, ...(limit.allowance ? { details: { allowance: limit.allowance } } : {}) });
  const client = nl2sqlChatService.getClient();
  const model = freeTier ? config.PLANNER_FREE_MODEL || nl2sqlChatService.resolveChatModel({ freeTier: true }) : config.TRANSFORM_PLANNER_MODEL || config.NETWORK_PLANNER_MODEL || nl2sqlChatService.resolveChatModel({});
  const startedAt = Date.now();
  if (!contractService.isReady(agreed)) {
    // Phase "extract": the brief's clauses and nothing else — no plan, no preview, until the person decides.
    const docs = briefDocuments.getDocuments(documentIds);
    try {
      // The brief's statements about today's network are measured on the feed as the plan will be (the country and
      // the school zone read as the turn reads them), before the person decides anything.
      const measurePremises = async (list) => {
        const own = await require("./calendarContext").contextOf(db, sessionId, { fetchImpl, model: buildFeedModel(db) });
        return premisesService.measurePremises(db, list, { country: own.country || country || null, region: own.region || null, fetchImpl, today: todayIso(today) });
      };
      // The tests of the change the engine derives from the intent sheet, on the feed as it is (contract/derivedChecks).
      const deriveIntent = (sheet) => require("../contract/derivedChecks").deriveChecks(sheet, { model: buildFeedModel(db) });
      const out = await runExtractTurn({ brief: text, db, readings: config.EXTRACT_READINGS, documents: docs.found, documentIds, missing: docs.missing, tooLong: [...(docs.too_long_ids || []), ...(docs.overflow_ids || [])], language, mode: "transform", model, trial: freeTier, emit, signal, measurePremises, deriveIntent });
      eventLogger.recordEvent("transform.plan", { ...(req ? eventLogger.extractReqMeta(req) : {}), model, phase: "extract", clauses: out.contract.clauses.length, wishes: out.contract.wishes.length, uncovered: out.coverage?.uncovered.length ?? null, ...(out.usage || {}), durationMs: Date.now() - startedAt, anon: freeTier });
      return { text: "", phase: "extract", contract: out.contract, coverage: out.coverage, plan: null, preview: null, ready: false, verdict: out.verdict, prose: null };
    } catch (err) {
      if (signal?.aborted) {
        emit("done", { reason: "aborted", phase: "extract" });
        return null;
      }
      throw err;
    }
  }
  // A statement of the brief about today's network that the feed contradicts is the person's question, asked at ①
  // with the fact read; nothing is planned over it until they answer (contract/premises): a plan would otherwise
  // make the brief's belief true by itself, or build on it.
  // Two readings of the brief that differ (contract/intentSheet reconcileSheets): each divergence is the person's
  // question at ①, A or B; nothing is planned over one nobody answered.
  const unread = contractService.undecidedReadings(agreed);
  if (unread.length) throw refusal(409, "READING_UNDECIDED", `${unread.length} point(s) on which the two readings of the brief differ wait for the person's choice.`, { readings: unread.map((d) => ({ id: d.id, field: d.field, a: d.a ?? null, b: d.b ?? null, quote: String(d.quote || "").slice(0, 200) })) });
  const undecided = premisesService.undecidedPremises(agreed);
  if (undecided.length) throw refusal(409, "PREMISE_UNDECIDED", `${undecided.length} statement(s) of the brief about today's network are contradicted by the feed and wait for the person's decision.`, { premises: undecided.map((p) => ({ id: p.id, quote: String(p.quote || "").slice(0, 200), measured: p.measured ?? null })) });
  const feedModel = buildFeedModel(db);
  // The client's plan is the user's record; its requirements are measured as normalizeClause reads them
  // (an anonymous waiver is demoted) and its assumptions carry nothing but text, operation, confidence —
  // then the contract over them (withContract).
  // The engine's own answers a client's plan records (`auto` assumptions) stay marked: the turn's simulations prune or keep them.
  const clientPlan = withContract(plan && Array.isArray(plan.operations) ? { ...plan, ...(plan.requirements !== undefined ? { requirements: normalizeRequirements(plan.requirements) } : {}), ...(plan.assumptions !== undefined ? { assumptions: normalizeAssumptions(plan.assumptions, { keepAuto: true }) } : {}) } : null, agreed);
  // `autopilot`: the turn the modify journey launches by itself (nobody typed it) — the pinned operations are kept as
  // they are. `auto` (always with it; also a typed turn of that journey): the turn's simulations settle the questions
  // that carry their own answer, as the studio's own simulations do (engine.previewPlan { auto }).
  const ctx = { db, sessionId, dataVersion, country, fetchImpl, model: feedModel, plan: clientPlan, planChanged: false, refusedProposal: null, preview: null, asked: false, emit, router: deps.createRouter(), dataIds: Array.isArray(dataIds) ? dataIds : [], lang: typeof language === "string" ? language : "en", today: todayIso(today), contract: agreed, auto: Boolean(auto || autopilot), autopilot: Boolean(autopilot) };
  // What the conversation already says (the engine check leaves a refusal the person settled there).
  ctx.saidText = [text, ...(history || []).map((h) => String(h?.content || ""))].join("\n");
  // G5, once per turn (the contract and the documents do not change within it): the brief's requirement sentences
  // the contract answers; the preview's gate holds the plan while one is uncovered under a decided or assumed contract.
  ctx.coverage = coverageForContract({ contract: agreed, documentIds });
  // The session's school region (a network opened from the catalogue): the school periods resolved without asking.
  ctx.region = require("../sessionCountry").sessionSchoolRegion(sessionId);
  // …else the feed's own (calendarContext: an uploaded GTFS has neither in its session): the country its agency's
  // time zone names — a fact —, and, on a turn that settles (`auto`: the engine records it as an assumption of the
  // plan), the school zone its own calendars follow. The validator and the residents' grid keep the session's country.
  // Both readers answer null for what they cannot tell and never throw, so nothing is caught here: a failure of the
  // code itself ends the turn with its error instead of a silent « neither known ».
  ctx.calendar = { country: country || null, country_source: country ? "session" : null, region: ctx.region || null, region_source: ctx.region ? "session" : null };
  if (!ctx.calendar.country || (ctx.auto && !ctx.calendar.region)) {
    const calendarContext = require("./calendarContext");
    if (ctx.auto && !ctx.calendar.region) {
      const own = await calendarContext.contextOf(db, sessionId, { fetchImpl, model: feedModel });
      ctx.calendar = { country: own.country || ctx.calendar.country, country_source: own.country ? own.country_source : ctx.calendar.country_source, region: own.region || null, region_source: own.region ? own.region_source : null };
    } else {
      const own = calendarContext.feedCountry(db) || null;
      ctx.calendar = { ...ctx.calendar, country: own, country_source: own ? "feed" : null };
    }
  }
  // The residents a coverage clause counts (the grid the recommendations counted at ②), once per turn: without them
  // the clause is unknown and holds the plan behind an acknowledgement.
  ctx.territory = await require("../demand/populationGrid").territoryFor(db, { clauses: agreed?.clauses || [] }, { sessionId, countryCode: country, dataIds: ctx.dataIds });
  const tools = createTools(ctx);
  const docs = briefDocuments.getDocuments(documentIds);
  // The spreadsheets read_grid reads (their cells kept by the server).
  ctx.documents = docs.found;
  const context = [`[Today] ${ctx.today}`, contractService.promptOf(agreed)].filter(Boolean);
  // A country read from the feed counts only on a turn that records it (`auto`): otherwise the engine asks.
  if (ctx.calendar.country && (ctx.calendar.country_source !== "feed" || ctx.auto)) context.push(`[Country] ${ctx.calendar.country}${ctx.calendar.country_source === "feed" ? " (read from the operator's time zone: an assumption the user validates)" : ""} (public and school holidays can be named periods)${ctx.calendar.region ? `; school zone ${ctx.calendar.region}${ctx.calendar.region_source === "inferred" ? " (read from the feed's own calendars: an assumption the user validates)" : ""}` : ""}`);
  // The journey's own turn: said to the model as what it is — nobody typed this message.
  if (ctx.autopilot) context.push("[Autopilot] This turn was launched by the application when the user opened the step — the user typed nothing. Build the complete change the brief and the contract ask for, beyond the pinned operations (see the principles): every clause of the contract is measured after the plan. The engine settles by itself the questions that carry their own answer. Ask the user (ask_user) only what truly changes the result and that neither the brief, the contract nor the feed says; when nothing is missing, ask nothing. The page shows the engine's own questions to the user by itself: never repeat one with ask_user — answer it with patch_plan answers when the brief says the answer, else leave it to the page. An option you offer is said in the user's language (never an engine value such as replace or keep).");
  const refs = sessionId ? references.listReferences(sessionId) : [];
  if (refs.length) context.push(`[Reference feeds] ${refs.map((r) => `${r.id} "${r.name}" (${r.agencies.join(", ") || "?"}; ${r.counts.trips} trips near the network; validity ${r.validity ? `${r.validity.start}–${r.validity.end}` : "?"})`).join("; ")} — read them with reference_timetable.`);
  if (docs.missing.length) context.push(`[Documents] ${docs.missing.length} attached document(s) expired on the server and are NOT in this message: say so; do not guess their content.`);
  if (docs.overflow) context.push(`[Documents] ${docs.overflow} more attached document(s) are NOT in this message (${briefDocuments.MAX_TURN_DOCUMENTS} at most per message): say so to the user, name what you could not read, and do not guess their content.`);
  if (docs.too_long?.length) context.push(`[Documents] ${docs.too_long.map((n) => `"${n}"`).join(", ")} NOT in this message: the documents of one message are bounded together (about 120k tokens): say so to the user, name them, and do not guess their content.`);
  // A document the person kept from the assistant (sent_to_assistant: false) is never handed over; the model only knows it exists.
  if (docs.withheld && docs.withheld.length) context.push(`[Documents] ${docs.withheld.length} attached document(s) were kept from the assistant by the user and are NOT in this message: do not guess their content.`);
  if (docs.found.length) emit("step", { kind: "documents", count: docs.found.length, names: docs.found.map((d) => d.name) });
  // What the user wrote, against which the plan's quotes are checked.
  ctx.quoteSources = quoteSourcesOf({ brief: text, history, documents: docs.found, plan: ctx.plan, contract: agreed });
  if (ctx.plan) verifyOperations(ctx.plan.operations, ctx.quoteSources);
  // The current plan is previewed again: the model sees where it stands.
  let preview = null;
  if (ctx.plan) {
    preview = await engine.previewPlan(db, ctx.plan, previewOptions(ctx));
    // What the engine settles by itself is the plan's before the model reads it (and the client's: `plan`, `preview`).
    if (preview.auto) {
      const settled = autoAnswers.withAuto(ctx.plan, preview.auto);
      if (JSON.stringify(settled) !== JSON.stringify(ctx.plan)) {
        ctx.plan = settled;
        emit("plan", ctx.plan);
        emit("preview", preview);
      }
    }
    ctx.preview = preview;
  }
  const messages = buildMessages({ history, brief: text, plan: ctx.plan, preview, overview: feedOverview(feedModel), language, documents: docs.found, context });
  // What this turn costs the person: the assistant's allowance for their key after
  // this call was counted — the three windows of aiCostLimiter, each `limit` null when the operator set none — said
  // before the words, so that the trial's daily cap is read where the turn is, never found out on a refusal.
  emit("meta", { model, mode: "transform", trial: Boolean(freeTier), allowance: allowanceOf(limit) });
  const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // The turn's ceiling (llm/turnBudget): past it, one closing call and the turn ends incomplete.
  const budget = turnBudget(aiCostLimiter.turnCeiling(config.AI_TURN_MAX_WEIGHTED_TOKENS, limit, model));
  const addUsage = (u) => {
    if (!u) return;
    for (const k of Object.keys(usageTotals)) usageTotals[k] += Number(u[k]) || 0;
    budget.add(u);
  };
  let rounds = 0;
  let toolCalls = 0;
  let consecutiveErrors = 0;
  let incomplete = null;
  // The budget spent (said once): the turn is incomplete from here, whatever the model concludes.
  const spent = () => {
    if (!budget.exceeded()) return false;
    if (incomplete !== "TURN_BUDGET") {
      incomplete = "TURN_BUDGET";
      emit("budget", { code: "TURN_BUDGET", ...budget.snapshot() });
    }
    return true;
  };
  // The model's prose: `finalText` is its answer since the last correction (what the verdict judges), `superseded` what came before.
  let finalText = "";
  const superseded = [];
  const corr = correction.tally(correction.maxOf(maxCorrections));
  // Corrections ran out (or the budget did) and the engine still refuses: the person decides — the engine's questions.
  // Only what the person can settle: the model's own proposals of corrections of the contract were never proposed to
  // anyone (refused, or a replacement the plan fails), so they are never escalated (selfCorrection.forPerson).
  const escalate = (all) => {
    const refusals = correction.forPerson(all);
    if (!refusals.length) return;
    corr.escalated = true;
    emit("correction", { attempt: corr.attempts, max: corr.max, phase: "escalated", reasons: correction.reasonsOf(refusals) });
    const questions = correction.escalationQuestions(refusals, { lang: ctx.lang, max: corr.max, shape: "transform" });
    if (questions.length) {
      emit("questions", { questions });
      ctx.asked = true;
    }
  };
  try {
    for (;;) {
      if (signal?.aborted) {
        emit("done", { reason: "aborted" });
        return null;
      }
      const round = await runRound({ client, model, messages, tools, signal, emit });
      rounds += 1;
      addUsage(round.usage);
      finalText += round.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (round.stopReason === "refusal") {
        incomplete = "REFUSAL";
        emit("error", { code: "REFUSAL", message: "The model declined this request." });
        break;
      }
      if (round.stopReason === "max_tokens") {
        incomplete = "OUTPUT_LIMIT";
        emit("error", { code: "OUTPUT_LIMIT", message: "The plan is too large to be written in one go: split the brief." });
        break;
      }
      if (!round.toolUses.length || round.stopReason !== "tool_use") {
        // The model ended its turn: the engine checks the plan it changed (or the proposal it had refused). What the
        // model can fix goes back to it as a user message (never a forced tool); what remains is the person's.
        const roundsLeft = MAX_ROUNDS - rounds;
        if (correction.shouldCheck({ max: corr.max, stopReason: round.stopReason, asked: ctx.asked, incomplete, changed: ctx.planChanged, refused: Boolean(ctx.refusedProposal), attempts: corr.attempts, roundsLeft })) {
          const refusals = await checkPlan(ctx);
          const decided = correction.decide({ refusals, attempts: corr.attempts, max: corr.max, roundsLeft });
          // The turn's budget spent: no correction round, the person decides.
          const next = decided === "retry" && spent() ? "escalate" : decided;
          if (next === "retry") {
            corr.attempts += 1;
            emit("correction", { attempt: corr.attempts, max: corr.max, phase: "retry", reasons: correction.reasonsOf(refusals) });
            messages.push({ role: "assistant", content: correction.assistantContent(round.content) });
            messages.push({ role: "user", content: [{ type: "text", text: correction.correctionMessage(refusals, corr.attempts, corr.max, ctx.lang, { fix: "patch_plan (set_plan only to rewrite the whole plan)" }) }] });
            superseded.push(finalText);
            finalText = "";
            continue;
          }
          if (next === "escalate") escalate(refusals);
          else if (corr.attempts) corr.resolved = true;
        }
        break;
      }
      messages.push({ role: "assistant", content: round.content });
      const results = [];
      for (const tu of round.toolUses) {
        toolCalls += 1;
        const tool = tools.byName[tu.name];
        let res;
        try {
          res = tool ? await tool.run(tu.input || {}) : { content: `Error: unknown tool ${tu.name}.`, isError: true };
        } catch (err) {
          res = { content: `Tool ${tu.name} failed: ${err.message}`, isError: true };
        }
        consecutiveErrors = res.isError ? consecutiveErrors + 1 : 0;
        // What the assistant just did, in one line for the person's wait screen (the reading shown as it happens —
        // the grid read by its cells, the line looked up, the plan written): the tool's name and the few inputs that
        // say what it read, never the model's words nor the tool's answer.
        emit("tool", { name: tu.name, ...toolSummary(tu.name, tu.input || {}), ...(res.isError ? { error: true } : {}) });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: res.content, ...(res.isError ? { is_error: true } : {}) });
      }
      const over = spent();
      const stop = rounds >= MAX_ROUNDS || consecutiveErrors >= MAX_CONSECUTIVE_ERRORS || ctx.asked || over;
      if (stop && !ctx.asked) results[results.length - 1].content += over ? "\n\n[Turn budget exhausted: summarise now with what you have and say what is missing.]" : rounds >= MAX_ROUNDS ? "\n\n[Tool budget exhausted: summarise now.]" : "\n\n[Too many consecutive tool errors: summarise now and say what is missing.]";
      messages.push({ role: "user", content: results });
      if (stop) {
        const closing = await runRound({ client, model, messages, tools, signal, emit, toolChoice: { type: "none" } });
        addUsage(closing.usage);
        finalText += closing.content.filter((b) => b.type === "text").map((b) => b.text).join("");
        rounds += 1;
        // The budget ran out after a correction: the engine's last word decides between resolved and the person's questions.
        if (corr.attempts && !ctx.asked) {
          const refusals = await checkPlan(ctx);
          if (refusals.length) escalate(refusals);
          else corr.resolved = true;
        }
        break;
      }
    }
    emit("usage", { rounds, toolCalls, ...usageTotals, budget: budget.snapshot(), durationMs: Date.now() - startedAt });
    const p = ctx.preview;
    const g = p?.gate || null;
    // Ready = the engine's gate says so: something to commit, nothing blocking, nothing to acknowledge.
    const ready = Boolean(p && p.id && g?.can_commit && !g.acknowledgeable.length && !incomplete);
    const ack = (code, key) => (g?.acknowledgeable || []).filter((a) => a.code === code).flatMap((a) => a[key] || []);
    // The verdict is the engine's (recomputed from the conformance results), emitted apart from the
    // model's prose; a sentence of the prose contradicting it is flagged (spans to strike).
    // G5: the brief's requirement sentences the contract answers (the gate holds the plan while one is uncovered).
    const verdict = verdictOf(p?.conformance?.after, { gate: g, coverage: ctx.coverage, contract: ctx.contract });
    // …and a claim that a clause of the contract was changed, which no tool of the model can do, struck too — read
    // against the record (contractClaims: never a sentence about the plan, nor about the model's own clauses).
    const prose = withContractClaims(contradictionsOf(finalText, verdict), finalText, { contract: ctx.contract, plan: ctx.plan, written: ctx.written });
    emit("verdict", { verdict, gate: g, prose });
    emit("done", { reason: incomplete ? "incomplete" : "complete", ready, blocked: Boolean(p?.blocked), previewId: p?.id || null, asked: ctx.asked, planChanged: ctx.planChanged, gate: g, failingClauses: ack("clauses_failing", "clauses").map((c) => c.id), unknownClauses: ack("clauses_unknown", "clauses").map((c) => c.id), pendingAssumptions: ack("assumptions_unvalidated", "assumptions"), verdict, corrections: { ...corr } });
    eventLogger.recordEvent("transform.plan", { ...(req ? eventLogger.extractReqMeta(req) : {}), model, rounds, toolCalls, operations: ctx.plan?.operations?.length || 0, blocked: Boolean(p?.blocked), ready, asked: ctx.asked, incomplete, must_fail: verdict?.must.fail ?? null, must_unknown: verdict?.must.unknown ?? null, contradiction: prose.contradicts, claims_all_met: prose.claims_all_met, claims_contract_change: Boolean(prose.claims_contract_change), corrections: corr.attempts, corrections_max: corr.max, corrections_resolved: corr.resolved, escalated: corr.escalated, ...usageTotals, durationMs: Date.now() - startedAt, anon: freeTier });
    return { text: finalText, superseded, corrections: { ...corr }, plan: ctx.plan, preview: p, ready, verdict, prose, asked: ctx.asked };
  } catch (err) {
    eventLogger.recordEvent("transform.plan", { ...(req ? eventLogger.extractReqMeta(req) : {}), model, rounds, toolCalls, error: err.code || err.name || "error", ...usageTotals, durationMs: Date.now() - startedAt, anon: freeTier });
    if (signal?.aborted) {
      emit("done", { reason: "aborted" });
      return null;
    }
    throw err;
  }
};

/**
 * One planner turn with the persons of its contract and of the working copy's journal and
 * acknowledgements known to the model client's safety net (llm/personalData).
 */
const planChanges = (args = {}) => personalData.run([...personalData.namesOfContract(args.contract), ...personalData.namesOfSessionDb(args.db)], () => planChangesTurn(args));

module.exports = { planChanges, buildSystemPrompt, feedOverview, summarizePreview, _internals: { withContract, changeRefusals, checkPlan, deps, catalogueText, createTools, toolSummary, buildMessages, quoteSourcesOf, planForModel, sizedTimetable, gridsOf, withGrids, MAX_GRIDS, assumptionForModel, pinnedOf, engineAssumptions, previewOptions, normalizeRequirements, normalizeAssumptions, mergeRequirements, modelClauses, modelOperation, clauseWarnings, notesOf, REQUIREMENTS_SCHEMA, MAX_ROUNDS, MAX_ENGINE_ASSUMPTIONS, RECIPES, planBlock, PLAN_CHARS } };
