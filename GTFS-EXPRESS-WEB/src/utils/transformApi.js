/**
 * transformApi — client of the transformation engine (changes to the
 * loaded feed, session-bound).
 *
 *   fetchOperations({ lang })       GET  /transform/operations   the catalogue (localized by the server when it can)
 *   fetchOverview()                 GET  /transform/overview     lines and their service
 *   fetchHealth()                   GET  /transform/quality      quality, minimum fleet, consumer checks
 *   fetchStops()                    GET  /stops/all              the feed's stops (pickers of the operation form)
 *   fetchAlerts(id, { language })   GET  /transform/preview/:id/alerts   passenger information of a preview
 *   downloadPreviewExport(id, kind) alerts-pb | alerts-json | diff-csv | diff-json → a file
 *   fetchReferences() / addReference({ url, name }) / removeReference(id)   other operators' timetables
 *   previewChangePlan(plan, opts)   POST /transform/preview      sandbox run, nothing written ({ validate, language }),
 *                                   with the engine's `verdict` (the same as the planner's SSE event); `auto`: the
 *                                   engine settles the questions that carry their own answer and returns them in
 *                                   `auto` { params, decisions, assumptions } (utils/autopilot.withAutoAnswers)
 *   commitChangePlan(id, opts)      POST /transform/commit       one undoable edit (edit mode), { acknowledge }
 *   streamChangePlan({...})         POST /transform/plan         the change planner (SSE; `verdict` { verdict, gate, prose } before `done`)
 *   fetchDemand({ place, dataIds, previewId }) POST /transform/demand  estimated ridership of the loaded feed, or of a previewed plan
 *   optimizeChangePlan({...})       POST /transform/optimize     a plan proposed by the optimizer (never committed)
 *   uploadDemandData(file) / deleteDemandData(id)   POST|DELETE /network/demand/data   the user's own counts
 *
 * Errors carry `code` (the server's error code), `status` and `body`;
 * isUnavailable(err) tells an endpoint this server does not offer (yet).
 */

import { contractFields } from "./networkStudioApi";
import { contractForServer } from "./contract";
import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";

const json = async (res) => {
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

const post = (path, body) => fetchWithSession(`${API_BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(json);

/** An endpoint this server does not offer (not deployed, disabled or not built yet). */
export const isUnavailable = (err) => [404, 405, 501, 503].includes(err?.status) || ["NOT_FOUND", "NOT_IMPLEMENTED", "DEMAND_DISABLED", "UNAVAILABLE"].includes(err?.code);

export const fetchOperations = ({ lang = null } = {}) => fetchWithSession(`${API_BASE_URL}/transform/operations${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`).then(json);
export const fetchOverview = () => fetchWithSession(`${API_BASE_URL}/transform/overview`).then(json);
export const fetchHealth = () => fetchWithSession(`${API_BASE_URL}/transform/quality`).then(json);
export const fetchStops = () => fetchWithSession(`${API_BASE_URL}/stops/all`).then(json).then((d) => d.stops || []);
export const fetchAlerts = (previewId, { language = "en", cause = null } = {}) => fetchWithSession(`${API_BASE_URL}/transform/preview/${previewId}/alerts?language=${encodeURIComponent(language)}${cause ? `&cause=${encodeURIComponent(cause)}` : ""}`).then(json);

const EXPORTS = {
  "alerts-pb": (id, lang) => [`/transform/preview/${id}/alerts?format=pb&language=${lang}`, `alerts-${id}.pb`],
  "alerts-json": (id, lang) => [`/transform/preview/${id}/alerts?format=json&language=${lang}`, `alerts-${id}.json`],
  "diff-csv": (id) => [`/transform/preview/${id}/gtfs-diff/csv`, `gtfs-diff-${id}.csv`],
  "diff-json": (id) => [`/transform/preview/${id}/gtfs-diff/json`, `gtfs-diff-${id}.json`],
};
export const fetchReferences = () => fetchWithSession(`${API_BASE_URL}/transform/references`).then(json);
export const addReference = ({ url, name }) => post("/transform/references", { url, name });
export const removeReference = (id) => fetchWithSession(`${API_BASE_URL}/transform/references/${id}`, { method: "DELETE" }).then(json);

/** Download one export of a preview as a file. */
export const downloadPreviewExport = async (previewId, kind, { language = "en" } = {}) => {
  const [path, filename] = EXPORTS[kind](previewId, encodeURIComponent(language));
  const res = await fetchWithSession(`${API_BASE_URL}${path}`);
  if (!res.ok) await json(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
};
/**
 * Simulate a plan → the preview, with `verdict` (services/verdict.verdictOf of
 * the conformance after, with the gate: the verdict the card shows by hand, never
 * recomputed here) and `gate`. `validate` is always sent: the server validates an
 * unsaid request wherever the validator is available, and the studio asks the fast
 * preview at each edit (false), then the canonical validator on the stable plan (true).
 */
// dataIds: the demand data the residents grid merges, read by the server only for a coverage clause (as at ②).
// auto: the modify journey's autopilot — the engine answers by itself the questions that carry their own answer.
export const previewChangePlan = (plan, { validate = false, language = null, contract = null, brief = null, documents = null, dataIds = null, auto = false } = {}) => post("/transform/preview", { plan, validate: Boolean(validate), ...(language ? { language } : {}), ...contractFields({ contract, brief, documents }), ...(Array.isArray(dataIds) && dataIds.length ? { dataIds } : {}), ...(auto ? { auto: true } : {}) });
/**
 * Commit a preview. `acknowledge` is the named acknowledgement
 * ({ by: { name }, clauses: [ids], sources?: true, assumptions?: [ids], note? },
 * common/AcknowledgementForm) of what the gate lets a person accept: must
 * clauses not met or not measurable, unverified sources, assumptions — never
 * a validator error. Refusals come back as errors with the server's code
 * (400 ACKNOWLEDGEMENT_UNNAMED; 409 PLAN_BLOCKED, INTEGRITY_FAILED,
 * CLAUSES_FAILING, CLAUSES_UNKNOWN, SOURCES_UNVERIFIED, ASSUMPTIONS_UNVALIDATED,
 * VALIDATION_NEW_ERRORS, PREVIEW_STALE; 503 VALIDATOR_*) and the details in `err.body`.
 */
export const commitChangePlan = (previewId, { acknowledge = null } = {}) => post("/transform/commit", { previewId, ...(acknowledge ? { acknowledge } : {}) });

// ── Demand: estimated ridership, the user's own counts, the optimizer ──────

/** Estimated ridership of the loaded feed → { estimate, kpis, inputs }. */
export const fetchDemand = ({ place = null, dataIds = [], previewId = null } = {}) => post("/transform/demand", { ...(place ? { place } : {}), ...(dataIds.length ? { dataIds } : {}), ...(previewId ? { previewId } : {}) });

/** A change plan proposed by the optimizer → { plan, preview, kpis_before, kpis_after, warnings }. */
export const optimizeChangePlan = ({ objective, constraints = {}, place = null, dataIds = [] }) => post("/transform/optimize", { objective, constraints, ...(place ? { place } : {}), ...(dataIds.length ? { dataIds } : {}) });

export const DEMAND_DATA_ACCEPT = ".csv,.tsv,.txt,.xlsx,.xls,.ods,.json,.geojson";
export const DEMAND_DATA_MAX_BYTES = 20 * 1024 * 1024;

/** Upload counts, a survey's OD or places with weights → { id, kind, rows, columns, mapping, preview, warnings }. */
export const uploadDemandData = async (file) => {
  if (file.size > DEMAND_DATA_MAX_BYTES) throw Object.assign(new Error("FILE_TOO_LARGE"), { code: "FILE_TOO_LARGE", status: 413 });
  const form = new FormData();
  form.append("file", file, file.name);
  return fetchWithSession(`${API_BASE_URL}/network/demand/data`, { method: "POST", body: form }).then(json);
};
export const deleteDemandData = (id) => fetchWithSession(`${API_BASE_URL}/network/demand/data/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);

/** Parse an SSE body, calling onEvent(event, data) for each block. */
export const readSSE = async (response, onEvent) => {
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
    // A block of comments only (the server's « : keep-alive » on a quiet change turn) is no event.
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
      console.error("streamChangePlan onEvent threw:", cbErr);
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
};

/**
 * A change-planner turn (SSE); `contract` as for streamPlan: none or a draft, the turn is the extraction.
 * `autopilot`: the turn the journey launches by itself (nobody typed it: the operations read from the brief's
 * spreadsheets are kept as they are). `auto`: the turn's simulations settle the questions that carry their own
 * answer, as the studio's own do (always with `autopilot`; the modify journey's typed turns ask for it too).
 */
export async function streamChangePlan({ brief, plan = null, messages = [], language = "en", documents = [], dataIds = [], contract = null, autopilot = false, auto = false, signal, onEvent }) {
  let response;
  try {
    response = await fetchWithSession(`${API_BASE_URL}/transform/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief, plan, messages, language, documents, ...(dataIds.length ? { dataIds } : {}), ...(contract ? { contract: contractForServer(contract) } : {}), ...(autopilot ? { autopilot: true } : {}), ...(auto || autopilot ? { auto: true } : {}) }), signal });
  } catch (err) {
    const e = new Error(err.name === "AbortError" ? "aborted" : err.message || "Network error");
    e.code = err.name === "AbortError" ? "ABORTED" : err.isRateLimit ? "RATE_LIMITED" : "NETWORK_ERROR";
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
  // « Arrêter l'assistant » mid-stream: the reader rejects with the browser's AbortError (« signal is aborted without
  // reason » in Chrome) — the person's own act, said as ABORTED like an abort before the first byte, never as an error.
  try {
    await readSSE(response, onEvent);
  } catch (err) {
    if (err?.name !== "AbortError" && !signal?.aborted) throw err;
    const e = new Error("aborted");
    e.code = "ABORTED";
    throw e;
  }
}

/** A plan with one operation's parameter set (answering a blocked question). */
export const withParam = (plan, opId, param, value) => ({
  ...plan,
  operations: plan.operations.map((op) => (op.id === opId ? { ...op, params: { ...(op.params || {}), [param]: value } } : op)),
});

/** The next free operation id of a plan (op1, op2…). */
export const nextOpId = (plan) => {
  const used = new Set((plan?.operations || []).map((o) => o.id));
  let n = (plan?.operations || []).length + 1;
  while (used.has(`op${n}`)) n += 1;
  return `op${n}`;
};
