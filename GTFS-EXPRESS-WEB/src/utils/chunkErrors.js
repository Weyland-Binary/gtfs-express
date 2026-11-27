/**
 * A tab opened before a deploy asks for hashed chunk names the new build no longer serves. A retry cannot help
 * (React.lazy keeps the rejected promise): only a reload reads the new index.html.
 */

const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i;

/** `err`: an Error, a string, or Vite's `vite:preloadError` payload. */
export const isChunkLoadError = (err) => {
  if (!err) return false;
  const message = typeof err === "string" ? err : err.message || String(err);
  return CHUNK_ERROR_RE.test(message) || err.name === "ChunkLoadError";
};

export const RELOAD_STAMP_KEY = "gtfs:chunk-reload-at";
// The same failure within this window means the chunk is missing for good: the boundary says so instead of the
// page reloading forever.
export const RELOAD_WINDOW_MS = 10000;

export const reloadPage = () => window.location.reload();

/** Without a usable sessionStorage nothing guards against a loop, so no automatic reload then. Returns whether it reloaded. */
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
    return false;
  }
  reload();
  return true;
};
