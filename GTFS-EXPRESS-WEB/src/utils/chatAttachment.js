/**
 * Chat attachments are parsed on the server into a read-only `_chat_att_<n>` table of the session, keeping a parser
 * out of the bundle. Failures throw with `.code` and `.status` for the localized message.
 */

import API_BASE_URL from "../config";
import { requestJson } from "./apiRequest";

export const ACCEPTED_EXTENSIONS = ".csv,.tsv,.txt,.xlsx";
// The server's default caps, for an instant check only: the server stays the authority.
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_MB = 5;
export const MAX_ATTACHMENT_COLS = 64;

export function uploadChatAttachment(file) {
  const formData = new FormData();
  formData.append("chatAttachment", file);
  // No Content-Type: the browser sets the multipart boundary.
  return requestJson(`${API_BASE_URL}/sql/nl2sql-chat/attachment`, { method: "POST", body: formData });
}

/** Safe to fire and forget: the table dies with the session anyway. */
export function deleteChatAttachment(table) {
  return requestJson(`${API_BASE_URL}/sql/nl2sql-chat/attachment/${encodeURIComponent(table)}`, { method: "DELETE" });
}
