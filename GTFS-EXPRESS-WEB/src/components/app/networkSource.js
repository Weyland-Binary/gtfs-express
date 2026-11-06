/**
 * Where the network open in this tab came from (catalogue | upload | sample | version) and when it opened, kept next
 * to its handle in sessionStorage so it survives a reload: a project that modifies it records it as its reference's
 * origin.
 */
const NETWORK_SOURCE_KEY = "gtfs_network_source";
const NETWORK_SOURCES = Object.freeze(["catalogue", "upload", "sample", "version"]);
export const rememberNetworkSource = (id, source) => {
  try {
    sessionStorage.setItem(NETWORK_SOURCE_KEY, JSON.stringify({ id, source: NETWORK_SOURCES.includes(source) ? source : null, at: new Date().toISOString() }));
  } catch {
    /* storage disabled: the origin is unknown after a reload */
  }
};
/** nulls when this tab does not know it. */
export const networkSourceOf = (id) => {
  try {
    const kept = JSON.parse(sessionStorage.getItem(NETWORK_SOURCE_KEY) || "null");
    return kept && kept.id === id ? { source: kept.source || null, at: kept.at || null } : { source: null, at: null };
  } catch {
    return { source: null, at: null };
  }
};
