#!/usr/bin/env node
/**
 * eval/network/run.mjs — level 1 of the planner evaluation: the real
 * planner designs each golden brief (eval/network/cases.js) in a frozen
 * world, and the ORACLE scores what it delivered.
 *
 * The world is frozen so a run measures the planner, not the internet: the
 * territory is the fixture dossier of Valmont, the geocoder its gazetteer,
 * routing straight lines, no feed catalog. The conversation runs up to
 * three turns: when the planner asks questions, the case's scripted answers
 * (else the planner's own suggested defaults) are sent back.
 *
 * Per case and run: must/should clauses met (by the oracle, not by the
 * model's own clauses), spec validity, design score, questions asked,
 * turns, tokens, time, whether the model's final text claims a failing
 * must clause as met (honesty), and how many oracle clauses the model
 * recorded itself (extraction recall, by kind).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node eval/network/run.mjs [--model claude-opus-5-5] [--effort medium] [--runs 3] [--case id]
 *
 * Output: eval/results/network-<timestamp>.json and .md. NOT part of CI (it
 * spends real tokens): run it when touching the planner prompt, its tools,
 * the model or the effort, and commit the report as the new baseline.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(__dirname, "..", "..", "GTFS-EXPRESS-API");
const require = createRequire(path.join(API_DIR, "package.json"));

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
};
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is required (this run spends real tokens).");
  process.exit(1);
}
if (arg("model")) process.env.NETWORK_PLANNER_MODEL = arg("model");
if (arg("effort")) process.env.NETWORK_PLANNER_EFFORT = arg("effort");
process.env.NL2SQL_CHAT_ENABLED = "true";

const { CASES, territory } = require(path.join(__dirname, "cases.js"));
const planner = require(path.join(API_DIR, "src/services/network/networkPlannerService.js"));
const { normalizeSpec } = require(path.join(API_DIR, "src/services/network/networkSpec.js"));
const { compileSpec } = require(path.join(API_DIR, "src/services/network/compiler.js"));
const { createRouter } = require(path.join(API_DIR, "src/services/network/roadRouter.js"));
const { checkConformance, clausesOf } = require(path.join(API_DIR, "src/services/network/conformanceService.js"));
const { estimateOperations } = require(path.join(API_DIR, "src/services/network/operationsService.js"));
const design = require(path.join(API_DIR, "src/services/network/networkDesignService.js"));
const territoryService = require(path.join(API_DIR, "src/services/network/territoryService.js"));
const config = require(path.join(API_DIR, "src/config.js"));

const TERRITORY = territory(territoryService.populationGrid);
const { geocode } = require(path.join(__dirname, "cases.js"));

// The frozen world.
planner._internals.deps.geocode = async (q) => geocode(q);
planner._internals.deps.createRouter = () => createRouter({ mode: "straight" });
planner._internals.deps.buildTerritory = async () => TERRITORY;
planner._internals.deps.findFeeds = async () => [];
planner._internals.deps.importFeed = async () => {
  throw new Error("no catalog in the evaluation world");
};

const RUNS = Math.max(1, parseInt(arg("runs", "1"), 10) || 1);
const ONLY = arg("case");
const MAX_TURNS = 3;

const answerFor = (c, q) => {
  const key = Object.keys(c.answers || {}).find((k) => q.id === k || q.id.includes(k) || q.question.toLowerCase().includes(k));
  return key ? c.answers[key] : q.default || (q.options || [])[0] || "Comme vous le proposez.";
};

const runOnce = async (c) => {
  const t0 = Date.now();
  let spec = null;
  let requirements = null;
  const history = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  let brief = c.brief;
  let turns = 0;
  let questions = 0;
  let finalText = "";
  let done = null;
  let error = null;
  for (; turns < MAX_TURNS; ) {
    turns += 1;
    const events = [];
    try {
      const r = await planner.planNetwork({ brief, spec, history, requirements, language: "fr", territoryPlace: null, rateKey: "eval", aiLimits: { hourlyLimit: 10000, dailyLimit: 10000 }, signal: new AbortController().signal, emit: (event, data) => events.push({ event, data }) });
      if (r?.spec) spec = r.spec;
      if (r?.requirements) requirements = r.requirements;
      finalText = r?.text || "";
    } catch (err) {
      error = err.message;
      break;
    }
    for (const e of events) if (e.event === "usage") for (const k of Object.keys(usage)) usage[k] += Number(e.data[k]) || 0;
    done = events.filter((e) => e.event === "done").at(-1)?.data || null;
    if (done?.requirements) requirements = done.requirements;
    history.push({ role: "user", content: brief }, { role: "assistant", content: finalText || "(no text)" });
    const asked = events.filter((e) => e.event === "questions").flatMap((e) => e.data.questions || []);
    if (!asked.length) break;
    questions += asked.length;
    brief = `Réponses : ${asked.map((q) => `${q.question} → ${answerFor(c, q)}`).join(" ; ")}`;
  }
  // Score with the ORACLE on what was delivered.
  let oracle = null;
  let score = null;
  let ok = false;
  if (spec) {
    const norm = normalizeSpec(spec);
    ok = norm.ok;
    let tables = null;
    try {
      tables = norm.ok ? (await compileSpec(norm.spec, { router: createRouter({ mode: "straight" }), shapes: false })).tables : null;
    } catch {
      tables = null;
    }
    const operations = estimateOperations(norm.spec, null, { country: TERRITORY.country });
    oracle = checkConformance(norm.spec, c.oracle, { tables, operations, territory: TERRITORY });
    score = design.evaluatePlan(norm.spec, { territory: TERRITORY }).score;
  }
  const s = oracle?.summary;
  const failingMust = (oracle?.results || []).filter((r) => r.level === "must" && r.status !== "pass");
  // Honesty: the final text says the brief is met while a must clause fails.
  const claimsAllMet = /(toutes? les (exigences|clauses|contraintes)[^.]*(respect|tenu|satisf))|(all (requirements|clauses)[^.]*(met|satisf))|(\d+)\s*\/\s*\1\s*(clauses|exigences|must)/i.test(finalText);
  // Extraction recall: oracle clauses the model recorded a clause of the same kind for.
  const recorded = clausesOf(requirements || {});
  const recall = c.oracle.clauses.length ? c.oracle.clauses.filter((o) => recorded.some((m) => m.kind === o.kind)).length / c.oracle.clauses.length : null;
  return {
    case: c.id,
    ok,
    must: s ? `${s.must.pass}/${s.must.total}` : "0/?",
    must_rate: s && s.must.total ? s.must.pass / s.must.total : 0,
    should: s ? `${s.should.pass}/${s.should.total}` : "0/?",
    failing_must: spec ? failingMust.map((r) => `${r.id} (${r.status}${r.measured ? `: ${r.measured}` : ""})`) : ["no plan delivered"],
    score,
    turns,
    questions,
    recall,
    honest: !(claimsAllMet && failingMust.length),
    tokens: usage,
    durationMs: Date.now() - t0,
    error,
    ready: done?.ready ?? null,
    clean: done?.clean ?? null,
  };
};

const results = [];
for (const c of CASES.filter((x) => !ONLY || x.id === ONLY)) {
  for (let i = 0; i < RUNS; i++) {
    process.stdout.write(`${c.id} #${i + 1} … `);
    const r = await runOnce(c);
    results.push({ ...r, run: i + 1 });
    console.log(`must ${r.must}, should ${r.should}, score ${r.score ?? "—"}, ${r.turns} turn(s), ${r.questions} question(s), ${Math.round(r.durationMs / 1000)} s${r.error ? `, ERROR ${r.error}` : ""}`);
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const summary = {
  model: config.NETWORK_PLANNER_MODEL,
  effort: config.NETWORK_PLANNER_EFFORT || "default",
  runs: results.length,
  must_rate: mean(results.map((r) => r.must_rate)),
  all_must_met: results.filter((r) => r.must_rate === 1).length / (results.length || 1),
  valid_spec: results.filter((r) => r.ok).length / (results.length || 1),
  honest: results.filter((r) => r.honest).length / (results.length || 1),
  recall: mean(results.map((r) => r.recall).filter((x) => x != null)),
  mean_score: mean(results.map((r) => r.score).filter((x) => x != null)),
  output_tokens: results.reduce((n, r) => n + r.tokens.output_tokens, 0),
  input_tokens: results.reduce((n, r) => n + r.tokens.input_tokens, 0),
};

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = path.join(__dirname, "..", "results");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `network-${stamp}.json`), JSON.stringify({ summary, results }, null, 2));
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)} %`);
const md = [
  `# Network planner evaluation — ${stamp}`,
  "",
  `Model \`${summary.model}\`, effort ${summary.effort}, ${summary.runs} run(s).`,
  "",
  `| Metric | Value |`,
  `| --- | --- |`,
  `| Must clauses met (mean) | ${pct(summary.must_rate)} |`,
  `| Runs with every must clause met | ${pct(summary.all_must_met)} |`,
  `| Valid spec delivered | ${pct(summary.valid_spec)} |`,
  `| Honest summary | ${pct(summary.honest)} |`,
  `| Extraction recall (clause kinds) | ${pct(summary.recall)} |`,
  `| Mean design score | ${summary.mean_score == null ? "—" : Math.round(summary.mean_score)} |`,
  `| Tokens in / out | ${summary.input_tokens} / ${summary.output_tokens} |`,
  "",
  `| Case | Run | Must | Should | Score | Turns | Questions | Failing must |`,
  `| --- | --- | --- | --- | --- | --- | --- | --- |`,
  ...results.map((r) => `| ${r.case} | ${r.run} | ${r.must} | ${r.should} | ${r.score ?? "—"} | ${r.turns} | ${r.questions} | ${r.failing_must.join("; ") || "—"} |`),
  "",
].join("\n");
fs.writeFileSync(path.join(dir, `network-${stamp}.md`), md);
console.log(`\n${md}`);
console.log(`Written to eval/results/network-${stamp}.{json,md}`);
