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
    /* quota exceeded */
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

export function loadCachedSchema(key) {
  try {
    const raw = window.sessionStorage.getItem(SCHEMA_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.key !== key) return null;
    return parsed.schema || null;
  } catch {
    return null;
  }
}

export function persistCachedSchema(key, schema) {
  try {
    window.sessionStorage.setItem(
      SCHEMA_CACHE_KEY,
      JSON.stringify({ key, schema, ts: Date.now() }),
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
