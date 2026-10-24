/**
 * A line's timetable, print-ready HTML (the stop sheets are utils/sheetsApi). It needs the session header, which a
 * plain link cannot carry, so it is fetched as a blob and opened from an object URL.
 */

import API_BASE_URL from "../config";
import { ensureOk, request } from "./apiRequest";

const openDocument = async (path, params) => {
  const url = new URL(`${API_BASE_URL}${path}`, window.location.origin);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);
  const res = await ensureOk(await request(url.toString()));
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const win = window.open(objectUrl, "_blank", "noopener");
  // Revoke later: the new tab needs the URL while it loads.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  return Boolean(win);
};

export const openTimetable = (routeId, { date = null, lang = "en" } = {}) => openDocument("/documents/timetable", { route_id: routeId, date, lang });
