/**
 * featuresApi — Cache + fetch helper for GET /gtfs/config/features.
 *
 * The features endpoint is intentionally light: a single GET that returns
 * server-side flags (NL2SQL kill-switch + model name today). We hit it once
 * at boot, cache the response in module memory, and reuse it across all
 * consumers. The `useFeatures()` hook below returns a `{features, loaded}`
 * tuple so consumers can render a skeleton during the (very brief) load.
 *
 * Defaults — when the request fails or before it lands — are conservative
 * (everything OFF). This guarantees the UI never flickers a button that
 * would 503 on click.
 */

import { useEffect, useState } from "react";
import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

export const DEFAULT_FEATURES = Object.freeze({
  nl2sql: { enabled: false, model: null },
  chat: { enabled: false, model: null },
});

let cachedFeatures = null;
let inflight = null;

/**
 * Fetch features from the API. Memoizes both the result and the in-flight
 * promise (so concurrent callers don't fan out).
 */
export const fetchFeatures = () => {
  if (cachedFeatures) return Promise.resolve(cachedFeatures);
  if (inflight) return inflight;
  inflight = fetchWithSession(`${API_BASE_URL}/config/features`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`features fetch ${res.status}`);
      const body = await res.json();
      // Defensive merge — if the server adds new flags later, missing
      // ones still default to false instead of undefined.
      cachedFeatures = {
        ...DEFAULT_FEATURES,
        ...body,
        nl2sql: { ...DEFAULT_FEATURES.nl2sql, ...(body?.nl2sql || {}) },
        chat: { ...DEFAULT_FEATURES.chat, ...(body?.chat || {}) },
      };
      return cachedFeatures;
    })
    .catch((err) => {
      console.warn("features fetch failed, using defaults:", err);
      cachedFeatures = { ...DEFAULT_FEATURES };
      return cachedFeatures;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
};

/**
 * Synchronous accessor — returns the cached value or `null` if not yet
 * loaded. Used by code paths that already check `loaded` (e.g. button
 * gating in the parent component) and don't want a re-render loop.
 */
export const getCachedFeatures = () => cachedFeatures;

/**
 * React hook — fetch on mount, return `{features, loaded}`.
 * `features` is always non-null (defaults until the request lands).
 * `loaded` flips to true once the request resolves (success OR failure —
 * either way we have the canonical values cached).
 */
export const useFeatures = () => {
  const [state, setState] = useState(() => ({
    features: cachedFeatures || DEFAULT_FEATURES,
    loaded: Boolean(cachedFeatures),
  }));

  useEffect(() => {
    if (cachedFeatures) {
      // Already loaded earlier in this session — sync state and bail.
      setState({ features: cachedFeatures, loaded: true });
      return;
    }
    let cancelled = false;
    fetchFeatures().then((f) => {
      if (!cancelled) setState({ features: f, loaded: true });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
};
