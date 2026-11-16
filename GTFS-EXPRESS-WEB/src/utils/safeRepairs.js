/**
 * The validator rules whose repair changes the form and never the meaning (a colour's #, an address without its scheme,
 * spaces around a name, a time zone's case, a description or an address repeating another, the distances along a
 * shape that contradict it), all applied at once by POST /edit/quickfix/apply-safe. The server decides what it
 * repairs and says it beforehand (GET /edit/quickfix/safe, the same answer as the apply's, nothing written): the
 * report's button announces that count, never the report's own totals. The list below only names the rules the report
 * asks the server about, and safeRepairs.test.js holds it equal to the server's SAFE_REPAIRS.
 */

import { useEffect, useState } from "react";
import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";
import { useEditMode } from "../contexts/EditModeContext";
import { countWords } from "./countWords";

export const SAFE_REPAIR_RULES = Object.freeze([
  "leading_or_trailing_whitespaces",
  "invalid_url",
  "invalid_color",
  "invalid_timezone",
  "same_name_and_description_for_route",
  "same_name_and_description_for_stop",
  "same_route_and_agency_url",
  "same_stop_and_agency_url",
  "same_stop_and_route_url",
  "decreasing_or_equal_stop_time_distance",
  "trip_distance_exceeds_shape_distance",
  "decreasing_shape_distance",
  "equal_shape_distance_diff_coordinates",
]);

const SAFE = new Set(SAFE_REPAIR_RULES);

/**
 * The safe rules a report holds a finding of, the rows kept aside and what the import settled left out: what the
 * announcement and the apply keep to, so that nothing is repaired under a rule the report does not show.
 */
export const safeRulesOf = (findings) => [...new Set((findings || []).filter((f) => f && SAFE.has(f.ruleCode) && !f.resolvedByImport && !f.asideId).map((f) => f.ruleCode))].sort();

const NOTHING = Object.freeze({ applied: 0, rules: Object.freeze({}), left: Object.freeze([]), distances: null });

const outcomeOf = (body) => (body && typeof body === "object" ? { ...body, applied: Number(body.applied) || 0, rules: body.rules || {}, left: Array.isArray(body.left) ? body.left : [] } : NOTHING);

/** What the safe repairs of these rules would do on the open network, nothing written. */
export async function fetchSafePlan(rules) {
  const res = await fetchWithSession(`${API_BASE_URL}/edit/quickfix/safe?rules=${encodeURIComponent(rules.join(","))}`);
  if (!res.ok) return NOTHING;
  return outcomeOf(await res.json().catch(() => null));
}

/**
 * { plan, pending } for the rules a report holds: the plan is what a click would do now ({ applied, rules, left }),
 * read again after every edit; `pending` while it is not known yet, so the screen announces nothing in the meantime.
 */
export function useSafePlan(rules) {
  const { dataVersion } = useEditMode();
  const key = rules.join(",");
  const [state, setState] = useState({ at: null, plan: NOTHING });
  const at = `${key}@${dataVersion}`;
  useEffect(() => {
    if (!key) return undefined;
    let alive = true;
    fetchSafePlan(key.split(","))
      .then((plan) => alive && setState({ at, plan }))
      .catch(() => alive && setState({ at, plan: NOTHING }));
    return () => {
      alive = false;
    };
  }, [key, at]);
  if (!key) return { plan: NOTHING, pending: false };
  return state.at === at ? { plan: state.plan, pending: false } : { plan: NOTHING, pending: true };
}

// Left for want of a value to write; the other reasons are the distances', said by trip and by shape.
const VALUE_REASONS = new Set(["no_safe_value", "required", "refused"]);

/**
 * What the safe repairs did, in the person's words: `done`, the corrections with the rules they settled, and `notes`,
 * one sentence each for the distances cleared, the values left to fix by hand with their rules, the trips and the
 * shapes that keep their distances.
 */
export const safeOutcomeWords = (t, body, titleOf) => {
  const outcome = outcomeOf(body);
  const named = (counts) =>
    Object.entries(counts)
      .map(([rule, n]) => `${titleOf(rule)} (${n})`)
      .join(", ");
  const values = {};
  for (const l of outcome.left) if (VALUE_REASONS.has(l.reason)) values[l.rule] = (values[l.rule] || 0) + (Number(l.count) || 0);
  const leftValues = Object.values(values).reduce((n, k) => n + k, 0);
  const distances = outcome.distances || {};
  const cleared = Number(distances.cleared_values) || 0;
  const leftTrips = Object.values(distances.skipped || {}).reduce((n, k) => n + (Number(k) || 0), 0);
  const leftShapes = Number(distances.shapes_left) || 0;
  return {
    applied: outcome.applied,
    done: outcome.applied > 0 ? countWords(t, "validation.safe.done", outcome.applied, { count: outcome.applied, rules: named(outcome.rules) }) : null,
    notes: [
      cleared > 0 ? countWords(t, "validation.safe.cleared", cleared, { count: cleared }) : null,
      leftValues > 0 ? countWords(t, "validation.safe.leftValues", leftValues, { count: leftValues, rules: named(values) }) : null,
      leftTrips > 0 ? countWords(t, "validation.safe.left", leftTrips, { count: leftTrips }) : null,
      leftShapes > 0 ? countWords(t, "validation.safe.leftShapes", leftShapes, { count: leftShapes }) : null,
    ].filter(Boolean),
  };
};
