/**
 * transform/planAudit — an independent reading of the plan against the brief.
 *
 * Why: the delivery gate measures the clauses the contract holds — the
 * person's decisions, the model's extraction. A requirement the contract
 * never wrote, or wrote wrong, held nothing: on the 2026-09-28 campaign, 12
 * of the 15 failed modification runs were committed with a clean gate (the
 * silent failures of the reliability verdict). The engine's measures stay
 * the only verdict (G3). This is a SECOND READER: a fresh model context that
 * never saw the planner's conversation reads the brief and its documents,
 * the clauses the person decided, the plan's operations and what the
 * simulation says changed (the semantic diff's lines, the clauses after the
 * plan, the impact), and says, requirement by requirement, what the plan
 * meets, what it does not, what it cannot tell, and what the plan changes
 * that the brief never asked (collateral).
 *
 * Its findings are REFUSALS of source "audit" (llm/selfCorrection): they go
 * back to the planner as a correction like the engine's own, and what stays
 * after the attempts is the person's question — never a verdict shown as
 * the engine's, never a silent pass. The audit runs only once the engine
 * holds nothing against the plan (transformPlannerService.checkPlan), once
 * per plan (cached by the plan's key within the turn: a plan the model did
 * not change after a finding keeps the finding, and the attempts run out
 * into the person's question), and never blocks a turn by its own failure
 * (a model error, no call: the turn goes on without it, `skipped` said).
 *
 *   auditPlan({ client, model, brief, documents, contract, plan, preview, language, signal }) →
 *     { findings: [{ status: met | not_met | unclear | collateral, quote, why }], refusals, usage, skipped? }
 *   refusalsOf(findings) → the refusals (source "audit", codes audit_not_met | audit_unclear | audit_collateral)
 *
 * One call, one tool (report_audit), unforced (rule 8: the production model
 * refuses a forced tool_choice) — a prose answer is asked once more for the
 * call. PLANNER_AUDIT_ENABLED turns it off; PLANNER_AUDIT_MODEL names another
 * model than the planner's (the same one by default: a fresh context is the
 * independence, not another family).
 */

"use strict";

const crypto = require("crypto");
const config = require("../../config");
const llm = require("../llm/provider");
const { withRollingCache } = require("../promptCache");
const { clipSaid } = require("../llm/clipText");

const MAX_FINDINGS = 40;
const MAX_REFUSALS = 12;
const DOC_CHARS = 12000;
const DOCS_CHARS = 30000;
const BRIEF_CHARS = 12000;
const PLAN_CHARS = 8000;
const LINES_MAX = 60;
const MAX_TOKENS = 8000;

const SYSTEM = [
  "You are an independent auditor of a public-transport service change. You never saw the conversation that produced the plan: you receive the person's brief (and the text of the documents it came with), the contract clauses the person decided, the change plan's operations, and what the application's simulation says the plan changes in the GTFS feed.",
  "Your job: for EACH requirement of the brief — every sentence that asks for something: a line, a direction, a day type, a date or a period (school days, school holidays, from a date), a time or a time window, a frequency, a stop, a count of trips, something left unchanged — decide from the SIMULATION's changes (never from the plan's intentions, never from the clauses alone) whether the plan as simulated satisfies it.",
  "Be strict: a wrong line, direction, day type, date, period, time, stop name or count means not_met; a requirement the simulation shows nothing about means unclear; a change the simulation shows that no sentence of the brief asked for is collateral (list it apart) — a line, a direction, a day type, a period, a date or a window the brief never names; the running times, the departure minutes or the service the simulation retimes on the very trips the plan rebuilds (a new series, a stop added or withdrawn, a validity extended) are the change's own doing, never collateral. Quote each requirement verbatim from the brief or its documents (one sentence or less). Say why in one short sentence, naming the change line or the clause you read. Never invent a change that the simulation does not show. Never soften a not_met into unclear.",
  "A contract clause marked pass is evidence, not proof: the clauses measure what the person decided to measure, and a requirement with no clause is still a requirement. Treat « le reste est inchangé », « les autres lignes ne changent pas », « hors de cette plage » as requirements too.",
  "Answer with ONE call of report_audit and nothing else.",
].join("\n");

const TOOL = {
  name: "report_audit",
  description: "The audit's findings: every requirement of the brief with its status as the simulation shows it, the collateral changes, and a one-paragraph summary.",
  input_schema: {
    type: "object",
    properties: {
      requirements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            quote: { type: "string", description: "The requirement, verbatim from the brief or a document (one sentence or less)." },
            status: { type: "string", enum: ["met", "not_met", "unclear"] },
            why: { type: "string", description: "One short sentence: the change line or clause read, and what it shows." },
          },
          required: ["quote", "status", "why"],
        },
      },
      collateral: {
        type: "array",
        items: { type: "object", properties: { change: { type: "string", description: "The change the simulation shows, in the simulation's words." }, why: { type: "string", description: "Why no sentence of the brief asks for it." } }, required: ["change", "why"] },
      },
      summary: { type: "string" },
    },
    required: ["requirements", "collateral", "summary"],
  },
};

const clip = (s, n) => clipSaid(String(s ?? ""), n);

/** The text the auditor reads, as blocks: the brief, the documents, the contract, the plan, the simulation. */
const blocksOf = ({ brief, documents = [], contract = null, plan, preview, language }) => {
  const blocks = [];
  blocks.push(`[Brief, the person's words]\n${clip(brief, BRIEF_CHARS)}`);
  let spent = 0;
  for (const d of documents) {
    const text = typeof d.text === "string" ? d.text : null;
    if (!text) {
      blocks.push(`[Document "${d.name}"] (no text the application can read: a scan or an image; the plan's quotes from it are unverifiable)`);
      continue;
    }
    const room = Math.max(0, Math.min(DOC_CHARS, DOCS_CHARS - spent));
    const shown = clip(text, room);
    spent += shown.length;
    blocks.push(`[Document "${d.name}"]\n${shown}`);
  }
  const clauses = Array.isArray(contract?.clauses) ? contract.clauses : [];
  if (clauses.length) blocks.push(`[Contract clauses the person decided]\n${clauses.slice(0, 60).map((c) => `- ${c.id} (${c.kind}, ${c.level || "must"}): ${clip(c.text || JSON.stringify(c.params || {}), 240)}`).join("\n")}`);
  const ops = Array.isArray(plan?.operations) ? plan.operations : [];
  blocks.push(`[Change plan, ${ops.length} operation(s)]\n${clip(JSON.stringify(ops.map((o) => ({ id: o.id, type: o.type, params: o.params, ...(o.source?.quote ? { quote: o.source.quote } : {}) })), null, 0), PLAN_CHARS)}`);
  const sim = [];
  const steps = Array.isArray(preview?.steps) ? preview.steps : [];
  if (steps.length) sim.push(`Steps: ${steps.map((s) => `${s.id} ${s.type} ${s.status}${s.summary ? ` — ${clip(s.summary, 200)}` : ""}`).join("; ")}`);
  const lines = Array.isArray(preview?.lines) ? preview.lines : [];
  if (lines.length) sim.push(`Changes the simulation shows (${lines.length} line(s)):\n${lines.slice(0, LINES_MAX).map((l) => `  ${clip(l, 300)}`).join("\n")}${lines.length > LINES_MAX ? `\n  … ${lines.length - LINES_MAX} more` : ""}`);
  else sim.push("Changes the simulation shows: none.");
  const res = preview?.conformance?.after?.results || [];
  if (res.length) sim.push(`Clauses measured after the plan: ${res.map((r) => `${r.id} ${r.status}${r.status === "unknown" ? ` (${clip(r.note || "not measurable", 120)})` : r.status !== "pass" ? ` (expected ${r.expected}, measured ${r.measured})` : ""}`).join("; ")}`);
  const im = preview?.impact;
  if (im?.totals) sim.push(`Impact over ${im.window?.days ?? "?"} running days: km ${im.totals.km?.before} → ${im.totals.km?.after}, vehicles at peak ${im.totals.fleet?.before} → ${im.totals.fleet?.after}${im.stops?.lost?.length ? `; stops no longer served: ${im.stops.lost.map((s) => s.name).slice(0, 10).join(", ")}` : ""}`);
  blocks.push(`[Simulation]\n${sim.join("\n")}`);
  blocks.push(`[Language of the person] ${language || "fr"}: write quotes verbatim, the rest in that language.`);
  return blocks.join("\n\n");
};

const normalizeFindings = (input) => {
  const out = [];
  for (const r of Array.isArray(input?.requirements) ? input.requirements.slice(0, MAX_FINDINGS) : []) {
    if (!r || typeof r !== "object") continue;
    const status = ["met", "not_met", "unclear"].includes(r.status) ? r.status : "unclear";
    const quote = clip(r.quote, 300).trim();
    if (!quote) continue;
    out.push({ status, quote, why: clip(r.why, 300).trim() });
  }
  for (const c of Array.isArray(input?.collateral) ? input.collateral.slice(0, MAX_FINDINGS) : []) {
    if (!c || typeof c !== "object") continue;
    const change = clip(c.change, 300).trim();
    if (!change) continue;
    out.push({ status: "collateral", quote: change, why: clip(c.why, 300).trim() });
  }
  return out;
};

/** The refusals the planner's correction loop reads: what the audit holds against the plan. */
const refusalsOf = (findings) =>
  findings
    .filter((f) => f.status !== "met")
    .slice(0, MAX_REFUSALS)
    .map((f, i) => ({ source: "audit", code: f.status === "collateral" ? "audit_collateral" : f.status === "unclear" ? "audit_unclear" : "audit_not_met", id: `a${i + 1}`, text: f.quote, message: f.why || null }));

const countOf = (findings) => findings.reduce((acc, f) => ({ ...acc, [f.status]: (acc[f.status] || 0) + 1 }), { met: 0, not_met: 0, unclear: 0, collateral: 0 });

/**
 * The audit of one plan as simulated. Never throws for the model's sake: a failed call, a refusal or no call is a
 * skipped audit (`skipped`), with no finding.
 */
const auditPlan = async ({ client, model, brief, documents = [], contract = null, plan, preview, language = "fr", signal = null }) => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const count = (u) => {
    for (const k of Object.keys(usage)) usage[k] += Number(u?.[k]) || 0;
  };
  const auditModel = config.PLANNER_AUDIT_MODEL || model;
  const effort = config.NETWORK_PLANNER_EFFORT;
  const messages = [{ role: "user", content: [{ type: "text", text: blocksOf({ brief, documents, contract, plan, preview, language }) }] }];
  const round = () =>
    client.messages
      .stream(
        {
          model: llm.modelId(auditModel, config.LLM_PROVIDER),
          max_tokens: MAX_TOKENS,
          system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
          tools: [TOOL],
          ...(effort && llm.supportsEffort(auditModel) ? { output_config: { effort } } : {}),
          messages: withRollingCache(messages),
        },
        signal ? { signal } : undefined,
      )
      .finalMessage();
  const callOf = (m) => (m?.content || []).find((b) => b.type === "tool_use" && b.name === TOOL.name);
  try {
    let final = await round();
    count(final.usage);
    let call = callOf(final);
    if (!call && final.stop_reason !== "refusal") {
      messages.push({ role: "assistant", content: final.content && final.content.length ? final.content : [{ type: "text", text: "(no answer)" }] }, { role: "user", content: "Report the audit now with report_audit, in one call." });
      final = await round();
      count(final.usage);
      call = callOf(final);
    }
    if (!call) return { findings: [], refusals: [], usage, skipped: final.stop_reason === "refusal" ? "refusal" : "no_call", model: auditModel };
    const findings = normalizeFindings(call.input);
    return { findings, refusals: refusalsOf(findings), usage, summary: clip(call.input?.summary, 600), model: auditModel, counts: countOf(findings) };
  } catch (err) {
    if (signal?.aborted) throw err;
    return { findings: [], refusals: [], usage, skipped: "error", error: clip(err.message, 200), model: auditModel };
  }
};

const planKeyOf = (plan) => crypto.createHash("sha1").update(JSON.stringify(plan ?? null)).digest("hex");

module.exports = { auditPlan, refusalsOf, normalizeFindings, countOf, planKeyOf, _internals: { SYSTEM, TOOL, blocksOf, MAX_REFUSALS, DOC_CHARS, DOCS_CHARS } };
