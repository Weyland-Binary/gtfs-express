/**
 * The direct mode's workflow, its loop held by the code, not by a model: the agent changes the working copy until it
 * finishes or asks the person one question (the turn is held and resumes with the answer); the engine states the facts
 * with the canonical validator; the reviewer reports per demand; what is not done, not asked, a new validator error or
 * broken integrity sends the agent back (the reviewer's findings as one message, nothing else of the reviewer),
 * MAX_CORRECTIONS rounds at most. The result is the preview the commit replays exactly (G6). The models' words are not
 * streamed: the result is the report and the facts.
 * The AI's cost is bounded: the limiter counts the turn once, the agent and the reviewer spend under one ceiling
 * (llm/turnBudget), the agent leaving the review its share, and every request passes the personal-data scrub with the
 * journal's persons known. A change is deliverable only on a complete review: a reviewer that ends without its report
 * is asked for it once, and a review still missing is run again on its own (reviewAgain, POST /transform/direct/review).
 */

"use strict";

const crypto = require("crypto");
const config = require("../../config");
const aiCostLimiter = require("../aiCostLimiter");
const nl2sqlChatService = require("../nl2sqlChatService");
const eventLogger = require("../eventLogger");
const personalData = require("../llm/personalData");
const briefDocuments = require("../documents/briefDocumentService");
const engine = require("../transform/engine");
const { turnBudget } = require("../llm/turnBudget");
const { buildFeedModel } = require("../transform/feedModel");
const { feedOverview } = require("../transform/modelText");
const { createWorkingCopy } = require("./workingCopy");
const { runLoop } = require("./modelLoop");
const { factsOf } = require("./facts");
const { getDataVersion } = require("../../middleware/readCache");
const validatorGate = require("../validatorGate");
const agent = require("./agent");
const reviewer = require("./reviewer");

const MAX_CORRECTIONS = 2;
const REVIEW_MAX_ROUNDS = 16;
const REVIEW_NUDGE_ROUNDS = 4;
// What the agent may spend of the turn's ceiling: the rest is the review's, which the delivery cannot do without.
const AGENT_BUDGET_SHARE = 0.8;
const REVIEW_NUDGE = "[Call report now, once: one entry per demand of the brief with what you measured, and the changes no demand asks for. A demand you could not measure is unproven.]";
// The stops after which the reviewer's conversation can take one more message (its last message is its own).
const NUDGEABLE = new Set(["end_turn", "rounds", "errors"]);
const MAX_BRIEF_CHARS = 60000;
// A turn held by a question waits this long for its answer (the previews it built live as long).
const PENDING_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING = 200;

const clip = (s, n) => (typeof s === "string" && s.length > n ? `${s.slice(0, n)}…` : s);

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

const answerOf = (raw) => {
  if (typeof raw === "string" && raw.trim()) return { text: raw.trim().slice(0, 2000) };
  if (raw && typeof raw === "object" && typeof raw.text === "string" && raw.text.trim()) return { text: raw.text.trim().slice(0, 2000), ...(typeof raw.question === "string" && raw.question.trim() ? { question: raw.question.trim().slice(0, 600) } : {}) };
  return null;
};

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

/**
 * The reviewer's conversation, to its report. Null when the turn was stopped; otherwise the report, `complete: false`
 * (with the reason it stopped) when the reviewer ended without it even when asked once more.
 */
const runReview = async ({ client, model, copy, brief, documents = [], facts, language, today, answers = [], country = null, region = null, fetchImpl = null, budget, signal, emit, onRound }) => {
  const messages = [reviewer.reviewMessage({ brief, documents, facts, language, today, answers })];
  const tools = reviewer.reviewerTools({ copy, country, region, today, fetchImpl, emit });
  const loop = (maxRounds) => runLoop({ client, model, system: reviewer.reviewerPrompt(), tools, messages, maxRounds, budget, signal, emit, onRound });
  let rv = await loop(REVIEW_MAX_ROUNDS);
  if (NUDGEABLE.has(rv.stop) && !budget.exceeded() && !signal?.aborted) {
    messages.push({ role: "user", content: REVIEW_NUDGE });
    rv = await loop(REVIEW_NUDGE_ROUNDS);
  }
  if (rv.stop === "aborted" || signal?.aborted) return null;
  return rv.stop === "tool" && rv.tool.name === "report" ? { ...rv.tool.answer, complete: true, model } : { demands: [], not_asked: [], complete: false, stop: rv.stop, model };
};

const runDirectTurn = async ({ db, sessionId = null, dataVersion = null, country = null, region: givenRegion = null, brief, documentIds = [], answer = null, language = "en", freeTier = false, rateKey, aiLimits = {}, signal, emit = () => {}, req = null, today = null, fetchImpl = null, settle = null }) => {
  const text = String(brief || "").trim();
  if (text.length < 3) throw Object.assign(new Error("brief is required (≥ 3 characters)."), { code: "INVALID_INPUT", status: 400 });
  if (text.length > MAX_BRIEF_CHARS) throw Object.assign(new Error(`brief is too long (max ${MAX_BRIEF_CHARS} characters).`), { code: "INVALID_INPUT", status: 400 });
  const limit = aiCostLimiter.check({ key: rateKey || "anon", scope: "chat", ...aiLimits });
  if (!limit.ok) throw Object.assign(new Error(limit.code === "BUDGET_EXHAUSTED" ? "The daily AI budget has been reached." : limit.code === "AI_ALLOWANCE_EXHAUSTED" ? "The AI envelope of this account is spent." : "AI request limit reached. Try again later."), { code: limit.code, status: limit.status || (limit.code === "BUDGET_EXHAUSTED" ? 503 : 429), retryAfterSec: limit.retryAfterSec, ...(limit.allowance ? { details: { allowance: limit.allowance } } : {}) });
  const client = nl2sqlChatService.getClient();
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
  const agentBudget = budget.share(AGENT_BUDGET_SHARE);
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
    const answers = held ? [...(held.answers || []), { question: said.question || held.question?.question || null, text: said.text }] : said ? [said] : [];
    if (held) {
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
      const out = await runLoop({ client, model: agentModel, system: agent.agentPrompt(), tools, messages, maxRounds: config.DIRECT_MAX_ROUNDS, budget: agentBudget, signal, emit, onRound: counter("agent") });
      if (out.stop === "aborted" || signal?.aborted) {
        finishWith("aborted");
        return null;
      }
      if (out.stop === "tool" && out.tool.name === "ask_person") {
        const question = out.tool.answer;
        keepPending(sessionId, { key, messages, writes: copy.writes, results: out.results, toolUseId: out.tool.id, corrections, question, answers });
        emit("question", question);
        return finishWith("asked", { question, previewId: null });
      }
      account = out.stop === "tool" && out.tool.name === "finish" ? out.tool.answer : { demands: [], doubts: [], ...(out.text.trim() ? { text: clip(out.text.trim(), 4000) } : {}) };
      incomplete = out.stop === "tool" || out.stop === "end_turn" ? null : out.stop;
      final = await copy.validated();
      facts = factsOf(final, final?.id ? engine.previewChangeset(sessionId, final.id)?.changeset : null);
      emit("step", { kind: "reviewing", by: "reviewer", round: corrections });
      report = await runReview({ client, model: reviewerModel, copy, brief: text, documents: docs.found, facts, language: lang, today: isoToday, answers, country, region, fetchImpl, budget, signal, emit, onRound: counter("reviewer") });
      if (!report) {
        finishWith("aborted");
        return null;
      }
      emit("report", { round: corrections, previewId: facts.preview_id, report, facts, validation: facts.validator });
      const findings = findingsOf(report, facts);
      // The agent's conversation continues only where it can: it ended on finish or on its own words.
      const resumable = out.stop === "tool" || out.stop === "end_turn" || out.stop === "rounds" || out.stop === "errors";
      if (!findings.length || corrections >= MAX_CORRECTIONS || agentBudget.exceeded() || !resumable) break;
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
    // Nothing is delivered on a review that did not conclude: the change waits for one, run on its own.
    let deliverable = Boolean(final?.id && final.gate?.can_commit && report?.complete);
    let previewId = final?.id || null;
    if (settle && final?.id) {
      const settled = await settle({ previewId: final.id, report, facts: factsDigest(facts), review: { brief: text, documentIds: (documentIds || []).slice(0, 20), answers, language: lang } });
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

/**
 * The review run again on its own, on a draft whose turn ended without a complete one: the brief, its documents and the
 * person's answers kept with the report, the facts stated again from the draft compared with its working copy (what
 * the decision applies). The agent is not called: the change is the draft's as it stands.
 */
const reviewAgainOn = async ({ db, sessionId, main, mainDb, kept, language = "en", freeTier = false, rateKey, aiLimits = {}, signal, emit = () => {}, req = null, today = null, fetchImpl = null }) => {
  const asked = kept?.review;
  if (!asked || typeof asked.brief !== "string" || !asked.brief.trim()) throw engine.refusal(409, "NO_REVIEW_TO_RUN", "This draft keeps no brief to review: prepare the change from its brief again.");
  if (kept.version !== getDataVersion(db)) throw engine.refusal(409, "NO_REVIEW_TO_RUN", "The draft changed since its brief was worked on: prepare the change from its brief again.", { reason: "moved" });
  const limit = aiCostLimiter.check({ key: rateKey || "anon", scope: "chat", ...aiLimits });
  if (!limit.ok) throw Object.assign(new Error(limit.code === "BUDGET_EXHAUSTED" ? "The daily AI budget has been reached." : limit.code === "AI_ALLOWANCE_EXHAUSTED" ? "The AI envelope of this account is spent." : "AI request limit reached. Try again later."), { code: limit.code, status: limit.status || (limit.code === "BUDGET_EXHAUSTED" ? 503 : 429), retryAfterSec: limit.retryAfterSec, ...(limit.allowance ? { details: { allowance: limit.allowance } } : {}) });
  const client = nl2sqlChatService.getClient();
  const reviewerModel = config.DIRECT_REVIEWER_MODEL;
  const lang = typeof asked.language === "string" ? asked.language.slice(0, 8) : typeof language === "string" ? language.slice(0, 8) : "en";
  const isoToday = engine.todayIso(today);
  const session = require("../sessionCountry");
  const country = session.sessionCountryCode(main) || null;
  const region = session.sessionSchoolRegion(main) || null;
  const startedAt = Date.now();
  emit("meta", { mode: "review", models: { reviewer: reviewerModel }, trial: Boolean(freeTier) });
  emit("step", { kind: "reviewing", by: "reviewer", round: 0 });
  const validate = validatorGate.isAvailable() ? (d) => validatorGate.validateDb(d, country) : null;
  const compared = await engine.previewDraft(mainDb, db, { sessionId: main, draftSession: sessionId, dataVersion: getDataVersion(mainDb), draftVersion: getDataVersion(db), validate, validatorEnabled: validatorGate.isAvailable(), country, region, lang, today: isoToday });
  if (!compared.id) throw engine.refusal(409, "NO_REVIEW_TO_RUN", "Nothing in this draft differs from the network: there is no change to review.");
  const facts = factsOf(compared, engine.previewChangeset(main, compared.id)?.changeset);
  let model = null;
  const copy = {
    before: () => mainDb,
    current: () => db,
    model: () => {
      if (!model) model = buildFeedModel(db);
      return model;
    },
  };
  const budget = turnBudget(aiCostLimiter.turnCeiling(config.AI_TURN_MAX_WEIGHTED_TOKENS, limit, reviewerModel));
  const usage = { rounds: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const onRound = (u) => {
    usage.rounds += 1;
    for (const k of Object.keys(usage)) if (k !== "rounds") usage[k] += Number(u?.[k]) || 0;
    budget.add(u);
  };
  const documents = briefDocuments.getDocuments(Array.isArray(asked.documentIds) ? asked.documentIds : []).found;
  const report = await runReview({ client, model: reviewerModel, copy, brief: asked.brief, documents, facts, language: lang, today: isoToday, answers: Array.isArray(asked.answers) ? asked.answers : [], country, region, fetchImpl, budget, signal, emit, onRound });
  const finish = (reason, extra = {}) => {
    emit("usage", { reviewer: usage, budget: budget.snapshot(), durationMs: Date.now() - startedAt });
    const done = { reason, ...extra };
    emit("done", done);
    eventLogger.recordEvent("transform.direct.review", { ...(req ? eventLogger.extractReqMeta(req) : {}), reason, model: reviewerModel, complete: Boolean(extra.report?.complete), reviewer_rounds: usage.rounds, durationMs: Date.now() - startedAt, anon: Boolean(freeTier) });
    return done;
  };
  if (!report) return finish("aborted");
  const digest = factsDigest(facts);
  require("../transform/draftSession").keepReport(sessionId, { ...kept, report, facts: digest, version: getDataVersion(db) });
  engine.markDirect(main, compared.id, { report, facts: digest });
  emit("report", { round: 0, previewId: compared.id, report, facts, validation: facts.validator });
  return finish("complete", { previewId: compared.id, deliverable: Boolean(compared.gate?.can_commit && report.complete), report, facts, validation: facts.validator });
};

/** The persons of the working copy's journal and acknowledgements are made known to the personal-data scrub. */
const runDirect = (args = {}) => personalData.run([...personalData.namesOfSessionDb(args.db)], () => runDirectTurn(args));
const reviewAgain = (args = {}) => personalData.run([...personalData.namesOfSessionDb(args.db), ...personalData.namesOfSessionDb(args.mainDb)], () => reviewAgainOn(args));

module.exports = { runDirect, reviewAgain, MAX_CORRECTIONS, AGENT_BUDGET_SHARE, _internals: { findingsOf, correctionText, answerOf, briefKey, takePending, keepPending, factsDigest, runReview, REVIEW_NUDGE, _pending } };
