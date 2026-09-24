/**
 * aiSummaryService — one-shot AI summaries of structured feed data.
 *
 *   POST /gtfs/ai/summarize   { kind: "changelog" | "diff", language, payload? }
 *
 *   • changelog — release notes written from the session's edit log
 *     (`_edit_log`, undone entries excluded). The markdown is also stored in
 *     `<session dir>/_changelog.md` so the export can ship it as CHANGELOG.md.
 *   • diff — a business-level reading of a feed comparison (POST /diff
 *     result handed back by the client: per-table counts and samples).
 *
 * Gated like the chat (beta code or free trial), charged against the same
 * AI cost limiter, same model resolution. The model only ever sees compact,
 * server-trimmed data; the answer is markdown displayed by the client.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const config = require("../config");
const aiCostLimiter = require("./aiCostLimiter");
const freeTierLimiter = require("./freeTierLimiter");
const nl2sqlChatService = require("./nl2sqlChatService");
const { recordEvent, extractReqMeta } = require("./eventLogger");
const { requireSession } = require("./edit/_editCore");
const { GTFS_UPLOAD_DIR } = require("./sessionManager");

const KINDS = new Set(["changelog", "diff"]);
const MAX_LOG_ENTRIES = 400;
const MAX_DIFF_SAMPLES = 5;
const MAX_OUTPUT_TOKENS = 1800;
const CHANGELOG_FILE = "_changelog.md";
const LANG_NAMES = { en: "English", fr: "French", es: "Spanish", de: "German", pt: "Portuguese", zh: "Chinese (Simplified)", ar: "Arabic", hi: "Hindi" };

const changelogPath = (sessionId) => path.join(GTFS_UPLOAD_DIR, sessionId, CHANGELOG_FILE);

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);

// ── Payload builders ───────────────────────────────────────────────────────

const feedIdentity = (db) => {
  const q = (sql) => {
    try {
      return db.prepare(sql).get() || {};
    } catch {
      return {};
    }
  };
  const info = q("SELECT feed_publisher_name, feed_version, feed_start_date, feed_end_date, feed_lang FROM feed_info LIMIT 1");
  const agency = q("SELECT agency_name FROM agency LIMIT 1");
  const counts = q("SELECT (SELECT COUNT(*) FROM routes) AS routes, (SELECT COUNT(*) FROM trips) AS trips, (SELECT COUNT(*) FROM stops) AS stops");
  return {
    publisher: info.feed_publisher_name || agency.agency_name || null,
    feed_version: info.feed_version || null,
    feed_dates: info.feed_start_date ? `${info.feed_start_date}–${info.feed_end_date || "?"}` : null,
    counts,
  };
};

const buildChangelogPayload = (db) => {
  const total = db.prepare("SELECT COUNT(*) AS n FROM _edit_log WHERE undone = 0").get().n;
  const rows = db
    .prepare(`SELECT ts, entity, entity_id, action, description FROM _edit_log WHERE undone = 0 ORDER BY id ASC LIMIT ${MAX_LOG_ENTRIES}`)
    .all()
    .map((r) => ({ ts: r.ts, entity: r.entity, id: clip(String(r.entity_id || ""), 80), action: r.action, what: clip(r.description || "", 200) }));
  return { feed: feedIdentity(db), edits_total: total, edits_shown: rows.length, edits: rows };
};

const trimDiffPayload = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const summary = raw.summary && typeof raw.summary === "object" ? raw.summary : {};
  const tables = {};
  for (const [name, info] of Object.entries(raw.tables || {})) {
    if (!info || typeof info !== "object" || !/^[a-z_]{1,40}$/.test(name)) continue;
    const added = Number(info.added) || 0;
    const removed = Number(info.removed) || 0;
    const changed = Number(info.changed) || 0;
    if (!added && !removed && !changed) continue;
    const s = info.samples || {};
    const shrink = (row) => {
      if (!row || typeof row !== "object") return row;
      const out = {};
      for (const [k, v] of Object.entries(row).slice(0, 12)) out[k] = clip(v == null ? v : String(v), 60);
      return out;
    };
    tables[name] = {
      added,
      removed,
      changed,
      samples: {
        added: (Array.isArray(s.added) ? s.added : []).slice(0, MAX_DIFF_SAMPLES).map(shrink),
        removed: (Array.isArray(s.removed) ? s.removed : []).slice(0, MAX_DIFF_SAMPLES).map(shrink),
        changed: (Array.isArray(s.changed) ? s.changed : []).slice(0, MAX_DIFF_SAMPLES).map((c) => ({
          key: shrink(c?.key),
          changed_columns: Array.isArray(c?.changedColumns) ? c.changedColumns.slice(0, 10) : [],
          before: shrink(c?.before),
          after: shrink(c?.after),
        })),
      },
    };
  }
  return {
    summary: { added: Number(summary.added) || 0, removed: Number(summary.removed) || 0, changed: Number(summary.changed) || 0, tables_with_changes: Number(summary.tablesWithChanges) || 0 },
    tables,
  };
};

// ── Prompts ────────────────────────────────────────────────────────────────

const systemPromptFor = (kind, language) => {
  const lang = LANG_NAMES[language] || "English";
  const common = `Write in ${lang}. Output GitHub-flavoured markdown only (no preamble, no code fences around the whole answer). Never invent a change that is not in the data; when the data is truncated, say so in one line. Aggregate repeated edits into counts ("14 stops renamed") and name a few concrete examples with their ids in backticks.`;
  if (kind === "changelog") {
    return `You write release notes for a GTFS transit feed update, read by data consumers (journey planners, app developers) and by the operator's own team. The input is the ordered edit log of an editing session (entity, id, action, description).
${common}
Structure: a title line "# Release notes — <publisher or feed> <version or date>", a 2–3 sentence summary of what this update does for passengers, then sections with bullets only for the groups that have changes: "## Routes and trips", "## Stops", "## Calendars and service", "## Shapes", "## Fares and other files", "## Data quality fixes" (validation-driven edits: colours, URLs, ids, whitespace…). Finish with "## Things to check" listing at most 3 points a consumer should verify (e.g. renamed ids, removed trips). Keep it under 350 words.`;
  }
  return `You explain the differences between two versions of a GTFS transit feed (the loaded feed vs. another file) to a transit planner in plain business language: what changes for passengers and for downstream consumers. The input is a per-table diff (counts of added/removed/changed rows plus a few sample rows).
${common}
Structure: "## In short" (2–3 sentences: is this a minor update, a timetable change, a network change?), "## What changed" with bullets grouped by theme (network: routes/agencies; stops; service and calendars; timetable: trips, stop_times, frequencies; geometry: shapes; fares; other), each bullet quantified from the counts and illustrated by samples; "## Risks before publishing" (at most 4 bullets: removed stops still referenced, ids that changed, calendar gaps, large timetable shifts). If nothing changed, say the feeds are identical in one line. Keep it under 300 words.`;
};

// ── Handler ────────────────────────────────────────────────────────────────

const summarize = async (req, res) => {
  if (!config.NL2SQL_CHAT_ENABLED) {
    return res.status(503).json({ error: "NL2SQL_CHAT_DISABLED", message: "The AI assistant is disabled on this server." });
  }
  const sessionCtx = requireSession(req, res);
  if (!sessionCtx) return;
  const body = req.body || {};
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!KINDS.has(kind)) return res.status(400).json({ error: "INVALID_INPUT", message: "kind must be 'changelog' or 'diff'." });
  const language = typeof body.language === "string" && LANG_NAMES[body.language] ? body.language : "en";

  let payload;
  if (kind === "changelog") {
    payload = buildChangelogPayload(sessionCtx.db);
    if (payload.edits_total === 0) return res.status(409).json({ error: "NO_EDITS", message: "No edit to describe: the edit log is empty." });
  } else {
    payload = trimDiffPayload(body.payload && body.payload.diff);
    if (!payload) return res.status(400).json({ error: "INVALID_INPUT", message: "payload.diff (the POST /diff result) is required." });
  }

  // Same access rules as a chat turn: beta quotas or one free-trial message.
  const rateKey = req.betaTester?.code || `anon:${sessionCtx.sessionId}`;
  const aiLimits = aiCostLimiter.betaLimitsFor(req.betaTester);
  if (req.freeTier) {
    const quota = freeTierLimiter.check({ sessionId: sessionCtx.sessionId, ip: req.ip });
    if (!quota.ok) {
      return res.status(403).json({ error: "FREE_QUOTA_EXHAUSTED", message: "Free trial messages used up. Enter a beta access code to keep going." });
    }
    freeTierLimiter.consume({ sessionId: sessionCtx.sessionId, ip: req.ip });
  }
  const limit = aiCostLimiter.check({ key: rateKey, scope: "chat", ...aiLimits });
  if (!limit.ok) {
    const status = limit.code === "BUDGET_EXHAUSTED" ? 503 : 429;
    return res.status(status).json({ error: limit.code, message: "AI request limit reached. Try again later.", retryAfterSec: limit.retryAfterSec });
  }

  let client;
  try {
    client = nl2sqlChatService.getClient();
  } catch (err) {
    return res.status(err.status || 503).json({ error: err.code || "AI_UNAVAILABLE", message: err.message });
  }
  const model = nl2sqlChatService.resolveChatModel({ freeTier: Boolean(req.freeTier) });
  const startedAt = Date.now();
  try {
    const message = await client.messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemPromptFor(kind, language),
      messages: [{ role: "user", content: `${kind === "changelog" ? "Edit log" : "Feed diff"} (JSON):\n${JSON.stringify(payload)}` }],
    });
    const markdown = (message.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!markdown) throw new Error("Empty answer from the model.");
    let stored = false;
    if (kind === "changelog") {
      try {
        fs.writeFileSync(changelogPath(sessionCtx.sessionId), `${markdown}\n`, "utf8");
        stored = true;
      } catch (err) {
        console.warn("changelog store failed:", err.message);
      }
    }
    recordEvent("ai.summary", { ...extractReqMeta(req), kind, model, durationMs: Date.now() - startedAt, anon: Boolean(req.freeTier) });
    res.json({
      kind,
      language,
      model,
      markdown,
      stored,
      usage: { input_tokens: message.usage?.input_tokens ?? null, output_tokens: message.usage?.output_tokens ?? null },
      ...(kind === "changelog" ? { edits_total: payload.edits_total, edits_shown: payload.edits_shown } : {}),
    });
  } catch (err) {
    console.error("ai summarize error:", err.message);
    res.status(502).json({ error: "AI_ERROR", message: err.message });
  }
};

/** Path of the stored changelog for the export (null when none). */
const storedChangelogPath = (sessionId) => {
  const p = changelogPath(sessionId);
  return fs.existsSync(p) ? p : null;
};

module.exports = { summarize, storedChangelogPath, _internals: { buildChangelogPayload, trimDiffPayload, systemPromptFor } };
