/**
 * accountApi — the user-account endpoints (ACCOUNTS_ENABLED on the API).
 *
 *   fetchMe()                      → user | null (not signed in, or accounts off)
 *   requestCode(email, language)   → { sent, expires_in_s, resend_after_s }: a six-digit code sent by e-mail
 *   verifyCode(email, code)        → { user, created }: the session opened (the first code creates the account)
 *   updateMe({ display_name })     → user
 *   logout({ everywhere })         → null (every device of the account with `everywhere`)
 *   exportMyData()                → { blob, filename }: the account's data as JSON (GET /auth/me/export)
 *   deleteMyAccount(confirm)       → { deleted, …counts } (DELETE /auth/me, the e-mail typed in `confirm`;
 *                                    409 ACCOUNT_PROJECTS_SHARED carries `projects` to hand over first)
 *   handOverProject(id, userId)    → { project }: a project the account holds, handed over to a member
 *
 * No password: the code verifies the address itself; the licence
 * (`user.licence`) says what the account may modify.
 *
 * The session rides in the HttpOnly cookie `gtfs_session`, so every call
 * sends `credentials: "include"`: same-origin in production (/api/gtfs) and
 * cross-origin in development (VITE_API_BASE_URL), where the API answers
 * with Access-Control-Allow-Credentials once ACCOUNTS_ENABLED is on. The
 * callers only reach these endpoints after GET /config/features said
 * `accounts.enabled`, so a credentialed request never hits an API that
 * refuses credentials.
 *
 * A failed call throws an Error carrying `{ code, status, message, body }`
 * in the shape humanError() reads.
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

const apiError = (status, body) => {
  const err = new Error(body?.message || body?.error || `HTTP ${status}`);
  err.status = status;
  err.code = typeof body?.error === "string" ? body.error : null;
  err.body = body || null;
  return err;
};

const request = async (path, { method = "GET", body = null } = {}) => {
  const options = { method, credentials: "include", headers: {} };
  if (body != null) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const res = await fetchWithSession(`${API_BASE_URL}${path}`, options);
  if (res.status === 204) return null;
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw apiError(res.status, payload);
  return payload;
};

/** The signed-in user, or null when nobody is signed in or accounts are off. */
export const fetchMe = async () => {
  try {
    const body = await request("/auth/me");
    return body?.user || null;
  } catch (err) {
    if (err.status === 401 || err.code === "ACCOUNTS_DISABLED") return null;
    throw err;
  }
};

/** Ask a sign-in code for an address (the same answer whether an account holds it or not). */
export const requestCode = async (email, language = "fr") => request("/auth/code", { method: "POST", body: { email, language } });

/** Check the code: the session cookie is set; → { user, created }. */
export const verifyCode = async (email, code) => {
  const body = await request("/auth/code/verify", { method: "POST", body: { email, code } });
  return { user: body?.user || null, created: Boolean(body?.created) };
};

/** The name the account's acts are signed with (null clears it). */
export const updateMe = async ({ display_name }) => {
  const body = await request("/auth/me", { method: "PATCH", body: { display_name } });
  return body?.user || null;
};

export const logout = async ({ everywhere = false } = {}) => {
  await request("/auth/logout", { method: "POST", ...(everywhere ? { body: { everywhere: true } } : {}) });
  return null;
};


/** The file name the server gives the export (Content-Disposition), else a dated one. */
const fileNameOf = (res) => {
  const m = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
  return m ? m[1] : `gtfs-express-mes-donnees-${new Date().toISOString().slice(0, 10)}.json`;
};

/** The account's data as a JSON file, ready to save: { blob, filename }. */
export const exportMyData = async () => {
  const res = await fetchWithSession(`${API_BASE_URL}/auth/me/export`, { method: "GET", credentials: "include", headers: {} });
  if (!res.ok) throw apiError(res.status, await res.json().catch(() => ({})));
  return { blob: await res.blob(), filename: fileNameOf(res) };
};

/** Delete the account (the e-mail typed confirms it). */
export const deleteMyAccount = async (confirm) => request("/auth/me", { method: "DELETE", body: { confirm } });

/** Hand a project the account holds over to one of its members (before deleting the account). */
export const handOverProject = async (projectId, userId) => request(`/workspace/projects/${encodeURIComponent(projectId)}/owner`, { method: "POST", body: { user_id: userId } });
