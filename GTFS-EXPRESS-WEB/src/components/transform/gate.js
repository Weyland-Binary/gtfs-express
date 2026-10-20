/**
 * gate — what stands between a previewed plan and "Apply".
 *
 * The server's preview carries `gate` (transform/engine.gateOf): what BLOCKS
 * — steps blocked or failed, broken integrity, no canonical validator on
 * this server, new errors of the validator; none of it can be overridden —
 * and what a NAMED person may accept knowingly — the plan's must clauses not
 * met (clauses_failing) or not measurable (clauses_unknown: a plan the chat
 * proposed carries its own), operations whose quotes the engine could not
 * find (sources_unverified), the errors the client's reference GTFS already
 * carried (baseline_errors { errors, rules }: accepted by name, never
 * silently), and the lines and dates the plan changes, or the rows of a table
 * it writes, that no clause of the plan asks for (changes_not_asked
 * { changes: [{ route, label, count, from, to } | { table, what, rows, columns?,
 * examples }] }, or { error } when the accounting could not run: accepted by
 * name). A NEW validator error is never acceptable: it is fixed in the change.
 * A preview without `gate` (an older server): the same gate is derived from
 * its steps, integrity, conformance and validation, new errors on the
 * blocking side.
 *
 *   gateOf(preview)            → { can_commit, blocking, acknowledgeable, validation, derived } | null
 *   blockedSteps(preview)      → the steps waiting for an answer or failed
 *   gateIntegrity(gate, preview) / gateClauses(gate) / gateNewErrors(gate) / gateValidatorOff(gate)
 *   gateBaselineErrors(gate)   → { errors, rules } of the reference GTFS still carried, or null
 *   gateChangesNotAsked(gate)  → the changes no clause of the plan asks for ([{ route, label, count, from, to } | { table, what, rows, columns, examples }], [] when the accounting could not run), or null
 *   planStatus({ plan, preview, previewing }) → { key, params, tone } — the status line, in its order:
 *                                blocked → integrity → new validator errors → no validator → clauses
 *                                to accept → the reference's errors → changes not asked → no change →
 *                                ready. What blocks comes before what a name can
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
    // An older server may list new validator errors as acceptable: they block, whatever it says.
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
/** The errors the reference GTFS already carried, still there after the plan: { errors, rules } to accept by name, or null. */
export const gateBaselineErrors = (gate) => {
  const item = itemOf(gate?.acknowledgeable, "baseline_errors");
  return item ? { errors: Number(item.errors) || 0, rules: item.rules && typeof item.rules === "object" ? item.rules : {} } : null;
};

/** The lines and dates changed, and the tables' rows written, that no clause of the plan asks for ([] when the accounting could not run), or null when none. */
export const gateChangesNotAsked = (gate) => {
  const item = itemOf(gate?.acknowledgeable, "changes_not_asked");
  return item ? (Array.isArray(item.changes) ? item.changes : []) : null;
};

/** The status line: the first thing that stands between the plan and "Apply", in plain words. */
export const planStatus = ({ plan, preview, previewing }) => {
  if (!plan?.operations?.length) return { key: "transform.emptyPlan", tone: "info" };
  if (previewing) return { key: "transform.previewing", tone: "info" };
  if (!preview) return { key: "transform.noPreview", tone: "info" };
  const gate = gateOf(preview);
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
  // The must clauses to accept: « non tenues » once one fails; only not measurable, « à confirmer ».
  const clauses = gateClauses(gate).length;
  const failing = (itemOf(gate?.acknowledgeable, "clauses_failing")?.clauses || []).length;
  if (clauses) return { key: failing ? "transform.clausesFailing" : "transform.clausesUnknown", params: { count: clauses }, tone: "warning" };
  // The reference GTFS's own errors: accepted by name at the application, never « Ready » unsaid.
  const baseline = gateBaselineErrors(gate);
  if (baseline) return { key: "transform.status.baselineErrors", params: { count: baseline.errors }, tone: "warning" };
  // The lines the plan changes on dates, the rows it writes, that no clause of the plan asks for: accepted by name at the application.
  const changes = gateChangesNotAsked(gate);
  const changedLines = (changes || []).filter((c) => !c?.table).length;
  if (changes && !changedLines && changes.length) return { key: "transform.status.rowsNotAsked", params: { count: changes.length }, tone: "warning" };
  if (changes) return { key: "transform.status.changesNotAsked", params: { count: changedLines || 1 }, tone: "warning" };
  if (preview.empty) return { key: "transform.noChanges", tone: "info" };
  return { key: "transform.ready", tone: "success" };
};
