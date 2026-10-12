/**
 * readerApi — the reader's reads a step can make on its own (the Change Studio's reader at the centre of ③,
 * 2026-10-11): a line's directions on a date, and its timetable (stops and stop times), each read either from the
 * working copy or through the API's lens on a simulated draft (`previewId`: the header X-View-Preview the
 * previewLens answers; an explicit empty header reads the working copy whatever lens the reader holds —
 * sessionManager leaves a caller's own header as it is). GETs only: never an edit, never the engine.
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

/** The API's date: YYYYMMDD from YYYY-MM-DD (or already so). */
export const apiDate = (date) => String(date || "").replace(/-/g, "");

const lensOptions = (previewId, signal) => ({ headers: { "X-View-Preview": previewId || "" }, ...(signal ? { signal } : {}) });

const read = async (path, previewId, signal) => {
  const res = await fetchWithSession(`${API_BASE_URL}${path}`, lensOptions(previewId, signal));
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
};

/** The directions a line runs on a date: [{ direction_id, … }] (the API's list, empty when no service). */
export const fetchDirections = (route, date, { previewId = null, signal = null } = {}) => read(`/directions/${encodeURIComponent(route)}/${apiDate(date)}`, previewId, signal);

/** A line's timetable on a date, one direction: { stops, stop_times, frequency_info, has_frequencies, has_normal_times, wheelchair_accessible_trips, total_trips }. */
export const fetchTimetable = (route, direction, date, { previewId = null, signal = null } = {}) =>
  read(`/stops_and_times/${encodeURIComponent(route)}/${encodeURIComponent(direction)}/${apiDate(date)}`, previewId, signal);
