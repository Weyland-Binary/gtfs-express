/**
 * transformApi — client of the transformation engine (changes to the
 * loaded feed, session-bound).
 *
 *   fetchOperations()               GET  /transform/operations   the catalogue
 *   fetchOverview()                 GET  /transform/overview     lines and their service
 *   fetchHealth()                   GET  /transform/quality      quality, minimum fleet, consumer checks
 *   fetchAlerts(id, { language })   GET  /transform/preview/:id/alerts   passenger information of a preview
 *   downloadPreviewExport(id, kind) alerts-pb | alerts-json | diff-csv | diff-json → a file
 *   fetchReferences() / addReference({ url, name }) / removeReference(id)   other operators' timetables
 *   previewChangePlan(plan, opts)   POST /transform/preview      sandbox run, nothing written
 *   commitChangePlan(previewId)     POST /transform/commit       one undoable edit (edit mode)
 *   streamChangePlan({...})         POST /transform/plan         the change planner (SSE)
 */

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

export const fetchOperations = () => fetchWithSession(`${API_BASE_URL}/transform/operations`).then(json);
export const fetchOverview = () => fetchWithSession(`${API_BASE_URL}/transform/overview`).then(json);
export const fetchHealth = () => fetchWithSession(`${API_BASE_URL}/transform/quality`).then(json);
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
export const previewChangePlan = (plan, { validate = false } = {}) => post("/transform/preview", { plan, validate });
export const commitChangePlan = (previewId) => post("/transform/commit", { previewId });

/** Parse an SSE body, calling onEvent(event, data) for each block. */
const readSSE = async (response, onEvent) => {
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

export async function streamChangePlan({ brief, plan = null, messages = [], language = "en", documents = [], signal, onEvent }) {
  let response;
  try {
    response = await fetchWithSession(`${API_BASE_URL}/transform/plan`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief, plan, messages, language, documents }), signal });
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
  await readSSE(response, onEvent);
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
