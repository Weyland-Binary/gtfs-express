/**
 * The named record of what a person accepts at a delivery (G4): must clauses not met, sources the engine could not
 * verify, the reference feed's own errors, the errors the working copy carries beyond it, and the one decision on a direct-mode report or a change by hand.
 * Nothing is acknowledged anonymously, and a NEW validator error is never acknowledgeable.
 */

"use strict";

const crypto = require("crypto");
const { refusal } = require("./refusal");
const eventLogger = require("./eventLogger");

// Matches judge.MAX_CLAUSES, so that every clause not met can be accepted by name.
const MAX_CLAUSES = 240;
const MAX_NOTE = 400;
const SCOPES = ["commit", "approve", "waive"];

const NAME_OK = (s) => typeof s === "string" && s.trim().length >= 2 && s.trim().length <= 120 && /\p{L}/u.test(s);

const idSet = (list, max) => new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()).slice(0, max));

const SHAPE = "acknowledge must be { by: { name }, clauses?: [ids], sources?: true, baseline_errors?: true, current_errors?: true, changes?: true, direct?: true, hand?: true, note? }";

const parse = (raw, req = null) => {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw refusal(400, "INVALID_INPUT", SHAPE);
  if (raw.clauses != null && !Array.isArray(raw.clauses)) throw refusal(400, "INVALID_INPUT", SHAPE);
  const typed = raw.by && typeof raw.by === "object" ? raw.by.name : null;
  const by = { name: NAME_OK(typed) ? typed.trim() : req?.user?.display_name || null, user_id: req?.user?.id || null };
  const clauses = idSet(raw.clauses, MAX_CLAUSES);
  const sources = raw.sources === true;
  const baselineErrors = raw.baseline_errors === true;
  // Errors the working copy carries that the loaded feed did not (a hand edit before the plan), named apart.
  const currentErrors = raw.current_errors === true;
  // The change accounting's finding (changes no clause asks for) is accepted as one, by name.
  const changes = raw.changes === true;
  // The direct mode's decision: the review report delivered as shown, whatever it says.
  const direct = raw.direct === true;
  const hand = raw.hand === true;
  const note = typeof raw.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, MAX_NOTE) : null;
  if ((clauses.size || sources || baselineErrors || currentErrors || changes || direct || hand) && !NAME_OK(by.name)) throw refusal(400, "ACKNOWLEDGEMENT_UNNAMED", "An acknowledgement names the person who accepts it (acknowledge.by.name, 2–120 characters).", { required: ["by.name"] });
  return { by, clauses, sources, baseline_errors: baselineErrors, current_errors: currentErrors, changes, direct, hand, note };
};

const recordOf = (parsed, items, scope) => {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return null;
  if (!SCOPES.includes(scope)) throw new Error(`acknowledgement scope must be one of ${SCOPES.join(", ")}`);
  // The gate checks the name first; this keeps a record from ever being anonymous.
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

const notAskedText = (changes) => {
  const lines = changes.filter((c) => !c.table).length;
  const tables = changes.filter((c) => c.table);
  return [lines || !tables.length ? `changes not asked on ${lines} line(s)` : null, tables.length ? `rows not asked in ${[...new Set(tables.map((c) => c.table))].join(", ")}` : null].filter(Boolean).join(", ");
};

const directText = (report) => {
  const demands = Array.isArray(report?.demands) ? report.demands : [];
  const n = (s) => demands.filter((d) => d && d.status === s).length;
  const notAsked = Array.isArray(report?.not_asked) ? report.not_asked.length : 0;
  return `the review report as shown (${n("done")} done, ${n("not_done")} not done, ${n("unproven")} unproven, ${notAsked} not asked)`;
};

// "assumption" and "simplified_baseline" items occur only in older stored records.
const describe = (record) => {
  if (!record) return "";
  const clauses = record.items.filter((i) => i.kind === "clause").map((i) => `${i.id} (${i.status})`);
  const sources = record.items.filter((i) => i.kind === "sources").flatMap((i) => (i.operations || []).map((o) => `${o.id} (${o.reason})`));
  const assumptions = record.items.filter((i) => i.kind === "assumption").map((i) => i.id);
  const baseline = record.items.find((i) => i.kind === "baseline_errors");
  const current = record.items.find((i) => i.kind === "current_errors");
  const simplified = record.items.some((i) => i.kind === "simplified_baseline");
  const changes = record.items.find((i) => i.kind === "changes_not_asked");
  const direct = record.items.find((i) => i.kind === "direct_report");
  const hand = record.items.find((i) => i.kind === "hand_decision");
  const parts = [direct ? directText(direct.report) : null, hand ? `the change by hand as listed (${Number(hand.operations) || 0} step(s))` : null, clauses.length ? `clauses ${clauses.join(", ")}` : null, sources.length ? `sources ${sources.join(", ")}` : null, assumptions.length ? `assumptions ${assumptions.join(", ")}` : null, baseline ? `${Number(baseline.errors) || 0} error(s) of the reference feed` : null, current ? `${Number(current.errors) || 0} error(s) present before the plan, not in the reference feed` : null, simplified ? "a simplified baseline" : null, changes ? (Array.isArray(changes.changes) ? notAskedText(changes.changes) : "change accounting not run") : null].filter(Boolean);
  return `acknowledged by ${record.by.name}: ${parts.join("; ")}`.slice(0, MAX_NOTE);
};

// The event carries a keyed hash of the name, never the plain name nor the clause texts.
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

// Lazy: the judge requires this module for NAME_OK (a require cycle).
const mustItems = (conformance) => require("./judge").unmetMust(conformance);

module.exports = { NAME_OK, parse, recordOf, actorOf, describe, record, mustItems, SCOPES };
