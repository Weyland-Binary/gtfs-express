/**
 * acknowledgement — the named record of what a person accepts at a delivery
 * (G4): a must clause failing or not measurable, a source the engine could not
 * verify, an assumption of a build, the reference feed's own errors, and the
 * person's one decision on a change (the direct mode's review report, a change
 * made by hand). Nothing is acknowledged anonymously; the record names who,
 * what and when (server clock).
 *
 *   NAME_OK(s)                    2–120 characters with at least one letter
 *   parse(raw, req = null)        the request's `acknowledge` → null when absent,
 *                                 { by: { name, user_id }, clauses: Set, sources: bool,
 *                                 assumptions: Set, baseline_errors: bool, changes: bool,
 *                                 direct: bool, hand: bool, note } — 400
 *                                 INVALID_INPUT when it is not an object, 400
 *                                 ACKNOWLEDGEMENT_UNNAMED when it acknowledges anything
 *                                 without a name (by.name, else the signed-in account's
 *                                 display_name). `validation` is ignored: a NEW validator
 *                                 error is never acknowledgeable; `baseline_errors: true`
 *                                 accepts the errors the client's reference feed already
 *                                 carried (accepted by name, never silently); `direct: true` is
 *                                 the direct mode's one decision: the person delivers the
 *                                 review report as it was shown (engine.markDirect);
 *                                 `hand: true` the decision on a change made by hand: the
 *                                 person applies it as its steps list it, under their name.
 *   recordOf(parsed, items, scope) → null when nothing is acknowledged; else
 *                                 { id, by: { name, user_id }, at, scope, clauses: [ids],
 *                                 items, note } with scope commit | compile | approve | waive
 *                                 and items of kinds
 *                                   { kind: 'clause', id, status: 'fail' | 'unknown', text, expected, measured, note }
 *                                   { kind: 'sources', operations: [{ id, reason }] }
 *                                   { kind: 'assumption', id, text }
 *                                   { kind: 'baseline_errors', errors, rules: { ruleCode: count } }
 *                                   { kind: 'changes_not_asked', changes: [{ route, label, count, from, to, dates } | { table, what, rows, columns?, examples }] | error }
 *                                   { kind: 'simplified_baseline', losses }
 *                                   { kind: 'direct_report', preview_id, report: { demands, not_asked, … }, facts }
 *                                   { kind: 'hand_decision', title, operations }
 *   actorOf(req)                  → { user_id, name } of the signed-in account (nulls otherwise)
 *   describe(record)              → 'acknowledged by NAME: clauses c3 (fail), hop (unknown);
 *                                 sources op2 (pdf); assumptions a1' (≤ 400 characters),
 *                                 appended to the edit description
 *   record({ db, editId, record, session, req })  writes the row next to the edit
 *                                 (_editCore.logAcknowledgement) when a db is given and
 *                                 records the event acknowledgement.recorded: the id, the
 *                                 scope, the user id, a keyed hash of the name (never the
 *                                 plain name nor the clause texts) and the item kinds/ids
 *   mustItems(conformance)        the must clauses failing or not measurable, as clause
 *                                 items (judge.unmetMust: the single
 *                                 definition of "not met")
 */

"use strict";

const crypto = require("crypto");
const { refusal } = require("./refusal");
const eventLogger = require("./eventLogger");

// As many clause ids as a contract may hold (judge.MAX_CLAUSES: a brief's sheets state dozens per line),
// so that every clause not met can be accepted by name — never a delivery nobody can acknowledge.
const MAX_CLAUSES = 240;
// More than a build may list (contractService.pendingAssumptionsOf: the contract's assumptions, the wishes nobody
// checked) — every one of them is accepted by name, never the first forty.
const MAX_ASSUMPTIONS = 2000;
const MAX_NOTE = 400;
const SCOPES = ["commit", "compile", "approve", "waive"];

const NAME_OK = (s) => typeof s === "string" && s.trim().length >= 2 && s.trim().length <= 120 && /\p{L}/u.test(s);

const idSet = (list, max) => new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()).slice(0, max));

const SHAPE = "acknowledge must be { by: { name }, clauses?: [ids], sources?: true, assumptions?: [ids], baseline_errors?: true, changes?: true, direct?: true, hand?: true, note? }";

const parse = (raw, req = null) => {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw refusal(400, "INVALID_INPUT", SHAPE);
  if ((raw.clauses != null && !Array.isArray(raw.clauses)) || (raw.assumptions != null && !Array.isArray(raw.assumptions))) throw refusal(400, "INVALID_INPUT", SHAPE);
  const typed = raw.by && typeof raw.by === "object" ? raw.by.name : null;
  const by = { name: NAME_OK(typed) ? typed.trim() : req?.user?.display_name || null, user_id: req?.user?.id || null };
  const clauses = idSet(raw.clauses, MAX_CLAUSES);
  const assumptions = idSet(raw.assumptions, MAX_ASSUMPTIONS);
  const sources = raw.sources === true;
  const baselineErrors = raw.baseline_errors === true;
  // The change accounting's finding (lines changed on dates, rows of a table, that no clause of the plan asks for) is
  // accepted as one, by name.
  const changes = raw.changes === true;
  // The direct mode's one decision: the review report delivered as shown, whatever it says is done, not done or unproven.
  const direct = raw.direct === true;
  // The decision on a change made by hand: applied as its steps list it, under the person's name.
  const hand = raw.hand === true;
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, MAX_NOTE) : null;
  if ((clauses.size || sources || assumptions.size || baselineErrors || changes || direct || hand) && !NAME_OK(by.name)) throw refusal(400, "ACKNOWLEDGEMENT_UNNAMED", "An acknowledgement names the person who accepts it (acknowledge.by.name, 2–120 characters).", { required: ["by.name"] });
  return { by, clauses, sources, assumptions, baseline_errors: baselineErrors, changes, direct, hand, note };
};

const recordOf = (parsed, items, scope) => {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return null;
  if (!SCOPES.includes(scope)) throw new Error(`acknowledgement scope must be one of ${SCOPES.join(", ")}`);
  // Belt and braces: the gate checked the name before; a record is never anonymous.
  if (!NAME_OK(parsed?.by?.name)) throw refusal(400, "ACKNOWLEDGEMENT_UNNAMED", "An acknowledgement names the person who accepts it (acknowledge.by.name, 2–120 characters).", { required: ["by.name"] });
  return {
    id: crypto.randomBytes(9).toString("hex"),
    by: { name: parsed.by.name.trim(), user_id: parsed.by.user_id || null },
    at: new Date().toISOString(),
    scope,
    clauses: list.filter((i) => i.kind === "clause").map((i) => i.id),
    items: list,
    note: parsed.note || null,
  };
};

const actorOf = (req) => ({ user_id: req?.user?.id || null, name: req?.user?.display_name || null });

// The change accounting's items as the edit says them: the lines, then the tables' rows.
const notAskedText = (changes) => {
  const lines = changes.filter((c) => !c.table).length;
  const tables = changes.filter((c) => c.table);
  return [lines || !tables.length ? `changes not asked on ${lines} line(s)` : null, tables.length ? `rows not asked in ${[...new Set(tables.map((c) => c.table))].join(", ")}` : null].filter(Boolean).join(", ");
};

// The review report as the edit says it: how many demands it found done, not done and unproven, and the changes not asked.
const directText = (report) => {
  const demands = Array.isArray(report?.demands) ? report.demands : [];
  const n = (s) => demands.filter((d) => d && d.status === s).length;
  const notAsked = Array.isArray(report?.not_asked) ? report.not_asked.length : 0;
  return `the review report as shown (${n("done")} done, ${n("not_done")} not done, ${n("unproven")} unproven, ${notAsked} not asked)`;
};

const describe = (record) => {
  if (!record) return "";
  const clauses = record.items.filter((i) => i.kind === "clause").map((i) => `${i.id} (${i.status})`);
  const sources = record.items.filter((i) => i.kind === "sources").flatMap((i) => (i.operations || []).map((o) => `${o.id} (${o.reason})`));
  const assumptions = record.items.filter((i) => i.kind === "assumption").map((i) => i.id);
  const baseline = record.items.find((i) => i.kind === "baseline_errors");
  const simplified = record.items.some((i) => i.kind === "simplified_baseline");
  const changes = record.items.find((i) => i.kind === "changes_not_asked");
  const direct = record.items.find((i) => i.kind === "direct_report");
  const hand = record.items.find((i) => i.kind === "hand_decision");
  const parts = [direct ? directText(direct.report) : null, hand ? `the change by hand as listed (${Number(hand.operations) || 0} step(s))` : null, clauses.length ? `clauses ${clauses.join(", ")}` : null, sources.length ? `sources ${sources.join(", ")}` : null, assumptions.length ? `assumptions ${assumptions.join(", ")}` : null, baseline ? `${Number(baseline.errors) || 0} error(s) of the reference feed` : null, simplified ? "a simplified baseline" : null, changes ? (Array.isArray(changes.changes) ? notAskedText(changes.changes) : "change accounting not run") : null].filter(Boolean);
  return `acknowledged by ${record.by.name}: ${parts.join("; ")}`.slice(0, MAX_NOTE);
};

const record = ({ db = null, editId = null, record: rec, session = null, req = null } = {}) => {
  if (!rec) return null;
  if (db) require("./edit/_editCore").logAcknowledgement(db, { editId, record: rec });
  eventLogger.recordEvent("acknowledgement.recorded", {
    ...(req ? eventLogger.extractReqMeta(req) : {}),
    ...(session ? { session } : {}),
    ack_id: rec.id,
    scope: rec.scope,
    by_user_id: rec.by.user_id || null,
    by_hash: eventLogger.hashIp(rec.by.name.toLowerCase()),
    items: rec.items.map(({ kind, id, status }) => ({ kind, ...(id ? { id } : {}), ...(status ? { status } : {}) })),
  });
  return rec;
};

// Lazy: the judge (judge/clauseModel) reads NAME_OK from here for the named decisions of a clause.
const mustItems = (conformance) => require("./judge").unmetMust(conformance);

module.exports = { NAME_OK, parse, recordOf, actorOf, describe, record, mustItems, SCOPES };
