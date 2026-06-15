/**
 * chatStream — Streaming client for POST /gtfs/sql/nl2sql-chat (SSE).
 *
 * Why fetch + ReadableStream instead of EventSource?
 *   EventSource is GET-only and cannot send custom headers (X-Beta-Code,
 *   X-Session-ID). The chat endpoint is POST + custom headers, so we hand-
 *   roll the SSE parse on top of fetch + response.body.getReader().
 *
 * Server event schema (see nl2sqlChatService.js):
 *   meta           {conversationId, turnId, model, mode}
 *   token          {phase: "preamble" | "summary", text}
 *   sql_generated  {sql, preamble}
 *   sql_blocked    {reason, message, draftSql, preamble}
 *   sql_executing  {}
 *   sql_result     {rowCount, columns, rowsPreview, truncated, durationMs}
 *   sql_error      {message, status?, stage?}
 *   usage          {pass, input_tokens, output_tokens, …}
 *   error          {code, message, retryAfterSec?}
 *   done           {reason}
 *
 * Pre-stream errors (gate failure, validation, rate limit) come back as a
 * JSON envelope with `error` and `message` keys — those are surfaced via
 * the returned promise rejection (with `error.code` for branching).
 */

import API_BASE_URL from "../config";
import { fetchWithSession } from "./sessionManager";
import { BETA_CODE_STORAGE_KEY } from "../components/edit/BetaGateDialog";

/**
 * Stream a chat turn. Resolves when the SSE `done` event arrives (or the
 * stream ends naturally). Rejects on pre-stream JSON errors or transport
 * failures. Mid-stream errors are surfaced as `error` events via `onEvent`
 * — they do NOT reject the promise (the chat UI displays them inline).
 *
 * @param {Object}        opts
 * @param {Array}         opts.messages       — flat history array
 * @param {string}        opts.userMessage    — current user request
 * @param {string}        opts.language       — UI language code (en, fr, …)
 * @param {Object?}       opts.sessionContext — live session snapshot
 *        (validation summary, UI tab) injected server-side into the current
 *        turn so the assistant acts as a repair companion
 * @param {string?}       opts.conversationId — opaque, echoed by server
 * @param {string?}       opts.turnId         — opaque, echoed by server
 * @param {AbortSignal?}  opts.signal         — abort to cancel the stream
 * @param {(name, data)=>void} opts.onEvent  — called for each SSE event
 * @returns {Promise<void>}
 */
export async function streamChat({
  messages,
  userMessage,
  language,
  sessionContext = null,
  conversationId = null,
  turnId = null,
  signal,
  onEvent,
}) {
  let betaCode = null;
  try {
    betaCode = localStorage.getItem(BETA_CODE_STORAGE_KEY);
  } catch {
    /* localStorage may be disabled (incognito) */
  }

  // X-Session-ID is injected by fetchWithSession; the raw Response is
  // returned untouched, so the SSE reader below keeps working.
  const headers = { "Content-Type": "application/json" };
  if (betaCode) headers["X-Beta-Code"] = betaCode;

  let response;
  try {
    response = await fetchWithSession(`${API_BASE_URL}/sql/nl2sql-chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages,
        userMessage,
        language,
        sessionContext,
        conversationId,
        turnId,
      }),
      signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      const e = new Error("aborted");
      e.code = "ABORTED";
      throw e;
    }
    if (err.isRateLimit) {
      // Mirror the pre-stream envelope shape callers already handle.
      const e = new Error(err.message || "HTTP 429");
      e.code = "HTTP_429";
      e.status = 429;
      throw e;
    }
    const e = new Error(err.message || "Network error");
    e.code = "NETWORK_ERROR";
    throw e;
  }

  // Pre-stream error (server returned JSON envelope, no SSE channel opened).
  const ct = response.headers.get("content-type") || "";
  if (!ct.startsWith("text/event-stream")) {
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
  }

  // ── SSE parse loop ────────────────────────────────────────────────────
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  const flushBlock = (block) => {
    // Each block is a series of `field: value` lines. We only care about
    // `event:` and `data:` (id:/retry: are unused server-side).
    let event = "message";
    let data = "";
    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // SSE allows multi-line data — concatenate with \n.
        data += (data ? "\n" : "") + line.slice(5).trimStart();
      }
    }
    if (!event && !data) return;
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
      // Don't let a faulty handler break the stream — surface to console
      // so it's visible in dev but keep parsing.
      console.error("chatStream onEvent threw:", cbErr);
    }
  };

  try {
    while (true) {
      // The `signal` aborts the fetch; the reader will throw an AbortError.
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Split on the canonical SSE event terminator: a blank line.
      // Tolerate both \r\n\r\n (HTTP/1.1 strict) and \n\n (most servers).
      let idx;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, idx);
        // Skip the matched terminator (1–2 chars × 2)
        const matchLen = buffer.slice(idx).match(/^\r?\n\r?\n/)[0].length;
        buffer = buffer.slice(idx + matchLen);
        if (block.trim()) flushBlock(block);
      }
    }
    // Drain any final partial block (some servers don't send a trailing \n\n).
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
