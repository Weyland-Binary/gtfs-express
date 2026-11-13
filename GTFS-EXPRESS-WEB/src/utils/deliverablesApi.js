/** A version's delivery package (validated by the server, G1), its manifest, review and approval. */

import { workspaceFetch, workspaceJson } from "./projectApi";

const P = (id) => `/projects/${encodeURIComponent(id)}`;
const V = (id, vid) => `${P(id)}/versions/${encodeURIComponent(vid)}`;

// ── Roles and approval

export const ROLES = Object.freeze(["reader", "contributor", "approver"]);
const RANK = { reader: 1, contributor: 2, approver: 3, owner: 4 };
/** A project the server sends without a role is this browser's own. */
export const can = (role, needed) => (RANK[role || "owner"] || 0) >= (RANK[needed] || 0);

export const APPROVAL_STATES = Object.freeze(["none", "in_review", "approved", "rejected"]);
export const approvalOf = (project, versionId) => {
  const s = project?.approval?.versions?.[versionId];
  return APPROVAL_STATES.includes(s) ? s : "none";
};
export const reviewsOf = (project, versionId) => (Array.isArray(project?.reviews) ? project.reviews.filter((r) => r && r.version_id === versionId) : []).slice().reverse();
/** A project shared with other accounts delivers a version only once approved. */
export const approvalRequired = (project) => Boolean(project?.approval?.required || (Array.isArray(project?.members) && project.members.length));

// ── Versions

export const isFrozen = (version) => Boolean(version?.zip?.sha256 && !version.zip.purged_at);

export const deliveryTargetOf = (project) =>
  (project?.versions || []).filter((v) => v && v.kind !== "reference" && v.n !== 0).reduce((best, v) => (!best || v.n > best.n ? v : best), null);

export const referenceOf = (project) => (project?.versions || []).find((v) => v && (v.kind === "reference" || v.n === 0)) || null;

// ── Manifest

export const shortHash = (sha) => (typeof sha === "string" && sha.length > 12 ? `${sha.slice(0, 4)}…${sha.slice(-4)}` : String(sha || ""));

export const manifestRows = (manifest) =>
  (Array.isArray(manifest?.files) ? manifest.files : []).map((f) => ({ name: String(f.name || ""), role: String(f.role || ""), bytes: Number(f.bytes) || 0, sha256: String(f.sha256 || ""), short: shortHash(f.sha256) }));

const toBytes = async (data) => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && typeof data.arrayBuffer === "function") return new Uint8Array(await data.arrayBuffer());
  return new TextEncoder().encode(String(data ?? ""));
};

export const sha256Hex = async (data) => {
  const digest = await crypto.subtle.digest("SHA-256", await toBytes(data));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

/** `files` maps a name to its bytes; a file the manifest does not list is reported as `extra`. */
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

// ── Files

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

const fileNameOf = (res, fallback) => {
  const header = res.headers?.get?.("Content-Disposition") || "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return m ? decodeURIComponent(m[1]) : fallback;
};

// ── Requests

const query = (params) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const fetchVersionDiff = (projectId, versionId, { from = null, signal } = {}) => workspaceJson(`${V(projectId, versionId)}/diff${query({ from })}`, { signal });

export const fetchVersionCoherence = (projectId, versionId, { region = null, signal } = {}) => workspaceJson(`${V(projectId, versionId)}/coherence${query({ region, limit: 500 })}`, { signal });

// `accept`: what the person accepts under their name when the package asks (409 BASELINE_ERRORS → baseline_errors,
// 409 OPEN_ITEMS_UNACCEPTED kind "retouched" → retouched); only the ticked ones are sent.
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
