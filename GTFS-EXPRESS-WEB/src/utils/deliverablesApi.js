/**
 * deliverablesApi — what ⑤ delivers of a project's version, and what it reads
 * of the versions. « Tout le paquet » of a version holds its validated GTFS,
 * its coherence report as a workbook and a PDF, the summary note (packed when
 * the flow that made the version can write it, else the manifest and ⑤ say
 * why not), and manifest.json; the plan's details are in the note's plan
 * table.
 *
 * The server's (the workspace, utils/projectApi.workspaceFetch — the
 * browser's token, the account cookie):
 *
 *   fetchVersionDiff(projectId, versionId, { from })   « Diff v0 → vN »: the explorer's comparison
 *                                   (added · removed · changed per table) of two frozen versions
 *   fetchVersionCoherence(projectId, versionId, { clauses })   the version's coherence report, read
 *                                   from its frozen zip — a static source for CoherenceReport
 *   buildPackage(projectId, versionId, { by, lang, note, noteOmitted })   « Tout le paquet »: built and
 *                                   VALIDATED by the server (G1) → { package, manifest, manifest_sha256 };
 *                                   without a note, `noteOmitted` says why (retouched · unavailable)
 *   downloadPackage(projectId, pkg)  the package's zip saved under its name → { name, manifestSha256 }
 *   markDelivered(projectId, versionId, { by, packageId, files })   « Marquer livrée » → { project }
 *   reviewVersion(projectId, versionId, action, { comment })   submit · approve · reject (with
 *                                   accounts; named by the server after the account) →
 *                                   { approval, review, project }
 *   addMember(projectId, email, role) / removeMember(projectId, userId) → { project }
 *
 * And, pure (the Vitest suites read them):
 *
 *   ROLES, can(role, needed)         the roles of a project (reader < contributor < approver < owner)
 *   approvalOf(project, versionId)   none · in_review · approved · rejected (the server's last review)
 *   approvalRequired(project)        a shared project (members): a version is delivered only approved
 *   deliveryTargetOf(project)        the version ⑤ delivers: the latest one that is not the reference
 *   isFrozen(version)                its zip is kept with the project (diff, restore, package need it)
 *   manifestRows(manifest)           the manifest's files as ⑤ lists them: { name, role, bytes, sha256, short }
 *   sha256Hex(bytes)                 the SHA-256 of bytes (Web Crypto), hex
 *   verifyManifest(manifest, files)  each file's bytes against the manifest's SHA-256 → { ok, files: [{ name, ok }] }
 *   saveBlob(blob, name)             the browser saves a file
 */

import { workspaceFetch, workspaceJson } from "./projectApi";
import { clausesBody, compactClauses } from "./coherenceApi";

const P = (id) => `/projects/${encodeURIComponent(id)}`;
const V = (id, vid) => `${P(id)}/versions/${encodeURIComponent(vid)}`;

// ── Roles and approval ──────────────────────────────────────────────────────

export const ROLES = Object.freeze(["reader", "contributor", "approver"]);
const RANK = { reader: 1, contributor: 2, approver: 3, owner: 4 };
/** Whether a role is at least the one needed; a project the server sends without a role is this browser's own. */
export const can = (role, needed) => (RANK[role || "owner"] || 0) >= (RANK[needed] || 0);

export const APPROVAL_STATES = Object.freeze(["none", "in_review", "approved", "rejected"]);
/** A version's approval as the server says it (the last review), "none" when it says nothing. */
export const approvalOf = (project, versionId) => {
  const s = project?.approval?.versions?.[versionId];
  return APPROVAL_STATES.includes(s) ? s : "none";
};
/** The reviews of one version, newest first. */
export const reviewsOf = (project, versionId) => (Array.isArray(project?.reviews) ? project.reviews.filter((r) => r && r.version_id === versionId) : []).slice().reverse();
/** Whether the project's versions are delivered only once approved: it is shared with other accounts. */
export const approvalRequired = (project) => Boolean(project?.approval?.required || (Array.isArray(project?.members) && project.members.length));

// ── Versions ────────────────────────────────────────────────────────────────

/** Whether a version's zip is kept with the project (frozen, not purged). */
export const isFrozen = (version) => Boolean(version?.zip?.sha256 && !version.zip.purged_at);

/** The version ⑤ delivers: the latest that is not the reference (null when only v0 exists). */
export const deliveryTargetOf = (project) =>
  (project?.versions || []).filter((v) => v && v.kind !== "reference" && v.n !== 0).reduce((best, v) => (!best || v.n > best.n ? v : best), null);

/** The reference v0 (frozen or not), or null. */
export const referenceOf = (project) => (project?.versions || []).find((v) => v && (v.kind === "reference" || v.n === 0)) || null;

// ── Manifest ────────────────────────────────────────────────────────────────

/** A fingerprint shortened for a line ("a91f…3c2d"), the whole one kept for the title. */
export const shortHash = (sha) => (typeof sha === "string" && sha.length > 12 ? `${sha.slice(0, 4)}…${sha.slice(-4)}` : String(sha || ""));

/** The files of a manifest as ⑤ lists them, the manifest itself excluded (it describes the others). */
export const manifestRows = (manifest) =>
  (Array.isArray(manifest?.files) ? manifest.files : []).map((f) => ({ name: String(f.name || ""), role: String(f.role || ""), bytes: Number(f.bytes) || 0, sha256: String(f.sha256 || ""), short: shortHash(f.sha256) }));

const toBytes = async (data) => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data.arrayBuffer === "function") return new Uint8Array(await data.arrayBuffer());
  return new TextEncoder().encode(String(data ?? ""));
};

/** The SHA-256 of bytes (an ArrayBuffer, a typed array, a Blob or a string), hex. */
export const sha256Hex = async (data) => {
  const digest = await crypto.subtle.digest("SHA-256", await toBytes(data));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

/**
 * Each file of a package against its manifest (a delivery can be checked,
 * later, by anyone): `files` maps a name to its bytes. A file the manifest
 * lists but `files` lacks is not ok; a file `files` has but the manifest does
 * not list is reported as `extra`.
 */
export const verifyManifest = async (manifest, files = {}) => {
  const rows = manifestRows(manifest);
  const out = [];
  for (const r of rows) {
    const data = files[r.name];
    if (data == null) {
      out.push({ name: r.name, ok: false, missing: true });
      continue;
    }
    out.push({ name: r.name, ok: (await sha256Hex(data)) === r.sha256 });
  }
  const listed = new Set(rows.map((r) => r.name));
  const extra = Object.keys(files).filter((n) => !listed.has(n) && n !== "manifest.json");
  return { ok: out.length > 0 && out.every((f) => f.ok) && !extra.length, files: out, extra };
};

// ── Files ───────────────────────────────────────────────────────────────────

/** The browser saves a file under `name`. */
export const saveBlob = (blob, name) => {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
};

/** The file name a response gives (Content-Disposition), else the fallback. */
const fileNameOf = (res, fallback) => {
  const header = res.headers?.get?.("Content-Disposition") || "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return m ? decodeURIComponent(m[1]) : fallback;
};

// ── The server's ────────────────────────────────────────────────────────────

const query = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const fetchVersionDiff = (projectId, versionId, { from = null, signal } = {}) => workspaceJson(`${V(projectId, versionId)}/diff${query({ from })}`, { signal });

/**
 * The clauses, compacted as the report reads them, ride in a JSON body (the POST form of the same route: a long
 * contract's clauses do not fit a URL, and none is cut); without clauses the report is read by GET.
 */
export const fetchVersionCoherence = (projectId, versionId, { clauses = null, region = null, signal } = {}) => {
  const body = clausesBody(compactClauses(clauses));
  return workspaceJson(`${V(projectId, versionId)}/coherence${query({ region, limit: 500 })}`, body ? { method: "POST", body, signal } : { signal });
};

// `accept`: what the person delivering accepts under their name when the package asks: the reference
// feed's own errors (409 BASELINE_ERRORS → baseline_errors) and the edits by hand after the last build or application
// (409 OPEN_ITEMS_UNACCEPTED, kind "retouched" → retouched). Sent only when ticked.
export const buildPackage = (projectId, versionId, { by = null, lang = "fr", note = null, noteOmitted = null, accept = null } = {}) => {
  const accepted = accept ? Object.fromEntries(Object.entries(accept).filter(([, v]) => v === true)) : {};
  return workspaceJson(`${V(projectId, versionId)}/package`, { method: "POST", body: { ...(by ? { by: { name: by } } : {}), lang, ...(note?.content ? { note: { content: note.content } } : noteOmitted ? { note_omitted: noteOmitted } : {}), ...(Object.keys(accepted).length ? { accept: accepted } : {}) } });
};

export const downloadPackage = async (projectId, pkg) => {
  const res = await workspaceFetch(`${P(projectId)}/packages/${encodeURIComponent(pkg.id)}`);
  const name = fileNameOf(res, pkg.name || "livraison.zip");
  saveBlob(await res.blob(), name);
  return { name, manifestSha256: res.headers?.get?.("X-Manifest-Sha256") || null };
};

export const markDelivered = (projectId, versionId, { by = null, packageId = null, files = [] } = {}) =>
  workspaceJson(`${V(projectId, versionId)}/delivered`, { method: "POST", body: { ...(by ? { by: { name: by } } : {}), ...(packageId ? { package_id: packageId } : { files }) } });

export const reviewVersion = (projectId, versionId, action, { comment = null } = {}) => workspaceJson(`${V(projectId, versionId)}/review`, { method: "POST", body: { action, ...(comment ? { comment } : {}) } });

export const addMember = (projectId, email, role) => workspaceJson(`${P(projectId)}/members`, { method: "POST", body: { email, role } });
export const removeMember = (projectId, userId) => workspaceJson(`${P(projectId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
