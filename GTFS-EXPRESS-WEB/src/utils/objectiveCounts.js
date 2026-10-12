/**
 * objectiveCounts — the one count ③ and ④ give of a simulation's measure.
 *
 * The owner's test of 2026-10-07 read, on one delivery page, « 14 objectifs
 * tenus sur 22 · 3 à mesurer » (the verdict's tile: every must clause, the
 * default guarantees in) beside « 10 objectifs tenus sur 14 » and
 * « Garanties par défaut : 3 non tenues » (the recap: every unchanged_except
 * clause counted as a default guarantee, the brief's own « le sens vers …
 * n'est pas modifié » among them). Every place that counts the
 * objectives of a change now reads this module, the same way:
 *
 *   GUARANTEE_IDS              the two default guarantees a modification starts with (utils/contract.unchangedClauses,
 *                              the server's unchangedClauses.DERIVED): the rest of the network, the rest of the day
 *   isGuarantee(clause|result) one of them: by its id, or by `params.derive` (a clause of ② before it is measured) —
 *                              never by its kind: a requirement of the brief that keeps something unchanged
 *                              (unchanged_except too) is the person's objective, counted with the others
 *   objectiveCounts(results)   the server's results (preview.conformance.after.results) — one the person set aside
 *                              (waived) left out — as { objectives, desired, guarantees }, each { total, pass, fail,
 *                              unknown }; null before any measure:
 *       objectives   the person's mandatory clauses (level "must", every one that is no default guarantee)
 *       desired      the person's desired clauses (level "should": ② says them « souhaitées »), null when there is
 *                    none — never among the objectives: the server's `conforms`, the delivery's gate and the list a
 *                    person accepts at ④ read the mandatory ones only, so a desired clause is never a gap to accept
 *       guarantees   the default guarantees, mandatory, null when none was measured (one the person made desired at ②
 *                    is a desired clause, as the server counts it); its `ids` say which were measured
 *     Together they are exactly the server's own counts by level (services/verdict.verdictOf: must, should).
 *   objectiveResults(results)  the same three as lists (what ③'s progress lists, row by row)
 *   guaranteesSaid(guarantees) → { key, params }: the guarantees' line of ③ and ④ — the ones held named by what they
 *                              keep (the rest of the network, the rest of the day), only those measured: one the
 *                              person made desired or set aside at ② is never said held (the owner's test of
 *                              2026-10-07 read « le reste du réseau et le reste de la journée sont inchangés » with
 *                              only the network measured); a count when the measured ones cannot be told
 *   countsAgree(counts, verdict)
 *                              those counts are that verdict's: their objectives and guarantees add up to its must,
 *                              their desired clauses are its should, and their objectives are its own split
 *                              (`verdict.objectives`, sent when a default guarantee is measured; its must when none
 *                              is) — counted from the results it was counted from: a turn's card never says a split
 *                              that contradicts the verdict it stands beside (one the planner measured without the
 *                              page seeing it, the same totals split otherwise)
 *
 * Nothing here judges: the results are the server's, only counted. No import:
 * the change's parts (ChangePlanParts) and the journey's helpers (autopilot)
 * both read it without depending on each other.
 */

export const GUARANTEE_IDS = Object.freeze(["other_lines_unchanged", "rest_of_the_day_unchanged"]);

export const isGuarantee = (r) => Boolean(r && typeof r === "object" && (GUARANTEE_IDS.includes(r.id) || (r.params && typeof r.params === "object" && r.params.derive)));

// Which default guarantee a result is: its id, or the one its derivation names (the server's unchangedClauses.DERIVED).
const DERIVED = Object.freeze({ other_lines: "other_lines_unchanged", rest_of_day: "rest_of_the_day_unchanged" });
const guaranteeId = (r) => (GUARANTEE_IDS.includes(r.id) ? r.id : DERIVED[r.params?.derive] || null);

// The verdicts of a list of results, counted: anything but a pass or a fail is not measurable yet.
const tally = (list) => ({ total: list.length, pass: list.filter((r) => r.status === "pass").length, fail: list.filter((r) => r.status === "fail").length, unknown: list.filter((r) => r.status !== "pass" && r.status !== "fail").length });
// A desired clause (level "should"); the server's clauses are mandatory unless they say so (conformanceService).
const desired = (r) => r.level === "should";

/**
 * The results themselves, sorted as they are counted: { objectives, desired, guarantees } (lists; a waived one in
 * none) — what ObjectivesProgress lists, so that its rows are the very ones its count counts. Read on the contract's
 * clauses before any measure (their statuses aside), it says how many each list will hold.
 */
export const objectiveResults = (results) => {
  if (!Array.isArray(results)) return null;
  const measured = results.filter((r) => r && typeof r === "object" && r.status !== "waived");
  const must = measured.filter((r) => !desired(r));
  return { objectives: must.filter((r) => !isGuarantee(r)), desired: measured.filter(desired), guarantees: must.filter(isGuarantee) };
};

export const objectiveCounts = (results) => {
  const lists = objectiveResults(results);
  if (!lists) return null;
  return { objectives: tally(lists.objectives), desired: lists.desired.length ? tally(lists.desired) : null, guarantees: lists.guarantees.length ? { ...tally(lists.guarantees), ids: lists.guarantees.map(guaranteeId) } : null };
};

// The sentence that names one guarantee held, by its id.
const HELD_ONE = Object.freeze({ other_lines_unchanged: "autopilot.line.guarantees.network", rest_of_the_day_unchanged: "autopilot.line.guarantees.day" });

/** The guarantees' line (see the header): a failure or a measure missing first, as before; then what was held. */
export const guaranteesSaid = (g) => {
  if (!g || !g.total) return null;
  if (g.fail) return { key: "autopilot.line.guarantees.fail", params: { count: g.fail } };
  if (g.pass !== g.total) return { key: "autopilot.line.guarantees.unknown", params: { count: g.unknown } };
  // Both named only when both were measured (a count without ids: the two there are, each once).
  const ids = Array.isArray(g.ids) ? g.ids : null;
  const both = ids ? ids.length === 2 && GUARANTEE_IDS.every((id) => ids.includes(id)) : g.total === 2;
  if (both) return { key: "autopilot.line.guarantees", params: {} };
  if (ids && ids.length === 1 && HELD_ONE[ids[0]]) return { key: HELD_ONE[ids[0]], params: {} };
  return { key: "autopilot.line.guarantees.count", params: { pass: g.pass, total: g.total } };
};

const sameTally = (a, b) => ["total", "pass", "fail", "unknown"].every((k) => (Number(a?.[k]) || 0) === (Number(b?.[k]) || 0));
const plus = (a, b) => ({ total: (a?.total || 0) + (b?.total || 0), pass: (a?.pass || 0) + (b?.pass || 0), fail: (a?.fail || 0) + (b?.fail || 0), unknown: (a?.unknown || 0) + (b?.unknown || 0) });

export const countsAgree = (counts, verdict) => {
  if (!(counts && counts.objectives && verdict && typeof verdict === "object" && verdict.must)) return false;
  if (!sameTally(plus(counts.objectives, counts.guarantees), verdict.must) || !sameTally(counts.desired, verdict.should)) return false;
  // The split too: the same totals measured on another plan may hold another guarantee and miss another objective.
  // A verdict that measured no default guarantee sends no split of its own: its must are all objectives then.
  const split = verdict.objectives && typeof verdict.objectives === "object" ? verdict.objectives : verdict.must;
  return sameTally(counts.objectives, split);
};
