/**
 * gate — what stands between a previewed plan and "Apply".
 *
 * The server's preview carries `gate` (transform/engine.gateOf): what BLOCKS
 * — steps blocked or failed, broken integrity, no canonical validator on
 * this server, new errors of the validator; none of it can be overridden —
 * and what a NAMED person may accept knowingly — must clauses not met
 * (clauses_failing) or not measurable (clauses_unknown), operations whose
 * quotes the engine could not find (sources_unverified), assumptions of the
 * plan (assumptions_unvalidated), and — since the owner's rule of
 * 2026-10-05 — the errors the client's reference GTFS already carried
 * (baseline_errors { errors, rules }: accepted by name, never silently).
 * Requirements of the brief answered by no
 * clause of the contract (requirements_uncovered, G5) block too: they are
 * answered at ② (a clause, « à vérifier à la main », a named dismissal),
 * never here; so does a plan simulated on a Studio project's copy without a
 * ready contract (contract_required { reason: missing | draft | unnamed }:
 * decided, assumed or recorded empty by a named person at ②). A NEW
 * validator error is never acceptable:
 * it is fixed in the change. A preview without `gate` (an older server): the
 * same gate is derived from its steps, integrity, conformance and
 * validation, new errors on the blocking side.
 *
 *   gateOf(preview)            → { can_commit, blocking, acknowledgeable, validation, derived } | null
 *   blockedSteps(preview)      → the steps waiting for an answer or failed
 *   gateIntegrity(gate, preview) / gateClauses(gate) / gateNewErrors(gate) / gateValidatorOff(gate) / gateUncovered(gate)
 *   gateContractRequired(gate) → the reason the contract holds the plan (missing | draft | unnamed) or null
 *   gateBaselineErrors(gate)   → { errors, rules } of the reference GTFS still carried, or null
 *   planStatus({ plan, preview, previewing }) → { key, params, tone } — the status line, in its order:
 *                                no ready contract → blocked → integrity → new validator errors → no
 *                                validator → requirements without a clause (G5) → clauses to
 *                                accept → no change → ready. What blocks comes before what a name can
 *                                accept: a plan with a failing clause AND new errors says the errors
 *                                (no acknowledgement unlocks it), a plan on a server without the
 *                                validator never reads "Ready".
 *
 * The acknowledgement itself (the items, the name, the body sent to POST
 * /transform/commit) is common/AcknowledgementForm's.
 */

export const blockedSteps = (preview) => (preview?.steps || []).filter((s) => s.status === "blocked" || s.status === "failed");

export const gateOf = (preview) => {
  if (!preview) return null;
  const g = preview.gate;
  if (g && typeof g === "object" && (Array.isArray(g.blocking) || Array.isArray(g.acknowledgeable))) {
    const blocking = Array.isArray(g.blocking) ? [...g.blocking] : [];
    // An older server listed new validator errors as acceptable: they block, whatever it said.
    const acknowledgeable = (Array.isArray(g.acknowledgeable) ? g.acknowledgeable : []).filter((a) => {
      if (a && a.code === "validation_new_errors") {
        if (!blocking.some((b) => b.code === "validation_new_errors")) blocking.push(a);
        return false;
      }
      return true;
    });
    return { can_commit: g.can_commit !== undefined ? Boolean(g.can_commit) && !blocking.length : !blocking.length, blocking, acknowledgeable, validation: g.validation || "not_run", derived: false };
  }
  const blocking = [];
  const stuck = blockedSteps(preview);
  if (stuck.length || preview.blocked) blocking.push({ code: "blocked_steps", steps: stuck.map((s) => s.id) });
  if ((preview.integrity || []).length) blocking.push({ code: "integrity", integrity: preview.integrity });
  const v = preview.validation;
  const newErrors = v && !v.error ? v.new_errors || [] : [];
  if (newErrors.length) blocking.push({ code: "validation_new_errors", new_errors: newErrors });
  const acknowledgeable = [];
  const unmet = (status) => (preview.conformance?.after?.results || []).filter((r) => r.level === "must" && r.status === status).map((r) => ({ id: r.id, kind: r.kind, status, text: r.text, expected: r.expected, measured: r.measured, note: r.note }));
  if (unmet("fail").length) acknowledgeable.push({ code: "clauses_failing", clauses: unmet("fail") });
  if (unmet("unknown").length) acknowledgeable.push({ code: "clauses_unknown", clauses: unmet("unknown") });
  const validation = !v ? "not_run" : v.error ? "unavailable" : newErrors.length ? "new_errors" : "passed";
  return { can_commit: !blocking.length, blocking, acknowledgeable, validation, derived: true };
};

const itemOf = (list, code) => (list || []).find((x) => x && x.code === code) || null;

export const gateIntegrity = (gate, preview = null) => {
  const item = itemOf(gate?.blocking, "integrity");
  if (!item) return [];
  const list = item.integrity || item.problems || item.items || preview?.integrity || [];
  return Array.isArray(list) ? list : [];
};
/** The must clauses to accept: not met, then not measurable. */
export const gateClauses = (gate) => [...(itemOf(gate?.acknowledgeable, "clauses_failing")?.clauses || []), ...(itemOf(gate?.acknowledgeable, "clauses_unknown")?.clauses || [])];
export const gateNewErrors = (gate) => itemOf(gate?.blocking, "validation_new_errors")?.new_errors || [];
export const gateValidatorOff = (gate) => Boolean(itemOf(gate?.blocking, "validator_unavailable"));
export const gateBlockedSteps = (gate) => Boolean(itemOf(gate?.blocking, "blocked_steps"));
/** The requirement sentences of the brief no clause answers (G5): { id, text }[]. */
export const gateUncovered = (gate) => itemOf(gate?.blocking, "requirements_uncovered")?.sentences || [];
/** Why the contract holds the plan (2026-10-05): "missing" | "draft" | "unnamed", or null when it does not. */
export const gateContractRequired = (gate) => {
  const item = itemOf(gate?.blocking, "contract_required");
  return item ? item.reason || "missing" : null;
};
/** The errors the reference GTFS already carried, still there after the plan: { errors, rules } to accept by name, or null. */
export const gateBaselineErrors = (gate) => {
  const item = itemOf(gate?.acknowledgeable, "baseline_errors");
  return item ? { errors: Number(item.errors) || 0, rules: item.rules && typeof item.rules === "object" ? item.rules : {} } : null;
};

/** The status line: the first thing that stands between the plan and "Apply", in plain words. */
export const planStatus = ({ plan, preview, previewing }) => {
  if (!plan?.operations?.length) return { key: "transform.emptyPlan", tone: "info" };
  if (previewing) return { key: "transform.previewing", tone: "info" };
  if (!preview) return { key: "transform.noPreview", tone: "info" };
  const gate = gateOf(preview);
  // No ready contract on a Studio project's copy: ② first, whatever else the plan says (nothing is applied before).
  if (gateContractRequired(gate)) return { key: "transform.status.contractRequired", params: { reason: gateContractRequired(gate) }, tone: "warning" };
  const steps = preview.steps || [];
  const blocked = steps.filter((s) => s.status === "blocked").length;
  const failed = steps.filter((s) => s.status === "failed").length;
  if (blocked) return { key: "transform.blocked", params: { count: blocked }, tone: "warning" };
  if (failed || gateBlockedSteps(gate)) return { key: "transform.failedSteps", params: { count: failed || 1 }, tone: "error" };
  if (itemOf(gate?.blocking, "integrity")) return { key: "transform.integrityProblems", tone: "error" };
  // A validator error is fixed in the change, never accepted: the sentence says so.
  const errors = gateNewErrors(gate).length;
  if (errors) return { key: "transform.status.validatorErrors", params: { count: errors }, tone: "error" };
  if (gateValidatorOff(gate)) return { key: "gtfsCheck.unavailable", tone: "error" };
  const uncovered = gateUncovered(gate).length;
  if (uncovered) return { key: "transform.status.uncovered", params: { count: uncovered }, tone: "warning" };
  // The must clauses to accept: « non tenues » once one fails; only not measurable, « à confirmer ».
  const clauses = gateClauses(gate).length;
  const failing = (itemOf(gate?.acknowledgeable, "clauses_failing")?.clauses || []).length;
  if (clauses) return { key: failing ? "transform.clausesFailing" : "transform.clausesUnknown", params: { count: clauses }, tone: "warning" };
  // The reference GTFS's own errors: accepted by name at the application, never « Ready » unsaid.
  const baseline = gateBaselineErrors(gate);
  if (baseline) return { key: "transform.status.baselineErrors", params: { count: baseline.errors }, tone: "warning" };
  if (preview.empty) return { key: "transform.noChanges", tone: "info" };
  return { key: "transform.ready", tone: "success" };
};
