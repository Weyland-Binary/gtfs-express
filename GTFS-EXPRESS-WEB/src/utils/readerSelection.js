/**
 * The reader's selection (agency, line, direction, date), one for every screen of a network: the reader publishes it,
 * the sheets, the offer and the studio read it when they open and ask the reader to change it, and the address
 * carries it (`ligne`, `sens`, `jour`, and `agence` when the feed has several), so a link shows exactly what one sees.
 */
import { useEffect, useState } from "react";
import { NAVIGATE_EVENT } from "./appEvents";

const EMPTY = Object.freeze({ agencyId: "", routeId: "", directionId: "", date: "" });
let current = EMPTY;
const listeners = new Set();

export const readerSelection = () => current;

export const onReaderSelection = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** The day the reader shows ("YYYY-MM-DD"), followed as it changes; today here while the reader has none. */
export const useReaderDay = () => {
  const [date, setDate] = useState(() => current.date);
  useEffect(() => {
    setDate(current.date);
    return onReaderSelection((sel) => setDate(sel.date));
  }, []);
  return date || localToday();
};

const normalise = (sel) => ({ agencyId: String(sel.agencyId || ""), routeId: String(sel.routeId || ""), directionId: sel.directionId == null ? "" : String(sel.directionId), date: String(sel.date || "") });

/** The reader says what it shows. */
export const publishReaderSelection = (next) => {
  const merged = normalise(next);
  if (merged.agencyId === current.agencyId && merged.routeId === current.routeId && merged.directionId === current.directionId && merged.date === current.date) return;
  current = merged;
  listeners.forEach((fn) => fn(current));
};

/** Another screen asks the reader to show this; what it leaves out is kept. */
export const selectInReader = ({ routeId = null, agencyId = null, directionId = null, date = null } = {}) =>
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: { target: "select", routeId, agencyId, directionId, date } }));

/**
 * The direction shown as the feed writes it in direction_id, "" for any other: one read from its trips' stops
 * (`inferred`), the trips writing none (`null`), or one the directions held do not name.
 */
export const writtenDirectionOf = (directions, shown) => {
  const direction = (directions || []).find((d) => d.direction_id !== null && String(d.direction_id) === String(shown));
  return direction && !direction.inferred ? String(shown) : "";
};

/** Whether `iso` ("YYYY-MM-DD") names a day of the calendar: "2026-13-45" would roll over to another one. */
export const isRealDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return false;
  const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return day.getFullYear() === Number(m[1]) && day.getMonth() === Number(m[2]) - 1 && day.getDate() === Number(m[3]);
};

/** The selection an address carries; a date that names no day is left out. */
export const selectionFromSearch = (search) => {
  const q = new URLSearchParams(search || "");
  const date = q.get("jour") || "";
  const dir = q.get("sens");
  return { agencyId: q.get("agence") || "", routeId: q.get("ligne") || "", directionId: dir === "0" || dir === "1" ? dir : "", date: isRealDay(date) ? date : "" };
};

/** The address's search with this selection written in; the agency only when the feed has several. */
export const searchWithSelection = (search, sel, { withAgency = false } = {}) => {
  const q = new URLSearchParams(search || "");
  const set = (key, value) => (value ? q.set(key, value) : q.delete(key));
  set("agence", withAgency ? sel.agencyId : "");
  set("ligne", sel.routeId);
  set("sens", sel.routeId ? sel.directionId : "");
  set("jour", sel.date);
  const s = q.toString();
  return s ? `?${s}` : "";
};

/** For tests. */
export const _resetReaderSelection = () => {
  current = EMPTY;
};
