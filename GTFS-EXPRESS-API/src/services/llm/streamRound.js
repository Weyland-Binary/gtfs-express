/**
 * llm/streamRound — one model call of a planner's turn, streamed, made robust.
 *
 * Why: a planner's turn is up to twenty calls in a row. The SDK retries a
 * call only before its stream opens (a refused connection, a 429, a 5xx); a
 * stream cut in the middle (a reset, an overloaded upstream, a proxy's
 * timeout) would throw out of the turn: the person would lose the whole turn
 * with the limiter's slot already spent. Worse, a stream that ends without
 * its final message would read as "the model ended its turn" with nothing
 * said: the turn would complete quietly on an unchanged plan.
 *
 * Here one round is retried on its own. The conversation it was sent is
 * unchanged until the round returns, so sending it again is the same request.
 * The partial text the stream had emitted is announced superseded to the
 * reader first (`retry` event: the web empties the message it was filling).
 * A final message that never comes, or comes without a stop reason, is a
 * failure of the round (UPSTREAM_INCOMPLETE), retried like a cut, never an
 * empty answer.
 *
 *   streamRound({ client, body, signal, emit, attempts? }) →
 *     { content, toolUses, stopReason, usage, attempts }
 *
 * Retried: the SDK's connection errors and timeouts, a socket cut in the
 * stream, 408, 409, 429, every 5xx (529 overloaded included), an incomplete
 * stream. Not retried: an abort (the person stopped the turn), a 4xx that
 * says the request itself is wrong (the same request would fail again), a
 * programming error, anything past the attempts. The usage returned is the
 * successful attempt's: what a cut attempt was billed is unknown here.
 */

"use strict";

const ROUND_ATTEMPTS = 3;
const RETRY_STATUSES = new Set([408, 409, 429]);
const BACKOFF_MS = [500, 2000];
const PROGRAMMING_ERRORS = new Set(["TypeError", "RangeError", "ReferenceError"]);

/** Whether sending the same round again may succeed. */
const isRetryable = (err) => {
  if (!err || err.name === "AbortError" || err.name === "APIUserAbortError") return false;
  const status = Number(err.status);
  if (Number.isFinite(status) && status > 0) return status >= 500 || RETRY_STATUSES.has(status);
  if (err.code === "UPSTREAM_INCOMPLETE") return true;
  // No status: the SDK's connection errors and timeouts, a reset in the stream, a truncated chunk.
  return !PROGRAMMING_ERRORS.has(err.name);
};

const codeOf = (err) => err.code || (err.status ? `UPSTREAM_${err.status}` : err.name || "UPSTREAM_ERROR");

/** Waits, or returns at once when the turn is aborted meanwhile. */
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

/** One attempt: the stream read to its end and its final message, or a thrown error. */
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

/**
 * The round, retried up to `attempts` times in all. `emit` receives the stream's `tool_pending` and `token`
 * events, and `retry` { attempt, max, code, status } before each new attempt (attempt: the retry's rank, max:
 * how many retries the round may make). `wait` is the back-off (tests pass their own).
 */
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
