/**
 * « Tout le paquet »: a version's GTFS, its coherence report and optional note, zipped with a manifest of what was
 * delivered and the proof it stands on (the decision, the engine's verdict, every open item with who accepted it).
 * A delivery path (G1): the zip is validated before anything is written, and on any refusal nothing is.
 * Manifests carry names only, never an e-mail. A package is kept 24 hours, served to the project's own callers only.
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

const networkNameOf = (project) => text(project?.network?.name, 120) || text(project?.name, 120) || "reseau";

const gtfsNameOf = (project, version, at) => `${slug(networkNameOf(project)) || "reseau"}_v${version.n}_${ymd(at)}.zip`;

/** The acknowledgements the server recorded with the version's proof, by id only: the names stay with the project. */
const attestedAcknowledgementsOf = (proof = null) => {
  const ids = new Set();
  for (const g of Array.isArray(proof?.gates) ? proof.gates : []) for (const r of g.acknowledgements || []) if (r && typeof r.id === "string") ids.add(r.id.slice(0, 64));
  for (const r of Array.isArray(proof?.acknowledgements) ? proof.acknowledgements : []) if (r && typeof r.id === "string") ids.add(r.id.slice(0, 64));
  return [...ids];
};

/**
 * The acknowledgements the project's document (written by the client) lists up to the version, its own included, and
 * the server did not record: declared by the client, never attested, so the manifest keeps them apart.
 */
const clientAcknowledgementsOf = (project, version, attested = []) => {
  const at = Date.parse(version?.at || "") || Infinity;
  const ids = new Set();
  for (const r of Array.isArray(project?.acknowledgements) ? project.acknowledgements : []) {
    if (!r || typeof r.id !== "string") continue;
    const when = Date.parse(r.at || "");
    if (r.id === version?.acknowledgement_id || !Number.isFinite(when) || when <= at) ids.add(r.id.slice(0, 64));
  }
  if (typeof version?.acknowledgement_id === "string") ids.add(version.acknowledgement_id.slice(0, 64));
  for (const id of attested) ids.delete(id);
  return [...ids];
};

/**
 * Read from the server's record (versions.proof), never from the project document the client writes. An item
 * open at several gates is listed once, the last word winning.
 */
const proofSectionOf = (proof, extra = []) => {
  const gates = Array.isArray(proof?.gates) ? proof.gates : [];
  const last = gates[gates.length - 1] || null;
  const items = new Map();
  for (const g of gates) for (const i of g.open_items || []) if (i && i.kind) items.set(`${i.kind}:${i.id ?? ""}`, i);
  for (const i of extra) items.set(`${i.kind}:${i.id ?? ""}`, i);
  return {
    decision: deliveryProof.decisionOf(last),
    verdict: last?.verdict || null,
    open_items: [...items.values()],
    proof: { gates: gates.map((g) => ({ scope: g.scope, at: g.at, ...(g.edit_id != null ? { edit_id: g.edit_id } : {}), acknowledgements: (g.acknowledgements || []).map((r) => r.id) })), retouched_edits: Number(proof?.retouched_edits) || 0 },
  };
};

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
      // Recorded by the server with the proof: never the client's word, never recomputed here.
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
    decision: proven.decision,
    verdict: proven.verdict,
    open_items: proven.open_items,
    proof: proven.proof,
    acknowledgements: attestedAcknowledgementsOf(proof),
    client_acknowledgements: clientAcknowledgementsOf(project, version, attestedAcknowledgementsOf(proof)),
    approval: approval && approval.status !== "none" ? { status: approval.status, by: approval.review?.by?.name || null, at: approval.review?.at || null, comment: approval.review?.comment || null } : null,
    // Never silently missing: the note packed, or why there is none.
    note: noteOf(files, noteOmitted),
    files: files.map((f) => ({ name: f.name, role: f.role, bytes: f.bytes, sha256: f.sha256 })),
  };
};

// A retouched version (snapshot, delivery from edit mode, copy reopened) has no note describing it.
const NOTE_OMISSIONS = ["retouched", "unavailable"];
const noteOf = (files, omitted) => {
  const file = files.find((f) => f.role === "note");
  if (file) return { included: true, name: file.name };
  return { included: false, reason: NOTE_OMISSIONS.includes(omitted) ? omitted : "not_sent" };
};

/** Under the project's country (as its exports); above the baseline refuses 409 VALIDATION_NEW_ERRORS; without a baseline, any error refuses. */
const validated = async (projectId, zipPath) => {
  const report = await validatorGate.validateDir(zipPath, store.countryCodeOf(projectId));
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
 * The reference feed's errors still in the zip count as accepted only by an earlier record covering every rule's
 * count, else by the author here; the edits by hand after the last gate are accepted by the author or stay open.
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

/** Written aside, then moved in place. */
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
  const reader = await readerOf(projectId, row, { req });
  const { versionSheets } = require("../coherence/coherenceController");
  const sheets = await versionSheets(reader, { params: {}, labels: { network: networkNameOf(project), version: `v${row.n}`, version_at: ymd(version.at || row.at) }, lang, validation: { report, savedAt: now } });

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

module.exports = { manifestOf, buildPackage, attestedAcknowledgementsOf, clientAcknowledgementsOf, gtfsNameOf, networkNameOf, MANIFEST_SCHEMA, _internals: { slug, validated, proofSectionOf, packageItemsOf } };
