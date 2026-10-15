/**
 * autoAnswerPolicy — what the engine may settle by itself, and what it never does.
 *
 * A question an operation raises can carry its own answer (`auto`): the
 * autopilot takes it, writes it in the plan and records it as an assumption a
 * named person validates at the delivery (autoAnswers, G2). This module is the
 * closed list of the questions whose answer the engine may take, each with
 * WHAT the answer does — the only things an answer taken for the person may do:
 *
 *   names     the one thing a word of the order reads as: a grid's stop name
 *             that is exactly one stop of the line; the pattern the order's own
 *             origin stop names; the school zone and the country read from the
 *             feed's own calendars
 *   keeps     what exists, where the order says nothing: a few dates without
 *             service left as they are; a departure the line already makes;
 *             the vehicle blocks left to the scheduling tool
 *   builds    what the order states, the network's own way: a band's first
 *             departure, a grid's band times, the line's running times, the
 *             holidays its weekdays cover, the plan's shared date for an
 *             operation that gives none
 *   replaces  the trips a complete timetable stands for: a desserte grid is
 *             the whole offer of its direction and day type, not an addition
 *
 * Never taken for the person — the question stops at them, whatever default
 * the operator or the planner would recommend: withdrawing service the order
 * does not state in words, moving a date the order states, choosing between
 * two readings of the order's words (a divergence of two readings, a stretch
 * read one way or the other, a stop one direction lists and the other may
 * serve), confirming a change the engine finds too large. A question whose
 * code is not listed here keeps its `auto` unused: the step is blocked, for
 * the person, however defensible its operator found the answer. A new auto
 * answer is added here with its category, and autoAnswerPolicy.test.js holds
 * the list to the sources.
 *
 *   allows(code)   → whether the engine may take that question's own answer
 *   POLICY         { code: category }
 *   CATEGORIES     the four things an answer may do
 *   NEVER          question codes that must never carry an answer the engine takes
 */

"use strict";

const CATEGORIES = Object.freeze(["names", "keeps", "builds", "replaces"]);

const POLICY = Object.freeze({
  // build_timetable
  timetable_stop: "names",
  band_gap: "builds",
  band_times_missing: "builds",
  running_times_missing: "builds",
  weekday_hole: "builds",
  new_dates_missing: "keeps",
  others_missing: "replaces",
  // add_trips
  near_existing_departure: "keeps",
  pattern_withdrawn_from_stop: "names",
  // create_route
  holidays_unspecified: "builds",
  // every operation's scope
  effective_date_shared: "builds",
  // the plan's own readings (engine.previewPlan)
  calendar_region_inferred: "names",
  calendar_country_inferred: "names",
  blocks_unchained: "keeps",
});

// Questions whose answer is the person's whatever an operator may one day offer: two readings of the brief
// (planAgreement), a cut the engine finds too large, a line's service withdrawn before the plan's own date, a stop
// listed in one direction only, a stop with one platform per direction, a trip that would run before midnight.
const NEVER = Object.freeze(["reading", "single_trip_big_change", "service_removed_before_plan_date", "one_way_stop", "stop_side_ambiguous", "time_invalid"]);

const allows = (code) => typeof code === "string" && Object.prototype.hasOwnProperty.call(POLICY, code);

module.exports = { allows, POLICY, CATEGORIES, NEVER };
