/**
 * judge — does the network do what the user asked? The clause vocabulary of
 * a brief and its measures on a feed (the Change Studio) or a designed network
 * (the Network Studio). This file is its public surface; the parts, by role:
 *
 *   clauseModel       the clause catalogue (KINDS, KIND_DOCS), normalising,
 *                     merging and linting the clauses of a brief
 *   values            how a clause's params are read: text, numbers, lists, clock times
 *   calendar          windows, scopes and grids: the dates and timetables a clause is measured on
 *   locate            lines, places, stops, calls and directions on a spec
 *   clauseTrips       the trips the trip-level clauses read
 *   result            the shape of one clause's verdict
 *   checks/           one check per clause kind, by family: network, timetable,
 *                     patterns, comparison, identity, tables
 *   tableParams       how a table_rows clause names a table's rows and values
 *   verdict           checkConformance and what a verdict adds up to
 *   unchangedClauses  the « inchangé » clauses, derived from a plan's operations
 *   changeAccounting  the changes a plan makes that no objective asks for
 */

"use strict";

const { clockOf } = require("./values");
const { daysOf, departuresByDirection, MAX_OD_TIMETABLES, windowOf, holidayDayOf, designCalendar, scopeOf, structuralPoints, gridOf, weekDay } = require("./calendar");
const { findLine, pairedLine, nameMatches, PLAN_STOP_NOTE, locate, directionIn } = require("./locate");
const { KINDS, NETWORK_KINDS, STRUCTURAL_KINDS, TIME_KINDS, KIND_DOCS, kindsText, WEEKDAY_RULE, LEVELS, STATUSES, MAX_CLAUSES, normalizeClause, mergeClauses, unmetMust, clausesOf, clauseLints } = require("./clauseModel");
const { fastestTrip } = require("./checks/network");
const { gapOf, refDatesOf, likeDayRunningTimes } = require("./checks/timetable");
const { hausdorffM, shapeSectionBetween } = require("./checks/patterns");
const { linePairs } = require("./checks/comparison");
const { identityLine, stopsNamedIn, identityStops, wheelchairOf } = require("./checks/identity");
const { checkConformance, withResults, summarizeConformance, liftGenericFindings } = require("./verdict");

module.exports = { checkConformance, withResults, clausesOf, mergeClauses, normalizeClause, unmetMust, summarizeConformance, liftGenericFindings, KINDS, NETWORK_KINDS, TIME_KINDS, STRUCTURAL_KINDS, KIND_DOCS, kindsText, clauseLints, WEEKDAY_RULE, LEVELS, STATUSES, MAX_CLAUSES, MAX_OD_TIMETABLES, PLAN_STOP_NOTE, _internals: { locate, daysOf, findLine, pairedLine, linePairs, directionIn, nameMatches, departuresByDirection, fastestTrip, windowOf, scopeOf, gridOf, structuralPoints, gapOf, designCalendar, holidayDayOf, clockOf, weekDay, stopsNamedIn, identityStops, identityLine, wheelchairOf, hausdorffM, shapeSectionBetween, likeDayRunningTimes, refDatesOf } };
