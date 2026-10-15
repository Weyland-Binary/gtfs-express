/**
 * acknowledgement — the named record of what a person accepts when a delivery
 * does not meet the brief (G4): a must clause failing or not measurable, a
 * source the engine could not verify, an assumption of the plan. Nothing is
 * acknowledged anonymously; the record names who, what and when (server clock).
 *
 *   NAME_OK(s)                    2–120 characters with at least one letter
 *   parse(raw, req = null)        the request's `acknowledge` → null when absent,
 *                                 { by: { name, user_id }, clauses: Set, sources: bool,
 *                                 assumptions: Set, baseline_errors: bool, note } — 400
 *                                 INVALID_INPUT when it is not an object, 400
 *                                 ACKNOWLEDGEMENT_UNNAMED when it acknowledges anything
 *                                 without a name (by.name, else the signed-in account's
 *                                 display_name). `validation` is ignored: a NEW validator
 *                                 error is never acknowledgeable; `baseline_errors: true`
 *                                 accepts the errors the client's reference feed already
 *                                 carried (accepted by name, never silently).
 *   recordOf(parsed, items, scope) → null when nothing is acknowledged; else
 *                                 { id, by: { name, user_id }, at, scope, clauses: [ids],
 *                                 items, note } with scope commit | compile | approve | waive
 *                                 and items of kinds
 *                                   { kind: 'clause', id, status: 'fail' | 'unknown', text, expected, measured, note }
 *                                   { kind: 'sources', operations: [{ id, reason }] }
 *                                   { kind: 'assumption', id, text }
 *                                   { kind: 'baseline_errors', errors, rules: { ruleCode: count } }
 *                                   { kind: 'changes_not_asked', changes: [{ route, label, count, from, to, dates }] | error }
 *                                   { kind: 'simplified_baseline', losses }
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
 *                                 items (conformanceService.unmetMust: the single
 *                                 definition of "not met")
 */

"use strict";

const crypto = require("crypto");
const { refusal } = require("./refusal");
const eventLogger = require("./eventLogger");

// As many clause ids as a contract may hold (conformanceService.MAX_CLAUSES: a brief's sheets state dozens per line),
// so that every clause not met can be accepted by name — never a delivery nobody can acknowledge.
const MAX_CLAUSES = 240;
// As many as the gate may list (engine.pendingAssumptions: the plan's assumptions, the answers the engine took by
// itself, the contract's wishes nobody checked) — every one of them is accepted by name, never the first forty.
const MAX_ASSUMPTIONS = 2000;
const MAX_NOTE = 400;
const SCOPES = ["commit", "compile", "approve", "waive"];

const NAME_OK = (s) => typeof s === "string" && s.trim().length >= 2 && s.trim().length <= 120 && /\p{L}/u.test(s);

const idSet = (list, max) => new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()).slice(0, max));

const SHAPE = "acknowledge must be { by: { name }, clauses?: [ids], sources?: true, assumptions?: [ids], baseline_errors?: true, changes?: true, note? }";

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
  // The change accounting's finding (lines changed on dates no objective asks for) is accepted as one, by name.
  const changes = raw.changes === true;
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, MAX_NOTE) : null;
  if ((clauses.size || sources || assumptions.size || baselineErrors || changes) && !NAME_OK(by.name)) throw refusal(400, "ACKNOWLEDGEMENT_UNNAMED", "An acknowledgement names the person who accepts it (acknowledge.by.name, 2–120 characters).", { required: ["by.name"] });
  return { by, clauses, sources, assumptions, baseline_errors: baselineErrors, changes, note };
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

const describe = (record) => {
  if (!record) return "";
  const clauses = record.items.filter((i) => i.kind === "clause").map((i) => `${i.id} (${i.status})`);
  const sources = record.items.filter((i) => i.kind === "sources").flatMap((i) => (i.operations || []).map((o) => `${o.id} (${o.reason})`));
  const assumptions = record.items.filter((i) => i.kind === "assumption").map((i) => i.id);
  const baseline = record.items.find((i) => i.kind === "baseline_errors");
  const simplified = record.items.some((i) => i.kind === "simplified_baseline");
  const changes = record.items.find((i) => i.kind === "changes_not_asked");
  const parts = [clauses.length ? `clauses ${clauses.join(", ")}` : null, sources.length ? `sources ${sources.join(", ")}` : null, assumptions.length ? `assumptions ${assumptions.join(", ")}` : null, baseline ? `${Number(baseline.errors) || 0} error(s) of the reference feed` : null, simplified ? "a simplified baseline" : null, changes ? (Array.isArray(changes.changes) ? `changes not asked on ${changes.changes.length} line(s)` : "change accounting not run") : null].filter(Boolean);
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

// Lazy: conformanceService reads NAME_OK from here for the named decisions of a clause.
const mustItems = (conformance) => require("./network/conformanceService").unmetMust(conformance);

module.exports = { NAME_OK, parse, recordOf, actorOf, describe, record, mustItems, SCOPES };
