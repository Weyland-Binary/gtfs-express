/**
 * projectApi — the journey's projects on the server: the workspace
 * (/gtfs/workspace…, for everyone). A version's deliverables are its package
 * (utils/deliverablesApi), its approval is ⑤'s, the list of projects is Home.
 *
 * The workspace: the projects this browser keeps on the server, owned by an account or by the browser's token — sent
 * in the X-Client-Token header of these calls only, minted on first need
 * (POST /workspace/token), set aside and minted again when the server no
 * longer knows it (401 CLIENT_TOKEN_REQUIRED) — set aside, never deleted:
 * the projects it owns are not lost with it, and « Rattacher mes travaux à
 * mon compte » presents it too (X-Client-Token-Previous). Autosave is compare-and-set:
 * `patchProject` names the data_version it was made from (If-Match) and a
 * stale one throws AUTOSAVE_CONFLICT with the server's project in
 * `err.body.project`; `force` writes over it ("Garder ma copie"). A version is
 * frozen from the working copy that holds it (its session id in the header).
 *
 * `workspaceFetch(path, options)` is the raw call (the token, the retry once
 * a token is replaced) for a caller that reads something else than JSON —
 * the package's zip (utils/deliverablesApi).
 *
 * Every call sends the account cookie (credentials: "include") and, through
 * fetchWithSession, the X-Session-ID of the feed loaded in the app. A failed
 * call throws an Error carrying `{ code, status, message, body }` (humanError()
 * reads it).
 */

import API_BASE_URL from "../config";
import { clearPreviousClientToken, fetchWithSession, getClientToken, getPreviousClientToken, retireClientToken, setClientToken } from "./sessionManager";

const apiError = (status, body) => {
  const err = new Error(body?.message || body?.error || `HTTP ${status}`);
  err.status = status;
  err.code = typeof body?.error === "string" ? body.error : null;
  err.body = body || null;
  return err;
};

// ── The workspace (the journey's projects) ─────────────────────────────────

let minting = null;
/** This browser's workspace token: the kept one, else a new one from the server (one request at a time). */
export const ensureClientToken = async () => {
  const kept = getClientToken();
  if (kept) return kept;
  if (!minting) {
    minting = (async () => {
      const res = await fetch(`${API_BASE_URL}/workspace/token`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.token) throw apiError(res.status, body);
      setClientToken(body.token);
      return body.token;
    })().finally(() => {
      minting = null;
    });
  }
  return minting;
};

/**
 * A raw workspace call → the Response: the token in X-Client-Token (a new one
 * minted once when the server no longer knows it), the working copy's session
 * when given (`sessionId`, else the tab's), the If-Match of a write, the
 * account cookie. A refusal is thrown as an Error { code, status, body }; a
 * success is the caller's to read (JSON, or a zip).
 */
export const workspaceFetch = async (path, { method = "GET", body = null, ifMatch = null, sessionId = null, retry = true, headers: extra = {}, signal } = {}) => {
  const token = await ensureClientToken();
  const headers = { ...extra, "X-Client-Token": token };
  if (body != null) headers["Content-Type"] = "application/json";
  if (ifMatch != null) headers["If-Match"] = ifMatch === "*" ? "*" : `"${ifMatch}"`;
  if (sessionId) headers["X-Session-ID"] = sessionId;
  const res = await fetchWithSession(`${API_BASE_URL}/workspace${path}`, { method, headers, signal, ...(body != null ? { body: JSON.stringify(body) } : {}) });
  if (res.ok) return res;
  const payload = await res.json().catch(() => ({}));
  if (res.status === 401 && payload?.error === "CLIENT_TOKEN_REQUIRED" && retry) {
    // Set aside, never deleted: its projects may come back (a secret put back) and an attachment presents it.
    retireClientToken();
    return workspaceFetch(path, { method, body, ifMatch, sessionId, retry: false, headers: extra, signal });
  }
  throw apiError(res.status, payload);
};

/** A workspace call answered in JSON (see workspaceFetch); a 204 is {}. */
const wsRequest = async (path, options = {}) => {
  const res = await workspaceFetch(path, options);
  return res.status === 204 ? {} : res.json().catch(() => ({}));
};
export const workspaceJson = wsRequest;

const WP = (id) => `/projects/${encodeURIComponent(id)}`;

/** The projects of this browser (or account): Home's lines, never the whole documents. */
export const listWorkspaceProjects = () => wsRequest("/projects");
export const createWorkspaceProject = (project) => wsRequest("/projects", { method: "POST", body: { project } });
export const getWorkspaceProject = (id) => wsRequest(WP(id));
/** The autosave: `dataVersion` read last, or "*" to write over another writer (`actor` for the journal). */
export const patchWorkspaceProject = (id, project, dataVersion, { actor = null } = {}) => wsRequest(WP(id), { method: "PATCH", ifMatch: dataVersion, body: { project, ...(actor ? { actor } : {}) } });
export const deleteWorkspaceProject = (id) => wsRequest(WP(id), { method: "DELETE" });
/** The working copy (a session) the project runs on: the server snapshots its edits. */
export const bindWorkspaceSession = (id, sessionId = null) => wsRequest(`${WP(id)}/bind`, { method: "POST", sessionId });
/** Freeze the working copy that holds a version as its zip (the build's session, or the tab's). */
export const freezeWorkspaceVersion = (id, version, sessionId = null) => wsRequest(`${WP(id)}/versions`, { method: "POST", body: { version }, sessionId });
export const deleteWorkspaceVersion = (id, versionId) => wsRequest(`${WP(id)}/versions/${encodeURIComponent(versionId)}`, { method: "DELETE" });
/** « Reprendre »: a new working copy from the version's zip → { sessionId, validationReport, counts, version }. */
export const restoreWorkspaceVersion = (id, versionId) => wsRequest(`${WP(id)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
export const keepWorkspaceDocument = (id, documentId) => wsRequest(`${WP(id)}/documents`, { method: "POST", body: { document_id: documentId } });
export const removeWorkspaceDocument = (id, documentId) => wsRequest(`${WP(id)}/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
/**
 * « Rattacher mes travaux à mon compte »: the projects move to the account, the browser gets a new token. A
 * token set aside is presented too (its projects move when the server knows it again, and it is forgotten).
 */
export const attachWorkspaceToAccount = async () => {
  const previous = getPreviousClientToken();
  const out = await wsRequest("/attach", { method: "POST", headers: previous && previous !== getClientToken() ? { "X-Client-Token-Previous": previous } : {} });
  if (out?.token) setClientToken(out.token);
  // Moved with the rest: forgotten. Still unknown to the server: kept aside for a later attachment.
  if (previous && out?.previous === true) clearPreviousClientToken();
  return out;
};

