/**
 * transformApi — client of the transformation engine (changes to the
 * loaded feed, session-bound).
 *
 *   fetchOperations({ lang })       GET  /transform/operations   the catalogue (localized by the server when it can)
 *   fetchOverview()                 GET  /transform/overview     lines and their service
 *   fetchAlerts(id, { language })   GET  /transform/preview/:id/alerts   passenger information of a preview
 *   downloadPreviewExport(id, kind) alerts-pb | alerts-json | diff-csv | diff-json → a file
 *   previewChangePlan(plan, opts)   POST /transform/preview      sandbox run, nothing written ({ validate, language }),
 *                                   with the engine's `verdict`
 *   commitChangePlan(id, opts)      POST /transform/commit       one undoable edit (edit mode), { acknowledge }
 *   streamDirectChange({...})       POST /transform/direct       the direct mode's turn (SSE: meta, step, question, report, done)
 *   fetchPreviewDiff(id)            GET  /transform/preview/:id/diff   a stored preview's semantic diff and geometry
 *   fetchDraft() / openDraft() / dropDraft()   GET|POST|DELETE /transform/draft   a draft by hand: a copy of the
 *                                   working copy kept as a session of its own (the requests of the draft's screen go to
 *                                   it: utils/sessionManager setDraftSession), { draft: { session, created_at, edits } }
 *   previewDraft({ validate, language })      POST /transform/draft/preview   the draft compared with the working copy
 *   mergeIntoDraft(previewId)       POST /transform/draft/merge   a plan simulated on the draft joins it as one retouche
 *   applyDraft(id, { acknowledge }) POST /transform/draft/apply   the draft applied through the commit's gate, then closed
 *   reopenDraft(editId, { title, direct }) POST /transform/draft/reopen   an application undone: its draft reopened on the change
 *   fetchDemand({ place, dataIds, previewId }) POST /transform/demand  estimated ridership of the loaded feed, or of a previewed plan
 *   uploadDemandData(file) / deleteDemandData(id)   POST|DELETE /network/demand/data   the user's own counts
 *
 * Errors carry `code` (the server's error code), `status` and `body`.
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

// `session`: the session the request names, whatever the screen works in (a plan simulated on the draft from « Avant »).
const post = (path, body, { session = null } = {}) => fetchWithSession(`${API_BASE_URL}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(session ? { "X-Session-ID": session } : {}) }, body: JSON.stringify(body) }).then(json);

export const fetchOperations = ({ lang = null } = {}) => fetchWithSession(`${API_BASE_URL}/transform/operations${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`).then(json);
export const fetchOverview = () => fetchWithSession(`${API_BASE_URL}/transform/overview`).then(json);
export const fetchAlerts = (previewId, { language = "en", cause = null } = {}) => fetchWithSession(`${API_BASE_URL}/transform/preview/${previewId}/alerts?language=${encodeURIComponent(language)}${cause ? `&cause=${encodeURIComponent(cause)}` : ""}`).then(json);

const EXPORTS = {
  "alerts-pb": (id, lang) => [`/transform/preview/${id}/alerts?format=pb&language=${lang}`, `alerts-${id}.pb`],
  "alerts-json": (id, lang) => [`/transform/preview/${id}/alerts?format=json&language=${lang}`, `alerts-${id}.json`],
  "diff-csv": (id) => [`/transform/preview/${id}/gtfs-diff/csv`, `gtfs-diff-${id}.csv`],
  "diff-json": (id) => [`/transform/preview/${id}/gtfs-diff/json`, `gtfs-diff-${id}.json`],
};

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
export const previewChangePlan = (plan, { validate = false, language = null, session = null } = {}) => post("/transform/preview", { plan, validate: Boolean(validate), ...(language ? { language } : {}) }, { session });
/**
 * Commit a preview. `acknowledge` is the named acknowledgement
 * ({ by: { name }, clauses: [ids], sources?: true, baseline_errors?: true,
 * changes?: true, direct?: true, hand?: true, note? }, common/AcknowledgementForm)
 * of what the gate lets a person accept — must clauses not met or not
 * measurable, unverified sources, the reference feed's errors, changes no
 * clause asks for, never a validator error — and of the person's decision (the
 * direct mode's report, a change by hand). Refusals come back as errors with
 * the server's code (400 ACKNOWLEDGEMENT_UNNAMED; 409 PLAN_BLOCKED,
 * INTEGRITY_FAILED, CLAUSES_FAILING, CLAUSES_UNKNOWN, SOURCES_UNVERIFIED,
 * BASELINE_ERRORS, CHANGES_NOT_ASKED, DIRECT_REPORT_UNACCEPTED,
 * VALIDATION_NEW_ERRORS, PREVIEW_STALE; 503 VALIDATOR_*) and the details in `err.body`.
 */
export const commitChangePlan = (previewId, { acknowledge = null } = {}) => post("/transform/commit", { previewId, ...(acknowledge ? { acknowledge } : {}) });

// ── Demand: estimated ridership, the user's own counts ─────────────────────

/** Estimated ridership of the loaded feed → { estimate, kpis, inputs }. */
export const fetchDemand = ({ place = null, dataIds = [], previewId = null } = {}) => post("/transform/demand", { ...(place ? { place } : {}), ...(dataIds.length ? { dataIds } : {}), ...(previewId ? { previewId } : {}) });

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
      console.error("readSSE onEvent threw:", cbErr);
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
 * A turn of the direct mode (SSE): an agent changes a copy of the network, the engine states the facts, an independent
 * reviewer measures each demand of the brief. `answer` ({ question, text }) resumes a turn held by the agent's question
 * — with the same brief and documents, which is how the server finds it.
 */
// `session`: the draft's own session the turn runs on (its change joins the draft), whatever side the screen shows.
export async function streamDirectChange({ brief, documentIds = [], answer = null, language = "en", signal, onEvent, session = null }) {
  let response;
  try {
    response = await fetchWithSession(`${API_BASE_URL}/transform/direct`, { method: "POST", headers: { "Content-Type": "application/json", ...(session ? { "X-Session-ID": session } : {}) }, body: JSON.stringify({ brief, documentIds, language, ...(answer ? { answer } : {}) }), signal });
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
    err.body = body;
    throw err;
  }
  try {
    await readSSE(response, onEvent);
  } catch (err) {
    if (err?.name !== "AbortError" && !signal?.aborted) throw err;
    const e = new Error("aborted");
    e.code = "ABORTED";
    throw e;
  }
}

// ── A draft by hand (the API's transform/draftSession): every route names the working copy ──
export const fetchDraft = () => fetchWithSession(`${API_BASE_URL}/transform/draft`).then(json);
export const openDraft = () => post("/transform/draft", {});
export const dropDraft = () => fetchWithSession(`${API_BASE_URL}/transform/draft`, { method: "DELETE" }).then(json);
export const previewDraft = ({ validate = false, language = null } = {}) => post("/transform/draft/preview", { validate: Boolean(validate), ...(language ? { language } : {}) });
export const mergeIntoDraft = (previewId) => post("/transform/draft/merge", { previewId });
export const applyDraft = (previewId, { acknowledge = null } = {}) => post("/transform/draft/apply", { previewId, ...(acknowledge ? { acknowledge } : {}) });
export const reopenDraft = (editId, { title = "", direct = null } = {}) => post("/transform/draft/reopen", { editId, ...(title ? { title } : {}), ...(direct ? { direct } : {}) });

/** A stored preview's semantic diff ({ items, totals, empty }) and its geometry (`geo`), for a preview the web did not simulate. */
export const fetchPreviewDiff = (previewId) => fetchWithSession(`${API_BASE_URL}/transform/preview/${encodeURIComponent(previewId)}/diff`).then(json);

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
