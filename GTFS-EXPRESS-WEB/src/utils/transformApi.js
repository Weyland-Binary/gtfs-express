import API_BASE_URL from "../config";
import { ensureOk, httpError, jsonHeaders, readJson, request } from "./apiRequest";

// `session` overrides the screen's session (a plan simulated on the draft while « Avant » is shown).
const post = (path, body, { session = null } = {}) => request(`${API_BASE_URL}${path}`, { method: "POST", headers: { ...jsonHeaders(), ...(session ? { "X-Session-ID": session } : {}) }, body: JSON.stringify(body) }).then(readJson);

export const fetchOperations = ({ lang = null } = {}) => request(`${API_BASE_URL}/transform/operations${lang ? `?lang=${encodeURIComponent(lang)}` : ""}`).then(readJson);
export const fetchOverview = () => request(`${API_BASE_URL}/transform/overview`).then(readJson);
export const fetchAlerts = (previewId, { language = "en", cause = null } = {}) => request(`${API_BASE_URL}/transform/preview/${previewId}/alerts?language=${encodeURIComponent(language)}${cause ? `&cause=${encodeURIComponent(cause)}` : ""}`).then(readJson);

const EXPORTS = {
  "alerts-pb": (id, lang) => [`/transform/preview/${id}/alerts?format=pb&language=${lang}`, `alerts-${id}.pb`],
  "alerts-json": (id, lang) => [`/transform/preview/${id}/alerts?format=json&language=${lang}`, `alerts-${id}.json`],
  "diff-csv": (id) => [`/transform/preview/${id}/gtfs-diff/csv`, `gtfs-diff-${id}.csv`],
  "diff-json": (id) => [`/transform/preview/${id}/gtfs-diff/json`, `gtfs-diff-${id}.json`],
};

export const downloadPreviewExport = async (previewId, kind, { language = "en" } = {}) => {
  const [path, filename] = EXPORTS[kind](previewId, encodeURIComponent(language));
  const res = await request(`${API_BASE_URL}${path}`);
  await ensureOk(res);
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
/** `validate` is always sent: the server validates a request that leaves it unsaid whenever the validator is available. */
export const previewChangePlan = (plan, { validate = false, language = null, session = null } = {}) => post("/transform/preview", { plan, validate: Boolean(validate), ...(language ? { language } : {}) }, { session });
/**
 * `acknowledge` names what the gate lets a person accept (never a validator error) and the person's decision;
 * a refusal comes back as an error with the server's code and its details in `err.body`.
 */
export const commitChangePlan = (previewId, { acknowledge = null } = {}) => post("/transform/commit", { previewId, ...(acknowledge ? { acknowledge } : {}) });

/** Estimated ridership of the loaded feed, or of a previewed plan. */
export const fetchDemand = ({ previewId = null } = {}) => post("/transform/demand", previewId ? { previewId } : {});

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
    // A block of comments only (the server's keep-alive) is no event.
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
 * `answer` ({ question, text }) resumes a turn held by the agent's question: the server finds it by the same brief
 * and documents. `session` is the draft's, whatever side the screen shows.
 */
export async function streamDirectChange({ brief, documentIds = [], answer = null, language = "en", signal, onEvent, session = null }) {
  const response = await request(`${API_BASE_URL}/transform/direct`, { method: "POST", headers: { ...jsonHeaders(), ...(session ? { "X-Session-ID": session } : {}) }, body: JSON.stringify({ brief, documentIds, language, ...(answer ? { answer } : {}) }), signal });
  const ct = response.headers.get("content-type") || "";
  if (!ct.startsWith("text/event-stream")) throw httpError(response, await response.json().catch(() => ({})));
  try {
    await readSSE(response, onEvent);
  } catch (err) {
    if (err?.name !== "AbortError" && !signal?.aborted) throw err;
    const e = new Error("aborted");
    e.code = "ABORTED";
    throw e;
  }
}

/** The independent review run again on its own, on the draft whose turn ended without a complete one. */
export async function streamDirectReview({ language = "en", signal, onEvent, session = null }) {
  const response = await request(`${API_BASE_URL}/transform/direct/review`, { method: "POST", headers: { ...jsonHeaders(), ...(session ? { "X-Session-ID": session } : {}) }, body: JSON.stringify({ language }), signal });
  const ct = response.headers.get("content-type") || "";
  if (!ct.startsWith("text/event-stream")) throw httpError(response, await response.json().catch(() => ({})));
  try {
    await readSSE(response, onEvent);
  } catch (err) {
    if (err?.name !== "AbortError" && !signal?.aborted) throw err;
    const e = new Error("aborted");
    e.code = "ABORTED";
    throw e;
  }
}

// The draft's routes name the working copy, not the draft's session.
export const fetchDraft = () => request(`${API_BASE_URL}/transform/draft`).then(readJson);
export const openDraft = () => post("/transform/draft", {});
export const dropDraft = () => request(`${API_BASE_URL}/transform/draft`, { method: "DELETE" }).then(readJson);
export const previewDraft = ({ validate = false, language = null } = {}) => post("/transform/draft/preview", { validate: Boolean(validate), ...(language ? { language } : {}) });
export const mergeIntoDraft = (previewId) => post("/transform/draft/merge", { previewId });
export const applyDraft = (previewId, { acknowledge = null } = {}) => post("/transform/draft/apply", { previewId, ...(acknowledge ? { acknowledge } : {}) });
export const reopenDraft = (editId, { title = "" } = {}) => post("/transform/draft/reopen", { editId, ...(title ? { title } : {}) });

export const fetchPreviewDiff = (previewId) => request(`${API_BASE_URL}/transform/preview/${encodeURIComponent(previewId)}/diff`).then(readJson);

export const withParam = (plan, opId, param, value) => ({
  ...plan,
  operations: plan.operations.map((op) => (op.id === opId ? { ...op, params: { ...(op.params || {}), [param]: value } } : op)),
});

export const nextOpId = (plan) => {
  const used = new Set((plan?.operations || []).map((o) => o.id));
  let n = (plan?.operations || []).length + 1;
  while (used.has(`op${n}`)) n += 1;
  return `op${n}`;
};
