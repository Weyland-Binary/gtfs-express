/**
 * chatAttachment — Upload/remove tabular chat attachments (CSV/TSV/XLSX).
 *
 * The file is parsed SERVER-side and imported as a read-only `_chat_att_<n>`
 * table in the session DB (no client parser → no bundle impact). The
 * returned metadata drives the attachment chip and is referenced on each
 * chat turn via `attachments: [{ table }]`.
 *
 * Errors follow the chat envelope contract: `{ error: CODE, message }` →
 * thrown as Error with `.code` and `.status` so ChatDrawer can branch to
 * localized messages (same pattern as chatStream.js).
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";
import { BETA_CODE_STORAGE_KEY } from "../components/edit/BetaGateDialog";

export const ACCEPTED_EXTENSIONS = ".csv,.tsv,.txt,.xlsx";
// Mirror of the server-side caps (config.CHAT_ATTACHMENT_MAX_BYTES/_COLS
// defaults) — used only for instant client-side pre-checks; the server
// remains the authority.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_MB = 5;
export const MAX_ATTACHMENT_COLS = 64;

const betaHeaders = () => {
  const headers = {};
  try {
    const code = localStorage.getItem(BETA_CODE_STORAGE_KEY);
    if (code) headers["X-Beta-Code"] = code;
  } catch {
    /* localStorage may be disabled (incognito) */
  }
  return headers;
};

const throwEnvelope = async (response) => {
  let body = null;
  try {
    body = await response.json();
  } catch {
    /* unparseable body */
  }
  const err = new Error(body?.message || `HTTP ${response.status}`);
  err.code = body?.error || `HTTP_${response.status}`;
  err.status = response.status;
  throw err;
};

const normalizeTransportError = (err) => {
  if (err.isRateLimit) {
    const e = new Error(err.message || "HTTP 429");
    e.code = "HTTP_429";
    e.status = 429;
    return e;
  }
  const e = new Error(err.message || "Network error");
  e.code = "NETWORK_ERROR";
  return e;
};

/**
 * Upload one tabular file. Resolves with the attachment metadata:
 * `{ table, filename, columns: [{original, sanitized}], rowCount, truncated,
 *    cellsTruncated, sheetName?, sheetNames? }`.
 */
export async function uploadChatAttachment(file) {
  const formData = new FormData();
  formData.append("chatAttachment", file);

  let response;
  try {
    // No Content-Type header — the browser sets the multipart boundary.
    response = await fetchWithSession(
      `${API_BASE_URL}/sql/nl2sql-chat/attachment`,
      { method: "POST", headers: betaHeaders(), body: formData },
    );
  } catch (err) {
    throw normalizeTransportError(err);
  }
  if (!response.ok) await throwEnvelope(response);
  return response.json();
}

/**
 * Drop an attachment table from the session. Safe to fire-and-forget —
 * the table dies with the session TTL anyway.
 */
export async function deleteChatAttachment(table) {
  let response;
  try {
    response = await fetchWithSession(
      `${API_BASE_URL}/sql/nl2sql-chat/attachment/${encodeURIComponent(table)}`,
      { method: "DELETE" },
    );
  } catch (err) {
    throw normalizeTransportError(err);
  }
  if (!response.ok) await throwEnvelope(response);
  return response.json();
}
