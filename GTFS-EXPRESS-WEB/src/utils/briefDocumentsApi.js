import { formatDateTime } from "./formatDate";
import { apiUrl, request, requestJson } from "./apiRequest";

export const BRIEF_ACCEPT = ".pdf,.docx,.odt,.xlsx,.xlsm,.xls,.ods,.txt,.md,.markdown,.csv,.tsv,.json,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,application/vnd.oasis.opendocument.spreadsheet,text/*";
export const BRIEF_MAX_BYTES = 20 * 1024 * 1024;

/** `sentToAssistant: false` keeps it with the project without the model ever reading it. */
export const uploadBriefDocument = async (file, { sentToAssistant = true } = {}) => {
  if (file.size > BRIEF_MAX_BYTES) {
    const err = new Error("FILE_TOO_LARGE");
    err.code = "DOCUMENT_TOO_LARGE";
    throw err;
  }
  const form = new FormData();
  form.append("file", file, file.name);
  if (sentToAssistant === false) form.append("sent_to_assistant", "false");
  // No Content-Type: the browser sets the multipart boundary. A document belongs to no working copy.
  return requestJson(apiUrl("/network/documents"), { method: "POST", headers: {}, body: form, withSession: false });
};

export const deleteBriefDocument = (id) => request(apiUrl(`/network/documents/${encodeURIComponent(id)}`), { method: "DELETE", withSession: false }).catch(() => {});

const DAY_MS = 24 * 60 * 60 * 1000;

const daysUntil = (iso, now = Date.now()) => {
  const at = Date.parse(iso || "");
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / DAY_MS)) : null;
};

/** « À redéposer » only once the server said it is gone (DOCUMENT_NOT_FOUND) or its memory date has passed. */
export const documentStateOf = (d, { retentionDays = 30, retentionUntil = null, t, language, now = Date.now() }) => {
  const sent = d.sent_to_assistant === false ? t("documents.notSent") : t("documents.sentToAssistant");
  if (d.kept) {
    const left = daysUntil(d.expires_at || retentionUntil, now);
    return [sent, t("documents.keptWithProject", { days: retentionDays }), left !== null ? t("documents.expiresIn", { duration: t("documents.days", { count: left }) }) : null].filter(Boolean);
  }
  const memoryEnd = Date.parse(d.expires_at || "");
  if (d.gone || (Number.isFinite(memoryEnd) && memoryEnd <= now)) return [sent, t("documents.expired")];
  if (d.keeping) return [sent, t("documents.keeping")];
  return [sent, Number.isFinite(memoryEnd) ? t("documents.inMemory", { time: formatDateTime(d.expires_at, language) }) : t("documents.notKept")];
};

/** The project's documents first, then those being sent (or refused) and not yet among them. */
export const documentItemsOf = (pending = [], records = []) => {
  const recorded = (records || []).filter((r) => r && r.id);
  const ids = new Set(recorded.map((r) => r.id));
  const expired = new Set((pending || []).filter((d) => d.id && d.status === "expired").map((d) => d.id));
  return [
    ...recorded.map((r) => ({ id: r.id, name: r.name, pages: r.pages, kind: r.kind, status: expired.has(r.id) || r.gone ? "expired" : "ready", record: r })),
    ...(pending || []).filter((d) => !(d.id && ids.has(d.id))),
  ];
};
