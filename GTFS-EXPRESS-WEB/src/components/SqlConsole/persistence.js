/* ------------------------------------------------------------------ */
/* localStorage / sessionStorage helpers for query history, user      */
/* presets, and per-session schema cache.                              */
/* ------------------------------------------------------------------ */

import {
  HISTORY_KEY,
  USER_PRESETS_KEY,
  SCHEMA_CACHE_KEY,
} from "./constants";

export function loadHistory() {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveHistory(items) {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(items));
  } catch {
    /* quota exceeded — silently ignore */
  }
}

export function loadUserPresets() {
  try {
    const raw = window.localStorage.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveUserPresets(items) {
  try {
    window.localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(items));
  } catch {
    /* ignore */
  }
}

export function loadCachedSchema(sessionId) {
  try {
    const raw = window.sessionStorage.getItem(SCHEMA_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.sessionId !== sessionId) return null;
    return parsed.schema || null;
  } catch {
    return null;
  }
}

export function persistCachedSchema(sessionId, schema) {
  try {
    window.sessionStorage.setItem(
      SCHEMA_CACHE_KEY,
      JSON.stringify({ sessionId, schema, ts: Date.now() }),
    );
  } catch {
    /* ignore */
  }
}

export function invalidateCachedSchema() {
  try {
    window.sessionStorage.removeItem(SCHEMA_CACHE_KEY);
  } catch {
    /* ignore */
  }
}
