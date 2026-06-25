/**
 * nl2sqlChatService — Multi-turn streaming SQL assistant.
 *
 * Lifecycle of one user turn (driven by `streamChatTurn`):
 *
 *   ┌───── PASS 1 (Anthropic streaming) ─────────────────────────────────┐
 *   │  System prompt: buildChatSystemPrompt() (cached, ephemeral)        │
 *   │  Stop sequence: "</sql>"                                           │
 *   │  Output shape: <preamble>…</preamble>\n<sql>\nSELECT …;            │
 *   │  → emit("token", {phase:"preamble", text:Δ}) for each delta        │
 *   │  → on stream end, extract <preamble> / <sql> blocks                │
 *   │  → emit("sql_generated", {sql, preamble}) OR emit("done") if no SQL│
 *   └────────────────────────────────────────────────────────────────────┘
 *                                  │
 *                                  ▼
 *   ┌───── classifyStatement (sqlConsoleService) ────────────────────────┐
 *   │  Reuses the SAME parser the SQL Console uses — error messages and  │
 *   │  protected-table list match what users see elsewhere.              │
 *   │  - allowMutations: false                                           │
 *   │  - On "mutate" → emit("sql_blocked", {reason, draftSql, …})        │
 *   │  - On "forbidden" → emit("sql_blocked", {reason:"forbidden", …})   │
 *   │  - On "read" → continue                                            │
 *   └────────────────────────────────────────────────────────────────────┘
 *                                  │
 *                                  ▼
 *   ┌───── executeSqlInSession ──────────────────────────────────────────┐
 *   │  Same code path the SQL Console hits. Read-only enforced via       │
 *   │  allowMutations:false. Result truncated at the standard MAX_ROWS   │
 *   │  cap (1000 rows). The full row count + truncation flag are echoed  │
 *   │  to the UI; only the first ~20 rows are forwarded to Claude in     │
 *   │  Pass 2 to control token cost.                                     │
 *   │  → emit("sql_executing", {})                                        │
 *   │  → emit("sql_result", {rowCount, columns, rowsPreview, truncated, │
 *   │           durationMs, modelSampleRows}) on success                 │
 *   │  → emit("sql_error", {message}) on SQLite/runtime failure          │
 *   └────────────────────────────────────────────────────────────────────┘
 *                                  │
 *                                  ▼
 *   ┌───── PASS 2 (Anthropic streaming) ─────────────────────────────────┐
 *   │  Same system prompt (cache hit). New user message contains the     │
 *   │  result snapshot + a directive: "summarize in 2-4 sentences in     │
 *   │  {language}". Plain prose only — no <sql> block expected.          │
 *   │  → emit("token", {phase:"summary", text:Δ}) for each delta         │
 *   │  → emit("usage", {pass:2, …}) at end                               │
 *   └────────────────────────────────────────────────────────────────────┘
 *                                  │
 *                                  ▼
 *                            emit("done", {})
 *
 * Cancellation: the controller wires `req.on("close", () => abort.abort())`.
 * Both Anthropic streams accept `signal`. SQL execution is synchronous
 * (better-sqlite3) so abort during execute is a no-op — the result is
 * discarded by the caller after abort.
 *
 * Rate limiting: per-beta-code sliding 1-hour window in memory. Single
 * process scope — acceptable for the beta footprint. Migrate to Redis when
 * we cluster.
 */

const fs = require("fs");
const path = require("path");
const { Anthropic } = require("@anthropic-ai/sdk");
const config = require("../config");
const nl2sqlService = require("./nl2sqlService");
const sqlConsoleService = require("./edit/sqlConsoleService");
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

// ─── Block extraction (post-stream) ───────────────────────────────────────
// Pulls <preamble>…</preamble> and <sql>…</sql>? from the full assistant
// text. Robust to multiple model output formats — we'd rather salvage a
// borderline response than tell the user "I had nothing to say".
//
// Resolution order for SQL:
//   1. <sql>...</sql> tags (canonical, what the prompt requests)
//   2. <sql>...$ (closing tag missing because we use it as stop_sequence)
//   3. ```sql\n...\n``` markdown fence (some models default to this)
//   4. ```\n...\n``` plain code fence containing what looks like SQL
//   5. Bare statement matching ^(WITH|SELECT|EXPLAIN|UPDATE|INSERT|DELETE)
//      anywhere in the text after the preamble
//
// `extracted.via` is set so we can log which fallback fired.
const extractBlocks = (fullText) => {
  const out = { preamble: "", sql: "", via: null };
  const pre = /<preamble>([\s\S]*?)<\/preamble>/i.exec(fullText);
  if (pre) out.preamble = pre[1].trim();

  // 1 & 2. Tagged form, with or without closing tag.
  const tagged = /<sql>\s*([\s\S]*?)\s*(?:<\/sql>|$)/i.exec(fullText);
  if (tagged && tagged[1].trim()) {
    out.sql = tagged[1].trim();
    out.via = tagged[0].includes("</sql>") ? "tags" : "tags_open_only";
  }

  // 3 & 4. Markdown code fence fallback — strip fence markers and trim.
  if (!out.sql) {
    const fenced = /```(?:sql)?\s*\n?([\s\S]*?)\n?```/i.exec(fullText);
    if (fenced && fenced[1].trim()) {
      out.sql = fenced[1].trim();
      out.via = "fence";
    }
  }

  // 5. Bare SQL statement — last resort. We accept the verbs the SQL
  //    classifier knows about so the result still flows through the same
  //    read-only enforcement.
  if (!out.sql) {
    // Strip the preamble (if any) before searching, to avoid matching
    // the word "select" inside conversational text.
    const after = pre
      ? fullText.slice(pre.index + pre[0].length)
      : fullText;
    const bare =
      /\b(WITH\s+[\s\S]+?;|SELECT\s+[\s\S]+?;|EXPLAIN\s+[\s\S]+?;|UPDATE\s+[\s\S]+?;|INSERT\s+[\s\S]+?;|DELETE\s+[\s\S]+?;)/i.exec(
        after,
      );
    if (bare && bare[1]) {
      out.sql = bare[1].trim();
      out.via = "bare_statement";
    }
  }

  // Fallback: if no <preamble> tag was emitted, use everything before the
  // SQL block (or the whole text if there's none) as the preamble.
  if (!out.preamble) {
    const sqlMarker = /<sql>|```/i.exec(fullText);
    out.preamble = (sqlMarker
      ? fullText.slice(0, sqlMarker.index)
      : fullText
    )
      .replace(/<\/?preamble>/gi, "")
      .trim();
  }
  return out;
};

// ─── Streaming token cleaner ──────────────────────────────────────────────
// Buffers raw deltas and computes the "currently safe to display" preamble
// text by stripping any <preamble>/</preamble>/<sql> tags and holding back
// any trailing partial-tag fragment (e.g. "<", "<pr", "</prea") that might
// resolve into a tag on the next delta.
const makeStreamCleaner = () => {
  let raw = "";
  let lastEmittedLen = 0;

  const computeDisplayable = (buf) => {
    // Find the boundaries of the <preamble> block.
    const startIdx = buf.indexOf("<preamble>");
    let inner;
    if (startIdx === -1) {
      // Tag may not have been emitted yet. Tolerate model variations:
      // if there is no <preamble> open tag but text exists, treat the
      // whole buffer as preamble until a <sql> tag appears.
      inner = buf;
    } else {
      inner = buf.slice(startIdx + "<preamble>".length);
    }
    // Cut at </preamble> or <sql> if present.
    const endTag = inner.indexOf("</preamble>");
    const sqlTag = inner.indexOf("<sql>");
    let cutoff = inner.length;
    if (endTag !== -1) cutoff = Math.min(cutoff, endTag);
    if (sqlTag !== -1) cutoff = Math.min(cutoff, sqlTag);
    let safe = inner.slice(0, cutoff);
    // Hold back any trailing "<" that might be the start of a tag.
    const lastLT = safe.lastIndexOf("<");
    if (lastLT !== -1) {
      const tail = safe.slice(lastLT);
      // If the tail looks like a complete safe character sequence (e.g.
      // standalone "<" used in text), still hold it — better safe.
      if (!/^<[a-z\/][a-z]*>$/i.test(tail)) {
        safe = safe.slice(0, lastLT);
      }
    }
    return safe;
  };

  return {
    pushDelta(text) {
      raw += text;
      const display = computeDisplayable(raw);
      if (display.length > lastEmittedLen) {
        const newPart = display.slice(lastEmittedLen);
        lastEmittedLen = display.length;
        return newPart;
      }
      return "";
    },
    finalize() {
      // On stream end, flush whatever remaining displayable text we held
      // back (no risk of partial-tag now).
      const startIdx = raw.indexOf("<preamble>");
      let inner = startIdx === -1 ? raw : raw.slice(startIdx + "<preamble>".length);
      const endTag = inner.indexOf("</preamble>");
      const sqlTag = inner.indexOf("<sql>");
      let cutoff = inner.length;
      if (endTag !== -1) cutoff = Math.min(cutoff, endTag);
      if (sqlTag !== -1) cutoff = Math.min(cutoff, sqlTag);
      const final = inner.slice(0, cutoff);
      if (final.length > lastEmittedLen) {
        const tail = final.slice(lastEmittedLen);
        lastEmittedLen = final.length;
        return tail;
      }
      return "";
    },
    getRaw() {
      return raw;
    },
  };
};

// ─── History → Anthropic messages array ───────────────────────────────────
// Each historical assistant turn is collapsed to a single short text block
// containing the SQL + a one-line result summary. This keeps token cost
// bounded as history grows. Trim to MAX_TURNS most recent.
const MAX_TURNS = 10;

const flattenAssistantTurn = (turn) => {
  const parts = [];
  if (turn.preamble) parts.push(turn.preamble);
  if (turn.sql) {
    parts.push("<sql>\n" + turn.sql + "\n</sql>");
    if (turn.blocked) {
      parts.push(`(SQL was a ${turn.blocked.reason}; not executed.)`);
    } else if (turn.resultSummary) {
      parts.push(`(Result: ${turn.resultSummary})`);
    }
  }
  if (turn.summary) parts.push(turn.summary);
  return parts.filter(Boolean).join("\n").trim();
};

const buildAnthropicMessages = (history, currentUserText) => {
  // Take only the last MAX_TURNS pairs (each pair = user+assistant).
  // History is provided client-side as a flat array; we trust ordering.
  const trimmed = history.slice(-MAX_TURNS * 2);
  const msgs = [];
  for (const turn of trimmed) {
    if (turn.role === "user" && typeof turn.content === "string") {
      msgs.push({ role: "user", content: turn.content });
    } else if (turn.role === "assistant") {
      const flat = flattenAssistantTurn(turn);
      if (flat) msgs.push({ role: "assistant", content: flat });
    }
  }
  msgs.push({ role: "user", content: currentUserText });
  return msgs;
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

// ─── Pass 2 prompt (result summarisation) ─────────────────────────────────
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

// Hard ceilings to keep the result snapshot sent to Claude under control.
const MODEL_SAMPLE_ROWS = 20;
const MODEL_SAMPLE_BYTES = 6 * 1024;

const buildResultSnapshot = (sqlResult) => {
  const cols = sqlResult.columns || [];
  const rows = sqlResult.rows || [];
  const sample = rows.slice(0, MODEL_SAMPLE_ROWS);
  let payload = JSON.stringify({
    rowCount: sqlResult.rowCount || rows.length,
    truncated: Boolean(sqlResult.truncated),
    columns: cols,
    sampleRows: sample,
  });
  if (payload.length > MODEL_SAMPLE_BYTES) {
    // Wide rows / long strings — fall back to a textual digest.
    payload = JSON.stringify({
      rowCount: sqlResult.rowCount || rows.length,
      truncated: true,
      columns: cols,
      note: `Result is too wide to include verbatim. ${rows.length} rows × ${cols.length} columns. First row keys: ${cols.slice(0, 8).join(", ")}.`,
    });
  }
  return { payload, sample };
};

const buildPass2UserMessage = ({ sql, sqlResult, language }) => {
  const langName = LANG_NAMES[language] || "English";
  const { payload } = buildResultSnapshot(sqlResult);
  return [
    `The server executed the SQL you proposed. Here is the result snapshot (JSON):`,
    "",
    payload,
    "",
    `Now write a 2-4 sentence summary in ${langName} of what the data shows.`,
    `Reference concrete numbers from the result. Plain prose only — NO code,`,
    `NO markdown headings, NO XML tags, NO <sql> block.`,
    `If the result is empty (rowCount = 0), say so plainly and suggest one`,
    `concrete refinement the user could try.`,
  ].join("\n");
};

// ─── Pass 1: SQL generation streaming ─────────────────────────────────────
const runPass1 = async ({ client, model, history, userMessage, signal, emit }) => {
  const messages = buildAnthropicMessages(history, userMessage);
  const cleaner = makeStreamCleaner();
  let pass1Usage = null;

  let stream;
  try {
    stream = client.messages.stream(
      {
        model,
        // 1024 was occasionally tight when Haiku produced verbose SQL
        // (window functions + CTEs) — bumped to 2048 to leave headroom.
        // Pass-2 stays at 768 since it only writes prose.
        max_tokens: 2048,
        stop_sequences: ["</sql>"],
        system: [
          {
            type: "text",
            text: nl2sqlService.CHAT_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages,
      },
      { signal },
    );
  } catch (err) {
    throw mapAnthropicError(err);
  }

  try {
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta &&
        event.delta.type === "text_delta"
      ) {
        const text = event.delta.text || "";
        if (!text) continue;
        const display = cleaner.pushDelta(text);
        if (display) emit("token", { phase: "preamble", text: display });
      } else if (event.type === "message_delta" && event.usage) {
        // Final usage event arrives at the end of the stream.
        pass1Usage = event.usage;
      }
    }
  } catch (err) {
    throw mapAnthropicError(err);
  }

  // Flush any held-back tail from the cleaner.
  const tail = cleaner.finalize();
  if (tail) emit("token", { phase: "preamble", text: tail });

  // Pull the final aggregated message for usage + raw text.
  let finalMessage = null;
  try {
    finalMessage = await stream.finalMessage();
  } catch {
    /* finalMessage may already have been read by the iterator on some
       SDK versions — fall back to what we have. */
  }
  if (finalMessage && finalMessage.usage) pass1Usage = finalMessage.usage;

  const fullText = cleaner.getRaw() || (finalMessage?.content?.[0]?.text || "");
  const { preamble, sql, via } = extractBlocks(fullText);

  // Log the rare case where we got NO sql at all — useful for tuning the
  // system prompt. Truncate to 600 chars so the log file doesn't bloat.
  if (!sql) {
    console.warn(
      "[nl2sql-chat] pass1 produced no SQL block. Raw model output (truncated):\n" +
        fullText.slice(0, 600),
    );
  } else if (via && via !== "tags") {
    // Non-canonical extraction — the model deviated from the requested
    // format. Useful breadcrumb without spamming the log on the happy path.
    console.info(`[nl2sql-chat] pass1 SQL extracted via fallback: ${via}`);
  }

  if (pass1Usage) emit("usage", { pass: 1, ...pass1Usage });

  return { preamble, sql, fullText };
};

// ─── Pass 2: result summarisation streaming ───────────────────────────────
const runPass2 = async ({
  client,
  model,
  history,
  userMessage,
  pass1Preamble,
  pass1Sql,
  sqlResult,
  language,
  signal,
  emit,
}) => {
  // Build messages: prior history + current user msg + the assistant's
  // pass-1 turn (so the model has full context) + a synthetic user msg
  // with the result snapshot.
  const baseMessages = buildAnthropicMessages(history, userMessage);
  // Append the pass-1 assistant content (pre-execution).
  const assistantContent = [
    pass1Preamble ? `<preamble>${pass1Preamble}</preamble>` : "",
    pass1Sql ? `<sql>\n${pass1Sql}\n</sql>` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const pass2Messages = [
    ...baseMessages,
    { role: "assistant", content: assistantContent },
    {
      role: "user",
      content: buildPass2UserMessage({
        sql: pass1Sql,
        sqlResult,
        language,
      }),
    },
  ];

  let stream;
  try {
    stream = client.messages.stream(
      {
        model,
        max_tokens: 768,
        system: [
          {
            type: "text",
            text: nl2sqlService.CHAT_SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: pass2Messages,
      },
      { signal },
    );
  } catch (err) {
    throw mapAnthropicError(err);
  }

  let pass2Usage = null;
  let summary = "";

  try {
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta &&
        event.delta.type === "text_delta"
      ) {
        const text = event.delta.text || "";
        if (!text) continue;
        summary += text;
        emit("token", { phase: "summary", text });
      } else if (event.type === "message_delta" && event.usage) {
        pass2Usage = event.usage;
      }
    }
  } catch (err) {
    throw mapAnthropicError(err);
  }

  let finalMessage = null;
  try {
    finalMessage = await stream.finalMessage();
  } catch {
    /* see Pass 1 */
  }
  if (finalMessage && finalMessage.usage) pass2Usage = finalMessage.usage;

  if (pass2Usage) emit("usage", { pass: 2, ...pass2Usage });

  return { summary };
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

// ─── Main entry: drive a full chat turn ───────────────────────────────────
/**
 * @param {Object} opts
 * @param {Array}  opts.history       — prior turns (client-managed)
 * @param {string} opts.userMessage   — current user request (string)
 * @param {string} opts.language      — UI language code (en, fr, …)
 * @param {Object} opts.dbCtx         — { db, sessionId } from requireSession
 * @param {string} opts.rateKey       — beta code (or fallback) for rate limit
 * @param {object} [opts.aiLimits]    — per-code AI cap overrides for beta
 *                                       holders ({dailyLimit?, hourlyLimit?});
 *                                       {} for anon → strict config defaults
 * @param {AbortSignal} opts.signal   — wired to req close from controller
 * @param {(event:string, data:Object) => void} opts.emit — SSE writer
 * @param {string} [opts.conversationId] — opaque, echoed back in events
 * @param {string} [opts.turnId]      — opaque, echoed back in events
 */
const streamChatTurn = async ({
  history,
  userMessage,
  language,
  sessionContext = null,
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
    throw Object.assign(
      new Error("Message is too short (min 2 chars)."),
      { code: "INVALID_INPUT", status: 400 },
    );
  }
  if (trimmed.length > 2000) {
    throw Object.assign(
      new Error("Message is too long (max 2000 chars)."),
      { code: "INVALID_INPUT", status: 400 },
    );
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
    mode: "read",
    // Anonymous free-trial allowance left AFTER this turn (null for coded
    // users) — drives the "N free messages left" chip in the drawer.
    freeRemaining,
  });

  // Companion awareness: prepend the sanitized session snapshot to the
  // CURRENT user message only. The client stores its own raw copy of the
  // user text in history, so past contexts never pile up turn after turn.
  const contextBlock = buildSessionContextBlock(sessionContext);
  const outboundUserMessage = contextBlock
    ? `${contextBlock}\n\n${trimmed}`
    : trimmed;

  // ── PASS 1 — generate SQL ──────────────────────────────────────────────
  let pass1;
  try {
    pass1 = await runPass1({
      client,
      model,
      history,
      userMessage: outboundUserMessage,
      signal,
      emit,
    });
  } catch (err) {
    logChatUsage({
      conversationId,
      turnId,
      ok: false,
      stage: "pass1",
      code: err.code || "UPSTREAM_ERROR",
      duration_ms: Date.now() - startedAt,
    });
    throw err;
  }

  // No <sql> block? Treat as a clarifying question — done.
  if (!pass1.sql) {
    logChatUsage({
      conversationId,
      turnId,
      ok: true,
      stage: "clarify",
      duration_ms: Date.now() - startedAt,
    });
    emit("done", { reason: "clarify" });
    return;
  }

  // ── Classify SQL (read-only enforcement) ───────────────────────────────
  const parsed = sqlConsoleService.parseStatements(pass1.sql, {
    allowMutations: false,
  });
  if (!parsed.ok) {
    // Determine reason: mutation in read mode vs forbidden verb / table.
    // The error string from parseStatements distinguishes them.
    const isMutation = /Mutations are not allowed/i.test(parsed.error);
    emit("sql_blocked", {
      reason: isMutation ? "mutation_in_read_mode" : "forbidden",
      message: parsed.error,
      draftSql: pass1.sql,
      preamble: pass1.preamble,
    });
    logChatUsage({
      conversationId,
      turnId,
      ok: true,
      stage: "blocked",
      reason: isMutation ? "mutation_in_read_mode" : "forbidden",
      duration_ms: Date.now() - startedAt,
    });
    emit("done", { reason: "blocked" });
    return;
  }

  // ── Surface the generated SQL to the UI before execution ───────────────
  emit("sql_generated", {
    sql: pass1.sql,
    preamble: pass1.preamble,
  });

  // Cancellation check before paying for execution.
  if (signal && signal.aborted) {
    emit("done", { reason: "aborted" });
    return;
  }

  // ── Execute via the same code path the SQL Console uses ────────────────
  emit("sql_executing", {});
  const execStart = Date.now();
  let execResult;
  try {
    execResult = sqlConsoleService.executeSqlInSession(dbCtx, pass1.sql, {
      allowMutations: false,
    });
  } catch (err) {
    emit("sql_error", {
      message: err?.message || "SQL execution failed.",
    });
    logChatUsage({
      conversationId,
      turnId,
      ok: false,
      stage: "execute",
      duration_ms: Date.now() - startedAt,
      sql_duration_ms: Date.now() - execStart,
    });
    emit("done", { reason: "sql_error" });
    return;
  }
  if (execResult.status >= 400) {
    emit("sql_error", {
      message: execResult.body?.error || "SQL execution failed.",
      status: execResult.status,
    });
    logChatUsage({
      conversationId,
      turnId,
      ok: false,
      stage: "execute",
      duration_ms: Date.now() - startedAt,
      sql_duration_ms: Date.now() - execStart,
    });
    emit("done", { reason: "sql_error" });
    return;
  }

  const body = execResult.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const columns = Array.isArray(body.columns) ? body.columns : [];
  const rowCount = body.rowCount ?? rows.length;
  // UI preview: first 50 rows. Model snapshot: first 20 (handled later).
  const PREVIEW_ROWS = 50;
  const rowsPreview = rows.slice(0, PREVIEW_ROWS);
  emit("sql_result", {
    rowCount,
    columns,
    rowsPreview,
    truncated: Boolean(body.truncated) || rows.length > PREVIEW_ROWS,
    durationMs: body.duration_ms ?? Date.now() - execStart,
  });

  // ── PASS 2 — summarise the result in natural language ──────────────────
  if (signal && signal.aborted) {
    emit("done", { reason: "aborted" });
    return;
  }

  let pass2;
  try {
    pass2 = await runPass2({
      client,
      model,
      history,
      userMessage: trimmed,
      pass1Preamble: pass1.preamble,
      pass1Sql: pass1.sql,
      sqlResult: { rowCount, columns, rows, truncated: body.truncated },
      language,
      signal,
      emit,
    });
  } catch (err) {
    // Pass 2 failure is non-fatal — the user got their SQL + result; only
    // the prose summary is missing. Emit a soft error and finish.
    emit("sql_error", {
      message: err?.message || "Summary generation failed.",
      stage: "summary",
    });
    logChatUsage({
      conversationId,
      turnId,
      ok: false,
      stage: "pass2",
      code: err.code || "UPSTREAM_ERROR",
      duration_ms: Date.now() - startedAt,
    });
    emit("done", { reason: "summary_failed" });
    return;
  }

  logChatUsage({
    conversationId,
    turnId,
    ok: true,
    stage: "complete",
    row_count: rowCount,
    duration_ms: Date.now() - startedAt,
    sql_duration_ms: body.duration_ms ?? null,
    summary_chars: (pass2?.summary || "").length,
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
    extractBlocks,
    makeStreamCleaner,
    buildAnthropicMessages,
    buildPass2UserMessage,
  },
};
