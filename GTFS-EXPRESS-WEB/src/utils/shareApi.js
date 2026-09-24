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

export const createShare = async (title = null) => {
  const res = await fetchWithSession(`${API_BASE_URL}/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(title ? { title } : {}) });
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
