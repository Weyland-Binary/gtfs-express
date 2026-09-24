/**
 * networkStudioApi — client of the Network Studio endpoints.
 *
 *   validateSpec(spec)            POST /network/validate
 *   estimateSpec(spec)            POST /network/estimate   (routed geometry)
 *   geocodeQuery(query, near)     POST /network/geocode
 *   compileSpec(spec, options)    POST /network/compile    → a new session
 *   streamPlan({...})             POST /network/plan       (SSE)
 *
 * None of them needs a session; the studio runs before a feed exists. The
 * beta code (when present) rides along so the planner and the compiler
 * apply the paid-plan limits.
 */

import API_BASE_URL from "../config";
import { BETA_CODE_STORAGE_KEY } from "../components/edit/BetaGateDialog";
import { fetchWithSession } from "./sessionManager";

const betaHeaders = () => {
  const h = { "Content-Type": "application/json" };
  try {
    const code = localStorage.getItem(BETA_CODE_STORAGE_KEY);
    if (code) h["X-Beta-Code"] = code;
  } catch {
    /* storage disabled */
  }
  return h;
};

const post = async (path, body) => {
  const res = await fetch(`${API_BASE_URL}${path}`, { method: "POST", headers: betaHeaders(), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.code = data.error || `HTTP_${res.status}`;
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
};

export const validateSpec = (spec) => post("/network/validate", { spec });
export const estimateSpec = (spec, routing = null) => post("/network/estimate", { spec, ...(routing ? { routing } : {}) });
export const geocodeQuery = (query, near = null, lang = null) => post("/network/geocode", { query, near, lang, limit: 5 });
export const compileSpec = (spec, options = {}) => post("/network/compile", { spec, options });
export const fetchTerritory = (place, force = false) => post("/network/territory", { place, force });
export const fetchCoverage = (spec, place) => post("/network/coverage", { spec, place });
/** The design quality report of a plan; `geometry` is the studio's routed lines ([{lineId, directionId, distance_km, running_min}]). */
export const evaluateSpec = (spec, place = null, geometry = null) => post("/network/evaluate", { spec, place, geometry });
/** Snap the planned stops onto the territory's existing stops and fill the long gaps. */
export const refineSpec = (spec, place) => post("/network/refine", { spec, place });
/** The public GTFS feeds covering a place (Mobility Database catalog). */
export const fetchCatalog = async (place) => {
  const res = await fetch(`${API_BASE_URL}/network/catalog?place=${encodeURIComponent(place)}`, { headers: betaHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || data.error || `HTTP ${res.status}`);
    err.code = data.error || `HTTP_${res.status}`;
    throw err;
  }
  return data;
};
/** Download a public feed and reverse-compile it into a spec with its baseline report. */
export const importCatalogFeed = (url, place) => post("/network/catalog/import", { url, place });
/** The network report stored with the current session (null when the session was not built by the studio). */
export const fetchNetworkReport = async () => {
  const res = await fetchWithSession(`${API_BASE_URL}/network/report`);
  if (!res.ok) return null;
  return res.json().catch(() => null);
};

/** Stream a planner turn; resolves at `done`. Mid-stream errors arrive as `error` events. */
export async function streamPlan({ brief, spec = null, messages = [], language = "en", near = null, territory = null, requirements = null, signal, onEvent }) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/network/plan`, { method: "POST", headers: betaHeaders(), body: JSON.stringify({ brief, spec, messages, language, near, territory, requirements }), signal });
  } catch (err) {
    const e = new Error(err.name === "AbortError" ? "aborted" : err.message || "Network error");
    e.code = err.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR";
    throw e;
  }
  const ct = response.headers.get("content-type") || "";
  if (!ct.startsWith("text/event-stream")) {
    const body = await response.json().catch(() => null);
    const err = new Error(body?.message || `HTTP ${response.status}`);
    err.code = body?.error || `HTTP_${response.status}`;
    err.status = response.status;
    throw err;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const flush = (block) => {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
    }
    let parsed = {};
    if (data) {
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = { raw: data };
      }
    }
    try {
      onEvent(event, parsed);
    } catch (cbErr) {
      console.error("streamPlan onEvent threw:", cbErr);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
      if (block.trim()) flush(block);
    }
  }
  if (buffer.trim()) flush(buffer);
}

/** Read a brief file (text-like formats) as text. */
export const readBriefFile = (file) =>
  new Promise((resolve, reject) => {
    const name = (file?.name || "").toLowerCase();
    if (!/\.(txt|md|markdown|csv|json|tsv)$/.test(name) && !(file?.type || "").startsWith("text/")) {
      const err = new Error("UNSUPPORTED_FILE");
      err.code = "UNSUPPORTED_FILE";
      reject(err);
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      const err = new Error("FILE_TOO_LARGE");
      err.code = "FILE_TOO_LARGE";
      reject(err);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsText(file);
  });

const DRAFT_KEY = "gtfs:network-draft";
export const loadDraft = () => {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
export const saveDraft = (draft) => {
  try {
    if (!draft) localStorage.removeItem(DRAFT_KEY);
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* storage disabled */
  }
};
