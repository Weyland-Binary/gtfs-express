import API_BASE_URL from "../config";
import { apiUrl, jsonHeaders, readJson, request, requestJson } from "./apiRequest";

const SHARES_KEY = "gtfs:shares";

/** The shares this browser created; their secret lets it publish new versions. */
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

/** The acknowledgements' names travel with the public copy only with `includeNames`; the server removes them otherwise. */
export const createShare = async (title = null, { includeNames = false } = {}) => {
  const data = await requestJson(apiUrl("/share"), { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ ...(title ? { title } : {}), ...(includeNames ? { include_names: true } : {}) }) });
  if (data.secret) rememberShare({ token: data.token, secret: data.secret, title: data.card?.title || "", createdAt: new Date().toISOString() });
  return data;
};

export const publishShareVersion = (token, secret, note = null, { includeNames = false } = {}) =>
  requestJson(apiUrl(`/share/${encodeURIComponent(token)}/versions`), { method: "POST", headers: { ...jsonHeaders(), "X-Share-Secret": secret }, body: JSON.stringify({ ...(note ? { note } : {}), ...(includeNames ? { include_names: true } : {}) }) });

// A share's page is read by any visitor, and opening it makes a new session: neither belongs to the current one.
export const fetchShareCard = async (token) => {
  const res = await request(apiUrl(`/share/${encodeURIComponent(token)}`), { withSession: false });
  if (res.status === 404) return null;
  return readJson(res);
};

export const openShare = (token) => requestJson(apiUrl(`/share/${encodeURIComponent(token)}/open`), { method: "POST", withSession: false });

// The slug /partage is fixed, never localised; built on the app's origin,
// never under the address the link was made from.
export const shareUrl = (token) => new URL(`/partage/${encodeURIComponent(token)}`, window.location.origin).toString();

export const shareZipUrl = (token) => `${API_BASE_URL}/share/${encodeURIComponent(token)}/gtfs.zip`;
