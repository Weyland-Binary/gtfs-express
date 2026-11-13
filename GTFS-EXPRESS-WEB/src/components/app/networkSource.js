/**
 * Where the network open in this tab came from (catalogue | upload | sample | version), when it opened and its content
 * fingerprint (the server's), kept next to its handle in sessionStorage so it survives a reload: a project that
 * modifies it records them as its reference's.
 */
const NETWORK_SOURCE_KEY = "gtfs_network_source";
const NETWORK_SOURCES = Object.freeze(["catalogue", "upload", "sample", "version"]);
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
export const rememberNetworkSource = (id, source, { fingerprint = null } = {}) => {
  try {
    sessionStorage.setItem(NETWORK_SOURCE_KEY, JSON.stringify({ id, source: NETWORK_SOURCES.includes(source) ? source : null, at: new Date().toISOString(), fingerprint: FINGERPRINT_RE.test(String(fingerprint || "")) ? fingerprint : null }));
  } catch {
    /* storage disabled: the origin is unknown after a reload */
  }
};
/** nulls when this tab does not know it. */
export const networkSourceOf = (id) => {
  try {
    const kept = JSON.parse(sessionStorage.getItem(NETWORK_SOURCE_KEY) || "null");
    return kept && kept.id === id ? { source: kept.source || null, at: kept.at || null, fingerprint: kept.fingerprint || null } : { source: null, at: null, fingerprint: null };
  } catch {
    return { source: null, at: null, fingerprint: null };
  }
};
