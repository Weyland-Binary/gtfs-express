/**
 * shareApi — public shares of a feed.
 *
 *   createShare(title)     POST /share            (session)  → { token, expiresAt, card }
 *   fetchShareCard(token)  GET  /share/:token                → card | null
 *   openShare(token)       POST /share/:token/open           → { sessionId, validationReport, counts, share }
 *   shareUrl(token)        the app link that lands on the card
 *   shareZipUrl(token)     the hosted GTFS zip
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

const asError = async (res) => {
  const data = await res.json().catch(() => ({}));
  const err = new Error(data.message || data.error || `HTTP ${res.status}`);
  err.code = data.error || `HTTP_${res.status}`;
  err.status = res.status;
  return err;
};

const SHARES_KEY = "gtfs:shares";

/** The shares this browser created (token, secret, title) — the secret lets it publish new versions. */
export const rememberedShares = () => {
  try {
    const raw = localStorage.getItem(SHARES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((s) => s && s.token && s.secret) : [];
  } catch {
    return [];
  }
};
const rememberShare = (entry) => {
  try {
    const list = rememberedShares().filter((s) => s.token !== entry.token);
    list.unshift(entry);
    localStorage.setItem(SHARES_KEY, JSON.stringify(list.slice(0, 20)));
  } catch {
    /* storage disabled */
  }
};
export const forgetShare = (token) => {
  try {
    localStorage.setItem(SHARES_KEY, JSON.stringify(rememberedShares().filter((s) => s.token !== token)));
  } catch {
    /* storage disabled */
  }
};

export const createShare = async (title = null) => {
  const res = await fetchWithSession(`${API_BASE_URL}/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(title ? { title } : {}) });
  if (!res.ok) throw await asError(res);
  const data = await res.json();
  if (data.secret) rememberShare({ token: data.token, secret: data.secret, title: data.card?.title || "", createdAt: new Date().toISOString() });
  return data;
};

/** Publish the current session's feed as a new version of a share this browser created. */
export const publishShareVersion = async (token, secret, note = null) => {
  const res = await fetchWithSession(`${API_BASE_URL}/share/${encodeURIComponent(token)}/versions`, { method: "POST", headers: { "Content-Type": "application/json", "X-Share-Secret": secret }, body: JSON.stringify(note ? { note } : {}) });
  if (!res.ok) throw await asError(res);
  return res.json();
};

export const fetchShareCard = async (token) => {
  const res = await fetch(`${API_BASE_URL}/share/${encodeURIComponent(token)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw await asError(res);
  return res.json();
};

export const openShare = async (token) => {
  const res = await fetch(`${API_BASE_URL}/share/${encodeURIComponent(token)}/open`, { method: "POST" });
  if (!res.ok) throw await asError(res);
  return res.json();
};

export const shareUrl = (token) => {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("share", token);
  return url.toString();
};

export const shareZipUrl = (token) => `${API_BASE_URL}/share/${encodeURIComponent(token)}/gtfs.zip`;

/** The share token in the current URL, when the page was opened from a link. */
export const shareTokenFromLocation = () => {
  try {
    const v = new URLSearchParams(window.location.search).get("share");
    return v && /^[a-f0-9]{20}$/.test(v) ? v : null;
  } catch {
    return null;
  }
};

export const clearShareFromLocation = () => {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("share");
    window.history.replaceState(window.history.state || {}, "", url.toString());
  } catch {
    /* no history API */
  }
};
