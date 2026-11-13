/**
 * The session rides in the HttpOnly cookie `gtfs_session`, hence `credentials: "include"` on every call. Callers
 * reach these endpoints only once /config/features says `accounts.enabled`: before that, the API in development
 * refuses credentialed cross-origin requests. A failure throws `{ code, status, message, body }` for humanError().
 */

import { apiUrl, ensureOk, jsonHeaders, request as send, requestJson } from "./apiRequest";

const request = (path, { method = "GET", body = null } = {}) =>
  requestJson(apiUrl(path), { method, credentials: "include", headers: body != null ? jsonHeaders() : {}, ...(body != null ? { body: JSON.stringify(body) } : {}) }, { empty: null });

export const fetchMe = async () => {
  try {
    const body = await request("/auth/me");
    return body?.user || null;
  } catch (err) {
    if (err.status === 401 || err.code === "ACCOUNTS_DISABLED") return null;
    throw err;
  }
};

/** The same answer whether an account holds the address or not. */
export const requestCode = async (email, language = "fr") => request("/auth/code", { method: "POST", body: { email, language } });

/** Sets the session cookie; the first code creates the account. */
export const verifyCode = async (email, code) => {
  const body = await request("/auth/code/verify", { method: "POST", body: { email, code } });
  return { user: body?.user || null, created: Boolean(body?.created) };
};

/** `display_name`: the name the account's acts are signed with; null clears it. */
export const updateMe = async ({ display_name }) => {
  const body = await request("/auth/me", { method: "PATCH", body: { display_name } });
  return body?.user || null;
};

export const logout = async ({ everywhere = false } = {}) => {
  await request("/auth/logout", { method: "POST", ...(everywhere ? { body: { everywhere: true } } : {}) });
  return null;
};


const fileNameOf = (res) => {
  const m = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
  return m ? m[1] : `gtfs-express-mes-donnees-${new Date().toISOString().slice(0, 10)}.json`;
};

export const exportMyData = async () => {
  const res = await ensureOk(await send(apiUrl("/auth/me/export"), { method: "GET", credentials: "include", headers: {} }));
  return { blob: await res.blob(), filename: fileNameOf(res) };
};

/** `confirm`: the typed e-mail; 409 ACCOUNT_PROJECTS_SHARED lists the projects to hand over first. */
export const deleteMyAccount = async (confirm) => request("/auth/me", { method: "DELETE", body: { confirm } });

export const handOverProject = async (projectId, userId) => request(`/workspace/projects/${encodeURIComponent(projectId)}/owner`, { method: "POST", body: { user_id: userId } });
