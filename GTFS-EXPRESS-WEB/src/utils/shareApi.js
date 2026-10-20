/**
 * shareApi — public shares of a feed.
 *
 *   createShare(title)     POST /share            (session)  → { token, expiresAt, card }
 *   fetchShareCard(token)  GET  /share/:token                → card | null
 *   openShare(token)       POST /share/:token/open           → { sessionId, validationReport, counts, share }
 *   shareUrl(token)        the app link that lands on the card (/partage/:token)
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

/**
 * Create a share of the current session's feed. `includeNames`: « inclure les acceptations nominatives » —
 * the names of the acknowledgements travel with the public copy only when ticked; the server removes them otherwise.
 */
export const createShare = async (title = null, { includeNames = false } = {}) => {
  const res = await fetchWithSession(`${API_BASE_URL}/share`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(title ? { title } : {}), ...(includeNames ? { include_names: true } : {}) }) });
  if (!res.ok) throw await asError(res);
  const data = await res.json();
  if (data.secret) rememberShare({ token: data.token, secret: data.secret, title: data.card?.title || "", createdAt: new Date().toISOString() });
  return data;
};

/** Publish the current session's feed as a new version of a share this browser created. */
export const publishShareVersion = async (token, secret, note = null, { includeNames = false } = {}) => {
  const res = await fetchWithSession(`${API_BASE_URL}/share/${encodeURIComponent(token)}/versions`, { method: "POST", headers: { "Content-Type": "application/json", "X-Share-Secret": secret }, body: JSON.stringify({ ...(note ? { note } : {}), ...(includeNames ? { include_names: true } : {}) }) });
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

// The landing's own address, /partage/<token> (French, fixed, never
// localised); older links are `/?share=<token>`, which the router still
// sends there. On the app's origin, never under the explorer URL the link
// was made from.
export const shareUrl = (token) => new URL(`/partage/${encodeURIComponent(token)}`, window.location.origin).toString();

export const shareZipUrl = (token) => `${API_BASE_URL}/share/${encodeURIComponent(token)}/gtfs.zip`;
