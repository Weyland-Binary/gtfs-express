import { apiUrl, jsonHeaders, post, requestJson } from "./apiRequest";
import { noteImport } from "./importNotes";
import { READ_FIRST_HEADERS, beginTimetables } from "./timetablesLoading";

/** `light`: found from the place alone, the fast path of "find my network". */
// The catalogue and the feed it opens belong to no working copy: no session is sent.
export const fetchCatalog = (place, { light = false, signal } = {}) =>
  requestJson(apiUrl(`/network/catalog?place=${encodeURIComponent(place)}${light ? "&light=1" : ""}`), { headers: jsonHeaders(), withSession: false, ...(signal ? { signal } : {}) });

/** A new session holding the feed as published: every trip, variant and exception kept. */
export const openCatalogFeed = async (url, { name = null, place = null, headers = null } = {}) => {
  const opened = await post("/network/catalog/open", { url, ...(name ? { name } : {}), ...(place ? { place } : {}) }, { withSession: false, headers: { ...READ_FIRST_HEADERS, ...(headers || {}) } });
  noteImport(opened?.sessionId, opened?.meta);
  // A large network is read before its stop times are in: their load is followed from here.
  if (opened?.timetables?.loading) beginTimetables(opened.sessionId);
  return opened;
};
