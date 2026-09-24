/**
 * documentsApi — passenger documents (print-ready HTML) of the loaded feed.
 *
 *   openTimetable(routeId, { date, lang })  → opens the line's timetable in a new tab
 *   openStopPoster(stopId, { date, lang })  → opens the stop's departure poster
 *
 * The document needs the session header, so it is fetched as a blob and
 * opened from an object URL (a plain link could not carry the header).
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

const openDocument = async (path, params) => {
  const url = new URL(`${API_BASE_URL}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);
  const res = await fetchWithSession(url.toString());
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const win = window.open(objectUrl, "_blank", "noopener");
  // Revoke later: the new tab needs the URL while it loads.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  return Boolean(win);
};

export const openTimetable = (routeId, { date = null, lang = "en" } = {}) => openDocument("/documents/timetable", { route_id: routeId, date, lang });
export const openStopPoster = (stopId, { date = null, lang = "en" } = {}) => openDocument("/documents/stop", { stop_id: stopId, date, lang });
export const timetableUrl = (routeId, { date = null, lang = "en" } = {}) => `${API_BASE_URL}/documents/timetable?route_id=${encodeURIComponent(routeId)}${date ? `&date=${date}` : ""}&lang=${lang}`;
