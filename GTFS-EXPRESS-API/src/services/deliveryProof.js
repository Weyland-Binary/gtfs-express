/**
 * What a delivery stands on, recorded with it so nothing leaves unnamed (G1, G4): the canonical validator's
 * answer (no GTFS is delivered unless it ran for real), the person's one named decision and who accepted each open item, by name only (never an e-mail or
 * an account id). A gate proof lives in the session folder's `_delivery_proof.json`, never in the network
 * report (a public share publishes it) nor in a SQLite table (the assistant's SQL reads those).
 */

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { NAME_OK } = require("./acknowledgement");

const PROOF_FILE = "_delivery_proof.json";
const INHERITED_FILE = "_inherited_proof.json";
const MAX_PROOFS = 50;
const MAX_GATES = 20;

const accepted = (name, at, basis) => (NAME_OK(name) ? { accepted_by: { name: name.trim() }, accepted_at: at || null, basis } : { accepted_by: null, accepted_at: null, basis: null });
const cut = (s, n) => (typeof s === "string" ? s.slice(0, n) : null);

/** An acknowledgement record as a proof keeps it: the person's name, never the account id. */
const recordOut = (r) => ({ id: r.id, scope: r.scope || null, at: r.at || null, by: { name: r.by.name }, clauses: Array.isArray(r.clauses) ? r.clauses : [], items: Array.isArray(r.items) ? r.items : [], note: r.note || null });

/** Every item that stays open on a delivery and who accepted it; one no record covers has `accepted_by: null`. */
const openItemsOf = ({ results = null, records = [] } = {}) => {
  const recs = (Array.isArray(records) ? records : []).filter((r) => r && NAME_OK(r.by?.name));
  const seen = new Set();
  // A record's item: by kind and id, or by text.
  const recordOf = (kind, id, text = null) =>
    recs.find((r) =>
      (r.items || []).some((i) => {
        if (!i || i.kind !== kind) return false;
        const hit = i.id === id || (text && typeof i.text === "string" && i.text.length >= 8 && text.slice(0, 300) === i.text.slice(0, 300));
        if (hit) seen.add(`${i.kind}:${i.id ?? ""}`);
        return hit;
      }),
    ) || null;
  const viaRecord = (rec) => accepted(rec.by.name, rec.at, "acknowledgement");
  const out = [];
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !["must", "should"].includes(r.level) || !["fail", "unknown"].includes(r.status)) continue;
    const rec = recordOf("clause", r.id);
    const acc = rec ? viaRecord(rec) : accepted(null);
    out.push({ kind: "clause", id: r.id, level: r.level, status: r.status, text: cut(r.text, 300), ...acc });
  }
  // What else the records accepted (unverified sources, the reference feed's errors, a clause the results
  // did not carry), each once.
  for (const rec of recs) {
    for (const i of rec.items || []) {
      if (!i || !i.kind) continue;
      const key = `${i.kind}:${i.id ?? ""}`;
      if (seen.has(key) || (i.kind === "clause" && out.some((x) => x.kind === "clause" && x.id === i.id))) continue;
      seen.add(key);
      const { kind, ...rest } = i;
      out.push({ kind, ...rest, ...viaRecord(rec) });
    }
  }
  return out;
};

/** A gate proof: the verdict, the validator's answer, the acknowledgements and the open items. */
const proofOf = ({ scope, at = new Date().toISOString(), edit_id = null, verdict = null, validator = null, results = null, records = [] }) => {
  const recs = (Array.isArray(records) ? records : []).filter((r) => r && r.id && NAME_OK(r.by?.name));
  return {
    id: crypto.randomBytes(8).toString("hex"),
    scope,
    at,
    ...(edit_id != null ? { edit_id: Number(edit_id) } : {}),
    verdict: verdict || null,
    validator: validator || null,
    acknowledgements: recs.map(recordOut),
    open_items: openItemsOf({ results, records: recs }),
  };
};

const unaccepted = (items) => (Array.isArray(items) ? items : []).filter((i) => i && !(i.accepted_by && NAME_OK(i.accepted_by.name)));

const sessionDir = (sessionId) => path.join(require("./sessionManager").GTFS_UPLOAD_DIR, String(sessionId));
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Keeps the last MAX_PROOFS; null for a working copy without a folder (an in-memory sandbox). Throws when the
 * folder exists but the file cannot be written, so a proof is never lost silently.
 */
const appendSessionProof = (sessionId, proof) => {
  if (!sessionId || !fs.existsSync(sessionDir(sessionId))) return null;
  const file = path.join(sessionDir(sessionId), PROOF_FILE);
  const list = readJson(file)?.proofs || [];
  fs.writeFileSync(file, JSON.stringify({ proofs: [...list, proof].slice(-MAX_PROOFS) }), "utf8");
  return proof;
};

/** Whether an edit of the working copy still stands (an application undone proves nothing any more). */
const standing = (db, editId) => {
  try {
    const row = db.prepare("SELECT undone FROM _edit_log WHERE id = ?").get(Number(editId));
    return Boolean(row) && !row.undone;
  } catch {
    return false;
  }
};

/** The gate proofs of a working copy; an application's counts only while its edit still stands. */
const sessionProofs = (sessionId, db = null) => {
  const list = readJson(path.join(sessionDir(sessionId), PROOF_FILE))?.proofs || [];
  const handle = db || (() => {
    try {
      return require("./db/connection").ensureDbHandle(sessionId);
    } catch {
      return null;
    }
  })();
  return list.filter((p) => p && (p.scope !== "commit" || (handle && standing(handle, p.edit_id))));
};

/** The proof of the version a working copy was restored from (« Reprendre »): its gates carry on. */
const writeInherited = (sessionId, versionProof) => {
  if (!versionProof || !Array.isArray(versionProof.gates) || !versionProof.gates.length) return false;
  fs.writeFileSync(path.join(sessionDir(sessionId), INHERITED_FILE), JSON.stringify(versionProof), "utf8");
  return true;
};

/** Standing edits of a working copy after `afterId` (0: all of them). */
const editsAfter = (db, afterId) => {
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM _edit_log WHERE id > ? AND undone = 0").get(Number(afterId) || 0).n || 0;
  } catch {
    return 0;
  }
};

/** The named acknowledgements a working copy holds, those of an undone edit left out (names only). */
const sessionAcknowledgements = (db) => {
  try {
    if (!db || !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_acknowledgements'").get()) return [];
    const parse = (s) => {
      try {
        return JSON.parse(s);
      } catch {
        return [];
      }
    };
    return db
      .prepare("SELECT id, edit_id, ts, scope, by_name, clauses, items, note FROM _acknowledgements ORDER BY ts")
      .all()
      .filter((r) => r.edit_id == null || standing(db, r.edit_id))
      .map((r) => ({ id: r.id, scope: r.scope, at: r.ts, by: { name: r.by_name }, ...(r.edit_id != null ? { edit_id: r.edit_id } : {}), clauses: parse(r.clauses), items: parse(r.items), note: r.note || null }));
  } catch {
    return [];
  }
};

/**
 * A version's proof: the gates inherited and its own, the acknowledgements the copy holds (an application's
 * record is there even when its proof file could not be written), and the edits by hand after the last gate,
 * which re-measures the whole feed. null when no gate stands: nothing is proven.
 */
const versionProofOf = (sessionId, { db = null, now = Date.now() } = {}) => {
  const handle = db || require("./db/connection").ensureDbHandle(sessionId);
  const inherited = readJson(path.join(sessionDir(sessionId), INHERITED_FILE));
  const own = sessionProofs(sessionId, handle);
  const ids = new Set();
  const gates = [...(Array.isArray(inherited?.gates) ? inherited.gates : []), ...own].filter((g) => g && g.id && !ids.has(g.id) && ids.add(g.id)).slice(-MAX_GATES);
  if (!gates.length) return null;
  const commits = own.filter((g) => g.scope === "commit").map((g) => Number(g.edit_id) || 0);
  // After this copy's own last gate; with none (a restored copy), the inherited count and every edit of this copy.
  const retouched = own.length ? editsAfter(handle, commits.length ? Math.max(...commits) : 0) : (Number(inherited?.retouched_edits) || 0) + editsAfter(handle, 0);
  const seen = new Set();
  const acknowledgements = [...(Array.isArray(inherited?.acknowledgements) ? inherited.acknowledgements : []), ...sessionAcknowledgements(handle)].filter((r) => r && r.id && !seen.has(r.id) && seen.add(r.id)).slice(-200);
  return { gates, acknowledgements, retouched_edits: retouched, at: new Date(now).toISOString() };
};

/** What the person decided on the change a gate delivered: the review report ("direct") or the decision by hand ("hand"), with who and when. */
const decisionOf = (gate) => {
  const item = (gate?.open_items || []).find((i) => i && (i.kind === "direct_report" || i.kind === "hand_decision"));
  if (!item) return null;
  const who = { by: item.accepted_by || null, at: item.accepted_at || null };
  if (item.kind === "hand_decision") return { kind: "hand", operations: Number(item.operations) || 0, ...who };
  const demands = Array.isArray(item.report?.demands) ? item.report.demands : [];
  const n = (s) => demands.filter((d) => d && d.status === s).length;
  return { kind: "direct", demands: { done: n("done"), not_done: n("not_done"), unproven: n("unproven") }, not_asked: Array.isArray(item.report?.not_asked) ? item.report.not_asked.length : 0, ...who };
};

/** What the project document shows of a version's proof: no name, no item text — counts and the last verdict. */
const summaryOf = (proof) => {
  if (!proof || !Array.isArray(proof.gates) || !proof.gates.length) return null;
  const last = proof.gates[proof.gates.length - 1];
  const items = proof.gates.flatMap((g) => g.open_items || []);
  return {
    at: proof.at || null,
    gates: proof.gates.map((g) => ({ scope: g.scope, at: g.at })),
    deliverable: last.verdict && typeof last.verdict.deliverable === "boolean" ? last.verdict.deliverable : null,
    validator: last.validator ? { engine: last.validator.engine || null, version: last.validator.version || null, errors: last.validator.errors ?? null, warnings: last.validator.warnings ?? null } : null,
    decision: decisionOf(last)?.kind || null,
    open_items: items.length,
    unaccepted: unaccepted(items).length,
    retouched_edits: Number(proof.retouched_edits) || 0,
  };
};

module.exports = { PROOF_FILE, INHERITED_FILE, openItemsOf, proofOf, unaccepted, appendSessionProof, sessionProofs, writeInherited, versionProofOf, decisionOf, summaryOf };
