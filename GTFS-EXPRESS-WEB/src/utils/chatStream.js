/**
 * The reader's chat stream (POST /sql/nl2sql-chat). EventSource is GET-only and cannot send X-Session-ID, so the
 * SSE is parsed by hand on top of fetch.
 */

import API_BASE_URL from "../config";
import { httpError, request } from "./apiRequest";

/**
 * Rejects on an error answered before the stream opens (a JSON envelope, with `code`) or on a transport failure;
 * an error during the stream arrives as an `error` event and does not reject.
 */
export async function streamChat({
  messages,
  userMessage,
  language,
  sessionContext = null,
  attachments = [],
  conversationId = null,
  turnId = null,
  signal,
  onEvent,
}) {
  const headers = { "Content-Type": "application/json" };

  const response = await request(`${API_BASE_URL}/sql/nl2sql-chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages,
      userMessage,
      language,
      sessionContext,
      attachments,
      conversationId,
      turnId,
    }),
    signal,
  });

  const ct = response.headers.get("content-type") || "";
  if (!ct.startsWith("text/event-stream")) throw httpError(response, await response.json().catch(() => ({})));

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const flushBlock = (block) => {
    let event = "message";
    let data = "";
    let fields = 0;
    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
        fields += 1;
      } else if (line.startsWith("data:")) {
        data += (data ? "\n" : "") + line.slice(5).trimStart();
        fields += 1;
      }
    }
    // The server's keep-alive comments on a quiet turn are no event.
    if (!fields || (!event && !data)) return;
    let parsed = null;
    if (data) {
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = { raw: data };
      }
    }
    try {
      onEvent(event, parsed || {});
    } catch (cbErr) {
      // A faulty handler must not break the stream.
      console.error("chatStream onEvent threw:", cbErr);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, idx);
        const matchLen = buffer.slice(idx).match(/^\r?\n\r?\n/)[0].length;
        buffer = buffer.slice(idx + matchLen);
        if (block.trim()) flushBlock(block);
      }
    }
    // Some servers end without a trailing blank line.
    if (buffer.trim()) flushBlock(buffer);
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error("aborted");
      e.code = "ABORTED";
      throw e;
    }
    const e = new Error(err.message || "Stream read error");
    e.code = "STREAM_ERROR";
    throw e;
  }
}
