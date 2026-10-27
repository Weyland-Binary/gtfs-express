import { apiUrl, jsonHeaders, post, requestJson } from "./apiRequest";

/** `light`: found from the place alone, the fast path of "find my network". */
// The catalogue and the feed it opens belong to no working copy: no session is sent.
export const fetchCatalog = (place, { light = false, signal } = {}) =>
  requestJson(apiUrl(`/network/catalog?place=${encodeURIComponent(place)}${light ? "&light=1" : ""}`), { headers: jsonHeaders(), withSession: false, ...(signal ? { signal } : {}) });

/** A new session holding the feed as published: every trip, variant and exception kept. */
export const openCatalogFeed = (url, { name = null, place = null, headers = null } = {}) => post("/network/catalog/open", { url, ...(name ? { name } : {}), ...(place ? { place } : {}) }, { withSession: false, headers });
