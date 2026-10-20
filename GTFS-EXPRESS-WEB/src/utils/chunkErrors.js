/**
 * chunkErrors — a stale lazy chunk after a deploy.
 *
 * The screens are lazy chunks with hashed names (`SqlConsole-3f9a….js`). A
 * tab opened before a deploy still asks for the OLD names, which the new
 * build no longer serves: the dynamic import rejects ("Failed to fetch
 * dynamically imported module" in Chromium, "Importing a module script
 * failed" in Safari, "error loading dynamically imported module" in
 * Firefox). A retry cannot help — React.lazy keeps the rejected promise —
 * only a reload, which reads the new index.html and its new chunk names.
 *
 *   isChunkLoadError(err)      — is this the failure of a lazy chunk?
 *   reloadOnceForStaleChunk()  — reloads the page, at most once per
 *                                RELOAD_WINDOW_MS (sessionStorage stamp), so a
 *                                chunk really missing on the server never
 *                                turns into a reload loop. Returns whether it
 *                                reloaded.
 *   reloadPage()               — the plain reload (the error boundary's button).
 */

const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

/** The failure of a lazy chunk (an Error, a string, or Vite's `vite:preloadError` payload). */
export const isChunkLoadError = (err) => {
  if (!err) return false;
  const message = typeof err === "string" ? err : err.message || String(err);
  // Vite's preload helper and some bundlers name the error itself.
  return CHUNK_ERROR_RE.test(message) || err.name === "ChunkLoadError";
};

export const RELOAD_STAMP_KEY = "gtfs:chunk-reload-at";
// A reload that lands on the same failure within this window is not tried
// again: the chunk is missing for good (a broken deploy), the boundary's
// message says so instead of the page reloading forever.
export const RELOAD_WINDOW_MS = 10000;

export const reloadPage = () => window.location.reload();

/**
 * Reloads the page once for a stale chunk. `storage` / `now` / `reload` are
 * injectable (tests). Without a usable sessionStorage (blocked, private
 * mode) nothing guards against a loop: no automatic reload then, the
 * boundary offers the button.
 */
export const reloadOnceForStaleChunk = ({
  storage = (() => {
    try {
      return window.sessionStorage;
    } catch {
      return null;
    }
  })(),
  now = Date.now(),
  reload = reloadPage,
} = {}) => {
  if (!storage) return false;
  try {
    const last = Number(storage.getItem(RELOAD_STAMP_KEY));
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_WINDOW_MS) return false;
    storage.setItem(RELOAD_STAMP_KEY, String(now));
  } catch {
    // Storage refused the stamp: no guard against a loop, no automatic reload.
    return false;
  }
  reload();
  return true;
};
