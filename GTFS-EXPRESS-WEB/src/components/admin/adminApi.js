// adminApi.js — thin client for the admin dashboard.
// Stores the X-Admin-Token in localStorage (admin only — UA is the laptop
// of the operator running the dashboard, not an end user).

import API_BASE_URL from "../../config";

const TOKEN_KEY = "gtfs_admin_token";

export const getAdminToken = () => localStorage.getItem(TOKEN_KEY) || "";
export const setAdminToken = (token) => {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
};
export const clearAdminToken = () => localStorage.removeItem(TOKEN_KEY);

const adminFetch = async (path, options = {}) => {
  const token = getAdminToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Admin-Token": token,
      "Content-Type": "application/json",
    },
  });
  if (res.status === 401) {
    const err = new Error("Invalid admin token");
    err.status = 401;
    throw err;
  }
  if (res.status === 503) {
    const err = new Error(
      "Admin dashboard is disabled. ADMIN_TOKEN is not set on the API.",
    );
    err.status = 503;
    throw err;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

export const ping = (tokenOverride) =>
  fetch(`${API_BASE_URL}/admin/ping`, {
    headers: { "X-Admin-Token": tokenOverride ?? getAdminToken() },
  }).then((r) => {
    if (r.status === 401) throw Object.assign(new Error("invalid"), { status: 401 });
    if (r.status === 503) throw Object.assign(new Error("disabled"), { status: 503 });
    if (!r.ok) throw Object.assign(new Error("error"), { status: r.status });
    return r.json();
  });

export const fetchStats = (fresh = false) =>
  adminFetch(`/admin/stats${fresh ? "?fresh=1" : ""}`);

export const fetchActiveSessions = async () => {
  return adminFetch("/admin/active");
};

export const fetchActiveSessionsDetails = async () => {
  return adminFetch("/admin/sessions");
};

export const resetStats = () =>
  adminFetch("/admin/stats/reset", { method: "POST" });
