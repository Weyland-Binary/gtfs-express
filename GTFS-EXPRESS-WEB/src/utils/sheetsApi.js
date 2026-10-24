/**
 * The stop sheets' requests. The server computes the sheets (columns by day type, notes, next stops, checks); the
 * browser lays them out and prints them. A batch goes in requests of BATCH stops (the server takes 200 at most).
 */

import API_BASE_URL from "../config";
import { jsonHeaders, requestJson } from "./apiRequest";

export const BATCH = 100;

export const getSheetsSetup = ({ region = null, signal } = {}) => {
  const q = region ? `?region=${encodeURIComponent(region)}` : "";
  return requestJson(`${API_BASE_URL}/documents/sheets/setup${q}`, { signal });
};

const postJson = (path, body, signal) => requestJson(`${API_BASE_URL}${path}`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify(body), signal });

/** The sheets of `stopIds` over { from, to } in `lang` (`routeId`: that line alone): one answer, its `sheets` in the order asked. */
export const getSheets = async ({ stopIds, routeId = null, from = null, to = null, lang, region = null, signal, onProgress = null }) => {
  let head = null;
  const sheets = [];
  for (let i = 0; i < stopIds.length; i += BATCH) {
    const part = await postJson("/documents/sheets", { stop_ids: stopIds.slice(i, i + BATCH), route_id: routeId, from, to, lang, region }, signal);
    if (!head) head = part;
    sheets.push(...(part.sheets || []));
    if (onProgress) onProgress(Math.min(stopIds.length, i + BATCH), stopIds.length);
  }
  return { ...(head || {}), sheets };
};

/** The day classes of the period and the names kept for them. */
export const getSheetCalendar = ({ from = null, to = null, lang, region = null, signal } = {}) => {
  const q = new URLSearchParams();
  if (from) q.set("from", from);
  if (to) q.set("to", to);
  if (lang) q.set("lang", lang);
  if (region) q.set("region", region);
  return requestJson(`${API_BASE_URL}/documents/sheets/calendar?${q}`, { signal });
};
/** The names as the person leaves them: the whole list replaces the one kept. */
export const putSheetCalendar = ({ periods, holidays, from = null, to = null, lang, region = null, signal } = {}) => requestJson(`${API_BASE_URL}/documents/sheets/calendar`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ periods, holidays, from, to, lang, region }), signal });
/** The model names the blocks and holidays the network shows; its proposals wait unconfirmed. */
export const suggestSheetCalendar = ({ from = null, to = null, lang, region = null, signal } = {}) => postJson("/documents/sheets/calendar/suggest", { from, to, lang, region }, signal);

/** On a draft, the stops whose sheet the draft changes: { draft, changed: [{ stop_id, added, removed, lines }] }. */
export const getSheetChanges = ({ from = null, to = null, signal } = {}) => postJson("/documents/sheets/changes", { from, to }, signal);
