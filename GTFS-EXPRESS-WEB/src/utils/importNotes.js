/**
 * What the import said of a network's files when it opened: the files it could not read as UTF-8 and read as
 * Windows-1252, and the UTF-8 files of which a few bytes alone were read so (`strays`, their number). Kept by working
 * copy for the tab, a reload included, so that the validation report's notices name them.
 */

const keyOf = (sessionId) => `gtfs:import-notes:${sessionId}`;

/** Keeps what an opening's answer says (the `meta` of an upload or of a published feed's opening) for its session. */
export const noteImport = (sessionId, meta) => {
  if (!sessionId) return;
  const files = (Array.isArray(meta?.encodingFallbacks) ? meta.encodingFallbacks : []).filter((f) => f && typeof f.fileName === "string").map((f) => ({ fileName: f.fileName, encoding: String(f.encoding || ""), ...(Number.isInteger(f.strays) && f.strays > 0 ? { strays: f.strays } : {}) }));
  try {
    if (files.length > 0) sessionStorage.setItem(keyOf(sessionId), JSON.stringify({ encodingFallbacks: files }));
    else sessionStorage.removeItem(keyOf(sessionId));
  } catch {
    // Storage refused (private mode, quota): the notice is not shown.
  }
};

/** The files of that working copy not read as UTF-8 whole: [{ fileName, encoding, strays? }], [] when none. */
export const encodingFallbacksOf = (sessionId) => {
  if (!sessionId) return [];
  try {
    const files = JSON.parse(sessionStorage.getItem(keyOf(sessionId)) || "null")?.encodingFallbacks;
    return Array.isArray(files) ? files : [];
  } catch {
    return [];
  }
};
