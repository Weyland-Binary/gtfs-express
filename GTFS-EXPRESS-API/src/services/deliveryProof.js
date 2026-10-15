/**
 * deliveryProof — what a delivery stands on, recorded with it so that
 * nothing leaves unnamed (G1, G4, G5): no GTFS is delivered unless the
 * canonical validator
 * ran for real, every requirement of the brief is measured by a clause or
 * declared not measurable, whatever stays open is accepted by a named person,
 * and that proof is kept with the version and in the package's manifest —
 * the names of who accepted what included, never an e-mail nor an account id.
 *
 * A GATE PROOF is one gate passed: a build (scope "compile", POST
 * /network/compile) or an application (scope "commit", POST
 * /transform/commit). Both are written next to the working copy, in
 * `_delivery_proof.json` of its session folder — never in the network
 * report (a public share publishes that one) nor in a SQLite table (the
 * assistant's SQL reads those):
 *
 *   { id, scope, at, build_id?, edit_id?,
 *     verdict,                                     the engine's verdict on the delivered feed (verdict.verdictOf)
 *     validator: { engine, version, errors, warnings, rules },   the canonical validator's answer (validatorGate.recordOf)
 *     contract: { status, decided_by, decided_at, clauses: [{ id, kind, level, status, decided_by, measured }],
 *                 wishes, dismissed, assumptions } | null,
 *     acknowledgements: [{ id, scope, at, by: { name }, clauses, items, note }],
 *     open_items: [{ kind, id, …, accepted_by: { name } | null, accepted_at, basis }] }
 *
 * The open items: `clause` (a must or should clause not met or not
 * measurable), `wish` (« à vérifier à la main »), `dismissed` (a requirement
 * sentence a named person set aside), `unread_document` (a document nobody
 * could read, acknowledged), `assumption` (of the contract — the assumed
 * contract itself included — or of the plan), `sources` (operations whose
 * words the engine could not verify), `baseline_errors` (errors the client's
 * reference feed already carried), `simplified_baseline` (a simplified
 * import built), and — added by the package — `retouched` (edits by hand
 * after the last gate). `basis` says what accepted it: acknowledgement (the
 * gate's named record), checked_by_hand, confirmed, dismissal, contract (a
 * should clause, tolerated by whoever decided the clause or the contract),
 * package (accepted when the package was built).
 *
 * A VERSION's proof (workspace versions.proof, frozen with its zip) is the
 * gates its working copy passed, those it inherited from the version it was
 * restored from, the named acknowledgements the copy holds
 * (`_acknowledgements` rows, names and dates), and how many edits by hand
 * stand after the last one: { gates: [gate proof], acknowledgements,
 * retouched_edits, at }.
 *
 *   contractRecord(contract, results)          → the contract as a proof keeps it (names only)
 *   openItemsOf({ results, contract, coverage, records }) → [open item]
 *   proofOf({ scope, … })                      → a gate proof
 *   unaccepted(items)                          → the open items nobody accepted
 *   appendSessionProof(sessionId, proof)       a gate proof written next to the working copy
 *   sessionProofs(sessionId)                   → the gate proofs of a working copy (their edit still standing)
 *   writeInherited(sessionId, versionProof)    the proof of the version a working copy was restored from
 *   versionProofOf(sessionId)                  → { gates, acknowledgements, retouched_edits, at } | null (no gate: nothing proven)
 *   summaryOf(versionProof)                    → what the project document shows of it (no names)
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

const nameOf = (by) => (by && typeof by === "object" ? by.name : typeof by === "string" ? by : null);
const accepted = (name, at, basis) => (NAME_OK(name) ? { accepted_by: { name: name.trim() }, accepted_at: at || null, basis } : { accepted_by: null, accepted_at: null, basis: null });
const cut = (s, n) => (typeof s === "string" ? s.slice(0, n) : null);

/** The contract as a proof keeps it: its status, who decided it, each clause's level, kind, status and measure — names only. */
const contractRecord = (contract, results = null) => {
  if (!contract || typeof contract !== "object") return null;
  const measured = new Map((Array.isArray(results) ? results : []).filter(Boolean).map((r) => [r.id, r.status]));
  return {
    status: contract.status || "draft",
    decided_by: NAME_OK(contract.decided_by) ? contract.decided_by.trim() : null,
    decided_at: contract.decided_at || null,
    clauses: (contract.clauses || []).slice(0, require("./network/conformanceService").MAX_CLAUSES).map((c) => ({ id: c.id, kind: c.kind || null, level: c.level || "must", status: c.status || null, decided_by: NAME_OK(c.decision?.by?.name) ? c.decision.by.name.trim() : null, measured: measured.get(c.id) || null })),
    wishes: (contract.wishes || []).length,
    dismissed: (contract.dismissed || []).length,
    assumptions: (contract.assumptions || []).length,
  };
};

/** An acknowledgement record as a proof keeps it: the person's name, never the account id. */
const recordOut = (r) => ({ id: r.id, scope: r.scope || null, at: r.at || null, by: { name: r.by.name }, clauses: Array.isArray(r.clauses) ? r.clauses : [], items: Array.isArray(r.items) ? r.items : [], note: r.note || null });

/**
 * Every item that stays open on a delivery and who accepted it (see the header). `results`: the conformance results
 * the delivery was measured on; `contract`: the contract it ran under (contractService.normalizeContract);
 * `coverage`: the coverage of the brief by it (contract/coverage: the unread documents' reasons); `records`: the named
 * acknowledgements the gate recorded. An item no record, no tick and no decision covers has `accepted_by: null`.
 */
const openItemsOf = ({ results = null, contract = null, coverage = null, records = [] } = {}) => {
  const recs = (Array.isArray(records) ? records : []).filter((r) => r && NAME_OK(r.by?.name));
  const seen = new Set();
  // A record's item: by kind and id, or — the contract's pending items renamed a1…an by a change plan — by text.
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
  const own = new Map((contract?.clauses || []).map((c) => [c.id, c]));
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !["must", "should"].includes(r.level) || !["fail", "unknown"].includes(r.status)) continue;
    const rec = recordOf("clause", r.id);
    const decision = own.get(r.id)?.decision;
    // A should clause is tolerated by whoever decided it (or the contract); a must one only by a named acknowledgement.
    const acc = rec ? viaRecord(rec) : r.level === "should" ? (NAME_OK(decision?.by?.name) ? accepted(decision.by.name, decision.at, "contract") : accepted(contract?.decided_by, contract?.decided_at, "contract")) : accepted(null);
    out.push({ kind: "clause", id: r.id, level: r.level, status: r.status, text: cut(r.text, 300), ...acc });
  }
  const pending = new Map(require("./contract/contractService").pendingAssumptionsOf(contract).map((p) => [p.id, p.text]));
  for (const w of contract?.wishes || []) {
    const id = `contract_${w.id}`;
    const rec = w.checked ? null : recordOf("assumption", id, pending.get(id));
    const acc = w.checked ? accepted(nameOf(w.checked.by), w.checked.at, "checked_by_hand") : rec ? viaRecord(rec) : accepted(null);
    out.push({ kind: "wish", id: w.id, quote: cut(w.quote, 300), ...(NAME_OK(nameOf(w.by)) ? { marked_by: { name: nameOf(w.by).trim() } } : {}), ...acc });
  }
  const unread = new Map((coverage?.unread || []).map((u) => [`doc:${u.id}`, u]));
  for (const d of contract?.dismissed || []) {
    const doc = String(d.sentence || "").startsWith("doc:");
    const u = unread.get(d.sentence);
    out.push({ kind: doc ? "unread_document" : "dismissed", id: d.sentence, text: cut(d.text || u?.name || null, 300), ...(u?.reason ? { reason: u.reason } : {}), ...(d.reason ? { note: cut(d.reason, 300) } : {}), ...accepted(nameOf(d.by), d.at, "dismissal") });
  }
  if (contract?.status === "assumed") {
    const rec = recordOf("assumption", "contract_assumed", pending.get("contract_assumed"));
    out.push({ kind: "assumption", id: "contract_assumed", text: "contract assumed (not reviewed clause by clause)", ...(rec ? viaRecord(rec) : accepted(null)) });
  }
  for (const a of contract?.assumptions || []) {
    if (!a || !a.text) continue;
    const id = `contract_${a.id}`;
    const rec = a.confirmed ? null : recordOf("assumption", id, pending.get(id));
    out.push({ kind: "assumption", id, text: cut(a.text, 300), ...(a.confirmed ? accepted(nameOf(a.confirmed.by), a.confirmed.at, "confirmed") : rec ? viaRecord(rec) : accepted(null)) });
  }
  // What else the records accepted: the plan's assumptions, unverified sources, the reference feed's errors, a
  // simplified baseline, a clause the results did not carry — each once, accepted by its record.
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

/** A gate proof (see the header). `records`: the acknowledgement records of the gate (acknowledgement.recordOf). */
const proofOf = ({ scope, at = new Date().toISOString(), build_id = null, edit_id = null, verdict = null, validator = null, contract = null, results = null, coverage = null, records = [] }) => {
  const recs = (Array.isArray(records) ? records : []).filter((r) => r && r.id && NAME_OK(r.by?.name));
  return {
    id: crypto.randomBytes(8).toString("hex"),
    scope,
    at,
    ...(build_id ? { build_id } : {}),
    ...(edit_id != null ? { edit_id: Number(edit_id) } : {}),
    verdict: verdict || null,
    validator: validator || null,
    contract: contractRecord(contract, results),
    acknowledgements: recs.map(recordOut),
    open_items: openItemsOf({ results, contract, coverage, records: recs }),
  };
};

/** The open items nobody accepted. */
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
 * A gate proof written next to the working copy (the last MAX_PROOFS kept); null for a working copy without a folder
 * (an in-memory sandbox). Throws when the folder exists and the file cannot be written: the build calls it before it
 * answers, so a build that cannot record its proof is removed.
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

/** The gate proofs of a working copy: its build's, and each application whose edit still stands. */
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

/**
 * The named acknowledgements a working copy holds (`_acknowledgements`, next to the edit log): who accepted what at
 * each application — the rows of the edits still standing, and those of no edit — as a proof keeps them (names only).
 */
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
 * A version's proof, read from the working copy it is frozen from: the gates it inherited and its own, the named
 * acknowledgements the copy holds (`_acknowledgements`: an application's record lives there even when its proof file
 * could not be written), and the edits by hand standing after the last gate (a gate of this working copy re-measures
 * the whole feed: the edits before it are covered by it). null when no gate stands: nothing is proven.
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
    contract: last.contract ? { status: last.contract.status } : null,
    open_items: items.length,
    unaccepted: unaccepted(items).length,
    retouched_edits: Number(proof.retouched_edits) || 0,
  };
};

module.exports = { PROOF_FILE, INHERITED_FILE, contractRecord, openItemsOf, proofOf, unaccepted, appendSessionProof, sessionProofs, writeInherited, versionProofOf, summaryOf };
