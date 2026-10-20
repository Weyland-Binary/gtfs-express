/**
 * workspace/deliverables.js — « Tout le paquet »: what a project hands over
 * for one of its versions, stamped and described by a manifest.
 *
 * The package is a zip of the version's deliverables, each named after the
 * network, the version and the day, and a `manifest.json` that says what was
 * delivered and lets anyone check it later:
 *
 *   <network>_v<N>_<date>.zip                the version's GTFS — the bytes frozen
 *                                            with the project, VALIDATED NOW (G1)
 *   rapport-coherence_<…>.xlsx / .pdf        the version's coherence report as the
 *                                            operator's service-méthode sheet, read
 *                                            from the version itself
 *   note-<…>.html                            the summary note, when the flow that
 *                                            made the version wrote one (optional)
 *   manifest.json                            network, version, author, date, the
 *                                            validator (engine, version, errors,
 *                                            warnings, rules, the fingerprint of its
 *                                            report), the ids of the acknowledgements
 *                                            the version stands on, its approval, the
 *                                            note (`note`: { included, name } or, when
 *                                            none is packed, { included: false, reason:
 *                                            retouched · unavailable · not_sent }), the
 *                                            SHA-256 and size of every other file — and
 *                                            the PROOF the version stands on: `decision`
 *                                            (a change's: the review report it was
 *                                            delivered on, or the decision by hand, with
 *                                            who and when), `contract` (a build's:
 *                                            status, decided_by, clauses with their
 *                                            level, kind and status), `verdict` (the
 *                                            engine's, recorded by the server — never
 *                                            the client's word), `open_items` (each
 *                                            must or should clause not met or not
 *                                            measurable, wish, dismissed sentence,
 *                                            unread document, assumption, the reference
 *                                            feed's errors, a simplified baseline, edits
 *                                            by hand after the last gate, each with
 *                                            `accepted_by { name }` and `accepted_at`:
 *                                            names only, never an e-mail) and `proof`
 *                                            (the gates passed, the edits after them)
 *
 * A DELIVERY PATH (G1): the version's zip is handed to the canonical
 * validator through validatorGate before anything is written — a validator
 * missing or crashed refuses (503 VALIDATOR_UNAVAILABLE / VALIDATOR_FAILED),
 * an error above the project's baseline refuses (409 VALIDATION_NEW_ERRORS),
 * and a project without a baseline (a network designed here) must carry no
 * error at all (409 VALIDATION_ERRORS). A version of a shared project (one
 * with members) is delivered only once approved (409 NOT_APPROVED);
 * a delivery names the person who makes it (400 ACKNOWLEDGEMENT_UNNAMED).
 * A version frozen without a gate (no build, no application standing in its
 * working copy) is not delivered (409 PROOF_MISSING); the errors the
 * reference feed already carried are delivered only once a named person
 * accepted them — at the application, or here (`accept.baseline_errors`,
 * 409 BASELINE_ERRORS otherwise); edits by hand after the last gate, and
 * anything open nobody accepted, refuse 409 OPEN_ITEMS_UNACCEPTED { items }
 * (`accept.retouched` accepts the former under the author's name).
 * On a refusal nothing is written. The package is kept 24 hours (the
 * deliverables are regenerated from the version, never stored beyond),
 * served by its id to the project's own callers only.
 *
 *   manifestOf({ … })     the manifest's object, pure (the unit tests read it)
 *   buildPackage({ … })   → { package: { id, name, bytes, sha256, created_at }, manifest, manifest_sha256 }
 */

"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const archiver = require("archiver");
const validatorGate = require("../validatorGate");
const { NAME_OK } = require("../acknowledgement");
const store = require("./workspaceStore");
const { readerOf } = require("./versionReader");
const { sha256OfFile } = require("./versionFiles");
const { recordEvent } = require("../eventLogger");
const deliveryProof = require("../deliveryProof");

const refusal = store.refusal;
const MANIFEST_SCHEMA = "gtfs-express/delivery-manifest@1";
const NOTE_MAX_BYTES = 600 * 1024;

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const slug = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 40);
const ymd = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso || "")) ? String(iso).slice(0, 10) : new Date().toISOString().slice(0, 10));
const text = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "");

/** The network's name a file carries: the project's network, else the project's own name. */
const networkNameOf = (project) => text(project?.network?.name, 120) || text(project?.name, 120) || "reseau";

/** `<network>_v<N>_<date>.zip`: the delivered GTFS's name. */
const gtfsNameOf = (project, version, at) => `${slug(networkNameOf(project)) || "reseau"}_v${version.n}_${ymd(at)}.zip`;

/**
 * The acknowledgements a version stands on: the project's named records made
 * up to the version (its own, and the ones before it — a clause waived at ②,
 * an earlier build's), by id only — the names stay with the project.
 */
const acknowledgementIdsOf = (project, version, proof = null) => {
  const at = Date.parse(version?.at || "") || Infinity;
  const ids = new Set();
  for (const r of Array.isArray(project?.acknowledgements) ? project.acknowledgements : []) {
    if (!r || typeof r.id !== "string") continue;
    const when = Date.parse(r.at || "");
    if (r.id === version?.acknowledgement_id || !Number.isFinite(when) || when <= at) ids.add(r.id.slice(0, 64));
  }
  if (typeof version?.acknowledgement_id === "string") ids.add(version.acknowledgement_id.slice(0, 64));
  // The records the server keeps with the version's proof (the gates' named acknowledgements, the working copy's rows).
  for (const g of Array.isArray(proof?.gates) ? proof.gates : []) for (const r of g.acknowledgements || []) if (r && typeof r.id === "string") ids.add(r.id.slice(0, 64));
  for (const r of Array.isArray(proof?.acknowledgements) ? proof.acknowledgements : []) if (r && typeof r.id === "string") ids.add(r.id.slice(0, 64));
  return [...ids];
};

/**
 * What the package says the version stands on, from the server's record of it
 * (versions.proof) — never from the project document the client writes: the last gate's decision (deliveryProof.decisionOf),
 * contract and verdict, every open item of every gate (once: the last word on an item wins) and the package's own
 * (`extra`), each with who accepted it.
 *   → { decision, contract, verdict, open_items, proof: { gates: [{ scope, at, build_id?, edit_id? }], retouched_edits } }
 */
const proofSectionOf = (proof, extra = []) => {
  const gates = Array.isArray(proof?.gates) ? proof.gates : [];
  const last = gates[gates.length - 1] || null;
  const items = new Map();
  for (const g of gates) for (const i of g.open_items || []) if (i && i.kind) items.set(`${i.kind}:${i.id ?? ""}`, i);
  for (const i of extra) items.set(`${i.kind}:${i.id ?? ""}`, i);
  return {
    decision: deliveryProof.decisionOf(last),
    contract: last?.contract || null,
    verdict: last?.verdict || null,
    open_items: [...items.values()],
    proof: { gates: gates.map((g) => ({ scope: g.scope, at: g.at, ...(g.build_id ? { build_id: g.build_id } : {}), ...(g.edit_id != null ? { edit_id: g.edit_id } : {}), acknowledgements: (g.acknowledgements || []).map((r) => r.id) })), retouched_edits: Number(proof?.retouched_edits) || 0 },
  };
};

/**
 * The manifest of a package, pure: what was delivered, by whom, when,
 * validated by which engine (and the fingerprint of the report it answered),
 * standing on which acknowledgements, approved by whom, and each file's
 * SHA-256 and size. `files`: [{ name, role, bytes, sha256 }].
 */
const manifestOf = ({ project, version, versionSha256, files, validation, author, generatedAt, approval = null, noteOmitted = null, proof = null, extraItems = [] }) => {
  const proven = proofSectionOf(proof, extraItems);
  return {
    schema: MANIFEST_SCHEMA,
    generated_at: generatedAt,
    author: { name: author },
    project: { id: project?.id || null, name: text(project?.name, 200) || null, job: project?.job || null },
    network: { name: networkNameOf(project), source: project?.network?.source || null },
    version: {
      id: version.id,
      n: version.n,
      label: `v${version.n}`,
      kind: version.kind || null,
      at: version.at || null,
      by: text(version.by, 120) || null,
      sha256: versionSha256,
      // The engine's verdict the server recorded with the version's proof (never the client's word, never recomputed here).
      verdict: proven.verdict,
    },
    validator: {
      engine: validation.engine || null,
      version: validation.version || null,
      report_sha256: validation.report_sha256,
      errors: validation.errors,
      warnings: validation.warnings,
      rules: validation.rules || {},
      preexisting_errors: validation.preexisting,
      new_errors: validation.new_errors,
      checked_at: generatedAt,
    },
    // The proof the version stands on: what the person decided (a change) or the contract (a build), the engine's
    // verdict, every open item with who accepted it.
    decision: proven.decision,
    contract: proven.contract,
    verdict: proven.verdict,
    open_items: proven.open_items,
    proof: proven.proof,
    acknowledgements: acknowledgementIdsOf(project, version, proof),
    approval: approval && approval.status !== "none" ? { status: approval.status, by: approval.review?.by?.name || null, at: approval.review?.at || null, comment: approval.review?.comment || null } : null,
    // The summary note: the file packed, or why there is none — never silently missing.
    note: noteOf(files, noteOmitted),
    files: files.map((f) => ({ name: f.name, role: f.role, bytes: f.bytes, sha256: f.sha256 })),
  };
};

// Why a package carries no note: the version is a retouch (a snapshot, a delivery from edit mode, a copy reopened)
// that no note describes, or the note could not be written where the package was asked.
const NOTE_OMISSIONS = ["retouched", "unavailable"];
const noteOf = (files, omitted) => {
  const file = files.find((f) => f.role === "note");
  if (file) return { included: true, name: file.name };
  return { included: false, reason: NOTE_OMISSIONS.includes(omitted) ? omitted : "not_sent" };
};

/** The validator's answer on the version's zip, gated (see the header): { report, summary }. */
const validated = async (projectId, zipPath) => {
  const report = await validatorGate.validateDir(zipPath);
  const baseline = store.readBaseline(projectId);
  const compared = baseline ? validatorGate.assertNoNewErrors(baseline, report) : (validatorGate.assertCreationValid(report), null);
  const summary = validatorGate.summaryOf(report);
  const record = validatorGate.recordOf(report);
  return {
    report,
    summary: { engine: summary.engine, version: record.version, errors: summary.errors, warnings: summary.warnings, rules: record.rules, preexisting: Number(baseline?.counts?.errors) || 0, new_errors: compared ? compared.new_errors : [], report_sha256: sha256(Buffer.from(JSON.stringify(report))) },
  };
};

/**
 * The open items the package itself adds, and whether each is accepted: the reference feed's errors the
 * zip still carries (accepted at an application whose record covers every rule's count, else by the author here,
 * `accept.baseline_errors`), the edits by hand after the last gate (`accept.retouched`, the author). Throws 409
 * BASELINE_ERRORS for the former when nobody accepted them. → [open item]
 */
const packageItemsOf = ({ summary, proof, author, at, accept = {} }) => {
  const out = [];
  if (summary.errors > 0) {
    const covers = (i) => i && i.kind === "baseline_errors" && i.accepted_by && Object.entries(summary.rules || {}).every(([code, n]) => Number(i.rules?.[code]) >= n);
    const prior = (proof?.gates || []).flatMap((g) => g.open_items || []).filter(covers).pop() || null;
    if (!prior && !accept.baseline_errors) throw refusal(409, "BASELINE_ERRORS", `The version keeps ${summary.errors} error(s) the reference feed already carried: the person delivering accepts them by name (accept.baseline_errors: true) to build the package.`, { errors: summary.errors, rules: summary.rules || {}, preexisting: summary.preexisting });
    out.push({ kind: "baseline_errors", id: "package", errors: summary.errors, rules: summary.rules || {}, ...(prior ? { accepted_by: prior.accepted_by, accepted_at: prior.accepted_at, basis: prior.basis } : { accepted_by: { name: author }, accepted_at: at, basis: "package" }) });
  }
  const retouched = Number(proof?.retouched_edits) || 0;
  if (retouched > 0) out.push({ kind: "retouched", id: "edits", edits: retouched, ...(accept.retouched ? { accepted_by: { name: author }, accepted_at: at, basis: "package" } : { accepted_by: null, accepted_at: null, basis: null }) });
  return out;
};

/** Write the package's files into one zip at `zipPath` (written aside, then moved in place). */
const writeZip = async (zipPath, entries) => {
  await fsp.mkdir(path.dirname(zipPath), { recursive: true });
  const partial = `${zipPath}.partial`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(partial);
    const archive = archiver("zip", { zlib: { level: 6 } });
    out.on("close", resolve);
    out.on("error", reject);
    archive.on("error", reject);
    archive.pipe(out);
    for (const e of entries) archive.append(e.body, { name: e.name, date: e.date });
    archive.finalize();
  });
  await fsp.rename(partial, zipPath);
};

/**
 * Build « Tout le paquet » of a version (see the header). `project` is the
 * project's document (the client's shape), `row` the version's record in
 * the store; `author` the person delivering; `labels` the coherence files'
 * header (network, version, version_at); `note` an optional { name, content }
 * written by the flow (HTML, ≤ 600 KB); `approval` the version's status;
 * `accept` what the author accepts here ({ baseline_errors, retouched }).
 */
const buildPackage = async ({ projectId, project, row, author, lang = "fr", note = null, noteOmitted = null, approval = null, team = false, req = null, now = Date.now(), accept = {} }) => {
  const version = (Array.isArray(project?.versions) ? project.versions : []).find((v) => v && v.id === row.id) || { id: row.id, n: row.n, kind: row.kind, at: row.at };
  if (!NAME_OK(author)) throw refusal(400, "ACKNOWLEDGEMENT_UNNAMED", "A delivery names the person who makes it (by.name, 2–120 characters).", { required: ["by.name"] });
  // A shared project delivers what its approver approved; alone, the named delivery is the record.
  if (team && approval?.status !== "approved") throw refusal(409, "NOT_APPROVED", "This version is not approved: submit it, then have an approver approve it.", { status: approval?.status || "none", n: row.n });
  // Nothing leaves unproven: the version stands on a gate the server recorded when it was frozen.
  const proof = store.versionProof(projectId, row.id);
  if (!proof || !Array.isArray(proof.gates) || !proof.gates.length) throw refusal(409, "PROOF_MISSING", `v${row.n} was frozen without a build or an application standing in its working copy: nothing proves it met its brief. Build or apply it in the Studio, then deliver the version that follows.`, { n: row.n, kind: row.kind });
  if (!row.zip_sha256 || row.purged_at) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.", { n: row.n });
  const zipPath = store.zipPathOf(projectId, row.id);
  if (!fs.existsSync(zipPath)) throw refusal(409, "VERSION_MISSING", "This version's zip is no longer kept.", { n: row.n });
  if ((await sha256OfFile(zipPath)) !== row.zip_sha256) throw refusal(409, "VERSION_CORRUPT", "This version's zip no longer matches the fingerprint recorded when it was frozen: it is not delivered.");
  let noteBody = null;
  if (note && typeof note === "object" && typeof note.content === "string" && note.content.length) {
    noteBody = Buffer.from(note.content, "utf8");
    if (noteBody.length > NOTE_MAX_BYTES) throw refusal(413, "INVALID_INPUT", `The note is larger than ${Math.round(NOTE_MAX_BYTES / 1024)} KB.`);
  }

  // G1: the validator answers on the very bytes delivered, before anything is written.
  const { report, summary } = await validated(projectId, zipPath);
  const at = new Date(now).toISOString();
  // What stays open is accepted by a named person, or the package is refused (G4).
  const extraItems = packageItemsOf({ summary, proof, author: author.trim(), at, accept: accept || {} });
  const open = deliveryProof.unaccepted([...proofSectionOf(proof, extraItems).open_items]);
  if (open.length) throw refusal(409, "OPEN_ITEMS_UNACCEPTED", `${open.length} item(s) left open on v${row.n} were accepted by nobody (${open.map((i) => `${i.kind}${i.id ? ` ${i.id}` : ""}`).join(", ")}): accept them by name (the edits by hand after the last gate: accept.retouched) or go back to the Studio.`, { items: open, count: open.length, n: row.n });
  const gtfs = await fsp.readFile(zipPath);
  const clauses = ["decided", "assumed"].includes(project?.contract?.status) ? project.contract.clauses || [] : [];
  const reader = await readerOf(projectId, row);
  const { versionSheets } = require("../coherence/coherenceController");
  const parseClauses = require("../coherence/coherenceService").parseClauses;
  const sheets = await versionSheets(reader, { params: { clauses: parseClauses(clauses) }, labels: { network: networkNameOf(project), version: `v${row.n}`, version_at: ymd(version.at || row.at) }, lang, validation: { report, savedAt: now } });

  const files = [{ name: gtfsNameOf(project, version, at), role: "gtfs", body: gtfs }, { name: `${sheets.base}.xlsx`, role: "coherence_xlsx", body: sheets.xlsx }, { name: `${sheets.base}.pdf`, role: "coherence_pdf", body: sheets.pdf }];
  if (noteBody) files.push({ name: `note_${slug(networkNameOf(project)) || "reseau"}_v${row.n}_${ymd(at)}.html`, role: "note", body: noteBody });
  const described = files.map((f) => ({ ...f, bytes: f.body.length, sha256: sha256(f.body) }));
  const manifest = manifestOf({ project: { ...project, id: projectId }, version: { ...version, n: row.n }, versionSha256: row.zip_sha256, files: described, validation: summary, author: author.trim(), generatedAt: at, approval, noteOmitted, proof, extraItems });
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestSha = sha256(manifestBody);

  const id = crypto.randomBytes(8).toString("hex");
  const name = `${(slug(networkNameOf(project)) || "reseau")}_v${row.n}_${ymd(at)}_livraison.zip`;
  const packagePath = store.packagePathOf(projectId, id);
  const date = new Date(now);
  await writeZip(packagePath, [...described.map((f) => ({ name: f.name, body: f.body, date })), { name: "manifest.json", body: manifestBody, date }]);
  const packageSha = await sha256OfFile(packagePath);
  const meta = { id, name, bytes: fs.statSync(packagePath).size, sha256: packageSha, created_at: at, version_id: row.id, n: row.n, manifest, manifest_sha256: manifestSha };
  store.recordPackage(projectId, id, meta);
  recordEvent("workspace.package", { ...(req ? require("../eventLogger").extractReqMeta(req) : {}), n: row.n, files: described.length, validation_errors: summary.errors, engine: summary.engine, team });
  return { package: { id, name, bytes: meta.bytes, sha256: packageSha, created_at: at, version_id: row.id, n: row.n }, manifest, manifest_sha256: manifestSha };
};

module.exports = { manifestOf, buildPackage, acknowledgementIdsOf, gtfsNameOf, networkNameOf, MANIFEST_SCHEMA, _internals: { slug, validated, proofSectionOf, packageItemsOf } };
