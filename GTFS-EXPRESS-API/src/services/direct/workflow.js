/**
 * direct/workflow — the direct mode's fixed workflow, its loop held by the code, not by a model:
 *
 *   1. the agent (direct/agent) changes the working copy in SQL until it calls finish — or asks the person one
 *      question (ask_person): the turn stops there, its conversation and writes held for the session, and resumes
 *      with the answer;
 *   2. the facts (direct/facts): the last simulation run again with the canonical validator, stated by the engine;
 *   3. the reviewer (direct/reviewer): another model, the brief and the facts only, a report per demand;
 *   4. a report with demands not done, changes not asked, or the facts with a new validator error or a broken
 *      integrity sends the agent back — the reviewer's findings as one message, nothing else of the reviewer —,
 *      then the facts and the review again: MAX_CORRECTIONS rounds at most, then the result goes to the person as
 *      it stands;
 *   5. the result: the preview the commit replays exactly (G6), marked as the direct mode's with its report
 *      (engine.markDirect), the report, the facts, the validator's verdict. The delivery is POST /transform/commit
 *      with the person's one decision (acknowledge.direct, by name), recorded with the report; only a new validator
 *      error (and a broken integrity) blocks it.
 *
 *   runDirect({ db, sessionId, dataVersion, country, region, brief, documentIds, answer, language, freeTier, rateKey,
 *               aiLimits, signal, emit, req, today, fetchImpl }) → the result, or null when aborted
 *     country and region: the ones the named periods resolve with (the session's school region when none is given);
 *     today and fetchImpl: the date and the calendar service a caller freezes (an evaluation world)
 *
 * Events (emit): meta { mode: "direct", models: { agent, reviewer }, trial, allowance }, step { kind: reading |
 * querying | writing | measuring | reviewing | correcting, by: agent | reviewer, … }, question { question, options,
 * why? }, report { round, previewId, report, facts, validation }, retry, usage { agent and reviewer: rounds and the four token meters; budget, durationMs },
 * done { reason: complete |
 * incomplete | asked | aborted, previewId, deliverable, report, facts, validation, account, corrections, question? }.
 * The models' words are not streamed: the result is the report and the facts.
 *
 * The AI's cost is bounded like every assistant's turn: the limiter counts the turn once (aiCostLimiter), the agent and the reviewer
 * spend under one ceiling (llm/turnBudget), every call is metered under the route's feature (llm/aiMeter: direct),
 * and every request passes the personal-data scrub with the persons of the working copy's journal known.
 */

"use strict";

const crypto = require("crypto");
const config = require("../../config");
const aiCostLimiter = require("../aiCostLimiter");
const nl2sqlChatService = require("../nl2sqlChatService");
const eventLogger = require("../eventLogger");
const personalData = require("../llm/personalData");
const briefDocuments = require("../network/briefDocumentService");
const engine = require("../transform/engine");
const { turnBudget } = require("../llm/turnBudget");
const { buildFeedModel } = require("../transform/feedModel");
const { feedOverview } = require("../transform/modelText");
const { createWorkingCopy } = require("./workingCopy");
const { runLoop } = require("./modelLoop");
const { factsOf } = require("./facts");
const agent = require("./agent");
const reviewer = require("./reviewer");

const MAX_CORRECTIONS = 2;
const REVIEW_MAX_ROUNDS = 16;
const MAX_BRIEF_CHARS = 60000;
// A turn held by a question waits this long for its answer (the previews it built live as long).
const PENDING_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING = 200;

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);

// ── Turns held by a question ────────────────────────────────────────────────

const _pending = new Map();
const prune = () => {
  const now = Date.now();
  for (const [k, v] of _pending) if (now - v.at > PENDING_TTL_MS) _pending.delete(k);
  while (_pending.size > MAX_PENDING) _pending.delete(_pending.keys().next().value);
};
const briefKey = (brief, documentIds) => crypto.createHash("sha256").update(`${brief}\u0000${(documentIds || []).join(",")}`).digest("hex");
const keepPending = (sessionId, held) => {
  if (!sessionId) return;
  prune();
  _pending.set(sessionId, { ...held, at: Date.now() });
};
/** The session's held turn for this brief, taken (an answer resumes it once); another brief's is dropped. */
const takePending = (sessionId, key) => {
  prune();
  const held = sessionId ? _pending.get(sessionId) : null;
  if (!held) return null;
  _pending.delete(sessionId);
  return held.key === key ? held : null;
};

/** The person's answer as the body gives it: a text, or { question, text }. */
const answerOf = (raw) => {
  if (typeof raw === "string" && raw.trim()) return { text: raw.trim().slice(0, 2000) };
  if (raw && typeof raw === "object" && typeof raw.text === "string" && raw.text.trim()) return { text: raw.text.trim().slice(0, 2000), ...(typeof raw.question === "string" && raw.question.trim() ? { question: raw.question.trim().slice(0, 600) } : {}) };
  return null;
};

// ── The loop's findings ─────────────────────────────────────────────────────

/** What sends the agent back: the demands measured not done, the changes not asked, the validator's new errors, a broken integrity. */
const findingsOf = (report, facts) => [
  ...(report?.demands || []).filter((d) => d.status === "not_done").map((d) => ({ kind: "not_done", quote: d.quote, evidence: d.evidence, where: d.where })),
  ...(report?.not_asked || []).map((n) => ({ kind: "not_asked", what: n.what, why: n.why })),
  ...(facts?.validator?.new_errors || []).map((e) => ({ kind: "validator", code: e.code, before: e.before, after: e.after })),
  ...(facts?.integrity || []).map((i) => ({ kind: "integrity", code: i.code, count: i.count, ...(i.refs ? { refs: i.refs } : {}) })),
];

const whereText = (w) => {
  const parts = ["line", "date", "stop"].filter((k) => w && w[k]).map((k) => `${k} ${w[k]}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
};

/** The findings as the agent reads them: nothing of the reviewer but what it measured wrong. */
const correctionText = (findings, round) => {
  const notDone = findings.filter((f) => f.kind === "not_done");
  const notAsked = findings.filter((f) => f.kind === "not_asked");
  const engineSaid = findings.filter((f) => f.kind === "validator" || f.kind === "integrity");
  const out = [`[Review — correction ${round}/${MAX_CORRECTIONS}] An independent review measured the copy against the brief. Fix what it finds with write (query first when you need to), check it, then call finish again with your account of every demand.`];
  if (notDone.length) out.push(`Not done:\n${notDone.map((f) => `- « ${f.quote} » — ${f.evidence}${whereText(f.where)}`).join("\n")}`);
  if (notAsked.length) out.push(`Changed without being asked (undo it unless a demand of the brief needs it):\n${notAsked.map((f) => `- ${f.what} — ${f.why}`).join("\n")}`);
  if (engineSaid.length) out.push(`The engine (these block the delivery):\n${engineSaid.map((f) => (f.kind === "validator" ? `- the canonical validator's new error ${f.code}: ${f.before} → ${f.after}` : `- integrity broken: ${f.code} ×${f.count}${f.refs ? ` — references to no row: ${f.refs.map((r) => `${r.ref} ×${r.count}`).join(", ")}` : ""}`)).join("\n")}`);
  return out.join("\n\n");
};

// What the delivery record keeps of the facts: the diff and the rows per table, the validator — not the examples.
const factsDigest = (facts) => ({ diff: facts.diff, tables: facts.tables.map(({ table, added, removed, changed }) => ({ table, added, removed, changed })), integrity: facts.integrity, validator: facts.validator });

// ── The turn ────────────────────────────────────────────────────────────────

const runDirectTurn = async ({ db, sessionId = null, dataVersion = null, country = null, region: givenRegion = null, brief, documentIds = [], answer = null, language = "en", freeTier = false, rateKey, aiLimits = {}, signal, emit = () => {}, req = null, today = null, fetchImpl = null, settle = null }) => {
  const text = String(brief || "").trim();
  if (text.length < 3) throw Object.assign(new Error("brief is required (≥ 3 characters)."), { code: "INVALID_INPUT", status: 400 });
  if (text.length > MAX_BRIEF_CHARS) throw Object.assign(new Error(`brief is too long (max ${MAX_BRIEF_CHARS} characters).`), { code: "INVALID_INPUT", status: 400 });
  const limit = aiCostLimiter.check({ key: rateKey || "anon", scope: "chat", ...aiLimits });
  if (!limit.ok) throw Object.assign(new Error(limit.code === "BUDGET_EXHAUSTED" ? "The daily AI budget has been reached." : limit.code === "AI_ALLOWANCE_EXHAUSTED" ? "The AI envelope of this account is spent." : "AI request limit reached. Try again later."), { code: limit.code, status: limit.status || (limit.code === "BUDGET_EXHAUSTED" ? 503 : 429), retryAfterSec: limit.retryAfterSec, ...(limit.allowance ? { details: { allowance: limit.allowance } } : {}) });
  const client = nl2sqlChatService.getClient();
  // The trial's free messages run the agent on the light model, as the Network Studio's planner's turns do.
  const agentModel = freeTier ? config.PLANNER_FREE_MODEL || nl2sqlChatService.resolveChatModel({ freeTier: true }) : config.DIRECT_AGENT_MODEL || nl2sqlChatService.resolveChatModel({});
  const reviewerModel = config.DIRECT_REVIEWER_MODEL;
  const lang = typeof language === "string" ? language.slice(0, 8) : "en";
  const isoToday = engine.todayIso(today);
  const region = givenRegion || require("../sessionCountry").sessionSchoolRegion(sessionId) || null;
  const startedAt = Date.now();
  const docs = briefDocuments.getDocuments(documentIds);
  const allowance = Object.fromEntries(["hourly", "daily", "global"].map((w) => [w, { used: Number(limit?.[w]?.used) || 0, limit: Number.isFinite(limit?.[w]?.limit) && limit[w].limit > 0 ? limit[w].limit : null }]));
  emit("meta", { mode: "direct", models: { agent: agentModel, reviewer: reviewerModel }, trial: Boolean(freeTier), allowance });
  const budget = turnBudget(aiCostLimiter.turnCeiling(config.AI_TURN_MAX_WEIGHTED_TOKENS, limit, agentModel));
  // The four meters the provider reports, per role: the cache's reads and writes are priced apart from the input.
  const METERS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  const usage = { agent: { rounds: 0, ...Object.fromEntries(METERS.map((k) => [k, 0])) }, reviewer: { rounds: 0, ...Object.fromEntries(METERS.map((k) => [k, 0])) } };
  const counter = (role) => (u) => {
    usage[role].rounds += 1;
    for (const k of METERS) usage[role][k] += Number(u?.[k]) || 0;
    budget.add(u);
  };
  const said = answerOf(answer);
  const key = briefKey(text, documentIds);
  const copy = createWorkingCopy({ db, sessionId, dataVersion, lang, today: isoToday, country });
  let corrections = 0;
  const finishWith = (reason, extra = {}) => {
    emit("usage", { ...usage, budget: budget.snapshot(), durationMs: Date.now() - startedAt });
    const done = { reason, corrections: { rounds: corrections, max: MAX_CORRECTIONS }, ...extra };
    emit("done", done);
    eventLogger.recordEvent("transform.direct", { ...(req ? eventLogger.extractReqMeta(req) : {}), reason, models: { agent: agentModel, reviewer: reviewerModel }, writes: copy.writes.length, corrections, agent_rounds: usage.agent.rounds, reviewer_rounds: usage.reviewer.rounds, not_done: (extra.report?.demands || []).filter((d) => d.status === "not_done").length, unproven: (extra.report?.demands || []).filter((d) => d.status === "unproven").length, not_asked: (extra.report?.not_asked || []).length, durationMs: Date.now() - startedAt, anon: Boolean(freeTier) });
    return done;
  };
  try {
    const tools = agent.agentTools({ copy, documents: docs.found, country, region, today: isoToday, fetchImpl, emit });
    emit("step", { kind: "reading", by: "agent", ...(docs.found.length ? { documents: docs.found.map((d) => d.name) } : {}) });
    const held = said ? takePending(sessionId, key) : null;
    let messages;
    let account = null;
    if (held) {
      // The held turn resumes where it stopped: its writes simulated again, the question's tool call answered.
      await copy.restore(held.writes);
      messages = held.messages;
      corrections = held.corrections;
      messages.push({ role: "user", content: [...held.results, { type: "tool_result", tool_use_id: held.toolUseId, content: `The person answered: ${said.text}` }] });
    } else {
      messages = [agent.firstMessage({ brief: text, documents: docs.found, overview: feedOverview(buildFeedModel(db)), language: lang, today: isoToday, answered: said })];
    }
    let report = null;
    let facts = null;
    let final = null;
    let incomplete = null;
    for (;;) {
      const out = await runLoop({ client, model: agentModel, system: agent.agentPrompt(), tools, messages, maxRounds: config.DIRECT_MAX_ROUNDS, budget, signal, emit, onRound: counter("agent") });
      if (out.stop === "aborted" || signal?.aborted) {
        finishWith("aborted");
        return null;
      }
      if (out.stop === "tool" && out.tool.name === "ask_person") {
        const question = out.tool.answer;
        keepPending(sessionId, { key, messages, writes: copy.writes, results: out.results, toolUseId: out.tool.id, corrections });
        emit("question", question);
        return finishWith("asked", { question, previewId: null });
      }
      account = out.stop === "tool" && out.tool.name === "finish" ? out.tool.answer : { demands: [], doubts: [], ...(out.text.trim() ? { text: clip(out.text.trim(), 4000) } : {}) };
      incomplete = out.stop === "tool" || out.stop === "end_turn" ? null : out.stop;
      // The facts, on the copy as the commit would replay it, with the canonical validator.
      final = await copy.validated();
      facts = factsOf(final, final?.id ? engine.previewChangeset(sessionId, final.id)?.changeset : null);
      emit("step", { kind: "reviewing", by: "reviewer", round: corrections });
      // The review: a conversation of its own, the brief and the facts only.
      const review = [reviewer.reviewMessage({ brief: text, documents: docs.found, facts, language: lang, today: isoToday })];
      const rv = await runLoop({ client, model: reviewerModel, system: reviewer.reviewerPrompt(), tools: reviewer.reviewerTools({ copy, country, region, today: isoToday, fetchImpl, emit }), messages: review, maxRounds: REVIEW_MAX_ROUNDS, budget, signal, emit, onRound: counter("reviewer") });
      if (rv.stop === "aborted" || signal?.aborted) {
        finishWith("aborted");
        return null;
      }
      report = rv.stop === "tool" && rv.tool.name === "report" ? { ...rv.tool.answer, complete: true, model: reviewerModel } : { demands: [], not_asked: [], complete: false, model: reviewerModel };
      emit("report", { round: corrections, previewId: facts.preview_id, report, facts, validation: facts.validator });
      const findings = findingsOf(report, facts);
      // The agent's conversation continues only where it can: it ended on finish or on its own words.
      const resumable = out.stop === "tool" || out.stop === "end_turn" || out.stop === "rounds" || out.stop === "errors";
      if (!findings.length || corrections >= MAX_CORRECTIONS || budget.exceeded() || !resumable) break;
      corrections += 1;
      emit("step", { kind: "correcting", by: "agent", round: corrections, findings: findings.length });
      const answered = out.stop === "tool" ? [...out.results, { type: "tool_result", tool_use_id: out.tool.id, content: "Received." }] : [];
      messages.push({ role: "user", content: [...answered, { type: "text", text: correctionText(findings, corrections) }] });
    }
    if (signal?.aborted) {
      finishWith("aborted");
      return null;
    }
    if (final?.id) engine.markDirect(sessionId, final.id, { report, facts: factsDigest(facts) });
    let deliverable = Boolean(final?.id && final.gate?.can_commit);
    let previewId = final?.id || null;
    // On a draft (`settle`, the controller's): the change joins the draft, the result is the draft's comparison.
    if (settle && final?.id) {
      const settled = await settle({ previewId: final.id, report, facts: factsDigest(facts) });
      previewId = settled.previewId;
      deliverable = Boolean(previewId && deliverable);
    }
    return finishWith(incomplete ? "incomplete" : "complete", { ...(incomplete ? { incomplete } : {}), previewId, deliverable, report, facts, validation: facts.validator, account });
  } catch (err) {
    if (signal?.aborted) {
      finishWith("aborted");
      return null;
    }
    throw err;
  } finally {
    copy.close();
  }
};

/** A direct turn with the persons of the working copy's journal and acknowledgements known to the scrub. */
const runDirect = (args = {}) => personalData.run([...personalData.namesOfSessionDb(args.db)], () => runDirectTurn(args));

module.exports = { runDirect, MAX_CORRECTIONS, _internals: { findingsOf, correctionText, answerOf, briefKey, takePending, keepPending, factsDigest, _pending } };
