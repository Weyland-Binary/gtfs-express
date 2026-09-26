#!/usr/bin/env node
/**
 * eval/transform/run.mjs — level 1 of the change-planner evaluation: the
 * real planner reads each golden brief (eval/transform/cases.js) about the
 * real Albi feed, and the ORACLE scores the feed it would produce.
 *
 * The world is frozen: the feed is the fixture, routing is straight lines,
 * the school holidays the planner may ask the calendar service for are the
 * ones the feed itself encodes (zone C). The conversation runs up to three
 * turns: when the planner asks, the case's scripted answers (else "use your
 * recommended default") are sent back.
 *
 * Per case and run: every check passed, steps blocked at the end, questions
 * asked, turns, operations used, tokens, time.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... node eval/transform/run.mjs [--model claude-opus-5-5] [--effort medium] [--runs 3] [--case id]
 *
 * Output: eval/results/transform-<timestamp>.json and .md. NOT part of CI
 * (it spends real tokens): run it when touching the change planner, its
 * tools, the operator catalogue, the model or the effort, and commit the
 * report as the new baseline.
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
if (arg("model")) process.env.TRANSFORM_PLANNER_MODEL = arg("model");
if (arg("effort")) process.env.NETWORK_PLANNER_EFFORT = arg("effort");
process.env.NL2SQL_CHAT_ENABLED = "true";

const { CASES, lib, holidayWeekdays, FEED } = require(path.join(__dirname, "cases.js"));
const { loadReal } = require(path.join(API_DIR, "src/__tests__/_helpers/feedDb.js"));
const fm = require(path.join(API_DIR, "src/services/transform/feedModel.js"));
const S = require(path.join(API_DIR, "src/services/transform/scope.js"));
const engine = require(path.join(API_DIR, "src/services/transform/engine.js"));
const planner = require(path.join(API_DIR, "src/services/transform/transformPlannerService.js"));
const { createRouter } = require(path.join(API_DIR, "src/services/network/roadRouter.js"));
const config = require(path.join(API_DIR, "src/config.js"));

planner._internals.deps.createRouter = () => createRouter({ mode: "straight" });
const L = lib(fm, S);
const runs = Math.max(1, parseInt(arg("runs", "1"), 10));
const only = arg("case");

// The frozen calendar service: public holidays of France, and the Albi feed's own school holidays as zone C.
const frozenFetch = (model) => {
  const hol = S.activeDates(model, "7");
  const periods = [];
  for (const d of hol) {
    const last = periods[periods.length - 1];
    if (last && fm._internals.addDays(last.end, 1) >= d && d <= fm._internals.addDays(last.end, 3)) last.end = d;
    else periods.push({ start: d, end: d });
  }
  const iso = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`;
  return async (url) => {
    const u = String(url);
    const body = u.includes("SchoolHolidays")
      ? periods.map((p) => ({ startDate: iso(p.start), endDate: iso(p.end), name: [{ language: "FR", text: "Vacances" }], nationwide: false, subdivisions: [{ shortName: "FR-C" }] }))
      : [
          { date: "2026-11-01", localName: "Toussaint", name: "All Saints", global: true },
          { date: "2026-11-11", localName: "Armistice", name: "Armistice", global: true },
          { date: "2026-12-25", localName: "Noël", name: "Christmas", global: true },
          { date: "2027-01-01", localName: "Jour de l'an", name: "New Year", global: true },
          { date: "2027-03-29", localName: "Lundi de Pâques", name: "Easter Monday", global: true },
          { date: "2027-05-01", localName: "Fête du Travail", name: "Labour Day", global: true },
          { date: "2027-05-08", localName: "Victoire 1945", name: "Victory", global: true },
          { date: "2027-05-06", localName: "Ascension", name: "Ascension", global: true },
          { date: "2027-05-17", localName: "Lundi de Pentecôte", name: "Whit Monday", global: true },
        ];
    return { ok: true, json: async () => body };
  };
};

const runCase = async (c) => {
  const db = loadReal(FEED);
  const before = fm.buildFeedModel(db);
  const fetchImpl = frozenFetch(before);
  const t0 = Date.now();
  let plan = null;
  let preview = null;
  const history = [];
  const usage = { input: 0, output: 0 };
  let questions = 0;
  let turns = 0;
  let brief = c.brief;
  for (; turns < 3; ) {
    turns += 1;
    const events = [];
    const out = await planner.planChanges({ db, sessionId: `eval-${c.id}`, country: "FR", fetchImpl, brief, plan, history, language: "fr", rateKey: "eval", signal: new AbortController().signal, emit: (e, d) => events.push({ e, d }) });
    for (const u of events.filter((x) => x.e === "usage")) {
      usage.input += u.d.input_tokens || 0;
      usage.output += u.d.output_tokens || 0;
    }
    history.push({ role: "user", content: brief }, { role: "assistant", content: out?.text || "" });
    plan = out?.plan || plan;
    preview = out?.preview || preview;
    const asked = events.find((x) => x.e === "questions")?.d?.questions || [];
    questions += asked.length;
    if (!asked.length && !(preview && preview.blocked)) break;
    // Scripted answers, else the planner's own defaults.
    const lines = asked.map((q) => {
      const scripted = q.param && c.answers ? c.answers[q.param] : null;
      return `- ${q.text} → ${scripted || q.default || "use your recommended default"}`;
    });
    brief = lines.length ? `Réponses :\n${lines.join("\n")}` : "Utilise tes valeurs par défaut recommandées pour ce qui reste à trancher.";
  }
  let checks = [];
  let committed = false;
  if (preview && preview.id && !preview.blocked) {
    const again = await engine.previewPlan(db, plan, { sessionId: "eval", router: createRouter({ mode: "straight" }), country: "FR", fetchImpl });
    if (again.id && !again.blocked) {
      engine.commitPreview("eval", db, again.id);
      committed = true;
      const after = fm.buildFeedModel(db);
      checks = c.checks(L).map((k) => ({ id: k.id, ...k.run(before, after) }));
    }
  }
  return {
    case: c.id,
    passed: committed && checks.length > 0 && checks.every((x) => x.ok),
    committed,
    checks,
    blocked: Boolean(preview?.blocked),
    questions,
    turns,
    operations: (plan?.operations || []).map((o) => o.type),
    usage,
    ms: Date.now() - t0,
  };
};

const main = async () => {
  const cases = CASES.filter((c) => !only || c.id === only);
  const results = [];
  for (const c of cases) {
    for (let r = 0; r < runs; r++) {
      process.stdout.write(`${c.id} #${r + 1}… `);
      try {
        const res = await runCase(c);
        results.push(res);
        console.log(res.passed ? "PASS" : `FAIL ${res.checks.filter((x) => !x.ok).map((x) => x.id).join(",") || (res.blocked ? "blocked" : "not committed")}`);
      } catch (err) {
        results.push({ case: c.id, passed: false, error: err.message });
        console.log(`ERROR ${err.message}`);
      }
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(__dirname, "..", "results");
  fs.mkdirSync(dir, { recursive: true });
  const model = config.TRANSFORM_PLANNER_MODEL || config.NETWORK_PLANNER_MODEL;
  const pass = results.filter((r) => r.passed).length;
  fs.writeFileSync(path.join(dir, `transform-${stamp}.json`), JSON.stringify({ model, effort: config.NETWORK_PLANNER_EFFORT, runs, results }, null, 2));
  const md = [`# Change planner — ${model}`, "", `${pass}/${results.length} briefs fully met.`, "", "| case | passed | failed checks | blocked | questions | turns | operations | tokens in/out | s |", "|---|---|---|---|---|---|---|---|---|"];
  for (const r of results) md.push(`| ${r.case} | ${r.passed ? "✓" : "✗"} | ${(r.checks || []).filter((x) => !x.ok).map((x) => x.id).join(", ") || (r.error ? `error: ${r.error}` : "")} | ${r.blocked ? "yes" : ""} | ${r.questions ?? ""} | ${r.turns ?? ""} | ${(r.operations || []).join(", ")} | ${r.usage ? `${r.usage.input}/${r.usage.output}` : ""} | ${r.ms ? Math.round(r.ms / 1000) : ""} |`);
  fs.writeFileSync(path.join(dir, `transform-${stamp}.md`), md.join("\n"));
  console.log(`\n${pass}/${results.length} — eval/results/transform-${stamp}.md`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
