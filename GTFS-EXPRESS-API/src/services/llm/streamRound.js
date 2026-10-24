/**
 * One streamed model call of a turn, retried on its own. The SDK retries only before a stream opens; a stream cut
 * in the middle would lose the whole turn, and one ending without its final message would read as an empty answer
 * (UPSTREAM_INCOMPLETE, retried like a cut). The conversation is unchanged until the round returns, so a retry is
 * the same request; the `retry` event tells the reader to drop the partial text. Never retried: an abort, a 4xx
 * that says the request itself is wrong, a programming error. The usage returned is the successful attempt's.
 */

"use strict";

const ROUND_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([408, 409, 429]);
const BACKOFF_MS = [500, 2000];
const PROGRAMMING_ERRORS = new Set(["TypeError", "RangeError", "ReferenceError"]);

const isRetryable = (err) => {
  if (!err || err.name === "AbortError" || err.name === "APIUserAbortError") return false;
  const status = Number(err.status);
  if (Number.isFinite(status) && status > 0) return status >= 500 || RETRY_STATUSES.has(status);
  if (err.code === "UPSTREAM_INCOMPLETE") return true;
  // No status: the SDK's connection errors and timeouts, a reset in the stream, a truncated chunk.
  return !PROGRAMMING_ERRORS.has(err.name);
};

const codeOf = (err) => err.code || (err.status ? `UPSTREAM_${err.status}` : err.name || "UPSTREAM_ERROR");

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const once = async ({ client, body, signal, emit }) => {
  const stream = client.messages.stream(body, { signal });
  let usage = null;
  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") emit("tool_pending", { name: event.content_block.name });
    else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) emit("token", { text: event.delta.text });
    else if (event.type === "message_delta" && event.usage) usage = event.usage;
  }
  const finalMessage = await stream.finalMessage();
  if (!finalMessage || !Array.isArray(finalMessage.content) || !finalMessage.stop_reason) {
    throw Object.assign(new Error("The model's answer ended before its final message."), { code: "UPSTREAM_INCOMPLETE" });
  }
  if (finalMessage.usage) usage = finalMessage.usage;
  const content = finalMessage.content;
  return { content, toolUses: content.filter((b) => b.type === "tool_use"), stopReason: finalMessage.stop_reason, usage };
};

/** `attempts` counts the first try; the `retry` event's `max` is how many retries the round may make. */
const streamRound = async ({ client, body, signal, emit = () => {}, attempts = ROUND_ATTEMPTS, wait = sleep }) => {
  const max = Math.max(1, attempts);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const round = await once({ client, body, signal, emit });
      return { ...round, attempts: attempt };
    } catch (err) {
      if (signal?.aborted || attempt >= max || !isRetryable(err)) {
        if (err && typeof err === "object" && !err.code) err.code = codeOf(err);
        throw err;
      }
      emit("retry", { attempt, max: max - 1, code: codeOf(err), status: Number(err.status) || null });
      await wait(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)], signal);
    }
  }
};

module.exports = { streamRound, isRetryable, ROUND_ATTEMPTS, BACKOFF_MS };
