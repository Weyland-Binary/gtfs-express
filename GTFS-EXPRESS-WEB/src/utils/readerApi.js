/**
 * Read-only reader requests (a line's directions and timetable on a date), from the working copy or through
 * the API's preview lens (`previewId` → X-View-Preview). An explicit empty header reads the working copy
 * whatever lens the reader holds: sessionManager keeps a caller's own header.
 */

import API_BASE_URL from "../config";
import { getSessionId } from "./sessionManager";
import { requestJson } from "./apiRequest";

export const apiDate = (date) => String(date || "").replace(/-/g, "");

// Without a preview, name the working copy's session: the screen may be working in its draft's session.
const lensOptions = (previewId, signal) => ({ headers: { "X-View-Preview": previewId || "", ...(previewId ? {} : { "X-Session-ID": getSessionId() }) }, ...(signal ? { signal } : {}) });

const read = (path, previewId, signal) => requestJson(`${API_BASE_URL}${path}`, lensOptions(previewId, signal));

/** [{ direction_id, … }], empty when the line has no service that day. */
export const fetchDirections = (route, date, { previewId = null, signal = null } = {}) => read(`/directions/${encodeURIComponent(route)}/${apiDate(date)}`, previewId, signal);

export const fetchTimetable = (route, direction, date, { previewId = null, signal = null } = {}) =>
  read(`/stops_and_times/${encodeURIComponent(route)}/${encodeURIComponent(direction)}/${apiDate(date)}`, previewId, signal);
