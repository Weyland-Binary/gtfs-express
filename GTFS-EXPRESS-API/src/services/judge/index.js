/** The judge's public surface: the clause vocabulary of a brief and its measures on a feed. */

"use strict";

const { clockOf } = require("./values");
const { daysOf, windowOf, scopeOf, gridOf, weekDay } = require("./calendar");
const { findLine, pairedLine, nameMatches, locate, directionIn } = require("./locate");
const { KINDS, STRUCTURAL_KINDS, TIME_KINDS, KIND_DOCS, kindsText, WEEKDAY_RULE, LEVELS, STATUSES, MAX_CLAUSES, normalizeClause, mergeClauses, unmetMust, clausesOf } = require("./clauseModel");
const { gapOf, refDatesOf, likeDayRunningTimes } = require("./checks/timetable");
const { hausdorffM, shapeSectionBetween } = require("./checks/patterns");
const { linePairs } = require("./checks/comparison");
const { identityLine, stopsNamedIn, identityStops, wheelchairOf } = require("./checks/identity");
const { checkConformance, withResults } = require("./verdict");

module.exports = { checkConformance, withResults, clausesOf, mergeClauses, normalizeClause, unmetMust, KINDS, TIME_KINDS, STRUCTURAL_KINDS, KIND_DOCS, kindsText, WEEKDAY_RULE, LEVELS, STATUSES, MAX_CLAUSES, _internals: { locate, daysOf, findLine, pairedLine, linePairs, directionIn, nameMatches, windowOf, scopeOf, gridOf, gapOf, clockOf, weekDay, stopsNamedIn, identityStops, identityLine, wheelchairOf, hausdorffM, shapeSectionBetween, likeDayRunningTimes, refDatesOf } };
