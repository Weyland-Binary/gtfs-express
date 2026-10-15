// adminApi.js — the operator console's client.
//
// Two ways in, as the API's adminGate takes them: the operator's own account (ADMIN_EMAILS), signed in by a code
// sent by e-mail and carried by the session cookie (every call sends the credentials), or the X-Admin-Token kept in
// this browser's localStorage (scripts, servers without accounts). The token is sent only when one is stored.

import API_BASE_URL from "../../config";
import { fetchWithSession } from "../../utils/sessionManager";

const TOKEN_KEY = "gtfs_admin_token";

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
};
export const getAdminToken = readToken;
export const setAdminToken = (token) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage refused: the account's cookie still works */
  }
};
export const clearAdminToken = () => setAdminToken("");

const failure = async (res) => {
  const body = await res.json().catch(() => ({}));
  const err = new Error(body.message || body.error || `HTTP ${res.status}`);
  err.status = res.status;
  err.code = typeof body.error === "string" && /^[A-Z][A-Z0-9_]+$/.test(body.error) ? body.error : null;
  err.body = body;
  return err;
};

const call = async (path, { method = "GET", body, token } = {}) => {
  const stored = token ?? readToken();
  let res;
  try {
    res = await fetchWithSession(`${API_BASE_URL}${path}`, {
      method,
      credentials: "include",
      headers: { ...(stored ? { "X-Admin-Token": stored } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    // fetchWithSession turns a 429 into an error of its own; anything else is the network.
    throw Object.assign(new Error(err.message || "The API cannot be reached."), { status: err.status || 0, code: err.status === 429 ? "RATE_LIMITED" : "NETWORK" });
  }
  if (!res.ok) throw await failure(res);
  return res.status === 204 ? null : res.json();
};

const qs = (params = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

// ── Who is signed in ──
export const fetchMe = (token) => call("/admin/me", { token });

// The operator's account: a code sent by e-mail, then checked (the session cookie is set by the API).
export const requestSignInCode = (email) => call("/auth/code", { method: "POST", body: { email, language: "en" }, token: "" });
// purpose « admin »: the server signs in an operator only, never creates an account for another address.
export const verifySignInCode = (email, code) => call("/auth/code/verify", { method: "POST", body: { email, code, purpose: "admin" }, token: "" });
export const signOutAccount = () => call("/auth/logout", { method: "POST", body: {}, token: "" });

// ── Screens ──
export const fetchOverview = (days) => call(`/admin/overview${qs({ days })}`);
export const fetchUsers = () => call("/admin/users");
export const fetchUser = (id) => call(`/admin/users/${encodeURIComponent(id)}`);
export const setUserEntitlements = (id, changes) => call(`/admin/users/${encodeURIComponent(id)}/entitlements`, { method: "POST", body: changes });
export const logoutUser = (id) => call(`/admin/users/${encodeURIComponent(id)}/logout`, { method: "POST", body: {} });
export const fetchAiUsage = (days) => call(`/admin/usage/ai${qs({ days })}`);
export const fetchApiUsage = (days) => call(`/admin/usage/api${qs({ days })}`);
export const fetchErrors = (days) => call(`/admin/errors${qs({ days })}`);
export const fetchBilling = () => call("/admin/billing");
export const fetchQuotes = () => call("/admin/quotes");
export const updateQuote = (id, patch) => call(`/admin/quotes/${encodeURIComponent(id)}`, { method: "PATCH", body: patch });
export const fetchProjects = () => call("/admin/projects");
export const fetchEvents = (params) => call(`/admin/events${qs(params)}`);
export const fetchAudit = () => call("/admin/audit");
export const fetchSessions = () => call("/admin/sessions");
export const endSession = (id) => call(`/admin/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
export const fetchTraffic = () => call("/admin/stats");
export const fetchActive = () => call("/admin/active");
export const fetchPerf = () => call("/admin/perf/sample");
export const resetPerf = () => call("/admin/perf/reset", { method: "POST", body: {} });
export const resetStats = () => call("/admin/stats/reset", { method: "POST", body: {} });
export const fetchMail = () => call("/admin/mail");
