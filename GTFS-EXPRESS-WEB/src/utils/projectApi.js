/**
 * The workspace API: the projects this browser keeps on the server, owned by an account or by the browser's
 * token (X-Client-Token, sent on these calls only). A token the server no longer knows is set aside, never
 * deleted, so its projects can still be attached to an account later (X-Client-Token-Previous).
 * Autosave is compare-and-set on data_version (If-Match); a stale write throws AUTOSAVE_CONFLICT.
 * A failed call throws an Error carrying `{ code, status, message, body }`.
 */

import API_BASE_URL from "../config";
import { clearPreviousClientToken, getClientToken, getPreviousClientToken, retireClientToken, setClientToken } from "./sessionManager";
import { apiError, request } from "./apiRequest";

let minting = null;
/** The kept token, else a new one from the server (one mint request at a time). */
export const ensureClientToken = async () => {
  const kept = getClientToken();
  if (kept) return kept;
  if (!minting) {
    minting = (async () => {
      // A token belongs to the browser, not to a working copy.
      const res = await request(`${API_BASE_URL}/workspace/token`, { method: "POST", withSession: false });
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
 * Every path under /projects/:id/ waits until the project is on the server: a project made a moment ago is
 * saved a tick later and must not meet a 404 meanwhile. Its own create, read and autosave never wait, since
 * they are what makes it ready.
 */
let projectReady = null;
export const setProjectReady = (fn) => {
  projectReady = typeof fn === "function" ? fn : null;
};
const PROJECT_ACT = /^\/projects\/([^/?#]+)\/./;

/** The raw call, for callers that read something else than JSON (a zip); retried once with a new token. */
export const workspaceFetch = async (path, { method = "GET", body = null, ifMatch = null, sessionId = null, retry = true, headers: extra = {}, signal } = {}) => {
  const act = projectReady && retry ? PROJECT_ACT.exec(path) : null;
  if (act) await projectReady(decodeURIComponent(act[1]));
  const token = await ensureClientToken();
  const headers = { ...extra, "X-Client-Token": token };
  if (body != null) headers["Content-Type"] = "application/json";
  if (ifMatch != null) headers["If-Match"] = ifMatch === "*" ? "*" : `"${ifMatch}"`;
  if (sessionId) headers["X-Session-ID"] = sessionId;
  const res = await request(`${API_BASE_URL}/workspace${path}`, { method, headers, signal, ...(body != null ? { body: JSON.stringify(body) } : {}) });
  if (res.ok) return res;
  const payload = await res.json().catch(() => ({}));
  if (res.status === 401 && payload?.error === "CLIENT_TOKEN_REQUIRED" && retry) {
    // Set aside, never deleted: its projects may come back, and an attachment presents it.
    retireClientToken();
    return workspaceFetch(path, { method, body, ifMatch, sessionId, retry: false, headers: extra, signal });
  }
  throw apiError(res.status, payload);
};

/** A 204 is {}. */
const wsRequest = async (path, options = {}) => {
  const res = await workspaceFetch(path, options);
  return res.status === 204 ? {} : res.json().catch(() => ({}));
};
export const workspaceJson = wsRequest;

const WP = (id) => `/projects/${encodeURIComponent(id)}`;

/** Summaries only, never the whole documents. */
export const listWorkspaceProjects = () => wsRequest("/projects");
export const createWorkspaceProject = (project) => wsRequest("/projects", { method: "POST", body: { project } });
export const getWorkspaceProject = (id) => wsRequest(WP(id));
/** `dataVersion` read last, or "*" to write over another writer; `actor` goes to the journal. */
export const patchWorkspaceProject = (id, project, dataVersion, { actor = null } = {}) => wsRequest(WP(id), { method: "PATCH", ifMatch: dataVersion, body: { project, ...(actor ? { actor } : {}) } });
export const deleteWorkspaceProject = (id) => wsRequest(WP(id), { method: "DELETE" });
export const bindWorkspaceSession = (id, sessionId = null) => wsRequest(`${WP(id)}/bind`, { method: "POST", sessionId });
/** Freezes, as the version's zip, the working copy that holds it (`sessionId`, else the tab's). */
export const freezeWorkspaceVersion = (id, version, sessionId = null) => wsRequest(`${WP(id)}/versions`, { method: "POST", body: { version }, sessionId });
export const deleteWorkspaceVersion = (id, versionId) => wsRequest(`${WP(id)}/versions/${encodeURIComponent(versionId)}`, { method: "DELETE" });
/** A new working copy from the version's zip → { sessionId, validationReport, counts, version }. */
export const restoreWorkspaceVersion = (id, versionId) => wsRequest(`${WP(id)}/versions/${encodeURIComponent(versionId)}/restore`, { method: "POST" });
export const keepWorkspaceDocument = (id, documentId) => wsRequest(`${WP(id)}/documents`, { method: "POST", body: { document_id: documentId } });
export const removeWorkspaceDocument = (id, documentId) => wsRequest(`${WP(id)}/documents/${encodeURIComponent(documentId)}`, { method: "DELETE" });
/** Moves the browser's projects to the account and gets a new token; a token set aside is presented too. */
export const attachWorkspaceToAccount = async () => {
  const previous = getPreviousClientToken();
  const out = await wsRequest("/attach", { method: "POST", headers: previous && previous !== getClientToken() ? { "X-Client-Token-Previous": previous } : {} });
  if (out?.token) setClientToken(out.token);
  // A previous token still unknown to the server stays aside for a later attachment.
  if (previous && out?.previous === true) clearPreviousClientToken();
  return out;
};

