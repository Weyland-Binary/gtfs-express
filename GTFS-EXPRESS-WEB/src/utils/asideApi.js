/**
 * The rows of the open network that the import kept aside (a key missing, a duplicate key with other values): how many
 * there are by file, and how many are duplicates of a loaded row, read again after every edit. They stay in the GTFS
 * delivered as they were read until loaded or removed.
 */

import { useEffect, useState } from "react";
import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";
import { readRefusal } from "./refusalToAction";
import { useEditMode } from "../contexts/EditModeContext";

const NONE = Object.freeze({ total: 0, tables: Object.freeze({}), duplicates: 0 });

export async function fetchAsideSummary() {
  const res = await fetchWithSession(`${API_BASE_URL}/edit/aside?summary=1`);
  if (!res.ok) return NONE;
  const body = await res.json().catch(() => null);
  return body ? { total: Number(body.total) || 0, tables: body.tables || {}, duplicates: Number(body.duplicates) || 0 } : NONE;
}

/** { total, tables, duplicates } for the open network; none while it is unknown or no network is open. */
export function useAsideSummary(networkKey = null) {
  const { dataVersion } = useEditMode();
  const [summary, setSummary] = useState(NONE);
  // A report object stands for its counts: a parent that rebuilds it each render must not fetch each render.
  const key = networkKey && typeof networkKey === "object" ? `${JSON.stringify(networkKey.counts || {})}|${networkKey.engine_version || ""}` : networkKey;
  useEffect(() => {
    let alive = true;
    fetchAsideSummary()
      .then((s) => alive && setSummary(s))
      .catch(() => alive && setSummary(NONE));
    return () => {
      alive = false;
    };
  }, [dataVersion, key]);
  return summary;
}

const NO_GROUPS = Object.freeze({ groups: Object.freeze([]), total: 0, rows: 0 });

/**
 * The duplicates kept aside grouped by what they belong to (a trip, a shape, a service, else one key), each with the
 * values that differ from the copy the network shows: { groups, total, rows }. Read only while some exist.
 */
export function useDuplicateGroups(count) {
  const { dataVersion } = useEditMode();
  const [state, setState] = useState(NO_GROUPS);
  useEffect(() => {
    if (!count) {
      setState(NO_GROUPS);
      return undefined;
    }
    let alive = true;
    fetchWithSession(`${API_BASE_URL}/edit/aside/duplicates`)
      .then(async (res) => (res.ok ? res.json() : NO_GROUPS))
      .then((body) => alive && setState({ groups: Array.isArray(body?.groups) ? body.groups : [], total: Number(body?.total) || 0, rows: Number(body?.rows) || 0 }))
      .catch(() => alive && setState(NO_GROUPS));
    return () => {
      alive = false;
    };
  }, [count, dataVersion]);
  return state;
}

const post = async (url, body = {}) => {
  const res = await fetchWithSession(`${API_BASE_URL}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw await readRefusal(res);
  return res.json();
};

/** Removes one row kept aside (a trip with the calls that hung off it): { discarded, validation }. Edit mode. */
export const discardAsideRow = (id) => post(`/edit/aside/${encodeURIComponent(id)}/discard`);

/** Keeps the copies the network shows: the duplicates aside (`ids`, else every one) leave the GTFS. Edit mode. */
export const keepLoadedVersions = (ids = null) => post("/edit/aside/discard-duplicates", ids ? { ids } : {});

/** Uses the duplicates aside (`ids`, else every one) in place of the copies the network shows. Edit mode. */
export const takeDuplicateCopies = (ids = null) => post("/edit/aside/use-duplicates", ids ? { ids } : {});
