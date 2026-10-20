/**
 * networkStudioApi — client of the Network Studio endpoints.
 *
 *   validateSpec(spec)            POST /network/validate
 *   estimateSpec(spec)            POST /network/estimate   (routed geometry)
 *   geocodeQuery(query, near)     POST /network/geocode
 *   compileSpec(spec, options, { acknowledgeSimplification, acknowledge })
 *                                 POST /network/compile    → a new session
 *                                 (409 SIMPLIFIED_BASELINE for a simplified
 *                                 import, unless acknowledged; 409
 *                                 CLAUSES_FAILING / CLAUSES_UNKNOWN until a
 *                                 named person accepts the must clauses not
 *                                 met: `acknowledge` = { by: { name }, clauses, note? })
 *   checkSpec(spec, options)      POST /network/compile { dry_run: true } → the build
 *                                 checked without being built (the Checks step): the
 *                                 validation by rule, the engine's verdict, the counts
 *   downloadBuiltNetwork(buildId, sessionId, { version })
 *                                 GET /network/:buildId/export.zip?version=N → the built
 *                                 network's zip named after its version, saved by the
 *                                 browser (no edit mode); the build's session goes in
 *                                 the header, never the URL
 *   rememberBuild / builtSessionOf  the build → its session, kept in this tab only
 *                                 (sessionStorage, like the session id itself)
 *   evaluateSpec(spec, place, geometry, requirements)
 *                                 POST /network/evaluate   → the quality report, the
 *                                 conformance and the engine's `verdict`
 *   fetchCatalog(place, { light }) GET /network/catalog    (light: the place alone, fast)
 *   streamPlan({...})             POST /network/plan       (SSE; `handoff` hands a
 *                                 modification over to the real feed; `verdict`
 *                                 { verdict, readiness, prose } before `done`: the
 *                                 engine's verdict on the turn, the readiness with
 *                                 the server's ready_once_acknowledged, and the
 *                                 sentences of the prose it contradicts)
 *
 * None of them needs a session; the studio runs before a feed exists. The
 * account cookie (credentialsOption) rides along so the planner and the
 * compiler apply the licence's limits. Every failure throws an Error carrying
 * `code`, `status`, `body` and `retryAfterSec` (humanError reads them).
 */

import { contractForServer } from "./contract";
import API_BASE_URL from "../config";
import { credentialsOption, fetchWithSession, getClientToken, notifyPaywall } from "./sessionManager";

const jsonHeaders = () => ({ "Content-Type": "application/json" });

/** An API failure as an Error: the server's code and message, the status, the body, the wait it asks for. */
const httpError = (res, data = {}) => {
  const err = new Error(data.message || data.error || `HTTP ${res.status}`);
  err.code = data.error || `HTTP_${res.status}`;
  err.status = res.status;
  err.body = data;
  const retry = Number(data.retryAfterSec ?? res.headers?.get?.("retry-after"));
  if (Number.isFinite(retry) && retry > 0) err.retryAfterSec = retry;
  return err;
};

/** A request that never reached the server (offline, aborted) as a coded Error. */
const transportError = (err) => {
  const e = new Error(err?.name === "AbortError" ? "aborted" : err?.message || "Network error");
  e.code = err?.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR";
  return e;
};

const post = async (path, body, { signal, headers = null } = {}) => {
  let res;
  try {
    res = await fetch(`${API_BASE_URL}${path}`, { method: "POST", headers: { ...jsonHeaders(), ...(headers || {}) }, body: JSON.stringify(body), ...credentialsOption(), ...(signal ? { signal } : {}) });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) notifyPaywall(res);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};

// The place lets the server check what depends on the territory (a school calendar's zone).
export const validateSpec = (spec, place = null) => post("/network/validate", { spec, ...(place ? { place } : {}) });
export const estimateSpec = (spec, routing = null) => post("/network/estimate", { spec, ...(routing ? { routing } : {}) });
export const geocodeQuery = (query, near = null, lang = null) => post("/network/geocode", { query, near, lang, limit: 5 });
/**
 * Build the network. A plan started from a simplified import is refused
 * (409 SIMPLIFIED_BASELINE with its `losses`) until the user acknowledges
 * that it is a study, not the real network. A must clause of the brief the
 * built timetable does not meet (or cannot measure) is refused (409
 * CLAUSES_FAILING / CLAUSES_UNKNOWN { clauses, unacknowledged }) until a
 * named person accepts it: `acknowledge` is the AcknowledgementForm's body
 * (scope compile on the server, recorded with the build).
 */
export const compileSpec = (spec, options = {}, { acknowledgeSimplification = false, acknowledge = null, contract = null, brief = null, documents = null } = {}) =>
  post("/network/compile", { spec, options: acknowledgeSimplification ? { ...options, acknowledgeSimplification: true } : options, ...(acknowledgeSimplification ? { acknowledgeSimplification: true } : {}), ...(acknowledge ? { acknowledge } : {}), ...contractFields({ contract, brief, documents }) });

/**
 * The project's contract as a request carries it, with what the coverage detector reads (G5):
 * the brief pasted and the project's documents. The server checks the contract again (400 for an unnamed decision).
 */
export const contractFields = ({ contract = null, brief = null, documents = null } = {}) => ({
  ...(contract ? { contract: contractForServer(contract) } : {}),
  ...(typeof brief === "string" && brief.trim() ? { brief } : {}),
  ...(Array.isArray(documents) && documents.length ? { documents } : {}),
});
/**
 * G5 for ②: the requirement sentences of the brief and what answers each (POST /contract/coverage, no model). The
 * route answers with the documents' words, so it reads a document a project keeps only for its owner: the browser's
 * workspace token goes with it (X-Client-Token, the header the workspace calls use; never in a URL).
 */
export const fetchContractCoverage = ({ contract, brief = null, documents = null }) => {
  const token = getClientToken();
  return post("/contract/coverage", contractFields({ contract, brief, documents }), token ? { headers: { "X-Client-Token": token } } : {});
};
/** The public-data dossier of a place (slow: tens of seconds when OpenStreetMap is busy); `signal` cancels it. */
export const fetchTerritory = (place, force = false, { signal } = {}) => post("/network/territory", { place, force }, { signal });
export const fetchCoverage = (spec, place) => post("/network/coverage", { spec, place });
/**
 * The design quality report of a plan; `geometry` is the studio's routed lines ([{lineId, directionId, distance_km, running_min}]).
 * With `requirements`, the report carries the conformance to the brief and the engine's `verdict` on it (verdictOf, null
 * without clauses): the verdict a design made by hand shows before its build, never computed in the browser.
 */
export const evaluateSpec = (spec, place = null, geometry = null, requirements = null, { contract = null, brief = null, documents = null } = {}) => post("/network/evaluate", { spec, place, geometry, ...(requirements ? { requirements } : {}), ...contractFields({ contract, brief, documents }) });
/**
 * What the system still needs from the user (by impact), with the service
 * levers' figures. `geometry` is the studio's routed lines (as for
 * evaluateSpec): the levers then cost the plan on the same kilometres as
 * the footer's estimate.
 */
export const fetchNeeds = (spec, { requirements = null, place = null, quality = null, geometry = null } = {}) =>
  post("/network/needs", { spec, ...(requirements ? { requirements } : {}), ...(place ? { place } : {}), ...(quality ? { quality: { operations: quality.operations || null, conformance: quality.conformance || null } } : {}), ...(geometry && geometry.length ? { geometry } : {}) });
/** Snap the planned stops onto the territory's existing stops and fill the long gaps. */
export const refineSpec = (spec, place) => post("/network/refine", { spec, place });
/**
 * The public GTFS feeds covering a place (France: the National Access
 * Point, then the Mobility Database). `light`: found from the place alone,
 * without the territory dossier — the fast path of "find my network".
 */
export const fetchCatalog = async (place, { light = false, signal } = {}) => {
  let res;
  try {
    res = await fetch(`${API_BASE_URL}/network/catalog?place=${encodeURIComponent(place)}${light ? "&light=1" : ""}`, { headers: jsonHeaders(), ...credentialsOption(), ...(signal ? { signal } : {}) });
  } catch (err) {
    throw transportError(err);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};
/**
 * Download a public feed and reverse-compile it into a SIMPLIFIED spec
 * (one pattern per line and direction): a baseline to compare a redesign
 * with, never the real network. The result says what was lost (`losses`).
 */
export const importCatalogFeed = (url, place) => post("/network/catalog/import", { url, place });
/** Open a public feed in the application as it is (a new session: every trip, variant and exception kept). */
export const openCatalogFeed = (url, { name = null, place = null } = {}) => post("/network/catalog/open", { url, ...(name ? { name } : {}), ...(place ? { place } : {}) });
/**
 * The network report stored with the current session (null when the session was not built by the studio);
 * `sessionId`: the report of a build's own session instead (a build's delivery step, once its answer is gone).
 */
export const fetchNetworkReport = async ({ live = false, sessionId = null } = {}) => {
  const res = await fetchWithSession(`${API_BASE_URL}/network/report${live ? "?live=1" : ""}`, sessionId ? { headers: { "X-Session-ID": sessionId } } : {});
  if (!res.ok) return null;
  return res.json().catch(() => null);
};

/** The file types the planner reads as a specification. */
export const BRIEF_ACCEPT = ".pdf,.docx,.odt,.xlsx,.xlsm,.xls,.ods,.txt,.md,.markdown,.csv,.tsv,.json,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.oasis.opendocument.spreadsheet,text/*";
export const BRIEF_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Upload a specification document (PDF, Word, OpenDocument, text) → { id, name, kind, pages, chars, size, sent_to_assistant, expiresAt }.
 * `sentToAssistant: false` keeps it with the project without the assistant ever reading it (form field
 * sent_to_assistant="false", read by the server): a document attached while the assistant is off is not
 * sent to the model provider if the assistant is switched on later, and ① says « non envoyé ».
 */
export const uploadBriefDocument = async (file, { sentToAssistant = true } = {}) => {
  if (file.size > BRIEF_MAX_BYTES) {
    const err = new Error("FILE_TOO_LARGE");
    err.code = "DOCUMENT_TOO_LARGE";
    throw err;
  }
  const form = new FormData();
  form.append("file", file, file.name);
  if (sentToAssistant === false) form.append("sent_to_assistant", "false");
  let res;
  try {
    // No Content-Type: the browser sets the multipart boundary.
    res = await fetch(`${API_BASE_URL}/network/documents`, { method: "POST", headers: {}, body: form, ...credentialsOption() });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) notifyPaywall(res);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(res, data);
  return data;
};

export const deleteBriefDocument = (id) => fetch(`${API_BASE_URL}/network/documents/${encodeURIComponent(id)}`, { method: "DELETE", ...credentialsOption() }).catch(() => {});

/**
 * Stream a planner turn (SSE); resolves at `done`, mid-stream errors arrive as `error` events. `contract`: the
 * project's contract — none, or a draft, and the turn is the extraction (phase "extract": the `contract` event
 * carries the draft the brief proposes, nothing is designed); decided, assumed or empty, the design.
 */
export async function streamPlan({ brief, spec = null, messages = [], language = "en", near = null, territory = null, requirements = null, documents = [], dataIds = [], contract = null, signal, onEvent }) {
  let response;
  try {
    response = await fetch(`${API_BASE_URL}/network/plan`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ brief, spec, messages, language, near, territory, requirements, documents, ...(dataIds.length ? { dataIds } : {}), ...(contract ? { contract: contractForServer(contract) } : {}) }), ...credentialsOption(), signal });
  } catch (err) {
    throw transportError(err);
  }
  if (!response.ok) notifyPaywall(response);
  const ct = response.headers.get("content-type") || "";
  if (!ct.startsWith("text/event-stream")) {
    const body = await response.json().catch(() => null);
    throw httpError(response, body || {});
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const flush = (block) => {
    let event = "message";
    let data = "";
    let fields = 0;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        fields += 1;
      } else if (line.startsWith("data:")) {
        data += (data ? "\n" : "") + line.slice(5).trimStart();
        fields += 1;
      }
    }
    // A block of comments only (the server's « : keep-alive » on a quiet design turn) is no event.
    if (!fields) return;
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
/** The draft of a project's design (one per project), or the studio's own outside a project. */
export const draftKeyOf = (projectId = null) => (projectId ? `${DRAFT_KEY}:${projectId}` : DRAFT_KEY);
export const loadDraft = (key = DRAFT_KEY) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
export const saveDraft = (draft, key = DRAFT_KEY) => {
  try {
    if (!draft) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    /* storage disabled */
  }
};

/** The build checked without being built (dry run): { validation: { errors, warnings, by_rule, engine }, verdict, counts }. */
export const checkSpec = (spec, options = {}, { contract = null, brief = null, documents = null } = {}) => post("/network/compile", { spec, options, dry_run: true, ...contractFields({ contract, brief, documents }) });

// The build → its session: in this tab only, like the session id (a credential, never in localStorage nor a URL).
const BUILDS_KEY = "gtfs:network-builds";
const readBuilds = () => {
  try {
    return JSON.parse(sessionStorage.getItem(BUILDS_KEY) || "{}") || {};
  } catch {
    return {};
  }
};
export const rememberBuild = (buildId, sessionId) => {
  if (!buildId || !sessionId) return;
  try {
    sessionStorage.setItem(BUILDS_KEY, JSON.stringify({ ...readBuilds(), [buildId]: sessionId }));
  } catch {
    /* storage disabled: the build is downloadable while the page lives */
  }
};
export const builtSessionOf = (buildId) => (buildId ? readBuilds()[buildId] || null : null);

/** The file name a Content-Disposition header gives, or the fallback. */
const fileNameOf = (res, fallback) => {
  const header = res.headers?.get?.("content-disposition") || "";
  const m = /filename="?([^";]+)"?/i.exec(header);
  return m ? m[1] : fallback;
};

/**
 * Download a network built here, as it was built (no edit mode): the
 * build's session in the header, the build's id in the URL, and the
 * project's version it is (`version`, the n of vN: the file is named
 * `<network>_v<N>_<date>.zip`). Resolves with the file name once the
 * browser has it; throws the server's refusal (httpError: 400 INVALID_INPUT,
 * 404 NO_REPORT, 409 BUILD_EDITED, 422 VALIDATION_*, 503 VALIDATOR_*).
 */
export const downloadBuiltNetwork = async (buildId, sessionId, { version = null } = {}) => {
  let res;
  const query = Number.isInteger(version) && version >= 1 ? `?version=${version}` : "";
  try {
    res = await fetchWithSession(`${API_BASE_URL}/network/${encodeURIComponent(buildId)}/export.zip${query}`, { headers: { "X-Session-ID": sessionId } });
  } catch (err) {
    throw transportError(err);
  }
  if (!res.ok) throw httpError(res, await res.json().catch(() => ({})));
  const blob = await res.blob();
  const name = fileNameOf(res, "gtfs.zip");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return name;
};
