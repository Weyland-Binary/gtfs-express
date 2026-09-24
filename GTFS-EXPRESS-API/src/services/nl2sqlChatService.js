/**
 * nl2sqlChatService — the streaming, tool-using chat assistant.
 *
 * One user turn (`streamChatTurn`) is an agent loop:
 *
 *   messages = history (flattened) + [context blocks + user text]
 *   loop (≤ MAX_TOOL_ROUNDS):
 *     stream = anthropic.messages.stream({ system (cached), tools, messages })
 *       text deltas       → emit("token", { text })      (answer, markdown)
 *       tool_use start    → emit("tool_pending", { name })
 *     final = stream.finalMessage()
 *     if stop_reason !== "tool_use" → break
 *     for each tool_use block → executeTool() (chatAgentTools.js), which
 *       emits the UI events (step_start / step_result / proposal /
 *       ui_action / chart) and returns the text handed back to the model
 *     messages += assistant(final.content) + user(tool_results)
 *   followups tag at the end of the answer → emit("followups", { items })
 *   emit("done")
 *
 * Safety: run_sql is read-only (same classifier as the SQL Console);
 * propose_fix never executes (dry-run only) — the user applies through the
 * guided flow. Tool inputs are validated in chatAgentTools.
 *
 * Cancellation: the controller aborts the signal when the client goes away;
 * both the Anthropic stream and the loop honour it.
 *
 * Rate limiting: aiCostLimiter (per key / daily / global), one check per turn.
 */

const fs = require("fs");
const path = require("path");
const { Anthropic } = require("@anthropic-ai/sdk");
const config = require("../config");
const nl2sqlService = require("./nl2sqlService");
const chatAgentTools = require("./chatAgentTools");
const sqlConsoleService = require("./edit/sqlConsoleService");
const chatAttachmentService = require("./chatAttachmentService");
const aiCostLimiter = require("./aiCostLimiter");

// ─── Lazy Anthropic client ────────────────────────────────────────────────
let _client = null;
const getClient = () => {
  // Hard no-billing safety net: the test suite must NEVER reach the real
  // Anthropic client (mock streamChatTurn instead). Any test that forgets
  // fails loudly here rather than making an outbound API call.
  if (
    process.env.JEST_WORKER_ID !== undefined &&
    process.env.ALLOW_ANTHROPIC_IN_TESTS !== "true"
  ) {
    throw Object.assign(
      new Error(
        "Anthropic client blocked under Jest — mock the AI service in this test " +
          "(set ALLOW_ANTHROPIC_IN_TESTS=true only for deliberate token-spending runs).",
      ),
      { code: "ANTHROPIC_BLOCKED_IN_TESTS", status: 503 },
    );
  }
  if (_client) return _client;
  if (!config.ANTHROPIC_API_KEY) {
    throw Object.assign(
      new Error("ANTHROPIC_API_KEY is not configured."),
      { code: "NL2SQL_CHAT_DISABLED", status: 503 },
    );
  }
  _client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  return _client;
};

// Per-code + global rate limits live in services/aiCostLimiter — shared with
// the one-shot /sql/nl2sql endpoint. See that module for the three-tier
// (hourly + daily + global budget) sliding-window logic.

// ─── Usage logging (separate file from beta usage.jsonl) ──────────────────
const logChatUsage = (entry) => {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    const dir = path.dirname(config.NL2SQL_CHAT_USAGE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(config.NL2SQL_CHAT_USAGE_PATH, line);
  } catch {
    /* swallow — telemetry must never break the stream */
  }
};

// ─── Session context block (companion awareness) ─────────────────────────
// The frontend may attach a compact snapshot of the live session state
// (validation summary, UI tab) so the assistant can answer "help me fix
// this feed" without the user pasting anything. The block is:
//   - sanitized field-by-field (counts clamped, rule codes whitelisted to
//     identifier characters, hard entry/length caps) — it travels into the
//     model prompt, never into SQL;
//   - injected into the CURRENT user message only (the cached system
//     prompt stays byte-identical → cache hits are preserved, and stale
//     context never accumulates in history).
const CONTEXT_MAX_RULES = 8;
const CONTEXT_MAX_CHARS = 2000;
const RULE_CODE_RE = /^[a-z0-9_]{1,64}$/i;
const SEVERITIES = new Set(["error", "warning", "info"]);

const clampCount = (v) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 1000000);
};

// Rule descriptions come from the server-side catalogue (trusted source,
// not client payload). Lazy-required to keep module load light.
let _ruleDescriptions = null;
const ruleDescription = (code) => {
  if (!_ruleDescriptions) {
    try {
      _ruleDescriptions = require("../utils/locales/en.json");
    } catch {
      _ruleDescriptions = {};
    }
  }
  const text = _ruleDescriptions[code];
  return typeof text === "string" ? text.slice(0, 140) : null;
};

const SAFE_ID_RE = /^[\w.\-:]{1,64}$/;

const buildSessionContextBlock = (raw) => {
  if (!raw || typeof raw !== "object") return "";
  const lines = [];

  const v = raw.validation;
  if (v && typeof v === "object") {
    const errors = clampCount(v.errors);
    const warnings = clampCount(v.warnings);
    const infos = clampCount(v.infos);
    lines.push(
      `Validation status: ${errors} error(s), ${warnings} warning(s), ${infos} info notice(s).` +
        (errors > 0 ? " Export is blocked until the errors are fixed." : ""),
    );
    if (Array.isArray(v.topRules)) {
      const rules = v.topRules
        .slice(0, CONTEXT_MAX_RULES)
        .filter(
          (r) =>
            r &&
            typeof r === "object" &&
            typeof r.code === "string" &&
            RULE_CODE_RE.test(r.code),
        )
        .map((r) => {
          const sev = SEVERITIES.has(r.severity) ? r.severity : "error";
          // Server-side enrichment: one line of catalogue knowledge per
          // rule so the model knows WHAT each finding means, grounded in
          // the same source the validation UI uses.
          const desc = ruleDescription(r.code);
          return (
            `${r.code} (${clampCount(r.count)} ${sev})` +
            (desc ? ` — ${desc}` : "")
          );
        });
      if (rules.length > 0)
        lines.push(`Top findings:\n- ${rules.join("\n- ")}`);
    }
  }

  // Feed facts (client-supplied, sanitized): a handful of REAL identifiers
  // so generated SQL can reference actual agency ids instead of guessing.
  const f = raw.feed;
  if (f && typeof f === "object") {
    if (Array.isArray(f.agencyIds)) {
      const ids = f.agencyIds
        .slice(0, 10)
        .filter((id) => typeof id === "string" && SAFE_ID_RE.test(id));
      if (ids.length > 0) lines.push(`Agency ids: ${ids.join(", ")}.`);
    }
    const counts = [];
    if (f.routes != null) counts.push(`${clampCount(f.routes)} routes`);
    if (f.stops != null) counts.push(`${clampCount(f.stops)} stops`);
    if (f.trips != null) counts.push(`${clampCount(f.trips)} trips`);
    if (counts.length > 0) lines.push(`Feed size: ${counts.join(", ")}.`);
  }

  // Rescue-import note (client-supplied, sanitized): the tolerant loader
  // drops duplicate-PK rows at import (INSERT OR IGNORE). Without this the
  // model drafts DELETE statements against duplicates that no longer exist
  // and the upload report's duplicate_key findings look unfixed when they
  // are already resolved in the working database.
  const adj = raw.importAdjustments;
  if (adj && typeof adj === "object" && !Array.isArray(adj)) {
    const entries = Object.entries(adj)
      .slice(0, 10)
      .filter(
        ([table, count]) =>
          /^[a-z_]{1,40}$/.test(table) && clampCount(count) > 0,
      )
      .map(([table, count]) => `${table}: ${clampCount(count)}`);
    if (entries.length > 0) {
      lines.push(
        `Import note: duplicate primary-key rows were already dropped when this feed was imported (${entries.join(", ")}). ` +
          "duplicate_key findings in the upload report are therefore likely already resolved in the working database — " +
          "recommend re-validating the feed instead of drafting DELETE statements for them.",
      );
    }
  }

  if (typeof raw.tab === "string" && /^[a-z_-]{1,32}$/i.test(raw.tab)) {
    lines.push(`The user is currently on the "${raw.tab}" view.`);
  }

  if (lines.length === 0) return "";
  const block = [
    "[Session context — auto-attached by the app, may lag behind the latest edits]",
    ...lines,
  ].join("\n");
  return block.length > CONTEXT_MAX_CHARS
    ? block.slice(0, CONTEXT_MAX_CHARS)
    : block;
};

const LANG_NAMES = {
  en: "English",
  fr: "French",
  es: "Spanish",
  de: "German",
  pt: "Portuguese",
  zh: "Chinese (Simplified)",
  ar: "Arabic",
  hi: "Hindi",
};

// ─── Anthropic error mapper ───────────────────────────────────────────────
const mapAnthropicError = (err) => {
  if (err && err.name === "AbortError") {
    return Object.assign(new Error("Generation aborted"), {
      code: "ABORTED",
      status: 499,
    });
  }
  const status = err?.status || err?.response?.status;
  const code =
    status === 401
      ? "UPSTREAM_AUTH_ERROR"
      : status === 429
        ? "UPSTREAM_RATE_LIMIT"
        : "UPSTREAM_ERROR";
  return Object.assign(
    new Error(err?.message || "Anthropic API call failed"),
    { code, status: status || 502 },
  );
};

// Cost tiering: coded (paying/beta) users get the premium repair model;
// anonymous free-trial turns run on the cheaper one-shot model
// (NL2SQL_MODEL, Haiku by default — ~10x cheaper per turn). The free trial
// stays a real taste of the product while bounding worst-case spend to
// quota × Haiku pricing. The active model is surfaced in the SSE `meta`
// event, so the UI chip stays truthful.
const resolveChatModel = ({ freeTier = false } = {}) =>
  freeTier
    ? config.NL2SQL_MODEL
    : config.NL2SQL_CHAT_MODEL || config.NL2SQL_MODEL;

// ─── History → Anthropic messages ─────────────────────────────────────────
// Each past assistant turn is collapsed into one text block: the answer plus
// a compact trace of the tools it used (queries with their row counts, the
// fixes it proposed and their outcome). The model keeps continuity ("the
// query above", "apply the second fix") at bounded token cost.
const MAX_TURNS = 10;
const MAX_ANSWER_CHARS = 6000;
const MAX_TRACE_SQL_CHARS = 1200;
const MAX_TRACE_ITEMS = 12;

const clipText = (v, n) => {
  const str = typeof v === "string" ? v : "";
  return str.length > n ? `${str.slice(0, n)}…` : str;
};

const flattenAssistantTurn = (turn) => {
  const parts = [];
  const answer = clipText(turn.content, MAX_ANSWER_CHARS).trim();
  if (answer) parts.push(answer);
  const trace = [];
  const steps = Array.isArray(turn.steps) ? turn.steps.slice(0, MAX_TRACE_ITEMS) : [];
  for (const st of steps) {
    if (!st || typeof st !== "object") continue;
    if (st.kind === "sql" && typeof st.sql === "string") {
      const outcome = st.error
        ? `error: ${clipText(st.error, 200)}`
        : `${Number.isFinite(Number(st.rowCount)) ? Number(st.rowCount) : "?"} rows`;
      trace.push(`- run_sql: ${clipText(st.sql, MAX_TRACE_SQL_CHARS)} → ${outcome}`);
    }
  }
  const proposals = Array.isArray(turn.proposals) ? turn.proposals.slice(0, MAX_TRACE_ITEMS) : [];
  for (const p of proposals) {
    if (!p || typeof p !== "object" || typeof p.sql !== "string") continue;
    const outcome = typeof p.outcome === "string" && p.outcome ? clipText(p.outcome, 200) : "not applied yet";
    trace.push(`- propose_fix "${clipText(p.title, 80)}": ${clipText(p.sql, MAX_TRACE_SQL_CHARS)} → ${outcome}`);
  }
  const actions = Array.isArray(turn.uiActions) ? turn.uiActions.slice(0, MAX_TRACE_ITEMS) : [];
  for (const a of actions) {
    if (a && typeof a.label === "string") trace.push(`- navigate: ${clipText(a.label, 120)}`);
  }
  if (trace.length) parts.push(`[Tools used in this turn]\n${trace.join("\n")}`);
  return parts.join("\n\n").trim();
};

const buildAnthropicMessages = (history, currentUserText) => {
  const trimmed = history.slice(-MAX_TURNS * 2);
  const msgs = [];
  for (const turn of trimmed) {
    if (!turn || typeof turn !== "object") continue;
    if (turn.role === "user" && typeof turn.content === "string" && turn.content.trim()) {
      msgs.push({ role: "user", content: clipText(turn.content, MAX_ANSWER_CHARS) });
    } else if (turn.role === "assistant") {
      const flat = flattenAssistantTurn(turn);
      if (flat) msgs.push({ role: "assistant", content: flat });
    }
  }
  // Anthropic requires strictly alternating roles starting with "user".
  const alternating = [];
  for (const m of msgs) {
    const last = alternating[alternating.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else if (alternating.length === 0 && m.role !== "user") {
      continue;
    } else {
      alternating.push({ ...m });
    }
  }
  if (alternating.length && alternating[alternating.length - 1].role === "user") {
    alternating[alternating.length - 1].content += `\n\n${currentUserText}`;
  } else {
    alternating.push({ role: "user", content: currentUserText });
  }
  return alternating;
};

// ─── Answer stream cleaner ────────────────────────────────────────────────
// Withholds the trailing `<followups>[…]</followups>` tag (and any partial
// "<f…" tail that might become one) from the displayed text; the parsed
// questions are emitted as a separate event once the message ends.
const FOLLOWUPS_OPEN = "<followups>";
const FOLLOWUPS_RE = /<followups>\s*([\s\S]*?)\s*<\/followups>/i;

const makeAnswerCleaner = () => {
  let raw = "";
  let emitted = 0;

  const displayable = (buf) => {
    const at = buf.toLowerCase().indexOf(FOLLOWUPS_OPEN);
    let safe = at === -1 ? buf : buf.slice(0, at);
    if (at === -1) {
      // Hold back a tail that could be the start of the tag.
      const lt = safe.lastIndexOf("<");
      if (lt !== -1 && FOLLOWUPS_OPEN.startsWith(safe.slice(lt).toLowerCase())) {
        safe = safe.slice(0, lt);
      }
    }
    // Trailing whitespace may precede the tag: keep it until real text follows.
    return safe.replace(/\s+$/, "");
  };

  return {
    push(text) {
      raw += text;
      const shown = displayable(raw);
      if (shown.length > emitted) {
        const delta = shown.slice(emitted);
        emitted = shown.length;
        return delta;
      }
      return "";
    },
    finalize() {
      const at = raw.toLowerCase().indexOf(FOLLOWUPS_OPEN);
      const shown = (at === -1 ? raw : raw.slice(0, at)).replace(/\s+$/, "");
      const delta = shown.length > emitted ? shown.slice(emitted) : "";
      emitted = Math.max(emitted, shown.length);
      return delta;
    },
    followups() {
      const m = FOLLOWUPS_RE.exec(raw);
      if (!m) return [];
      try {
        const arr = JSON.parse(m[1]);
        return Array.isArray(arr)
          ? arr.filter((q) => typeof q === "string" && q.trim()).map((q) => q.trim().slice(0, 160)).slice(0, 3)
          : [];
      } catch {
        return [];
      }
    },
    answerText() {
      const at = raw.toLowerCase().indexOf(FOLLOWUPS_OPEN);
      return (at === -1 ? raw : raw.slice(0, at)).trim();
    },
    reset() {
      raw = "";
      emitted = 0;
    },
  };
};

// ─── One model call (streams text, collects tool calls) ───────────────────
const runModelRound = async ({ client, model, messages, signal, emit, cleaner, maxTokens }) => {
  let stream;
  try {
    stream = client.messages.stream(
      {
        model,
        max_tokens: maxTokens,
        system: [
          {
            type: "text",
            text: nl2sqlService.CHAT_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: chatAgentTools.TOOL_DEFINITIONS,
        messages,
      },
      { signal },
    );
  } catch (err) {
    throw mapAnthropicError(err);
  }

  let usage = null;
  let sawText = false;
  try {
    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        emit("tool_pending", { name: event.content_block.name });
      } else if (
        event.type === "content_block_delta" &&
        event.delta &&
        event.delta.type === "text_delta"
      ) {
        const text = event.delta.text || "";
        if (!text) continue;
        sawText = true;
        const shown = cleaner.push(text);
        if (shown) emit("token", { phase: "answer", text: shown });
      } else if (event.type === "message_delta" && event.usage) {
        usage = event.usage;
      }
    }
  } catch (err) {
    throw mapAnthropicError(err);
  }

  let finalMessage = null;
  try {
    finalMessage = await stream.finalMessage();
  } catch {
    /* some SDK versions consume it in the iterator — fall back */
  }
  if (finalMessage?.usage) usage = finalMessage.usage;
  const content = Array.isArray(finalMessage?.content) ? finalMessage.content : [];
  // A non-streaming mock may only return text through finalMessage.
  if (!sawText) {
    for (const block of content) {
      if (block.type === "text" && block.text) {
        const shown = cleaner.push(block.text);
        if (shown) emit("token", { phase: "answer", text: shown });
      }
    }
  }
  return {
    content,
    stopReason: finalMessage?.stop_reason || null,
    toolUses: content.filter((b) => b.type === "tool_use"),
    usage,
  };
};

// ─── Main entry: drive a full chat turn ───────────────────────────────────
const MAX_TOOL_ROUNDS = 8;
const MAX_CONSECUTIVE_TOOL_ERRORS = 4;

/**
 * @param {Object} opts
 * @param {Array}  opts.history       — prior turns (client-managed)
 * @param {string} opts.userMessage   — current user request (string)
 * @param {string} opts.language      — UI language code (en, fr, …)
 * @param {Object} opts.dbCtx         — { db, sessionId, editing } from requireSession
 * @param {string} opts.rateKey       — beta code (or fallback) for rate limit
 * @param {object} [opts.aiLimits]    — per-code AI cap overrides
 * @param {AbortSignal} opts.signal   — wired to the response close
 * @param {(event:string, data:Object) => void} opts.emit — SSE writer
 * @param {string} [opts.conversationId]
 * @param {string} [opts.turnId]
 * @param {Array<{table:string}>} [opts.attachmentRefs]
 */
const streamChatTurn = async ({
  history,
  userMessage,
  language,
  sessionContext = null,
  attachmentRefs = [],
  freeRemaining = null,
  freeTier = false,
  dbCtx,
  rateKey,
  aiLimits = {},
  signal,
  emit,
  conversationId,
  turnId,
}) => {
  if (!config.NL2SQL_CHAT_ENABLED) {
    throw Object.assign(new Error("Chat assistant is currently disabled."), {
      code: "NL2SQL_CHAT_DISABLED",
      status: 503,
    });
  }
  if (!config.ANTHROPIC_API_KEY) {
    throw Object.assign(
      new Error("ANTHROPIC_API_KEY is not configured."),
      { code: "NL2SQL_CHAT_DISABLED", status: 503 },
    );
  }

  const trimmed = (userMessage || "").trim();
  if (trimmed.length < 2) {
    throw Object.assign(new Error("Message is too short (min 2 chars)."), {
      code: "INVALID_INPUT",
      status: 400,
    });
  }
  if (trimmed.length > 2000) {
    throw Object.assign(new Error("Message is too long (max 2000 chars)."), {
      code: "INVALID_INPUT",
      status: 400,
    });
  }
  if (!Array.isArray(history)) {
    throw Object.assign(new Error("history must be an array."), {
      code: "INVALID_INPUT",
      status: 400,
    });
  }

  const limit = aiCostLimiter.check({
    key: rateKey || "anon",
    scope: "chat",
    ...aiLimits,
  });
  if (!limit.ok) {
    const messages = {
      BUDGET_EXHAUSTED:
        "The daily AI budget has been reached. Please try again tomorrow.",
      DAILY_LIMIT_REACHED:
        "You've reached the daily AI request limit for your beta code.",
      RATE_LIMITED: `Rate limit reached (${limit.hourly.limit} messages per hour). Try again in ${limit.retryAfterSec}s.`,
    };
    const status = limit.code === "BUDGET_EXHAUSTED" ? 503 : 429;
    throw Object.assign(new Error(messages[limit.code]), {
      code: limit.code,
      status,
      retryAfterSec: limit.retryAfterSec,
    });
  }

  const client = getClient();
  const model = resolveChatModel({ freeTier });
  const startedAt = Date.now();

  emit("meta", {
    conversationId,
    turnId,
    model,
    mode: "agent",
    freeRemaining,
  });

  // Context blocks travel in the CURRENT user message only (the cached
  // system prompt stays byte-identical; stale context never accumulates in
  // history): [Session context] → [Attached file] → user text.
  const langName = LANG_NAMES[language] || "English";
  const contextBlock = buildSessionContextBlock(sessionContext);
  const attachmentBlock = chatAttachmentService.buildAttachmentContextBlock(
    dbCtx.db,
    attachmentRefs,
  );
  const outboundUserMessage = [
    contextBlock ? `${contextBlock}\nUI language: ${langName}.` : `[UI language: ${langName}]`,
    attachmentBlock,
    trimmed,
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages = buildAnthropicMessages(history, outboundUserMessage);
  const toolCtx = chatAgentTools.createToolContext({ dbCtx, emit });
  const cleaner = makeAnswerCleaner();
  const usageTotals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let rounds = 0;
  let toolCalls = 0;
  let consecutiveErrors = 0;

  const addUsage = (u) => {
    if (!u) return;
    for (const k of Object.keys(usageTotals)) usageTotals[k] += Number(u[k]) || 0;
  };

  try {
    for (;;) {
      if (signal?.aborted) {
        emit("done", { reason: "aborted" });
        return;
      }
      const round = await runModelRound({
        client,
        model,
        messages,
        signal,
        emit,
        cleaner,
        maxTokens: 4096,
      });
      addUsage(round.usage);
      rounds += 1;

      if (round.stopReason !== "tool_use" || round.toolUses.length === 0) break;

      messages.push({ role: "assistant", content: round.content });
      const results = [];
      for (const tu of round.toolUses) {
        if (signal?.aborted) break;
        toolCalls += 1;
        const res = chatAgentTools.executeTool(tu.name, tu.input, toolCtx);
        if (res.isError) consecutiveErrors += 1;
        else consecutiveErrors = 0;
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: res.content,
          ...(res.isError ? { is_error: true } : {}),
        });
      }
      const budgetLeft = MAX_TOOL_ROUNDS - rounds;
      const stopTools =
        budgetLeft <= 0 || consecutiveErrors >= MAX_CONSECUTIVE_TOOL_ERRORS;
      const userContent = stopTools
        ? [
            ...results,
            {
              type: "text",
              text:
                consecutiveErrors >= MAX_CONSECUTIVE_TOOL_ERRORS
                  ? "Several tool calls failed in a row. Stop calling tools and answer the user now with what you know, stating what could not be verified."
                  : "Tool budget for this turn is exhausted. Do not call tools again: answer the user now with what you have.",
            },
          ]
        : results;
      messages.push({ role: "user", content: userContent });
      if (cleaner.answerText()) {
        // Keep a paragraph break between narration and the final answer.
        const gap = cleaner.push("\n\n");
        if (gap) emit("token", { phase: "answer", text: gap });
      }
    }
  } catch (err) {
    logChatUsage({
      conversationId,
      turnId,
      ok: false,
      stage: rounds === 0 ? "pass1" : "loop",
      code: err.code || "UPSTREAM_ERROR",
      rounds,
      tool_calls: toolCalls,
      duration_ms: Date.now() - startedAt,
    });
    throw err;
  }

  const tail = cleaner.finalize();
  if (tail) emit("token", { phase: "answer", text: tail });
  const followups = cleaner.followups();
  if (followups.length) emit("followups", { items: followups });
  emit("usage", { rounds, toolCalls, ...usageTotals });

  logChatUsage({
    conversationId,
    turnId,
    ok: true,
    stage: "complete",
    rounds,
    tool_calls: toolCalls,
    answer_chars: cleaner.answerText().length,
    duration_ms: Date.now() - startedAt,
    ...usageTotals,
  });
  emit("done", { reason: "complete" });
};

module.exports = {
  streamChatTurn,
  buildSessionContextBlock,
  resolveChatModel,
  logChatUsage,
  // Exposed for tests.
  _internals: {
    buildAnthropicMessages,
    flattenAssistantTurn,
    makeAnswerCleaner,
  },
};
